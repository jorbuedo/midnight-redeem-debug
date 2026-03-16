/**
 * Run all fetch steps concurrently where possible, then generate report.
 *
 * - fetch-txs and fetch-schedules run in parallel (txs are fast, schedules are rate-limited)
 * - fetch-escrows runs after fetch-txs completes (needs escrow addresses)
 * - As fetch-txs discovers new eligible addresses, fetch-schedules picks them up
 *   on its next pass (schedules only queries unfetched addresses)
 * - Report generates at the end
 */

import type {Db} from './db.js'
import {fetchEscrows} from './fetch-escrows.js'
import {fetchSchedules} from './fetch-schedules.js'
import {fetchTxs} from './fetch-txs.js'
import {generateReport, type ReportFormat} from './report.js'

export const sync = async (db: Db, rateLimitMs: number, outputPath: string, format: ReportFormat = 'markdown') => {
  // Run fetch-txs and fetch-schedules concurrently.
  // fetch-schedules will process whatever eligible addresses exist in the db,
  // including ones added by fetch-txs as it runs.
  // We loop fetch-schedules so it picks up new addresses from fetch-txs.
  console.log('Starting parallel sync: fetch-txs + fetch-schedules\n')

  let txsDone = false

  const txsPromise = fetchTxs(db).finally(() => {
    txsDone = true
  })

  const schedulesPromise = (async () => {
    // Keep fetching schedules in rounds until txs are done and no more unfetched addresses
    while (true) {
      const unfetched = db.getUnfetchedAddresses()
      if (unfetched.length > 0) {
        await fetchSchedules(db, rateLimitMs)
      }
      if (txsDone) {
        // One final pass to catch any addresses added in the last tx batch
        const remaining = db.getUnfetchedAddresses()
        if (remaining.length > 0) {
          await fetchSchedules(db, rateLimitMs)
        }
        break
      }
      // Wait a bit before checking for new addresses
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
  })()

  await Promise.all([txsPromise, schedulesPromise])

  // Now fetch escrow tx history (needs escrow addresses from fetch-txs)
  console.log()
  await fetchEscrows(db)

  // Generate report
  console.log()
  generateReport(db, outputPath, format)
}
