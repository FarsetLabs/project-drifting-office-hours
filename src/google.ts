import type { ServiceAccountKey } from "./types";

const SCOPE = "https://www.googleapis.com/auth/calendar";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getAccessToken(
  keyJson: string,
  subject?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const cacheKey = subject ?? "_self";
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + 60) {
    return cached.token;
  }

  const key: ServiceAccountKey = JSON.parse(keyJson);
  const header = { alg: "RS256", typ: "JWT" };
  const claim: Record<string, unknown> = {
    iss: key.client_email,
    scope: SCOPE,
    aud: key.token_uri,
    iat: now,
    exp: now + 3600,
  };
  if (subject) claim.sub = subject;

  const enc = (obj: unknown) =>
    base64url(new TextEncoder().encode(JSON.stringify(obj)));
  const unsigned = `${enc(header)}.${enc(claim)}`;

  const pkcs8 = pemToArrayBuffer(key.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(unsigned),
  );
  const jwt = `${unsigned}.${base64url(new Uint8Array(sigBuf))}`;

  const res = await fetch(key.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey, {
    token: data.access_token,
    expiresAt: now + data.expires_in,
  });
  return data.access_token;
}

export interface RoomEvent {
  summary: string;
  visibility?: string;
  start: string;
  end: string;
}

export async function getEventsForRooms(
  token: string,
  calendarIds: string[],
  startISO: string,
  endISO: string,
): Promise<Record<string, RoomEvent[]>> {
  const entries = await Promise.all(
    calendarIds.map(async (id): Promise<[string, RoomEvent[]]> => {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`,
      );
      url.searchParams.set("timeMin", startISO);
      url.searchParams.set("timeMax", endISO);
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("orderBy", "startTime");

      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        throw new Error(
          `events.list (${id}) failed: ${res.status} ${await res.text()}`,
        );
      }
      const data = (await res.json()) as {
        items: Array<{
          summary?: string;
          visibility?: string;
          start: { dateTime?: string; date?: string };
          end: { dateTime?: string; date?: string };
        }>;
      };
      const events: RoomEvent[] = data.items.map((e) => ({
        summary: e.summary ?? "",
        visibility: e.visibility,
        start: e.start.dateTime ?? e.start.date ?? "",
        end: e.end.dateTime ?? e.end.date ?? "",
      }));
      return [id, events];
    }),
  );
  return Object.fromEntries(entries);
}

export interface CreatedEvent {
  htmlLink: string;
  id: string;
  attendees?: Array<{ email: string; resource?: boolean; responseStatus?: string }>;
}

export async function createEvent(
  token: string,
  calendarId: string,
  event: {
    summary: string;
    description: string;
    location: string;
    startISO: string;
    endISO: string;
    roomEmails?: string[];
  },
): Promise<CreatedEvent> {
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
  );
  if (event.roomEmails?.length) url.searchParams.set("sendUpdates", "all");

  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    location: event.location,
    start: { dateTime: event.startISO, timeZone: "Europe/London" },
    end: { dateTime: event.endISO, timeZone: "Europe/London" },
  };
  if (event.roomEmails?.length) {
    body.attendees = event.roomEmails.map((email) => ({ email, resource: true }));
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Create event failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as CreatedEvent;
}

export interface RoomBookingResult {
  roomEmail: string;
  link?: string;
  error?: string;
}

export async function createRoomBookings(
  token: string,
  roomEmails: string[],
  event: {
    summary: string;
    description: string;
    location: string;
    startISO: string;
    endISO: string;
  },
): Promise<RoomBookingResult[]> {
  return Promise.all(
    roomEmails.map(async (roomEmail): Promise<RoomBookingResult> => {
      try {
        const created = await createEvent(token, roomEmail, event);
        return { roomEmail, link: created.htmlLink };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { roomEmail, error: message };
      }
    }),
  );
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}
