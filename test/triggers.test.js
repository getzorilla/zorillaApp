// A listening step has to pass on what is new and stay quiet about the rest,
// including after a restart.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadIntegrations, nodesFor } from '../src/integrations/registry.js'
import { Memory } from '../src/storage/memory.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const { integrations } = await loadIntegrations({ builtinDir: path.join(here, '../src/integrations/builtin') })

test('a telegram bot hears each message once', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zorilla-tg-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const step = nodesFor(integrations.get('telegram')).find((n) => n.type === 'telegram.messages')
  assert.equal(step.category, 'trigger', 'it should sit with the triggers, not the actions')

  let inbox = [
    { update_id: 1, message: { text: '/price', chat: { id: 7 }, from: { username: 'aykk' } } },
    { update_id: 2, message: { text: 'hello', chat: { id: 7 }, from: { username: 'aykk' } } },
  ]
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: inbox }), { status: 200 })

  const memory = await Memory.open(dir)
  const call = () => step.run({
    params: { credential: 'tg', every: 1, unit: 'minutes' },
    creds: { tg: { botToken: '123:ABC', chatId: '7' } },
    auth: () => ({ headers: {}, query: {} }),
    memory: memory.scope('wf', 'tg-node'),
    log: () => {},
  })

  try {
    const first = await call()
    assert.equal(first.length, 2)
    assert.equal(first[0].json.text, '/price')
    assert.equal(first[0].json.from, 'aykk')

    const second = await call()
    assert.equal(second.length, 0, 'the same messages must not fire twice')

    inbox = [...inbox, { update_id: 3, message: { text: 'new one', chat: { id: 7 }, from: { username: 'aykk' } } }]
    const third = await call()
    assert.equal(third.length, 1)
    assert.equal(third[0].json.text, 'new one')

    // a restart reads the same memory off disk
    const fresh = await Memory.open(dir)
    const afterRestart = await step.run({
      params: { credential: 'tg', every: 1, unit: 'minutes' },
      creds: { tg: { botToken: '123:ABC', chatId: '7' } },
      auth: () => ({ headers: {}, query: {} }),
      memory: fresh.scope('wf', 'tg-node'),
      log: () => {},
    })
    assert.equal(afterRestart.length, 0, 'a restart must not replay yesterday')
  } finally {
    globalThis.fetch = real
  }
})

test('a new payment fires once per payment', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'zorilla-stripe-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const step = nodesFor(integrations.get('stripe')).find((n) => n.type === 'stripe.newCharge')
  let charges = [{ id: 'ch_1', amount: 4900 }]
  const real = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: charges }), { status: 200 })

  const memory = await Memory.open(dir)
  const call = () => step.run({
    params: { credential: 'k', every: 5, unit: 'minutes' },
    creds: { k: { secretKey: 'sk' } },
    auth: () => ({ headers: {}, query: {} }),
    memory: memory.scope('wf', 'stripe-node'),
    log: () => {},
  })

  try {
    assert.equal((await call()).length, 1)
    assert.equal((await call()).length, 0)
    charges = [{ id: 'ch_2', amount: 12900 }, ...charges]
    const next = await call()
    assert.equal(next.length, 1)
    assert.equal(next[0].json.id, 'ch_2')
  } finally {
    globalThis.fetch = real
  }
})
