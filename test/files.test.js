// Files have to survive the trip: made or downloaded, carried between steps,
// saved to disk, and attached to an email.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execute } from '../src/engine/execute.js'
import { loadNodes } from '../src/engine/registry.js'
import { loadIntegrations, nodesFor } from '../src/integrations/registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const { nodes } = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })
const { integrations } = await loadIntegrations({ builtinDir: path.join(here, '../src/integrations/builtin') })

const node = (id, type, params = {}) => ({ id, type, params, position: { x: 0, y: 0 } })
const edge = (from, to) => ({ from, fromPort: 'main', to, toPort: 'main' })

test('a spreadsheet is made, saved, and read back', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'zorilla-files-'))
  process.env.ZORILLA_HOME = home
  t.after(() => { delete process.env.ZORILLA_HOME; return rm(home, { recursive: true, force: true }) })

  const run = await execute({
    nodes,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('make', 'file.fromText', { text: 'name,amount\nada,42', name: 'report.csv', as: 'file' }),
        node('save', 'file.save', { which: 'file', name: '' }),
      ],
      edges: [edge('t', 'make'), edge('make', 'save')],
    },
  })
  assert.equal(run.status, 'ok', run.nodes.save?.error)
  const written = await readFile(path.join(home, 'files', 'report.csv'), 'utf8')
  assert.equal(written, 'name,amount\nada,42')
})

test('a download keeps its bytes and its name', async (t) => {
  const real = globalThis.fetch
  t.after(() => { globalThis.fetch = real })
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  globalThis.fetch = async () => new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="chart.png"' },
  })

  const run = await execute({
    nodes,
    graph: {
      nodes: [
        node('t', 'core.manual'),
        node('get', 'net.http', { method: 'GET', url: 'https://example.com/chart', headers: [], sendBody: false, timeout: 5, failOnError: true }),
      ],
      edges: [edge('t', 'get')],
    },
  })
  assert.equal(run.nodes.get.status, 'ok', run.nodes.get.error)
  assert.match(run.nodes.get.logs[0].message, /8 bytes/)
})

test('an email carries the file the run is holding', async (t) => {
  const real = globalThis.fetch
  t.after(() => { globalThis.fetch = real })
  let sent = null
  globalThis.fetch = async (url, options) => {
    sent = JSON.parse(options.body)
    return new Response(JSON.stringify({ id: 'em_1' }), { status: 200 })
  }

  const send = nodesFor(integrations.get('resend')).find((n) => n.type === 'resend.send')
  const item = {
    json: {},
    binary: { file: { filename: 'report.csv', mime: 'text/csv', size: 18, data: Buffer.from('name,amount\nada,42').toString('base64') } },
  }
  await send.run({
    params: { credential: 'k', to: 'you@example.com', subject: 'report', html: '<p>attached</p>', from: 'me@example.com' },
    creds: { k: { apiKey: 're_x' } },
    auth: () => ({ headers: {}, query: {} }),
    item,
    log: () => {},
  })

  assert.equal(sent.attachments.length, 1)
  assert.equal(sent.attachments[0].filename, 'report.csv')
  assert.equal(Buffer.from(sent.attachments[0].content, 'base64').toString(), 'name,amount\nada,42')
})
