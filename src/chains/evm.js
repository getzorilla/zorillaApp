import { createPublicClient, fallback, http, isAddress, getAddress, formatEther, formatUnits } from 'viem'
import { mainnet, sepolia } from 'viem/chains'

// Free endpoints rate limit constantly, so every network carries several and
// viem falls through them in order. A saved RPC key goes to the front.
export const CHAINS = {
  ethereum: {
    label: 'Ethereum',
    chain: mainnet,
    // Ordered by what they actually answer. The first three serve eth_getLogs
    // to anonymous callers, which most free endpoints do not: publicnode calls
    // it an archive request, ankr wants a key, cloudflare refuses outright.
    rpcs: [
      'https://rpc.mevblocker.io',
      'https://gateway.tenderly.co/public/mainnet',
      'https://rpc.flashbots.net',
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
    ],
  },
  sepolia: {
    label: 'Sepolia (test network)',
    chain: sepolia,
    rpcs: [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://gateway.tenderly.co/public/sepolia',
      'https://sepolia.gateway.tenderly.co',
    ],
  },
}

export const CHAIN_OPTIONS = Object.entries(CHAINS).map(([value, entry]) => ({ value, label: entry.label }))

const clients = new Map()

export function clientFor(key, rpcUrl = '') {
  const entry = CHAINS[key]
  if (!entry) throw new Error(`"${key}" is not a network zorilla knows. Pick one from the list.`)
  const cacheKey = `${key}|${rpcUrl}`
  if (!clients.has(cacheKey)) {
    const urls = [rpcUrl, ...entry.rpcs].filter(Boolean)
    clients.set(cacheKey, createPublicClient({
      chain: entry.chain,
      transport: fallback(urls.map((url) => http(url, { timeout: 15_000, retryCount: 1 }))),
    }))
  }
  return clients.get(cacheKey)
}

// Reads the RPC URL off a saved key, if the step was given one.
export function rpcFrom(creds, name) {
  if (!name) return ''
  return String(creds?.[name]?.url ?? '').trim()
}

// Accepts a plain address or an ENS name, and always hands back a checksummed
// address. Mixing the two up is the most common way a read silently returns
// nothing useful.
export async function toAddress(client, value, what = 'address') {
  const input = String(value ?? '').trim()
  if (!input) throw new Error(`No ${what} was given.`)
  if (isAddress(input)) return getAddress(input)
  if (input.includes('.')) {
    // A lookup that failed and a name that points nowhere are different
    // problems, and blaming the name for a dead endpoint sends people looking
    // in the wrong place.
    let resolved
    try {
      resolved = await client.getEnsAddress({ name: input })
    } catch (err) {
      throw new Error(`Could not look up "${input}": ${err.shortMessage ?? err.message}. That is the endpoint, not the name.`)
    }
    if (!resolved) {
      const onMainnet = client.chain?.id === 1
      throw new Error(onMainnet
        ? `"${input}" does not point at any wallet.`
        : `"${input}" does not point at any wallet here. ENS lives on Ethereum, and a test network has its own unrelated registry.`)
    }
    return getAddress(resolved)
  }
  throw new Error(`"${input}" is not a wallet address or an ENS name. Addresses start with 0x and are 42 characters long.`)
}

// Amounts are integers on chain and must stay that way. Every number that
// leaves a step goes out as a string: JSON cannot carry a BigInt, and a float
// would quietly lose the smallest units of somebody's balance.
export function amount(raw, decimals) {
  return { raw: raw.toString(), amount: formatUnits(raw, decimals), decimals }
}

export function ether(wei) {
  return { wei: wei.toString(), eth: formatEther(wei) }
}
