/**
 * Print sync progress to console.
 */

import {formatNight} from './constants.js'
import type {Db} from './db.js'

export const showStatus = (db: Db) => {
  const stats = db.getStats()
  const totalNight = db.getTotalNightDistributed()
  const remaining = stats.addressCount - stats.fetchedCount
  const escrowStats = db.getEscrowStats()
  const redeemStats = db.getRedeemStats()

  console.log('=== Midnight Debug Status ===')
  console.log(`Transactions:        ${stats.txCount}`)
  console.log(`Last synced block:   ${stats.lastBlock ?? 'none'}`)
  console.log(`Redeem txs:          ${redeemStats.total}`)
  console.log(
    `  Dirty funding:     ${redeemStats.dirtyFunding} (${redeemStats.total > 0 ? ((redeemStats.dirtyFunding / redeemStats.total) * 100).toFixed(1) : 0}%)`,
  )
  console.log(`Eligible addresses:  ${stats.addressCount}`)
  console.log(`Total NIGHT sent:    ${formatNight(totalNight)} NIGHT`)
  console.log(`Escrow addresses:    ${escrowStats.total} (${escrowStats.synced} synced)`)
  console.log(`Schedules fetched:   ${stats.fetchedCount}`)
  console.log(`Schedules remaining: ${remaining}`)
  console.log(`Schedule errors:     ${stats.errorCount}`)
}
