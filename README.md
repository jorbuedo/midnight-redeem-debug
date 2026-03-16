# Midnight Redeem Debug CLI

Debug tool for investigating discrepancies between the Midnight NIGHT token schedule API and on-chain Cardano data.

**Live report:** [GitHub Pages](https://jorbuedo.github.io/midnight-redeem-debug/)

## Problem

The Midnight TGE schedule endpoint (`/thaws/{address}/schedule`) sometimes reports incorrect statuses:
- Claims that succeeded on-chain are reported as `failed`
- Failed first-thaw claims cause the second-thaw amount to double
- Doubled amounts cause subsequent tx builds to fail

This CLI fetches all NIGHT token redemption transactions from the Cardano blockchain (via Yoroi API), queries the Midnight schedule API for each eligible address, and generates a report comparing on-chain reality vs API-reported status.

## How NIGHT redemption works on-chain

A redeem transaction has exactly 4 outputs (order may vary), identified by their properties:

| Role | How to identify |
|---|---|
| Treasury NIGHT change | Address matches the known treasury script address |
| Eligible address (this thaw's NIGHT) | Base address (`addr1q...`) receiving NIGHT |
| Escrow (remaining thaws' NIGHT) | Script address (`addr1z...`/`addr1w...`, not treasury) receiving NIGHT |
| ADA change to funder | Whatever output is left (no NIGHT) |

Inputs: at least one from the treasury, plus one or more funding UTXOs from the user's wallet.

- **First thaw**: NIGHT comes from the treasury. The escrow address is created to hold the remaining thaws.
- **Subsequent thaws**: NIGHT comes from the escrow address, not the treasury.

The escrow address uses `addr1z` format (script payment credential + staking credential from the eligible address), so the NIGHT appears under the user's staking key on explorers.

## Setup

```bash
bun install

# Import the database from the SQL dump
bun db:import
```

## Usage

```bash
# Run the full pipeline (recommended)
bun start sync

# Check sync progress at any time
bun start status
```

The `sync` command runs all steps concurrently where possible: treasury tx fetching and schedule fetching run in parallel (schedules are rate-limited, so this saves significant time), then escrow history is fetched, and finally the report is generated.

Individual steps can also be run separately:

```bash
bun start fetch-txs
bun start fetch-escrows
bun start fetch-schedules
bun start report
```

## Options

```
--db <path>        SQLite database path (default: ./midnight-debug.db)
--rate-limit <ms>  Delay between schedule API calls (default: 750)
--output <path>    Report output path (default: ./midnight-debug-report.md)
--format <fmt>     Report format: both, markdown, or html (default: both)
```

## Database management

The SQLite database is gitignored. Instead, a gzipped SQL dump (`midnight-debug.sql.gz`) is committed for portability.

```bash
# Recreate .db from the SQL dump
bun db:import

# Export .db back to SQL dump (after syncing new data)
bun db:export
```

## Discrepancy detection

The report flags these discrepancy types:

- **suspicious-status**: Thaw has a status other than `upcoming`, `redeemable`, or `confirmed` (e.g. `failed`, `submitted`, `skipped`, `confirming`)
- **redeemable-but-onchain**: Schedule says `redeemable` with no `transaction_id`, but the exact NIGHT amount was already delivered on-chain (server didn't record the claim)
- **confirmed-no-onchain**: Schedule says `confirmed` with a `transaction_id`, but that tx doesn't exist in treasury or escrow history
- **failed-but-onchain**: Schedule says `failed`/`skipped`, but the `transaction_id` IS found on-chain
- **doubled-amount**: A thaw's amount is >150% of the expected per-thaw amount (computed from the first redeem tx's total NIGHT allocation, not from the schedule which may already be inflated)

## Data flow

```
Treasury (Yoroi API)          Escrow addresses (Yoroi API)     Schedule (Midnight API)
        │                              │                              │
   fetch-txs                     fetch-escrows                 fetch-schedules
        │                              │                              │
        ▼                              ▼                              ▼
┌─────────────┐              ┌──────────────┐              ┌──────────────┐
│ transactions│              │  escrow_txs  │              │ thaw_schedule│
│ night_outputs│             │              │              │              │
│ eligible_addr│◄────────────│escrow_addresses│            │              │
└─────────────┘              └──────────────┘              └──────────────┘
        │                              │                          │
        └──────────────┬───────────────┘                          │
                       │                                          │
                  on-chain txs ◄──── cross-reference ────► schedule txIds
                       │
                    report
                       │
                       ▼
              HTML discrepancy report
```

## SQLite schema

- **transactions** — All fetched txs (treasury + escrow)
- **night_outputs** — NIGHT token outputs from redeem txs
- **redeem_txs** — Detailed redeem tx analysis (funding address, token cleanliness, NIGHT amounts per output, input count)
- **eligible_addresses** — Addresses that received NIGHT, with schedule fetch status and `numberOfClaimedAllocations`
- **escrow_addresses** — Escrow→eligible address mapping from redeem tx structure
- **escrow_txs** — Tx history for each escrow address (subsequent thaw redemptions)
- **thaw_schedule** — Per-thaw schedule data from the Midnight API (amount, status, transaction_id, queue_position)
- **sync_state** — Pagination cursors for resumable fetching
