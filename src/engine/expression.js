// {{ }} expressions in node parameters.
//
// Evaluation uses new Function. That is not a sandbox: an expression can reach
// anything the server process can. It sits at the same trust level as the Run
// JavaScript node, and per-node credential scoping is what will eventually
// narrow it. See docs/SIGNING.md.

const ANY = /\{\{[\s\S]*?\}\}/

const cache = new Map()

// Finding the end of an expression is a scan, not a regex. A lazy regex stops
// at the first }} and cuts {{ JSON.stringify({ a: 1 }) }} in half; a greedy one
// swallows everything between the first {{ and the last }}, which silently
// turned "{{ $json.a }} and {{ $json.b }}" into one broken expression. Counting
// braces is the only thing that gets both right.
function findAll(text) {
  const found = []
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] !== '{' || text[i + 1] !== '{') continue
    let depth = 0
    for (let j = i + 2; j < text.length; j++) {
      if (text[j] === '{') depth += 1
      else if (text[j] === '}') {
        if (depth > 0) { depth -= 1; continue }
        if (text[j + 1] !== '}') continue
        found.push({ start: i, end: j + 2, source: text.slice(i + 2, j) })
        i = j + 1
        break
      }
    }
  }
  return found
}

function compile(source) {
  let fn = cache.get(source)
  if (!fn) {
    try {
      fn = new Function(
        '$json', '$index', '$items', '$now', '$creds',
        `"use strict"; return (${source});`
      )
    } catch (err) {
      throw new Error(`Expression {{${source}}} is not valid: ${err.message}`)
    }
    cache.set(source, fn)
  }
  return fn
}

function run(source, ctx) {
  try {
    return compile(source)(ctx.$json, ctx.$index, ctx.$items, ctx.$now, ctx.$creds)
  } catch (err) {
    // "Cannot read properties of undefined" tells somebody nothing about their
    // automation. Which field was missing, and where to look, does.
    const missing = /Cannot read properties of (?:undefined|null) \(reading '([^']+)'\)/.exec(err.message)
    if (missing) {
      throw new Error(`Expression {{${source}}} could not find "${missing[1]}". Open the run log and look at what the step before this one actually sent.`)
    }
    throw new Error(`Expression {{${source}}} failed: ${err.message}`)
  }
}

function stringify(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function hasExpression(value) {
  return typeof value === 'string' && ANY.test(value)
}

// A string that is nothing but one expression keeps the expression's real type,
// so {{ $json.n * 2 }} stays a number. Anything else interpolates to a string.
export function resolveValue(value, ctx) {
  if (typeof value === 'string') {
    if (!ANY.test(value)) return value
    const found = findAll(value)
    if (!found.length) return value
    const [only] = found
    if (found.length === 1 && !value.slice(0, only.start).trim() && !value.slice(only.end).trim()) {
      return run(only.source, ctx)
    }
    let out = ''
    let at = 0
    for (const one of found) {
      out += value.slice(at, one.start) + stringify(run(one.source, ctx))
      at = one.end
    }
    return out + value.slice(at)
  }
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, ctx))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = resolveValue(v, ctx)
    return out
  }
  return value
}

export function makeContext({ item, index, items, creds }) {
  return {
    $json: item ? item.json : {},
    $index: index ?? 0,
    $items: items ?? [],
    $now: new Date(),
    $creds: creds ?? {},
  }
}

export function resolveParams(params, ctx) {
  return resolveValue(params ?? {}, ctx)
}
