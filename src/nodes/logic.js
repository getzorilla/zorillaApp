const OPERATIONS = [
  { value: 'equals', label: 'is equal to' },
  { value: 'notEquals', label: 'is not equal to' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'does not contain' },
  { value: 'greater', label: 'is greater than' },
  { value: 'less', label: 'is less than' },
  { value: 'isEmpty', label: 'is empty' },
  { value: 'isNotEmpty', label: 'is not empty' },
  { value: 'isTrue', label: 'is true' },
]

const NEEDS_COMPARE = ['equals', 'notEquals', 'contains', 'notContains', 'greater', 'less']

function empty(value) {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

function numeric(a, b) {
  const x = Number(a)
  const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
}

export function test(value, operation, compare) {
  switch (operation) {
    case 'isEmpty': return empty(value)
    case 'isNotEmpty': return !empty(value)
    case 'isTrue': return value === true || value === 'true' || value === 1
    case 'contains': return String(value ?? '').includes(String(compare ?? ''))
    case 'notContains': return !String(value ?? '').includes(String(compare ?? ''))
    case 'greater': { const n = numeric(value, compare); return n ? n[0] > n[1] : String(value) > String(compare) }
    case 'less': { const n = numeric(value, compare); return n ? n[0] < n[1] : String(value) < String(compare) }
    case 'notEquals': return !test(value, 'equals', compare)
    case 'equals':
    default: {
      const n = numeric(value, compare)
      if (n) return n[0] === n[1]
      return String(value ?? '') === String(compare ?? '')
    }
  }
}

const ifNode = {
  type: 'logic.if',
  label: 'If',
  category: 'logic',
  description: 'Two paths: true and false.',
  outputs: ['true', 'false'],
  params: [
    { key: 'value', label: 'Value', type: 'text', default: '', placeholder: '{{ $json.status }}',
      description: 'The thing being tested, usually a field from the step before.' },
    { key: 'operation', label: 'Condition', type: 'select', default: 'equals', options: OPERATIONS },
    { key: 'compare', label: 'Compared with', type: 'text', default: '', showWhen: { operation: NEEDS_COMPARE },
      description: 'What to test it against. Numbers compare as numbers.' },
  ],
  run({ params, item }) {
    return test(params.value, params.operation, params.compare)
      ? { true: [item] }
      : { false: [item] }
  },
}

const filterNode = {
  type: 'logic.filter',
  label: 'Filter',
  category: 'logic',
  description: 'Keeps the items that match.',
  outputs: ['main'],
  params: [
    { key: 'value', label: 'Value', type: 'text', default: '', placeholder: '{{ $json.amount }}',
      description: 'Tested on every item. The ones that fail are dropped, not sent down another path.' },
    { key: 'operation', label: 'Condition', type: 'select', default: 'isNotEmpty', options: OPERATIONS },
    { key: 'compare', label: 'Compared with', type: 'text', default: '', showWhen: { operation: NEEDS_COMPARE } },
  ],
  run({ params, item }) {
    return test(params.value, params.operation, params.compare) ? [item] : []
  },
}

export default [ifNode, filterNode]
