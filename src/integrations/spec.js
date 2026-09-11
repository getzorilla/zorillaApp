// An integration is data, never code.
//
// That is the whole point. A shared integration is a JSON file describing what
// a service needs and what requests to make, so installing one from somebody
// else cannot run anything on your machine, and the hosts it contacts can be
// read straight off the file and shown to you before you install it.
//
// Two substitutions exist and they are deliberately small:
//   {{ paramKey }}        a value from the step, already resolved by the engine
//   {{ key.fieldName }}   a field from the saved key this step is using
// Neither can reach $json, $creds, or anything else. An integration only ever
// sees what the step was handed.

const TOKEN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g
const WHOLE = /^\s*\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}\s*$/

function lookup(scope, path) {
  return path.split('.').reduce((at, part) => (at == null ? undefined : at[part]), scope)
}

// Replacement text is inserted verbatim, never rescanned, so a value that
// happens to contain braces is not treated as a template.
export function template(value, scope, where = 'This integration') {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE)
    if (whole) {
      const found = lookup(scope, whole[1])
      if (found === undefined) throw new Error(`${where} needs ${whole[1]}, which was left blank.`)
      return found
    }
    return value.replace(TOKEN, (_, path) => {
      const found = lookup(scope, path)
      if (found === undefined) throw new Error(`${where} needs ${path}, which was left blank.`)
      return typeof found === 'object' ? JSON.stringify(found) : String(found)
    })
  }
  if (Array.isArray(value)) return value.map((item) => template(item, scope, where))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [template(k, scope, where), template(v, scope, where)])
    )
  }
  return value
}

function tokensIn(value, found = []) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(TOKEN)) found.push(match[1])
  } else if (Array.isArray(value)) {
    for (const item of value) tokensIn(item, found)
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      tokensIn(k, found)
      tokensIn(v, found)
    }
  }
  return found
}

// The site an action contacts has to be readable without running anything.
// Either it is written out, or the whole address comes from a field you filled
// in yourself — both of which can be shown on an install screen.
export function hostOf(urlTemplate, spec) {
  const url = String(urlTemplate ?? '').trim()
  const fromField = url.match(/^\{\{\s*key\.([a-zA-Z0-9_]+)\s*\}\}/)
  if (fromField) {
    const field = spec.credential?.fields?.find((f) => f.key === fromField[1])
    return { host: null, note: `a web address you provide (${field?.label ?? fromField[1]})` }
  }
  const parsed = url.match(/^(https?):\/\/([^/?#]+)/i)
  if (!parsed) {
    throw new Error(`"${url}" has to start with https:// and a site name, so people can see what this contacts.`)
  }
  if (parsed[2].includes('{{')) {
    throw new Error(`The site name in "${url}" is filled in at run time, so nobody can tell what this contacts. Put the changing part after the first slash.`)
  }
  return { host: parsed[2], insecure: parsed[1].toLowerCase() === 'http' }
}

const PARAM_TYPES = ['text', 'textarea', 'number', 'boolean', 'select', 'code', 'keyvalue', 'list', 'datetime']

export function validateIntegration(input) {
  const spec = structuredClone(input)
  const fail = (message) => { throw new Error(message) }

  // The id becomes the first half of every function this integration adds
  // (resend.send), and those are matched exactly, so it is lowercased here
  // rather than refused for a capital letter somebody did not mean to type.
  spec.id = String(spec.id ?? '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9_]*$/.test(spec.id)) {
    fail('An integration needs a short id: a letter first, then letters, numbers or underscores. Like "resend" or "my_api".')
  }
  if (!spec.label) fail(`Integration "${spec.id}" needs a name people will recognise.`)

  // An icon is a picture, not a link and not a drawing that can carry script:
  // an inline png, jpeg or webp, small enough to sit in the file.
  if (spec.icon) {
    const icon = String(spec.icon)
    if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(icon)) {
      fail(`The icon for "${spec.label}" has to be a png, jpeg or webp pasted into the file. Addresses and svg are not accepted.`)
    }
    if (icon.length > 200_000) fail(`The icon for "${spec.label}" is too big. Use one around 128 pixels square.`)
    spec.icon = icon
  }
  spec.description ??= ''
  spec.category ??= 'action'
  spec.actions ??= []
  if (!Array.isArray(spec.actions) || !spec.actions.length) {
    fail(`"${spec.label}" has no steps. An integration needs at least one thing it can do.`)
  }

  const credential = spec.credential ?? null
  const secrets = new Set()
  if (credential) {
    if (!Array.isArray(credential.fields) || !credential.fields.length) {
      fail(`"${spec.label}" needs at least one field for the key.`)
    }
    for (const field of credential.fields) {
      if (!/^[a-zA-Z0-9_]+$/.test(String(field.key ?? ''))) fail(`"${spec.label}" has a field with no usable name.`)
      if (!field.label) field.label = field.key
      if (field.secret) secrets.add(field.key)
    }
  }

  const hosts = []
  const warnings = []
  const seenKeys = new Set()
  // a key sent in the web address is a key sent in the web address, whether the
  // integration puts it there or the credential's own auth does
  const queryTokens = tokensIn(credential?.auth?.query ?? {})

  for (const action of spec.actions) {
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(String(action.key ?? ''))) fail(`"${spec.label}" has a step with no usable id.`)
    if (seenKeys.has(action.key)) fail(`"${spec.label}" has two steps called "${action.key}".`)
    seenKeys.add(action.key)
    if (!action.label) fail(`Step "${action.key}" in "${spec.label}" needs a name.`)
    action.params ??= []
    action.paging = validatePagination(action, fail)

    // Sending a file is not something a template can express, so the file says
    // where the attachments go and the runner fills them in.
    if (action.attachments) {
      if (!action.attachments.into) fail(`"${action.label}" says it sends files but not where they go.`)
      action.attachments = {
        into: String(action.attachments.into),
        filenameKey: String(action.attachments.filenameKey ?? 'filename'),
        contentKey: String(action.attachments.contentKey ?? 'content'),
        typeKey: action.attachments.typeKey ? String(action.attachments.typeKey) : null,
      }
    }

    // An action can also be something to wait for rather than something to do.
    // It still describes one request; the difference is that zorilla asks over
    // and over and only passes on what it has not seen before.
    if (action.trigger) {
      if (!action.itemsPath) fail(`"${action.label}" listens for new things but never says where the list is.`)
      if (!action.trigger.dedupeBy) fail(`"${action.label}" needs to say which field tells two of them apart.`)
      action.trigger = { dedupeBy: String(action.trigger.dedupeBy), remember: Math.min(5000, Number(action.trigger.remember) || 500) }
    }
    action.description ??= ''
    for (const param of action.params) {
      if (!/^[a-zA-Z0-9_]+$/.test(String(param.key ?? ''))) fail(`Step "${action.label}" has a field with no usable name.`)
      param.type ??= 'text'
      if (!PARAM_TYPES.includes(param.type)) fail(`"${param.type}" is not a kind of field zorilla can draw.`)
      if (!param.label) param.label = param.key
    }

    const request = action.request
    if (!request?.url) fail(`Step "${action.label}" has no web address.`)
    request.method = String(request.method ?? 'GET').toUpperCase()
    const where = hostOf(request.url, spec)
    if (where.host) hosts.push(where.host)
    if (where.note) hosts.push(where.note)
    if (where.insecure) warnings.push(`${action.label} contacts an unencrypted address.`)

    // A key in a web address ends up in server logs and browser history all the
    // way along the route. Some services still require it; say so out loud
    // rather than pretending it did not happen.
    // an action's templates name fields as key.thing; a credential's own auth
    // names them bare
    const inAddress = tokensIn(request.query ?? {})
      .filter((t) => t.startsWith('key.'))
      .map((t) => t.slice(4))
      .concat(queryTokens)
    if (inAddress.some((field) => secrets.has(field))) {
      warnings.push(`${action.label} puts your key in the web address, where it can be logged along the way.`)
    }
    const bodyKinds = ['json', 'form', 'text', 'jsonFrom'].filter((k) => request[k] !== undefined)
    if (bodyKinds.length > 1) {
      fail(`Step "${action.label}" describes its body ${bodyKinds.length} different ways (${bodyKinds.join(', ')}). Pick one.`)
    }
    if (request.jsonFrom && !action.params.some((p) => p.key === request.jsonFrom)) {
      fail(`Step "${action.label}" builds its body from "${request.jsonFrom}", but has no field by that name.`)
    }
    for (const [key, source] of Object.entries(action.fallbacks ?? {})) {
      if (typeof source !== 'string') fail(`The fallback for "${key}" in "${action.label}" has to be a piece of text.`)
    }
    action.stripEmpty ??= true
  }

  spec.hosts = [...new Set(hosts)]
  spec.warnings = [...new Set(warnings)]
  return spec
}

export function buildRequest(action, params, keyFields) {
  const scope = { ...params, key: keyFields }
  const where = `"${action.label}"`
  const request = action.request

  // A blank field can fall back to something saved with the key, so "sender"
  // can be filled in once rather than on every step that sends mail.
  for (const [key, source] of Object.entries(action.fallbacks ?? {})) {
    const current = scope[key]
    if (current === undefined || current === null || current === '') {
      scope[key] = template(source, scope, where)
    }
  }

  const url = new URL(template(request.url, scope, where))
  for (const [key, value] of Object.entries(template(request.query ?? {}, scope, where))) {
    if (value !== '' && value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }

  const headers = template(request.headers ?? {}, scope, where)
  let body
  if (request.json) {
    let payload = template(request.json, scope, where)
    if (action.stripEmpty && payload && typeof payload === 'object' && !Array.isArray(payload)) {
      payload = Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== '' && v !== undefined))
    }
    body = JSON.stringify(payload)
    headers['content-type'] ??= 'application/json'
  } else if (request.form) {
    const form = new URLSearchParams()
    for (const [key, value] of Object.entries(template(request.form, scope, where))) {
      if (value !== '' && value !== undefined && value !== null) form.append(key, String(value))
    }
    body = form.toString()
    headers['content-type'] ??= 'application/x-www-form-urlencoded'
  } else if (request.jsonFrom) {
    body = JSON.stringify(objectFrom(params[request.jsonFrom], request.jsonFrom, where))
    headers['content-type'] ??= 'application/json'
  } else if (request.text !== undefined) {
    body = String(template(request.text, scope, where))
  }

  return { url, method: request.method, headers, body }
}

// Accepts either the name/value rows the editor draws, or raw JSON typed by
// hand, so an integration author picks whichever suits the service.
function objectFrom(value, field, where) {
  if (Array.isArray(value)) {
    return Object.fromEntries(value.filter((row) => row?.name).map((row) => [row.name, row.value]))
  }
  if (typeof value === 'string') {
    if (!value.trim()) return {}
    try {
      return JSON.parse(value)
    } catch (err) {
      throw new Error(`${where} needs valid JSON in ${field}: ${err.message}`)
    }
  }
  return value ?? {}
}

// How a service hands back the next page. Declared, never coded: the file says
// where the next cursor lives and where it goes back in, and the runner does
// the asking. Without this a list step returns the first page and says nothing
// about the rest, which is worse than refusing.
const PAGE_SOURCES = ['cursor', 'lastItem', 'count', 'page']

export function validatePagination(action, fail) {
  const page = action.pagination
  if (!page) return null
  const where = `"${action.label}"`
  const source = PAGE_SOURCES.find((k) => page.next && k in page.next)
  if (!source) fail(`${where} describes paging but not how to find the next page. Use one of: ${PAGE_SOURCES.join(', ')}.`)
  if (!page.into || typeof page.into !== 'object') fail(`${where} does not say where the next page marker goes.`)
  const target = ['query', 'json'].find((k) => k in page.into)
  if (!target) fail(`${where} has to put the next page marker in query or json.`)
  if (!action.itemsPath) fail(`${where} pages through a list but never says where the list is.`)
  return {
    ...page,
    source,
    target,
    size: Math.max(1, Number(page.size) || 100),
  }
}

// Where the next page marker goes into the request that was already built.
export function applyPageMarker(page, { url, body, headers }, marker) {
  if (marker === null || marker === undefined || marker === '') return { url, body, headers }
  if (page.target === 'query') {
    url.searchParams.set(page.into.query, String(marker))
    return { url, body, headers }
  }
  const payload = body ? JSON.parse(body) : {}
  payload[page.into.json] = marker
  return { url, body: JSON.stringify(payload), headers: { ...headers, 'content-type': headers['content-type'] ?? 'application/json' } }
}

export function applyPageSize(page, { url, body, headers }) {
  if (!page.sizeInto) return { url, body, headers }
  if (page.sizeInto.query) {
    url.searchParams.set(page.sizeInto.query, String(page.size))
    return { url, body, headers }
  }
  const payload = body ? JSON.parse(body) : {}
  payload[page.sizeInto.json] = page.size
  return { url, body: JSON.stringify(payload), headers: { ...headers, 'content-type': headers['content-type'] ?? 'application/json' } }
}

// The marker for the page after this one, or null when the service says there
// is nothing left.
export function nextPageMarker(page, body, items, taken) {
  if (page.more !== undefined) {
    const flag = String(page.more).split('.').reduce((at, part) => (at == null ? undefined : at[part]), body)
    if (flag === false) return null
  }
  if (page.source === 'cursor') {
    const value = String(page.next.cursor).split('.').reduce((at, part) => (at == null ? undefined : at[part]), body)
    return value ?? null
  }
  if (page.source === 'lastItem') {
    const last = items[items.length - 1]
    if (!last) return null
    const value = String(page.next.lastItem).split('.').reduce((at, part) => (at == null ? undefined : at[part]), last.json ?? last)
    return value ?? null
  }
  // a service that counts rather than points: stop as soon as a page is short
  if (items.length < page.size) return null
  if (page.source === 'count') return taken
  return Math.floor(taken / page.size) + 1
}

export function mapOutput(action, body) {
  const pick = (source) => {
    if (!action.output || action.output === '$') return source
    const out = {}
    for (const [key, path] of Object.entries(action.output)) {
      out[key] = path === '$' ? source : lookup(source, path)
    }
    return out
  }

  if (action.itemsPath) {
    const list = action.itemsPath === '$' ? body : lookup(body, action.itemsPath)
    if (!Array.isArray(list)) return [{ json: pick(body) }]
    return list.map((entry) => ({ json: pick(entry) }))
  }
  const picked = pick(body)
  return [{ json: picked && typeof picked === 'object' && !Array.isArray(picked) ? picked : { result: picked } }]
}

export function errorFrom(action, body, response) {
  if (action.errorPath) {
    const found = lookup(body, action.errorPath)
    if (found) return typeof found === 'string' ? found : JSON.stringify(found)
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 200)
  if (body && typeof body === 'object') return JSON.stringify(body).slice(0, 200)
  return `${response.status} ${response.statusText}`
}
