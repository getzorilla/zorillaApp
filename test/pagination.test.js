// A list step has to come back with everything, or say plainly that it did not.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadIntegrations, nodesFor } from '../src/integrations/registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const { integrations } = await loadIntegrations({ builtinDir: path.join(here, '../src/integrations/builtin') })

function stub(handler) {
  const real = globalThis.fetch
  globalThis.fetch = handler
  return () => { globalThis.fetch = real }
}

test('stripe: 250 payments come back as 250, not 100', async () => {
  const charges = nodesFor(integrations.get('stripe')).find((n) => n.type === 'stripe.charges')
  const asked = []
  const restore = stub(async (url) => {
    const target = new URL(String(url))
    asked.push(target.searchParams.get('starting_after'))
    const after = Number(target.searchParams.get('starting_after')?.replace('ch_', '') ?? 0)
    const page = Array.from({ length: Math.min(100, 250 - after) }, (_, i) => ({ id: `ch_${after + i + 1}`, amount: 100 }))
    return new Response(JSON.stringify({ data: page, has_more: after + page.length < 250 }), { status: 200 })
  })
  try {
    const logs = []
    const items = await charges.run({
      params: { credential: 'k', limit: 250 },
      creds: { k: { secretKey: 'sk' } },
      auth: () => ({ headers: {}, query: {} }),
      log: (l) => logs.push(l),
    })
    assert.equal(items.length, 250)
    assert.equal(items.at(-1).json.id, 'ch_250')
    assert.deepEqual(asked, [null, 'ch_100', 'ch_200'])
    assert.match(logs.join(' '), /That is all of them/)
  } finally { restore() }
})

test('notion: asking for fewer than exist says so out loud', async () => {
  const query = nodesFor(integrations.get('notion')).find((n) => n.type === 'notion.query')
  const restore = stub(async (url, options) => {
    const body = JSON.parse(options.body)
    const from = Number(body.start_cursor ?? 0)
    const page = Array.from({ length: 100 }, (_, i) => ({ id: `row_${from + i + 1}` }))
    return new Response(JSON.stringify({ results: page, has_more: true, next_cursor: String(from + 100) }), { status: 200 })
  })
  try {
    const logs = []
    const items = await query.run({
      params: { credential: 'k', databaseId: 'db', limit: 150 },
      creds: { k: { token: 't' } },
      auth: () => ({ headers: {}, query: {} }),
      log: (l) => logs.push(l),
    })
    assert.equal(items.length, 150)
    assert.match(logs.join(' '), /the most you asked for. There are more/)
  } finally { restore() }
})

test('a service that just stops gets believed', async () => {
  const list = nodesFor(integrations.get('airtable')).find((n) => n.type === 'airtable.list')
  let calls = 0
  const restore = stub(async () => {
    calls += 1
    if (calls === 1) return new Response(JSON.stringify({ records: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}` })), offset: 'next' }), { status: 200 })
    return new Response(JSON.stringify({ records: [{ id: 'last' }] }), { status: 200 })
  })
  try {
    const items = await list.run({
      params: { credential: 'k', baseId: 'b', table: 't', limit: 500 },
      creds: { k: { token: 't' } },
      auth: () => ({ headers: {}, query: {} }),
      log: () => {},
    })
    assert.equal(items.length, 101)
    assert.equal(calls, 2)
  } finally { restore() }
})
