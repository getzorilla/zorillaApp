import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// User code runs in a separate process with Node's permission model turned on:
// no file access, no spawning, no add-ons, and an environment carrying nothing
// about you. It can still reach the network, which is the point of most code
// steps. See docs/SIGNING.md for what this does and does not buy.
const here = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(here, 'code-runner.mjs')
const LIMIT = 15_000

// The flag was --experimental-permission until Node 22.13 renamed it. Picking
// the wrong one is not a warning: node refuses to start, so every code step on
// Node 20 would fail with "bad option".
const [major, minor] = process.versions.node.split('.').map(Number)
const FENCE = major > 22 || (major === 22 && minor >= 13) ? '--permission' : '--experimental-permission'


// A node crash ends with its own version banner and a blank line, so taking the
// last line reported "Node.js v20.20.2" as the reason for everything. The line
// worth showing is the first one that looks like an error.
function reasonFrom(text) {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean)
  const real = lines.find((l) => /Error|error:|not allowed|denied|bad option/i.test(l))
  return real ?? lines.find((l) => !/^Node\.js v/.test(l)) ?? ''
}

function runFenced(payload, seconds) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      FENCE,
      // node 20 will not even load the runner's own file once the permission
      // model is on, so it is granted read of that one path and nothing else
      `--allow-fs-read=${RUNNER}`,
      '--no-warnings',
      `--max-old-space-size=256`,
      RUNNER,
    ], {
      // nothing from this process's environment goes across
      env: {},
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`The code ran for longer than ${seconds} seconds and was stopped.`))
    }, seconds * 1000)

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not start the code step: ${e.message}`)) })
    child.on('close', (codeOut) => {
      clearTimeout(timer)
      if (!out) {
        reject(new Error(reasonFrom(err) || `The code step stopped with code ${codeOut}.`))
        return
      }
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error('The code step answered with something that is not readable.'))
      }
    })

    child.stdin.end(JSON.stringify(payload))
  })
}

export default {
  type: 'code.js',
  label: 'Run JavaScript',
  category: 'transform',
  description: 'Your own JavaScript over the items, in a process of its own.',
  outputs: ['main'],
  mode: 'batch',
  params: [
    {
      key: 'code', label: 'Code', type: 'code',
      default: 'return items.map(item => ({ json: { ...item.json } }))',
      description: 'Gets items, $creds, log. Return [{ json }], or nothing to pass through.',
    },
    {
      key: 'credential', label: 'Key it may use', type: 'credential', default: '', required: false,
      description: 'Optional. Only the key you pick here is handed across.',
    },
    { key: 'timeout', label: 'Stop it after (seconds)', type: 'number', default: 15, min: 1 },
  ],
  async run({ params, items, creds, log }) {
    const seconds = Math.max(1, Math.min(300, Number(params.timeout) || 15))
    const payload = { code: params.code ?? '', items, creds: creds ?? {} }
    if (JSON.stringify(payload).length > 8_000_000) {
      throw new Error('There is too much data here to hand to a code step. Filter it down first.')
    }

    const answer = await runFenced(payload, seconds)
    for (const line of answer.logs ?? []) log(line)
    if (!answer.ok) throw new Error(answer.error)
    return answer.result
  },
}
