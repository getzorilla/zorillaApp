const manual = {
  type: 'core.manual',
  label: 'Manual start',
  category: 'trigger',
  description: 'Runs when you press run.',
  outputs: ['main'],
  params: [],
  mode: 'batch',
  run({ items }) {
    return items
  },
}

const schedule = {
  type: 'core.schedule',
  label: 'Schedule',
  category: 'trigger',
  description: 'Runs on a repeat, or once at a set time.',
  outputs: ['main'],
  mode: 'batch',
  params: [
    {
      key: 'mode', label: 'When', type: 'select', default: 'every',
      options: [
        { value: 'every', label: 'On an interval' },
        { value: 'once', label: 'Once, at a set time' },
      ],
    },
    { key: 'every', label: 'Run every', type: 'number', default: 15, min: 1, showWhen: { mode: 'every' } },
    {
      key: 'unit', label: 'Unit', type: 'select', default: 'minutes', showWhen: { mode: 'every' },
      options: [
        { value: 'minutes', label: 'minutes' },
        { value: 'hours', label: 'hours' },
        { value: 'days', label: 'days' },
      ],
    },
    { key: 'at', label: 'Date and time', type: 'datetime', default: '', showWhen: { mode: 'once' },
      description: 'Runs once when this time passes, then never again. A time already gone runs at the next start.' },
  ],
  run({ items }) {
    if (items.length === 1 && Object.keys(items[0].json).length === 0) {
      return [{ json: { startedAt: new Date().toISOString() } }]
    }
    return items
  },
}

const webhook = {
  type: 'core.webhook',
  label: 'Webhook',
  category: 'trigger',
  description: 'Runs when something calls a URL on this machine.',
  outputs: ['main'],
  mode: 'batch',
  params: [
    { key: 'path', label: 'Path', type: 'text', default: 'my-hook', placeholder: 'my-hook',
      description: 'The address ends /hook/<path>. Local only until you put a tunnel in front of it.' },
    { key: 'secret', label: 'Secret', type: 'text', default: '',
      description: 'Optional, and worth setting the moment this is reachable from the internet. The caller has to send it as ?secret=… or an X-Zorilla-Secret header.' },
    {
      key: 'method', label: 'Method', type: 'select', default: 'POST',
      options: ['GET', 'POST', 'PUT', 'DELETE'].map((v) => ({ value: v, label: v })),
    },
  ],
  run({ items, params }) {
    // A run started by hand has no call behind it. Handing on the shape a real
    // call would have means the steps after it can be built and tried before
    // anything is wired up outside.
    const empty = items.length === 1 && Object.keys(items[0].json).length === 0
    if (!empty) return items
    return [{ json: { body: {}, query: {}, headers: {}, method: params.method ?? 'POST', sample: true } }]
  },
}

export default [manual, schedule, webhook]
