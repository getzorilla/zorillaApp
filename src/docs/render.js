// The reference an agent reads to write an automation.
//
// Rendered rather than read off a file, because the app serves it from what is
// actually loaded — including integrations and functions somebody installed
// themselves. A copy generated at build time lists the built-ins only, and an
// agent would never learn about the service its user just added.
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export async function renderDocs({ nodes, credentialTypes, specs, examplesDir }) {
  const out = []
  const w = (...lines) => out.push(...lines)

  w('# zorilla, for agents',
    '',
    'zorilla runs automations on one person\'s own machine. An automation is a JSON file:',
    'steps, and wires between them. This file lists every step, what it takes, and the rules',
    'the engine enforces. It is generated from the running catalogue.',
    '',
    `Steps: ${nodes.length}. Integrations: ${specs.length}.`,
    '',
    'For anything this file does not cover, read https://zorilla.io/docs.',
    '',
    '## The file',
    '',
    '```json',
    JSON.stringify({
      name: 'eth price to discord',
      folder: 'Examples',
      notes: 'One line saying what this is for.',
      active: false,
      nodes: [
        { id: 'clock', type: 'core.schedule', params: { mode: 'every', every: 10, unit: 'minutes' }, position: { x: 60, y: 200 } },
        { id: 'price', type: 'coingecko.price', params: { ids: 'ethereum', currency: 'usd' }, position: { x: 330, y: 200 } },
        { id: 'post', type: 'discord.post', params: { credential: 'signals_webhook', content: 'ETH ${{ $json.ethereum.usd }}' }, position: { x: 600, y: 200 } },
      ],
      edges: [
        { from: 'clock', fromPort: 'main', to: 'price', toPort: 'main' },
        { from: 'price', fromPort: 'main', to: 'post', toPort: 'main' },
      ],
    }, null, 2),
    '```',
    '',
    '`name` is required. `folder`, `notes` and `active` are optional: `folder` groups it',
    'in the workspace, `notes` is the one line shown under the name, and `active` decides',
    'whether its trigger runs on its own. An imported automation always arrives with',
    '`active` false whatever the file says.',
    '',
    '`retries`, `retryWait` and `onError` sit on the step itself, beside `params`, never',
    'inside it:',
    '',
    '```json',
    JSON.stringify({
      id: 'price', type: 'coingecko.price', params: { ids: 'ethereum' },
      retries: 2, retryWait: 5000, onError: 'continue',
      position: { x: 330, y: 200 },
    }, null, 2),
    '```',
    '',
    '## Rules',
    '',
    '- Every step takes a list of items and returns a list of items. An item is `{ "json": { ... } }`, and may also carry `binary` for files.',
    '- A step returning nothing passes its input through. A step returning `[]` passes nothing on, and every step after it is skipped.',
    '- A step that receives no items does not run at all; the log marks it skipped.',
    '- Cycles are refused before a run starts. There is no loop step.',
    '- Exactly one step should have category `trigger`. Without one, nothing starts.',
    '- `{{ ... }}` in any parameter is JavaScript over `$json` (this item), `$items`, `$index`, `$now`, `$creds`.',
    '- A parameter that is only an expression keeps its type: `{{ $json.n * 2 }}` stays a number. A parameter with text around it, or with more than one expression in it, becomes a string.',
    '- A step receives only the keys named on it. `$creds` holds nothing else.',
    '- Amounts from chain steps are integers, handed on as strings. Do not put them through a float.',
    '- A step that says "hands on" below produces exactly those fields, so read them as `{{ $json.text }}`. A step with no such line passes the service\'s own answer through unchanged, and its field names are the ones in that service\'s documentation.',
    '- `net.http` hands on one item shaped `{ status, ok, headers, body }`. `body` is the parsed JSON when the answer is JSON, and the text otherwise, so a field of the answer is `{{ $json.body.whatever }}`. This is the step to reach for when nothing else fits.',
    '- An optional `credential` parameter left as `""` means no key: the step uses a public endpoint. `rpc` on the chain steps is the usual one.',
    '- `logic.changed` and `logic.moved` pass the whole item through, so a field the step before it produced is still there afterwards.',
    '- `logic.if` and `logic.filter` take `value`, `operation` and `compare`. `isEmpty`, `isNotEmpty` and `isTrue` test `value` alone; leave `compare` out.',
    '- Every step may set `retries` (0-5), `retryWait` (milliseconds) and `onError`: `stop`, `continue`, or `errorOutput`. With `errorOutput` the step grows a second port named `error` carrying `{ error, step, at }`.',
    '- Steps that read a list keep asking for pages until they have `limit` items, and say in the log whether more were left.',
    '- Steps whose category is `trigger` and which poll (marked below) fire on their own timer and pass on only what they have not seen before.',
    '',
    '## Shapes there is no step for',
    '',
    'Two things people ask for often and the engine cannot express. Reach for',
    '`code.js` and say so, rather than looking for a step that is not there.',
    '',
    '- **Many items into one.** Nothing collapses a list. `transform.set` runs per item and the `logic.*` steps only drop items. A digest — one email built from twenty stories — has to go through `code.js`.',
    '- **A time of day.** `core.schedule` in `every` mode has no clock: it fires every N minutes, hours or days counted from when it was switched on. `at` belongs to `once` mode, which runs one time and stops. "Every morning at 9" is not expressible.',
    '',
    '## Keys',
    '',
    'A step names a key; it never carries the value. The person installing it binds that name',
    'to their own saved key. Use plain names like `my_slack`, `signals_webhook`.',
    '')

  const byService = new Map()
  for (const node of nodes) {
    const key = node.integration ?? node.category
    if (!byService.has(key)) byService.set(key, [])
    byService.get(key).push(node)
  }

  const paramLine = (p) => {
    const bits = [`\`${p.key}\``, p.type]
    if (p.default !== undefined && p.default !== '' && !Array.isArray(p.default)) bits.push(`default ${JSON.stringify(p.default)}`)
    if (p.options?.length) bits.push(`one of: ${p.options.map((o) => (o.value ?? o)).join(', ')}`)
    if (p.credentialType) bits.push(`a saved ${p.credentialType} key`)
    const note = [p.label, p.description].filter(Boolean).join('. ')
    return `  - ${bits.join(', ')}${note ? ` — ${note}` : ''}`
  }

  w('## Steps', '')
  for (const [group, list] of [...byService].sort()) {
    const spec = specs.find((i) => i.id === group)
    w(`### ${spec ? spec.label : group}`, '')
    if (spec) w(`${spec.description} Contacts: ${spec.hosts.join(', ') || 'nothing'}.`, '')
    for (const node of list.sort((a, b) => a.type.localeCompare(b.type))) {
      const kind = node.poll ? 'trigger, polls' : node.category
      w(`- **\`${node.type}\`** (${kind}) — ${node.description || node.label}`)
      if (node.outputs?.length > 1) w(`  - ports: ${node.outputs.join(', ')}`)
      if (node.hands?.length) {
        w(`  - hands on: ${node.hands.map((f) => `\`$json.${f}\``).join(', ')}${node.perRow ? ', one item per row' : ''}`)
      } else if (node.perRow) {
        w('  - hands on: one item per row of the answer, with the service\'s own field names')
      }
      for (const p of node.params ?? []) w(paramLine(p))
    }
    w('')
  }

  w('## Keys you can save', '')
  for (const type of credentialTypes.sort((a, b) => a.type.localeCompare(b.type))) {
    const fields = (type.fields ?? []).map((f) => `${f.key}${f.required === false ? ' (optional)' : ''}`).join(', ')
    w(`- \`${type.type}\` — ${type.label}${fields ? `: ${fields}` : ''}`)
  }
  w('')

  const exampleDir = examplesDir
  w('## Working examples', '')
  for (const file of (await readdir(exampleDir)).filter((f) => f.endsWith('.json')).sort()) {
    const wf = JSON.parse(await readFile(path.join(exampleDir, file), 'utf8'))
    w(`### ${wf.name}`, '', wf.notes || '', '', '```json', JSON.stringify({ nodes: wf.nodes, edges: wf.edges }, null, 2), '```', '')
  }

  w('## What it cannot do',
    '',
    '- Sign or send a transaction. `web3.prepare` simulates and reports the fee; a person signs.',
    '- Loop or repeat a step. Lists page themselves; nothing else repeats.',
    '- Receive a webhook from the internet without a tunnel, which the app opens on request.',
    '- Cron expressions, or a schedule pinned to a time of day.',
    '')

  return out.join('\n')
}
