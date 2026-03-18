# Escrow Redeem Research: Crafting Second+ Thaw Transactions

## Background

A user redeemed thaw #1 via our retry mechanism after the Midnight backend failed.
The successful tx exists on-chain but the backend still shows `failed` with a wrong tx hash.

- **Eligible address**: `addr1qy0rpmsd9wz0x85esg03uhjscc6v0akwydpxy28cpwtpnzskgwn49c4sg0s6sj783fe3t0alqfsn3rkewv7wsghharuq32lx5c`
- **Real first-thaw tx**: [`c62490e56a1d0fa915db2bfa328e0624167a15a55193ae6d4efb99b3a345a1c3`](https://cexplorer.io/tx/c62490e56a1d0fa915db2bfa328e0624167a15a55193ae6d4efb99b3a345a1c3) (block 13,001,236, 2026-02-05)
- **Escrow address**: `addr1z9vcd07vpjluvr0v3hu8w9wvjhgrs9a2cwrtp6wn8ksrkwgkgwn49c4sg0s6sj783fe3t0alqfsn3rkewv7wsghharuq8fq6ev`
- **Midnight API status**: `failed` with wrong tx_id `1d30f72e560ec1fba42abbec1d2593b2df57102109a7b7415d00bbea851a7147` (does not exist on-chain)
- **Schedule**: <https://mainnet.prod.gd.midnighttge.io/thaws/addr1qy0rpmsd9wz0x85esg03uhjscc6v0akwydpxy28cpwtpnzskgwn49c4sg0s6sj783fe3t0alqfsn3rkewv7wsghharuq32lx5c/schedule>

## Two distinct script paths for NIGHT redemption

### First thaw: treasury script spend

The first thaw for any address is always a **treasury script spend**. The treasury holds the master NIGHT supply across multiple UTxOs, each managing a Merkle tree of allocations.

**Inputs:**
- Treasury UTxO (holds bulk NIGHT + inline datum with Merkle root and bitmap)
- User wallet UTxO (ADA for fees)

**Outputs:**
- Treasury change (updated bitmap marking this allocation as claimed)
- Eligible address (one thaw worth of NIGHT)
- Escrow address (remaining thaws' NIGHT, with inline datum)
- Funder ADA change

**Redeemer:** `Constr(1, [Constr(0, [leaf_index, total_allocation, merkle_proof_siblings, bitmap_position])])` — a Merkle proof of allocation membership.

**Treasury datum:**
```
Constr(0, [
  merkle_root: ByteString(32),      -- root of allocation Merkle tree
  start_time: Integer,               -- epoch start (ms since unix epoch)
  interval: Integer,                  -- thaw interval (ms)
  Constr(1, [bitmap: ByteString])    -- 128-byte bitmap tracking claimed slots
])
```

### Second+ thaw: escrow script spend

Subsequent thaws spend the **escrow UTxO** created by the first thaw. This is a completely separate script interaction — no Merkle proof needed.

**Key finding: the escrow address is NEVER spent in first-thaw txs.** It only appears as an output. The escrow UTxO is first spent when claiming thaw #2.

**Inputs:**
- Escrow UTxO (NIGHT for remaining thaws + inline datum)
- User wallet UTxO (ADA for fees)

**Outputs:**
- Eligible address (one thaw worth of NIGHT + min ADA)
- Escrow address (remaining NIGHT + updated datum), omitted if last thaw
- Funder ADA change

**Redeemer:** `Constr(0, [])` — **empty!** (CBOR: `d87980`)

The escrow script validates entirely from the inline datum, no external proof is needed.

## Escrow datum format

```
Constr(0, [
  address: Constr(0, [                          -- eligible address
    payment_cred: Constr(0, [ByteString(28)]),   -- PubKeyHash
    staking_cred: Constr(0, [                    -- Just(StakingHash)
      Constr(0, [
        Constr(0, [ByteString(28)])              -- PubKeyHash
      ])
    ])                                           -- or Constr(1, []) for Nothing
  ]),
  night_per_thaw: Integer,                       -- NIGHT lovelace per thaw
  next_thaw_time: Integer,                       -- ms since unix epoch
  thaws_remaining: Integer,                      -- decrements each claim
  interval: Integer                              -- ms between thaws (7776000000 = 90 days)
])
```

For addresses with no staking credential (`addr1v...`), the staking part is `Constr(1, [])` (Nothing) instead of the nested Just/Constr(0) structure.

## Escrow script

- **Script hash (payment credential):** `5986bfcc0cbfc60dec8df87715cc95d03817aac386b0e9d33da03b39`
- **Script type:** PlutusV3
- **Script size:** ~6,278 bytes
- **Reference script UTxO:** `da17a0e51e8374fafa9977c5bddf4bc35af2eb53bda52dfc8b38c451e7e150f1#0`

The script is NOT embedded in escrow UTxOs or provided in the witness set. It is supplied via **reference input** (read-only input pointing to the UTxO that holds the script).

Note: different transactions may use different reference script UTxOs (e.g., `80a146507156745632e5e4b7ae72944fd67a9cc57cb850e826c30151e825be56#0` was seen in another tx). Both contain the same PlutusV3 script. Any UTxO holding a reference script with hash `5986bfcc...` will work.

## Escrow script validation (inferred from on-chain behavior)

The script appears to check:
1. **Time gate:** `tx.invalid_before >= datum.next_thaw_time` (the tx validity interval proves the current time is past the thaw date)
2. **Correct recipient:** NIGHT is sent to the address encoded in the datum
3. **Correct amount:** eligible receives exactly `escrow_night_in / datum.thaws_remaining`
4. **Correct escrow change:** remaining NIGHT goes back to the same escrow address
5. **Updated datum:** the escrow change output has `thaws_remaining - 1` and `next_thaw_time + interval`

## Thaw date enforcement

**Thaw dates ARE enforced by the script.** Each thaw can only be claimed after its date.

Evidence:
- The confirmed second thaw tx [`2db0b74912c7e123...`](https://cexplorer.io/tx/2db0b74912c7e123c9b484c9f8da9270d86cb79a069ea8f117573653789aa18f) was submitted on 2026-03-10 02:51 UTC, immediately after thaw #2 became available (2026-03-10 00:00 UTC).
- Its `invalid_before` slot maps to 2026-03-10 02:49:52 UTC — just past the `next_thaw_time` of 2026-03-10 00:00:00 UTC from the escrow datum.
- No thaw #3 has been claimed on-chain because the earliest thaw #3 date (2026-06-08) is still in the future.
- Chaining multiple thaw redeems in one tx is impossible: each tx creates a new escrow UTxO whose datum gates the next spend to a future date.

## Transaction specification for our user's thaw #2

### Escrow UTxO to spend

| Field | Value |
|---|---|
| UTxO | `c62490e56a1d0fa915db2bfa328e0624167a15a55193ae6d4efb99b3a345a1c3#2` |
| Address | `addr1z9vcd07vpjluvr0v3hu8w9wvjhgrs9a2cwrtp6wn8ksrkwgkgwn49c4sg0s6sj783fe3t0alqfsn3rkewv7wsghharuq8fq6ev` |
| NIGHT | 119,074,057,221 (119,074.057221 NIGHT) |
| ADA | ~1,698,140 lovelace |

### Current escrow datum

| Field | Value |
|---|---|
| Payment cred | `1e30ee0d2b84f31e99821f1e5e50c634c7f6ce23426228f80b96198a` |
| Staking cred | `1643a752e2b043e1a84bc78a7315bfbf0261388ed9733ce822f7e8f8` |
| NIGHT per thaw | 39,691,352,407 (39,691.352407 NIGHT) |
| Next thaw time | 1,773,100,800,000 ms (2026-03-10 00:00:00 UTC) |
| Thaws remaining | 3 |
| Interval | 7,776,000,000 ms (90 days) |

### Transaction structure

**Reference input (read-only, provides escrow PlutusV3 script):**
`da17a0e51e8374fafa9977c5bddf4bc35af2eb53bda52dfc8b38c451e7e150f1#0`

**Inputs:**
1. Escrow UTxO: `c62490e5...#2` (119,074,057,221 NIGHT + ~1.7 ADA)
2. Funding UTxO from any wallet (ADA for fees + collateral)

**Outputs:**
1. **Eligible address** — `addr1qy0rpmsd9wz0x85esg03uhjscc6v0akwydpxy28cpwtpnzskgwn49c4sg0s6sj783fe3t0alqfsn3rkewv7wsghharuq32lx5c`
   - 39,691,352,407 NIGHT + min ADA (~1,176,630 lovelace)
2. **Escrow change** — same escrow address
   - 79,382,704,814 NIGHT + ~1,698,140 lovelace
   - Inline datum (updated):
     - Address: same
     - NIGHT per thaw: 39,691,352,407 (unchanged)
     - Next thaw time: **1,780,876,800,000 ms (2026-06-08 00:00:00 UTC)**
     - Thaws remaining: **2**
     - Interval: 7,776,000,000 ms (unchanged)
3. **Funder ADA change**

**Redeemer:** `Constr(0, [])` → CBOR hex `d87980`

**Validity interval:**
- `invalid_before`: any slot after 2026-03-10 00:00:00 UTC (slot ~186,459,309). We're past this.
- Shelley slot formula: `slot = unix_seconds - 1591566291 + 4924800`

**Collateral:** ~5 ADA from funder wallet

**Execution budget** (estimated from similar tx):
- Memory: ~870,000 units
- Steps: ~213,000,000 units

### Updated escrow datum CBOR

```
d8799f                                          -- Constr(0, [
  d8799f                                        --   Constr(0, [  (address)
    d8799f                                      --     Constr(0, [  (payment cred)
      581c 1e30ee0d2b84f31e99821f1e5e50c634     --       ByteString(28)
           c7f6ce23426228f80b96198a
    ff                                          --     ])
    d8799f                                      --     Constr(0, [  (Just staking)
      d8799f                                    --       Constr(0, [
        d8799f                                  --         Constr(0, [
          581c 1643a752e2b043e1a84bc78a7315     --           ByteString(28)
               bfbf0261388ed9733ce822f7e8f8
        ff                                      --         ])
      ff                                        --       ])
    ff                                          --     ])
  ff                                            --   ])
  1b 000000093dc9f957                           --   39691352407 (NIGHT per thaw)
  1b 0000019ea4877000                           --   1780876800000 (2026-06-08 00:00 UTC)
  02                                            --   2 (thaws remaining)
  1b 00000001cf7c5800                           --   7776000000 (90 days interval)
ff                                              -- ])
```

Full hex: `d8799fd8799fd8799f581c1e30ee0d2b84f31e99821f1e5e50c634c7f6ce23426228f80b96198affd8799fd8799fd8799f581c1643a752e2b043e1a84bc78a7315bfbf0261388ed9733ce822f7e8f8ffffffff1b000000093dc9f9571b0000019ea487700002  1b00000001cf7c5800ff`

## Remaining thaw schedule

| Thaw | NIGHT | Available | Status |
|---|---|---|---|
| #1 | 39,691.352407 | 2025-12-10 | Claimed (tx `c62490e5...`) |
| #2 | 39,691.352407 | 2026-03-10 | **Claimable now** |
| #3 | 39,691.352407 | 2026-06-08 | Locked (future date) |
| #4 | 39,691.352407 | 2026-09-06 | Locked (future date) |

## Verified reference transactions

| Description | Tx Hash | Block |
|---|---|---|
| Our user's first thaw (treasury spend) | `c62490e56a1d0fa915db2bfa328e0624167a15a55193ae6d4efb99b3a345a1c3` | 13,001,236 |
| Confirmed second thaw (escrow spend, different address) | `2db0b74912c7e123c9b484c9f8da9270d86cb79a069ea8f117573653789aa18f` | 13,139,266 |
| First thaw for the above address (for comparison) | `4779cea08f234f22c29a2735f071cc72e76746caf8a48c0c525652752ad12723` | — |
| Reference script UTxO (PlutusV3 escrow script) | `da17a0e51e8374fafa9977c5bddf4bc35af2eb53bda52dfc8b38c451e7e150f1#0` | — |
| Alternative reference script UTxO | `80a146507156745632e5e4b7ae72944fd67a9cc57cb850e826c30151e825be56#0` | — |

## Implementation notes

- The transaction can be built with `cardano-cli transaction build` or any Cardano tx builder library (e.g., Lucid, MeshJS, cardano-serialization-lib).
- No special signing is required beyond the funder's key (the escrow script validates from the datum, not signatures).
- The escrow UTxO must still exist (not yet spent). Verify with `cardano-cli query utxo --address addr1z9vcd07...` or Koios API before building.
- The `invalid_before` field is critical — without it the script cannot verify the current time.
- Execution units should be estimated via `cardano-cli transaction build` (which runs the script in simulation) rather than hardcoded.
