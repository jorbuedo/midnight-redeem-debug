/**
 * Treasury address that distributes NIGHT tokens
 */
export const TREASURY_ADDRESS = 'addr1wxgp2xvmvh0lrfdeu2q3jtqp2lprej6hjvgjx2u5lcwqxlqfvty7h'

/**
 * NIGHT token policy ID and asset name
 */
export const NIGHT_POLICY_ID = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa'
export const NIGHT_ASSET_NAME_HEX = '4e49474854'
export const NIGHT_ASSET_ID = `${NIGHT_POLICY_ID}.${NIGHT_ASSET_NAME_HEX}`

/**
 * Yoroi mainnet API base URL
 */
export const YOROI_API_BASE = 'https://api.yoroiwallet.com'

/**
 * Default rate limit between schedule API calls (ms)
 */
export const DEFAULT_RATE_LIMIT_MS = 750

/**
 * Transaction page size for Yoroi API
 */
export const TX_PAGE_SIZE = 50

/**
 * NIGHT token decimals
 */
export const NIGHT_DECIMALS = 6

export const formatNight = (amount: bigint): string => {
  const whole = amount / BigInt(10 ** NIGHT_DECIMALS)
  const frac = amount % BigInt(10 ** NIGHT_DECIMALS)
  return `${whole.toLocaleString()}.${frac.toString().padStart(NIGHT_DECIMALS, '0')}`
}
