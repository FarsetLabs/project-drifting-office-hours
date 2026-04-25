import { createEvent, getAccessToken, getBusyRanges } from "./google";
import {
  buildBookingModal,
  openModal,
  postDM,
  verifySlackSignature,
} from "./slack";
import type { Booking, Env, Room, SlackViewSubmission } from "./types";

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
  if (!triggerId) return new Response("Missing trigger_id", { status: 400 });

  const rooms = loadRooms(env);
  ctx.waitUntil(
    openModal(env.SLACK_BOT_TOKEN, triggerId, buildBookingModal(rooms)).catch((err) =>
      console.error("Failed to open modal:", err),
    ),
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
    const shortcut = payload as unknown as { trigger_id: string; callback_id: string };
    if (shortcut.callback_id === "open_booking_modal") {
      const rooms = loadRooms(env);
      ctx.waitUntil(
        openModal(env.SLACK_BOT_TOKEN, shortcut.trigger_id, buildBookingModal(rooms)).catch(
          (err) => console.error("Failed to open modal from shortcut:", err),
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

  const rooms = loadRooms(env);
  const v = payload.view.state.values;
  const roomEmail = v.room_block.room.selected_option?.value ?? "";
  const room = rooms.find((r) => r.email === roomEmail);

  const booking: Booking = {
    title: v.title_block.title.value ?? "",
    date: v.date_block.date.selected_date ?? "",
    startTime: v.start_block.start_time.selected_time ?? "",
    endTime: v.end_block.end_time.selected_time ?? "",
    room: room?.name ?? "Unknown",
    visibility:
      (v.visibility_block.visibility.selected_option?.value as "public" | "private") ??
      "public",
    description: v.description_block?.description?.value ?? "",
    bookerSlackId: payload.user.id,
    bookerName: payload.user.name,
  };

  if (!room) {
    return jsonResponse({
      response_action: "errors",
      errors: { room_block: "Pick a room." },
    });
  }

  const startISO = toRFC3339London(booking.date, booking.startTime);
  const endISO = toRFC3339London(booking.date, booking.endTime);

  if (endISO <= startISO) {
    return jsonResponse({
      response_action: "errors",
      errors: { end_block: "End time must be after start time." },
    });
  }

  try {
    const token = await getAccessToken(
      env.GOOGLE_SERVICE_ACCOUNT_JSON,
      env.GOOGLE_IMPERSONATE_SUBJECT,
    );
    const busy = await getBusyRanges(token, room.email, startISO, endISO);

    if (busy.length > 0) {
      const first = busy[0];
      return jsonResponse({
        response_action: "errors",
        errors: {
          room_block: `${room.name} is already booked from ${first.start} to ${first.end}.`,
        },
      });
    }

    const description = [
      booking.description,
      "",
      `Room: ${room.name} (${room.capacity} seats)`,
      `Booked by: ${booking.bookerName} (<@${booking.bookerSlackId}>)`,
    ]
      .filter(Boolean)
      .join("\n");

    ctx.waitUntil(
      (async () => {
        try {
          const event = await createEvent(token, env.GOOGLE_CALENDAR_ID, {
            summary: booking.title,
            description,
            location: `Farset Labs — ${room.name}`,
            startISO,
            endISO,
            visibility: booking.visibility,
            roomEmail: room.email,
          });
          const roomAttendee = event.attendees?.find((a) => a.email === room.email);
          const declined = roomAttendee?.responseStatus === "declined";
          const note = declined
            ? `\n:warning: ${room.name} declined the invitation. Check the room's auto-accept settings.`
            : "";
          await postDM(
            env.SLACK_BOT_TOKEN,
            booking.bookerSlackId,
            `:white_check_mark: Booked *${booking.title}* in *${room.name}* on ${booking.date}, ${booking.startTime}–${booking.endTime}.\n${event.htmlLink}${note}`,
          );
        } catch (err) {
          console.error("Async booking failed:", err);
          await postDM(
            env.SLACK_BOT_TOKEN,
            booking.bookerSlackId,
            `:x: Sorry — your booking for *${booking.title}* failed to save. Please try again or ask an admin.`,
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

function toRFC3339London(date: string, time: string): string {
  const probe = new Date(`${date}T${time}:00Z`);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    timeZoneName: "longOffset",
  }).formatToParts(probe);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  const offset = m
    ? `${m[1]}${m[2].padStart(2, "0")}:${(m[3] ?? "00").padStart(2, "0")}`
    : "+00:00";
  return `${date}T${time}:00${offset}`;
}
