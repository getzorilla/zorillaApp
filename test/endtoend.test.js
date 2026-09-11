// The two automations the project has to be able to run:
//
//   every 10 minutes  -> ETH price -> post to a Discord channel
//   every hour        -> ETH price -> email through Resend
//
// The network is stubbed, so what this proves is everything zorilla is
// responsible for: the schedule shape, the price step, the templating, the
// Authorization header the vault applies, and the item that comes out.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '../src/engine/execute.js'
import { loadNodes } from '../src/engine/registry.js'
import { loadIntegrations, nodesFor, credentialTypeFor } from '../src/integrations/registry.js'
import { applyAuth } from '../src/credentials/apply.js'

const here = path.dirname(fileURLToPath(import.meta.url))

const code = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })
const { integrations } = await loadIntegrations({ builtinDir: path.join(here, '../src/integrations/builtin') })

const nodes = new Map(code.nodes)
const credentialTypes = new Map()
for (const spec of integrations.values()) {
  const type = credentialTypeFor(spec)
  if (type) credentialTypes.set(type.type, type)
  for (const def of nodesFor(spec)) nodes.set(def.type, def)
}

const WEBHOOK = 'https://discord.com/api/webhooks/123/abc'
const creds = {
  signals_webhook: { type: 'discord', values: { webhookUrl: WEBHOOK } },
  my_resend: { type: 'resend', values: { apiKey: 're_test_key', from: 'alerts@zorilla.dev' } },
}
const credValues = Object.fromEntries(Object.entries(creds).map(([name, c]) => [name, c.values]))
const authFor = (name) => {
  if (!name) return { headers: {}, query: {} }
  const record = creds[name]
  return applyAuth(credentialTypes.get(record.type), record.values)
}

function stubFetch(sent) {
  return async (url, options = {}) => {
    const href = String(url)
    sent.push({ url: href, ...options, body: options.body ? JSON.parse(options.body) : null })
    if (href.includes('coingecko')) {
      return new Response(JSON.stringify({ ethereum: { usd: 4123.45 } }), { status: 200 })
    }
    // a real webhook answers 204 with no body at all
    if (href.startsWith(WEBHOOK)) return new Response(null, { status: 204 })
    if (href.includes('resend')) return new Response(JSON.stringify({ id: 'em_123' }), { status: 200 })
    return new Response(JSON.stringify({ error: 'unexpected host' }), { status: 500 })
  }
}

const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } })
const edge = (from, to) => ({ from, fromPort: 'main', to, toPort: 'main' })

test('every 10 minutes, ETH price into a Discord channel', async () => {
  const sent = []
  const real = globalThis.fetch
  globalThis.fetch = stubFetch(sent)
  try {
    const run = await execute({
      nodes,
      creds: credValues,
      authFor,
      graph: {
        id: 'wf-discord',
        name: 'eth price to discord',
        nodes: [
          node('clock', 'core.schedule', { mode: 'every', every: 10, unit: 'minutes' }),
          node('price', 'coingecko.price', { ids: 'ethereum', currency: 'usd' }),
          node('post', 'discord.post', {
            credential: 'signals_webhook',
            content: 'ETH is ${{ $json.ethereum.usd }}',
            username: 'zorilla',
          }),
        ],
        edges: [edge('clock', 'price'), edge('price', 'post')],
      },
    })

    assert.equal(run.status, 'ok', run.error ?? JSON.stringify(run.nodes))
    assert.equal(run.nodes.post.status, 'ok')

    const [priceCall, discordCall] = sent
    assert.match(priceCall.url, /ids=ethereum&vs_currencies=usd/)
    assert.equal(discordCall.url, WEBHOOK)
    assert.equal(discordCall.body.content, 'ETH is $4123.45')
    assert.equal(discordCall.body.username, 'zorilla')
  } finally {
    globalThis.fetch = real
  }
})

test('every hour, the same price by email through Resend', async () => {
  const sent = []
  const real = globalThis.fetch
  globalThis.fetch = stubFetch(sent)
  try {
    const run = await execute({
      nodes,
      creds: credValues,
      authFor,
      graph: {
        id: 'wf-email',
        name: 'hourly eth email',
        nodes: [
          node('clock', 'core.schedule', { mode: 'every', every: 1, unit: 'hours' }),
          node('price', 'coingecko.price', { ids: 'ethereum', currency: 'usd' }),
          node('mail', 'resend.send', {
            credential: 'my_resend',
            to: 'someone@example.com',
            subject: 'ETH is {{ $json.ethereum.usd }}',
            html: '<p>ETH is {{ $json.ethereum.usd }} right now.</p>',
            from: '',
          }),
        ],
        edges: [edge('clock', 'price'), edge('price', 'mail')],
      },
    })

    assert.equal(run.status, 'ok', run.error ?? JSON.stringify(run.nodes))
    const mail = sent.at(-1)
    assert.equal(mail.url, 'https://api.resend.com/emails')
    assert.equal(mail.headers.Authorization, 'Bearer re_test_key')
    assert.equal(mail.body.to, 'someone@example.com')
    assert.equal(mail.body.subject, 'ETH is 4123.45')
    // the sender falls back to the one saved with the key
    assert.equal(mail.body.from, 'alerts@zorilla.dev')
  } finally {
    globalThis.fetch = real
  }
})

test('a step with no key chosen says so instead of failing at the network', async () => {
  const run = await execute({
    nodes,
    creds: credValues,
    authFor,
    graph: {
      nodes: [node('start', 'core.manual'), node('post', 'discord.post', { content: 'hi' })],
      edges: [edge('start', 'post')],
    },
  })
  assert.equal(run.nodes.post.status, 'error')
  assert.match(run.nodes.post.error, /Discord key/i)
})
