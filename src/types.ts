export interface Env {
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  GOOGLE_CALENDAR_ID: string;
  GOOGLE_IMPERSONATE_SUBJECT: string;
  ROOMS_JSON: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_MEMBERSHIP_PRICE_IDS: string;
  NEXUDUS_EMAIL: string;
  NEXUDUS_PASSWORD: string;
  NEXUDUS_BUSINESS_ID: string;
  NEXUDUS_PORTAL_URL: string;
  MEMBERSHIP_SIGNUP_URL: string;
  STRIPE_BILLING_PORTAL_URL: string;
  DOOR_CODE: string;
  BUSINESS_PARK_GATES_PASSWORD: string;
  WIFI_MEMBER_SSID: string;
  WIFI_MEMBER_PASSWORD: string;
  WIFI_GUEST_SSID: string;
  WIFI_GUEST_PASSWORD: string;
  EVENTS_CHANNEL_ID?: string;
}

export interface Room {
  name: string;
  email: string;
  capacity: number;
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
  value?: string | null;
  selected_options?: Array<{ value: string }>;
  selected_option?: { value: string } | null;
  selected_date_time?: number | null;
}
