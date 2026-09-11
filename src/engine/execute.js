import { randomUUID } from 'node:crypto'
import { indexGraph, toposort } from './graph.js'
import { makeContext, resolveParams } from './expression.js'
import { scratchMemory } from '../storage/memory.js'

const MAIN = 'main'

function outputsOf(def, node) {
  const ports = def.outputs?.length ? [...def.outputs] : [MAIN]
  if (node?.onError === 'errorOutput' && !ports.includes('error')) ports.push('error')
  return ports
}

function labelOf(node, def) {
  return node.name || def?.label || node.type
}

function emptyPorts(def, node) {
  const out = {}
  for (const port of outputsOf(def, node)) out[port] = []
  return out
}

// Every node speaks [{ json }] in and out. This is the only place that shape is
// enforced, and it is enforced rather than coerced: a node returning the wrong
// thing is a bug in the node, and silently reshaping it hides that bug until it
// surfaces somewhere far away.
function normalize(result, def, inputItems, label, node) {
  // returning nothing passes the input straight through, so a node that only
  // logs or asserts does not silently kill the branch below it
  if (result === undefined || result === null) {
    return { ...emptyPorts(def, node), [outputsOf(def, node)[0]]: inputItems }
  }

  const ports = outputsOf(def, node)
  let byPort
  if (Array.isArray(result)) byPort = { [ports[0]]: result }
  else if (typeof result === 'object') byPort = result
  else throw new Error(`${label} returned a ${typeof result}. Nodes return a list of items.`)

  const out = emptyPorts(def, node)
  for (const [port, items] of Object.entries(byPort)) {
    if (!ports.includes(port)) {
      throw new Error(`${label} sent items to an output called "${port}", but it declares: ${ports.join(', ')}.`)
    }
    if (!Array.isArray(items)) {
      throw new Error(`${label} sent something other than a list to output "${port}".`)
    }
    for (const item of items) {
      if (!item || typeof item !== 'object' || !('json' in item)) {
        throw new Error(`${label} returned an item with no json property. Every item looks like { json: { ... } }.`)
      }
      // An item may also carry files, under binary. Steps that know nothing
      // about files pass them along untouched.
      if (item.binary !== undefined && (typeof item.binary !== 'object' || item.binary === null)) {
        throw new Error(`${label} returned an item whose files are not a set of named files.`)
      }
      out[port].push(item)
    }
  }
  return out
}

function merge(into, add) {
  for (const [port, items] of Object.entries(add)) {
    into[port] = (into[port] ?? []).concat(items)
  }
  return into
}

function format(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try { return JSON.stringify(value) } catch { return String(value) }
}

const noAuth = () => ({ headers: {}, query: {} })

// A step sees the keys it names and nothing else. The install screen says
// "uses your saved keys: my_slack", and this is what makes that a rule rather
// than a description: the other keys are not in the room.
function keysNamedBy(def, params) {
  const named = new Set()
  for (const param of def.params ?? []) {
    if (param.type !== 'credential') continue
    const value = params?.[param.key]
    if (value) named.add(String(value))
  }
  return named
}

function scopeCreds(named, creds) {
  const scoped = {}
  for (const name of named) if (creds[name]) scoped[name] = creds[name]
  return scoped
}

function scopeAuth(named, authFor, label) {
  return (name) => {
    if (name && !named.has(String(name))) {
      throw new Error(`${label} asked for a key it does not use ("${name}"). A step only gets the keys chosen on it.`)
    }
    return authFor(name)
  }
}

export async function execute({
  graph, nodes, creds = {}, authFor = noAuth,
  memoryFor = scratchMemory(), trigger = null, onEvent = () => {},
}) {
  const index = indexGraph(graph)
  const runId = randomUUID()
  const run = {
    runId,
    workflowId: graph.id ?? null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    error: null,
    nodes: {},
  }

  const finish = () => {
    run.finishedAt = new Date().toISOString()
    if (run.status === 'running') run.status = 'ok'
    onEvent({ type: 'run:end', runId, status: run.status, error: run.error })
    return run
  }

  const { order, cycle } = toposort(index)
  if (!order) {
    const names = cycle.map((id) => {
      const node = index.nodes.get(id)
      return labelOf(node, nodes.get(node.type))
    })
    run.status = 'failed'
    run.error = `These steps feed back into each other and would never finish: ${names.join(' → ')}. Remove one of the connections between them.`
    return finish()
  }

  onEvent({ type: 'run:start', runId, workflowId: run.workflowId })

  const results = new Map()
  const stop = (reason = '') => {
    run.stopRequested = true
    run.stopReason = reason
  }

  for (const id of order) {
    const node = index.nodes.get(id)
    const def = nodes.get(node.type)
    const label = labelOf(node, def)
    const inEdges = index.incoming.get(id)

    const skip = (reason) => {
      results.set(id, { status: 'skipped', outputs: {} })
      run.nodes[id] = { status: 'skipped', ms: 0, itemsIn: 0, itemsOut: {}, reason, logs: [] }
      onEvent({ type: 'node:end', runId, nodeId: id, status: 'skipped', reason })
    }

    if (!def) {
      results.set(id, { status: 'error', outputs: {} })
      run.nodes[id] = {
        status: 'error', ms: 0, itemsIn: 0, itemsOut: {}, logs: [],
        error: `This workflow uses a step called "${node.type}" that is not installed.`,
      }
      run.status = 'failed'
      onEvent({ type: 'node:end', runId, nodeId: id, status: 'error', error: run.nodes[id].error })
      continue
    }

    // Roots are triggers. When a run names its trigger, the other triggers in
    // the workflow sit this one out.
    let items
    if (inEdges.length === 0) {
      if (trigger?.nodeId && trigger.nodeId !== id) {
        skip('Not the trigger for this run')
        continue
      }
      items = trigger?.items?.length ? trigger.items : [{ json: {} }]
    } else {
      items = []
      for (const edge of index.edges) {
        if (edge.to !== id) continue
        const source = results.get(edge.from)
        if (!source || source.status !== 'ran') continue
        items = items.concat(source.outputs[edge.fromPort] ?? [])
      }
      if (items.length === 0) {
        skip('No items reached this function')
        continue
      }
    }

    const defaults = Object.fromEntries((def.params ?? []).map((p) => [p.key, p.default ?? '']))
    const raw = { ...defaults, ...(node.params ?? {}) }

    // A step logging once per item over ten thousand items writes a run file
    // nobody can open. The first few hundred lines are what anybody reads.
    const LOG_LIMIT = 200
    const logs = []
    let dropped = 0
    const log = (...args) => {
      const message = args.map(format).join(' ')
      if (logs.length < LOG_LIMIT) logs.push({ ts: new Date().toISOString(), message })
      else dropped += 1
      onEvent({ type: 'node:log', runId, nodeId: id, message })
    }
    const closeLog = () => {
      if (dropped) logs.push({ ts: new Date().toISOString(), message: `…and ${dropped.toLocaleString()} more lines, not kept.` })
      return logs
    }

    onEvent({ type: 'node:start', runId, nodeId: id, itemsIn: items.length })
    const started = Date.now()

    // Most failures are a service having a bad minute. Try again a couple of
    // times before deciding it is broken, then do whatever the step was set to
    // do about it.
    const tries = Math.min(5, Math.max(0, Number(node.retries) || 0)) + 1
    const wait = Math.min(60_000, Math.max(0, Number(node.retryWait) || 2000))
    let attempt = 0
    let lastError = null

    while (attempt < tries) {
      attempt += 1
      try {
        // named from the raw parameters first, so an expression cannot widen
        // what a step can reach by resolving to some other key's name
        const declared = keysNamedBy(def, raw)
        const mine = scopeCreds(declared, creds)
        const auth = scopeAuth(declared, authFor, label)

        let outputs
        if (def.mode === 'batch') {
          const ctx = makeContext({ item: items[0], index: 0, items, creds: mine })
          const params = resolveParams(raw, ctx)
          const paramsFor = (i) =>
            resolveParams(raw, makeContext({ item: items[i], index: i, items, creds: mine }))
          outputs = normalize(await def.run({ params, paramsFor, items, creds: mine, auth, memory: memoryFor(id), stop, log, node }), def, items, label, node)
        } else {
          outputs = emptyPorts(def, node)
          for (let i = 0; i < items.length; i++) {
            const ctx = makeContext({ item: items[i], index: i, items, creds: mine })
            const params = resolveParams(raw, ctx)
            const one = [items[i]]
            merge(outputs, normalize(
              await def.run({ params, item: items[i], items: one, index: i, creds: mine, auth, memory: memoryFor(id), stop, log, node }),
              def, one, label, node
            ))
          }
        }

        const itemsOut = Object.fromEntries(Object.entries(outputs).map(([p, v]) => [p, v.length]))
        results.set(id, { status: 'ran', outputs })
        run.nodes[id] = { status: 'ok', ms: Date.now() - started, itemsIn: items.length, itemsOut, logs: closeLog(), attempts: attempt }
        onEvent({ type: 'node:end', runId, nodeId: id, status: 'ok', itemsOut })
        lastError = null
        break
      } catch (err) {
        lastError = err
        if (attempt < tries) {
          log(`${err.message} — trying again (${attempt} of ${tries - 1})`)
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
    }

    if (lastError) {
      const message = lastError?.message ? `${label} failed: ${lastError.message}` : `${label} failed.`
      const failure = { error: message, step: label, at: new Date().toISOString() }

      if (node.onError === 'continue') {
        // the items carry on with the failure attached, so the rest of the
        // workflow can decide what to do about it
        const carried = items.map((item) => ({ json: { ...item.json, error: message } }))
        const outputs = { ...emptyPorts(def, node), [outputsOf(def, node)[0]]: carried }
        results.set(id, { status: 'ran', outputs })
        run.nodes[id] = {
          status: 'error', ms: Date.now() - started, itemsIn: items.length,
          itemsOut: { [outputsOf(def, node)[0]]: carried.length }, error: message, logs: closeLog(), attempts: attempt, carriedOn: true,
        }
        onEvent({ type: 'node:end', runId, nodeId: id, status: 'error', error: message })
      } else if (node.onError === 'errorOutput') {
        const outputs = { ...emptyPorts(def, node), error: [{ json: failure }] }
        results.set(id, { status: 'ran', outputs })
        run.nodes[id] = {
          status: 'error', ms: Date.now() - started, itemsIn: items.length,
          itemsOut: { error: 1 }, error: message, logs: closeLog(), attempts: attempt, carriedOn: true,
        }
        onEvent({ type: 'node:end', runId, nodeId: id, status: 'error', error: message })
      } else {
        // one failed step does not stop branches that do not depend on it
        results.set(id, { status: 'error', outputs: {} })
        run.nodes[id] = { status: 'error', ms: Date.now() - started, itemsIn: items.length, itemsOut: {}, error: message, logs: closeLog(), attempts: attempt }
        onEvent({ type: 'node:end', runId, nodeId: id, status: 'error', error: message })
      }
      run.status = 'failed'
    }
  }

  return finish()
}
