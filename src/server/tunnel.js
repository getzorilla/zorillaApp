import { spawn } from 'node:child_process'
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { dataDir } from '../storage/files.js'

// A tunnel gives the webhook step an address the internet can reach without
// opening this machine up: cloudflared dials out to Cloudflare, and Cloudflare
// passes anything sent to that address back down the same connection. Closing
// it ends the address.
//
// The program is fetched from Cloudflare's own releases and kept in the zorilla
// folder, so nothing has to be installed by hand. It only ever happens because
// somebody pressed the button.

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download'

const BUILDS = {
  'darwin-arm64': 'cloudflared-darwin-arm64.tgz',
  'darwin-x64': 'cloudflared-darwin-amd64.tgz',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
  'win32-x64': 'cloudflared-windows-amd64.exe',
}

export function buildName() {
  return BUILDS[`${process.platform}-${process.arch}`] ?? null
}

export function downloadFrom() {
  const build = buildName()
  return build ? `${RELEASES}/${build}` : null
}

function binPath() {
  return path.join(dataDir(), 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
}

export async function isInstalled() {
  try {
    await stat(binPath())
    return true
  } catch {
    return false
  }
}

async function unpack(buffer, target) {
  // the mac builds arrive as a tgz; everything else is the program itself
  if (!buildName().endsWith('.tgz')) {
    await writeFile(target, buffer)
    return
  }
  const temp = `${target}.tgz`
  await writeFile(temp, buffer)
  await new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xzf', temp, '-C', path.dirname(target)])
    tar.on('error', reject)
    tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Could not unpack it (${code}).`))))
  })
  await rename(path.join(path.dirname(target), 'cloudflared'), target).catch(() => {})
  await rm(temp, { force: true })
}

export async function install(onProgress = () => {}) {
  const url = downloadFrom()
  if (!url) throw new Error(`There is no tunnel program for this machine (${process.platform} ${process.arch}). You can still run one yourself and set ZORILLA_PUBLIC_URL.`)

  const target = binPath()
  await mkdir(path.dirname(target), { recursive: true })

  onProgress(`Fetching the tunnel program from ${new URL(url).host}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Could not fetch the tunnel program: ${response.status} ${response.statusText}`)
  const buffer = Buffer.from(await response.arrayBuffer())

  const digest = createHash('sha256').update(buffer).digest('hex')
  onProgress(`Got ${(buffer.length / 1e6).toFixed(1)}MB, sha256 ${digest.slice(0, 16)}…`)

  await unpack(buffer, target)
  await chmod(target, 0o755)

  const works = await new Promise((resolve) => {
    const child = spawn(target, ['--version'], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
  if (!works) throw new Error('The tunnel program was fetched but will not run on this machine.')

  onProgress('Ready.')
  return { path: target, sha256: digest }
}

let current = null

export function status() {
  return {
    running: Boolean(current?.url),
    url: current?.url ?? null,
    startedAt: current?.startedAt ?? null,
  }
}

export async function start(port, onProgress = () => {}) {
  if (current?.url) return status()
  if (!(await isInstalled())) await install(onProgress)

  onProgress('Opening the tunnel')
  const child = spawn(binPath(), ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  current = { child, url: null, startedAt: new Date().toISOString() }

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The tunnel did not come up within 30 seconds.')), 30_000)
    const watch = (chunk) => {
      const found = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
      if (found) {
        clearTimeout(timer)
        resolve(found[0])
      }
    }
    child.stdout.on('data', watch)
    child.stderr.on('data', watch)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', () => { clearTimeout(timer); reject(new Error('The tunnel closed before it gave out an address.')) })
  }).catch((err) => {
    child.kill()
    current = null
    throw err
  })

  current.url = url
  child.on('close', () => { current = null })
  onProgress(`Reachable at ${url}`)
  return status()
}

export function stop() {
  if (!current) return { running: false, url: null, startedAt: null }
  current.child.kill()
  current = null
  return { running: false, url: null, startedAt: null }
}
