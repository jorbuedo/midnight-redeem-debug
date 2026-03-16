/**
 * Fetch treasury transactions from Yoroi and extract NIGHT outputs.
 * Resumable via cursor stored in sync_state.
 *
 * Redeem tx identification (order-independent):
 *   - Treasury is one of the inputs
 *   - Exactly 4 outputs
 *   - One output goes to treasury (NIGHT change)
 *   - One output is a base address receiving NIGHT (eligible)
 *   - One output is a script address receiving NIGHT (escrow, addr1z/addr1w != treasury)
 *   - One output is the ADA change to funder (no NIGHT)
 *
 * Non-redeem treasury txs (setup, funding, etc.) are stored but not used for escrow mapping.
 */

import {type ApiOutput, type ApiTransaction, bestBlock, type TxHistoryCursor, txHistory} from './api/yoroi.js'
import {NIGHT_ASSET_ID, TREASURY_ADDRESS, TX_PAGE_SIZE} from './constants.js'
import type {Db} from './db.js'
import {createProgress} from './progress.js'

const getNight = (output: ApiOutput): string | undefined =>
  output.assets.find((a) => a.assetId === NIGHT_ASSET_ID)?.amount

type RedeemParts = {
  eligible: ApiOutput
  escrow: ApiOutput
  treasury: ApiOutput
  change: ApiOutput
  eligibleAddress: string
  escrowAddress: string
}

/**
 * Classify outputs by their properties, not position.
 * Treasury: address matches treasury. Eligible: base address with NIGHT.
 * Escrow: script address with NIGHT (not treasury). Change: whatever's left.
 */
const parseRedeemTx = (tx: ApiTransaction): RedeemParts | null => {
  if (tx.outputs.length !== 4) return null
  if (!tx.inputs.some((inp) => inp.address === TREASURY_ADDRESS)) return null

  let treasury: ApiOutput | undefined
  let eligible: ApiOutput | undefined
  let escrow: ApiOutput | undefined
  let change: ApiOutput | undefined

  for (const out of tx.outputs) {
    if (out.address === TREASURY_ADDRESS) {
      treasury = out
    } else if (!out.address.startsWith('addr1w') && !out.address.startsWith('addr1z') && getNight(out)) {
      eligible = out
    } else if (
      (out.address.startsWith('addr1w') || out.address.startsWith('addr1z')) &&
      out.address !== TREASURY_ADDRESS &&
      getNight(out)
    ) {
      escrow = out
    } else {
      change = out
    }
  }

  if (!treasury || !eligible || !escrow || !change) return null

  return {
    treasury,
    eligible,
    escrow,
    change,
    eligibleAddress: eligible.address,
    escrowAddress: escrow.address,
  }
}

/**
 * Approximate total treasury txs for progress estimation.
 * Updated periodically — doesn't need to be exact, just gives a sense of progress.
 */
const APPROX_TOTAL_TREASURY_TXS = 51200

export const fetchTxs = async (db: Db) => {
  const tip = await bestBlock()
  console.log(`Chain tip: block ${tip.height}, hash ${tip.hash}`)

  const cursorJson = db.getSyncState('tx_cursor')
  let cursor: TxHistoryCursor | undefined = cursorJson ? JSON.parse(cursorJson) : undefined

  const startOffset = db.getStats().txCount
  if (cursor) {
    console.log(`Resuming from ${startOffset} txs already fetched`)
  }

  const progress = createProgress('Treasury txs', APPROX_TOTAL_TREASURY_TXS, startOffset)
  let totalFetched = startOffset
  let redeemTxs = 0

  while (true) {
    const txs = await txHistory([TREASURY_ADDRESS], tip.hash, cursor, TX_PAGE_SIZE)

    if (txs.length === 0) break

    db.transaction(() => {
      for (const tx of txs) {
        db.insertTransaction({
          hash: tx.hash,
          block_num: tx.block_num,
          block_hash: tx.block_hash,
          time: tx.time,
          tx_ordinal: tx.tx_ordinal,
          valid_contract: tx.valid_contract !== false,
        })

        const redeem = parseRedeemTx(tx)
        if (redeem) {
          redeemTxs++

          const eligibleNight = getNight(redeem.eligible)
          const escrowNight = getNight(redeem.escrow)
          const treasuryNight = getNight(redeem.treasury)

          if (eligibleNight) {
            const eligibleIdx = tx.outputs.indexOf(redeem.eligible)
            db.insertNightOutput({
              tx_hash: tx.hash,
              output_index: eligibleIdx,
              address: redeem.eligibleAddress,
              ada_amount: redeem.eligible.amount,
              night_amount: eligibleNight,
            })

            db.upsertEligibleAddress({
              address: redeem.eligibleAddress,
              night_amount: eligibleNight,
              block_num: tx.block_num,
            })
          }

          if (escrowNight) {
            const escrowIdx = tx.outputs.indexOf(redeem.escrow)
            db.insertNightOutput({
              tx_hash: tx.hash,
              output_index: escrowIdx,
              address: redeem.escrowAddress,
              ada_amount: redeem.escrow.amount,
              night_amount: escrowNight,
            })
          }

          // Analyze funding inputs — find non-treasury inputs
          const fundingInputs = tx.inputs.filter((inp) => inp.address !== TREASURY_ADDRESS)
          const primaryFunder = fundingInputs[0]
          const allFundingTokens = fundingInputs.flatMap((inp) => inp.assets)

          db.insertRedeemTx({
            tx_hash: tx.hash,
            eligible_address: redeem.eligibleAddress,
            escrow_address: redeem.escrowAddress,
            funding_address: primaryFunder?.address ?? '',
            night_to_eligible: eligibleNight ?? null,
            night_to_escrow: escrowNight ?? null,
            night_to_treasury: treasuryNight ?? null,
            funding_ada: primaryFunder?.amount ?? '0',
            funding_has_tokens: allFundingTokens.length > 0,
            funding_token_count: allFundingTokens.length,
            funding_tokens_json:
              allFundingTokens.length > 0
                ? JSON.stringify(allFundingTokens.map((a) => ({id: a.assetId, amount: a.amount})))
                : null,
            input_count: tx.inputs.length,
          })

          db.insertEscrow(redeem.escrowAddress, redeem.eligibleAddress, tx.hash)
        }
      }

      const lastTx = txs[txs.length - 1]
      if (lastTx?.block_hash) {
        cursor = {block: lastTx.block_hash, tx: lastTx.hash}
        db.setSyncState('tx_cursor', JSON.stringify(cursor))
      }
    })

    totalFetched += txs.length
    progress.update(totalFetched)

    if (txs.length < TX_PAGE_SIZE) break
  }

  const stats = db.getStats()
  const escrowStats = db.getEscrowStats()
  progress.done(
    `${stats.txCount} total txs, ${redeemTxs} redeems, ${stats.addressCount} eligible, ${escrowStats.total} escrows`,
  )
}
