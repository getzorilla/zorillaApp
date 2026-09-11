import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

function validate(def, source) {
  const where = `${source}`
  if (!def || typeof def !== 'object') throw new Error(`${where} did not export a step definition.`)
  for (const key of ['type', 'label', 'category']) {
    if (typeof def[key] !== 'string' || !def[key]) throw new Error(`${where} is missing "${key}".`)
  }
  if (typeof def.run !== 'function') throw new Error(`${where} has no run function.`)
  if (def.params && !Array.isArray(def.params)) throw new Error(`${where} has a params field that is not a list.`)
  return {
    outputs: ['main'],
    params: [],
    mode: 'perItem',
    description: '',
    ...def,
  }
}

async function loadDir(dir, into, problems) {
  let entries
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries.filter((n) => n.endsWith('.js')).sort()) {
    const file = path.join(dir, name)
    try {
      const mod = await import(pathToFileURL(file).href)
      const exported = mod.default
      const list = Array.isArray(exported) ? exported : [exported]
      for (const def of list) {
        const ok = validate(def, name)
        ok.source = dir
        into.set(ok.type, ok)
      }
    } catch (err) {
      problems.push({ file, message: err.message })
    }
  }
}

// Built-in steps first, then the user's own, so a local file can replace a
// shipped step without waiting for a release. A file in the user directory is
// unrestricted Node code; installing one is equivalent to npm install.
export async function loadNodes({ builtinDir, userDir }) {
  const nodes = new Map()
  const problems = []
  await loadDir(builtinDir, nodes, problems)
  if (userDir) await loadDir(userDir, nodes, problems)
  return { nodes, problems }
}

export function describe(def) {
  const { run, ...rest } = def
  return rest
}
