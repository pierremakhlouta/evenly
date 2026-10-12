# Evenly

A small mobile web app for tracking shared money between households: monthly bills, outings, one-off expenses and the payments that settle them.

[![CI](https://github.com/pierremakhlouta/evenly/actions/workflows/ci.yml/badge.svg)](https://github.com/pierremakhlouta/evenly/actions/workflows/ci.yml)

> In use by its first two households. Editing, monthly bills and the home-screen app are next.
> Live: https://pierremakhlouta.github.io/evenly/ (a group code and PIN are needed to join)

## Two modes, one engine

- **Household mode**: people belong to one of two households, and the app shows one balance between them ("Household 2 owes you $214.50").
- **People mode** (planned): every person is their own side, with balances simplified into as few payments as possible.

Both modes use the same engine: money always moves between _parties_, and household mode is simply the two-party case.

## What it does

- **Join once per phone** with a group code and PIN, then pick your name and enter your personal PIN, so nobody can add entries as someone else. The first person in a group is its admin and adds everyone else.
- **Home** shows one balance phrased from your side ("Basement suite owes you $214.50") and everything added since the last settle-up, each entry saying what it did to your balance.
- **Add expense**: who paid, and the other side's share (1/3, 1/2, all, a $ amount, a fraction or a percentage), with a live "They owe you $35.00" preview.
- **Record payment**: partial payments, or **Settle full balance**, which zeroes the balance and starts a new period.
- **History**: settle-up periods, newest first, each one opening to its entries.
- Phones stay in sync by refreshing on focus, every 30 seconds and after every change. There's an offline banner, and light and dark themes follow the phone.

## Tech stack

- TypeScript + Vite, no UI framework (the whole app is about 10 KB gzipped)
- Supabase (Postgres) with all access through RPC functions, called with a small typed `fetch` client
- GitHub Pages, deployed by GitHub Actions
- Vitest for the money math, pgTAP for the database

## Money rules

- All money is integer cents. No floating point anywhere, including display and parsing of typed amounts.
- Every entry stores one share row per party, and the shares always add up exactly to the total.
- A party's net position is what it paid minus its shares. Nets always sum to zero.
- Household splits (1/3, 1/2, all, fraction, percent, $ amount) round the other household's share half up; the payer gets the remainder.
- People-mode splits (equal, amounts, percent, weights) use largest-remainder allocation with ties broken by sort order.
- Debts between N people settle in at most N - 1 payments.

The same cases in [`shared/test-vectors.json`](shared/test-vectors.json) test both the TypeScript code (Vitest) and the SQL functions (pgTAP), so they must agree to the cent. The database is the source of truth: it computes and stores the shares, and the TypeScript copy only powers the live preview in forms.

## Security model

There are no user accounts. Each group has a shared PIN, entered once per phone.

```
Phone                         Supabase (Postgres)
-----                         -------------------
register_device(code, PIN) -> bcrypt check, lockout after 10 failures in 15 min
                           <- random 32-byte token (only its sha256 is stored)
get_summary(token)         -> require_device(token) -> caller's group only
add_entry(token, ...)      -> validate, compute shares, log the change
```

- The browser only has the project URL and the publishable key. Every table has row level security on with **no policies**, and all table privileges are revoked from the API roles, so the key can read nothing directly.
- The only way in is a fixed list of `security definer` RPC functions with an empty `search_path`. A test fails CI if anything else becomes callable.
- Every RPC resolves the caller's group from the device token, and composite `(group_id, id)` foreign keys make cross-group references impossible at the database level.
- Secrets (PIN hashes, device token hashes, PIN attempts) live in a `private` schema that the API cannot reach.
- Deletes are soft and every create, edit, delete and restore is written to an append-only change log.

## Database

- Schema changes are SQL migrations in [`supabase/migrations`](supabase/migrations), applied with the Supabase CLI.
- pgTAP tests in [`supabase/tests`](supabase/tests) cover the lockdown, group isolation, PIN lockout, revoked devices, split and balance math against the shared vectors, and every RPC.
- [`supabase/seed.sql`](supabase/seed.sql) creates two fake groups (household mode and people mode) for local development and screenshots.

## Run it locally

Requires Node 22.12 or newer.

```sh
npm install
npm run dev          # http://localhost:5173/evenly/
npm run dev -- --host  # also reachable from a phone on the same network
npm run check        # typecheck, lint, format check, tests, build
```

The database runs locally with the Supabase CLI and Docker:

```sh
supabase start       # local Postgres and API
supabase db reset    # apply migrations and the fake seed
supabase test db     # pgTAP tests
```

The seed's local-only logins are `HHHH-2222` (household mode) and `PPPP-3333` (people mode), both with PIN `1234`.

## Deploys

Every push and pull request runs CI: typecheck, lint, format check, unit tests and build in one job, and the pgTAP database tests against a fresh Postgres in another. When CI passes on `main`, a second workflow builds that exact commit and deploys it to GitHub Pages. A failing check never reaches the live site.

See [DECISIONS.md](DECISIONS.md) for the reasoning behind the design.
