import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execute } from '../src/engine/execute.js'
import { loadNodes } from '../src/engine/registry.js'
import { Memory } from '../src/storage/memory.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const { nodes } = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })

const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } })
const edge = (from, to) => ({ from, to, fromPort: 'main', toPort: 'main' })

async function freshMemory() {
  return Memory.open(path.join('/tmp', `zorilla-mem-${randomBytes(4).toString('hex')}`))
}

// Feeds one price in and reports whether an alert would have gone out.
function priceGraph(watch = '{{ $json.usd > 4000 }}') {
  return {
    id: 'wf1',
    nodes: [
      node('t', 'core.manual'),
      node('watch', 'logic.changed', { value: watch, direction: 'becomesTrue', key: '' }),
      node('alert', 'output.log', { message: 'ETH is {{ $json.usd }}' }),
    ],
    edges: [edge('t', 'watch'), edge('watch', 'alert')],
  }
}

const priced = (usd) => ({ nodeId: 't', items: [{ json: { usd } }] })

test('an alert fires on the way over the line and stays quiet above it', async () => {
  const memory = await freshMemory()
  const memoryFor = (nodeId) => memory.scope('wf1', nodeId)
  const run = (usd) => execute({ nodes, graph: priceGraph(), memoryFor, trigger: priced(usd) })

  const first = await run(4200)
  assert.equal(first.nodes.alert.status, 'ok', 'already over the line on the first run, so say so once')

  const second = await run(4300)
  assert.equal(second.nodes.alert.status, 'skipped', 'still over: nothing sent')

  const third = await run(4900)
  assert.equal(third.nodes.alert.status, 'skipped')

  const dropped = await run(3900)
  assert.equal(dropped.nodes.alert.status, 'skipped', 'falling back under is not an alert')

  const again = await run(4100)
  assert.equal(again.nodes.alert.status, 'ok', 'crossing again is')
})

test('a workflow that starts under the line stays silent until it crosses', async () => {
  const memory = await freshMemory()
  const memoryFor = (nodeId) => memory.scope('wf1', nodeId)
  const run = (usd) => execute({ nodes, graph: priceGraph(), memoryFor, trigger: priced(usd) })

  assert.equal((await run(2490)).nodes.alert.status, 'skipped')
  assert.equal((await run(2600)).nodes.alert.status, 'skipped')
  assert.equal((await run(4001)).nodes.alert.status, 'ok')
})

test('what a step remembers survives a restart', async () => {
  const dir = path.join('/tmp', `zorilla-mem-${randomBytes(4).toString('hex')}`)
  const first = await Memory.open(dir)
  await execute({ nodes, graph: priceGraph(), memoryFor: (id) => first.scope('wf1', id), trigger: priced(4200) })

  // a second Memory over the same directory is what a restarted server sees
  const reopened = await Memory.open(dir)
  const run = await execute({ nodes, graph: priceGraph(), memoryFor: (id) => reopened.scope('wf1', id), trigger: priced(4300) })
  assert.equal(run.nodes.alert.status, 'skipped', 'a restart must not re-announce what was already sent')
})

test('two wallets tracked separately do not silence each other', async () => {
  const memory = await freshMemory()
  const memoryFor = (nodeId) => memory.scope('wf1', nodeId)
  const graph = {
    id: 'wf1',
    nodes: [
      node('t', 'core.manual'),
      node('watch', 'logic.changed', { value: '{{ $json.low }}', direction: 'becomesTrue', key: '{{ $json.wallet }}' }),
      node('alert', 'output.log', { message: '{{ $json.wallet }} is low' }),
    ],
    edges: [edge('t', 'watch'), edge('watch', 'alert')],
  }
  const run = (items) => execute({ nodes, graph, memoryFor, trigger: { nodeId: 't', items } })

  const first = await run([{ json: { wallet: 'a', low: true } }, { json: { wallet: 'b', low: false } }])
  assert.deepEqual(first.nodes.alert.logs.map((l) => l.message), ['a is low'])

  const second = await run([{ json: { wallet: 'a', low: true } }, { json: { wallet: 'b', low: true } }])
  assert.deepEqual(second.nodes.alert.logs.map((l) => l.message), ['b is low'], 'a was already reported, b just crossed')
})

test('only the first time means only the first time', async () => {
  const memory = await freshMemory()
  const memoryFor = (nodeId) => memory.scope('wf1', nodeId)
  const graph = {
    id: 'wf1',
    nodes: [node('t', 'core.manual'), node('gate', 'logic.once', { key: '' }), node('after', 'output.log', { message: 'ran' })],
    edges: [edge('t', 'gate'), edge('gate', 'after')],
  }
  assert.equal((await execute({ nodes, graph, memoryFor })).nodes.after.status, 'ok')
  assert.equal((await execute({ nodes, graph, memoryFor })).nodes.after.status, 'skipped')
  assert.equal((await execute({ nodes, graph, memoryFor })).nodes.after.status, 'skipped')
})

test('a step can switch its own workflow off once it is done', async () => {
  const memory = await freshMemory()
  const run = await execute({
    nodes,
    memoryFor: (id) => memory.scope('wf1', id),
    graph: {
      id: 'wf1',
      nodes: [node('t', 'core.manual'), node('done', 'flow.stop', { reason: 'Alert sent' })],
      edges: [edge('t', 'done')],
    },
  })
  assert.equal(run.stopRequested, true)
  assert.equal(run.stopReason, 'Alert sent')
  assert.equal(run.status, 'ok')
})

test('forgetting makes the next run behave like a first run', async () => {
  const memory = await freshMemory()
  const memoryFor = (nodeId) => memory.scope('wf1', nodeId)
  const graph = {
    id: 'wf1',
    nodes: [
      node('t', 'core.manual'),
      node('watch', 'logic.changed', { value: '{{ $json.usd > 4000 }}', direction: 'becomesTrue', key: '' }),
      node('alert', 'output.log', { message: 'over' }),
    ],
    edges: [edge('t', 'watch'), edge('watch', 'alert')],
  }
  assert.equal((await execute({ nodes, graph, memoryFor, trigger: priced(4200) })).nodes.alert.status, 'ok')
  assert.equal((await execute({ nodes, graph, memoryFor, trigger: priced(4200) })).nodes.alert.status, 'skipped')

  await memory.scope('wf1', 'watch').remove('value')
  assert.equal((await execute({ nodes, graph, memoryFor, trigger: priced(4200) })).nodes.alert.status, 'ok')
})
