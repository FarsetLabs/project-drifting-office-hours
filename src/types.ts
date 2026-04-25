export interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_CALENDAR_ID: string;
  GOOGLE_IMPERSONATE_SUBJECT: string;
  ROOMS_JSON: string;
}

export interface Room {
  name: string;
  email: string;
  capacity: number;
}

export interface Booking {
  title: string;
  date: string;        // YYYY-MM-DD
  startTime: string;   // HH:MM
  endTime: string;     // HH:MM
  room: string;
  visibility: "public" | "private";
  description: string;
  bookerSlackId: string;
  bookerName: string;
}

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

export interface SlackViewSubmission {
  type: "view_submission";
  user: { id: string; name: string };
  view: {
    callback_id: string;
    state: { values: Record<string, Record<string, SlackBlockValue>> };
  };
}

export interface SlackBlockValue {
  type: string;
  value?: string;
  selected_option?: { value: string };
  selected_date?: string;
  selected_time?: string;
}
