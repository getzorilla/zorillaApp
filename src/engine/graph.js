// Graph shape and ordering. Nothing here knows what a node does.
//
//   { id, name, nodes: [{ id, type, params, position }],
//     edges: [{ from, fromPort, to, toPort }] }

export function indexGraph(graph) {
  const nodes = new Map()
  for (const node of graph.nodes ?? []) nodes.set(node.id, node)

  const incoming = new Map()
  const outgoing = new Map()
  for (const id of nodes.keys()) {
    incoming.set(id, [])
    outgoing.set(id, [])
  }

  const edges = []
  for (const edge of graph.edges ?? []) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue
    const e = { ...edge, fromPort: edge.fromPort || 'main', toPort: edge.toPort || 'main' }
    edges.push(e)
    outgoing.get(e.from).push(e)
    incoming.get(e.to).push(e)
  }

  return { nodes, edges, incoming, outgoing }
}

// Depth-first search for one concrete cycle, so the error can name the nodes
// involved rather than saying "somewhere in this graph".
export function findCycle(index) {
  const state = new Map()
  const stack = []

  const visit = (id) => {
    state.set(id, 'open')
    stack.push(id)
    for (const edge of index.outgoing.get(id) ?? []) {
      const next = edge.to
      if (state.get(next) === 'open') return stack.slice(stack.indexOf(next))
      if (!state.has(next)) {
        const found = visit(next)
        if (found) return found
      }
    }
    stack.pop()
    state.set(id, 'done')
    return null
  }

  for (const id of index.nodes.keys()) {
    if (!state.has(id)) {
      const found = visit(id)
      if (found) return found
    }
  }
  return null
}

// Kahn, with ties broken by the order nodes were declared so two runs of the
// same workflow execute in the same order.
export function toposort(index) {
  const declared = [...index.nodes.keys()]
  const remaining = new Map()
  for (const id of declared) remaining.set(id, index.incoming.get(id).length)

  const order = []
  const ready = declared.filter((id) => remaining.get(id) === 0)

  while (ready.length) {
    const id = ready.shift()
    order.push(id)
    for (const edge of index.outgoing.get(id)) {
      const left = remaining.get(edge.to) - 1
      remaining.set(edge.to, left)
      if (left === 0) ready.push(edge.to)
    }
    ready.sort((a, b) => declared.indexOf(a) - declared.indexOf(b))
  }

  if (order.length !== declared.length) {
    const cycle = findCycle(index)
    return { order: null, cycle: cycle ?? declared.filter((id) => remaining.get(id) > 0) }
  }
  return { order, cycle: null }
}

export function rootNodes(index) {
  return [...index.nodes.keys()].filter((id) => index.incoming.get(id).length === 0)
}
