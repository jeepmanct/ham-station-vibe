# Ham Radio Station Site

A self-hosted personal website for an amateur radio station: QSO log (synced
from LoTW/QRZ.com/eQSL.cc), awards tracking (DXCC/WAS/WAC/VUCC/WAZ/WPX and
more), live band conditions, a photo gallery, remote radio status, satellite
tracking, and a set of ham/electronics reference tools — all served from a
single Raspberry Pi (or any Linux box).

Nothing here is a paid SaaS product. The log database, photos, and code all
live on one machine you control.

## Quick start

```sh
git clone <this-repo-url>
cd <repo-directory>
./setup.sh
```

The script installs [Bun](https://bun.sh), installs dependencies, walks you
through the admin password and storage location, builds the frontend, and
optionally sets up systemd services and [Caddy](https://caddyserver.com) (for
HTTPS + reverse proxy). It's safe to re-run.

Once it's running, log into `/admin` and set your **callsign** first — most
features (page branding, POTA/PSK Reporter/WSPR/RBN lookups, QSL cards, ADIF
export) need it. Station location, and service credentials (QRZ, eQSL, LoTW,
HamQTH, FlexRadio) are all configured from the same page, whenever you're
ready for each.

## Requirements

- Linux with `systemd` (Debian, Raspberry Pi OS, Ubuntu, etc.) — other setups
  work too, `setup.sh` just skips the service-install step and tells you how
  to run things manually.
- [Bun](https://bun.sh) (the installer will offer to install it for you).
- A domain name if you want automatic HTTPS via Caddy; not required for a
  local-network-only install.

## Layout

- `web/` — [Astro](https://astro.build) static frontend. Every page is
  pre-rendered HTML/CSS/JS with no client-side framework runtime; dynamic
  data (log entries, live conditions, station branding) is fetched from the
  API after load.
- `api/` — [Hono](https://hono.dev) API on [Bun](https://bun.sh): ADIF
  import/sync, session-based admin auth, live radio status, alerts. Data
  lives in SQLite (one file, `<DATA_DIR>/hamstation.sqlite`) plus uploaded
  photos under `<DATA_DIR>/photos/`.
- `deploy/` — systemd unit templates (API service + one timer per background
  sync/alert job) and a Caddyfile, both filled in by `setup.sh`.
- `setup.sh` — the guided installer described above.

## Manual / local development

If you'd rather not run the installer (e.g. for local development):

```sh
# API (http://localhost:3000)
cd api
bun install
bun scripts/set-password.ts "your-admin-password"   # first time only
bun run dev

# Frontend (http://localhost:4321), in another shell
cd web
bun install
bun run dev
```

The frontend calls `/api/...` as relative paths, so in production both are
served from the same origin (see `deploy/Caddyfile`); in local dev, proxy or
run them behind the same host if you want the pages to talk to the API.

See `api/.env.example` for the environment variables the API reads.

## Features

- **QSO Log** — full searchable/filterable contact log; log a QSO by hand
  (with country/continent/CQ-zone auto-fill and an optional push to your QRZ
  logbook); incremental sync from LoTW, QRZ.com, and eQSL.cc; downloadable
  canvas-rendered virtual QSL cards; ADIF/CSV export.
- **QSO Map** — every contact as a great-circle line on a world map, with a
  day/night grayline overlay, filterable by band/mode/country/state.
- **Awards** — DXCC, WAS, WAC, VUCC, WAZ, CQ WPX, Triple Play WAS, USA
  Counties, and IOTA, computed live from the log — plus a Most-Wanted DXCC
  checklist ranked by Club Log's real demand data.
- **Stats** — QSOs per year/band/mode, an activity heatmap with streaks,
  hour-of-day/day-of-week patterns, a distance leaderboard, and solar-cycle
  history.
- **Conditions** — solar flux/A-index/K-index, sunrise/sunset for your QTH,
  a live DX spot feed with entity-precise "needed" flags, real-time
  reception reports via PSK Reporter, an announced-DXpedition calendar, and
  an upcoming-contest calendar.
- **Radio** — live status from a FlexRadio (if you have one): slice
  frequency/mode, SWR, power, temperature; a receive-only remote-control
  slice with live audio streaming; reception reports via PSK Reporter, WSPR,
  and the Reverse Beacon Network; DMR Last Heard via BrandMeister.
- **Satellites** — live position tracking and AOS/LOS pass predictions for
  active amateur satellites, via real SGP4 propagation.
- **Activations** — POTA activator/hunter activity.
- **Tools** — grid square converter, distance/bearing, antenna/RF
  calculators, a callsign lookup (via HamQTH), a Club Log OQRS checklist,
  and more.
- **Electronics** — general-purpose bench calculators (resistor codes, Ohm's
  Law, LED resistor, voltage divider, etc.), not ham-specific.
- **Reference** — Morse code trainer, US band plan chart, Q-codes/prosigns.
- **Admin** — everything above is configured from one page: callsign and
  station location, service credentials, alert channels (email and/or
  [ntfy.sh](https://ntfy.sh) push) for needed-DX spots, VHF/Sporadic-E
  openings, solar flares, solar wind, geomagnetic storms, and tropospheric
  ducting — each independently testable.

Background jobs (LoTW/QRZ/eQSL sync, solar data, satellite TLEs, Club Log
lists, and every alert check) run on their own systemd timers once installed
— nothing needs a human to remember to click "sync."

## License

[AGPL-3.0](LICENSE). Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
