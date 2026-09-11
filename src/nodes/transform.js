// Dotted names build nested objects, so "user.name" writes { user: { name } }.
function assign(target, path, value) {
  const parts = String(path).split('.').filter(Boolean)
  if (!parts.length) return
  let cursor = target
  for (const key of parts.slice(0, -1)) {
    if (!cursor[key] || typeof cursor[key] !== 'object' || Array.isArray(cursor[key])) cursor[key] = {}
    cursor = cursor[key]
  }
  cursor[parts.at(-1)] = value
}

export default {
  type: 'transform.set',
  label: 'Set fields',
  category: 'transform',
  description: 'Adds or replaces fields on every item.',
  outputs: ['main'],
  params: [
    { key: 'fields', label: 'Fields', type: 'keyvalue', default: [],
      description: 'A bare expression keeps its type: {{ $json.n * 2 }} stays a number.' },
    { key: 'keepOnly', label: 'Drop the other fields', type: 'boolean', default: false },
  ],
  run({ params, item }) {
    const json = params.keepOnly ? {} : { ...item.json }
    for (const row of params.fields ?? []) {
      if (row?.name) assign(json, row.name, row.value)
    }
    return [{ json }]
  },
}
