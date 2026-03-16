/**
 * Minimal Yoroi API client for treasury transaction fetching.
 * Avoids pulling chains/cardano inversify dependency tree.
 */

import {YOROI_API_BASE} from '../constants.js'

const HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
  'yoroi-version': 'chimera/1.0.0',
  'tangata-manu': 'chimera',
}

export type BestBlock = {
  readonly epoch: number
  readonly slot: number
  readonly hash: string
  readonly height: number
}

export type ApiAsset = {
  readonly assetId: string
  readonly policyId: string
  readonly name: string
  readonly amount: string
}

export type ApiOutput = {
  readonly address: string
  readonly amount: string
  readonly assets: readonly ApiAsset[]
}

export type ApiInput = {
  readonly address: string
  readonly amount: string
  readonly id: string
  readonly index: number
  readonly txHash: string
  readonly assets: readonly ApiAsset[]
}

export type ApiTransaction = {
  readonly hash: string
  readonly tx_ordinal: number
  readonly block_num: number | null
  readonly block_hash: string | null
  readonly time: string | null
  readonly valid_contract?: boolean
  readonly inputs: readonly ApiInput[]
  readonly outputs: readonly ApiOutput[]
}

export type TxHistoryCursor = {
  readonly block: string
  readonly tx: string
}

export const bestBlock = async (baseUrl = YOROI_API_BASE): Promise<BestBlock> => {
  const res = await fetch(`${baseUrl}/v2/bestblock`, {headers: HEADERS})
  if (!res.ok) throw new Error(`bestBlock failed: HTTP ${res.status}`)
  return res.json() as Promise<BestBlock>
}

export const txHistory = async (
  addresses: readonly string[],
  untilBlock: string,
  after?: TxHistoryCursor,
  limit = 50,
  baseUrl = YOROI_API_BASE,
): Promise<readonly ApiTransaction[]> => {
  const body: Record<string, unknown> = {addresses: [...addresses], untilBlock, limit}
  if (after) body.after = after
  const res = await fetch(`${baseUrl}/v2/txs/history`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`txHistory failed: HTTP ${res.status}`)
  return res.json() as Promise<readonly ApiTransaction[]>
}
