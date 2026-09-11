import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { validateIntegration, buildRequest, mapOutput, errorFrom, applyPageMarker, applyPageSize, nextPageMarker } from './spec.js'

const DEFAULT_TIMEOUT = 60_000

function withAttachments(action, request, item) {
  const files = Object.values(item?.binary ?? {})
  if (!action.attachments || !files.length || !request.body) return request
  const payload = JSON.parse(request.body)
  payload[action.attachments.into] = files.map((file) => ({
    [action.attachments.filenameKey]: file.filename,
    [action.attachments.contentKey]: file.data,
    ...(action.attachments.typeKey ? { [action.attachments.typeKey]: file.mime } : {}),
  }))
  return { ...request, body: JSON.stringify(payload) }
}

async function callAction(spec, action, { params, auth, creds, log, item }) {
  if (spec.credential && !params.credential) {
    throw new Error(`Pick a ${spec.label} key first, or add one under Keys.`)
  }
  const values = creds[params.credential] ?? {}
  const applied = spec.credential ? auth(params.credential) : { headers: {}, query: {} }

  const page = action.paging
  const wanted = page ? Math.max(1, Number(params.limit) || page.size) : 0

  const collected = []
  let marker = null
  let pages = 0
  let more = false

  do {
    pages += 1
    let request = buildRequest(action, params, values)
    for (const [key, value] of Object.entries(applied.query)) request.url.searchParams.set(key, value)
    request = withAttachments(action, request, item)

    if (page) {
      request = applyPageSize(page, request)
      request = applyPageMarker(page, request, marker)
    }

    const parsed = await send(spec, action, request, applied, log)
    const items = mapOutput(action, parsed)

    if (!page) return items

    collected.push(...items)
    marker = nextPageMarker(page, parsed, items, collected.length)
    more = marker !== null && marker !== undefined && items.length > 0
  } while (more && collected.length < wanted && pages < (page.maxPages ?? 50))

  const kept = collected.slice(0, wanted)
  // Whether anything was left behind is said out loud, every time. A number
  // that is quietly a hundred rows short is worse than no number.
  if (more && collected.length >= wanted) {
    log(`${kept.length} of them, which is the most you asked for. There are more.`)
  } else {
    log(`${kept.length} in total, across ${pages} request${pages === 1 ? '' : 's'}. That is all of them.`)
  }
  return kept
}

async function send(spec, action, { url, method, headers, body }, applied, log) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), action.timeout ?? DEFAULT_TIMEOUT)

  let response
  try {
    response = await fetch(url, {
      method,
      headers: { ...headers, ...applied.headers },
      body,
      signal: controller.signal,
    })
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`${spec.label} did not answer in time.`)
    throw new Error(`Could not reach ${spec.label}: ${err.message}`)
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  let parsed = text
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { parsed = JSON.parse(text) } catch { /* leave it as text */ }
  }

  if (!response.ok) throw new Error(`${spec.label} said: ${errorFrom(action, parsed, response)}`)

  // Slack and Telegram answer 200 and put the failure in the body
  if (action.okPath && parsed && typeof parsed === 'object') {
    const flag = action.okPath.split('.').reduce((at, part) => (at == null ? undefined : at[part]), parsed)
    if (flag === false) throw new Error(`${spec.label} said: ${errorFrom(action, parsed, response)}`)
  }
  // host only. For a webhook-style key the path is the secret itself, and a
  // run log is the one place it must not turn up.
  log(`${method} ${url.host} → ${response.status}`)
  return parsed
}

const POLL_PARAMS = [
  { key: 'every', label: 'Check every', type: 'number', default: 5, min: 1 },
  {
    key: 'unit', label: 'Unit', type: 'select', default: 'minutes',
    options: [
      { value: 'minutes', label: 'minutes' },
      { value: 'hours', label: 'hours' },
      { value: 'days', label: 'days' },
    ],
  },
]

// A listening step asks on a timer and passes on only what it has not seen.
// What counts as "seen" is remembered on disk, so restarting does not replay
// yesterday's messages.
async function pollAction(spec, action, context) {
  const { memory, log } = context
  const found = await callAction(spec, action, context)
  const seen = (await memory.get('seen')) ?? []
  const known = new Set(seen)

  const idOf = (item) => String(action.trigger.dedupeBy.split('.')
    .reduce((at, part) => (at == null ? undefined : at[part]), item.json) ?? '')

  const fresh = found.filter((item) => {
    const id = idOf(item)
    return id && !known.has(id)
  })

  if (found.length && !fresh.length) {
    log(`Nothing new. ${found.length} already seen.`)
    return []
  }

  const updated = [...seen, ...fresh.map(idOf)].slice(-action.trigger.remember)
  await memory.set('seen', updated)
  log(`${fresh.length} new.`)
  return fresh
}

export function nodesFor(spec) {
  return spec.actions.map((action) => ({
    type: `${spec.id}.${action.key}`,
    label: action.label,
    category: action.trigger ? 'trigger' : (action.category ?? spec.category),
    description: action.description,
    outputs: ['main'],
    integration: spec.id,
    poll: Boolean(action.trigger),
    // what one item looks like on the way out, so the reference an agent reads
    // can say `{{ $json.text }}` rather than leaving it to guess
    hands: action.output ? Object.keys(action.output) : null,
    perRow: Boolean(action.itemsPath),
    params: [
      ...(spec.credential
        ? [{ key: 'credential', label: `${spec.label} key`, type: 'credential', credentialType: spec.id, default: '' }]
        : []),
      ...action.params,
      ...(action.trigger ? POLL_PARAMS : []),
    ],
    run: (context) => (action.trigger ? pollAction(spec, action, context) : callAction(spec, action, context)),
  }))
}

export function credentialTypeFor(spec) {
  if (!spec.credential) return null
  return {
    type: spec.id,
    label: spec.label,
    description: spec.credential.description ?? spec.description,
    docs: spec.docs,
    fields: spec.credential.fields,
    auth: spec.credential.auth ?? {},
    test: spec.credential.test,
    identity: spec.credential.identity ?? null,
    fromIntegration: true,
    hosts: spec.hosts,
    warnings: spec.warnings,
  }
}

// What an install screen shows: the name, what it can do, and every site it
// contacts. All of it read off the file, none of it declared by the author in
// words that could simply be untrue.
export function describeIntegration(spec) {
  return {
    id: spec.id,
    label: spec.label,
    icon: spec.icon ?? null,
    description: spec.description,
    docs: spec.docs,
    category: spec.category,
    editable: Boolean(spec.editable),
    fields: spec.credential?.fields ?? [],
    hosts: spec.hosts,
    warnings: spec.warnings,
    actions: spec.actions.map((a) => ({ key: a.key, label: a.label, description: a.description })),
  }
}

async function loadDir(dir, into, problems, editable) {
  let entries = []
  try {
    entries = await readdir(dir)
  } catch {
    return
  }
  for (const name of entries.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name)
    try {
      const spec = validateIntegration(JSON.parse(await readFile(file, 'utf8')))
      spec.editable = editable
      spec.file = file
      into.set(spec.id, spec)
    } catch (err) {
      problems.push({ file, message: err.message })
    }
  }
}

export async function loadIntegrations({ builtinDir, userDir }) {
  const integrations = new Map()
  const problems = []
  await loadDir(builtinDir, integrations, problems, false)
  if (userDir) await loadDir(userDir, integrations, problems, true)
  return { integrations, problems }
}
