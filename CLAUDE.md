# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Start dev: Vite (:3000) + data proxy (:3001), auto-proxied
npm run build    # TypeScript check + Vite production build → dist/
npm start        # Production: single Node process serves API + static files on :3000
npm run lint     # ESLint on all TS/TSX files
npm run preview  # Vite preview of dist/
```

## Architecture

**Frontend**: React 19 + Vite 7 + TypeScript + Tailwind CSS (shadcn/ui theme). Charts are hand-written SVG (no charting library). Path alias `@/` maps to `src/`.

**Backend**: `server/index.cjs` — a zero-dependency Node.js native HTTP server that aggregates public Chinese market-data endpoints (Tencent, Sina, Eastmoney, Wallstreetcn, CNBC, Binance, Sunsirs, etc.). No framework, no database. Uses in-memory TTL caches (1.5s–24h per endpoint), LRU eviction, and periodic sweeps. Some endpoints fall back from Node `fetch` to `curl` for TLS-fingerprint-sensitive upstreams. Production serves both API and built frontend from a single port.

**Routes** (React Router, `src/App.tsx`):
- `/` — Market cockpit (indices, sectors, money flow, news, industry chains, watchlist)
- `/ai` — AI cockpit (OpenRouter provider token consumption trends)
- `/goods` — Commodity prices (futures trends + spot/basis tables)
- `/fin` — Earnings window (disclosure calendar, forecasts, industry/stock profit rankings, company trends)

### Key patterns

**Unified quote hub** (`src/lib/market.ts`): All panel prices/changes come from a single client-side `MarketHub`. Components subscribe via `useQuote(code)` / `useQuotes(codes)`, which use reference-counting and a single 5s polling loop. The same ticker renders the same frame everywhere — no per-panel duplicate fetches.

**Panel layout** (`src/components/dash/DashboardLayout.tsx`): The cockpit is a grid of resizable `Panel` components arranged in rows. `DashboardLayout` reads `PanelRowDef[]` (row height ratios + per-panel width ratios) and renders panels wrapped in `React.memo` so zooming one panel doesn't re-render siblings. Panel zoom state is managed by `usePanelZoom` hook.

**Data hooks** — two polling patterns:
- `usePolling(fn, interval)` (`src/hooks/usePolling.ts`) — per-component polling, pauses when tab hidden, guards against in-flight overlap
- `useSharedPolling(key, fn, interval)` (`src/hooks/useSharedPolling.ts`) — same-key components share one timer and data snapshot via `useSyncExternalStore`; last subscriber unsubscribing stops the loop

**API client** (`src/lib/api.ts`): Typed fetch wrappers. Server-first with browser-direct fallback for Tencent-sourced endpoints (quotes, minute data, boards) and Wallstreetcn news — so the app partially works without the proxy. The `api` object also includes a batched `stockFlow` loader that merges concurrent calls within a 60ms window.

**TV mode** (`src/lib/tv.ts`, `src/lib/tvFocus.ts`): Enabled via `?tv=1` or Android TV UA detection. Activates D-pad spatial navigation (scored by edge distance + axis overlap), fullscreen panel zoom overlays (CSS zoom, zero reflow), and performance adaptations (reduced polling, trimmed lists, disabled blurs/animations). All TV behavior is gated behind `isTv` checks — zero desktop impact.

**Static config** (`src/config/dashboard.ts`): Index definitions, commodity codes, and 8 industry-chain templates (LLM, embodied AI, semiconductors, new energy, innovative drugs, new industrialization, digital government, smart medicine) — each with upstream/midstream/downstream stock lists and search keywords.

**FinDashboard context** (`src/components/dash/fin/FinContext.ts`): React context (`FinProvider`) shares selected company + recent company list (localStorage-persisted) and reporting period across earnings panels. `.ts` file uses `createElement` instead of JSX.

## Server data files

- `server/.env` — optional `OPENROUTER_API_KEY` for the AI cockpit panel
- `server/data/spot-history.json` — accumulated daily Sunsirs spot prices (appended every 4h)
- `server/treasury-rates/` — monthly US Treasury yield CSVs (2001–present); updated via `scripts/update-treasury-archive.cjs`

## Docker

Multi-stage build: `node:20-alpine` build stage → production stage with only `dist/`, `server/`, and production `node_modules`. Requires `curl` at runtime (used by some proxy endpoints).
