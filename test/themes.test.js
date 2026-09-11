import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadThemes, validateTheme, TOKENS, DEFAULT_THEME } from '../src/themes/registry.js'
import { loadNodes } from '../src/engine/registry.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const builtinDir = path.join(here, '../src/themes/builtin')

test('every shipped theme loads and covers every colour', async () => {
  const { themes, problems } = await loadThemes({ builtinDir })
  assert.deepEqual(problems, [])
  assert.ok(themes.size >= 10, `only ${themes.size} themes`)
  for (const theme of themes.values()) {
    for (const token of TOKENS) {
      assert.match(theme.colors[token], /^#[0-9a-fA-F]{3,8}$/, `${theme.id} is missing ${token}`)
    }
  }
})

test('a theme is colours and nothing else', () => {
  // anything beyond the known fields is dropped rather than carried, so a file
  // cannot smuggle something past the loader and into the page
  const theme = validateTheme({ id: 'xy', colors: { bg: '#000' }, run: 'anything', onLoad: 'alert(1)' })
  assert.deepEqual(Object.keys(theme).sort(), ['appearance', 'author', 'colors', 'declared', 'id', 'label', 'notes'])

  assert.throws(() => validateTheme({ id: 'xy', colors: { bg: 'url(javascript:alert(1))' } }), /hex/)
  assert.throws(() => validateTheme({ id: 'xy', colors: { fetch: '#000' } }), /not a colour/)
  assert.throws(() => validateTheme({ id: 'Nope Caps', colors: { bg: '#000' } }), /id/)
})

test('a partial theme is completed from the default rather than refused', () => {
  const theme = validateTheme({ id: 'half', colors: { accent: '#ff0000' } })
  assert.equal(theme.colors.accent, '#ff0000')
  assert.equal(theme.colors.bg, DEFAULT_THEME.colors.bg)
  assert.deepEqual(theme.declared, ['accent'])
})

test('the example automations only use steps that exist', async () => {
  const { nodes } = await loadNodes({ builtinDir: path.join(here, '../src/nodes') })
  const integrationDir = path.join(here, '../src/integrations/builtin')
  const specs = await readdir(integrationDir)
  const known = new Set(nodes.keys())
  for (const file of specs) {
    const spec = JSON.parse(await readFile(path.join(integrationDir, file), 'utf8'))
    for (const action of spec.actions ?? []) known.add(`${spec.id}.${action.key}`)
  }

  const dir = path.join(here, '../automations')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  assert.ok(files.length, 'no example automations shipped')
  for (const file of files) {
    const wf = JSON.parse(await readFile(path.join(dir, file), 'utf8'))
    const ids = new Set(wf.nodes.map((n) => n.id))
    for (const node of wf.nodes) assert.ok(known.has(node.type), `${file} uses ${node.type}, which does not exist`)
    for (const edge of wf.edges) {
      assert.ok(ids.has(edge.from) && ids.has(edge.to), `${file} has an edge pointing at a step that is not there`)
    }
    assert.notEqual(wf.active, true, `${file} ships switched on`)
  }
})
