// Two ways the data directory quietly goes wrong, both worth catching at boot
// rather than as a corrupted file three weeks later.
//
// A second copy of Zorilla pointed at the same directory is the worse one: both
// hold the whole store in memory and write it back, so whichever saves last
// wins and the other's work is gone with no error anywhere.
//
// A synced folder is the other. Dropbox and iCloud watch for changes and copy
// files out from under you; the atomic temp-write-then-rename this app relies
// on is exactly the pattern those daemons race with.
import { readFile, writeFile, unlink } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import path from 'node:path'
import { ensureDir } from './files.js'

const LOCK = 'zorilla.lock'
// long enough that a busy run does not look dead, short enough that a crashed
// process does not lock somebody out for the afternoon
const STALE_MS = 60_000

const SYNCED = [
  ['Dropbox', /(^|\/)Dropbox(\/|$)/i],
  ['iCloud Drive', /(^|\/)(Mobile Documents|com~apple~CloudDocs)(\/|$)/i],
  ['Google Drive', /(^|\/)(Google Drive|GoogleDrive[^/]*)(\/|$)/i],
  ['OneDrive', /(^|\/)OneDrive([^/]*)(\/|$)/i],
]

export function syncedFolder(dir) {
  const found = SYNCED.find(([, pattern]) => pattern.test(dir))
  return found ? found[0] : null
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM means it exists and belongs to somebody else, which still counts
    return err.code === 'EPERM'
  }
}

// Returns a function that drops the lock. Throws if another live process holds
// it, naming the port it is on so the person can go and find it.
export async function takeLock(dir, { port } = {}) {
  await ensureDir(dir)
  const file = path.join(dir, LOCK)

  const held = await readFile(file, 'utf8').then(JSON.parse).catch(() => null)
  if (held && held.pid !== process.pid && alive(held.pid) && Date.now() - (held.at ?? 0) < STALE_MS) {
    throw new Error(
      `Another copy of Zorilla is already using ${dir}, on port ${held.port ?? 'unknown'}. `
      + 'Two copies sharing one folder overwrite each other. Stop that one, or start this one '
      + 'with a different ZORILLA_HOME.'
    )
  }

  const write = () => writeFile(file, JSON.stringify({ pid: process.pid, port, at: Date.now() }), { mode: 0o600 })
  await write()
  // refreshed so a long-running instance never looks stale to the next start
  const beat = setInterval(() => { write().catch(() => {}) }, STALE_MS / 3)
  beat.unref?.()

  let dropped = false
  const release = () => {
    if (dropped) return
    dropped = true
    clearInterval(beat)
    try { unlinkSync(file) } catch { /* going away anyway */ }
  }
  for (const signal of ['exit', 'SIGINT', 'SIGTERM']) {
    process.once(signal, () => { release(); if (signal !== 'exit') process.exit(0) })
  }
  return async () => { clearInterval(beat); dropped = true; await unlink(file).catch(() => {}) }
}
