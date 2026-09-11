import { mkdir, readFile, writeFile, rename, readdir, unlink, open } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function dataDir() {
  return process.env.ZORILLA_HOME || path.join(os.homedir(), '.zorilla')
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true })
  return dir
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    throw new Error(`${file} is not readable JSON: ${err.message}`)
  }
}

// Write to a sibling temp file, flush it, then rename. A crash mid-write leaves
// the previous file intact instead of a truncated one.
// JSON.stringify throws on a BigInt. A node returning one is a node bug, but it
// should surface as a readable value in the run log, not a crashed save.
const bigints = (_key, value) => (typeof value === 'bigint' ? value.toString() : value)

export async function writeJson(file, data, { mode = 0o600 } = {}) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  const handle = await open(tmp, 'w', mode)
  try {
    await handle.writeFile(JSON.stringify(data, bigints, 2))
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(tmp, file)
}

export async function listJson(dir) {
  try {
    const names = await readdir(dir)
    return names.filter((n) => n.endsWith('.json')).sort()
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
}

export async function removeFile(file) {
  try {
    await unlink(file)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
}
