// Plenty of APIs send JSON under text/plain, and a body handed on as a string
// breaks every expression downstream without ever raising an error. So the
// shape of the body decides, not the header, which is what integrations already
// do. A body that only looks like JSON and is not stays a string.
const TEXTUAL = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|ld\+json))/i

function isFile(contentType) {
  const type = String(contentType).split(';')[0].trim()
  if (!type) return false
  return !TEXTUAL.test(type)
}

// Content-Disposition first, then the last part of the address, then a default.
function nameFrom(response, url) {
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
  if (match) return decodeURIComponent(match[1])
  const last = String(url).split('?')[0].split('/').filter(Boolean).pop()
  return last && last.includes('.') ? last : 'download'
}

function parseBody(text, contentType) {
  const trimmed = text.trim()
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  if (contentType?.includes('json') || looksJson) {
    try { return JSON.parse(trimmed) } catch { return text }
  }
  return text
}

export default {
  type: 'net.http',
  label: 'HTTP request',
  category: 'action',
  description: 'Calls a URL, passes the response on.',
  outputs: ['main'],
  params: [
    {
      key: 'method', label: 'Method', type: 'select', default: 'GET',
      description: 'GET reads, POST sends. The rest are for services that ask for them.',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((v) => ({ value: v, label: v })),
    },
    { key: 'url', label: 'URL', type: 'text', default: '', placeholder: 'https://api.example.com/things',
      description: 'The whole address, including https://. Expressions work: .../users/{{ $json.id }}.' },
    { key: 'credential', label: 'Use a saved key', type: 'credential', default: '', required: false,
      description: 'Adds what the service needs to authenticate. No header to write.' },
    { key: 'headers', label: 'Extra headers', type: 'keyvalue', default: [],
      description: 'Anything the service asks for beyond the key, like Accept or a version header.' },
    { key: 'sendBody', label: 'Send a body', type: 'boolean', default: false,
      description: 'Off for a GET. On when you are sending something with the request.' },
    {
      key: 'bodyType', label: 'Body format', type: 'select', default: 'json',
      description: 'Json for most APIs, form for old ones that want name=value pairs.',
      options: [
        { value: 'json', label: 'JSON' },
        { value: 'text', label: 'Plain text' },
        { value: 'form', label: 'Form fields' },
      ],
      showWhen: { sendBody: true },
    },
    { key: 'body', label: 'Body', type: 'textarea', default: '', showWhen: { sendBody: true },
      description: 'What to send. Expressions work here too.' },
    { key: 'timeout', label: 'Timeout (seconds)', type: 'number', default: 30, min: 1,
      description: 'How long to wait before giving up on a service that is not answering.' },
    { key: 'failOnError', label: 'Stop on an error status', type: 'boolean', default: true,
      description: 'On, a 404 or a 500 fails the step. Off, the answer carries on with ok: false so a later step can decide.' },
  ],
  async run({ params, auth, log }) {
    const url = String(params.url ?? '').trim()
    if (!url) throw new Error('No URL was set. Fill in the URL field.')
    if (!/^https?:\/\//i.test(url)) throw new Error(`"${url}" is not a web address. It needs to start with http:// or https://`)

    const headers = {}
    for (const row of params.headers ?? []) {
      if (row?.name) headers[row.name] = String(row.value ?? '')
    }

    // The saved key wins over a hand-written header of the same name: picking a
    // key and then being authenticated as something else would be worse.
    const target = new URL(url)
    if (params.credential) {
      const applied = auth(params.credential)
      for (const [key, value] of Object.entries(applied.headers)) {
        if (headers[key] !== undefined && headers[key] !== value) {
          log(`The saved key "${params.credential}" replaced your ${key} header.`)
        }
        headers[key] = value
      }
      for (const [key, value] of Object.entries(applied.query)) target.searchParams.set(key, value)
    }

    let body
    if (params.sendBody) {
      if (params.bodyType === 'json') {
        const raw = params.body
        body = typeof raw === 'string' ? raw : JSON.stringify(raw)
        if (typeof raw === 'string' && raw.trim()) {
          try { JSON.parse(raw) } catch (err) {
            throw new Error(`The body is not valid JSON: ${err.message}`)
          }
        }
        headers['content-type'] ??= 'application/json'
      } else if (params.bodyType === 'form') {
        const form = new URLSearchParams()
        const raw = typeof params.body === 'string' ? JSON.parse(params.body || '{}') : (params.body ?? {})
        for (const [k, v] of Object.entries(raw)) form.append(k, String(v))
        body = form.toString()
        headers['content-type'] ??= 'application/x-www-form-urlencoded'
      } else {
        body = String(params.body ?? '')
      }
    }

    const controller = new AbortController()
    const seconds = Number(params.timeout) || 30
    const timer = setTimeout(() => controller.abort(), seconds * 1000)

    let response
    try {
      response = await fetch(target, { method: params.method || 'GET', headers, body, signal: controller.signal, redirect: 'follow' })
    } catch (err) {
      if (err.name === 'AbortError') throw new Error(`${url} did not answer within ${seconds} seconds.`)
      throw new Error(`Could not reach ${url}: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }

    const contentType = response.headers.get('content-type') ?? ''
    // Anything that is not text comes back as a file rather than as a string
    // that has already lost its bytes.
    if (isFile(contentType)) {
      const bytes = Buffer.from(await response.arrayBuffer())
      log(`${params.method || 'GET'} ${url} → ${response.status}, ${bytes.length} bytes`)
      if (!response.ok && params.failOnError) {
        throw new Error(`${url} answered ${response.status} ${response.statusText}.`)
      }
      return [{
        json: { status: response.status, ok: response.ok, headers: Object.fromEntries(response.headers), file: nameFrom(response, url) },
        binary: {
          file: {
            filename: nameFrom(response, url),
            mime: contentType.split(';')[0].trim() || 'application/octet-stream',
            size: bytes.length,
            data: bytes.toString('base64'),
          },
        },
      }]
    }

    const text = await response.text()
    const parsed = parseBody(text, contentType)
    log(`${params.method || 'GET'} ${url} → ${response.status}`)

    if (!response.ok && params.failOnError) {
      const detail = typeof parsed === 'string' ? parsed.slice(0, 200) : JSON.stringify(parsed).slice(0, 200)
      throw new Error(`${url} answered ${response.status} ${response.statusText}. It said: ${detail || '(nothing)'}`)
    }

    return [{
      json: {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers),
        body: parsed,
      },
    }]
  },
}
