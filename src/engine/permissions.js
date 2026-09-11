// What an automation can actually do, worked out by walking it.
//
// Never read from anything its author wrote: an author who could write their
// own permission list would write a flattering one. Everything here comes from
// the steps themselves and the integration files they use.

export function derivePermissions(workflow, { nodes, integrations }) {
  const hosts = new Set()
  const credentials = new Set()
  const unknown = new Set()
  const triggers = new Set()
  let runsCode = false
  let readsChain = false
  let buildsTransaction = false
  let writesFiles = false

  for (const node of workflow.nodes ?? []) {
    const def = nodes.get(node.type)
    if (!def) {
      unknown.add(node.type)
      continue
    }

    if (def.category === 'trigger') triggers.add(def.label)
    if (node.type === 'code.js') runsCode = true
    if (def.category === 'web3') readsChain = true
    if (node.type === 'web3.prepare') buildsTransaction = true
    if (node.type === 'file.save') writesFiles = true

    if (def.integration) {
      for (const host of integrations.get(def.integration)?.hosts ?? []) hosts.add(host)
    }
    if (node.type === 'net.http') {
      const url = String(node.params?.url ?? '')
      try {
        hosts.add(new URL(url).host)
      } catch {
        hosts.add(url.includes('{{') ? 'an address worked out while it runs' : 'an address you fill in')
      }
    }
    if (def.category === 'web3') hosts.add('an Ethereum endpoint')

    for (const param of def.params ?? []) {
      if (param.type === 'credential' && node.params?.[param.key]) credentials.add(node.params[param.key])
    }
  }

  return {
    steps: (workflow.nodes ?? []).length,
    triggers: [...triggers],
    hosts: [...hosts].sort(),
    credentials: [...credentials].sort(),
    unknown: [...unknown].sort(),
    runsCode,
    readsChain,
    buildsTransaction,
    writesFiles,
  }
}

// A package carries the name of a key, never its value, and nothing that only
// makes sense on the machine it came from.
export function cleanWorkflow(input) {
  if (!input || typeof input !== 'object') throw new Error('That is not an automation.')
  const nodes = Array.isArray(input.nodes) ? input.nodes : null
  if (!nodes?.length) throw new Error('That automation has no steps in it.')

  const seen = new Set()
  const cleaned = nodes.map((node, i) => {
    const id = String(node.id ?? `n${i}`)
    if (seen.has(id)) throw new Error(`Two steps share the name "${id}".`)
    seen.add(id)
    if (!node.type) throw new Error('A step in that file has no type.')
    return {
      id,
      type: String(node.type),
      name: String(node.name ?? ''),
      params: node.params && typeof node.params === 'object' ? node.params : {},
      position: {
        x: Number(node.position?.x) || 0,
        y: Number(node.position?.y) || 0,
      },
      onError: ['continue', 'errorOutput'].includes(node.onError) ? node.onError : 'stop',
      retries: Math.min(5, Math.max(0, Number(node.retries) || 0)),
      retryWait: Math.min(60_000, Math.max(0, Number(node.retryWait) || 0)),
    }
  })

  const ids = new Set(cleaned.map((n) => n.id))
  const edges = (Array.isArray(input.edges) ? input.edges : [])
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({
      from: String(e.from),
      to: String(e.to),
      fromPort: String(e.fromPort ?? 'main'),
      toPort: String(e.toPort ?? 'main'),
    }))

  return {
    name: String(input.name ?? 'untitled automation').slice(0, 80),
    notes: String(input.notes ?? '').slice(0, 400),
    nodes: cleaned,
    edges,
  }
}
