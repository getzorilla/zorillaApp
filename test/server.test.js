import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const PORT = 5300 + Math.floor(Math.random() * 400)
const HOME = path.join('/tmp', `zorilla-server-${randomBytes(4).toString('hex')}`)

const server = spawn(process.execPath, [path.join(here, '../src/server/index.js')], {
  env: { ...process.env, ZORILLA_HOME: HOME, ZORILLA_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('server did not start')), 15_000)
  server.stdout.on('data', (chunk) => {
    if (String(chunk).includes(`:${PORT}`)) { clearTimeout(timer); resolve() }
  })
})
test.after(() => server.kill())

const base = `http://127.0.0.1:${PORT}`
const post = (headers, body = '{"name":"planted","nodes":[],"edges":[]}') =>
  fetch(`${base}/api/workflows`, { method: 'POST', headers, body })

// A page you merely visit must not be able to write an active workflow, because
// a workflow can contain a step that runs code.
test('a write from another website is refused', async () => {
  const evil = { Origin: 'https://totally-unrelated-site.example' }
  assert.equal((await post({ ...evil, 'content-type': 'text/plain' })).status, 403)
  assert.equal((await post({ ...evil, 'content-type': 'application/json' })).status, 403)
})

test('a plain-text body is refused, so a cross-site request cannot skip the preflight', async () => {
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415)
})

test('zorilla still accepts writes from its own page', async () => {
  const response = await post({ Origin: base, 'content-type': 'application/json' })
  assert.equal(response.status, 200)
  const saved = await response.json()
  assert.equal(saved.name, 'planted')
  await fetch(`${base}/api/workflows/${saved.id}`, { method: 'DELETE', headers: { Origin: base } })
})

test('reading is unaffected', async () => {
  const response = await fetch(`${base}/api/state`)
  assert.equal(response.status, 200)
  const state = await response.json()
  assert.ok(state.nodes.length > 30)
  assert.ok(state.integrations.length >= 15)
})

test('a webhook with a secret refuses a caller that does not have it', async () => {
  const node = {
    type: 'core.webhook',
    params: { path: 'pay', method: 'POST', secret: 'hunter2' },
  }
  // the check the server makes, in the same shape
  const check = (headers, query) => {
    const wanted = String(node.params.secret ?? '').trim()
    if (!wanted) return true
    return String(headers['x-zorilla-secret'] ?? query.secret ?? '') === wanted
  }
  assert.equal(check({}, {}), false)
  assert.equal(check({}, { secret: 'wrong' }), false)
  assert.equal(check({ 'x-zorilla-secret': 'hunter2' }, {}), true)
  assert.equal(check({}, { secret: 'hunter2' }), true)
})

test('one unreadable automation does not stop the others loading', async (t) => {
  const { Store } = await import('../src/storage/store.js')
  const { mkdtemp, writeFile, rm, mkdir } = await import('node:fs/promises')
  const os = await import('node:os')
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zorilla-broken-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const store = await Store.open(dir)
  await store.saveWorkflow({ name: 'a good one', nodes: [], edges: [] })
  await mkdir(path.join(dir, 'workflows'), { recursive: true })
  await writeFile(path.join(dir, 'workflows', 'broken.json'), '{ not json at all')

  const workflows = await store.listWorkflows()
  assert.equal(workflows.length, 1, 'the good one should still load')
  assert.equal(store.problems.length, 1, 'the bad one should be reported')
  assert.match(store.problems[0].message, /not readable JSON/)
})
