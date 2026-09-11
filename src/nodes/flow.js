function booleanOf(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '' || text === 'false' || text === '0' || text === 'null' || text === 'undefined') return false
  return true
}

function stateOf(value, direction) {
  if (direction === 'changes') {
    return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')
  }
  return String(booleanOf(value))
}

function wanted(state, direction) {
  if (direction === 'becomesTrue') return state === 'true'
  if (direction === 'becomesFalse') return state === 'false'
  return true
}

const changed = {
  type: 'logic.changed',
  label: 'Only when it changes',
  category: 'logic',
  description: 'Passes an item on only when this value is different from last time. Without it, a check every ten minutes tells you the same thing every ten minutes.',
  outputs: ['main'],
  params: [
    { key: 'value', label: 'Watch this', type: 'text', default: '', placeholder: '{{ $json.usd > 4000 }}',
      description: 'The value being compared with last time. A true or false expression works, and so does a plain number.' },
    {
      key: 'direction', label: 'Pass it on when', type: 'select', default: 'becomesTrue',
      options: [
        { value: 'becomesTrue', label: 'it becomes true' },
        { value: 'becomesFalse', label: 'it becomes false' },
        { value: 'changes', label: 'the value changes at all' },
      ],
    },
    { key: 'key', label: 'Track separately by', type: 'text', default: '',
      description: 'Optional. {{ $json.address }} tracks each wallet on its own.' },
  ],
  async run({ params, item, memory, log }) {
    const slot = params.key ? `by:${params.key}` : 'value'
    const state = stateOf(params.value, params.direction)
    const previous = await memory.get(slot)
    await memory.set(slot, state)

    // First time it ever ran: if the thing being watched for is already the
    // case, say so once. Silence on a first run is the wrong default — you just
    // switched it on and it is true right now.
    if (previous === undefined) {
      if (!wanted(state, params.direction)) return []
      return [item]
    }
    if (previous === state) return []
    if (!wanted(state, params.direction)) {
      log(`Now ${state}. Nothing passed on; waiting for it to change back.`)
      return []
    }
    return [item]
  },
}

const once = {
  type: 'logic.once',
  label: 'Only the first time',
  category: 'logic',
  description: 'Passes something on once and never again. Keyed on whatever makes two things the same, like a transaction hash.',
  outputs: ['main'],
  params: [
    { key: 'key', label: 'Same thing means', type: 'text', default: '',
      description: 'Optional. {{ $json.transactionHash }} = once per transaction, not once ever.' },
  ],
  async run({ params, item, memory }) {
    const slot = params.key ? `by:${params.key}` : 'seen'
    if (await memory.get(slot)) return []
    await memory.set(slot, new Date().toISOString())
    return [item]
  },
}

const stopNode = {
  type: 'flow.stop',
  label: 'Switch this off',
  category: 'output',
  description: 'Switches the automation off from inside, once it has done what it was for. A one-shot alert that should not fire twice ends here.',
  outputs: ['main'],
  params: [
    { key: 'reason', label: 'Why', type: 'text', default: '', placeholder: 'Alert sent, nothing left to watch',
      description: 'Written into the run log, so next week you know why it stopped.' },
  ],
  run({ params, item, stop, log }) {
    stop(params.reason || '')
    log(`Switching this workflow off. ${params.reason || ''}`.trim())
    return [item]
  },
}

// "Tell me when it moves" is a different question from "tell me when it is
// above a line", and it is the one people actually ask. The last value is
// remembered on disk, so a restart does not reset the comparison.
const moved = {
  type: 'logic.moved',
  label: 'Only when it moves by',
  category: 'logic',
  description: 'Passes on when a number has moved far enough since the last time it said so. 5 percent, or 100 of whatever the number counts.',
  outputs: ['main'],
  params: [
    { key: 'value', label: 'Watch this', type: 'text', default: '', placeholder: '{{ $json.ethereum.usd }}',
      description: 'A number. Anything else and the step will say so rather than guess.' },
    { key: 'amount', label: 'Moved by at least', type: 'number', default: 5, min: 0,
      description: 'How far it has to move before this says anything.' },
    {
      key: 'unit', label: 'Measured in', type: 'select', default: 'percent',
      options: [
        { value: 'percent', label: 'percent' },
        { value: 'absolute', label: 'the number itself' },
      ],
    },
    {
      key: 'direction', label: 'Which way', type: 'select', default: 'either',
      options: [
        { value: 'either', label: 'up or down' },
        { value: 'up', label: 'up only' },
        { value: 'down', label: 'down only' },
      ],
    },
    { key: 'key', label: 'Track separately by', type: 'text', default: '',
      description: 'Optional. {{ $json.symbol }} follows each coin on its own.' },
  ],
  async run({ params, item, memory, log }) {
    const now = Number(params.value)
    if (!Number.isFinite(now)) {
      throw new Error(`"${params.value}" is not a number, so there is nothing to compare. Point this at a number.`)
    }

    const slot = params.key ? `moved:${params.key}` : 'moved'
    const before = await memory.get(slot)

    if (before === undefined || before === null) {
      await memory.set(slot, now)
      log(`First look: ${now}. Nothing to compare it against yet.`)
      return []
    }

    const from = Number(before)
    const change = now - from
    const size = params.unit === 'percent'
      ? (from === 0 ? Infinity : Math.abs(change / from) * 100)
      : Math.abs(change)
    const enough = size >= Math.abs(Number(params.amount) || 0)
    const rightWay = params.direction === 'either'
      || (params.direction === 'up' && change > 0)
      || (params.direction === 'down' && change < 0)

    if (!enough || !rightWay) {
      log(`${from} to ${now}. Not enough of a move.`)
      return []
    }

    await memory.set(slot, now)
    const shape = params.unit === 'percent' ? `${size.toFixed(2)}%` : String(size)
    log(`${from} to ${now}, a move of ${shape}.`)
    return [{
      json: {
        ...item.json,
        moved: { from, to: now, change, percent: from === 0 ? null : (change / from) * 100, direction: change > 0 ? 'up' : 'down' },
      },
    }]
  },
}

export default [changed, once, stopNode, moved]
