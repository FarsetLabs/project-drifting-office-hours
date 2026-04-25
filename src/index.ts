import { createEvent, getAccessToken, getBusyForCalendars } from "./google";
import {
  buildBookingModal,
  buildErrorModal,
  getUserEmail,
  openModal,
  postDM,
  TINKER_LINK,
  verifySlackSignature,
} from "./slack";
import { findActiveMembership } from "./stripe";
import type { Env, Room, SlackViewSubmission } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (request.method === "POST" && url.pathname === "/slack/commands") {
      return handleSlashCommand(request, env, ctx);
    }

    if (request.method === "POST" && url.pathname === "/slack/interactions") {
      return handleInteraction(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleSlashCommand(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.text();
  const verified = await verifyRequest(request, body, env);
  if (!verified) return new Response("Unauthorized", { status: 401 });

  const params = new URLSearchParams(body);
  const triggerId = params.get("trigger_id");
  const userId = params.get("user_id");
  if (!triggerId || !userId) {
    return new Response("Missing trigger_id or user_id", { status: 400 });
  }

  const gate = await checkMembership(env, userId);
  if (!gate.allowed) {
    return jsonResponse({
      response_type: "ephemeral",
      text: `${gate.message}\n\n${TINKER_LINK}`,
    });
  }

  const rooms = loadRooms(env);
  ctx.waitUntil(
    openModal(
      env.SLACK_BOT_TOKEN,
      triggerId,
      buildBookingModal(rooms, gate.greeting),
    ).catch((err) => console.error("Failed to open modal:", err)),
  );

  return new Response("", { status: 200 });
}

async function handleInteraction(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await request.text();
  const verified = await verifyRequest(request, body, env);
  if (!verified) return new Response("Unauthorized", { status: 401 });

  const params = new URLSearchParams(body);
  const payloadRaw = params.get("payload");
  if (!payloadRaw) return new Response("Missing payload", { status: 400 });

  const payload = JSON.parse(payloadRaw) as { type: string };

  if (payload.type === "shortcut") {
    const shortcut = payload as unknown as {
      trigger_id: string;
      callback_id: string;
      user: { id: string };
    };
    if (shortcut.callback_id === "open_booking_modal") {
      const gate = await checkMembership(env, shortcut.user.id);
      const view = gate.allowed
        ? buildBookingModal(loadRooms(env), gate.greeting)
        : buildErrorModal(gate.message);
      ctx.waitUntil(
        openModal(env.SLACK_BOT_TOKEN, shortcut.trigger_id, view).catch((err) =>
          console.error("Failed to open modal from shortcut:", err),
        ),
      );
      return new Response("", { status: 200 });
    }
  }

  if (payload.type === "view_submission") {
    return handleBookingSubmission(payload as unknown as SlackViewSubmission, env, ctx);
  }

  return new Response("", { status: 200 });
}

async function handleBookingSubmission(
  payload: SlackViewSubmission,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (payload.view.callback_id !== "submit_booking") {
    return new Response("", { status: 200 });
  }

  const allRooms = loadRooms(env);
  const v = payload.view.state.values;
  const title = (v.title_block?.title?.value ?? "").trim();
  const userDescription = (v.description_block?.description?.value ?? "").trim();
  const startTs = v.start_block?.start?.selected_date_time ?? null;
  const endTs = v.end_block?.end?.selected_date_time ?? null;
  const pickedOptions = v.rooms_block?.rooms?.selected_options ?? [];
  const pickedRooms = pickedOptions
    .map((opt) => allRooms.find((r) => r.email === opt.value))
    .filter((r): r is Room => Boolean(r));

  if (pickedRooms.length === 0) {
    return jsonResponse({
      response_action: "errors",
      errors: { rooms_block: "Pick at least one room." },
    });
  }
  if (startTs == null || endTs == null) {
    return jsonResponse({
      response_action: "errors",
      errors: { end_block: "Pick a start and end time." },
    });
  }
  if (endTs <= startTs) {
    return jsonResponse({
      response_action: "errors",
      errors: { end_block: "End must be after start." },
    });
  }

  const startISO = new Date(startTs * 1000).toISOString();
  const endISO = new Date(endTs * 1000).toISOString();

  const userId = payload.user.id;
  const userName = payload.user.name;
  const roomNames = pickedRooms.map((r) => r.name).join(", ");

  try {
    const token = await getAccessToken(
      env.GOOGLE_SERVICE_ACCOUNT_JSON,
      env.GOOGLE_IMPERSONATE_SUBJECT,
    );
    const busyMap = await getBusyForCalendars(
      token,
      pickedRooms.map((r) => r.email),
      startISO,
      endISO,
    );
    const conflicted = pickedRooms.find(
      (r) => (busyMap[r.email] ?? []).length > 0,
    );
    if (conflicted) {
      const range = busyMap[conflicted.email][0];
      return jsonResponse({
        response_action: "errors",
        errors: {
          rooms_block: `${conflicted.name} is already booked from ${range.start} to ${range.end}.`,
        },
      });
    }

    const fullDescription = [
      userDescription,
      "",
      `Booked by ${userName} via Slack /create-an-event`,
    ]
      .filter(Boolean)
      .join("\n");

    ctx.waitUntil(
      (async () => {
        try {
          const event = await createEvent(token, env.GOOGLE_CALENDAR_ID, {
            summary: title,
            description: fullDescription,
            location: `Farset Labs — ${roomNames}`,
            startISO,
            endISO,
            roomEmails: pickedRooms.map((r) => r.email),
          });
          const declined = (event.attendees ?? [])
            .filter((a) => a.responseStatus === "declined")
            .map(
              (a) => pickedRooms.find((r) => r.email === a.email)?.name ?? a.email,
            );
          const note = declined.length
            ? `\n:warning: Declined: ${declined.join(", ")}. Check those rooms' auto-accept settings.`
            : "";
          await postDM(
            env.SLACK_BOT_TOKEN,
            userId,
            `:white_check_mark: Booked *${title}* in *${roomNames}*.\n${event.htmlLink}${note}\n\n${TINKER_LINK}`,
          );
        } catch (err) {
          console.error("Async booking failed:", err);
          await postDM(
            env.SLACK_BOT_TOKEN,
            userId,
            `:x: Sorry — your booking for *${title}* failed to save. Please try again or ask another member to help.\n\n${TINKER_LINK}`,
          );
        }
      })(),
    );

    return jsonResponse({ response_action: "clear" });
  } catch (err) {
    console.error("Booking validation failed:", err);
    return jsonResponse({
      response_action: "errors",
      errors: { title_block: "Sorry — couldn't reach the calendar. Try again in a moment." },
    });
  }
}

function loadRooms(env: Env): Room[] {
  try {
    return JSON.parse(env.ROOMS_JSON) as Room[];
  } catch (err) {
    console.error("ROOMS_JSON is not valid JSON:", err);
    return [];
  }
}

async function checkMembership(
  env: Env,
  slackUserId: string,
): Promise<{ allowed: boolean; message: string; greeting?: string }> {
  try {
    const email = await getUserEmail(env.SLACK_BOT_TOKEN, slackUserId);
    if (!email) {
      return {
        allowed: false,
        message:
          ":lock: We couldn't read your Slack email. Make sure your Slack profile has an email set, or ask another member to help.",
      };
    }
    const priceIds = env.STRIPE_MEMBERSHIP_PRICE_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const { active, memberSince } = await findActiveMembership(
      env.STRIPE_SECRET_KEY,
      email.toLowerCase(),
      priceIds,
    );
    if (active) {
      const duration = memberSince ? humanizeDuration(memberSince) : null;
      const lines = [
        "*Let's create an event!*",
        "Bookings show up on the public <https://www.farsetlabs.org.uk/whats-on/|What's On> calendar — use this to book rooms or run events.",
      ];
      if (duration) {
        lines.push(`_Fun fact: you've been a Farset Labs member for *${duration}*._`);
      }
      return { allowed: true, message: "", greeting: lines.join("\n\n") };
    }

    return {
      allowed: false,
      message:
        `:lock: *Members only* — no active Farset Labs membership found for *${email}*.\n\n` +
        `*How to fix*\n` +
        `• Not a member yet? <${env.MEMBERSHIP_SIGNUP_URL}|Join Farset Labs>.\n` +
        `• Pay under a different email? <${env.STRIPE_BILLING_PORTAL_URL}|Manage it in Stripe>, or change your Slack profile email to match.\n\n` +
        `_(In a pinch, ask a member to book on your behalf — but please try to do one of the above.)_`,
    };
  } catch (err) {
    console.error("Membership check failed:", err);
    return {
      allowed: false,
      message:
        ":warning: Couldn't verify your membership right now. Please try again in a moment.",
    };
  }
}

function humanizeDuration(unixStartSeconds: number): string {
  const nowSec = Date.now() / 1000;
  const days = Math.max(0, Math.floor((nowSec - unixStartSeconds) / 86400));
  if (days < 1) return "less than a day";
  if (days < 30) return `${days} day${days === 1 ? "" : "s"}`;
  const months = Math.floor(days / 30.44);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"}`;
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  if (remMonths === 0) return `${years} year${years === 1 ? "" : "s"}`;
  return `${years} year${years === 1 ? "" : "s"}, ${remMonths} month${remMonths === 1 ? "" : "s"}`;
}

async function verifyRequest(
  request: Request,
  body: string,
  env: Env,
): Promise<boolean> {
  const timestamp = request.headers.get("X-Slack-Request-Timestamp") ?? "";
  const signature = request.headers.get("X-Slack-Signature") ?? "";
  return verifySlackSignature(body, timestamp, signature, env.SLACK_SIGNING_SECRET);
}

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

