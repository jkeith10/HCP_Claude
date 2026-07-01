# HVAC Assistant

A standalone, mobile‑friendly assistant you can **talk to on your phone** that acts in your
**Housecall Pro** account through its REST API. It's a small web app (installable as a
PWA) backed by a Node server that runs a Claude tool‑use loop.

- **Read‑only by default:** schedule, customers, service history, unpaid invoices, unsigned estimates.
- **Write actions behind a confirm step:** create/update jobs and estimates only run after you tap **Confirm**.
- **Secrets stay on the server:** your Housecall Pro API key and Anthropic API key live only in environment variables — never in the repo, never sent to the browser.

---

## How it works

```
 Phone (PWA chat + voice)
        │  HTTPS  (session id, optional password — never the API keys)
        ▼
 Node/Express server
        │  Claude tool-use loop (Opus 4.8)
        ├── read tools  → run immediately against Housecall Pro
        └── write tools → PAUSE → phone shows a confirm card → on Confirm, run
        │
        ▼  Authorization: Token <HOUSECALL_API_KEY>
 Housecall Pro REST API
```

The browser only ever sends your chat messages and (optionally) a shared access
password. The Housecall Pro and Anthropic keys are read from environment
variables on the server via `src/config.js` and are never exposed to the client.

---

## Prerequisites

- **Node.js 20+**
- A **Housecall Pro API key** — API access requires a Pro on the **MAX** plan.
  Find it under **Settings → API** in Housecall Pro.
- An **Anthropic API key** — https://console.anthropic.com/

---

## Setup

```bash
npm install
cp .env.example .env
# then edit .env and fill in the keys
npm start
```

Open `http://localhost:3000` (on your phone, use the machine's LAN address, or
deploy — see below). If `APP_PASSWORD` is set, you'll be asked for it once.

### Environment variables (`.env`)

| Variable             | Required | Purpose                                                        |
| -------------------- | -------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`  | yes      | Powers the assistant.                                          |
| `HOUSECALL_API_KEY`  | yes      | Your Housecall Pro API key. **Server‑side only.**              |
| `HOUSECALL_API_BASE` | no       | Defaults to `https://api.housecallpro.com`.                    |
| `APP_PASSWORD`       | no       | Shared password gate. **Strongly recommended** (it can write). |
| `ANTHROPIC_MODEL`    | no       | Defaults to `claude-opus-4-8`.                                 |
| `PORT`               | no       | Defaults to `3000`.                                            |

Never commit `.env` — it's already in `.gitignore`.

---

## Deploy (easiest: Render)

Get it always‑on for your phone in a few minutes — no CLI, no Docker. The repo
includes a `render.yaml` blueprint.

1. Go to https://dashboard.render.com and sign in with GitHub.
2. **New → Blueprint**, then connect this repository and pick the branch that
   has the code. Render reads `render.yaml` and sets up the web service.
3. When prompted, paste the three secret values (they're stored in Render, never
   in the repo):
   - `ANTHROPIC_API_KEY`
   - `HOUSECALL_API_KEY`
   - `APP_PASSWORD` (make one up — it's your app login)
4. Click **Apply / Create**. Render builds and gives you an `https://…onrender.com`
   URL. Open it on your phone and **Add to Home Screen**.

Render injects `PORT` automatically and the app listens on it. The free plan
spins down when idle (the first request after a nap takes ~30–60s to wake);
upgrade the instance if you want it always warm. `autoDeploy` is on, so pushing
new commits redeploys automatically.

> Other hosts work the same way — Railway (dashboard, set the same env vars) or
> Fly.io (`fly launch` → `fly secrets set …` → `fly deploy`). The key always
> lives in the host's secrets, never in the repo.

## Using it on your phone

1. Serve it over HTTPS on a host your phone can reach (a small VM, Fly.io,
   Render, a Cloudflare Tunnel to your laptop, etc.). Voice input and PWA
   install both require HTTPS.
2. Open the URL in mobile Safari/Chrome and **Add to Home Screen** — it installs
   like an app.
3. Tap 🎤 to speak, or type. Replies are read back aloud.

Example things to say:

- "What's on the schedule today?"
- "Show me unpaid invoices."
- "Any estimates that haven't been signed yet?"
- "Look up the Hendersons and show their service history."
- "Create a job for the Hendersons next Tuesday at 9am to replace the capacitor." → you'll get a **Confirm** card before anything is created.

---

## Write actions & the confirm step

When the assistant wants to **create or update a job or estimate**, the server
does **not** call Housecall Pro immediately. It pauses and sends the proposed
action to your phone, which shows a card with the exact details and **Confirm /
Cancel** buttons. Nothing changes in your account until you tap **Confirm**. If
you cancel, the assistant is told it was declined and moves on.

---

## Project layout

```
src/
  config.js       env loading + validation (fail fast if keys missing)
  hcpClient.js    Housecall Pro REST wrapper (Authorization: Token <key>)
  tools.js        tool schemas + execution; marks writes as confirm-gated
  assistant.js    Claude tool-use loop with the write-confirmation pause
  server.js       Express: static PWA, /api/chat, /api/confirm, auth gate
public/
  index.html app.js styles.css   mobile chat UI + voice
  manifest.webmanifest sw.js icon.svg   PWA install
```

---

## Notes on the Housecall Pro API

Housecall Pro's list responses and field names can vary by account and API
version. The client normalizes common list shapes (`pickList` in
`src/hcpClient.js`) and the "unpaid" / "unsigned" filters in `src/tools.js` are
best‑effort. If a field name is off for your account, adjust those two files —
everything else reads through them. Endpoints used: `/jobs`, `/customers`,
`/customers/{id}/jobs`, `/invoices`, `/estimates` with `Authorization: Token
<key>`.

## Security

- Keys are server‑side env vars only; the browser never receives them.
- Set `APP_PASSWORD` so only you can reach the write actions.
- All writes require an explicit on‑device confirmation.
- Deploy over HTTPS.
