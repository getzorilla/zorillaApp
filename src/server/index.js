import http from 'node:http'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadNodes, describe } from '../engine/registry.js'
import { execute } from '../engine/execute.js'
import { Store } from '../storage/store.js'
import { Memory } from '../storage/memory.js'
import { dataDir, ensureDir, writeJson, removeFile, readJson, listJson } from '../storage/files.js'
import { takeLock, syncedFolder } from '../storage/guard.js'
import * as workspaces from '../storage/workspaces.js'
import { Vault, makeScrubber } from '../vault/vault.js'
import { loadCredentialTypes, describeType } from '../credentials/registry.js'
import { loadIntegrations, nodesFor, credentialTypeFor, describeIntegration } from '../integrations/registry.js'
import { validateIntegration } from '../integrations/spec.js'
import { loadThemes, validateTheme, TOKENS } from '../themes/registry.js'
import { renderDocs } from '../docs/render.js'
import { derivePermissions, cleanWorkflow } from '../engine/permissions.js'
import * as tunnel from './tunnel.js'
import { applyAuth, testCredential, missingFields } from '../credentials/apply.js'

// Not configurable, on purpose. This process holds credentials and has no
// authentication. Anyone who wants it reachable from another machine should
// forward a port over SSH.
const HOST = '127.0.0.1'
const PORT = Number(process.env.ZORILLA_PORT) || 5177

// A tunnel connects out from this machine, so the bind address never changes.
// This is only what the editor shows people to paste into Stripe or GitHub.
const PUBLIC_URL = String(process.env.ZORILLA_PUBLIC_URL || '').replace(/\/$/, '')

const publicAddress = () => tunnel.status().url || PUBLIC_URL

const here = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(here, '../../public')
const builtinNodeDir = path.join(here, '../nodes')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const home = dataDir()

// Before anything opens a file in there: refuse to share the folder with
// another running copy, and say so if it sits somewhere a sync daemon will
// race with our writes.
try {
  await takeLock(home, { port: PORT })
} catch (err) {
  // a stack trace here tells somebody nothing they can act on
  console.error(`\n  ${err.message}\n`)
  process.exit(1)
}
const synced = syncedFolder(home)
if (synced) {
  console.warn(
    `\n  Warning: your Zorilla folder is inside ${synced}.\n`
    + '  Syncing software copies files while they are being written, which can corrupt\n'
    + '  your automations or your vault. Move it, or set ZORILLA_HOME somewhere local.\n'
  )
}

// Which workspace is open decides where the automations, the runs, the scratch
// memory and the vault come from. Switching re-opens all four rather than
// restarting, so the page can do it without the server going away.
let workspaceId = (await workspaces.list(home)).current
let workspaceDir = workspaces.dirFor(home, workspaceId)
let store = await Store.open(workspaceDir)
let memory = await Memory.open(workspaceDir)
// On a server the only thing anybody sees is the log, so a wrong passphrase has
// to say what to do rather than print a stack trace at them.
let vault
try {
  vault = await Vault.open({ dir: workspaceDir, passphrase: process.env.ZORILLA_PASSPHRASE || null })
} catch (err) {
  console.error(
    `\n  zorilla could not open the vault in ${workspaceDir}.\n`
    + `  ${err.message}\n\n`
    + '  If you set ZORILLA_PASSPHRASE, check it is the same one the vault was\n'
    + '  made with. A vault cannot be opened with a different passphrase, and\n'
    + '  there is no way to recover one that has been lost.\n'
  )
  process.exit(1)
}

const exampleDir = path.join(here, '../../automations')

// A workspace with nothing in it teaches nobody anything, so the examples that
// ship with zorilla are put into an Examples folder the first time one is
// opened. Once only: deleting them has to stick, which is what the seeded flag
// on the workspace records.
async function seedExamples(intoStore) {
  const workspace = await intoStore.getWorkspace()
  if (workspace.seeded) return
  let added = 0
  for (const file of await listJson(exampleDir)) {
    const example = await readJson(path.join(exampleDir, file), null)
    if (!example?.nodes) continue
    await intoStore.saveWorkflow({ ...example, id: null, folder: 'Examples', example: true, active: false })
    added += 1
  }
  await intoStore.saveWorkspace({
    seeded: true,
    folders: added ? [...workspace.folders, 'Examples'] : workspace.folders,
  })
}


async function openWorkspace(id) {
  const dir = workspaces.dirFor(home, id)
  await ensureDir(dir)
  const next = {
    store: await Store.open(dir),
    memory: await Memory.open(dir),
    // the machine key lives in the home, so every workspace's vault unlocks
    // with it while the keys themselves stay apart
    vault: await Vault.open({ dir, passphrase: process.env.ZORILLA_PASSPHRASE || null, keyDir: home }),
  }
  workspaceId = id
  workspaceDir = dir
  store = next.store
  memory = next.memory
  vault = next.vault
  await seedExamples(store)
  await rescheduleAll()
}
await seedExamples(store)

const userNodeDir = path.join(home, 'nodes')
const userCredentialDir = path.join(home, 'credentials')
await ensureDir(userNodeDir)
await ensureDir(userCredentialDir)

const builtinIntegrationDir = path.join(here, '../integrations/builtin')
const userIntegrationDir = path.join(home, 'integrations')
await ensureDir(userIntegrationDir)

const builtinThemeDir = path.join(here, '../themes/builtin')
const userThemeDir = path.join(home, 'themes')
await ensureDir(userThemeDir)

// Example automations ship as files in the repo rather than as code in here, so
// somebody reading the project can see what one looks like before running it.

// Steps come from two places. Some are JavaScript shipped with zorilla or
// dropped into ~/.zorilla/nodes by a user. The rest are integrations: JSON
// files describing a service's key and its requests, which is what makes a
// shared one safe to install.
async function loadEverything() {
  const code = await loadNodes({ builtinDir: builtinNodeDir, userDir: userNodeDir })
  const rawTypes = await loadCredentialTypes({ userDir: userCredentialDir })
  const { integrations, problems } = await loadIntegrations({
    builtinDir: builtinIntegrationDir,
    userDir: userIntegrationDir,
  })

  const nodes = new Map(code.nodes)
  const credentialTypes = new Map(rawTypes)
  for (const spec of integrations.values()) {
    const type = credentialTypeFor(spec)
    if (type) credentialTypes.set(type.type, type)
    for (const def of nodesFor(spec)) nodes.set(def.type, def)
  }

  const themeLoad = await loadThemes({ builtinDir: builtinThemeDir, userDir: userThemeDir })

  const allProblems = [...code.problems, ...problems, ...themeLoad.problems]
  for (const problem of allProblems) console.warn(`Could not load ${problem.file}: ${problem.message}`)
  return { nodes, credentialTypes, integrations, themes: themeLoad.themes, problems: allProblems }
}

let registry = await loadEverything()

// Nodes ask for this instead of reading key material. The engine wraps it per
// step (scopeAuth in execute.js) so a step can only resolve the keys chosen on
// it, and the names are read off the raw parameters, so an expression cannot
// resolve to somebody else's key name to widen the reach.
function authFor(name) {
  if (!name) return { headers: {}, query: {} }
  const record = vault.read(name)
  const type = registry.credentialTypes.get(record.type)
  if (!type) throw new Error(`"${name}" is a kind of key this install does not know about (${record.type}).`)
  return applyAuth(type, record.values)
}

const listeners = new Set()

function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`
  for (const res of listeners) res.write(line)
}

function scrubber() {
  return makeScrubber(vault.secrets())
}

async function runWorkflow(workflow, trigger) {
  const scrub = scrubber()
  const run = await execute({
    graph: workflow,
    nodes: registry.nodes,
    creds: vault.all(),
    authFor,
    memoryFor: (nodeId) => memory.scope(workflow.id, nodeId),
    trigger,
    onEvent: (event) => broadcast(scrub(event)),
  })
  const saved = await store.saveRun(scrub(run))

  // A step asked for this workflow to stop repeating. Honour it after the run
  // finishes, so the rest of the graph still completes.
  if (run.stopRequested) {
    const fresh = await store.getWorkflow(workflow.id)
    if (fresh?.active) {
      await store.saveWorkflow({ ...fresh, active: false })
      await rescheduleAll()
      broadcast({ type: 'workflow:off', workflowId: workflow.id, reason: run.stopReason ?? '' })
    }
  }
  return saved
}

// -- scheduling -------------------------------------------------------------

const STARTED_AT = new Date().toISOString()
const timers = new Map()
// What is armed right now, and when it next fires. A "Live" chip says a trigger
// exists; it does not say the machine is awake and counting, which is the thing
// somebody leaving an automation running actually wants to know.
const armed = new Map()
const MS = { minutes: 60_000, hours: 3_600_000, days: 86_400_000 }
const MAX_DELAY = 2 ** 31 - 1

function fireLater(key, delay, fire) {
  // setTimeout silently fires immediately past ~24 days, so long waits are
  // walked down in chunks instead
  if (delay > MAX_DELAY) {
    timers.set(key, setTimeout(() => fireLater(key, delay - MAX_DELAY, fire), MAX_DELAY))
    return
  }
  timers.set(key, setTimeout(fire, Math.max(0, delay)))
}

function runFresh(workflowId, nodeId) {
  return store.getWorkflow(workflowId)
    .then((fresh) => (fresh?.active ? runWorkflow(fresh, { nodeId }) : null))
    .catch((err) => console.warn(`Scheduled run failed: ${err.message}`))
}

// Timers only exist while the process does. A laptop shut at 11pm loses every
// run until morning, and without a written record of the last one there is no
// way to tell afterwards that anything was missed. So each firing is stamped on
// disk, and startup compares that stamp against the clock: one catch-up run,
// however long the gap, plus a line in the log saying how many were skipped.
async function armEvery(workflow, node) {
  const every = Math.max(1, Number(node.params?.every) || 15)
  const period = every * (MS[node.params?.unit] ?? MS.minutes)
  const slot = memory.scope(workflow.id, node.id)
  const key = `every:${period}`

  const fire = async () => {
    await slot.set(key, Date.now())
    await runFresh(workflow.id, node.id)
  }

  const last = Number(await slot.get(key)) || 0
  const missed = last ? Math.floor((Date.now() - last) / period) : 0
  if (missed >= 1) {
    // one run, not one per missed slot: catching up on 40 hours of hourly runs
    // by firing 40 times is never what anybody wanted
    broadcast({
      type: 'schedule:missed', workflowId: workflow.id, nodeId: node.id, missed,
      message: `${workflow.name}: ${missed} scheduled run${missed === 1 ? '' : 's'} missed while zorilla was closed. Running once now.`,
    })
    console.log(`${workflow.name}: ${missed} run${missed === 1 ? '' : 's'} missed while closed, running once now`)
    await fire()
  } else if (!last) {
    await slot.set(key, Date.now())
  }

  timers.set(`${workflow.id}:${node.id}`, setInterval(fire, period))
  armed.set(`${workflow.id}:${node.id}`, {
    workflowId: workflow.id,
    nodeId: node.id,
    kind: 'every',
    every,
    unit: node.params?.unit ?? 'minutes',
    nextAt: new Date((Number(await slot.get(key)) || Date.now()) + period).toISOString(),
  })
}

// A one-shot time runs when that moment passes and then never again. The record
// of having fired is keyed by the time itself, so moving the time arms it afresh
// rather than leaving it permanently spent.
async function armOnce(workflow, node) {
  const at = String(node.params?.at ?? '').trim()
  if (!at) return
  const target = new Date(at)
  if (Number.isNaN(target.getTime())) {
    console.warn(`"${at}" is not a date zorilla can read; that step will not fire.`)
    return
  }
  const slot = memory.scope(workflow.id, node.id)
  const stamp = `once:${at}`
  if (await slot.get(stamp)) return

  fireLater(`${workflow.id}:${node.id}`, target.getTime() - Date.now(), async () => {
    await slot.set(stamp, new Date().toISOString())
    await runFresh(workflow.id, node.id)
    armed.delete(`${workflow.id}:${node.id}`)
  })
  armed.set(`${workflow.id}:${node.id}`, {
    workflowId: workflow.id,
    nodeId: node.id,
    kind: 'once',
    nextAt: target.toISOString(),
  })
}

async function rescheduleAll() {
  for (const timer of timers.values()) {
    clearInterval(timer)
    clearTimeout(timer)
  }
  timers.clear()
  armed.clear()

  for (const workflow of await store.listWorkflows()) {
    if (!workflow.active) continue
    for (const node of workflow.nodes ?? []) {
      if (node.type === 'core.schedule') {
        if ((node.params?.mode ?? 'every') === 'once') await armOnce(workflow, node)
        else await armEvery(workflow, node)
        continue
      }
      // A listening step is a schedule with a question attached: the step
      // itself decides what counts as new.
      if (registry.nodes.get(node.type)?.poll) await armEvery(workflow, node)
    }
  }
}

// -- http -------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers })
  res.end(payload)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text }
  }
}

async function serveStatic(url, res) {
  const rel = url === '/' ? 'index.html' : url.slice(1)
  const root = path.resolve(publicDir)
  const file = path.resolve(root, rel)
  // the separator matters: without it, a sibling directory named public-something
  // passes a plain startsWith
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, { error: 'Not allowed.' })
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    send(res, 404, { error: 'Not found.' })
  }
}

async function handleWebhook(req, res, hookPath) {
  const body = await readBody(req)
  const query = Object.fromEntries(new URL(req.url, `http://${HOST}`).searchParams)

  for (const workflow of await store.listWorkflows()) {
    if (!workflow.active) continue
    const node = (workflow.nodes ?? []).find(
      (n) => n.type === 'core.webhook'
        && String(n.params?.path ?? '').replace(/^\//, '') === hookPath
        && (n.params?.method ?? 'POST') === req.method
    )
    if (!node) continue

    // Once this is reachable from the internet the path is the only thing
    // standing between a stranger and a run, which is why a secret can be set.
    const wanted = String(node.params?.secret ?? '').trim()
    if (wanted) {
      const given = String(req.headers['x-zorilla-secret'] ?? query.secret ?? '')
      if (given !== wanted) {
        return send(res, 401, { error: 'That secret does not match.' })
      }
    }
    const run = await runWorkflow(workflow, {
      nodeId: node.id,
      items: [{ json: { body, query, headers: req.headers, method: req.method } }],
    })
    return send(res, run.status === 'ok' ? 200 : 500, { runId: run.runId, status: run.status, error: run.error })
  }
  send(res, 404, { error: `Nothing is listening on /hook/${hookPath}. Check the path and that the workflow is switched on.` })
}

const OWN_ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`])

// A browser sends Origin on every cross-site request and on none of the
// requests a server or a command line makes. Anything arriving from another
// website is refused outright: without this, a page you merely visited can
// write an active workflow into your zorilla, and a workflow can contain a
// code step. Sending no CORS headers is not protection on its own, because a
// text/plain POST is a "simple request" and gets delivered whether or not the
// attacker is allowed to read the answer.
function fromAnotherSite(req) {
  const origin = req.headers.origin
  return Boolean(origin) && !OWN_ORIGINS.has(origin)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`)
  const route = url.pathname

  try {
    // Reading is refused from another site too: the workspace name, the
    // automations in it and the names of your saved keys are nobody else's
    // business. Webhooks are the exception, since they exist to be called from
    // somewhere else.
    if (!route.startsWith('/hook/') && fromAnotherSite(req)) {
      return send(res, 403, { error: 'That request came from another website. zorilla only answers its own page.' })
    }
    // Requiring JSON forces a preflight for anything cross-site, which closes
    // the simple-request hole a second time. Webhooks are exempt: whatever is
    // calling them chooses its own format.
    if (route.startsWith('/api/') && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        return send(res, 415, { error: 'zorilla only accepts application/json here.' })
      }
    }

    if (route.startsWith('/hook/')) return await handleWebhook(req, res, route.slice(6))

    if (route === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      res.write(': connected\n\n')
      listeners.add(res)
      req.on('close', () => listeners.delete(res))
      return
    }

    // Whether the guide still opens on start. Kept in the Zorilla folder rather
    // than the browser, so clearing site data or opening it in another browser
    // does not bring it back for somebody who turned it off.
    if (route === '/api/preferences' && req.method === 'GET') {
      return send(res, 200, await readJson(path.join(home, 'preferences.json'), { guideDone: false }))
    }
    if (route === '/api/preferences' && req.method === 'PUT') {
      const body = await readBody(req)
      const file = path.join(home, 'preferences.json')
      const now = { ...(await readJson(file, {})), ...body }
      await writeJson(file, now, { mode: 0o600 })
      return send(res, 200, now)
    }

    if (route === '/api/workspaces' && req.method === 'GET') {
      return send(res, 200, await workspaces.list(home))
    }
    if (route === '/api/workspaces' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        // an imported one arrives with its automations, so it is created first
        // and then filled, which keeps one path for both
        const made = await workspaces.create(home, String(body.name ?? '').trim() || 'Workspace')
        await openWorkspace(made.id)
        for (const pkg of Array.isArray(body.automations) ? body.automations : []) {
          await store.saveWorkflow({ ...cleanWorkflow(pkg), active: false })
        }
        return send(res, 200, { ...made, ...(await workspaces.list(home)) })
      } catch (err) {
        return send(res, 400, { error: err.message })
      }
    }
    const workspaceMatch = route.match(/^\/api\/workspaces\/([a-z0-9-]+)$/)
    if (workspaceMatch) {
      const id = workspaceMatch[1]
      if (req.method === 'PUT') {
        try {
          await workspaces.choose(home, id)
          await openWorkspace(id)
          return send(res, 200, await workspaces.list(home))
        } catch (err) {
          return send(res, 400, { error: err.message })
        }
      }
      if (req.method === 'DELETE') {
        try {
          const gone = await workspaces.forget(home, id)
          const now = await workspaces.list(home)
          if (workspaceId === id) await openWorkspace(now.current)
          return send(res, 200, { ...now, kept: gone.kept })
        } catch (err) {
          return send(res, 400, { error: err.message })
        }
      }
    }

    // Everything in this workspace as one file: the automations with nothing
    // machine-specific left on them, and never a key value.
    if (route === '/api/workspaces/export' && req.method === 'GET') {
      const all = await store.listWorkflows()
      const full = await Promise.all(all.map((w) => store.getWorkflow(w.id)))
      return send(res, 200, {
        zorilla: 1,
        name: (await store.getWorkspace()).name,
        exportedAt: new Date().toISOString(),
        automations: full.filter(Boolean).map((wf) => ({
          name: wf.name,
          notes: wf.notes ?? '',
          folder: wf.folder ?? '',
          nodes: wf.nodes,
          edges: wf.edges,
        })),
      })
    }

    if (route === '/api/workspace') {
      if (req.method === 'PUT') return send(res, 200, await store.saveWorkspace(await readBody(req)))
      return send(res, 200, await store.getWorkspace())
    }

    if (route === '/api/state') {
      return send(res, 200, {
        port: PORT,
        publicUrl: publicAddress(),
        tunnel: { ...tunnel.status(), installed: await tunnel.isInstalled(), from: tunnel.downloadFrom() },
        home,
        workspace: await store.getWorkspace(),
        nodes: [...registry.nodes.values()].map(describe),
        workflows: await store.listWorkflows(),
        credentials: vault.summary(),
        credentialTypes: [...registry.credentialTypes.values()].map(describeType),
        integrations: [...registry.integrations.values()].map(describeIntegration),
        themes: [...registry.themes.values()],
        runs: await store.listRuns({}),
        armed: [...armed.values()],
        startedAt: STARTED_AT,
        problems: [...registry.problems, ...store.problems],
      })
    }

    if (route === '/api/workflows' && req.method === 'GET') {
      return send(res, 200, await store.listWorkflows())
    }
    // Reading a shared automation before it is anywhere near your workspace:
    // what it contacts, which of your keys it wants, whether it runs code.
    // The examples that came with zorilla, offered rather than installed.
    // What a step remembers belongs to that step, so it is cleared from there
    // rather than by wiring in a node whose only job is forgetting.
    const memoryMatch = route.match(/^\/api\/workflows\/([^/]+)\/memory\/([^/]+)$/)
    if (memoryMatch) {
      const [, workflowId, nodeId] = memoryMatch
      const slot = memory.scope(workflowId, nodeId)
      if (req.method === 'GET') return send(res, 200, { remembers: await slot.everything() })
      if (req.method === 'DELETE') {
        await slot.clear()
        return send(res, 200, { ok: true })
      }
    }

    if (route === '/api/examples' && req.method === 'GET') {
      const out = []
      for (const file of await listJson(exampleDir)) {
        const example = await readJson(path.join(exampleDir, file), null)
        if (!example) continue
        out.push({
          file,
          name: example.name,
          notes: example.notes ?? '',
          nodes: example.nodes,
          edges: example.edges,
          derived: derivePermissions(example, { nodes: registry.nodes, integrations: registry.integrations }),
        })
      }
      return send(res, 200, out)
    }

    if (route === '/api/workflows/inspect' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const workflow = cleanWorkflow(body.package ?? body)
        return send(res, 200, {
          workflow,
          derived: derivePermissions(workflow, { nodes: registry.nodes, integrations: registry.integrations }),
        })
      } catch (err) {
        return send(res, 400, { error: err.message })
      }
    }

    if (route === '/api/workflows/import' && req.method === 'POST') {
      try {
        const body = await readBody(req)
        const workflow = cleanWorkflow(body.package ?? body)
        const saved = await store.saveWorkflow({
          ...workflow,
          folder: String(body.folder ?? 'installed'),
          active: false,
        })
        return send(res, 200, saved)
      } catch (err) {
        return send(res, 400, { error: err.message })
      }
    }

    if (route === '/api/workflows' && req.method === 'POST') {
      const saved = await store.saveWorkflow(await readBody(req))
      await rescheduleAll()
      return send(res, 200, saved)
    }

    const workflowMatch = route.match(/^\/api\/workflows\/([^/]+)(\/run)?$/)
    if (workflowMatch) {
      const [, id, isRun] = workflowMatch
      const workflow = await store.getWorkflow(id)
      if (!workflow) return send(res, 404, { error: 'That workflow no longer exists.' })

      if (isRun && req.method === 'POST') {
        const body = await readBody(req)
        return send(res, 200, await runWorkflow(workflow, { nodeId: body.triggerNodeId ?? null }))
      }
      if (req.method === 'GET') return send(res, 200, workflow)
      if (req.method === 'PUT') {
        const saved = await store.saveWorkflow({ ...(await readBody(req)), id })
        await rescheduleAll()
        return send(res, 200, saved)
      }
      // a PATCH changes a couple of fields without sending the whole graph back
      if (req.method === 'PATCH') {
        const changes = await readBody(req)
        const saved = await store.saveWorkflow({ ...workflow, ...changes, id })
        await rescheduleAll()
        return send(res, 200, saved)
      }
      if (req.method === 'DELETE') {
        await store.removeWorkflow(id)
        await memory.forget(id)
        await rescheduleAll()
        return send(res, 200, { ok: true })
      }
    }

    // what is counting down right now, so "Live" can be checked rather than
    // taken on faith
    if (route === '/api/schedule' && req.method === 'GET') {
      return send(res, 200, { startedAt: STARTED_AT, armed: [...armed.values()] })
    }

    if (route === '/api/runs' && req.method === 'GET') {
      return send(res, 200, await store.listRuns({ workflowId: url.searchParams.get('workflowId') }))
    }
    const runMatch = route.match(/^\/api\/runs\/([^/]+)$/)
    if (runMatch && req.method === 'GET') {
      const run = await store.getRun(runMatch[1])
      return run ? send(res, 200, run) : send(res, 404, { error: 'That run is no longer kept.' })
    }

    if (route === '/api/credentials' && req.method === 'GET') {
      return send(res, 200, vault.summary())
    }
    const testMatch = route.match(/^\/api\/credentials\/([^/]+)\/test$/)
    if (testMatch && req.method === 'POST') {
      const name = decodeURIComponent(testMatch[1])
      const body = await readBody(req)
      // values may be sent unsaved, so a wrong paste is caught before it is stored
      const record = body.values ? { type: body.type ?? 'generic', values: body.values } : vault.read(name)
      const type = registry.credentialTypes.get(record.type)
      const result = await testCredential(type, record.values)
      return send(res, 200, makeScrubber(Object.values(record.values).filter((v) => typeof v === 'string'))(result))
    }

    const credMatch = route.match(/^\/api\/credentials\/([^/]+)$/)
    if (credMatch) {
      const name = decodeURIComponent(credMatch[1])
      if (req.method === 'PUT') {
        const body = await readBody(req)
        const type = registry.credentialTypes.get(body.type ?? 'generic')
        if (!type) return send(res, 400, { error: `There is no key kind called "${body.type}".` })
        const missing = missingFields(type, body.values ?? {})
        if (missing.length) return send(res, 400, { error: `Still needs: ${missing.join(', ')}.` })
        // Checking on save costs one request and turns a saved key from a name
        // into "the webhook called signals, in channel 1234".
        let points = String(body.points ?? '')
        if (!points && type.test) {
          const checked = await testCredential(type, body.values ?? {}).catch(() => null)
          if (checked?.ok && checked.points) points = checked.points
        }
        await vault.set(name, { type: type.type, values: body.values ?? {}, points })
        return send(res, 200, { ok: true, credentials: vault.summary() })
      }
      if (req.method === 'DELETE') {
        await vault.remove(name)
        return send(res, 200, { ok: true, credentials: vault.summary() })
      }
    }

    // Themes are colours and nothing else. Listing them is enough for the page
    // to apply one; the server never needs to know which is showing beyond
    // remembering the choice on the workspace.
    // Opening a tunnel fetches a program the first time, so the page is told
    // what is happening rather than being left on a spinner.
    if (route === '/api/tunnel' && req.method === 'GET') {
      return send(res, 200, { ...tunnel.status(), installed: await tunnel.isInstalled(), from: tunnel.downloadFrom() })
    }
    if (route === '/api/tunnel' && req.method === 'POST') {
      try {
        const state = await tunnel.start(PORT, (message) => broadcast({ type: 'tunnel:progress', message }))
        broadcast({ type: 'tunnel:up', url: state.url })
        return send(res, 200, state)
      } catch (err) {
        return send(res, 400, { error: err.message })
      }
    }
    if (route === '/api/tunnel' && req.method === 'DELETE') {
      const state = tunnel.stop()
      broadcast({ type: 'tunnel:down' })
      return send(res, 200, state)
    }

    if (route === '/api/themes' && req.method === 'GET') {
      return send(res, 200, [...registry.themes.values()])
    }
    if (route === '/api/themes/check' && req.method === 'POST') {
      try {
        return send(res, 200, { ok: true, theme: validateTheme(await readBody(req)) })
      } catch (err) {
        return send(res, 200, { ok: false, error: err.message, tokens: TOKENS })
      }
    }
    if (route === '/api/themes' && req.method === 'POST') {
      try {
        const theme = validateTheme(await readBody(req))
        await writeJson(path.join(userThemeDir, `${theme.id}.json`), {
          id: theme.id, label: theme.label, appearance: theme.appearance,
          author: theme.author, notes: theme.notes, colors: theme.colors,
        })
        registry = await loadEverything()
        return send(res, 200, { ok: true, theme })
      } catch (err) {
        return send(res, 400, { error: err.message })
      }
    }
    const themeMatch = route.match(/^\/api\/themes\/([a-z0-9][a-z0-9-]{1,39})$/)
    if (themeMatch && req.method === 'DELETE') {
      const theme = registry.themes.get(themeMatch[1])
      if (!theme) return send(res, 404, { error: 'No such theme.' })
      if (theme.source !== 'yours') return send(res, 400, { error: 'That theme ships with zorilla, so it cannot be removed.' })
      await removeFile(path.join(userThemeDir, `${theme.id}.json`))
      registry = await loadEverything()
      return send(res, 200, { ok: true })
    }

    if (route === '/api/nodes/reload' && req.method === 'POST') {
      registry = await loadEverything()
      return send(res, 200, { nodes: [...registry.nodes.values()].map(describe), problems: registry.problems })
    }

    // Somebody who does not want to write JSON can hand this to an assistant
    // and paste back what it writes.
    // The reference an agent needs to write an automation, rendered from what
    // this install has actually loaded. DOCS.md in the repo is the same text for
    // the built-ins; this one also lists whatever somebody installed themselves,
    // which is the whole point of asking an agent to use their integration.
    if (route === '/api/agent-doc' && req.method === 'GET') {
      const text = await renderDocs({
        nodes: [...registry.nodes.values()].map(describe),
        credentialTypes: [...registry.credentialTypes.values()].map(describeType),
        specs: [...registry.integrations.values()].map(describeIntegration),
        examplesDir: path.join(here, '../../automations'),
      })
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' })
      return res.end(text)
    }

    if (route === '/api/integration-prompt' && req.method === 'GET') {
      const file = path.join(here, '../../docs/integration-prompt.md')
      try {
        return send(res, 200, { prompt: await readFile(file, 'utf8') })
      } catch {
        return send(res, 404, { error: 'The prompt file is not in this copy of zorilla.' })
      }
    }

    if (route === '/api/integrations' && req.method === 'GET') {
      return send(res, 200, [...registry.integrations.values()].map(describeIntegration))
    }
    if (route === '/api/integrations/check' && req.method === 'POST') {
      try {
        const spec = validateIntegration(await readBody(req))
        return send(res, 200, { ok: true, hosts: spec.hosts, warnings: spec.warnings, actions: spec.actions.length })
      } catch (err) {
        return send(res, 200, { ok: false, error: err.message })
      }
    }
    const integrationMatch = route.match(/^\/api\/integrations\/([a-z][a-z0-9_]*)$/)
    if (integrationMatch) {
      const id = integrationMatch[1]
      const existing = registry.integrations.get(id)
      if (req.method === 'GET') {
        if (!existing) return send(res, 404, { error: `There is no integration called "${id}".` })
        const { file, editable, hosts, warnings, ...spec } = existing
        return send(res, 200, spec)
      }
      if (req.method === 'PUT') {
        if (existing && !existing.editable) {
          return send(res, 400, { error: `"${existing.label}" ships with zorilla. Give yours a different id to keep both.` })
        }
        let spec
        try {
          spec = validateIntegration({ ...(await readBody(req)), id })
        } catch (err) {
          return send(res, 400, { error: err.message })
        }
        const { hosts, warnings, editable, file, ...clean } = spec
        await writeJson(path.join(userIntegrationDir, `${id}.json`), clean, { mode: 0o644 })
        registry = await loadEverything()
        return send(res, 200, { ok: true, hosts: spec.hosts, warnings: spec.warnings })
      }
      if (req.method === 'DELETE') {
        if (!existing) return send(res, 404, { error: 'Already gone.' })
        if (!existing.editable) return send(res, 400, { error: `"${existing.label}" ships with zorilla and cannot be deleted.` })
        await removeFile(existing.file)
        registry = await loadEverything()
        return send(res, 200, { ok: true })
      }
    }

    if (route.startsWith('/api/')) return send(res, 404, { error: 'No such endpoint.' })
    return await serveStatic(route, res)
  } catch (err) {
    const scrub = scrubber()
    // a name or a field the caller got wrong is a 400; 500 is for zorilla
    // breaking, and the difference matters to anything reading the status
    send(res, err.badRequest ? 400 : 500, { error: scrub(err.message) })
  }
})

// The examples ship in ./automations, are copied into a new workspace once, and
// are still offered from the marketplace and the Open a Demo button afterwards.
// Nothing else is installed on anybody's behalf.

await rescheduleAll()

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\n  Port ${PORT} is already being used by something else.\n`
      + '  If that is another Zorilla, open http://127.0.0.1:' + PORT + ' instead.\n'
      + `  Otherwise start this one somewhere else: ZORILLA_PORT=${PORT + 1} npm start\n`
    )
    process.exit(1)
  }
  if (err.code === 'EACCES') {
    console.error(`\n  This machine will not let Zorilla use port ${PORT}. Try ZORILLA_PORT=8080 npm start\n`)
    process.exit(1)
  }
  throw err
})

server.listen(PORT, HOST, () => {
  console.log(`zorilla  http://${HOST}:${PORT}`)
  console.log(`data     ${home}`)
})
