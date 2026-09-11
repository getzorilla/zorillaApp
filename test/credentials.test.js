import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { randomBytes, createCipheriv } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { execute } from '../src/engine/execute.js'
import { loadNodes } from '../src/engine/registry.js'
import { Vault } from '../src/vault/vault.js'
import { applyAuth, fill, missingFields } from '../src/credentials/apply.js'
import { loadCredentialTypes } from '../src/credentials/registry.js'
import { loadIntegrations, credentialTypeFor } from '../src/integrations/registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const { nodes } = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })
const types = await loadCredentialTypes({})
// Resend, Slack and Twilio arrive as integrations now, which contribute their
// credential type alongside their steps.
const { integrations } = await loadIntegrations({ builtinDir: path.join(here, '../src/integrations/builtin') })
for (const spec of integrations.values()) {
  const type = credentialTypeFor(spec)
  if (type) types.set(type.type, type)
}

const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } })
const edge = (from, to) => ({ from, to, fromPort: 'main', toPort: 'main' })

test('a credential type turns its own fields into whatever the request needs', () => {
  assert.deepEqual(
    applyAuth(types.get('resend'), { apiKey: 're_abc' }).headers,
    { Authorization: 'Bearer re_abc' }
  )
  assert.deepEqual(
    applyAuth(types.get('apiHeader'), { name: 'X-Token', value: 'abc' }).headers,
    { 'X-Token': 'abc' }
  )
})

test('field substitution only sees this credential, never workflow data', () => {
  assert.equal(fill('Bearer {{ apiKey }}', { apiKey: 'k' }), 'Bearer k')
  assert.equal(fill('{{ $json.secret }}', { apiKey: 'k' }), '{{ $json.secret }}')
})

test('a required field that is blank is caught before saving', () => {
  assert.deepEqual(missingFields(types.get('resend'), { apiKey: '  ' }), ['API key'])
  assert.deepEqual(missingFields(types.get('resend'), { apiKey: 're_abc' }), [])
})

test('the vault remembers which service a key belongs to', async (t) => {
  const dir = path.join('/tmp', `zorilla-vault-${randomBytes(4).toString('hex')}`)
  const vault = await Vault.open({ dir })
  await vault.set('my_resend', { type: 'resend', values: { apiKey: 're_secret_abc' } })

  assert.deepEqual(vault.summary(), [{ name: 'my_resend', type: 'resend', points: '', fields: ['apiKey'] }])
  assert.deepEqual(vault.get('my_resend'), { apiKey: 're_secret_abc' })
  assert.deepEqual(vault.all(), { my_resend: { apiKey: 're_secret_abc' } })
  assert.ok(vault.secrets().includes('re_secret_abc'))
})

test('a key remembers where it points, and that is never a secret', async () => {
  const dir = path.join('/tmp', `zorilla-vault-${randomBytes(4).toString('hex')}`)
  const vault = await Vault.open({ dir })
  await vault.set('signals_webhook', {
    type: 'discord',
    values: { webhookUrl: 'https://discord.com/api/webhooks/1/super-secret' },
    points: 'webhook signals, in channel 12345',
  })

  const [saved] = vault.summary()
  assert.equal(saved.points, 'webhook signals, in channel 12345')
  // what it points at is on the screen; the address behind it is not
  assert.doesNotMatch(JSON.stringify(vault.summary()), /super-secret/)
})

test('a vault written before credential types reads back as generic', async () => {
  const dir = path.join('/tmp', `zorilla-vault-${randomBytes(4).toString('hex')}`)
  const vault = await Vault.open({ dir })

  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', vault.key, iv)
  const ct = Buffer.concat([cipher.update(JSON.stringify({ token: 'old_style' }), 'utf8'), cipher.final()])
  vault.data.items.legacy = {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  }

  assert.deepEqual(vault.read('legacy'), { type: 'generic', values: { token: 'old_style' } })
  assert.deepEqual(vault.get('legacy'), { token: 'old_style' })
})

test('picking a saved key authenticates the request without writing a header', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ got: req.headers.authorization ?? null, url: req.url }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/echo`

  const run = await execute({
    nodes,
    authFor: (name) => (name === 'my_resend' ? applyAuth(types.get('resend'), { apiKey: 're_abc' }) : { headers: {}, query: {} }),
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('call', 'net.http', { method: 'GET', url, credential: 'my_resend', headers: [], timeout: 10, failOnError: true }),
      ],
      edges: [edge('t', 'call')],
    },
  })

  assert.equal(run.status, 'ok')
  assert.equal(run.nodes.call.status, 'ok')
})

test('a saved key overrides a hand-written header of the same name and says so', async (t) => {
  let seen = null
  const server = http.createServer((req, res) => {
    seen = req.headers.authorization
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const run = await execute({
    nodes,
    authFor: () => ({ headers: { Authorization: 'Bearer from_vault' }, query: {} }),
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('call', 'net.http', {
          method: 'GET',
          url: `http://127.0.0.1:${server.address().port}/`,
          credential: 'k',
          headers: [{ name: 'Authorization', value: 'Bearer typed_by_hand' }],
          timeout: 10,
          failOnError: true,
        }),
      ],
      edges: [edge('t', 'call')],
    },
  })

  assert.equal(seen, 'Bearer from_vault')
  assert.match(run.nodes.call.logs.map((l) => l.message).join(' '), /replaced your Authorization header/)
})

test('a step is handed only the keys chosen on it', async () => {
  const { execute } = await import('../src/engine/execute.js')
  const seen = []
  const spy = {
    type: 'test.spy',
    label: 'Spy',
    category: 'action',
    outputs: ['main'],
    params: [
      { key: 'credential', label: 'Key', type: 'credential', default: '' },
      { key: 'other', label: 'Other key', type: 'credential', default: '' },
    ],
    run({ creds, auth, item }) {
      seen.push(Object.keys(creds).sort())
      // asking for a key this step does not name is refused
      assert.throws(() => auth('unrelated'), /does not use/)
      return [item]
    },
  }
  const manual = { type: 'core.manual', label: 'Manual', category: 'trigger', outputs: ['main'], run: ({ items }) => items }

  const run = await execute({
    nodes: new Map([['test.spy', spy], ['core.manual', manual]]),
    creds: { mine: { token: 'a' }, unrelated: { token: 'b' } },
    authFor: (name) => ({ headers: { 'x-key': name }, query: {} }),
    graph: {
      nodes: [
        { id: 't', type: 'core.manual', params: {}, position: { x: 0, y: 0 } },
        { id: 's', type: 'test.spy', params: { credential: 'mine', other: '' }, position: { x: 0, y: 0 } },
      ],
      edges: [{ from: 't', fromPort: 'main', to: 's', toPort: 'main' }],
    },
  })

  assert.equal(run.nodes.s.status, 'ok', run.nodes.s.error)
  assert.deepEqual(seen[0], ['mine'])
})
