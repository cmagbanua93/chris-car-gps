# Fleet Dashboard

One dashboard for cars tracked on GPS-Server.net based sites (Expedite GPS Tracker, Vectras WTrackLite).
It signs in with your existing accounts, reads the same data their map shows, and never changes anything there.

## What it does
- Live map of every car, coloured by status (moving / idle / stopped / offline), with speed, ignition, car battery and last update.
- Today's distance and driving time per car.
- History for any car and day: route, numbered stops, summary, and replay.
- Alerts: offline, speeding, night use, power cut (tracker unplugged), arriving at / leaving your zones. Optional Telegram messages.
- Keeps its own copy of positions (SQLite), so history is still there if a provider can't answer.
- Polite: each site is read every 30 s by default (never faster than 20 s); failed sign-ins back off up to 1 hour.

## Try it locally
Needs Node 22.13 or newer, no packages to install.

    npm start          # with no SOURCE_ variables it runs on demo data
    open http://localhost:3000

## Deploy on Railway
1. New project, then deploy this folder (GitHub repo or `railway up`).
2. Add a Volume to the service, mounted at `/data`.
3. In Variables, set everything from `.env.example` (passwords go here only).
4. Settings > Networking > Generate Domain. Open it and sign in with any username and `DASHBOARD_PASSWORD`.

Health check path: `/healthz`.

## Adding the third car
If it's another GPS-Server.net site, add `SOURCE_3_*` variables. Any other system needs a small adapter in `lib/` with the same `live()` and `history()` methods.
