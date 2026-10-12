# Evenly

A small mobile web app for tracking shared money between households: monthly bills, outings, one-off expenses and the payments that settle them.

> Work in progress. Phase 0 (project setup) is done; the money logic comes next.

## Two modes, one engine

- **Household mode**: people belong to one of two households, and the app shows one balance between them ("Household 2 owes you $214.50").
- **People mode** (planned): every person is their own side, with balances simplified into as few payments as possible.

Both modes use the same engine: money always moves between _parties_, and household mode is simply the two-party case.

## Tech stack

- TypeScript + Vite, no UI framework
- Supabase (Postgres) with all access through RPC functions
- GitHub Pages, deployed by GitHub Actions
- Vitest for the money math, pgTAP for the database

## Run it locally

Requires Node 22.12 or newer.

```sh
npm install
npm run dev          # http://localhost:5173/evenly/
npm run dev -- --host  # also reachable from a phone on the same network
npm run check        # typecheck, lint, format check, tests, build
```

See [DECISIONS.md](DECISIONS.md) for the reasoning behind the design.
