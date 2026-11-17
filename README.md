# EVE Wallet Tracker

EVE Online income tracker: ESI wallet sync, sessions (including fleet/multibox grouping), loot valuation, reports and CSV exports.

Runs on **Cloudflare Workers + D1** at https://evewallet.crankyape.space. It was moved here from the DigitalOcean droplet (FastAPI + SQLite + Nginx/systemd); the Python version is still in this repo's git history. Pages, numbers and behaviour are the same as the Python app.

## How it fits together

| Piece | Where |
|---|---|
| Web app (all pages, EVE SSO login, wallet sync, loot pricing) | `src/` — a Cloudflare Worker, plain JavaScript, no build step |
| Database | D1 database `evewallet` (same tables as the old `evewallet.db`), schema in `migrations/` |
| Stylesheet | `public/static/css/app.css`, served directly by Cloudflare |
| Settings | `[vars]` in `wrangler.toml` |
| Secrets | Worker secrets: `EVE_CLIENT_SECRET`, `SECRET_KEY`, `JANICE_API_KEY` |

It uses the same EVE application (client ID and secret) and callback URL as before, so linked characters keep working without logging in again.

Auto Sync works as before: while a page is open with Auto Sync ON, the browser triggers a wallet sync whenever the 60-minute ESI cooldown allows.

## One-time setup

Run these in PowerShell. They need Node.js (`node -v`; if missing: `winget install OpenJS.NodeJS.LTS`, then open a new PowerShell window).

```powershell
cd C:\github
git clone https://github.com/scrowe71/eve-wallet-tracker
cd eve-wallet-tracker
git checkout dev
npx wrangler login
```

1. **Create the database:** `npx wrangler d1 create evewallet`, then put the `database_id` it prints into `wrangler.toml`.
2. **Create the tables:** `npx wrangler d1 migrations apply evewallet --remote`
3. **Load the old data** (made from the droplet's `evewallet.db` with `scripts/sqlite_to_d1.py`; it contains refresh tokens, so it is never committed):
   `npx wrangler d1 execute evewallet --remote --file=C:\github\evewallet\d1-data.sql`
4. **Free up the hostname:** in the Cloudflare dashboard, crankyape.space → DNS, delete the `evewallet` A record that points at the droplet.
5. **Deploy:** `npx wrangler deploy`
6. **Secrets** (read straight from the old `.env`, plus a new random cookie key):
   ```powershell
   $envFile = "C:\github\evewallet\.env"
   function Get-EnvValue($name) { (Select-String -Path $envFile -Pattern "^$name=").Line.Split('=', 2)[1].Trim().Trim('"') }
   Get-EnvValue EVE_CLIENT_SECRET | npx wrangler secret put EVE_CLIENT_SECRET
   Get-EnvValue JANICE_API_KEY | npx wrangler secret put JANICE_API_KEY
   [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 })) | npx wrangler secret put SECRET_KEY
   ```
7. **Automatic deploys:** Workers & Pages → `evewallet` → Settings → Build → connect `scrowe71/eve-wallet-tracker`, production branch `main`. From then on, every push to `main` deploys.

If something goes wrong, re-adding the old A record puts the droplet back in charge.

## Changing the database schema later

Add a new numbered file to `migrations/` (e.g. `0002_add_notes.sql`) and run `npx wrangler d1 migrations apply evewallet --remote`.
