# create-an-event-through-slack

Cloudflare Worker that powers the **Create an Event** Slack app. A `/create-an-event` slash command opens a modal; submitting it creates an event on the Farset Labs Events Google Calendar.

## Architecture

```
Slack workspace
  ├─ /create-an-event  ──►  POST /slack/commands       ──►  views.open (modal)
  └─ Modal submit      ──►  POST /slack/interactions   ──►  Google Calendar API
                                                              │
                                                              └──DM──►  Slack
```

## Endpoints

- `GET /health` — liveness check.
- `POST /slack/commands` — receives the `/create-an-event` slash command, opens the booking modal.
- `POST /slack/interactions` — receives modal submissions and global shortcuts.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Set Worker secrets

```bash
npx wrangler secret put SLACK_SIGNING_SECRET   # Basic Information → App Credentials → Signing Secret
npx wrangler secret put SLACK_BOT_TOKEN        # OAuth & Permissions → Bot User OAuth Token (xoxb-...)
npx wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON   # paste full service account JSON file contents
npx wrangler secret put GOOGLE_CALENDAR_ID     # farsetlabs.org.uk_srmqnkn373auq51u00s2nijrq8@group.calendar.google.com
```

### 3. Deploy

```bash
npx wrangler deploy
```

The Worker will be live at `https://create-an-event-through-slack.<your-subdomain>.workers.dev`.

### 4. Update the Slack app's URLs

At **api.slack.com/apps → Create an Event**:

- **Slash Commands** → `/create-an-event` → request URL: `https://create-an-event-through-slack.<your-subdomain>.workers.dev/slack/commands`
- **Interactivity & Shortcuts** → request URL: `https://create-an-event-through-slack.<your-subdomain>.workers.dev/slack/interactions`

Save both. No reinstall needed unless OAuth scopes change.

### 5. GitHub Actions (optional, for auto-deploy on push to main)

Add these repo secrets in **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — Workers Edit token
- `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID

The workflow in `.github/workflows/deploy.yml` runs on every push to `main`.

## Local dev

```bash
npx wrangler dev
```

Use a `.dev.vars` file (gitignored) to set local secrets. Note: Slack can't reach `localhost`, so for end-to-end testing you'll want `wrangler dev --remote` or just deploy to a preview environment.
