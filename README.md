# Vishwakarma Calendar

A small private calendar for assigning and tracking work. One Cloudflare Worker + D1 database, no build step.

## How access works

You open the link and type a password (15+ characters). The password decides what you see. The browser then stays signed in for 30 days.

| Who | Password comes from | Sees | Can change |
|---|---|---|---|
| **Admin** (shown as the `ADMIN_NAME` in `wrangler.jsonc`) | `ADMIN_PASSWORD` secret on the server | everything | everything, plus projects and people |
| **Editor** | created by the admin (random, 20 chars, shown once) | only projects the admin gave them | tasks in projects with **Can edit**; projects with **Can view** are read only; others are hidden completely |
| **Guest** | created by the admin | every project | nothing |

Hidden means hidden on the server: an editor's browser never receives tasks from projects they have no access to.

Each project has a colour **and** a pattern (stripes, dots, checks...) so it still reads for colour-blind viewers.

## Deploy (first time)

```bash
npm install
export CLOUDFLARE_API_TOKEN=...        # "Edit Cloudflare Workers" template + Account > D1 > Edit
npx wrangler deploy                    # creates tables on first request, no migration step
# set the two secrets (it asks you to type them, nothing is stored in git):
npx wrangler secret put ADMIN_PASSWORD   # your own password, 15+ characters
npx wrangler secret put SESSION_SECRET   # long random string, e.g. output of: openssl rand -hex 32
```

The D1 database id is already in `wrangler.jsonc`. Deploying again later is just `npx wrangler deploy`.

Changing `SESSION_SECRET` signs everyone out **and** invalidates every editor/guest password, so only do that on purpose.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # edit the values
npm run dev                      # http://127.0.0.1:8787
npm test                         # API checks, with dev server running (set ADMIN_PASSWORD if you changed it)
```

## Security notes

- Passwords are never stored. The server keeps a keyed hash (HMAC-SHA-256 with `SESSION_SECRET`), so a copy of the database alone can't be used to guess passwords.
- Sessions are random tokens in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, stored hashed.
- 8 wrong passwords from one IP locks that IP out for 15 minutes.
- Every write is checked on the server against the person's access, not just hidden in the UI.

## Not in this version

Hour-by-hour day/week grid, touch-screen drag and drop (use the task form on phones), email/WhatsApp notifications, recurring tasks, history of who changed what (only the last change is kept).
