// The code step is the one place a shared automation runs somebody else's
// instructions. These are the things it must not be able to do.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadNodes } from '../src/engine/registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const { nodes } = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })
const code = nodes.get('code.js')

const run = (source, extra = {}) => code.run({
  params: { code: source, timeout: 10, credential: '' },
  items: [{ json: { n: 1 } }],
  creds: {},
  log: () => {},
  ...extra,
})

test('ordinary code still works', async () => {
  const out = await run('return items.map(i => ({ json: { doubled: i.json.n * 2 } }))')
  assert.deepEqual(out, [{ json: { doubled: 2 } }])
})

test('it cannot read files', async () => {
  await assert.rejects(
    () => run("const fs = await import('node:fs/promises'); return [{ json: { home: await fs.readFile('/etc/hosts', 'utf8') } }]"),
    /permission|not allowed|denied|restricted/i,
  )
})

test('it cannot start other programs', async () => {
  await assert.rejects(
    () => run("const cp = await import('node:child_process'); cp.execSync('id'); return []"),
    /permission|not allowed|denied|restricted/i,
  )
})

test('it cannot see the environment this server runs with', async () => {
  process.env.ZORILLA_TEST_SECRET = 'do-not-leak'
  try {
    const out = await run('return [{ json: { env: { ...process.env } } }]')
    const env = out[0].json.env
    const named = Object.entries(env).filter(([, value]) => value !== '')
    assert.ok(!('ZORILLA_TEST_SECRET' in env), 'a secret in the environment reached the fenced code')
    // windows hands a child some of its own environment whatever is passed, so
    // the promise is that nothing carrying a value about this person survives
    const leaked = named.filter(([name]) => /USER|HOME|PROFILE|APPDATA|LOGON|TEMP|TMP|COMPUTERNAME|OneDrive|PATH|__CF_/i.test(name))
    assert.deepEqual(leaked, [], `the fence let something through: ${JSON.stringify(leaked)}`)
  } finally {
    delete process.env.ZORILLA_TEST_SECRET
  }
})

test('it cannot run forever', async () => {
  await assert.rejects(
    () => code.run({
      params: { code: 'while (true) {}', timeout: 1, credential: '' },
      items: [{ json: {} }],
      creds: {},
      log: () => {},
    }),
    /longer than 1 seconds/,
  )
})

test('a syntax mistake reads like a message, not a crash', async () => {
  await assert.rejects(() => run('this is not javascript'), /Unexpected|not defined|is not/)
})
