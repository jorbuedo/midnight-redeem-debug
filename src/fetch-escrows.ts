/**
 * Fetch transaction history for each escrow address.
 * These are the subsequent thaw redemptions (thaw 2, 3, 4...).
 * Resumable: only fetches escrow addresses with no escrow_synced_at.
 * Runs with concurrent workers to avoid being bottlenecked by sequential HTTP.
 */

import {bestBlock, type TxHistoryCursor, txHistory} from './api/yoroi.js'
import {NIGHT_ASSET_ID} from './constants.js'
import type {Db} from './db.js'
import {createProgress} from './progress.js'

const CONCURRENCY = 20
const MAX_RETRIES = 5
const RETRY_BASE_MS = 2000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const withRetry = async <T>(fn: () => Promise<T>): Promise<T> => {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const isRetryable =
        err instanceof Error && (/50[234]/.test(err.message) || /ECONNRESET|ETIMEDOUT|fetch failed/.test(err.message))
      if (!isRetryable || attempt === MAX_RETRIES) throw err
      await sleep(RETRY_BASE_MS * 2 ** attempt)
    }
  }
  throw new Error('unreachable')
}

type EscrowEntry = {escrow_address: string; eligible_addresses: string[]}

const fetchOneEscrow = async (db: Db, escrow: EscrowEntry, tipHash: string): Promise<number> => {
  const {escrow_address, eligible_addresses} = escrow
  const eligibleSet = new Set(eligible_addresses)
  let cursor: TxHistoryCursor | undefined
  let txCount = 0

  while (true) {
    const txs = await withRetry(() => txHistory([escrow_address], tipHash, cursor, 50))
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

        // Find NIGHT going back to escrow (remaining thaws)
        let nightToEscrow: string | null = null
        for (const output of tx.outputs) {
          if (output.address === escrow_address) {
            const nightAsset = output.assets.find((a) => a.assetId === NIGHT_ASSET_ID)
            if (nightAsset) nightToEscrow = nightAsset.amount
          }
        }

        // Record a row per eligible address that received NIGHT in this tx
        for (const output of tx.outputs) {
          if (!eligibleSet.has(output.address)) continue
          const nightAsset = output.assets.find((a) => a.assetId === NIGHT_ASSET_ID)
          if (!nightAsset) continue

          db.insertEscrowTx({
            tx_hash: tx.hash,
            escrow_address,
            eligible_address: output.address,
            block_num: tx.block_num,
            time: tx.time,
            night_to_eligible: nightAsset.amount,
            night_to_escrow: nightToEscrow,
          })
        }

        txCount++
      }
    })

    const last = txs[txs.length - 1]
    if (txs.length < 50 || !last?.block_hash) break
    cursor = {block: last.block_hash, tx: last.hash}
  }

  db.markEscrowSynced(escrow_address)
  return txCount
}

export const fetchEscrows = async (db: Db) => {
  const tip = await bestBlock()
  console.log(`Chain tip: block ${tip.height}`)

  const escrows = db.getUnsyncedEscrows()

  if (escrows.length === 0) {
    console.log('All escrow addresses already synced.')
    return
  }

  const escrowStats = db.getEscrowStats()
  const progress = createProgress('Escrows', escrowStats.total, escrowStats.synced)
  let totalEscrowTxs = 0
  let idx = 0

  let errors = 0

  const worker = async () => {
    while (true) {
      const i = idx++
      if (i >= escrows.length) break
      const escrow = escrows[i]
      if (!escrow) break

      try {
        const count = await fetchOneEscrow(db, escrow, tip.hash)
        totalEscrowTxs += count
      } catch (err) {
        errors++
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`\nError fetching ${escrow.escrow_address.slice(0, 20)}...: ${msg}\n`)
      }
      progress.increment()
    }
  }

  const workers = Array.from({length: Math.min(CONCURRENCY, escrows.length)}, () => worker())
  await Promise.all(workers)

  const finalStats = db.getEscrowStats()
  progress.done(
    `${finalStats.synced}/${finalStats.total} escrows synced, ${totalEscrowTxs} escrow txs found${errors > 0 ? `, ${errors} errors (re-run to retry)` : ''}`,
  )
}
