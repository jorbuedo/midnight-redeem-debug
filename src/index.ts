#!/usr/bin/env bun
/**
 * Midnight NIGHT token debug CLI.
 *
 * Usage:
 *   bun src/index.ts <command> [options]
 *
 * Commands:
 *   sync              Run full pipeline: fetch txs + schedules in parallel, then escrows, then report
 *   fetch-txs         Fetch treasury transactions from Yoroi (resumable)
 *   fetch-escrows     Fetch escrow address tx history (subsequent thaw redemptions)
 *   fetch-schedules   Fetch thaw schedules from Midnight API (resumable, rate-limited)
 *   report            Generate discrepancy report (markdown by default)
 *   status            Show sync progress
 *
 * Options:
 *   --db <path>        SQLite path (default: ./midnight-debug.db)
 *   --rate-limit <ms>  Delay between schedule API calls (default: 750)
 *   --output <path>    Report output path (default: ./midnight-debug-report.md)
 *   --format <fmt>     Report format: both, markdown, or html (default: both)
 */

import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

import {openDb} from './db.js'
import {fetchEscrows} from './fetch-escrows.js'
import {fetchSchedules} from './fetch-schedules.js'
import {fetchTxs} from './fetch-txs.js'
import {generateReport, type ReportFormat} from './report.js'
import {showStatus} from './status.js'
import {sync} from './sync.js'

const {values, positionals} = parseArgs({
  allowPositionals: true,
  options: {
    db: {type: 'string'},
    'rate-limit': {type: 'string', default: '750'},
    output: {type: 'string'},
    format: {type: 'string', default: 'both'},
    help: {type: 'boolean', short: 'h', default: false},
  },
})

const command = positionals[0]

if (!command || values.help) {
  console.log(`Usage: bun src/index.ts <command> [options]

Commands:
  sync              Run full pipeline (fetch txs + schedules in parallel, then escrows, then report)
  fetch-txs         Fetch treasury transactions only
  fetch-escrows     Fetch escrow tx history only
  fetch-schedules   Fetch thaw schedules only (rate-limited)
  report            Generate discrepancy report from existing data
  status            Show sync progress

Options:
  --db <path>        SQLite path (default: ./midnight-debug.db)
  --rate-limit <ms>  Delay between schedule API calls (default: 750)
  --output <path>    Report output path (default: ./midnight-debug-report.md)
  --format <fmt>     Report format: both, markdown, or html (default: both)
  -h, --help         Show this help`)
  process.exit(values.help ? 0 : 1)
}

const formatMap: Record<string, ReportFormat> = {html: 'html', markdown: 'markdown', both: 'both'}
const format = formatMap[values.format ?? 'both'] ?? 'both'
const defaultExt = format === 'html' ? '.html' : '.md'
const dbPath = values.db ?? resolve(APP_DIR, 'midnight-debug.db')
const rateLimitMs = parseInt(values['rate-limit'] ?? '750', 10)
const outputPath = values.output ?? resolve(APP_DIR, `midnight-debug-report${defaultExt}`)

const run = async () => {
  const db = openDb(dbPath)

  try {
    switch (command) {
      case 'sync':
        await sync(db, rateLimitMs, outputPath, format)
        break
      case 'fetch-txs':
        await fetchTxs(db)
        break
      case 'fetch-escrows':
        await fetchEscrows(db)
        break
      case 'fetch-schedules':
        await fetchSchedules(db, rateLimitMs)
        break
      case 'report':
        generateReport(db, outputPath, format)
        break
      case 'status':
        showStatus(db)
        break
      default:
        console.error(`Unknown command: ${command}`)
        process.exit(1)
    }
  } finally {
    db.close()
  }
}

run().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
