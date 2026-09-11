import { readdir } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import builtin from './types.js'

export async function loadCredentialTypes({ userDir } = {}) {
  const types = new Map()
  for (const type of builtin) types.set(type.type, type)

  if (userDir) {
    let entries = []
    try {
      entries = await readdir(userDir)
    } catch { /* no user types yet */ }
    for (const name of entries.filter((n) => n.endsWith('.js')).sort()) {
      try {
        const mod = await import(pathToFileURL(path.join(userDir, name)).href)
        for (const type of [mod.default].flat()) {
          if (type?.type) types.set(type.type, type)
        }
      } catch { /* a broken file should not stop the rest */ }
    }
  }
  return types
}

// Field keys and shapes only. Values never appear here.
export function describeType(type) {
  const { test, auth, ...rest } = type
  return { ...rest, checkable: Boolean(test) }
}
