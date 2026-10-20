# Deep Jiwan - Calendar

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

## MCP (let Claude or another AI agent use the calendar)

Each calendar also speaks MCP at `/mcp`. Use the same passwords as the website: the password you send decides your role, so the AI can do exactly what that person can do, no more.

```bash
# Claude Code (one per calendar; the password goes in the header)
claude mcp add --transport http deepjiwan https://deepjiwan.pentagontz.workers.dev/mcp \
  --header "Authorization: Bearer YOUR_PASSWORD"
```

| Role | Tools |
|---|---|
| **Guest** (5) | `whoami`, `list_projects`, `get_project`, `list_events`, `get_event` |
| **Editor** (9) | the above + `create_event`, `update_event`, `move_event`, `delete_event` (only in projects they can edit) |
| **Admin** (18) | everything: + `create_project`, `update_project`, `delete_project`, `list_users`, `get_user`, `create_user`, `update_user`, `reset_user_password`, `delete_user` |

Create / Read / Update / Delete is covered for projects, tasks and people. Deleting a project or a person needs `confirm: true`. `create_user` and `reset_user_password` return the new password once.

This repo's `.mcp.json` already connects the team calendar for Claude Code sessions. It reads the password from the `TECHNICAL_CALENDAR_PASSWORD` environment variable, so no password is stored in git.

### Claude.ai website ("custom connector")

Settings -> Connectors -> Add custom connector -> paste `https://<your-calendar>/mcp` -> Connect. A page from your own calendar opens: type a calendar password and press **Allow access**. The role of that password is the role Claude gets. (To switch role, remove the connector and add it again with another password.)

Under the hood the Worker is a small OAuth 2.1 server (discovery, dynamic client registration, authorization code + PKCE, rotating refresh tokens). Tokens stop working as soon as that person's password is reset, they are removed, or `ADMIN_PASSWORD` changes.

Clients that can send a header (Claude Code, Cursor, the MCP SDKs) can instead use the password directly as shown above.

## Two deployments from the same code

| | Personal | Team |
|---|---|---|
| Config | `wrangler.jsonc` | `wrangler.technical.jsonc` |
| Worker / link | `deepjiwan` | `technical` |
| Database | `vishwakarma-calendar` | `technical-calendar` |
| Deploy | `npm run deploy` | `npm run deploy:technical` |

Each has its own database, admin password and session secret, so nothing is shared. The name shown in the app comes from `BRAND_NAME`, the admin's display name from `ADMIN_NAME`. For a new copy, make a new config file, create a D1 database, deploy, then set its two secrets.

## Run locally

```bash
cp .dev.vars.example .dev.vars   # edit the values
npm run dev                      # http://127.0.0.1:8787
npm test                         # website API + MCP checks, with dev server running (set ADMIN_PASSWORD if you changed it)
```

## Security notes

- Passwords are never stored. The server keeps a keyed hash (HMAC-SHA-256 with `SESSION_SECRET`), so a copy of the database alone can't be used to guess passwords.
- Sessions are random tokens in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie, stored hashed.
- 8 wrong passwords from one IP locks that IP out for 15 minutes.
- Every write is checked on the server against the person's access, not just hidden in the UI.

## Not in this version

Hour-by-hour day/week grid, touch-screen drag and drop (use the task form on phones), email/WhatsApp notifications, recurring tasks, history of who changed what (only the last change is kept).
