/**
 * SQLite database schema and query helpers for midnight-debug.
 * Uses bun:sqlite for relational queries (joins, aggregations, WHERE clauses).
 */

import {Database} from 'bun:sqlite'

export type Db = ReturnType<typeof openDb>

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS transactions (
    hash TEXT PRIMARY KEY,
    block_num INTEGER,
    block_hash TEXT,
    time TEXT,
    tx_ordinal INTEGER,
    valid_contract INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS night_outputs (
    tx_hash TEXT NOT NULL,
    output_index INTEGER NOT NULL,
    address TEXT NOT NULL,
    ada_amount TEXT NOT NULL,
    night_amount TEXT NOT NULL,
    PRIMARY KEY (tx_hash, output_index)
  );

  CREATE TABLE IF NOT EXISTS eligible_addresses (
    address TEXT PRIMARY KEY,
    total_night_received TEXT NOT NULL DEFAULT '0',
    tx_count INTEGER NOT NULL DEFAULT 0,
    first_seen_block INTEGER,
    schedule_fetched_at TEXT,
    schedule_error TEXT,
    number_of_claimed_allocations INTEGER
  );

  CREATE TABLE IF NOT EXISTS thaw_schedule (
    address TEXT NOT NULL,
    thaw_index INTEGER NOT NULL,
    amount TEXT NOT NULL,
    status TEXT NOT NULL,
    thawing_period_start TEXT NOT NULL,
    queue_position INTEGER,
    transaction_id TEXT,
    PRIMARY KEY (address, thaw_index)
  );

  CREATE TABLE IF NOT EXISTS redeem_txs (
    tx_hash TEXT PRIMARY KEY,
    eligible_address TEXT NOT NULL,
    escrow_address TEXT NOT NULL,
    funding_address TEXT NOT NULL,
    night_to_eligible TEXT,
    night_to_escrow TEXT,
    night_to_treasury TEXT,
    funding_ada TEXT NOT NULL,
    funding_has_tokens INTEGER NOT NULL DEFAULT 0,
    funding_token_count INTEGER NOT NULL DEFAULT 0,
    funding_tokens_json TEXT,
    input_count INTEGER NOT NULL DEFAULT 2
  );

  CREATE TABLE IF NOT EXISTS escrow_addresses (
    escrow_address TEXT NOT NULL,
    eligible_address TEXT NOT NULL,
    first_seen_tx TEXT NOT NULL,
    escrow_synced_at TEXT,
    PRIMARY KEY (escrow_address, eligible_address)
  );

  CREATE TABLE IF NOT EXISTS escrow_txs (
    tx_hash TEXT NOT NULL,
    escrow_address TEXT NOT NULL,
    eligible_address TEXT NOT NULL,
    block_num INTEGER,
    time TEXT,
    night_to_eligible TEXT,
    night_to_escrow TEXT,
    PRIMARY KEY (tx_hash, escrow_address, eligible_address)
  );

  CREATE TABLE IF NOT EXISTS sync_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

export const openDb = (path: string) => {
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 30000')
  db.exec(SCHEMA)

  // Migration: rebuild escrow_addresses with composite PK if it has the old single-column PK
  const tableInfo = db.prepare("PRAGMA table_info('escrow_addresses')").all() as {name: string; pk: number}[]
  const pkColumns = tableInfo.filter((c) => c.pk > 0)
  if (pkColumns.length === 1 && pkColumns[0]?.name === 'escrow_address') {
    db.exec(`
      DROP TABLE escrow_addresses;
      CREATE TABLE escrow_addresses (
        escrow_address TEXT NOT NULL,
        eligible_address TEXT NOT NULL,
        first_seen_tx TEXT NOT NULL,
        escrow_synced_at TEXT,
        PRIMARY KEY (escrow_address, eligible_address)
      );
      INSERT OR IGNORE INTO escrow_addresses (escrow_address, eligible_address, first_seen_tx)
        SELECT escrow_address, eligible_address, tx_hash
        FROM redeem_txs;
    `)
  }

  // Migration: rebuild escrow_txs with 3-column PK if it has the old 2-column PK
  const escrowTxInfo = db.prepare("PRAGMA table_info('escrow_txs')").all() as {name: string; pk: number}[]
  const escrowTxPks = escrowTxInfo.filter((c) => c.pk > 0)
  if (escrowTxPks.length === 2) {
    // Need to reset escrow sync so shared escrows get re-fetched with the new PK
    db.exec(`
      DROP TABLE escrow_txs;
      CREATE TABLE IF NOT EXISTS escrow_txs (
        tx_hash TEXT NOT NULL,
        escrow_address TEXT NOT NULL,
        eligible_address TEXT NOT NULL,
        block_num INTEGER,
        time TEXT,
        night_to_eligible TEXT,
        night_to_escrow TEXT,
        PRIMARY KEY (tx_hash, escrow_address, eligible_address)
      );
      UPDATE escrow_addresses SET escrow_synced_at = NULL;
    `)
  }

  const stmts = {
    insertTx: db.prepare(`
      INSERT OR IGNORE INTO transactions (hash, block_num, block_hash, time, tx_ordinal, valid_contract)
      VALUES ($hash, $block_num, $block_hash, $time, $tx_ordinal, $valid_contract)
    `),
    insertNightOutput: db.prepare(`
      INSERT OR IGNORE INTO night_outputs (tx_hash, output_index, address, ada_amount, night_amount)
      VALUES ($tx_hash, $output_index, $address, $ada_amount, $night_amount)
    `),
    upsertEligibleAddress: db.prepare(`
      INSERT INTO eligible_addresses (address, total_night_received, tx_count, first_seen_block)
      VALUES ($address, $night_amount, 1, $block_num)
      ON CONFLICT(address) DO UPDATE SET
        total_night_received = CAST(CAST(total_night_received AS INTEGER) + CAST($night_amount AS INTEGER) AS TEXT),
        tx_count = tx_count + 1,
        first_seen_block = MIN(COALESCE(first_seen_block, $block_num), COALESCE($block_num, first_seen_block))
    `),
    getSyncState: db.prepare('SELECT value FROM sync_state WHERE key = $key'),
    setSyncState: db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES ($key, $value)'),
    getUnfetchedAddresses: db.prepare(
      'SELECT address FROM eligible_addresses WHERE schedule_fetched_at IS NULL ORDER BY address',
    ),
    markScheduleFetched: db.prepare(
      'UPDATE eligible_addresses SET schedule_fetched_at = $fetched_at, schedule_error = $error, number_of_claimed_allocations = $claimed WHERE address = $address',
    ),
    clearThawSchedule: db.prepare('DELETE FROM thaw_schedule WHERE address = $address'),
    insertThaw: db.prepare(`
      INSERT OR REPLACE INTO thaw_schedule (address, thaw_index, amount, status, thawing_period_start, queue_position, transaction_id)
      VALUES ($address, $thaw_index, $amount, $status, $thawing_period_start, $queue_position, $transaction_id)
    `),
    txCount: db.prepare('SELECT COUNT(*) as count FROM transactions'),
    addressCount: db.prepare('SELECT COUNT(*) as count FROM eligible_addresses'),
    fetchedCount: db.prepare('SELECT COUNT(*) as count FROM eligible_addresses WHERE schedule_fetched_at IS NOT NULL'),
    errorCount: db.prepare(
      "SELECT COUNT(*) as count FROM eligible_addresses WHERE schedule_error IS NOT NULL AND schedule_error != 'not-eligible'",
    ),
    lastBlock: db.prepare('SELECT MAX(block_num) as block_num FROM transactions'),
    allAddressesWithSchedules: db.prepare(`
      SELECT
        e.address,
        e.total_night_received,
        e.tx_count,
        e.first_seen_block,
        e.schedule_fetched_at,
        e.schedule_error
      FROM eligible_addresses e
      WHERE e.schedule_fetched_at IS NOT NULL
      ORDER BY CAST(e.total_night_received AS INTEGER) DESC
    `),
    thawsForAddress: db.prepare('SELECT * FROM thaw_schedule WHERE address = $address ORDER BY thaw_index'),
    nightOutputsForAddress: db.prepare(`
      SELECT no.*, t.block_num, t.time, t.valid_contract
      FROM night_outputs no
      JOIN transactions t ON no.tx_hash = t.hash
      WHERE no.address = $address
      ORDER BY t.block_num
    `),
    totalNightDistributed: db.prepare(`
      SELECT CAST(SUM(CAST(night_amount AS INTEGER)) AS TEXT) as total
      FROM night_outputs
      JOIN transactions ON night_outputs.tx_hash = transactions.hash
      WHERE transactions.valid_contract = 1
    `),
    insertRedeemTx: db.prepare(`
      INSERT OR IGNORE INTO redeem_txs (
        tx_hash, eligible_address, escrow_address, funding_address,
        night_to_eligible, night_to_escrow, night_to_treasury,
        funding_ada, funding_has_tokens, funding_token_count, funding_tokens_json,
        input_count
      ) VALUES (
        $tx_hash, $eligible_address, $escrow_address, $funding_address,
        $night_to_eligible, $night_to_escrow, $night_to_treasury,
        $funding_ada, $funding_has_tokens, $funding_token_count, $funding_tokens_json,
        $input_count
      )
    `),
    redeemTxForEligible: db.prepare(`
      SELECT r.* FROM redeem_txs r
      JOIN transactions t ON r.tx_hash = t.hash
      WHERE r.eligible_address = $address AND t.valid_contract = 1
      ORDER BY t.block_num, t.tx_ordinal
    `),
    redeemTxCount: db.prepare('SELECT COUNT(*) as count FROM redeem_txs'),
    dirtyFundingCount: db.prepare('SELECT COUNT(*) as count FROM redeem_txs WHERE funding_has_tokens = 1'),
    insertEscrow: db.prepare(`
      INSERT OR IGNORE INTO escrow_addresses (escrow_address, eligible_address, first_seen_tx)
      VALUES ($escrow_address, $eligible_address, $first_seen_tx)
    `),
    getUnsyncedEscrows: db.prepare(`
      SELECT escrow_address, GROUP_CONCAT(eligible_address) as eligible_addresses
      FROM escrow_addresses
      WHERE escrow_synced_at IS NULL
      GROUP BY escrow_address
      ORDER BY escrow_address
    `),
    markEscrowSynced: db.prepare(
      'UPDATE escrow_addresses SET escrow_synced_at = $synced_at WHERE escrow_address = $escrow_address',
    ),
    insertEscrowTx: db.prepare(`
      INSERT OR IGNORE INTO escrow_txs (tx_hash, escrow_address, eligible_address, block_num, time, night_to_eligible, night_to_escrow)
      VALUES ($tx_hash, $escrow_address, $eligible_address, $block_num, $time, $night_to_eligible, $night_to_escrow)
    `),
    escrowCount: db.prepare('SELECT COUNT(DISTINCT escrow_address) as count FROM escrow_addresses'),
    escrowSyncedCount: db.prepare(
      'SELECT COUNT(DISTINCT escrow_address) as count FROM escrow_addresses WHERE escrow_synced_at IS NOT NULL',
    ),
    escrowTxsForEligible: db.prepare(`
      SELECT e.* FROM escrow_txs e
      JOIN transactions t ON e.tx_hash = t.hash
      WHERE e.eligible_address = $address AND t.valid_contract = 1
      ORDER BY e.block_num
    `),
    getEscrowForEligible: db.prepare('SELECT escrow_address FROM escrow_addresses WHERE eligible_address = $address'),
    allOnChainTxsForAddress: db.prepare(`
      SELECT tx_hash, block_num, 'treasury' as source FROM night_outputs
        JOIN transactions ON night_outputs.tx_hash = transactions.hash
        WHERE night_outputs.address = $address AND transactions.valid_contract = 1
      UNION ALL
      SELECT e.tx_hash, e.block_num, 'escrow' as source FROM escrow_txs e
        JOIN transactions t ON e.tx_hash = t.hash
        WHERE e.eligible_address = $address AND e.night_to_eligible IS NOT NULL AND t.valid_contract = 1
      ORDER BY block_num
    `),
    invalidContractCount: db.prepare(
      'SELECT COUNT(*) as count FROM redeem_txs r JOIN transactions t ON r.tx_hash = t.hash WHERE t.valid_contract = 0',
    ),
    sharedEscrowCount: db.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT escrow_address FROM escrow_addresses GROUP BY escrow_address HAVING COUNT(*) > 1
      )
    `),
    sharedEscrowAddressCount: db.prepare(`
      SELECT COUNT(*) as count FROM escrow_addresses
      WHERE escrow_address IN (SELECT escrow_address FROM escrow_addresses GROUP BY escrow_address HAVING COUNT(*) > 1)
    `),
    notEligibleCount: db.prepare(
      "SELECT COUNT(*) as count FROM eligible_addresses WHERE schedule_error = 'not-eligible'",
    ),
    schedulesWithThawsCount: db.prepare('SELECT COUNT(DISTINCT address) as count FROM thaw_schedule'),
  }

  return {
    close: () => db.close(),

    insertTransaction: (tx: {
      hash: string
      block_num: number | null
      block_hash: string | null
      time: string | null
      tx_ordinal: number
      valid_contract: boolean
    }) => {
      stmts.insertTx.run({
        $hash: tx.hash,
        $block_num: tx.block_num,
        $block_hash: tx.block_hash,
        $time: tx.time,
        $tx_ordinal: tx.tx_ordinal,
        $valid_contract: tx.valid_contract ? 1 : 0,
      })
    },

    insertNightOutput: (output: {
      tx_hash: string
      output_index: number
      address: string
      ada_amount: string
      night_amount: string
    }) => {
      stmts.insertNightOutput.run({
        $tx_hash: output.tx_hash,
        $output_index: output.output_index,
        $address: output.address,
        $ada_amount: output.ada_amount,
        $night_amount: output.night_amount,
      })
    },

    upsertEligibleAddress: (addr: {address: string; night_amount: string; block_num: number | null}) => {
      stmts.upsertEligibleAddress.run({
        $address: addr.address,
        $night_amount: addr.night_amount,
        $block_num: addr.block_num,
      })
    },

    getSyncState: (key: string): string | undefined => {
      const row = stmts.getSyncState.get({$key: key}) as {value: string} | null
      return row?.value
    },

    setSyncState: (key: string, value: string) => {
      stmts.setSyncState.run({$key: key, $value: value})
    },

    getUnfetchedAddresses: (): string[] => {
      return (stmts.getUnfetchedAddresses.all() as {address: string}[]).map((r) => r.address)
    },

    markScheduleFetched: (address: string, error: string | null, claimedAllocations?: number) => {
      stmts.markScheduleFetched.run({
        $address: address,
        $fetched_at: new Date().toISOString(),
        $error: error,
        $claimed: claimedAllocations ?? null,
      })
    },

    insertThawSchedule: (address: string, thaws: readonly ThawRow[]) => {
      stmts.clearThawSchedule.run({$address: address})
      for (const thaw of thaws) {
        stmts.insertThaw.run({
          $address: address,
          $thaw_index: thaw.thaw_index,
          $amount: thaw.amount,
          $status: thaw.status,
          $thawing_period_start: thaw.thawing_period_start,
          $queue_position: thaw.queue_position ?? null,
          $transaction_id: thaw.transaction_id ?? null,
        })
      }
    },

    getStats: () => ({
      txCount: (stmts.txCount.get() as {count: number}).count,
      addressCount: (stmts.addressCount.get() as {count: number}).count,
      fetchedCount: (stmts.fetchedCount.get() as {count: number}).count,
      errorCount: (stmts.errorCount.get() as {count: number}).count,
      lastBlock: (stmts.lastBlock.get() as {block_num: number | null}).block_num,
    }),

    getAllAddressesWithSchedules: () =>
      stmts.allAddressesWithSchedules.all() as {
        address: string
        total_night_received: string
        tx_count: number
        first_seen_block: number | null
        schedule_fetched_at: string | null
        schedule_error: string | null
      }[],

    getThawsForAddress: (address: string) => stmts.thawsForAddress.all({$address: address}) as StoredThaw[],

    getNightOutputsForAddress: (address: string) =>
      stmts.nightOutputsForAddress.all({$address: address}) as {
        tx_hash: string
        output_index: number
        address: string
        ada_amount: string
        night_amount: string
        block_num: number
        time: string
        valid_contract: number
      }[],

    getTotalNightDistributed: (): bigint => {
      const row = stmts.totalNightDistributed.get() as {total: string | null}
      return BigInt(row.total ?? '0')
    },

    insertRedeemTx: (tx: {
      tx_hash: string
      eligible_address: string
      escrow_address: string
      funding_address: string
      night_to_eligible: string | null
      night_to_escrow: string | null
      night_to_treasury: string | null
      funding_ada: string
      funding_has_tokens: boolean
      funding_token_count: number
      funding_tokens_json: string | null
      input_count: number
    }) => {
      stmts.insertRedeemTx.run({
        $tx_hash: tx.tx_hash,
        $eligible_address: tx.eligible_address,
        $escrow_address: tx.escrow_address,
        $funding_address: tx.funding_address,
        $night_to_eligible: tx.night_to_eligible,
        $night_to_escrow: tx.night_to_escrow,
        $night_to_treasury: tx.night_to_treasury,
        $funding_ada: tx.funding_ada,
        $funding_has_tokens: tx.funding_has_tokens ? 1 : 0,
        $funding_token_count: tx.funding_token_count,
        $funding_tokens_json: tx.funding_tokens_json,
        $input_count: tx.input_count,
      })
    },

    getRedeemTxsForEligible: (address: string) =>
      stmts.redeemTxForEligible.all({$address: address}) as StoredRedeemTx[],

    getRedeemStats: () => ({
      total: (stmts.redeemTxCount.get() as {count: number}).count,
      dirtyFunding: (stmts.dirtyFundingCount.get() as {count: number}).count,
      invalidContract: (stmts.invalidContractCount.get() as {count: number}).count,
    }),

    getReportStats: () => ({
      sharedEscrows: (stmts.sharedEscrowCount.get() as {count: number}).count,
      sharedEscrowAddresses: (stmts.sharedEscrowAddressCount.get() as {count: number}).count,
      notEligible: (stmts.notEligibleCount.get() as {count: number}).count,
      schedulesWithThaws: (stmts.schedulesWithThawsCount.get() as {count: number}).count,
    }),

    insertEscrow: (escrowAddress: string, eligibleAddress: string, firstSeenTx: string) => {
      stmts.insertEscrow.run({
        $escrow_address: escrowAddress,
        $eligible_address: eligibleAddress,
        $first_seen_tx: firstSeenTx,
      })
    },

    getUnsyncedEscrows: (): {escrow_address: string; eligible_addresses: string[]}[] =>
      (stmts.getUnsyncedEscrows.all() as {escrow_address: string; eligible_addresses: string}[]).map((r) => ({
        escrow_address: r.escrow_address,
        eligible_addresses: r.eligible_addresses.split(','),
      })),

    markEscrowSynced: (escrowAddress: string) => {
      stmts.markEscrowSynced.run({
        $escrow_address: escrowAddress,
        $synced_at: new Date().toISOString(),
      })
    },

    insertEscrowTx: (tx: {
      tx_hash: string
      escrow_address: string
      eligible_address: string
      block_num: number | null
      time: string | null
      night_to_eligible: string | null
      night_to_escrow: string | null
    }) => {
      stmts.insertEscrowTx.run({
        $tx_hash: tx.tx_hash,
        $escrow_address: tx.escrow_address,
        $eligible_address: tx.eligible_address,
        $block_num: tx.block_num,
        $time: tx.time,
        $night_to_eligible: tx.night_to_eligible,
        $night_to_escrow: tx.night_to_escrow,
      })
    },

    getEscrowStats: () => ({
      total: (stmts.escrowCount.get() as {count: number}).count,
      synced: (stmts.escrowSyncedCount.get() as {count: number}).count,
    }),

    getEscrowTxsForEligible: (address: string) =>
      stmts.escrowTxsForEligible.all({$address: address}) as {
        tx_hash: string
        escrow_address: string
        eligible_address: string
        block_num: number | null
        time: string | null
        night_to_eligible: string | null
        night_to_escrow: string | null
      }[],

    getEscrowForEligible: (address: string): string | undefined => {
      const row = stmts.getEscrowForEligible.get({$address: address}) as {escrow_address: string} | null
      return row?.escrow_address
    },

    getAllOnChainTxsForAddress: (address: string) =>
      stmts.allOnChainTxsForAddress.all({$address: address}) as {
        tx_hash: string
        block_num: number | null
        source: 'treasury' | 'escrow'
      }[],

    transaction: <T>(fn: () => T): T => db.transaction(fn)(),

    /** Raw query access for ad-hoc report queries */
    rawQuery: (sql: string) => db.prepare(sql),
  }
}

export type ThawRow = {
  thaw_index: number
  amount: string
  status: string
  thawing_period_start: string
  queue_position?: number
  transaction_id?: string
}

export type StoredRedeemTx = {
  tx_hash: string
  eligible_address: string
  escrow_address: string
  funding_address: string
  night_to_eligible: string | null
  night_to_escrow: string | null
  night_to_treasury: string | null
  funding_ada: string
  funding_has_tokens: number
  funding_token_count: number
  funding_tokens_json: string | null
  input_count: number
}

export type StoredThaw = {
  address: string
  thaw_index: number
  amount: string
  status: string
  thawing_period_start: string
  queue_position: number | null
  transaction_id: string | null
}
