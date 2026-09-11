import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '../src/engine/execute.js'
import { loadNodes } from '../src/engine/registry.js'
import { resolveValue, makeContext } from '../src/engine/expression.js'
import { makeScrubber } from '../src/vault/vault.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const { nodes } = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })

const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } })
const edge = (from, to, fromPort = 'main') => ({ from, to, fromPort, toPort: 'main' })

test('expressions keep their type when the whole string is one expression', () => {
  const ctx = makeContext({ item: { json: { n: 21 } }, index: 0, items: [] })
  assert.equal(resolveValue('{{ $json.n * 2 }}', ctx), 42)
  assert.equal(resolveValue('n is {{ $json.n }}', ctx), 'n is 21')
})

test('two expressions in one string interpolate instead of being read as one', () => {
  const ctx = makeContext({ item: { json: { a: 1, b: 'two' } }, index: 0, items: [] })
  assert.equal(resolveValue('{{ $json.a }} and {{ $json.b }}', ctx), '1 and two')
  assert.equal(resolveValue('{{ $json.a }}{{ $json.b }}', ctx), '1two')
})

test('an expression that builds an object is not cut short at its own braces', () => {
  const ctx = makeContext({ item: { json: { b: 'two' } }, index: 0, items: [] })
  assert.deepEqual(resolveValue('{{ ({ k: { n: 1 } }) }}', ctx), { k: { n: 1 } })
  assert.equal(
    resolveValue('{{ JSON.stringify({ k: 1 }) }} then {{ $json.b }}', ctx),
    '{"k":1} then two'
  )
})

test('a step cannot reach a key it did not name', async () => {
  const asked = []
  const probe = {
    type: 'test.probe',
    label: 'Probe',
    category: 'action',
    params: [{ key: 'credential', type: 'credential' }, { key: 'other', type: 'text' }],
    async run({ params, creds, auth }) {
      asked.push(Object.keys(creds))
      auth(params.other)
      return [{ json: { ok: true } }]
    },
  }
  const withProbe = new Map(nodes)
  withProbe.set(probe.type, probe)

  const run = await execute({
    nodes: withProbe,
    creds: { mine: { token: 'a' }, theirs: { token: 'b' } },
    authFor: (name) => ({ headers: { auth: name }, query: {} }),
    graph: {
      nodes: [node('t', 'core.manual'), node('p', 'test.probe', { credential: 'mine', other: 'theirs' })],
      edges: [edge('t', 'p')],
    },
  })

  assert.equal(run.status, 'failed')
  assert.match(run.nodes.p.error, /asked for a key it does not use/)
  // and what it did get held only its own
  assert.deepEqual(asked, [['mine']])
})

test('an expression cannot widen which keys a step reaches', async () => {
  const probe = {
    type: 'test.probe2',
    label: 'Probe',
    category: 'action',
    params: [{ key: 'credential', type: 'credential' }],
    async run({ params, auth }) {
      auth(params.credential)
      return [{ json: { reached: params.credential } }]
    },
  }
  const withProbe = new Map(nodes)
  withProbe.set(probe.type, probe)

  const run = await execute({
    nodes: withProbe,
    creds: { mine: { token: 'a' }, theirs: { token: 'b' } },
    authFor: (name) => ({ headers: { auth: name }, query: {} }),
    graph: {
      // the raw parameter is an expression that resolves to another key's name
      nodes: [node('t', 'core.manual'), node('p', 'test.probe2', { credential: '{{ "theirs" }}' })],
      edges: [edge('t', 'p')],
    },
  })

  assert.equal(run.status, 'failed')
  assert.match(run.nodes.p.error, /asked for a key it does not use/)
})

test('a cycle is refused before anything runs', async () => {
  const run = await execute({
    nodes,
    graph: {
      nodes: [node('a', 'core.manual'), node('b', 'output.log'), node('c', 'output.log')],
      edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
    },
  })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /feed back into each other/)
  assert.deepEqual(run.nodes, {})
})

test('If sends items down one branch and the other branch is skipped', async () => {
  const run = await execute({
    nodes,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('set', 'transform.set', { fields: [{ name: 'n', value: '{{ 5 }}' }] }),
        node('if', 'logic.if', { value: '{{ $json.n }}', operation: 'greater', compare: '3' }),
        node('yes', 'output.log', { message: 'big' }),
        node('no', 'output.log', { message: 'small' }),
      ],
      edges: [edge('t', 'set'), edge('set', 'if'), edge('if', 'yes', 'true'), edge('if', 'no', 'false')],
    },
  })
  assert.equal(run.status, 'ok')
  assert.equal(run.nodes.yes.status, 'ok')
  assert.equal(run.nodes.no.status, 'skipped')
  assert.equal(run.nodes.yes.logs[0].message, 'big')
})

test('a failing step does not stop an independent branch', async () => {
  const run = await execute({
    nodes,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('boom', 'code.js', { code: 'throw new Error("nope")' }),
        node('fine', 'output.log', { message: 'still ran' }),
      ],
      edges: [edge('t', 'boom'), edge('t', 'fine')],
    },
  })
  assert.equal(run.status, 'failed')
  assert.equal(run.nodes.boom.status, 'error')
  assert.match(run.nodes.boom.error, /nope/)
  assert.equal(run.nodes.fine.status, 'ok')
})

test('a step below a failure is skipped, not run on stale items', async () => {
  const run = await execute({
    nodes,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('boom', 'code.js', { code: 'throw new Error("nope")' }),
        node('after', 'output.log', { message: 'should not appear' }),
      ],
      edges: [edge('t', 'boom'), edge('boom', 'after')],
    },
  })
  assert.equal(run.nodes.after.status, 'skipped')
})

test('a step that returns the wrong shape fails with a readable message', async () => {
  const run = await execute({
    nodes,
    graph: {
      nodes: [node('t', 'core.manual'), node('bad', 'code.js', { code: 'return [{ notJson: 1 }]' })],
      edges: [edge('t', 'bad')],
    },
  })
  assert.equal(run.nodes.bad.status, 'error')
  assert.match(run.nodes.bad.error, /item with no json property/)
})

test('only the named trigger runs when a workflow has several', async () => {
  const run = await execute({
    nodes,
    trigger: { nodeId: 'manual' },
    graph: {
      nodes: [node('manual', 'core.manual'), node('cron', 'core.schedule')],
      edges: [],
    },
  })
  assert.equal(run.nodes.manual.status, 'ok')
  assert.equal(run.nodes.cron.status, 'skipped')
})

test('a step cannot read a key it does not use', async () => {
  const creds = { my_key: { token: 'xoxb-secret-value' } }
  const run = await execute({
    nodes,
    creds,
    graph: {
      nodes: [node('t', 'core.manual'), node('log', 'output.log', { message: 'sent {{ $creds.my_key.token }}' })],
      edges: [edge('t', 'log')],
    },
  })
  // the log step names no key, so $creds is empty for it and the expression has
  // nothing to read rather than quietly reaching into the vault
  assert.equal(run.nodes.log.status, 'error')
  assert.doesNotMatch(JSON.stringify(run), /xoxb-secret-value/)
})

test('secrets are scrubbed out of a run before it leaves the server', () => {
  const run = {
    runId: 'r1',
    nodes: { log: { status: 'ok', logs: [{ ts: 'now', message: 'sent xoxb-secret-value' }] } },
  }
  const scrubbed = makeScrubber(['xoxb-secret-value'])(run)
  assert.match(scrubbed.nodes.log.logs[0].message, /sent ••••/)
  assert.doesNotMatch(JSON.stringify(scrubbed), /xoxb-secret-value/)
})

test('expressions resolve per item across a batch', async () => {
  const run = await execute({
    nodes,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('many', 'code.js', { code: 'return [1,2,3].map(n => ({ json: { n } }))' }),
        node('double', 'transform.set', { fields: [{ name: 'doubled', value: '{{ $json.n * 2 }}' }] }),
        node('log', 'output.log', { message: '{{ $json.doubled }}' }),
      ],
      edges: [edge('t', 'many'), edge('many', 'double'), edge('double', 'log')],
    },
  })
  assert.deepEqual(run.nodes.log.logs.map((l) => l.message), ['2', '4', '6'])
})

test('a flaky step is tried again before it counts as broken', async () => {
  let calls = 0
  const flaky = {
    type: 'test.flaky', label: 'Flaky', category: 'action', outputs: ['main'],
    run({ item }) {
      calls += 1
      if (calls < 3) throw new Error('the service had a bad minute')
      return [item]
    },
  }
  const withFlaky = new Map(nodes)
  withFlaky.set('test.flaky', flaky)

  const run = await execute({
    nodes: withFlaky,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        { ...node('f', 'test.flaky'), retries: 3, retryWait: 1 },
      ],
      edges: [edge('t', 'f')],
    },
  })
  assert.equal(run.nodes.f.status, 'ok')
  assert.equal(run.nodes.f.attempts, 3)
  assert.equal(calls, 3)
})

test('a step set to branch on failure sends the error down its own wire', async () => {
  const broken = {
    type: 'test.broken', label: 'Broken', category: 'action', outputs: ['main'],
    run() { throw new Error('nope') },
  }
  const withBroken = new Map(nodes)
  withBroken.set('test.broken', broken)

  const run = await execute({
    nodes: withBroken,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        { ...node('b', 'test.broken'), onError: 'errorOutput' },
        node('tell', 'output.log', { message: 'it broke: {{ $json.error }}' }),
      ],
      edges: [edge('t', 'b'), { from: 'b', fromPort: 'error', to: 'tell', toPort: 'main' }],
    },
  })
  assert.equal(run.nodes.b.status, 'error')
  assert.equal(run.nodes.tell.status, 'ok')
  assert.match(run.nodes.tell.logs[0].message, /it broke: Broken failed: nope/)
})

test('a step set to carry on passes its items along with the error attached', async () => {
  const broken = {
    type: 'test.broken2', label: 'Broken', category: 'action', outputs: ['main'],
    run() { throw new Error('nope') },
  }
  const withBroken = new Map(nodes)
  withBroken.set('test.broken2', broken)

  const run = await execute({
    nodes: withBroken,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        { ...node('b', 'test.broken2'), onError: 'continue' },
        node('after', 'output.log', { message: 'still here' }),
      ],
      edges: [edge('t', 'b'), edge('b', 'after')],
    },
  })
  assert.equal(run.nodes.after.status, 'ok')
  assert.equal(run.status, 'failed')
})

test('a json body sent as text/plain still arrives as json', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"ok":true,"result":[{"id":1}]}', {
    status: 200,
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
  })
  try {
    const run = await execute({
      nodes,
      graph: {
        nodes: [
          node('t', 'core.manual'),
          node('get', 'net.http', { method: 'GET', url: 'https://example.com/x', headers: [], sendBody: false, timeout: 5, failOnError: true }),
          node('log', 'output.log', { message: 'first id {{ $json.body.result[0].id }}' }),
        ],
        edges: [edge('t', 'get'), edge('get', 'log')],
      },
    })
    assert.equal(run.nodes.log.status, 'ok', run.nodes.log.error)
    assert.match(run.nodes.log.logs[0].message, /first id 1/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('a move of five percent gets through and a move of one percent does not', async (t) => {
  const { Memory } = await import('../src/storage/memory.js')
  const { rm, mkdtemp } = await import('node:fs/promises')
  const os = await import('node:os')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zorilla-moved-'))
  const memory = await Memory.open(dir)
  t.after(() => rm(dir, { recursive: true, force: true }))
  const graph = (price) => ({
    nodes: [
      node('t', 'core.manual'),
      node('set', 'transform.set', { fields: [{ name: 'usd', value: String(price) }], keepOnly: true }),
      node('moved', 'logic.moved', { value: '{{ $json.usd }}', amount: 5, unit: 'percent', direction: 'either', key: '' }),
      node('say', 'output.log', { message: 'moved {{ $json.moved.percent }}' }),
    ],
    edges: [edge('t', 'set'), edge('set', 'moved'), edge('moved', 'say')],
  })
  const at = (price) => execute({ nodes, graph: graph(price), memoryFor: (id) => memory.scope('moved-test', id) })

  const first = await at(4000)
  assert.equal(first.nodes.say.status, 'skipped', 'the first look has nothing to compare against')

  const small = await at(4040)
  assert.equal(small.nodes.say.status, 'skipped', 'one percent is not five')

  const big = await at(4400)
  assert.equal(big.nodes.say.status, 'ok')
  assert.match(big.nodes.say.logs[0].message, /moved 10/)
})
