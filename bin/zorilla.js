#!/usr/bin/env node
// Lets somebody try zorilla without cloning anything:
//
//   npx github:getzorilla/zorillaApp
//
// It starts the same server npm start does, then opens the page.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const server = path.join(here, '../src/server/index.js')
const port = Number(process.env.ZORILLA_PORT) || 5177

const child = spawn(process.execPath, [server], { stdio: 'inherit', env: process.env })

// Wait until it actually answers before opening a browser. A fixed delay is a
// guess, and losing that race shows somebody "unable to connect" on the first
// thing they ever see.
const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'

async function openWhenReady() {
  if (process.env.ZORILLA_NO_OPEN) return
  const address = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return
    try {
      await fetch(address, { signal: AbortSignal.timeout(1000) })
      // cmd's start takes the first quoted argument as a window title, so it
      // gets an empty one before the address
      const args = process.platform === 'win32' ? ['""', address] : [address]
      spawn(opener, args, { stdio: 'ignore', detached: true, shell: process.platform === 'win32' }).unref()
      return
    } catch {
      await new Promise((wait) => setTimeout(wait, 150))
    }
  }
  console.log(`\n  Zorilla is taking a while to start. Open ${address} yourself once it says it is ready.\n`)
}

openWhenReady()

const stop = () => child.kill('SIGINT')
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('close', (code) => process.exit(code ?? 0))
