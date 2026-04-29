import { createEvent, getAccessToken, getEventsForRooms } from "./google";
import {
  buildBookingModal,
  buildErrorModal,
  escapeMrkdwn,
  getUserEmail,
  listWorkspaceEmailToId,
  openModal,
  postChannelMessage,
  postDM,
  postToResponseUrl,
  tinkerContextBlock,
  TINKER_LINK,
  verifySlackSignature,
} from "./slack";
import {
  findActiveMembership as findActiveStripeMembership,
  getLifetimeContributionPence,
  getProductNames,
  getRecentStripeLeavers,
  listActiveMembers as listActiveStripeMembers,
} from "./stripe";
import {
  findActiveMembership as findActiveNexudusMembership,
  listActiveMembers as listActiveNexudusMembers,
} from "./nexudus";

const FARSET_LABS_OPENED_AT = "2012-04-06";
const TIER_ORDER = ["Standard", "Professional", "Professional + Desk", "Casual"];
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
  const command = params.get("command");
  const userId = params.get("user_id");
  const responseUrl = params.get("response_url");

  if (command === "/stats" || command === "/played") {
    if (!userId || !responseUrl) {
      return new Response("Missing user_id or response_url", { status: 400 });
    }
    if (!responseUrl.startsWith("https://hooks.slack.com/")) {
      return new Response("Invalid response_url", { status: 400 });
    }
    const userName = params.get("user_name") ?? "you";
    const personalOnly = command === "/played";
    ctx.waitUntil(
      computeAndSendStats(env, userId, userName, responseUrl, { personalOnly }).catch(
        (err) => console.error("Stats handler failed:", err),
      ),
    );
    return new Response("", { status: 200 });
  }

  if (command === "/door-code") {
    if (!userId || !responseUrl) {
      return new Response("Missing user_id or response_url", { status: 400 });
    }
    if (!responseUrl.startsWith("https://hooks.slack.com/")) {
      return new Response("Invalid response_url", { status: 400 });
    }
    ctx.waitUntil(
      sendDoorCode(env, userId, responseUrl).catch((err) =>
        console.error("Door code handler failed:", err),
      ),
    );
    return new Response("", { status: 200 });
  }

  if (command === "/members") {
    if (!userId || !responseUrl) {
      return new Response("Missing user_id or response_url", { status: 400 });
    }
    if (!responseUrl.startsWith("https://hooks.slack.com/")) {
      return new Response("Invalid response_url", { status: 400 });
    }
    ctx.waitUntil(
      sendMembersList(env, userId, responseUrl).catch((err) =>
        console.error("Members handler failed:", err),
      ),
    );
    return new Response("", { status: 200 });
  }

  if (command === "/wifi-password") {
    if (!userId || !responseUrl) {
      return new Response("Missing user_id or response_url", { status: 400 });
    }
    if (!responseUrl.startsWith("https://hooks.slack.com/")) {
      return new Response("Invalid response_url", { status: 400 });
    }
    ctx.waitUntil(
      sendWifi(env, userId, responseUrl).catch((err) =>
        console.error("Wifi handler failed:", err),
      ),
    );
    return new Response("", { status: 200 });
  }

  const triggerId = params.get("trigger_id");
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
      buildBookingModal(rooms, gate.greeting, gate.funFact),
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
        ? buildBookingModal(loadRooms(env), gate.greeting, gate.funFact)
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
    const eventsByRoom = await getEventsForRooms(
      token,
      pickedRooms.map((r) => r.email),
      startISO,
      endISO,
    );
    const conflicts = pickedRooms
      .map((r) => ({ room: r, events: eventsByRoom[r.email] ?? [] }))
      .filter((c) => c.events.length > 0);

    if (conflicts.length > 0) {
      const total = conflicts.reduce((n, c) => n + c.events.length, 0);
      const subject =
        total === 1 ? "another booking" : `${total} other bookings`;
      return jsonResponse({
        response_action: "errors",
        errors: {
          rooms_block: `There's a conflict with ${subject}. See what's on at https://www.farsetlabs.org.uk/whats-on/`,
        },
      });
    }

    const fullDescription = [
      userDescription,
      "",
      `Booked by @${userName} using /create-an-event on Slack`,
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
          await Promise.all([
            postDM(
              env.SLACK_BOT_TOKEN,
              userId,
              `:white_check_mark: Booked *${title}* in *${roomNames}*.\n${event.htmlLink}${note}\n\n${TINKER_LINK}`,
            ),
            announceToChannel(env, {
              title,
              userDescription,
              roomNames,
              startISO,
              endISO,
              userId,
              eventLink: event.htmlLink,
            }),
          ]);
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

async function announceToChannel(
  env: Env,
  args: {
    title: string;
    userDescription: string;
    roomNames: string;
    startISO: string;
    endISO: string;
    userId: string;
    eventLink: string;
  },
): Promise<void> {
  if (!env.EVENTS_CHANNEL_ID) return;
  const range = formatBusyRange(args.startISO, args.endISO);
  const safeTitle = escapeMrkdwn(args.title);
  const headerLines = [
    `:date: *${safeTitle}*`,
    `${range}  ·  ${escapeMrkdwn(args.roomNames)}`,
  ];
  if (args.userDescription) {
    headerLines.push("", escapeMrkdwn(args.userDescription));
  }
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: headerLines.join("\n") },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            `Booked by <@${args.userId}> using \`/create-an-event\`  ·  <${args.eventLink}|See on calendar>  ·  ${TINKER_LINK}`,
        },
      ],
    },
  ];
  const fallback = `New booking: ${args.title} — ${range} in ${args.roomNames}. ${args.eventLink}`;
  try {
    await postChannelMessage(
      env.SLACK_BOT_TOKEN,
      env.EVENTS_CHANNEL_ID,
      fallback,
      blocks,
    );
  } catch (err) {
    console.error("Channel announcement failed:", err);
  }
}

export interface CombinedMembership {
  active: boolean;
  email?: string;
  memberSince?: number;
}

export async function findActiveMembership(
  env: Env,
  email: string,
): Promise<CombinedMembership> {
  const lower = email.toLowerCase();
  const priceIds = env.STRIPE_MEMBERSHIP_PRICE_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const [stripeResult, nexudusResult] = await Promise.all([
    findActiveStripeMembership(env.STRIPE_SECRET_KEY, lower, priceIds).catch((err) => {
      console.error("Stripe membership lookup failed:", err);
      return { active: false, memberSince: undefined, customerIds: [] as string[] };
    }),
    findActiveNexudusMembership(
      env.NEXUDUS_EMAIL,
      env.NEXUDUS_PASSWORD,
      env.NEXUDUS_BUSINESS_ID,
      lower,
    ).catch((err) => {
      console.error("Nexudus membership lookup failed:", err);
      return { active: false, memberSince: undefined };
    }),
  ]);

  const active = stripeResult.active || nexudusResult.active;
  if (!active) return { active: false, email: lower };

  const candidates = [stripeResult.memberSince, nexudusResult.memberSince].filter(
    (v): v is number => typeof v === "number",
  );
  const memberSince = candidates.length > 0 ? Math.min(...candidates) : undefined;
  return { active: true, email: lower, memberSince };
}

async function checkMembership(
  env: Env,
  slackUserId: string,
): Promise<{ allowed: boolean; message: string; greeting?: string; funFact?: string }> {
  try {
    const email = await getUserEmail(env.SLACK_BOT_TOKEN, slackUserId);
    if (!email) {
      return {
        allowed: false,
        message:
          ":lock: We couldn't read your Slack email. Make sure your Slack profile has an email set, or ask another member to help.",
      };
    }
    const { active, memberSince } = await findActiveMembership(env, email);
    if (active) {
      const duration = memberSince ? humanizeDuration(memberSince) : null;
      const greeting = [
        "*Let's create an event!*",
        "Bookings show up on the public <https://www.farsetlabs.org.uk/whats-on/|What's On> calendar — use this to book rooms or run events.",
      ].join("\n\n");
      const funFact = duration
        ? `:partying_face: You've been a Farset Labs member for *${duration}*.`
        : undefined;
      return { allowed: true, message: "", greeting, funFact };
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

function formatBusyRange(startISO: string, endISO: string): string {
  const s = new Date(startISO);
  const e = new Date(endISO);
  const dateFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const startDate = dateFmt.format(s);
  const endDate = dateFmt.format(e);
  const startTime = timeFmt.format(s);
  const endTime = timeFmt.format(e);
  if (startDate === endDate) {
    return `${startDate}, ${startTime}–${endTime}`;
  }
  return `${startDate}, ${startTime} – ${endDate}, ${endTime}`;
}

async function sendDoorCode(
  env: Env,
  slackUserId: string,
  responseUrl: string,
): Promise<void> {
  const gate = await checkMembership(env, slackUserId);
  if (!gate.allowed) {
    await postToResponseUrl(responseUrl, {
      response_type: "ephemeral",
      text: gate.message,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: gate.message } },
        tinkerContextBlock(),
      ],
    });
    return;
  }
  const body =
    `:key: Current Farset Labs door code: *${env.DOOR_CODE}*\n` +
    `_Members only — please don't share outside the membership._\n\n` +
    `:night_with_stars: *If the business park gates are closed at night*, ring security on the telecom at the pedestrian entrance to get in or out. They'll ask for a password — it's *${env.BUSINESS_PARK_GATES_PASSWORD}*.`;
  await postToResponseUrl(responseUrl, {
    response_type: "ephemeral",
    text: body,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: body } },
      tinkerContextBlock(),
    ],
  });
}

async function sendMembersList(
  env: Env,
  slackUserId: string,
  responseUrl: string,
): Promise<void> {
  const gate = await checkMembership(env, slackUserId);
  if (!gate.allowed) {
    await postToResponseUrl(responseUrl, {
      response_type: "ephemeral",
      text: gate.message,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: gate.message } },
        tinkerContextBlock(),
      ],
    });
    return;
  }

  const priceIds = env.STRIPE_MEMBERSHIP_PRICE_IDS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const [stripeList, nexudusList, slackEmailToId] = await Promise.all([
    listActiveStripeMembers(env.STRIPE_SECRET_KEY, priceIds),
    listActiveNexudusMembers(
      env.NEXUDUS_EMAIL,
      env.NEXUDUS_PASSWORD,
      env.NEXUDUS_BUSINESS_ID,
    ),
    listWorkspaceEmailToId(env.SLACK_BOT_TOKEN),
  ]);

  const earliestByEmail = new Map<string, number>();
  for (const m of [...stripeList, ...nexudusList]) {
    const prev = earliestByEmail.get(m.email);
    if (prev === undefined || m.memberSince < prev) {
      earliestByEmail.set(m.email, m.memberSince);
    }
  }

  const inSlack: Array<{ id: string; memberSince: number }> = [];
  for (const [email, memberSince] of earliestByEmail) {
    const id = slackEmailToId.get(email);
    if (id) inSlack.push({ id, memberSince });
  }
  inSlack.sort((a, b) => b.memberSince - a.memberSince);

  const totalCounted = earliestByEmail.size;
  const memberLines = inSlack.map(
    (m) => `<@${m.id}> — member since ${formatOrdinalDate(m.memberSince)}`,
  );
  const lines = [
    `*:farsetlabs: Farset Labs Hackerspace Members*`,
    `${totalCounted} active members — ${inSlack.length} on Slack:`,
    "",
    ...memberLines,
  ];

  await postToResponseUrl(responseUrl, {
    response_type: "ephemeral",
    text: `${inSlack.length} active Farset Labs members on Slack.`,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
      tinkerContextBlock(),
    ],
  });
}

async function sendWifi(
  env: Env,
  slackUserId: string,
  responseUrl: string,
): Promise<void> {
  const guestBlock =
    `*Guest Wi-Fi* (share with friends and visitors)\n` +
    `• Network: \`${env.WIFI_GUEST_SSID}\`\n` +
    `• Password: \`${env.WIFI_GUEST_PASSWORD}\``;

  const gate = await checkMembership(env, slackUserId);
  const body = gate.allowed
    ? `:signal_strength: Farset Labs Wi-Fi\n\n` +
      `*Members Wi-Fi* (don't share)\n` +
      `• Network: \`${env.WIFI_MEMBER_SSID}\`\n` +
      `• Password: \`${env.WIFI_MEMBER_PASSWORD}\`\n\n` +
      `${guestBlock}`
    : `:signal_strength: Farset Labs Wi-Fi\n\n` +
      `${guestBlock}\n\n` +
      `_Members get the members-only network too — ${gate.message}_`;

  await postToResponseUrl(responseUrl, {
    response_type: "ephemeral",
    text: body,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: body } },
      tinkerContextBlock(),
    ],
  });
}

async function computeAndSendStats(
  env: Env,
  slackUserId: string,
  slackUserName: string,
  responseUrl: string,
  options: { personalOnly?: boolean } = {},
): Promise<void> {
  const personalOnly = options.personalOnly === true;
  try {
    const email = await getUserEmail(env.SLACK_BOT_TOKEN, slackUserId);
    if (!email) {
      await postToResponseUrl(responseUrl, {
        response_type: "ephemeral",
        text: ":lock: We couldn't read your Slack email. Make sure your Slack profile has an email set, or ask another member to help.",
      });
      return;
    }

    const lower = email.toLowerCase();
    const priceIds = env.STRIPE_MEMBERSHIP_PRICE_IDS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const productNames = await getProductNames(env.STRIPE_SECRET_KEY);

    const [stripeList, nexudusList, stripePersonal] = await Promise.all([
      listActiveStripeMembers(env.STRIPE_SECRET_KEY, priceIds, productNames),
      listActiveNexudusMembers(
        env.NEXUDUS_EMAIL,
        env.NEXUDUS_PASSWORD,
        env.NEXUDUS_BUSINESS_ID,
      ),
      findActiveStripeMembership(env.STRIPE_SECRET_KEY, lower, priceIds, productNames),
    ]);

    type MergedMember = { memberSince: number; tierName?: string };
    const merged = new Map<string, MergedMember>();
    for (const s of stripeList) {
      merged.set(s.email, { memberSince: s.memberSince, tierName: s.tierName });
    }
    for (const n of nexudusList) {
      const prev = merged.get(n.email);
      if (prev) {
        if (n.memberSince < prev.memberSince) prev.memberSince = n.memberSince;
        if (n.tariffName) prev.tierName = n.tariffName;
      } else {
        merged.set(n.email, { memberSince: n.memberSince, tierName: n.tariffName });
      }
    }

    const me = merged.get(lower);
    if (!me) {
      await postToResponseUrl(responseUrl, {
        response_type: "ephemeral",
        text: `No active Farset Labs membership found for ${email}.`,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `:bar_chart: No active Farset Labs membership found for *${email}*.\n\n` +
                `• Not a member yet? <${env.MEMBERSHIP_SIGNUP_URL}|Join Farset Labs>.\n` +
                `• Pay under a different email? <${env.STRIPE_BILLING_PORTAL_URL}|Manage it in Stripe>, or change your Slack profile email to match.`,
            },
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: TINKER_LINK }],
          },
        ],
      });
      return;
    }

    let lines: string[];
    if (personalOnly) {
      lines = [
        `Total time as a member: ${preciseDuration(me.memberSince)} (joined on ${formatOrdinalDateTime(me.memberSince)})`,
      ];
    } else {
      const cutoff30 = Math.floor(Date.now() / 1000) - 30 * 86400;
      let olderThanUser = 0;
      let joinedLast30 = 0;
      const tierBreakdown: Record<string, number> = {};
      for (const m of merged.values()) {
        if (m.memberSince < me.memberSince) olderThanUser += 1;
        if (m.memberSince >= cutoff30) joinedLast30 += 1;
        const tierKey = m.tierName ?? "Membership";
        tierBreakdown[tierKey] = (tierBreakdown[tierKey] ?? 0) + 1;
      }

      const [leftLast30, contributionPence] = await Promise.all([
        getRecentStripeLeavers(env.STRIPE_SECRET_KEY, priceIds),
        stripePersonal.customerIds.length > 0
          ? getLifetimeContributionPence(env.STRIPE_SECRET_KEY, stripePersonal.customerIds)
          : Promise.resolve(0),
      ]);

      const rank = olderThanUser + 1;
      const joinDate = formatOrdinalDate(me.memberSince);
      const contribution = formatPounds(contributionPence);
      const tierSplitText = orderedTierBreakdown(tierBreakdown)
        .map(([name, count]) => `${name} ${count}`)
        .join(" · ");
      const openedDate = formatOrdinalDate(unixFromIsoDate(FARSET_LABS_OPENED_AT));
      const birthdayMsg = nextBirthdayMessage(FARSET_LABS_OPENED_AT);
      const tierName = me.tierName ?? "Membership";
      lines = [
        `> *:bar_chart: @${slackUserName}*`,
        `> `,
        `> • You're the ${ordinal(rank)} longest-active member, active since ${joinDate} (${humanizeDuration(me.memberSince)})`,
        `> • You've contributed ${contribution} to the hackerspace via Stripe :green_heart:`,
        `> `,
        `> :credit_card: You're on ${tierName} membership. <${env.STRIPE_BILLING_PORTAL_URL}|Manage it in Stripe>.`,
        `> `,
        `> *:farsetlabs: Farset Labs Hackerspace*`,
        `> `,
        `> • ${merged.size} active members: ${tierSplitText}`,
        `> • ${joinedLast30} joined and ${leftLast30} left in the last 30 days`,
        `> • Open since ${openedDate} — next birthday is ${birthdayMsg}.`,
        `> `,
        `> ${TINKER_LINK}`,
      ];
    }

    const blockquote = lines.join("\n");

    await postToResponseUrl(responseUrl, {
      response_type: "ephemeral",
      text: personalOnly
        ? `Your Farset Labs membership stats.`
        : `Your Farset Labs membership and lab stats.`,
      blocks: personalOnly
        ? [
            {
              type: "section",
              text: { type: "mrkdwn", text: blockquote },
            },
            tinkerContextBlock(),
          ]
        : [
            {
              type: "section",
              text: { type: "mrkdwn", text: blockquote },
            },
          ],
    });
  } catch (err) {
    console.error("Stats compute failed:", err);
    await postToResponseUrl(responseUrl, {
      response_type: "ephemeral",
      text: ":warning: Couldn't fetch stats right now. Please try again in a moment.",
    });
  }
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function formatOrdinalDateTime(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);
  return `${formatOrdinalDate(unixSeconds)} at ${time}`;
}

function formatOrdinalDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(d);
  const day = parts.find((p) => p.type === "day")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  return `${ordinal(parseInt(day, 10))} ${month} ${year}`;
}

function formatPounds(pence: number): string {
  if (pence % 100 === 0) {
    return `£${(pence / 100).toLocaleString("en-GB")}`;
  }
  return `£${(pence / 100).toLocaleString("en-GB", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function nextBirthdayMessage(isoDate: string): string {
  const opened = parseIsoDate(isoDate);
  const now = new Date();
  const thisYear = now.getUTCFullYear();
  let next = new Date(
    Date.UTC(thisYear, opened.getUTCMonth(), opened.getUTCDate()),
  );
  if (next.getTime() <= now.getTime()) {
    next = new Date(
      Date.UTC(thisYear + 1, opened.getUTCMonth(), opened.getUTCDate()),
    );
  }
  const days = Math.ceil((next.getTime() - now.getTime()) / 86_400_000);
  if (days === 0) return "today!";
  if (days === 1) return "tomorrow";
  if (days < 14) return `in ${days} days`;
  if (days < 60) {
    const weeks = Math.round(days / 7);
    return weeks === 1 ? "in a week" : `in ${weeks} weeks`;
  }
  const months = Math.round(days / 30);
  return months === 1 ? "in a month" : `in ${months} months`;
}

function parseIsoDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function unixFromIsoDate(iso: string): number {
  return Math.floor(parseIsoDate(iso).getTime() / 1000);
}

function orderedTierBreakdown(
  breakdown: Record<string, number>,
): Array<[string, number]> {
  const rank = (name: string) => {
    const idx = TIER_ORDER.indexOf(name);
    return idx === -1 ? TIER_ORDER.length : idx;
  };
  return Object.entries(breakdown)
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => rank(a) - rank(b));
}

function preciseDuration(unixStartSeconds: number): string {
  const start = new Date(unixStartSeconds * 1000);
  const now = new Date();
  if (now.getTime() <= start.getTime()) {
    return "0 years, 0 days, 0 hours, 0 minutes, 0 seconds";
  }

  let years = now.getUTCFullYear() - start.getUTCFullYear();
  let days = now.getUTCDate() - start.getUTCDate();
  let monthDelta = now.getUTCMonth() - start.getUTCMonth();
  let hours = now.getUTCHours() - start.getUTCHours();
  let minutes = now.getUTCMinutes() - start.getUTCMinutes();
  let seconds = now.getUTCSeconds() - start.getUTCSeconds();

  if (seconds < 0) { seconds += 60; minutes -= 1; }
  if (minutes < 0) { minutes += 60; hours -= 1; }
  if (hours < 0) { hours += 24; days -= 1; }
  if (days < 0) {
    const prevMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    days += prevMonth.getUTCDate();
    monthDelta -= 1;
  }
  if (monthDelta < 0) { monthDelta += 12; years -= 1; }

  // Roll any leftover whole months into days using the calendar month lengths
  // walked forward from the start date.
  let cursorYear = start.getUTCFullYear();
  let cursorMonth = start.getUTCMonth() + 12 * years;
  while (monthDelta > 0) {
    const monthLen = new Date(Date.UTC(cursorYear, cursorMonth + 1, 0)).getUTCDate();
    days += monthLen;
    cursorMonth += 1;
    monthDelta -= 1;
  }

  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (years > 0) parts.push(part(years, "year"));
  if (days > 0) parts.push(part(days, "day"));
  if (hours > 0) parts.push(part(hours, "hour"));
  if (minutes > 0) parts.push(part(minutes, "minute"));
  if (seconds > 0) parts.push(part(seconds, "second"));
  return parts.length > 0 ? parts.join(", ") : "0 seconds";
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

