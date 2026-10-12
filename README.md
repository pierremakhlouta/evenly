# Evenly

A small mobile web app for tracking shared money between households: monthly bills, outings, one-off expenses and the payments that settle them.

[![CI](https://github.com/pierremakhlouta/evenly/actions/workflows/ci.yml/badge.svg)](https://github.com/pierremakhlouta/evenly/actions/workflows/ci.yml)

> Work in progress. The money logic and the deploy pipeline are done; the database comes next.
> Live (placeholder for now): https://pierremakhlouta.github.io/evenly/

## Two modes, one engine

- **Household mode**: people belong to one of two households, and the app shows one balance between them ("Household 2 owes you $214.50").
- **People mode** (planned): every person is their own side, with balances simplified into as few payments as possible.

Both modes use the same engine: money always moves between _parties_, and household mode is simply the two-party case.

## Tech stack

- TypeScript + Vite, no UI framework
- Supabase (Postgres) with all access through RPC functions
- GitHub Pages, deployed by GitHub Actions
- Vitest for the money math, pgTAP for the database

## Money rules

- All money is integer cents. No floating point anywhere, including display and parsing of typed amounts.
- Every entry stores one share row per party, and the shares always add up exactly to the total.
- A party's net position is what it paid minus its shares. Nets always sum to zero.
- Household splits (1/3, 1/2, all, fraction, percent, $ amount) round the other household's share half up; the payer gets the remainder.
- People-mode splits (equal, amounts, percent, weights) use largest-remainder allocation with ties broken by sort order.
- Debts between N people settle in at most N - 1 payments.

The same cases in [`shared/test-vectors.json`](shared/test-vectors.json) test the TypeScript code now and the SQL functions later, so both must agree to the cent.

## Run it locally

Requires Node 22.12 or newer.

```sh
npm install
npm run dev          # http://localhost:5173/evenly/
npm run dev -- --host  # also reachable from a phone on the same network
npm run check        # typecheck, lint, format check, tests, build
```

## Deploys

Every push and pull request runs CI (typecheck, lint, format check, unit tests, build). When CI passes on `main`, a second workflow builds that exact commit and deploys it to GitHub Pages. A failing check never reaches the live site.

See [DECISIONS.md](DECISIONS.md) for the reasoning behind the design.
