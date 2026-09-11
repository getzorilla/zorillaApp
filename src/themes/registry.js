// A theme is data, never code — the same rule integrations follow. It is a list
// of colours and nothing else, so a theme somebody else wrote cannot run
// anything, and installing one is reading a file rather than trusting a person.

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// Every colour the interface can use. A theme may set any subset; the rest fall
// back to the default, so an old theme still works after a token is added.
export const TOKENS = [
  'bg', 'raise', 'sunk', 'line', 'text', 'dim', 'dimmer',
  'accent', 'onAccent', 'ok', 'warn', 'bad', 'skip',
  'grid', 'wire', 'wireHot',
]

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const ID = /^[a-z0-9][a-z0-9-]{1,39}$/

export const DEFAULT_THEME = {
  id: 'zorilla-dark',
  label: 'Zorilla Dark',
  appearance: 'dark',
  author: 'zorilla',
  colors: {
    bg: '#101013', raise: '#16161a', sunk: '#0c0c0f', line: '#23232a',
    text: '#d8d8de', dim: '#6d6e78', dimmer: '#4a4b54',
    accent: '#6ea8fe', onAccent: '#0a0f1a',
    ok: '#5fd08a', warn: '#e3b341', bad: '#f0736f', skip: '#45464f',
    grid: '#1b1b21', wire: '#3a3b45', wireHot: '#6ea8fe',
  },
}

export function validateTheme(input, source = 'This theme') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${source} is not a theme file.`)
  }
  const id = String(input.id ?? '').trim()
  if (!ID.test(id)) throw new Error(`${source} needs an id like "nord": lower case, letters, numbers and dashes.`)
  if (!input.colors || typeof input.colors !== 'object') throw new Error(`${source} has no colours.`)

  const colors = {}
  for (const [key, value] of Object.entries(input.colors)) {
    if (!TOKENS.includes(key)) throw new Error(`${source} sets "${key}", which is not a colour zorilla uses. Known: ${TOKENS.join(', ')}.`)
    if (!HEX.test(String(value))) throw new Error(`${source} sets ${key} to "${value}". Colours are hex, like #1e1e2e.`)
    colors[key] = String(value)
  }

  const appearance = input.appearance === 'light' ? 'light' : 'dark'
  return {
    id,
    label: String(input.label ?? id).slice(0, 60),
    appearance,
    author: String(input.author ?? '').slice(0, 80),
    notes: String(input.notes ?? '').slice(0, 200),
    // merged so a partial theme is a valid theme
    colors: { ...DEFAULT_THEME.colors, ...colors },
    // what the file actually declared, so an export writes back what was written
    declared: Object.keys(colors),
  }
}

async function loadDir(dir, into, problems, user) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name)
    try {
      const theme = validateTheme(JSON.parse(await readFile(file, 'utf8')), name)
      into.set(theme.id, { ...theme, source: user ? 'yours' : 'built in' })
    } catch (err) {
      problems.push({ file, message: err.message })
    }
  }
}

// Built-in themes first, then the user's own, so a file in ~/.zorilla/themes
// can replace a shipped theme by reusing its id.
export async function loadThemes({ builtinDir, userDir }) {
  const themes = new Map([[DEFAULT_THEME.id, { ...DEFAULT_THEME, declared: Object.keys(DEFAULT_THEME.colors), source: 'built in' }]])
  const problems = []
  if (builtinDir) await loadDir(builtinDir, themes, problems, false)
  if (userDir) await loadDir(userDir, themes, problems, true)
  return { themes, problems }
}
