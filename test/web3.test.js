import test from 'node:test'
import assert from 'node:assert/strict'
import { coerce, buildCall } from '../src/nodes/web3.js'
import { amount, ether, toAddress, CHAINS } from '../src/chains/evm.js'
import { fileURLToPath } from 'node:url'

// Everything here is offline on purpose. Reads against a live network belong in
// a smoke test, not in a suite that has to pass on a plane.

test('token amounts use the token decimals and never a float', () => {
  // 37.192124 USDC, which has 6 decimals, not 18
  assert.deepEqual(amount(37192124n, 6), { raw: '37192124', amount: '37.192124', decimals: 6 })
  // a balance too large for a JS number still comes out exact
  assert.equal(amount(2n ** 80n, 18).raw, '1208925819614629174706176')
  assert.deepEqual(ether(6712150161831460931n), { wei: '6712150161831460931', eth: '6.712150161831460931' })
})

test('a wrong-looking address is refused with an explanation', async () => {
  await assert.rejects(
    () => toAddress(null, 'not-an-address'),
    /not a wallet address or an ENS name/
  )
  await assert.rejects(() => toAddress(null, '', 'wallet'), /No wallet was given/)
})

test('an address is returned checksummed', async () => {
  assert.equal(
    await toAddress(null, '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'),
    '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
  )
})

test('values are converted to the types the function actually takes', () => {
  assert.equal(coerce('1000000', 'uint256', 'Amount'), 1000000n)
  assert.equal(coerce('true', 'bool', 'Flag'), true)
  assert.equal(
    coerce('0xd8da6bf26964af9d7eed9e03e53415d37aa96045', 'address', 'To'),
    '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
  )
  assert.throws(() => coerce('12.5', 'uint256', 'Amount'), /takes a whole number/)
  assert.throws(() => coerce('0xnope', 'address', 'To'), /takes a wallet or contract address/)
})

test('too few values for a function is caught before any network call', () => {
  assert.throws(
    () => buildCall('function transfer(address to, uint256 amount) returns (bool)', ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045']),
    /needs 2 values \(address, uint256\), got 1/
  )
})

test('a function line is parsed with or without the leading keyword', () => {
  const withKeyword = buildCall('function balanceOf(address) view returns (uint256)', ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'])
  const without = buildCall('balanceOf(address) view returns (uint256)', ['0xd8da6bf26964af9d7eed9e03e53415d37aa96045'])
  assert.equal(withKeyword.functionName, 'balanceOf')
  assert.equal(without.functionName, 'balanceOf')
})

test('a function line that makes no sense says so', () => {
  assert.throws(() => buildCall('give me the money', []), /could not be read/)
  assert.throws(() => buildCall('', []), /No function was given/)
})

test('every network carries more than one endpoint to fall through', () => {
  for (const [key, entry] of Object.entries(CHAINS)) {
    assert.ok(entry.rpcs.length >= 2, `${key} needs a fallback endpoint`)
    assert.ok(entry.chain.id > 0)
  }
})

test('contract events refuse a filter on an argument that is not indexed', async () => {
  const { loadNodes } = await import('../src/engine/registry.js')
  const dir = fileURLToPath(new URL('../src/nodes/', import.meta.url))
  const { nodes } = await loadNodes({ builtinDir: dir })
  const logs = nodes.get('web3.logs')

  const base = {
    chain: 'ethereum',
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    event: 'event Transfer(address indexed from, address indexed to, uint256 value)',
    blocks: 10,
    rpc: '',
  }

  // value is not indexed, so no endpoint can filter on it. Saying so beats
  // returning every transfer on the network and quietly dropping most of them.
  await assert.rejects(
    () => logs.run({ params: { ...base, match: [{ name: 'value', value: '5' }] }, creds: {}, log: () => {} }),
    /not an indexed argument/,
  )
})
