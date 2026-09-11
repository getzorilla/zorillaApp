import { parseAbi, parseAbiItem, getAddress, isAddress, formatEther, formatGwei, parseEther } from 'viem'
import { CHAINS, CHAIN_OPTIONS, clientFor, rpcFrom, toAddress, amount, ether } from '../chains/evm.js'

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
])

const chainParam = {
  key: 'chain', label: 'Network', type: 'select', default: 'ethereum', options: CHAIN_OPTIONS,
}
const rpcParam = {
  key: 'rpc', label: 'RPC endpoint', type: 'credential', credentialType: 'evmRpc', default: '', required: false,
  description: 'Optional. Public endpoints rate limit.',
}

// JSON cannot carry a BigInt, and turning one into a float would lose the
// smallest units of a balance. Everything integer leaves as a string.
function plain(value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(plain)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]))
  }
  return value
}

export function coerce(value, type, label) {
  const raw = typeof value === 'string' ? value.trim() : value
  if (type.endsWith(']')) {
    try {
      return JSON.parse(raw)
    } catch {
      throw new Error(`${label} takes a list, written like ["a","b"].`)
    }
  }
  if (type.startsWith('uint') || type.startsWith('int')) {
    try {
      return BigInt(raw)
    } catch {
      throw new Error(`${label} takes a whole number. "${raw}" is not one.`)
    }
  }
  if (type === 'bool') return raw === true || String(raw).toLowerCase() === 'true'
  if (type === 'address') {
    if (!isAddress(String(raw))) throw new Error(`${label} takes a wallet or contract address. "${raw}" is not one.`)
    return getAddress(String(raw))
  }
  return raw
}

export function buildCall(signature, args) {
  const text = String(signature ?? '').trim()
  if (!text) throw new Error('No function was given. Paste one like: function balanceOf(address) view returns (uint256)')
  let item
  try {
    item = parseAbiItem(text.startsWith('function') ? text : `function ${text}`)
  } catch (err) {
    throw new Error(`That function line could not be read: ${err.shortMessage ?? err.message}`)
  }
  const given = (args ?? []).filter((a) => String(a ?? '').trim() !== '')
  if (given.length !== item.inputs.length) {
    const wanted = item.inputs.map((i) => i.type).join(', ')
    throw new Error(`${item.name} needs ${item.inputs.length} value${item.inputs.length === 1 ? '' : 's'} (${wanted || 'none'}), got ${given.length}.`)
  }
  return {
    abi: [item],
    functionName: item.name,
    args: item.inputs.map((input, i) => coerce(given[i], input.type, input.name || `Value ${i + 1}`)),
  }
}

const balance = {
  type: 'web3.balance',
  hands: ['chain', 'address', 'wei', 'eth'],
  label: 'ETH balance',
  category: 'web3',
  description: 'How much ETH a wallet holds.',
  params: [
    chainParam,
    { key: 'address', label: 'Wallet or ENS name', type: 'text', default: '', placeholder: 'vitalik.eth' },
    rpcParam,
  ],
  async run({ params, creds }) {
    const client = clientFor(params.chain, rpcFrom(creds, params.rpc))
    const address = await toAddress(client, params.address, 'wallet')
    const wei = await client.getBalance({ address })
    return [{ json: { chain: params.chain, address, ...ether(wei) } }]
  },
}

const erc20 = {
  type: 'web3.erc20Balance',
  hands: ['chain', 'token', 'symbol', 'address', 'raw', 'amount', 'decimals'],
  label: 'Token balance',
  category: 'web3',
  description: 'How much of one token a wallet holds.',
  params: [
    chainParam,
    { key: 'token', label: 'Token contract', type: 'text', default: '', placeholder: '0xA0b8…eB48 (USDC)' },
    { key: 'address', label: 'Wallet or ENS name', type: 'text', default: '', placeholder: 'vitalik.eth' },
    rpcParam,
  ],
  async run({ params, creds }) {
    const client = clientFor(params.chain, rpcFrom(creds, params.rpc))
    const token = await toAddress(client, params.token, 'token contract')
    const address = await toAddress(client, params.address, 'wallet')

    // the token's own decimals, never assumed to be 18
    const [raw, decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [address] }),
      client.readContract({ address: token, abi: ERC20, functionName: 'decimals' }),
      client.readContract({ address: token, abi: ERC20, functionName: 'symbol' }).catch(() => '?'),
    ]).catch((err) => {
      throw new Error(`${token} did not answer like a token contract. Check the address is the token, not the wallet. (${err.shortMessage ?? err.message})`)
    })

    return [{ json: { chain: params.chain, token, symbol, address, ...amount(raw, decimals) } }]
  },
}

const read = {
  type: 'web3.read',
  hands: ['chain', 'address', 'function', 'result'],
  label: 'Read from a contract',
  category: 'web3',
  description: 'Asks a contract a question.',
  params: [
    chainParam,
    { key: 'address', label: 'Contract address', type: 'text', default: '' },
    { key: 'signature', label: 'Function', type: 'text', default: '',
      placeholder: 'function balanceOf(address) view returns (uint256)' },
    { key: 'args', label: 'Values', type: 'list', default: [],
      description: 'In the order the function takes them.' },
    rpcParam,
  ],
  async run({ params, creds }) {
    const client = clientFor(params.chain, rpcFrom(creds, params.rpc))
    const address = await toAddress(client, params.address, 'contract')
    const call = buildCall(params.signature, params.args)
    let result
    try {
      result = await client.readContract({ address, ...call })
    } catch (err) {
      throw new Error(`${call.functionName} failed on ${address}: ${err.shortMessage ?? err.message}`)
    }
    return [{ json: { chain: params.chain, address, function: call.functionName, result: plain(result) } }]
  },
}

const logs = {
  type: 'web3.logs',
  label: 'Contract events',
  category: 'web3',
  description: 'Recent events from a contract. One item each.',
  params: [
    chainParam,
    { key: 'address', label: 'Contract address', type: 'text', default: '' },
    { key: 'event', label: 'Event', type: 'text', default: '',
      placeholder: 'event Transfer(address indexed from, address indexed to, uint256 value)' },
    { key: 'match', label: 'Only where', type: 'keyvalue', default: [],
      description: 'An indexed argument and the value to match. to = your wallet gives you only transfers that landed there. Without this a busy token returns every transfer on the network.' },
    { key: 'blocks', label: 'Recent blocks', type: 'number', default: 1000, min: 1,
      description: 'Public endpoints cap this. A few thousand is the ceiling.' },
    rpcParam,
  ],
  async run({ params, creds, log }) {
    const client = clientFor(params.chain, rpcFrom(creds, params.rpc))
    const address = await toAddress(client, params.address, 'contract')
    const text = String(params.event ?? '').trim()
    if (!text) throw new Error('No event was given. Paste one like: event Transfer(address indexed from, address indexed to, uint256 value)')

    let item
    try {
      item = parseAbiItem(text.startsWith('event') ? text : `event ${text}`)
    } catch (err) {
      throw new Error(`That event line could not be read: ${err.shortMessage ?? err.message}`)
    }

    // Matching on an indexed argument happens at the endpoint, not here. A
    // popular token moves a hundred times a block, so filtering afterwards
    // means asking for a hundred thousand events to keep three.
    const indexed = new Set(item.inputs.filter((i) => i.indexed).map((i) => i.name))
    const args = {}
    for (const row of params.match ?? []) {
      const name = String(row.name ?? '').trim()
      const value = String(row.value ?? '').trim()
      if (!name || !value) continue
      if (!indexed.has(name)) {
        throw new Error(`"${name}" is not an indexed argument of this event. Only ${[...indexed].join(', ') || 'none of them'} can be matched.`)
      }
      args[name] = /^0x[0-9a-fA-F]{40}$/.test(value) ? getAddress(value) : value
    }

    const latest = await client.getBlockNumber()
    const span = BigInt(Math.max(1, Number(params.blocks) || 1000))
    const fromBlock = latest > span ? latest - span : 0n

    let found
    try {
      found = await client.getLogs({
        address,
        event: item,
        fromBlock,
        toBlock: latest,
        ...(Object.keys(args).length ? { args } : {}),
      })
    } catch (err) {
      // endpoints usually say how wide a window they will serve; passing that
      // straight on beats making somebody guess
      const hint = err.details ?? err.shortMessage ?? err.message ?? ''
      const range = /\[(0x[0-9a-fA-F]+), *(0x[0-9a-fA-F]+)\]/.exec(hint)
      if (range) {
        const width = Number(BigInt(range[2]) - BigInt(range[1]))
        throw new Error(`That is more than this endpoint will answer at once. Ask for about ${width} blocks instead, or narrow it with "only where".`)
      }
      if (/too many|limit|exceed/i.test(hint)) {
        throw new Error(`That asks for too much at once: ${hint}. Ask for fewer blocks, or narrow it with "only where".`)
      }
      throw new Error(`Could not read events: ${err.shortMessage ?? err.message}. Most free endpoints refuse this call. Save your own RPC endpoint under Keys and pick it here.`)
    }
    log(`${found.length} event${found.length === 1 ? '' : 's'} in blocks ${fromBlock}–${latest}`)
    return found.map((entry) => ({
      json: plain({
        chain: params.chain,
        event: item.name,
        blockNumber: entry.blockNumber,
        transactionHash: entry.transactionHash,
        args: entry.args ?? {},
      }),
    }))
  },
}

const gas = {
  type: 'web3.gas',
  hands: ['chain', 'gasPriceWei', 'gasPriceGwei', 'maxFeePerGasGwei', 'maxPriorityFeePerGasGwei'],
  label: 'Gas price',
  category: 'web3',
  description: 'What a transaction costs to send right now.',
  params: [chainParam, rpcParam],
  async run({ params, creds }) {
    const client = clientFor(params.chain, rpcFrom(creds, params.rpc))
    const [price, fees] = await Promise.all([
      client.getGasPrice(),
      client.estimateFeesPerGas().catch(() => null),
    ])
    return [{
      json: plain({
        chain: params.chain,
        gasPriceWei: price,
        gasPriceGwei: formatGwei(price),
        maxFeePerGasGwei: fees ? formatGwei(fees.maxFeePerGas) : null,
        maxPriorityFeePerGasGwei: fees ? formatGwei(fees.maxPriorityFeePerGas) : null,
      }),
    }]
  },
}

const ens = {
  type: 'web3.ens',
  hands: ['name', 'address'],
  label: 'ENS name',
  category: 'web3',
  description: 'Name to address, or back.',
  params: [
    { key: 'direction', label: 'Direction', type: 'select', default: 'resolve', options: [
      { value: 'resolve', label: 'Name to address' },
      { value: 'reverse', label: 'Address to name' },
    ] },
    { key: 'value', label: 'Name or address', type: 'text', default: '', placeholder: 'vitalik.eth' },
    rpcParam,
  ],
  async run({ params, creds }) {
    // ENS lives on Ethereum; test networks have their own unrelated registry
    const client = clientFor('ethereum', rpcFrom(creds, params.rpc))
    const input = String(params.value ?? '').trim()
    if (!input) throw new Error('Nothing to look up.')

    if (params.direction === 'reverse') {
      if (!isAddress(input)) throw new Error(`"${input}" is not an address.`)
      const name = await client.getEnsName({ address: getAddress(input) })
      return [{ json: { address: getAddress(input), name: name ?? null } }]
    }
    const address = await client.getEnsAddress({ name: input })
    if (!address) throw new Error(`"${input}" does not point at any wallet.`)
    return [{ json: { name: input, address: getAddress(address) } }]
  },
}

const prepare = {
  type: 'web3.prepare',
  label: 'Prepare transaction',
  category: 'web3',
  description: 'What a transaction would do and cost. Sends nothing.',
  params: [
    chainParam,
    { key: 'from', label: 'Send from', type: 'text', default: '', placeholder: 'your wallet address' },
    { key: 'to', label: 'Send to', type: 'text', default: '', placeholder: 'address or ENS name' },
    { key: 'value', label: 'ETH to send', type: 'text', default: '0' },
    { key: 'signature', label: 'Contract function', type: 'text', default: '',
      description: 'Leave blank to send plain ETH.',
      placeholder: 'function transfer(address, uint256) returns (bool)' },
    { key: 'args', label: 'Values', type: 'list', default: [] },
    { key: 'reason', label: 'What it is for', type: 'text', default: '',
      description: 'Shown before anyone approves it.' },
    rpcParam,
  ],
  async run({ params, creds, log }) {
    const client = clientFor(params.chain, rpcFrom(creds, params.rpc))
    const account = await toAddress(client, params.from, 'sending wallet')
    const to = await toAddress(client, params.to, 'destination')
    const value = parseEther(String(params.value || '0'))

    const intent = { chain: params.chain, chainId: CHAINS[params.chain].chain.id, account, to, value: value.toString(), reason: params.reason || '' }
    let gasLimit
    let result = null

    if (String(params.signature ?? '').trim()) {
      const call = buildCall(params.signature, params.args)
      intent.function = call.functionName
      try {
        const simulated = await client.simulateContract({ address: to, account, value, ...call })
        result = plain(simulated.result ?? null)
      } catch (err) {
        throw new Error(`This would fail if sent: ${err.shortMessage ?? err.message}`)
      }
      gasLimit = await client.estimateContractGas({ address: to, account, value, ...call }).catch(() => null)
    } else {
      gasLimit = await client.estimateGas({ account, to, value }).catch((err) => {
        throw new Error(`This would fail if sent: ${err.shortMessage ?? err.message}`)
      })
    }

    const fees = await client.estimateFeesPerGas().catch(() => null)
    const feeWei = gasLimit && fees ? gasLimit * fees.maxFeePerGas : null

    const summary = {
      ...intent,
      willSucceed: true,
      result,
      ethOut: formatEther(value),
      gasLimit: gasLimit?.toString() ?? null,
      estimatedFeeEth: feeWei ? formatEther(feeWei) : null,
      signed: false,
      sent: false,
    }
    log(`Would send ${summary.ethOut} ETH to ${to}, about ${summary.estimatedFeeEth ?? '?'} ETH in fees. Nothing has been sent.`)
    return [{ json: summary }]
  },
}

export default [balance, erc20, read, logs, gas, ens, prepare]
