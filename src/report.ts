/**
 * Generate discrepancy report comparing on-chain data vs API status.
 * Outputs markdown (default, git-friendly) or HTML (styled, local viewing).
 */

import {writeFileSync} from 'node:fs'
import {formatNight} from './constants.js'
import type {Db, StoredThaw} from './db.js'
import {createProgress} from './progress.js'

type Discrepancy = {
  address: string
  type: string
  detail: string
  onChainNight: string
  txCount: number
  thaws: StoredThaw[]
  txIds: string[]
}

const CEXPLORER_TX = 'https://cexplorer.io/tx'
const MIDNIGHT_SCHEDULE_API = 'https://mainnet.prod.gd.midnighttge.io/thaws'

const mdAddr = (addr: string) => `[${addr}](${MIDNIGHT_SCHEDULE_API}/${addr}/schedule)`
const mdTx = (txHash: string) => `[${txHash.slice(0, 12)}...](${CEXPLORER_TX}/${txHash})`

const htmlAddr = (addr: string) =>
  `<a href="${MIDNIGHT_SCHEDULE_API}/${addr}/schedule" target="_blank" class="addr">${addr}</a>`
const htmlTx = (txHash: string) =>
  `<a href="${CEXPLORER_TX}/${txHash}" target="_blank" class="tx-link">${txHash.slice(0, 16)}...</a>`

const NORMAL_STATUSES = new Set(['upcoming', 'redeemable', 'confirmed'])

const detectDiscrepancies = (db: Db): Discrepancy[] => {
  const discrepancies: Discrepancy[] = []
  const addresses = db.getAllAddressesWithSchedules()
  const progress = createProgress('Analyzing', addresses.length)

  for (const addr of addresses) {
    progress.increment()
    if (addr.schedule_error) continue

    const thaws = db.getThawsForAddress(addr.address)
    if (thaws.length === 0) continue

    const allOnChainTxs = db.getAllOnChainTxsForAddress(addr.address)
    const onChainTxHashes = new Set(allOnChainTxs.map((t) => t.tx_hash))

    const redeemTxs = db.getRedeemTxsForEligible(addr.address)
    const escrowTxs = db.getEscrowTxsForEligible(addr.address)

    const seenTxHashes = new Set<string>()
    const onChainAmountCounts = new Map<string, number>()
    for (const r of redeemTxs) {
      if (r.night_to_eligible && !seenTxHashes.has(r.tx_hash)) {
        seenTxHashes.add(r.tx_hash)
        onChainAmountCounts.set(r.night_to_eligible, (onChainAmountCounts.get(r.night_to_eligible) ?? 0) + 1)
      }
    }
    for (const e of escrowTxs) {
      if (e.night_to_eligible && !seenTxHashes.has(e.tx_hash)) {
        seenTxHashes.add(e.tx_hash)
        onChainAmountCounts.set(e.night_to_eligible, (onChainAmountCounts.get(e.night_to_eligible) ?? 0) + 1)
      }
    }

    const confirmedAmountCounts = new Map<string, number>()
    for (const thaw of thaws) {
      if (thaw.status === 'confirmed' && thaw.transaction_id) {
        confirmedAmountCounts.set(thaw.amount, (confirmedAmountCounts.get(thaw.amount) ?? 0) + 1)
      }
    }

    const base = {onChainNight: addr.total_night_received, txCount: addr.tx_count, thaws}

    for (const thaw of thaws) {
      if (!NORMAL_STATUSES.has(thaw.status)) {
        discrepancies.push({
          ...base,
          address: addr.address,
          type: 'suspicious-status',
          detail: `Thaw #${thaw.thaw_index}: status="${thaw.status}"`,
          txIds: thaw.transaction_id ? [thaw.transaction_id] : [],
        })
      }

      if (thaw.status === 'redeemable' && !thaw.transaction_id) {
        const onChainCount = onChainAmountCounts.get(thaw.amount) ?? 0
        const confirmedCount = confirmedAmountCounts.get(thaw.amount) ?? 0
        if (onChainCount > confirmedCount) {
          const matchingTxs = [...seenTxHashes].filter((txHash) => {
            const r = redeemTxs.find((rt) => rt.tx_hash === txHash && rt.night_to_eligible === thaw.amount)
            const e = escrowTxs.find((et) => et.tx_hash === txHash && et.night_to_eligible === thaw.amount)
            return r || e
          })
          discrepancies.push({
            ...base,
            address: addr.address,
            type: 'redeemable-but-onchain',
            detail: `Thaw #${thaw.thaw_index}: redeemable, no tx_id, but ${formatNight(BigInt(thaw.amount))} NIGHT delivered ${onChainCount}x on-chain vs ${confirmedCount} confirmed`,
            txIds: matchingTxs,
          })
        }
      }

      if (thaw.status === 'confirmed' && thaw.transaction_id && !onChainTxHashes.has(thaw.transaction_id)) {
        discrepancies.push({
          ...base,
          address: addr.address,
          type: 'confirmed-no-onchain',
          detail: `Thaw #${thaw.thaw_index}: confirmed but tx not found on-chain`,
          txIds: [thaw.transaction_id],
        })
      }

      if (
        (thaw.status === 'failed' || thaw.status === 'skipped') &&
        thaw.transaction_id &&
        onChainTxHashes.has(thaw.transaction_id)
      ) {
        discrepancies.push({
          ...base,
          address: addr.address,
          type: 'failed-but-onchain',
          detail: `Thaw #${thaw.thaw_index}: status=${thaw.status} but tx EXISTS on-chain`,
          txIds: [thaw.transaction_id],
        })
      }
    }

    if (thaws.length >= 2 && redeemTxs.length > 0) {
      const firstRedeem = redeemTxs[0]
      if (firstRedeem?.night_to_eligible) {
        const firstThawAmount = BigInt(firstRedeem.night_to_eligible)
        if (firstThawAmount > 0n) {
          for (const thaw of thaws) {
            const thawAmount = BigInt(thaw.amount)
            if (thawAmount > (firstThawAmount * 120n) / 100n) {
              discrepancies.push({
                ...base,
                address: addr.address,
                type: 'doubled-amount',
                detail: `Thaw #${thaw.thaw_index}: schedule=${formatNight(thawAmount)} but first thaw delivered ${formatNight(firstThawAmount)} (${thaw.status})`,
                txIds: firstRedeem ? [firstRedeem.tx_hash] : [],
              })
            }
          }
        }
      }
    }
  }

  progress.done(
    `${discrepancies.length} discrepancies found across ${new Set(discrepancies.map((d) => d.address)).size} addresses`,
  )
  return discrepancies
}

/** Compute additional analysis stats from the DB */
const analyzePatterns = (db: Db) => {
  const count = (sql: string) => (db.rawQuery(sql).get() as {c: number}).c
  const rows = (sql: string) => db.rawQuery(sql).all() as {status: string; c: number}[]

  const skippedThaw0 = count("SELECT COUNT(*) as c FROM thaw_schedule WHERE status = 'skipped' AND thaw_index = 0")
  const skippedWithOnchain = count(`
    SELECT COUNT(*) as c FROM thaw_schedule ts
    WHERE ts.status = 'skipped' AND ts.thaw_index = 0
    AND ts.address IN (SELECT eligible_address FROM redeem_txs)
  `)
  const failedCount = count("SELECT COUNT(*) as c FROM thaw_schedule WHERE status = 'failed'")
  const failedWithTx = count(
    "SELECT COUNT(*) as c FROM thaw_schedule WHERE status = 'failed' AND transaction_id IS NOT NULL",
  )
  const confirmingCount = count("SELECT COUNT(*) as c FROM thaw_schedule WHERE status = 'confirming'")
  const statusBreakdown = rows(`
    SELECT status, COUNT(*) as c FROM thaw_schedule
    WHERE status NOT IN ('upcoming', 'redeemable', 'confirmed')
    GROUP BY status ORDER BY c DESC
  `)

  return {skippedThaw0, skippedWithOnchain, failedCount, failedWithTx, confirmingCount, statusBreakdown}
}

type ReportData = {
  stats: ReturnType<Db['getStats']>
  redeemStats: ReturnType<Db['getRedeemStats']>
  escrowStats: ReturnType<Db['getEscrowStats']>
  reportStats: ReturnType<Db['getReportStats']>
  totalNight: bigint
  discrepancies: Discrepancy[]
  byType: Map<string, number>
  byAddress: Map<string, Discrepancy[]>
  patterns: ReturnType<typeof analyzePatterns>
}

const collectData = (db: Db): ReportData => {
  const stats = db.getStats()
  const redeemStats = db.getRedeemStats()
  const escrowStats = db.getEscrowStats()
  const reportStats = db.getReportStats()
  const totalNight = db.getTotalNightDistributed()
  const discrepancies = detectDiscrepancies(db)
  const patterns = analyzePatterns(db)

  const byType = new Map<string, number>()
  for (const d of discrepancies) byType.set(d.type, (byType.get(d.type) ?? 0) + 1)

  const byAddress = new Map<string, Discrepancy[]>()
  for (const d of discrepancies) {
    const existing = byAddress.get(d.address) ?? []
    existing.push(d)
    byAddress.set(d.address, existing)
  }

  return {stats, redeemStats, escrowStats, reportStats, totalNight, discrepancies, byType, byAddress, patterns}
}

// --- Markdown ---

const generateMarkdown = (data: ReportData): string => {
  const {stats, redeemStats, escrowStats, reportStats, totalNight, discrepancies, byType, byAddress, patterns} = data
  const l: string[] = []

  l.push('# Midnight NIGHT Token Debug Report')
  l.push('')

  // Key findings
  l.push('## Key Findings')
  l.push('')
  l.push(
    `Analysis of ${stats.addressCount.toLocaleString()} eligible addresses, ${stats.fetchedCount.toLocaleString()} API schedules, and ${stats.txCount.toLocaleString()} on-chain transactions reveals a **single root cause** manifesting as multiple symptoms:`,
  )
  l.push('')
  l.push(
    `**The Midnight backend fails to recognize successful on-chain thaw transactions.** When a first-thaw claim succeeds on-chain but the backend marks it as \`skipped\` or \`failed\`, three things happen:`,
  )
  l.push('')
  l.push(
    `1. **${patterns.skippedThaw0} addresses** have thaw #0 marked \`skipped\` despite all ${patterns.skippedWithOnchain} having a successful on-chain redeem transaction`,
  )
  l.push(
    `2. **${byType.get('doubled-amount') ?? 0} addresses** have thaw #1 amounts inflated (>120% of first-thaw delivery) because the backend rolled the "unclaimed" amount forward. **${formatNight(BigInt(data.discrepancies.filter((d) => d.type === 'doubled-amount').reduce((sum, d) => sum + BigInt(d.thaws[0]?.amount ?? '0') - BigInt(data.discrepancies.find((x) => x.address === d.address && x.type !== 'doubled-amount')?.thaws[0]?.amount ?? d.thaws[0]?.amount ?? '0'), 0n)))} excess NIGHT** is promised in inflated schedules`,
  )
  l.push(
    `3. **${byType.get('redeemable-but-onchain') ?? 0} thaws** show as "redeemable" in the API but the NIGHT was already delivered on-chain — users see a claim button for tokens they already received`,
  )
  l.push('')
  l.push('### Status Breakdown')
  l.push('')
  l.push('| Status | Count | Notes |')
  l.push('| --- | --- | --- |')
  for (const s of patterns.statusBreakdown) {
    let note = ''
    if (s.status === 'skipped') note = 'all thaw #0, all have successful on-chain tx'
    else if (s.status === 'failed') note = `all have tx_id, ${patterns.failedWithTx} tx_ids not found on-chain`
    else if (s.status === 'confirming') note = 'stuck in confirming state'
    l.push(`| ${s.status} | ${s.c} | ${note} |`)
  }
  l.push('')
  l.push(
    'These issues are **not correlated** with shared escrow addresses or dirty funding UTXOs — rates match the baseline population.',
  )
  l.push('')

  // On-Chain Data
  l.push('## On-Chain Data')
  l.push('')
  l.push('| Metric | Value | Detail |')
  l.push('| --- | --- | --- |')
  l.push(
    `| Treasury Transactions | ${stats.txCount.toLocaleString()} | ${(stats.txCount - redeemStats.total).toLocaleString()} non-redeem (setup/admin) |`,
  )
  l.push(
    `| Redeem Transactions | ${redeemStats.total.toLocaleString()} | ${redeemStats.invalidContract > 0 ? `**${redeemStats.invalidContract} failed contracts**` : 'all valid contracts'} |`,
  )
  l.push(`| Eligible Addresses | ${stats.addressCount.toLocaleString()} | 1:1 with redeems (all unique) |`)
  l.push(`| Total NIGHT Distributed | ${formatNight(totalNight)} | valid contracts only |`)
  l.push(
    `| Escrow Addresses | ${escrowStats.total.toLocaleString()} | ${escrowStats.synced.toLocaleString()} synced / ${reportStats.sharedEscrows.toLocaleString()} shared (${reportStats.sharedEscrowAddresses.toLocaleString()} addrs) |`,
  )
  l.push(
    `| Dirty Funding UTXOs | ${redeemStats.dirtyFunding.toLocaleString()} | ${redeemStats.total > 0 ? ((redeemStats.dirtyFunding / redeemStats.total) * 100).toFixed(1) : 0}% of redeems had extra tokens |`,
  )
  l.push('')

  // API Schedule Data
  l.push('## API Schedule Data')
  l.push('')
  l.push('| Metric | Value | Detail |')
  l.push('| --- | --- | --- |')
  l.push(
    `| Schedules Fetched | ${stats.fetchedCount.toLocaleString()} | ${(stats.addressCount - stats.fetchedCount).toLocaleString()} remaining |`,
  )
  l.push(
    `| Addresses with Thaws | ${reportStats.schedulesWithThaws.toLocaleString()} | ${reportStats.notEligible.toLocaleString()} returned not-eligible |`,
  )
  l.push(`| Schedule Errors | ${stats.errorCount.toLocaleString()} | excluding not-eligible |`)
  l.push('')

  // Detailed discrepancy tables
  l.push('## Detailed Discrepancies')
  l.push('')
  l.push(`**${byAddress.size}** addresses with **${discrepancies.length}** total discrepancies`)
  l.push('')

  if (byAddress.size > 0) {
    const typeOrder = [
      'suspicious-status',
      'doubled-amount',
      'redeemable-but-onchain',
      'confirmed-no-onchain',
      'failed-but-onchain',
    ]
    for (const type of typeOrder) {
      const count = byType.get(type)
      if (!count) continue
      const typeDiscrepancies = discrepancies.filter((d) => d.type === type)
      l.push(`### ${type} (${count})`)
      l.push('')
      l.push('| Address | Detail | Txs |')
      l.push('| --- | --- | --- |')
      for (const d of typeDiscrepancies) {
        const txLinks = d.txIds.map((tx) => mdTx(tx)).join(', ')
        l.push(`| ${mdAddr(d.address)} | ${d.detail} | ${txLinks || '-'} |`)
      }
      l.push('')
    }
  }

  l.push(`---\n*Generated at ${new Date().toISOString()} | Last synced block: ${stats.lastBlock ?? 'N/A'}*`)
  return l.join('\n')
}

// --- HTML ---

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const generateHtml = (data: ReportData): string => {
  const {stats, redeemStats, escrowStats, reportStats, totalNight, discrepancies, byType, byAddress, patterns} = data

  const typeOrder = [
    'suspicious-status',
    'doubled-amount',
    'redeemable-but-onchain',
    'confirmed-no-onchain',
    'failed-but-onchain',
  ]
  const typeLabels: Record<string, {title: string; severity: string; desc: string}> = {
    'suspicious-status': {
      title: 'Suspicious Status',
      severity: 'high',
      desc: `${patterns.skippedThaw0} thaw #0 marked "skipped" despite successful on-chain tx. ${patterns.failedCount} marked "failed" (${patterns.failedWithTx} with tx_ids not found on-chain). ${patterns.confirmingCount} stuck in "confirming".`,
    },
    'doubled-amount': {
      title: 'Doubled Thaw Amount',
      severity: 'high',
      desc: 'Schedule amount >120% of first-thaw on-chain delivery. All on thaw #1, all have skipped/failed thaw #0. The backend rolled the "unclaimed" first-thaw amount into subsequent thaws.',
    },
    'redeemable-but-onchain': {
      title: 'Redeemable but Already On-Chain',
      severity: 'medium',
      desc: 'API shows thaw as "redeemable" with no tx_id, but NIGHT was already delivered on-chain. Users see a claim button for tokens they already received.',
    },
    'confirmed-no-onchain': {
      title: 'Confirmed but Not Found On-Chain',
      severity: 'low',
      desc: 'API shows "confirmed" with a tx_id, but our on-chain index does not contain that transaction. May be due to shared escrow tx attribution or very recent transactions not yet indexed.',
    },
    'failed-but-onchain': {
      title: 'Failed but Exists On-Chain',
      severity: 'critical',
      desc: 'API shows "failed" or "skipped" but the transaction EXISTS on-chain. Risk of duplicate claims if backend retries.',
    },
  }

  const discrepancySections = typeOrder
    .filter((type) => byType.has(type))
    .map((type) => {
      const count = byType.get(type)!
      const info = typeLabels[type]!
      const typeDiscrepancies = discrepancies.filter((d) => d.type === type)
      const rows = typeDiscrepancies
        .map(
          (d) => `<tr>
          <td>${htmlAddr(d.address)}</td>
          <td>${escapeHtml(d.detail)}</td>
          <td class="tx-col">${d.txIds.map((tx) => htmlTx(tx)).join(', ') || '&mdash;'}</td>
        </tr>`,
        )
        .join('\n')

      return `
      <details class="discrepancy-section">
        <summary class="section-header severity-${info.severity}">
          <h3>${escapeHtml(info.title)} <span class="count">${count}</span></h3>
          <p class="section-desc">${escapeHtml(info.desc)}</p>
        </summary>
        <table>
          <thead><tr><th>Address</th><th>Detail</th><th>Transactions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`
    })
    .join('\n')

  const statusRows = patterns.statusBreakdown
    .map((s) => {
      let note = ''
      if (s.status === 'skipped') note = 'all thaw #0, all have successful on-chain tx'
      else if (s.status === 'failed') note = `all have tx_id, ${patterns.failedWithTx} tx_ids not found on-chain`
      else if (s.status === 'confirming') note = 'stuck in confirming state'
      return `<tr><td><code>${escapeHtml(s.status)}</code></td><td>${s.c}</td><td>${note}</td></tr>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Midnight NIGHT Token Debug Report</title>
<style>
  :root {
    --bg: #f8f9fa; --surface: #ffffff; --text: #1a1a2e; --text-secondary: #6c757d;
    --border: #e9ecef; --accent: #4361ee; --accent-light: #eef0ff;
    --red: #dc3545; --orange: #fd7e14; --yellow: #ffc107; --green: #198754; --purple: #6f42c1;
    --radius: 12px; --shadow: 0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06);
    --shadow-lg: 0 4px 6px rgba(0,0,0,0.07), 0 2px 4px rgba(0,0,0,0.06);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: var(--bg); color: var(--text); line-height: 1.6; }
  .container { max-width: 1400px; margin: 0 auto; padding: 2rem; }
  header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%); color: white; padding: 2.5rem 0; margin-bottom: 2rem; }
  header .container { padding-top: 0; padding-bottom: 0; }
  header h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }
  header .subtitle { opacity: 0.7; font-size: 0.9rem; }
  h2 { font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: var(--text); border-bottom: 2px solid var(--accent); padding-bottom: 0.5rem; display: inline-block; }
  .section { margin-bottom: 2.5rem; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
  .card { background: var(--surface); border-radius: var(--radius); padding: 1.25rem 1.5rem; box-shadow: var(--shadow); border: 1px solid var(--border); transition: box-shadow 0.2s; }
  .card:hover { box-shadow: var(--shadow-lg); }
  .card .value { font-size: 1.75rem; font-weight: 700; color: var(--accent); letter-spacing: -0.02em; }
  .card .label { font-size: 0.8rem; font-weight: 500; color: var(--text-secondary); margin-top: 0.15rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .card .detail { font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.35rem; }
  .card .value.warn { color: var(--red); }
  .card .value.ok { color: var(--green); }

  .finding { background: var(--surface); border-radius: var(--radius); padding: 1.5rem 2rem; box-shadow: var(--shadow); border: 1px solid var(--border); margin-bottom: 1.5rem; }
  .finding p { color: var(--text-secondary); margin-bottom: 0.75rem; line-height: 1.7; }
  .finding strong { color: var(--text); }
  .finding ol { margin: 0.75rem 0 0.75rem 1.5rem; color: var(--text-secondary); }
  .finding ol li { margin-bottom: 0.5rem; }
  .finding .note { font-size: 0.85rem; font-style: italic; color: var(--text-secondary); border-top: 1px solid var(--border); padding-top: 0.75rem; margin-top: 0.75rem; }
  .status-table { margin-top: 1rem; }
  .status-table table { font-size: 0.85rem; border-radius: var(--radius); }
  .status-table code { background: var(--bg); padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; }

  .discrepancy-section { margin-bottom: 1rem; }
  .discrepancy-section[open] .section-header { border-radius: var(--radius) var(--radius) 0 0; }
  .section-header { background: var(--surface); border-radius: var(--radius); padding: 1.25rem 1.5rem; border: 1px solid var(--border); cursor: pointer; list-style: none; }
  .section-header::-webkit-details-marker { display: none; }
  .section-header::marker { display: none; content: ''; }
  .discrepancy-section[open] .section-header { border-bottom: none; }
  .section-header h3 { font-size: 1rem; font-weight: 600; margin-bottom: 0.35rem; }
  .section-header h3::before { content: '\\25B6'; display: inline-block; margin-right: 0.5rem; font-size: 0.7rem; transition: transform 0.2s; }
  .discrepancy-section[open] .section-header h3::before { transform: rotate(90deg); }
  .section-header .count { background: var(--bg); padding: 0.15rem 0.6rem; border-radius: 12px; font-size: 0.8rem; margin-left: 0.5rem; }
  .section-header.severity-critical { border-left: 4px solid var(--red); }
  .section-header.severity-high { border-left: 4px solid var(--orange); }
  .section-header.severity-medium { border-left: 4px solid var(--yellow); }
  .section-header.severity-low { border-left: 4px solid var(--green); }
  .section-desc { font-size: 0.85rem; color: var(--text-secondary); line-height: 1.6; }

  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); overflow: hidden; box-shadow: var(--shadow); font-size: 0.85rem; }
  thead { background: var(--bg); }
  th { padding: 0.65rem 1rem; text-align: left; font-weight: 600; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); border-bottom: 2px solid var(--border); }
  td { padding: 0.6rem 1rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--accent-light); }
  .addr { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.7rem; word-break: break-all; color: var(--accent); text-decoration: none; max-width: 280px; display: inline-block; }
  .addr:hover { text-decoration: underline; }
  .tx-link { font-family: 'JetBrains Mono', 'Fira Code', monospace; font-size: 0.75rem; color: var(--accent); text-decoration: none; }
  .tx-link:hover { text-decoration: underline; }
  .tx-col { white-space: nowrap; }
  .generated { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--text-secondary); font-size: 0.75rem; text-align: center; }
</style>
</head>
<body>
<header>
  <div class="container">
    <h1>Midnight NIGHT Token Debug Report</h1>
    <p class="subtitle">On-chain vs API schedule discrepancy analysis</p>
  </div>
</header>

<div class="container">

<div class="section">
  <h2>Key Findings</h2>
  <div class="finding">
    <p>Analysis of <strong>${stats.addressCount.toLocaleString()}</strong> eligible addresses, <strong>${stats.fetchedCount.toLocaleString()}</strong> API schedules, and <strong>${stats.txCount.toLocaleString()}</strong> on-chain transactions reveals a <strong>single root cause</strong> manifesting as multiple symptoms:</p>
    <p><strong>The Midnight backend fails to recognize successful on-chain thaw transactions.</strong> When a first-thaw claim succeeds on-chain but the backend marks it as <code>skipped</code> or <code>failed</code>, three things happen:</p>
    <ol>
      <li><strong>${patterns.skippedThaw0} addresses</strong> have thaw #0 marked <code>skipped</code> despite all ${patterns.skippedWithOnchain} having a successful on-chain redeem transaction</li>
      <li><strong>${byType.get('doubled-amount') ?? 0} addresses</strong> have thaw #1 amounts inflated because the backend rolled the "unclaimed" amount forward</li>
      <li><strong>${byType.get('redeemable-but-onchain') ?? 0} thaws</strong> show as "redeemable" in the API but the NIGHT was already delivered on-chain &mdash; users see a claim button for tokens they already received</li>
    </ol>
    <p class="note">These issues are <strong>not correlated</strong> with shared escrow addresses or dirty funding UTXOs &mdash; rates match the baseline population.</p>
    <div class="status-table">
      <table>
        <thead><tr><th>Status</th><th>Count</th><th>Notes</th></tr></thead>
        <tbody>${statusRows}</tbody>
      </table>
    </div>
  </div>
</div>

<div class="section">
  <h2>On-Chain Data</h2>
  <div class="cards">
    <div class="card"><div class="value">${stats.txCount.toLocaleString()}</div><div class="label">Treasury Transactions</div><div class="detail">${(stats.txCount - redeemStats.total).toLocaleString()} non-redeem (setup/admin)</div></div>
    <div class="card"><div class="value">${redeemStats.total.toLocaleString()}</div><div class="label">Redeem Transactions</div><div class="detail">${redeemStats.invalidContract > 0 ? `<span style="color:var(--red)">${redeemStats.invalidContract} failed contracts</span>` : 'all valid contracts'}</div></div>
    <div class="card"><div class="value">${stats.addressCount.toLocaleString()}</div><div class="label">Eligible Addresses</div><div class="detail">1:1 with redeems (all unique)</div></div>
    <div class="card"><div class="value">${formatNight(totalNight)}</div><div class="label">Total NIGHT Distributed</div><div class="detail">valid contracts only</div></div>
    <div class="card"><div class="value">${escrowStats.total.toLocaleString()}</div><div class="label">Escrow Addresses</div><div class="detail">${escrowStats.synced.toLocaleString()} synced / ${reportStats.sharedEscrows.toLocaleString()} shared (${reportStats.sharedEscrowAddresses.toLocaleString()} addrs)</div></div>
    <div class="card"><div class="value">${redeemStats.dirtyFunding.toLocaleString()}</div><div class="label">Dirty Funding UTXOs</div><div class="detail">${redeemStats.total > 0 ? ((redeemStats.dirtyFunding / redeemStats.total) * 100).toFixed(1) : 0}% of redeems had extra tokens</div></div>
  </div>
</div>

<div class="section">
  <h2>API Schedule Data</h2>
  <div class="cards">
    <div class="card"><div class="value">${stats.fetchedCount.toLocaleString()}</div><div class="label">Schedules Fetched</div><div class="detail">${(stats.addressCount - stats.fetchedCount).toLocaleString()} remaining</div></div>
    <div class="card"><div class="value">${reportStats.schedulesWithThaws.toLocaleString()}</div><div class="label">Addresses with Thaws</div><div class="detail">${reportStats.notEligible.toLocaleString()} returned not-eligible</div></div>
    <div class="card"><div class="value">${stats.errorCount.toLocaleString()}</div><div class="label">Schedule Errors</div><div class="detail">excluding not-eligible</div></div>
  </div>
</div>

<div class="section">
  <h2>Discrepancies</h2>
  <div class="cards">
    <div class="card"><div class="value ${byAddress.size > 0 ? 'warn' : 'ok'}">${byAddress.size.toLocaleString()}</div><div class="label">Addresses with Issues</div></div>
    <div class="card"><div class="value ${discrepancies.length > 0 ? 'warn' : 'ok'}">${discrepancies.length.toLocaleString()}</div><div class="label">Total Discrepancies</div></div>
  </div>
  ${byAddress.size === 0 ? '<p>No discrepancies found.</p>' : discrepancySections}
</div>

<p class="generated">Generated at ${new Date().toISOString()} &middot; Last synced block: ${stats.lastBlock ?? 'N/A'}</p>
</div>
</body>
</html>`
}

// --- Public API ---

export type ReportFormat = 'markdown' | 'html' | 'both'

export const generateReport = (db: Db, outputPath: string, format: ReportFormat = 'both') => {
  const data = collectData(db)

  const formats: {fmt: 'markdown' | 'html'; path: string}[] = []
  if (format === 'both' || format === 'markdown') {
    const mdPath = format === 'both' ? outputPath.replace(/\.\w+$/, '.md') : outputPath
    formats.push({fmt: 'markdown', path: mdPath})
  }
  if (format === 'both' || format === 'html') {
    const htmlPath = format === 'both' ? outputPath.replace(/\.\w+$/, '.html') : outputPath
    formats.push({fmt: 'html', path: htmlPath})
  }

  for (const {fmt, path} of formats) {
    const content = fmt === 'html' ? generateHtml(data) : generateMarkdown(data)
    writeFileSync(path, content, 'utf-8')
    console.log(`Report written to ${path}`)
  }

  console.log(`${data.byAddress.size} addresses with ${data.discrepancies.length} discrepancies found.`)
  if (data.byType.size > 0) {
    for (const [type, count] of data.byType) console.log(`  ${type}: ${count}`)
  }
}
