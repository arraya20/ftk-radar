# FTK Radar

Live radar and event map for For The Kingdom.

The project contains:

- `server.js` — Express API, polling workers, SSE event stream, and static serving.
- `move-listener.js` — on-chain movement listener.
- `shared/` — code shared by the server and related tooling.
- `frontend/` — React/Vite radar UI.

## Requirements

- Node.js 20.19+
- npm
- Access to the FTK API and Rise RPC endpoints from the runtime host
- Optional FTK bot data at `/home/ubuntu/ftk-bot/data/items.json` for item name resolution

## Install

```bash
npm install
npm --prefix frontend install
```

For a local environment, copy `.env.example` to `.env` and set `RPC_URL` only if
the on-chain listener is needed. Keep `.env` private; it is ignored by Git.

## Run

Run the API/server:

```bash
npm run server
```

Run server and frontend development mode together:

```bash
npm run dev
```

The frontend development server listens on port `4173`; the API listens on port `4000` by default. Set `PORT` to change the API port.
The API binds to `127.0.0.1` by default; set `HOST=0.0.0.0` only when the
runtime requires direct network access. Set `CORS_ORIGINS` to a comma-separated
list when the frontend is hosted on a different origin.

## Production build

```bash
npm run build
```

The build output is generated in `frontend/dist/` and is intentionally ignored by Git.

Run the JavaScript syntax checks with:

```bash
npm run check
```

## Architecture notes

The browser receives live updates through Server-Sent Events at `/events`. On-chain movement events are handled separately from slower API polling, so the UI should distinguish delivery latency from source freshness. REST polling is not presented as truly real-time.

## Repository hygiene

Do not commit `node_modules`, local environment files, runtime logs, or generated build output. Never place API credentials or private keys in this repository.

## License

Copyright © 2026 Arraya. All rights reserved.

This repository is public for portfolio and viewing purposes only. No
permission is granted to copy, modify, distribute, sublicense, or use this
code or project commercially without written permission.
