import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateIntegration, template, buildRequest, mapOutput } from '../src/integrations/spec.js'
import { loadIntegrations, nodesFor, credentialTypeFor } from '../src/integrations/registry.js'
import { applyAuth } from '../src/credentials/apply.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const builtinDir = path.join(here, '../src/integrations/builtin')
const { integrations, problems } = await loadIntegrations({ builtinDir })

test('every integration that ships with zorilla is a valid one', () => {
  assert.deepEqual(problems, [], 'a shipped integration must not fail to load')
  assert.ok(integrations.size >= 15)
})

test('every shipped integration says which sites it contacts', () => {
  for (const spec of integrations.values()) {
    assert.ok(spec.hosts.length > 0, `${spec.id} discloses no host`)
  }
})

test('a value that happens to contain braces is not treated as a template', () => {
  const out = template('{{ prompt }}!', { prompt: 'write about {{ handlebars }}' })
  assert.equal(out, 'write about {{ handlebars }}!')
})

test('a whole-token template keeps the real type', () => {
  assert.equal(template('{{ maxTokens }}', { maxTokens: 1024 }), 1024)
  assert.equal(template('n={{ maxTokens }}', { maxTokens: 1024 }), 'n=1024')
})

test('an integration cannot reach past what the step was given', () => {
  // $json and $creds are not tokens an integration can write. They are left as
  // literal text, so a shared integration has no way to name your other keys.
  const scope = { prompt: 'hi', key: { apiKey: 'k' } }
  assert.equal(template('{{ $creds.other.apiKey }}', scope), '{{ $creds.other.apiKey }}')
  assert.equal(template('{{ $json.secret }}', scope), '{{ $json.secret }}')
  assert.throws(() => template('{{ key.notAField }}', scope), /needs key\.notAField/)
})

test('a site name that is filled in at run time is refused', () => {
  assert.throws(
    () => validateIntegration({
      id: 'sneaky', label: 'Sneaky',
      actions: [{ key: 'go', label: 'Go', request: { url: 'https://{{ host }}/path' } }],
    }),
    /nobody can tell what this contacts/
  )
})

test('a key travelling in the web address is called out, not silently allowed', () => {
  const spec = integrations.get('etherscan')
  assert.match(spec.warnings.join(' '), /key in the web address/)
})

test('a blank field falls back to what was saved with the key', () => {
  const spec = integrations.get('resend')
  const send = spec.actions.find((a) => a.key === 'send')
  const { url, method, body } = buildRequest(
    send,
    { to: 'a@b.com', subject: 'hi', html: '<p>hi</p>', from: '' },
    { apiKey: 're_x', from: 'me@mine.com' }
  )
  assert.equal(method, 'POST')
  assert.equal(url.href, 'https://api.resend.com/emails')
  assert.equal(JSON.parse(body).from, 'me@mine.com')
})

test('a body can be built from the name and value rows the editor draws', () => {
  const spec = integrations.get('supabase')
  const insert = spec.actions.find((a) => a.key === 'insert')
  const { url, body } = buildRequest(
    insert,
    { table: 'alerts', row: [{ name: 'symbol', value: 'ETH' }, { name: 'price', value: '4000' }] },
    { url: 'https://abc.supabase.co', serviceKey: 'sk' }
  )
  assert.equal(url.href, 'https://abc.supabase.co/rest/v1/alerts')
  assert.deepEqual(JSON.parse(body), { symbol: 'ETH', price: '4000' })
})

test('credentials generated from a spec authenticate the way the service expects', () => {
  assert.deepEqual(
    applyAuth(credentialTypeFor(integrations.get('anthropic')), { apiKey: 'sk-ant-x' }).headers,
    { 'x-api-key': 'sk-ant-x', 'anthropic-version': '2023-06-01' }
  )
  assert.deepEqual(
    applyAuth(credentialTypeFor(integrations.get('twilio')), { accountSid: 'AC1', authToken: 't' }).headers,
    { Authorization: `Basic ${Buffer.from('AC1:t').toString('base64')}` }
  )
})

test('a reply is reduced to the fields a person actually wants', () => {
  const ask = integrations.get('anthropic').actions[0]
  const items = mapOutput(ask, { content: [{ text: 'hello there' }], model: 'claude-sonnet-5', stop_reason: 'end_turn' })
  assert.deepEqual(items, [{ json: { text: 'hello there', model: 'claude-sonnet-5', stopReason: 'end_turn' } }])
})

test('a list reply becomes one item per entry', () => {
  const list = integrations.get('stripe').actions.find((a) => a.key === 'charges')
  const items = mapOutput(list, { data: [{ id: 'ch_1' }, { id: 'ch_2' }] })
  assert.equal(items.length, 2)
  assert.equal(items[1].json.id, 'ch_2')
})

test('a service that answers 200 and hides the failure in the body still fails', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'channel_not_found' }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const spec = validateIntegration({
    id: 'fake', label: 'Fake',
    credential: { fields: [{ key: 'token', label: 'Token', secret: true }], auth: {} },
    actions: [{
      key: 'post', label: 'Post',
      params: [{ key: 'text', label: 'Text' }],
      request: { method: 'POST', url: `http://127.0.0.1:${server.address().port}/`, json: { text: '{{ text }}' } },
      okPath: 'ok', errorPath: 'error',
    }],
  })
  const [node] = nodesFor(spec)
  await assert.rejects(
    () => node.run({
      params: { credential: 'k', text: 'hi' },
      creds: { k: { token: 't' } },
      auth: () => ({ headers: {}, query: {} }),
      log: () => {},
    }),
    /Fake said: channel_not_found/
  )
})

test('an integration with no credential needs no key', () => {
  const spec = integrations.get('coingecko')
  assert.equal(credentialTypeFor(spec), null)
  assert.ok(!nodesFor(spec)[0].params.some((p) => p.type === 'credential'))
})

test('a run log never carries the path of a webhook key', async () => {
  const { loadIntegrations, nodesFor } = await import('../src/integrations/registry.js')
  const dir = path.join(here, '../src/integrations/builtin')
  const { integrations } = await loadIntegrations({ builtinDir: dir })
  const post = nodesFor(integrations.get('discord')).find((n) => n.type === 'discord.post')

  const secret = 'https://discord.com/api/webhooks/123456/super-secret-token'
  const logs = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(null, { status: 204 })
  try {
    await post.run({
      params: { credential: 'hook', content: 'hi', username: '' },
      creds: { hook: { webhookUrl: secret } },
      auth: () => ({ headers: {}, query: {} }),
      item: { json: {} },
      log: (line) => logs.push(line),
    })
  } finally {
    globalThis.fetch = realFetch
  }

  assert.ok(logs.length, 'the step logged nothing at all')
  assert.doesNotMatch(logs.join(' '), /super-secret-token/)
  assert.doesNotMatch(logs.join(' '), /123456/)
})
