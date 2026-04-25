import type { Room } from "./types";

const FIVE_MINUTES = 5 * 60;

export const TINKER_LINK =
  ":wrench: Want to change how this works? <https://github.com/FarsetLabs/project-drifting-office-hours|Edit on GitHub>.";

function tinkerContextBlock(): object {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: TINKER_LINK }],
  };
}

export async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string,
): Promise<boolean> {
  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > FIVE_MINUTES) return false;

  const base = `v0:${timestamp}:${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(base),
  );
  const expected = "v0=" + bufferToHex(new Uint8Array(sigBuf));
  return constantTimeEqual(expected, signature);
}

export async function openModal(
  botToken: string,
  triggerId: string,
  view: object,
): Promise<void> {
  const res = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string; response_metadata?: unknown };
  if (!data.ok) {
    console.error("views.open failed:", data.error, data.response_metadata);
    throw new Error(`views.open failed: ${data.error}`);
  }
}

export async function postDM(
  botToken: string,
  userId: string,
  text: string,
): Promise<void> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: userId, text }),
  });
  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    console.error("chat.postMessage failed:", data.error);
  }
}

export async function getUserEmail(
  botToken: string,
  userId: string,
): Promise<string | null> {
  const res = await fetch(
    `https://slack.com/api/users.info?user=${encodeURIComponent(userId)}`,
    { headers: { Authorization: `Bearer ${botToken}` } },
  );
  const data = (await res.json()) as {
    ok: boolean;
    error?: string;
    user?: { profile?: { email?: string } };
  };
  if (!data.ok) {
    console.error("users.info failed:", data.error);
    return null;
  }
  return data.user?.profile?.email ?? null;
}

export function buildErrorModal(message: string): object {
  return {
    type: "modal",
    title: { type: "plain_text", text: "Members only" },
    close: { type: "plain_text", text: "Close" },
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: message } },
      { type: "divider" },
      tinkerContextBlock(),
    ],
  };
}

export function buildBookingModal(rooms: Room[], greeting?: string): object {
  const roomOptions = rooms.map((r) => ({
    text: { type: "plain_text", text: `${r.name} (${r.capacity} seats)` },
    value: r.email,
  }));
  const blocks: object[] = [];
  if (greeting) {
    blocks.push(
      { type: "section", text: { type: "mrkdwn", text: greeting } },
      { type: "divider" },
    );
  }
  blocks.push(
    {
      type: "input",
      block_id: "title_block",
      label: { type: "plain_text", text: "Title" },
      element: {
        type: "plain_text_input",
        action_id: "title",
        placeholder: { type: "plain_text", text: "e.g. Soldering night" },
        max_length: 100,
      },
    },
    {
      type: "input",
      block_id: "description_block",
      optional: true,
      label: { type: "plain_text", text: "Description" },
      element: {
        type: "plain_text_input",
        action_id: "description",
        multiline: true,
        max_length: 2000,
        placeholder: {
          type: "plain_text",
          text: "Here's what's on, and how to sign up to the event: https://example.com",
        },
      },
    },
    {
      type: "input",
      block_id: "start_block",
      label: { type: "plain_text", text: "Start" },
      element: { type: "datetimepicker", action_id: "start" },
    },
    {
      type: "input",
      block_id: "end_block",
      label: { type: "plain_text", text: "End" },
      element: { type: "datetimepicker", action_id: "end" },
    },
    {
      type: "input",
      block_id: "rooms_block",
      label: { type: "plain_text", text: "Rooms" },
      element: {
        type: "multi_static_select",
        action_id: "rooms",
        placeholder: { type: "plain_text", text: "Pick one or more rooms" },
        options: roomOptions,
      },
    },
    { type: "divider" },
    tinkerContextBlock(),
  );
  return {
    type: "modal",
    callback_id: "submit_booking",
    title: { type: "plain_text", text: "Create an Event" },
    submit: { type: "plain_text", text: "Book" },
    close: { type: "plain_text", text: "Cancel" },
    blocks,
  };
}

function bufferToHex(buf: Uint8Array): string {
  let out = "";
  for (const b of buf) out += b.toString(16).padStart(2, "0");
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
