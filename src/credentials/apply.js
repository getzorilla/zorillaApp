const FIELD = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g

export function fill(template, values) {
  if (typeof template === 'string') return template.replace(FIELD, (_, key) => String(values[key] ?? ''))
  if (Array.isArray(template)) return template.map((item) => fill(item, values))
  if (template && typeof template === 'object') {
    return Object.fromEntries(Object.entries(template).map(([k, v]) => [fill(k, values), fill(v, values)]))
  }
  return template
}

// What a request has to carry to authenticate as this credential. Nodes ask for
// this rather than reading the key, so no node has to know how a service
// authenticates and no author has to write the header themselves.
export function applyAuth(type, values) {
  const auth = type?.auth ?? {}
  const headers = fill(auth.headers ?? {}, values)
  const query = fill(auth.query ?? {}, values)
  if (auth.basic) {
    const user = fill(auth.basic.user, values)
    const pass = fill(auth.basic.pass, values)
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  }
  for (const [key, value] of Object.entries(headers)) if (!key || !value) delete headers[key]
  return { headers, query }
}

export function missingFields(type, values) {
  if (!type?.fields) return []
  return type.fields
    .filter((field) => field.required && !String(values?.[field.key] ?? '').trim())
    .map((field) => field.label)
}

// A cheap call that proves the key works, so a wrong paste is caught here
// rather than three steps into a workflow.
// Services say who you are when you check a key: the webhook's name, the bot's
// username, the workspace. Keeping that turns "signals_webhook" into something
// somebody can read.
function describePoint(type, body) {
  if (!type?.identity) return ''
  let parsed = body
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed) } catch { return '' }
  }
  const parts = []
  for (const [label, path] of Object.entries(type.identity)) {
    const value = String(path).split('.').reduce((at, part) => (at == null ? undefined : at[part]), parsed)
    if (value !== undefined && value !== null && value !== '') parts.push(label ? `${label} ${value}` : String(value))
  }
  return parts.join(', ').slice(0, 120)
}

export async function testCredential(type, values) {
  if (!type?.test) return { ok: null, message: 'This kind of key has no check available.' }
  const missing = missingFields(type, values)
  if (missing.length) return { ok: false, message: `Still needs: ${missing.join(', ')}.` }

  const { headers, query } = applyAuth(type, values)
  const url = new URL(fill(type.test.url, values))
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 12_000)
  try {
    const response = await fetch(url, {
      method: type.test.method ?? 'GET',
      headers: { ...headers, ...(type.test.headers ?? {}) },
      signal: controller.signal,
    })
    const body = await response.text()
    // Slack answers 200 with ok:false when a token is bad
    if (response.ok && body.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(body)
        if (parsed.ok === false) return { ok: false, message: `${type.label} rejected it: ${parsed.error ?? 'unknown reason'}` }
      } catch { /* not JSON after all */ }
    }
    if (response.ok) {
      const points = describePoint(type, body)
      return {
        ok: true,
        points,
        message: points ? `${type.label} accepted this key. It points at ${points}.` : `${type.label} accepted this key.`,
      }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, message: `${type.label} did not accept this key.` }
    }
    return { ok: false, message: `${type.label} answered ${response.status}. ${body.slice(0, 120)}` }
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, message: `${type.label} did not answer in time.` }
    return { ok: false, message: `Could not reach ${type.label}: ${err.message}` }
  } finally {
    clearTimeout(timer)
  }
}
