# create-an-event-through-slack

> Farset Labs is a hackerspace — about tinkering with technology. **This is a project. Tinker with it.**
>
> Read it. Break it (in a branch). Fix something that bugs you. Add a feature you want. Open a PR. The lab is collectively maintained, and so is this.

A small Cloudflare Worker that powers the **Create an Event** Slack app. Members run `/create-an-event` in Slack, fill in a form, and a real Google Calendar event lands on the Farset Labs Events calendar with the right rooms blocked.

---

## Usage — using it as a member

In any channel in the Farset Labs Slack, type:

```
/create-an-event
```

A form pops up. Fill in **Title**, optional **Description**, **Start**, **End**, and tick **one or more rooms**. Hit **Book**. You'll get a DM within a few seconds with a link to the calendar event.

If `EVENTS_CHANNEL_ID` is configured, the booking is also posted to a Slack channel (typically `#events`) with the title, time, rooms, your @-mention, and a link to the calendar event.

### Other commands

- **`/stats`** — see your own membership info plus a lab-wide snapshot. Shows when you joined, your tenure and rank (*Nth* longest-active member), your tier, your lifetime contribution, plus active member count, tier split, joiners/leavers in the last 30 days, and the lab's opening anniversary. Ephemeral reply (only you see it).

### "Members only" — what's that about?

The bot only accepts bookings from people with an active Stripe membership. When you run `/create-an-event`, it:

1. Reads your Slack profile email.
2. Asks Stripe whether that email has an active membership subscription.
3. If yes → opens the form (with a wee greeting telling you how long you've been a member).
4. If no → tells you politely, with two ways to resolve.

The two resolutions, in order of preference:

- **You're not yet a member?** [Join Farset Labs](https://www.farsetlabs.org.uk/).
- **Your Stripe email differs from your Slack email?** Either update Stripe's email via the customer portal (link is in the bot's reply), or update your Slack profile email to match what's on Stripe.

In a pinch a fellow member can book on your behalf, but please try the above first — bot accountability gets fuzzy when bookings don't match the actual person using the room.

### Something looks broken?

DM whoever's been on the project lately, post in `#tech` (or whatever the current channel is), or just open a GitHub issue. Saying "this didn't work and here's the screenshot" is a perfectly valid contribution.

---

## Maintenance — tinkering with the project

This is a normal repo. Clone it, edit it, deploy it. There's nothing magical going on.

### What's involved (every piece, plain English)

The whole thing is one Cloudflare Worker plus four external services. Each piece does one thing:

- **Slack app** — the user-facing chat UI. Owns the slash command and the modal. Configured at [api.slack.com/apps](https://api.slack.com/apps). Sends webhooks to the Worker when someone runs the command or submits the form.
- **Cloudflare Worker** — the brains. Receives Slack webhooks, talks to Stripe and Google, replies to Slack. Runs on Cloudflare's free tier. Configured at [dash.cloudflare.com](https://dash.cloudflare.com).
- **Google Workspace + Calendar** — where the actual events get created. Rooms are configured as Workspace **resources** (admin.google.com → Buildings and resources). The Worker uses a **service account** with **Domain-Wide Delegation** to act as a Workspace user (`services@farsetlabs.org.uk`) — that's what gives it permission to attach rooms to events.
- **Stripe** — source of truth for "is this person a member?". The Worker uses a read-only restricted API key.
- **GitHub** — where this code lives. Pushing to `main` auto-deploys via GitHub Actions. PRs welcome.

### How to get access to the pieces

| Piece | How to get access |
|---|---|
| **GitHub repo** | It's on Farset Labs' org. Ask a director if you need write access. Reading and forking are public. |
| **Cloudflare** | Ask a director — they'll add you to the Farset Labs Cloudflare account as a collaborator. |
| **Slack app config** | Ask a Workspace admin to add you as a "collaborator" on the app at api.slack.com/apps. |
| **Google Workspace admin** | Ask a director. Most maintenance doesn't need it. |
| **Stripe dashboard** | Ask a director. Most maintenance doesn't need it (the Worker uses a restricted API key, not a personal Stripe login). |

If you're not sure who a director is, see the Farset Labs website or ask in Slack.

### Where every config value comes from

The Worker is configured by **secrets** — encrypted environment variables stored in Cloudflare. Set them with `npx wrangler secret put NAME` (or pipe a file in: `npx wrangler secret put NAME < file.txt`).

> 🤖 **Don't know what something means? Ask Claude / ChatGPT / any LLM.** Paste the secret name, paste the description, and ask "where do I find this in the [Stripe / Google / Slack] dashboard". They're great at walking through these UIs.

#### Safe to set yourself

These are non-sensitive or you can find them yourself.

| Secret | What it is | Where to get it |
|---|---|---|
| `MEMBERSHIP_SIGNUP_URL` | Where non-members are pointed to join. | Wherever the lab's signup page lives — usually farsetlabs.org.uk. |
| `STRIPE_BILLING_PORTAL_URL` | Self-service link for members to update their billing email. | dashboard.stripe.com → Settings → Billing → Customer portal → copy the "Login link". Not secret. |
| `ROOMS_JSON` | JSON array of `{ name, email, capacity }` for each bookable room. | admin.google.com → Buildings and resources → click each room → copy the **Resource email** field. Capacity is the number you set when creating the room. |
| `GOOGLE_CALENDAR_ID` | The Farset Labs Events calendar's ID. | calendar.google.com → "Farset Labs Events" → Settings and sharing → "Calendar ID" field. |
| `GOOGLE_IMPERSONATE_SUBJECT` | Workspace user the bot acts as (currently `services@farsetlabs.org.uk`). | Just an email address. The user has to actually exist in Workspace and have access to the calendars. |
| `EVENTS_CHANNEL_ID` *(optional)* | Slack channel ID where bookings are announced (e.g. `#events`). Leave unset to disable channel announcements. | In Slack, right-click the channel → "Copy link" → grab the trailing `C…` segment. **Then `/invite @Create an Event` in that channel** — the bot must be a member to post there. |

#### Ask a director for these

These are sensitive — leaking them could let someone impersonate the bot, read membership data, or mess with the Google account.

| Secret | What it is | How to get it (with director help) |
|---|---|---|
| `SLACK_SIGNING_SECRET` | Slack uses this to prove webhooks really came from Slack. | api.slack.com/apps → Create an Event → Basic Information → App Credentials → Signing Secret. **A director can give you read access to the app.** |
| `SLACK_BOT_TOKEN` | The Slack bot's identity (`xoxb-...`). Lets the Worker post messages as the bot. | api.slack.com/apps → Create an Event → OAuth & Permissions → Bot User OAuth Token. **Same access as above.** |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | The full JSON private key for the service account that books events. **Treat like a password.** | console.cloud.google.com → IAM & Admin → Service Accounts → click the bot account → Keys → Create new key (JSON). Pipe the file into `wrangler secret put` — don't paste it. **Ask a director with GCP access.** |
| `STRIPE_SECRET_KEY` | Read-only Stripe API key for the membership check, `/stats` lookups, and lifetime contribution sums. | dashboard.stripe.com → Developers → API keys → Restricted keys → Create. Permissions, all **Read** only: **Customers**, **Customer search** (if shown separately), **Subscriptions**, **Products**, **Events**, **Invoices**. Nothing else. The bot never writes. **Ask a director with Stripe access.** |
| `STRIPE_MEMBERSHIP_PRICE_IDS` | Comma-separated list of Stripe Price IDs that count as a membership. | dashboard.stripe.com → Product catalog → click each membership product → copy each Price ID. **Director can pull these in two minutes.** |

If you're rotating one of the sensitive secrets (because someone left, or it leaked), you also need to invalidate the old one — revoke the Stripe key, regenerate the service-account key, etc. **Ask a director to help; this is the kind of thing where small mistakes have big consequences.**

### How to actually deploy a change

```bash
git clone https://github.com/farsetlabs/create-an-event-through-slack.git
cd create-an-event-through-slack
npm install
```

Make your change. Type-check it:

```bash
npx tsc --noEmit
```

Push to a branch, open a PR. When it merges to `main`, GitHub Actions auto-deploys (see `.github/workflows/deploy.yml`).

If you want to deploy a quick fix without going through CI (e.g. you're a maintainer with Cloudflare access and the prod bot is broken):

```bash
npx wrangler login
npx wrangler deploy
```

### Local development

```bash
npx wrangler dev
```

Set local secrets in a `.dev.vars` file (gitignored). Slack can't reach your `localhost`, so for end-to-end testing either:
- Use `npx wrangler dev --remote` (Cloudflare gives you a temporary public URL) and point the Slack app at it temporarily.
- Or just push to a branch and use the deployed preview URL.

### Architecture diagram

```
Slack workspace (Farset Labs)
  ├─ /create-an-event ──► POST /slack/commands
  │                          │
  │                          ├─ verify Slack signature
  │                          ├─ ask Stripe: "is this email a member?"
  │                          │     ├─ no  → ephemeral "members only" reply
  │                          │     └─ yes → open booking modal
  │                          └─ done
  │
  ├─ /stats ──────────► POST /slack/commands
  │                          │
  │                          ├─ verify Slack signature
  │                          ├─ ack with empty 200 (async work follows)
  │                          └─ in waitUntil:
  │                                ├─ Slack: get user's email
  │                                ├─ Stripe: products + active membership
  │                                ├─ Stripe: lab stats (active subs walk + leavers events) ‖
  │                                │   Stripe: lifetime invoices
  │                                └─ POST to response_url with rendered ephemeral
  │
  └─ Modal submit ──► POST /slack/interactions
                              │
                              ├─ list events across selected rooms (events.list)
                              │   → if any conflict, surface "There's a conflict with N other bookings"
                              ├─ create one event on the Events calendar
                              │   with rooms attached as resource attendees
                              ├─ DM booker with calendar link
                              └─ (if EVENTS_CHANNEL_ID set) post announcement to #events channel
```

### Code map

```
src/
├── index.ts     # Worker entrypoint — routes /health, /slack/commands, /slack/interactions, glue logic
├── google.ts    # Service-account JWT + DWD, room events listing, event creation
├── slack.ts     # Signature verification, modal builders, users.info, DM + channel posting
├── stripe.ts    # Membership lookup, lab stats walk (active subs + leaver events), lifetime invoice sum, product-name map
└── types.ts     # Env, Room, SlackBlockValue, etc.
```

### Adding a new room

1. Create the room in **admin.google.com → Buildings and resources**.
2. Subscribe to it in **calendar.google.com** (Other calendars → + → Browse resources).
3. Share its calendar with the impersonated Workspace user (currently `services@farsetlabs.org.uk`), permission **Make changes to events**.
4. Append a new entry to your local `rooms.json`:
   ```json
   { "name": "New Room", "email": "farsetlabs.org.uk_…@resource.calendar.google.com", "capacity": 12 }
   ```
5. Push the new file to Cloudflare:
   ```bash
   npx wrangler secret put ROOMS_JSON < rooms.json
   npx wrangler deploy
   ```

No code change needed — the modal reads from `ROOMS_JSON` on every open.

### Things to tinker with

A non-exhaustive list of "would be nice if someone built this" — pick whatever scratches your itch:

- **`/my-bookings`** — list your future bookings.
- **`/cancel-booking`** — cancel one of your bookings without leaving Slack.
- **Public-vs-private booking distinction** — currently every booking ends up on the public Events calendar; not every meeting needs that.
- **Cache the membership check** — Stripe gets pinged every time someone runs the command. Workers KV could cache for an hour per user.
- **Repeat-this-booking helper** — DM button after a successful booking that pre-fills the modal for next week.
- **Room descriptions in the dropdown** — extend `ROOMS_JSON` with a `description` field so newcomers know what each room is good for.
- **Trustee/external-visitor override** — allowlist of Slack IDs that can bypass the Stripe gate to book for visiting groups.
- **Post-booking reminders** — Cloudflare Cron Trigger that DMs bookers the day before.
- **Lightweight charity analytics** — weekly digest to trustees: top rooms, top members, occupancy by hour.
- **Recurring bookings** — Wednesday Hack Night, weekly knit-and-natter, etc.
- **Better duration parsing** — let people type "tomorrow 7-9pm" instead of using two pickers.
- **Past-time guard** — currently you can technically book yesterday.
- **Tier-aware UI** — show different rooms / time slots depending on membership tier.
- **Tests** — there are none. Bun has a test runner, vitest works too. PRs welcome.

---

## Endpoints

- `GET /health` — liveness check, returns `200 ok`.
- `POST /slack/commands` — receives the slash command.
- `POST /slack/interactions` — receives modal submissions and global shortcut clicks.

## Operational notes

- **Conflict detection** runs `events.list` on every selected room calendar before booking. If any room has a conflicting event, the modal stays open with a count of conflicts and a link to the public calendar — no event titles are exposed.
- **Room auto-accept** is handled by Workspace's native resource booking. If a room declines (e.g. its policy refuses the user), the booker gets a warning in their DM. The channel announcement still goes out.
- **Channel announcement** is optional — if `EVENTS_CHANNEL_ID` isn't set, only the DM goes out. The bot must be a member of the announcement channel (`/invite @Create an Event` from inside the channel).
- **Mrkdwn injection** — booker-supplied text (title, description, room names) is HTML-escaped before being broadcast to the public channel, so members can't inject `<!channel>`, `<@U…>`, or other Slack control sequences.
- **Stripe error redaction** — when a Stripe call fails, the response body is logged with any `rk_/sk_/pk_*_…` key suffixes redacted before reaching `wrangler tail`.
- **Token caching** — Google service-account JWTs are cached in-memory per Worker isolate.
- **No caching on Stripe** — each `/create-an-event` and `/stats` invocation hits Stripe. Fine at hackerspace scale.
