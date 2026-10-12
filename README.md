# VORTEX BOT

A Node.js Messenger bot scaffold with a protected Express dashboard, command modules, AppState validation, structured logs, and Railway deployment files. Developer branding: **Zero To**.

> **Important:** Messenger automation depends on Meta/Messenger behavior and the exact installed `@dongdev/fca-unofficial` API. This project does not bypass platform restrictions. Real login has not been verified without a valid user-provided AppState and an available network connection.

## Requirements
- Node.js 22.x (the package engine permits Node 20–22)
- npm 10+
- A valid AppState supplied by the account owner

## Local setup
1. Run `npm install` and `npm start`. The default Dashboard password is `vortex110`; change it before exposing the Dashboard publicly. A random `SESSION_SECRET` is generated and saved automatically when it is not supplied.
2. Set optional `ADMIN_IDS` to comma-separated numeric IDs. Never commit `.env` or AppState.
3. Run `npm install` and `npm start`.
2. Open `http://localhost:3000/login`.
3. Submit AppState in the protected Dashboard section. The session is saved in `data/appstate.json`; do not commit this file or share its contents.

## Optional environment variables
| Variable | Purpose |
|---|---|
| `DASHBOARD_PASSWORD` | Overrides the default Dashboard password `vortex110` |
| `SESSION_SECRET` | Optional session-signing secret; generated and stored locally when omitted |
| `APPSTATE_JSON` | Optional AppState JSON array; the Dashboard is recommended |
| `ADMIN_IDS` | Comma-separated numeric Messenger IDs |
| `BOT_NAME` | Display name; defaults to VORTEX |
| `PREFIX` | Command prefix; defaults to `*` |
| `PORT` | Web port; Railway injects this |
| `NODE_ENV` | Use `production` behind HTTPS |

Runtime data is stored in the project's `data/` directory. For persistence on Railway, attach a Volume at the app's `/app/data` directory. No environment variable is needed to set file paths.

## Commands
Commands live in `cmds/` and export `name`, `aliases`, `description`, `execute(api, event)` and optionally `adminOnly`. Prefix examples: `⚜︎ping`, `⚜︎help`, `⚜︎info`, `⚜︎uid`, `⚜︎admin`, `⚜︎kick`, `⚜︎prefix`, `⚜︎reload`.

`kick` is intentionally capability-checked: it only calls `removeUserFromGroup` if the installed client exposes it. It does not pretend success if the method is absent. The exact `@dongdev/fca-unofficial` callback/client surface may vary by release; verify against the installed package before relying on real sessions.

## Railway
1. Create a new Railway project from this repository.
2. The Dashboard defaults to password `vortex110`; set `DASHBOARD_PASSWORD` in Railway Variables to override it before public use. `SESSION_SECRET` is generated automatically if omitted.
3. Attach a Railway Volume at `/app/data` so saved AppState, settings, and the generated session secret persist between deployments.
4. Deploy with `npm start`. `railway.json` configures `GET /health` as healthcheck.
5. Use Railway's HTTPS domain; `NODE_ENV=production` enables secure session cookies.

## Security notes
- Dashboard login is session-based, with HttpOnly/SameSite cookies, login rate limiting, and CSRF token checks on mutating API calls.
- AppState is validated before storage and never returned by an API or written to logs. Local data should be kept on a private volume with restricted permissions.
- Dashboard command editing runs JavaScript with the bot process's privileges. Only use it with trusted administrators.
- Express's default in-memory session store is suitable for a single-process starter, not a multi-instance production deployment. Use a persistent external session store for horizontal scaling.
- Use Messenger normally, respect rate limits and account restrictions, and stop if the platform rejects access.

## Tests
Run `npm test` for Node's built-in test runner. `npm run check` runs syntax checks on project JavaScript files. Tests use mocks and do not prove real Messenger login works. Real login needs a valid AppState and a live supported FCA package/network.
