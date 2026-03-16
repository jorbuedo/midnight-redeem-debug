/**
 * Fetch thaw schedules from Midnight API for all eligible addresses.
 * Resumable: only fetches addresses with no schedule_fetched_at.
 * Rate-limited to avoid 403s.
 */

import {DEFAULT_RATE_LIMIT_MS} from './constants.js'
import type {Db, ThawRow} from './db.js'
import {createProgress} from './progress.js'

const MIDNIGHT_API_BASE = 'https://mainnet.prod.gd.midnighttge.io'

const API_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9',
  'cache-control': 'no-cache',
  'content-type': 'application/json',
  origin: 'https://redeem.midnight.gd',
  referer: 'https://redeem.midnight.gd/',
  'user-agent':
    'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.120 Mobile Safari/537.36',
}

type ThawApiResponse = {
  readonly amount: number
  readonly queue_position?: number
  readonly status: string
  readonly thawing_period_start: string
  readonly transaction_id?: string
}

type ScheduleResponse = {
  readonly numberOfClaimedAllocations: number
  readonly thaws: readonly ThawApiResponse[]
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fetchSchedule = async (
  address: string,
): Promise<{thaws: ThawRow[]; claimedAllocations: number} | 'not-eligible' | 'forbidden'> => {
  const url = `${MIDNIGHT_API_BASE}/thaws/${encodeURIComponent(address)}/schedule`
  const res = await fetch(url, {headers: API_HEADERS})

  if (res.status === 403) return 'forbidden'
  if (res.status === 404) return 'not-eligible'

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // 400 with no_redeemable_thaws = not eligible
    if (res.status === 400 && text.includes('no_redeemable_thaws')) return 'not-eligible'
    if (res.status === 400 && text.includes('incorrect_shelley_address')) return 'not-eligible'
    throw new Error(`HTTP ${res.status}: ${text}`)
  }

  const data = (await res.json()) as ScheduleResponse

  if (data.thaws.length === 0) return 'not-eligible'

  const thaws: ThawRow[] = data.thaws.map((t, i) => ({
    thaw_index: i,
    amount: t.amount.toString(),
    status: t.status,
    thawing_period_start: t.thawing_period_start,
    queue_position: t.queue_position,
    transaction_id: t.transaction_id,
  }))

  return {thaws, claimedAllocations: data.numberOfClaimedAllocations}
}

export const fetchSchedules = async (db: Db, rateLimitMs = DEFAULT_RATE_LIMIT_MS) => {
  const addresses = db.getUnfetchedAddresses()

  if (addresses.length === 0) {
    console.log('All addresses already fetched.')
    return
  }

  const stats = db.getStats()
  const progress = createProgress('Schedules', stats.addressCount, stats.fetchedCount)
  let succeeded = 0
  let notEligible = 0
  let errored = 0

  for (let i = 0; i < addresses.length; i++) {
    const address = addresses[i]
    if (!address) continue
    try {
      let result = await fetchSchedule(address)

      // Retry up to 3 times on 403 with 5s backoff
      if (result === 'forbidden') {
        for (let attempt = 0; attempt < 3; attempt++) {
          await sleep(5000)
          result = await fetchSchedule(address)
          if (result !== 'forbidden') break
        }
      }

      if (result === 'forbidden') {
        db.markScheduleFetched(address, '403 Forbidden after retries')
        errored++
      } else if (result === 'not-eligible') {
        db.markScheduleFetched(address, 'not-eligible')
        notEligible++
      } else {
        db.transaction(() => {
          db.insertThawSchedule(address, result.thaws)
          db.markScheduleFetched(address, null, result.claimedAllocations)
        })
        succeeded++
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      db.markScheduleFetched(address, msg)
      errored++
    }

    progress.increment()

    if (i < addresses.length - 1) {
      await sleep(rateLimitMs)
    }
  }

  progress.done(`${succeeded} fetched, ${notEligible} not eligible, ${errored} errors`)
}
