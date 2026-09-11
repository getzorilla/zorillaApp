// Geometry here has to agree with .node and .port in style.css.
const NODE_W = 210
const IN_Y = 26
const OUT_Y = 26
const OUT_STEP = 18

const $ = (id) => document.getElementById(id)

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else node[key] = value
  }
  node.append(...kids.flat().filter((k) => k || k === 0))
  return node
}

const state = {
  view: 'home',
  panel: 'automations',
  folder: null,
  workspace: { name: 'My Workspace', folders: [] },
  workspaces: { current: 'default', list: [] },
  defs: new Map(),
  credentialTypes: new Map(),
  integrations: [],
  credentials: [],
  themes: [],
  tunnel: {},
  paletteService: null,
  keyDraftType: null,
  workflows: [],
  wf: null,
  selected: null,
  runs: [],
  run: null,
  home: { port: 5177, path: '' },
  viewBox: { x: 60, y: 40, k: 1 },
}

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
  return data
}

let toastTimer
function toast(message, bad = false) {
  const node = $('toast')
  node.textContent = message
  node.className = `toast show${bad ? ' bad' : ''}`
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { node.className = 'toast' }, 2600)
}

const typeLabel = (type) => state.credentialTypes.get(type)?.label ?? type

// Services that ship with a logo file. Anything else falls back to a letter in
// the same box, so a row of them still lines up.
const LOGOS = new Set([
  'airtable', 'anthropic', 'coingecko', 'deepseek', 'discord', 'etherscan', 'gemini',
  'github', 'gmail', 'hackernews', 'notion', 'openai', 'resend', 'slack', 'stripe',
  'supabase', 'telegram', 'twilio', 'web3', 'x',
])

// Which service a step belongs to. Integration steps say so; the rest are named
// after their service already (gmail.send), and the built-ins are not services.
const SERVICE_LABEL = { web3: 'Web3', gmail: 'Gmail' }
const CORE = new Set(['core', 'logic', 'flow', 'transform', 'output', 'net', 'code', 'file'])
function serviceOf(def) {
  if (def.integration) return def.integration
  const prefix = String(def.type).split('.')[0]
  return CORE.has(prefix) ? null : prefix
}

const LOGO_ALIAS = { evmRpc: 'web3' }
// ours rather than anybody's, so they get a mark instead of a brand
const HOUSE_MARK = { generic: '⋯', bearer: '⌁', apiHeader: '⚿' }

function logoEl(id, size = 22) {
  const box = el('span', { class: 'logo', style: `width:${size}px;height:${size}px` })
  id = LOGO_ALIAS[id] ?? id
  const own = state.integrations.find((i) => i.id === id)?.icon
  if (own) {
    box.append(el('img', { src: own, alt: '', width: size, height: size }))
  } else if (LOGOS.has(id)) {
    box.append(el('img', { src: `/logos/${id}.svg`, alt: '', width: size, height: size }))
  } else if (HOUSE_MARK[id]) {
    box.classList.add('letter')
    box.append(el('span', { text: HOUSE_MARK[id] }))
  } else {
    box.classList.add('letter')
    box.append(el('span', { text: String(id ?? '?').charAt(0).toUpperCase() }))
  }
  return box
}
const relative = (iso) => {
  if (!iso) return 'Never run'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`
  return `${Math.round(seconds / 86400)}d ago`
}

const untilNow = (iso) => {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000)
  if (seconds <= 0) return 'any moment'
  if (seconds < 60) return `in ${seconds}s`
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`
  if (seconds < 86400) return `in ${Math.round(seconds / 3600)}h`
  return `in ${Math.round(seconds / 86400)}d`
}

// ---------------------------------------------------------------- views

function showView(view) {
  state.view = view
  $('home-view').hidden = view !== 'home'
  $('editor-view').hidden = view !== 'editor'
  $('editor-controls').hidden = view !== 'editor'
  $('crumb-sep').hidden = view !== 'editor'
  $('automation-name').hidden = view !== 'editor'
  if (view === 'home') renderHome()
}

function renderCrumbs() {
  $('workspace-name').textContent = state.workspace.name
  document.title = state.wf && state.view === 'editor'
    ? `${state.wf.name} · ${state.workspace.name}`
    : state.workspace.name
  if (state.wf) $('automation-name').textContent = state.wf.name
  $('home-meta').textContent = `127.0.0.1:${state.home.port}`
}

// The steps say how it works. This is the only place that says what it is for,
// so it sits above them rather than behind a click on empty canvas.
function renderPurpose() {
  const strip = $('purpose')
  const notes = state.wf?.notes?.trim()
  strip.textContent = notes || 'Say what this automation is for'
  strip.classList.toggle('unset', !notes)
}

$('purpose').onclick = () => {
  if (!state.wf) return
  const notes = prompt('Say what this automation is for', state.wf.notes ?? '')
  if (notes === null) return
  state.wf.notes = notes.trim()
  renderPurpose()
  touch()
}

$('go-home').onclick = () => { location.hash = state.panel === 'automations' ? '' : state.panel; showView('home') }

function applyHash() {
  const hash = location.hash.replace(/^#/, '')
  if (hash.startsWith('a/')) return { open: hash.slice(2) }
  if (['keys', 'integrations', 'settings', 'automations'].includes(hash)) state.panel = hash
  return { open: null }
}

async function renameWorkspace() {
  const name = prompt('Name this workspace', state.workspace.name)
  if (name === null) return
  state.workspace = await api('/api/workspace', { method: 'PUT', body: { name } })
  state.workspaces = await api('/api/workspaces')
  renderCrumbs()
  if (state.view === 'home') renderHome()
}

// Everything in the workspace is re-read, because switching changed all of it:
// different automations, different runs, different keys.
async function reloadWorkspace() {
  const boot = await api('/api/state')
  state.workspace = boot.workspace
  state.workflows = boot.workflows
  state.credentials = boot.credentials
  state.runs = boot.runs
  state.armed = boot.armed ?? []
  state.home = { path: boot.home, port: boot.port, publicUrl: boot.publicUrl }
  state.wf = null
  state.selected = null
  state.run = null
  state.workspaces = await api('/api/workspaces')
  showView('home')
  renderCrumbs()
}

async function switchWorkspace(id) {
  await api(`/api/workspaces/${id}`, { method: 'PUT', body: {} })
  await reloadWorkspace()
  toast(`Now in ${state.workspace.name}`)
}

async function newWorkspace() {
  const name = prompt('Name the new workspace')
  if (!name?.trim()) return
  try {
    await api('/api/workspaces', { method: 'POST', body: { name: name.trim() } })
    await reloadWorkspace()
    toast(`${state.workspace.name} is ready. Its keys are its own.`)
  } catch (err) {
    toast(err.message, true)
  }
}

// A workspace file is the automations, never the keys, so an imported one
// arrives asking for keys of the same names.
async function importWorkspace() {
  const picker = el('input', { type: 'file', accept: 'application/json' })
  picker.onchange = async () => {
    const file = picker.files?.[0]
    if (!file) return
    let parsed
    try {
      parsed = JSON.parse(await file.text())
    } catch (err) {
      return toast(`That file is not readable JSON: ${err.message}`, true)
    }
    const automations = Array.isArray(parsed.automations) ? parsed.automations : null
    if (!automations) return toast('That is not a workspace file.', true)
    try {
      await api('/api/workspaces', { method: 'POST', body: { name: parsed.name || 'Imported', automations } })
      await reloadWorkspace()
      toast(`${automations.length} automation(s) imported, switched off.`)
    } catch (err) {
      toast(err.message, true)
    }
  }
  picker.click()
}

$('workspace-name').onclick = (event) => {
  const box = $('workspace-name').getBoundingClientRect()
  const at = { clientX: box.left, clientY: box.bottom + 4, preventDefault: () => {}, stopPropagation: () => {} }
  const others = (state.workspaces?.list ?? []).filter((w) => w.id !== state.workspaces?.current)
  contextMenu(at, [
    ...others.map((w) => ({ label: w.name, run: () => switchWorkspace(w.id) })),
    ...(others.length ? ['divider'] : []),
    { label: 'Create New', run: () => newWorkspace() },
    { label: 'Import', run: () => importWorkspace() },
    'divider',
    { label: `Rename "${state.workspace.name}"`, run: () => renameWorkspace() },
  ])
}

$('automation-name').onclick = () => {
  const name = prompt('Name this automation', state.wf.name)
  if (name === null) return
  state.wf.name = name.trim() || state.wf.name
  renderCrumbs()
  touch()
}

$('open-editor').onclick = () => {
  const first = state.workflows[0]
  first ? openWorkflow(first.id) : newAutomation()
}

for (const item of document.querySelectorAll('.rail-item')) {
  item.onclick = () => {
    if (item.dataset.panel === 'guide') return openGuide()
    state.panel = item.dataset.panel
    location.hash = state.panel === 'automations' ? '' : state.panel
    for (const other of document.querySelectorAll('.rail-item')) {
      other.classList.toggle('active', other === item)
    }
    renderHome()
  }
}

function goToPanel(panel) {
  state.panel = panel
  location.hash = panel === 'automations' ? '' : panel
  markHistory()
  for (const item of document.querySelectorAll('.rail-item')) {
    item.classList.toggle('active', item.dataset.panel === panel)
  }
  renderHome()
}

function renderHome() {
  renderCrumbs()
  if (state.panel === 'automations') return renderAutomations()
  if (state.panel === 'keys') return renderKeysHome()
  if (state.panel === 'settings') return renderSettings()
  return renderIntegrationsHome()
}

// The shape of an automation, small. At this size the labels are unreadable, so
// it draws the boxes and the wires only: enough to tell a straight line from a
// branch, and to tell two automations apart at a glance.
const NS = 'http://www.w3.org/2000/svg'

const PLAY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l8-4.5z" fill="currentColor"/></svg>'
const TRASH_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.6 9a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4M6.5 7v4M9.5 7v4"/></svg>'

function iconButton(icon, label, extra, onclick) {
  const button = el('button', { class: `row-icon${extra ? ` ${extra}` : ''}`, title: label, onclick })
  button.setAttribute('aria-label', label)
  button.innerHTML = icon
  return button
}

function canvasThumb(workflow, width = 250, height = 84) {
  const nodes = workflow.nodes ?? []
  if (!nodes.length) return null

  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'thumb')
  svg.setAttribute('width', width)
  svg.setAttribute('height', height)
  svg.setAttribute('aria-hidden', 'true')

  const left = Math.min(...nodes.map((n) => n.position?.x ?? 0))
  const top = Math.min(...nodes.map((n) => n.position?.y ?? 0))
  const right = Math.max(...nodes.map((n) => (n.position?.x ?? 0) + NODE_W))
  const bottom = Math.max(...nodes.map((n) => (n.position?.y ?? 0) + 70))
  const pad = 26
  svg.setAttribute('viewBox', `${left - pad} ${top - pad} ${right - left + pad * 2} ${bottom - top + pad * 2}`)
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')

  const at = (id) => nodes.find((n) => n.id === id)
  for (const edge of workflow.edges ?? []) {
    const a = at(edge.from)
    const b = at(edge.to)
    if (!a || !b) continue
    const ax = (a.position?.x ?? 0) + NODE_W
    const ay = (a.position?.y ?? 0) + 24
    const bx = b.position?.x ?? 0
    const by = (b.position?.y ?? 0) + 24
    const bend = Math.max(40, Math.abs(bx - ax) / 2)
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', `M ${ax} ${ay} C ${ax + bend} ${ay}, ${bx - bend} ${by}, ${bx} ${by}`)
    path.setAttribute('class', 'thumb-wire')
    svg.append(path)
  }
  for (const node of nodes) {
    const rect = document.createElementNS(NS, 'rect')
    rect.setAttribute('x', node.position?.x ?? 0)
    rect.setAttribute('y', node.position?.y ?? 0)
    rect.setAttribute('width', NODE_W)
    rect.setAttribute('height', 48)
    rect.setAttribute('rx', 10)
    rect.setAttribute('class', state.defs.has(node.type) ? 'thumb-node' : 'thumb-node missing')
    svg.append(rect)
  }
  return svg
}

const readyTag = () => el('span', { class: 'tag ready' },
  el('span', { class: 'tick', text: '✓' }),
  el('span', { text: 'Ready' }))

const exampleTag = () => el('span', { class: 'tag', text: 'Example' })

// ---------------------------------------------------------------- examples

// The automations that came with zorilla. Offered, never installed on somebody's
// behalf, and each one says what it does and what it would need first.
async function showExamples() {
  const side = $('home-side')
  const sheet = $('home-sheet')
  side.textContent = ''
  sheet.textContent = ''

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: 'Automations that came with Zorilla' }),
    el('p', { text: 'They arrive switched off. Change anything you like afterwards.' })))
  sheet.append(el('div', { class: 'sheet-actions' },
    el('button', { class: 'ghost', text: 'Back', onclick: renderAutomations })))

  let examples = []
  try {
    examples = await api('/api/examples')
  } catch (err) {
    sheet.append(el('p', { class: 'error', text: err.message }))
    return
  }

  const saved = new Set(state.credentials.map((c) => c.name))
  const list = el('div', { class: 'row-list' })
  for (const example of examples.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const missing = example.derived.credentials.filter((name) => !saved.has(name))
    const row = el('div', { class: 'row' },
      el('div', { class: 'grow' },
        el('div', { class: 'row-inline row-title', style: 'gap:8px' },
          el('div', { class: 'name', text: example.name }),
          missing.length ? null : readyTag()),
        el('div', { class: 'note', text: example.notes }),
        el('div', { class: 'meta', text: [
          `${example.nodes.length} functions`,
          example.derived.hosts.length ? `contacts ${example.derived.hosts.join(', ')}` : 'Contacts nothing',
        ].join('  ·  ') }),
        missing.length ? el('div', { class: 'needs', text: `The following are required: ${missing.join(', ')}` }) : null),
      el('div', { class: 'row-actions' },
        el('button', { class: 'ghost', text: 'Add it', onclick: async (event) => {
          event.stopPropagation()
          const added = await api('/api/workflows/import', { method: 'POST', body: { package: example, folder: 'Examples' } })
          state.workflows = await api('/api/workflows')
          toast(`${added.name} added`)
          openWorkflow(added.id)
        } })))
    list.append(row)
  }
  sheet.append(list)
}

// ---------------------------------------------------------------- installing

// What somebody sees before an automation somebody else wrote goes anywhere
// near their workspace. Everything on this screen is worked out by reading the
// file, so none of it is the author's word for anything.
function permissionLines(derived) {
  const lines = []
  lines.push(`${derived.steps} function${derived.steps === 1 ? '' : 's'}${derived.triggers.length ? `, started by ${derived.triggers.join(' or ')}` : ''}`)
  lines.push(derived.hosts.length ? `Contacts ${derived.hosts.join(', ')}` : 'Contacts nothing')
  if (derived.credentials.length) lines.push(`Uses your saved keys: ${derived.credentials.join(', ')}`)
  if (derived.readsChain) lines.push('Reads Ethereum. It cannot move funds')
  if (derived.buildsTransaction) lines.push('Works out what a transaction would cost. It signs nothing')
  if (derived.writesFiles) lines.push('Saves files into your Zorilla files folder')
  return lines
}

// Which kind of key a name wants, worked out from the steps that use it. An
// imported automation says "my_telegram"; this is what turns that into the
// Telegram form rather than a list of every kind of key there is.
function keyTypesWanted(workflow) {
  const wanted = new Map()
  for (const node of workflow.nodes ?? []) {
    const def = state.defs.get(node.type)
    for (const param of def?.params ?? []) {
      if (param.type !== 'credential') continue
      const named = node.params?.[param.key]
      if (named && !wanted.has(named)) wanted.set(named, param.credentialType ?? 'generic')
    }
  }
  return wanted
}

// The form for one missing key, with its kind already chosen. Saving it here
// means somebody never has to leave the import screen, go and find Keys, and
// work out which of the seventeen this automation meant.
function missingKeyForm(name, type, onSaved) {
  const spec = state.credentialTypes.get(type)
  const values = {}
  const box = el('div', { class: 'checklist' })
  box.append(el('h4', { text: `Add the key this calls "${name}"` }))
  if (spec?.description) box.append(el('p', { class: 'hint', style: 'margin:0 0 10px' }, spec.description))

  const fields = el('div')
  if (!spec?.fields?.length) {
    box.append(el('p', { class: 'hint', style: 'margin:0 0 10px' },
      `Zorilla does not know what kind of key "${name}" is. Add it under Keys.`))
    box.append(el('button', { class: 'ghost', text: 'Open Keys', onclick: () => { showView('home'); goToPanel('keys') } }))
    return box
  }
  for (const field_ of spec.fields) {
    const input = el('input', {
      type: field_.secret ? 'password' : 'text',
      placeholder: field_.placeholder ?? '',
      style: 'width:100%',
    })
    values[field_.key] = ''
    input.oninput = () => { values[field_.key] = input.value }
    fields.append(field(field_.required === false ? `${field_.label} (optional)` : field_.label, input, field_.description))
  }
  box.append(fields)
  if (spec.docs) {
    box.append(el('a', { href: spec.docs, target: '_blank', rel: 'noreferrer', class: 'hint', text: 'Where to find this key' }))
  }

  const note = el('p', { class: 'error' })
  const save = el('button', { class: 'primary', text: `Save as ${name}` })
  save.onclick = async () => {
    note.textContent = ''
    save.disabled = true
    try {
      const { credentials } = await api(`/api/credentials/${encodeURIComponent(name)}`, {
        method: 'PUT',
        body: { type: spec.type, values },
      })
      state.credentials = credentials
      toast(`${name} saved`)
      onSaved()
    } catch (err) {
      note.textContent = err.message
      save.disabled = false
    }
  }
  box.append(el('div', { class: 'row-inline', style: 'margin-top:10px' }, save), note)
  return box
}

// A step nothing here provides. Name the service and hand over the prompt that
// writes it, rather than leaving somebody with a broken automation.
function missingServiceNote(unknown) {
  const services = [...new Set(unknown.map((type) => String(type).split('.')[0]))]
  const box = el('div', { class: 'checklist' })
  box.append(el('h4', { text: `This needs ${services.length === 1 ? 'an integration' : 'integrations'} you do not have: ${services.join(', ')}` }))
  box.append(el('p', { class: 'hint', style: 'margin:0 0 10px' },
    'An integration is a JSON file describing a service. Write one with the prompt, paste it in under Integrations, then import this again.'))
  box.append(el('div', { class: 'row-inline' },
    el('button', { class: 'ghost', text: 'Get the prompt', onclick: () => {
      showView('home')
      goToPanel('integrations')
      showIntegrationEditor(null, services[0])
    } })))
  return box
}

async function showImport() {
  const sheet = $('home-sheet')
  const side = $('home-side')
  side.textContent = ''
  sheet.textContent = ''

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: 'Import' }),
    el('p', { text: 'Drop in a file, or paste one. Nothing is saved until you have read what it does.' })))

  const drop = el('div', { class: 'drop' }, el('span', { text: 'Drop a .json file here, or choose one' }))
  const picker = el('input', { type: 'file', accept: 'application/json' })
  const box = el('textarea', { rows: 8, spellcheck: false, placeholder: 'Or paste the file here', style: 'width:100%' })
  const readout = el('div')
  const problem = el('p', { class: 'error' })

  let pending = null

  const inspect = async (text) => {
    problem.textContent = ''
    readout.textContent = ''
    pending = null
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch (err) {
      problem.textContent = `that file is not readable json: ${err.message}`
      return
    }
    try {
      const looked = await api('/api/workflows/inspect', { method: 'POST', body: { package: parsed } })
      if (!looked?.workflow || !looked?.derived) {
        problem.textContent = 'Zorilla could not read that as an automation.'
        return
      }
      pending = looked.workflow
      const missing = looked.derived.credentials.filter((name) => !state.credentials.some((c) => c.name === name))

      const card = el('div', { class: 'install-card' },
        el('h3', { text: looked.workflow.name }),
        looked.workflow.notes ? el('p', { class: 'hint', text: looked.workflow.notes }) : null,
        el('h4', { text: 'What this can do' }))
      const list = el('ul')
      for (const line of permissionLines(looked.derived)) list.append(el('li', { text: line }))
      card.append(list)

      if (looked.derived.unknown.length) {
        card.append(missingServiceNote(looked.derived.unknown))
      }
      if (looked.derived.runsCode) {
        card.append(el('div', { class: 'checklist' },
          el('h4', { text: 'It runs JavaScript its author wrote' }),
          el('p', { class: 'hint', text: 'That code runs in its own process with no access to your files, but it can still reach the internet. Read it first.' })))
      }
      // a missing key is filled in here rather than sending somebody off to
      // find Keys and guess which of the seventeen this one meant
      const wanted = keyTypesWanted(looked.workflow)
      for (const name of missing) {
        card.append(missingKeyForm(name, wanted.get(name) ?? 'generic', () => inspect(text)))
      }

      card.append(el('div', { class: 'row-inline', style: 'margin-top:12px' },
        el('button', { class: 'primary', text: 'Add it, switched off', onclick: async () => {
          const saved = await api('/api/workflows/import', { method: 'POST', body: { package: pending } })
          state.workflows = await api('/api/workflows')
          toast(`${saved.name} added`)
          openWorkflow(saved.id)
        } }),
        el('button', { class: 'ghost', text: 'Cancel', onclick: () => renderAutomations() })))
      readout.append(card)
    } catch (err) {
      problem.textContent = err.message
    }
  }

  picker.onchange = async () => {
    const file = picker.files?.[0]
    if (!file) return
    const text = await file.text()
    box.value = text
    await inspect(text)
  }
  drop.onclick = () => picker.click()
  drop.ondragover = (event) => { event.preventDefault(); drop.classList.add('over') }
  drop.ondragleave = () => drop.classList.remove('over')
  drop.ondrop = async (event) => {
    event.preventDefault()
    drop.classList.remove('over')
    const file = event.dataTransfer?.files?.[0]
    if (!file) return
    const text = await file.text()
    box.value = text
    await inspect(text)
  }
  // a dropped or chosen file reads itself; pasted text needs somewhere to press,
  // because onchange alone only fires once the box loses focus
  box.onchange = () => inspect(box.value)
  const load = el('button', { class: 'primary', text: 'Load', onclick: () => {
    if (!box.value.trim()) return toast('Paste a file into the box first.', true)
    inspect(box.value)
  } })
  const clear = el('button', { class: 'ghost', text: 'Clear', onclick: () => {
    box.value = ''
    readout.textContent = ''
    problem.textContent = ''
    pending = null
  } })
  const loadRow = el('div', { class: 'row-inline', style: 'margin:8px 0 4px' }, load, clear)

  sheet.append(drop, picker, box, loadRow, problem, readout)
}

// ---------------------------------------------------------------- automations

// What is still missing before this could work, in the words somebody would
// use themselves. A switched-on automation that quietly does nothing is the
// worst thing this can do, so the gaps are on the screen rather than in a log.
function whatItNeeds(workflow) {
  const needs = []
  const nodes = workflow.nodes ?? []

  const triggers = nodes.filter((n) => state.defs.get(n.type)?.category === 'trigger')
  if (!nodes.length) needs.push('At least one function')
  else if (!triggers.length) needs.push('A trigger: a schedule, a webhook, or a function that waits')

  for (const node of nodes) {
    const def = state.defs.get(node.type)
    if (!def) {
      needs.push(node.type)
      continue
    }
    for (const param of def.params ?? []) {
      if (param.type !== 'credential') continue
      const chosen = node.params?.[param.key]
      if (!chosen) {
        if (param.required !== false) needs.push(`A key for ${def.label}`)
        continue
      }
      if (!state.credentials.some((c) => c.name === chosen)) {
        needs.push(`A saved key called "${chosen}"`)
      }
    }
  }

  const hooks = nodes.filter((n) => n.type === 'core.webhook')
  if (hooks.length && !(state.tunnel?.url || state.home.publicUrl)) {
    needs.push('A public web address for the webhook')
  }

  return [...new Set(needs)]
}

setInterval(async () => {
  if (state.view !== 'home' || state.panel !== 'automations') return
  try {
    const fresh = await api('/api/schedule')
    state.armed = fresh.armed ?? []
    renderAutomations()
  } catch { /* the list is still readable without it */ }
}, 30_000)

// "Ok 7m ago" reads as a label. What happened is that it ran.
const RAN = { ok: 'Run', failed: 'Run failed', error: 'Run failed', running: 'Running, started' }
const ranWhat = (status) => RAN[status] ?? `Run ${status}`

// the soonest thing armed for this automation, or nothing if it is switched off
function nextRunFor(workflowId) {
  const times = (state.armed ?? [])
    .filter((a) => a.workflowId === workflowId)
    .map((a) => a.nextAt)
    .sort()
  return times[0] ?? null
}

function lastRunFor(workflowId) {
  return state.runs.find((r) => r.workflowId === workflowId) ?? null
}

// Groups live on the automations themselves, so renaming one means moving
// everything in it and deleting one only lets go of the label.
async function renameFolder(folder) {
  const name = prompt('Rename group', folder)
  if (!name?.trim() || name.trim() === folder) return
  for (const workflow of state.workflows.filter((w) => w.folder === folder)) {
    await api(`/api/workflows/${workflow.id}`, { method: 'PATCH', body: { folder: name.trim() } })
  }
  state.workspace = await api('/api/workspace', {
    method: 'PUT',
    body: { folders: [...new Set(state.workspace.folders.map((f) => (f === folder ? name.trim() : f)))] },
  })
  state.workflows = await api('/api/workflows')
  state.folder = name.trim()
  renderAutomations()
}

async function deleteFolder(folder) {
  const inside = state.workflows.filter((w) => w.folder === folder)
  if (!confirm(`Delete the group "${folder}"? The ${inside.length} automation(s) in it stay, without a group.`)) return
  for (const workflow of inside) {
    await api(`/api/workflows/${workflow.id}`, { method: 'PATCH', body: { folder: '' } })
  }
  state.workspace = await api('/api/workspace', {
    method: 'PUT',
    body: { folders: state.workspace.folders.filter((f) => f !== folder) },
  })
  state.workflows = await api('/api/workflows')
  state.folder = null
  renderAutomations()
}

function renderAutomations() {
  const side = $('home-side')
  const sheet = $('home-sheet')
  side.textContent = ''
  sheet.textContent = ''

  const folders = [...new Set(state.workflows.map((w) => w.folder).filter(Boolean))].sort()
  const counts = (folder) =>
    state.workflows.filter((w) => (folder === null ? true : (w.folder || '') === folder)).length

  side.append(el('div', { class: 'side-title', text: 'Groups' }))
  const entry = (label, folder) => {
    const row = el('div', {
      class: `side-item${state.folder === folder ? ' active' : ''}`,
      onclick: () => { state.folder = folder; renderAutomations() },
    }, el('span', { text: label }), el('span', { class: 'count', text: String(counts(folder)) }))
    if (folder) {
      row.oncontextmenu = (event) => contextMenu(event, [
        { label: 'New Automation here', run: () => newAutomation(folder) },
        'divider',
        { label: 'Rename group', run: () => renameFolder(folder) },
        { label: 'Delete group', run: () => deleteFolder(folder) },
      ])
    }
    return row
  }

  side.append(entry('All', null), entry('Ungrouped', ''))
  for (const folder of folders) side.append(entry(folder, folder))
  side.append(el('div', {
    class: 'side-item',
    onclick: async () => {
      const name = prompt('New group')
      if (!name?.trim()) return
      state.workspace = await api('/api/workspace', {
        method: 'PUT',
        body: { folders: [...state.workspace.folders, name.trim()] },
      })
      state.folder = name.trim()
      renderAutomations()
    },
  }, el('span', { text: '+ Group' })))

  const shown = state.workflows
    .filter((w) => state.folder === null || (w.folder || '') === state.folder)
    // by name, numerically, so demo02 comes after demo01 rather than after
    // demo19. Ready-first reordering put the demos out of sequence for no gain.
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }))

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: state.workspace.name }),
    el('p', { text: `${state.workflows.length} automation${state.workflows.length === 1 ? '' : 's'}` })))

  // only worth saying when there is in fact something to press run on; "0 of
  // these run right now" told somebody nothing they could act on
  const untouched = !state.credentials.length && !state.runs.length
  const ready = state.workflows.filter((w) => !whatItNeeds(w).length)
  if (untouched && ready.length) {
    sheet.append(el('div', { class: 'welcome' },
      el('h4', { text: 'New here?' }),
      el('p', {}, 'Open any of the demo automations and press "Run". The ones tagged "Ready" are ready to run right away, the others ',
        el('a', { href: '#', text: 'require an API key.', onclick: (e) => { e.preventDefault(); goToPanel('keys') } }))))
  } else if (untouched && state.workflows.length) {
    sheet.append(el('div', { class: 'welcome' },
      el('h4', { text: 'New here?' }),
      el('p', {}, 'Each of these needs a key before it can run. Open one to see which, or ',
        el('a', { href: '#', text: 'add a key now.', onclick: (e) => { e.preventDefault(); goToPanel('keys') } }))))
  }

  // with nothing here the empty box below offers the same two things, so the
  // row of buttons would only be saying it twice
  if (shown.length) {
    sheet.append(el('div', { class: 'sheet-actions' },
      el('button', { class: 'primary', text: 'New Automation', onclick: () => newAutomation() }),
      el('button', { class: 'ghost', text: 'Import', onclick: () => showImport() }),
      el('button', { class: 'ghost', text: 'Have an agent build it', onclick: () => showAgentPrompt() })))
  }

  if (!shown.length) {
    sheet.append(el('div', { class: 'empty' },
      el('h3', { text: 'Nothing here yet' }),
      el('p', { text: 'Start from an empty canvas, open a demo, or describe what you want and have an agent build it.' }),
      el('div', { class: 'row-inline', style: 'justify-content:center' },
        el('button', { class: 'primary', text: 'New Automation', onclick: () => newAutomation() }),
        el('button', { class: 'ghost', text: 'Import', onclick: () => showImport() }),
        el('button', { class: 'ghost', text: 'Open a Demo', onclick: () => showExamples() }),
        el('button', { class: 'ghost', text: 'Have an agent build it', onclick: () => showAgentPrompt() }))))
    return
  }

  const list = el('div', { class: 'row-list' })
  for (const workflow of shown) {
    const run = lastRunFor(workflow.id)
    const needs = whatItNeeds(workflow)
    const row = el('div', { class: 'row', onclick: () => openWorkflow(workflow.id) },
      el('div', { class: 'grow' },
        el('div', { class: 'row-inline row-title', style: 'gap:8px' },
          el('div', { class: 'name', text: workflow.name }),
          workflow.example ? exampleTag() : null,
          needs.length ? null : readyTag()),
        workflow.notes ? el('div', { class: 'note', text: workflow.notes }) : null,
        el('div', { class: 'meta' },
          el('span', { text: run ? `${ranWhat(run.status)} ${relative(run.startedAt)}` : 'Never run' }),
          // only while it is switched on. Being ready to run is not the same as
          // counting down to one
          workflow.active && nextRunFor(workflow.id)
            ? el('span', { class: 'due', text: `  ·  Next run ${untilNow(nextRunFor(workflow.id))}` })
            : null),
        needs.length ? el('div', { class: 'needs', text: `The following are required: ${needs.join(', ')}` }) : null),
      canvasThumb(workflow),
      el('div', { class: 'row-actions' },
        iconButton(PLAY_ICON, 'Run', 'good', async (event) => {
          event.stopPropagation()
          try {
            const result = await api(`/api/workflows/${workflow.id}/run`, { method: 'POST', body: {} })
            state.runs = await api('/api/runs')
            toast(`${workflow.name}: ${result.status}`, result.status !== 'ok')
            renderAutomations()
          } catch (err) { toast(err.message, true) }
        }),
        iconButton(TRASH_ICON, 'Delete', 'bad', async (event) => {
          event.stopPropagation()
          if (!confirm(`Delete "${workflow.name}"? This cannot be undone.`)) return
          await api(`/api/workflows/${workflow.id}`, { method: 'DELETE' })
          state.workflows = await api('/api/workflows')
          renderAutomations()
        })))
    row.oncontextmenu = (event) => contextMenu(event, [
      { label: 'Open', run: () => openWorkflow(workflow.id) },
      { label: 'Run', run: () => runFromList(workflow) },
      'divider',
      { label: 'Rename', run: () => renameWorkflow(workflow) },
      { label: 'Duplicate', run: () => duplicateWorkflow(workflow) },
      { label: 'Move to group', run: () => moveWorkflow(workflow) },
      'divider',
      { label: 'Delete', run: () => deleteWorkflow(workflow) },
    ])
    list.append(row)
  }
  sheet.append(list)
}

async function runFromList(workflow) {
  try {
    const result = await api(`/api/workflows/${workflow.id}/run`, { method: 'POST', body: {} })
    state.runs = await api('/api/runs')
    toast(`${workflow.name}: ${result.status}`, result.status !== 'ok')
    renderAutomations()
  } catch (err) { toast(err.message, true) }
}

async function renameWorkflow(workflow) {
  const name = prompt('Rename automation', workflow.name)
  if (!name?.trim() || name.trim() === workflow.name) return
  await api(`/api/workflows/${workflow.id}`, { method: 'PATCH', body: { name: name.trim() } })
  state.workflows = await api('/api/workflows')
  renderAutomations()
}

async function duplicateWorkflow(workflow) {
  const full = await api(`/api/workflows/${workflow.id}`)
  const saved = await api('/api/workflows', {
    method: 'POST',
    body: { ...full, id: undefined, active: false, name: `${full.name} copy` },
  })
  state.workflows = await api('/api/workflows')
  renderAutomations()
  toast(`${saved.name} created`)
}

async function moveWorkflow(workflow) {
  const folder = prompt('Move to which group? Leave it empty for none.', workflow.folder ?? '')
  if (folder === null) return
  await api(`/api/workflows/${workflow.id}`, { method: 'PATCH', body: { folder: folder.trim() } })
  if (folder.trim() && !state.workspace.folders.includes(folder.trim())) {
    state.workspace = await api('/api/workspace', {
      method: 'PUT',
      body: { folders: [...state.workspace.folders, folder.trim()] },
    })
  }
  state.workflows = await api('/api/workflows')
  renderAutomations()
}

async function deleteWorkflow(workflow) {
  if (!confirm(`Delete "${workflow.name}"? This cannot be undone.`)) return
  await api(`/api/workflows/${workflow.id}`, { method: 'DELETE' })
  state.workflows = await api('/api/workflows')
  renderAutomations()
}

async function newAutomation(folder = null) {
  const saved = await api('/api/workflows', {
    method: 'POST',
    body: { name: 'Untitled automation', folder: folder ?? state.folder ?? '', nodes: [], edges: [] },
  })
  state.workflows = await api('/api/workflows')
  openWorkflow(saved.id)
}

// ---------------------------------------------------------------- keys

function renderKeysHome() {
  const side = $('home-side')
  const sheet = $('home-sheet')
  side.textContent = ''
  sheet.textContent = ''

  side.append(el('div', { class: 'side-title', text: 'Saved keys' }))
  if (!state.credentials.length) side.append(el('div', { class: 'hint', text: 'None yet' }))
  for (const cred of state.credentials) {
    const row = el('div', {
      class: 'side-item',
      title: `Replace ${cred.name}`,
      onclick: () => { state.keyDraftType = cred.type; state.keyDraftName = cred.name; renderKeysHome() },
    }, el('span', { text: cred.name }), el('span', { class: 'count', text: typeLabel(cred.type) }))
    row.oncontextmenu = (event) => contextMenu(event, [
      { label: 'Replace the value', run: () => { state.keyDraftType = cred.type; state.keyDraftName = cred.name; renderKeysHome() } },
      { label: 'Copy its name', run: () => navigator.clipboard.writeText(cred.name).then(() => toast('Copied')) },
      'divider',
      { label: 'Delete', run: async () => {
        if (!confirm(`Delete the key "${cred.name}"? Automations that use it will stop working.`)) return
        const { credentials } = await api(`/api/credentials/${encodeURIComponent(cred.name)}`, { method: 'DELETE' })
        state.credentials = credentials
        renderKeysHome()
      } },
    ])
    side.append(row)
  }

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: 'Keys' }),
    el('p', { text: 'Encrypted on this machine. An automation stores a key\u2019s name, never its value.' })))

  const host = el('div', { class: 'max' })
  sheet.append(host)
  renderKeysInto(host)
}

// Used on the workspace page and inside the editor, so adding a key never means
// leaving what you were building.
function renderKeysInto(host) {
  host.textContent = ''
  const draft = {
    type: state.keyDraftType ?? state.credentialTypes.keys().next().value ?? 'generic',
    values: {}, pairs: [],
  }
  const startName = state.keyDraftName ?? ''
  state.keyDraftType = null
  state.keyDraftName = null

  const list = el('div')
  const form = el('div')
  host.append(list, el('div', { class: 'panel-title', style: 'margin-top:18px', text: startName ? `Replace ${startName}` : 'Add a key' }), form)

  const drawList = () => {
    list.textContent = ''
    if (!state.credentials.length) {
      list.append(el('p', { class: 'hint', text: 'Nothing saved yet.' }))
      return
    }
    for (const cred of state.credentials) {
      const meta = el('div', { class: 'meta' },
        el('div', { class: 'row-inline' }, logoEl(cred.type, 20), el('code', { text: cred.name })),
        el('div', { class: 'hint', text: cred.points ? `${typeLabel(cred.type)} · ${cred.points}` : typeLabel(cred.type) }))
      const actions = el('div', { class: 'actions' })

      if (state.credentialTypes.get(cred.type)?.checkable) {
        const check = el('button', { class: 'ghost', text: 'Test', onclick: async () => {
          check.textContent = '…'
          try {
            const result = await api(`/api/credentials/${encodeURIComponent(cred.name)}/test`, { method: 'POST', body: {} })
            meta.querySelector('.check')?.remove()
            meta.append(el('div', { class: `check ${result.ok ? 'good' : 'bad'}`, text: result.message }))
          } catch (err) { toast(err.message, true) }
          check.textContent = 'test'
        } })
        actions.append(check)
      }
      actions.append(el('button', { class: 'ghost', text: 'Delete', onclick: async () => {
        const { credentials } = await api(`/api/credentials/${encodeURIComponent(cred.name)}`, { method: 'DELETE' })
        state.credentials = credentials
        drawList()
        renderInspector()
      } }))
      list.append(el('div', { class: 'cred-row' }, meta, actions))
    }
  }

  const drawForm = () => {
    form.textContent = ''
    const type = state.credentialTypes.get(draft.type)

    const grid = el('div', { class: 'service-grid picker' })
    // services first, then the three that are ours rather than anybody's
    const HOUSE = { bearer: 1, apiHeader: 2, generic: 3 }
    const ordered = [...state.credentialTypes.values()].sort((a, b) =>
      (HOUSE[a.type] ?? 0) - (HOUSE[b.type] ?? 0) || a.label.localeCompare(b.label))
    for (const candidate of ordered) {
      grid.append(el('button', {
        class: `service-tile${candidate.type === draft.type ? ' active' : ''}`,
        title: candidate.label,
        onclick: () => { draft.type = candidate.type; draft.values = {}; drawForm() },
      }, logoEl(candidate.type, 26), el('small', { text: candidate.label })))
    }
    form.append(field('Service', grid, type?.description))

    const name = el('input', { type: 'text', spellcheck: false, value: startName, placeholder: `${String(draft.type).toLowerCase()}_key` })
    form.append(field('Name', name, 'What functions will call this key.'))

    if (!type?.fields) {
      form.append(field('Fields', keyValueControl(draft.pairs, (rows) => { draft.pairs = rows }),
        'Read them in a function with {{ $creds.name.field }}.'))
    } else {
      for (const spec of type.fields) {
        const input = el('input', {
          type: spec.secret ? 'password' : 'text',
          placeholder: spec.placeholder ?? '',
          value: draft.values[spec.key] ?? spec.default ?? '',
        })
        draft.values[spec.key] = input.value
        input.oninput = () => { draft.values[spec.key] = input.value }
        form.append(field(spec.required === false ? `${spec.label} (optional)` : spec.label, input, spec.description))
      }
      if (type.docs) {
        form.append(el('a', { href: type.docs, target: '_blank', rel: 'noreferrer', class: 'hint', text: 'Where to find this key' }))
      }
    }

    if (type?.hosts?.length) {
      const tags = el('div', { style: 'margin:10px 0' })
      tags.append(el('span', { class: 'hint', text: 'This key is sent to  ' }))
      for (const host of type.hosts) tags.append(el('span', { class: 'tag', text: host }))
      for (const warning of type.warnings ?? []) tags.append(el('span', { class: 'tag warn', text: warning }))
      form.append(tags)
    }

    const problem = el('p', { class: 'error' })
    const values = () => (type?.fields
      ? { ...draft.values }
      : Object.fromEntries(draft.pairs.filter((r) => r.name).map((r) => [r.name, r.value])))

    form.append(el('div', { class: 'row-inline' },
      el('button', { class: 'primary', text: 'Save', onclick: async () => {
        problem.className = 'error'
        problem.textContent = ''
        try {
          const result = await api(`/api/credentials/${encodeURIComponent(name.value.trim())}`,
            { method: 'PUT', body: { type: draft.type, values: values() } })
          state.credentials = result.credentials
          draft.values = {}
          draft.pairs = []
          drawList()
          drawForm()
          renderInspector()
          toast(`saved ${name.value.trim()}`)
        } catch (err) { problem.textContent = err.message }
      } }),
      type?.test ? el('button', { class: 'ghost', text: 'Test', onclick: async () => {
        problem.className = 'error'
        problem.textContent = 'checking…'
        try {
          const result = await api(`/api/credentials/${encodeURIComponent(name.value.trim() || 'draft')}/test`,
            { method: 'POST', body: { type: draft.type, values: values() } })
          problem.className = `error check ${result.ok ? 'good' : 'bad'}`
          problem.textContent = result.message
        } catch (err) { problem.textContent = err.message }
      } }) : null))
    form.append(problem)
  }

  drawList()
  drawForm()
}

// ---------------------------------------------------------------- integrations

function renderIntegrationsHome() {
  const side = $('home-side')
  const sheet = $('home-sheet')
  side.textContent = ''
  sheet.textContent = ''

  const mine = state.integrations.filter((i) => i.editable)
  const shipped = state.integrations.filter((i) => !i.editable)

  side.append(el('div', { class: 'side-item', onclick: () => showIntegrationEditor(null) },
    el('span', { text: '+ Create integration' })))

  if (mine.length) {
    side.append(el('div', { class: 'side-title spaced', text: 'Yours' }))
    for (const spec of mine) {
      side.append(el('div', { class: 'side-item', onclick: () => showIntegration(spec.id) },
        el('span', { text: spec.label }), el('span', { class: 'count', text: `${spec.actions.length}` })))
    }
  }

  side.append(el('div', { class: 'side-title spaced', text: 'Built in' }))
  for (const spec of shipped) {
    side.append(el('div', { class: 'side-item', onclick: () => showIntegration(spec.id) },
      el('span', { text: spec.label }), el('span', { class: 'count', text: `${spec.actions.length}` })))
  }

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: 'Integrations' })))

  const list = el('div', { class: 'integration-list' })
  for (const spec of state.integrations) {
    const row = el('button', { class: 'integration-row', onclick: () => showIntegration(spec.id) },
      logoEl(spec.id, 28),
      el('span', { class: 'grow' },
        el('span', { class: 'integration-name', text: spec.label }),
        el('small', { text: spec.description || '' })),
      el('span', { class: 'count', text: `${spec.actions.length} function${spec.actions.length === 1 ? '' : 's'}` }))
    if (spec.editable) row.append(el('span', { class: 'tag', text: 'Yours' }))
    list.append(row)
  }
  sheet.append(list)
}

function showIntegration(id) {
  const spec = state.integrations.find((i) => i.id === id)
  const sheet = $('home-sheet')
  sheet.textContent = ''
  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: spec.label }),
    el('p', { text: spec.description || '' })))

  const tags = el('div', { style: 'margin-bottom:16px' })
  tags.append(el('span', { class: 'hint', text: 'Contacts  ' }))
  for (const host of spec.hosts) tags.append(el('span', { class: 'tag', text: host }))
  for (const warning of spec.warnings) tags.append(el('span', { class: 'tag warn', text: warning }))
  sheet.append(tags)

  const steps = el('div', { class: 'card max' }, el('h3', { text: 'Functions' }))
  for (const action of spec.actions) {
    steps.append(el('p', {}, copyChip(`${spec.id}.${action.key}`), ` — ${action.label}`))
  }
  sheet.append(steps)

  if (spec.fields.length) {
    const fields = el('div', { class: 'card max' }, el('h3', { text: 'What you fill in' }))
    for (const f of spec.fields) {
      fields.append(el('p', {}, el('code', { text: f.label }), f.secret ? ' — kept secret' : ''))
    }
    sheet.append(fields)
  }

  sheet.append(el('div', { class: 'row-inline' },
    el('button', { class: 'ghost', text: spec.editable ? 'Edit' : 'Copy and edit', onclick: () => showIntegrationEditor(spec.id) }),
    spec.editable ? el('button', { class: 'ghost', text: 'Delete', onclick: async () => {
      if (!confirm(`delete the "${spec.label}" integration?`)) return
      await api(`/api/integrations/${spec.id}`, { method: 'DELETE' })
      await reloadIntegrations()
      renderIntegrationsHome()
    } }) : null,
    el('button', { class: 'ghost', text: 'Back', onclick: renderIntegrationsHome })))
}

const BLANK_INTEGRATION = {
  id: '', label: '', description: '', docs: '', category: 'action',
  credential: { fields: [{ key: 'apiKey', label: 'API key', secret: true, required: true }], auth: { headers: { Authorization: 'Bearer {{ apiKey }}' } } },
  actions: [{
    key: 'send', label: 'Do the thing',
    params: [{ key: 'text', label: 'Text', type: 'textarea' }],
    request: { method: 'POST', url: 'https://api.example.com/v1/things', json: { text: '{{ text }}' } },
    errorPath: 'error.message',
  }],
}

function previewBlock({ title, text, filename }) {
  const bar = el('div', { class: 'preview-bar' }, el('span', { class: 'preview-title', text: title }))
  const copy = el('button', { class: 'icon-btn', title: 'Copy', text: '⧉' })
  copy.onclick = async () => {
    await navigator.clipboard.writeText(text)
    copy.textContent = '✓'
    setTimeout(() => { copy.textContent = '⧉' }, 1600)
  }
  const save = el('button', { class: 'icon-btn', title: `Download ${filename}`, text: '↓' })
  save.onclick = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const link = el('a', { href: url, download: filename })
    link.click()
    URL.revokeObjectURL(url)
  }
  bar.append(copy, save)
  return el('div', { class: 'preview-box' }, bar, el('pre', { class: 'preview-text', text }))
}

// One overlay for the two things somebody wants to look at without leaving the
// canvas: what this automation is, and what to hand an agent.
function openSheet(title, node) {
  $('sheet-over-title').textContent = title
  const body = $('sheet-over-body')
  body.textContent = ''
  body.append(node)
  $('sheet-over').hidden = false
}

const closeSheet = () => { $('sheet-over').hidden = true }
$('sheet-over-close').onclick = closeSheet
$('sheet-over').onclick = (event) => { if (event.target.id === 'sheet-over') closeSheet() }
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('sheet-over').hidden) closeSheet()
})

// The same file Share writes, on screen instead of in the downloads folder.
function shareableWorkflow(wf) {
  return {
    name: wf.name,
    notes: wf.notes ?? '',
    nodes: wf.nodes.map((n) => ({
      id: n.id, type: n.type, name: n.name ?? '', params: n.params ?? {}, position: n.position,
      onError: n.onError ?? 'stop', retries: n.retries ?? 0, retryWait: n.retryWait ?? 0,
    })),
    edges: wf.edges,
  }
}

$('show-json').onclick = async () => {
  if (!state.wf) return
  await save()
  const text = JSON.stringify(shareableWorkflow(state.wf), null, 2)
  const name = state.wf.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  openSheet('This automation as JSON', previewBlock({
    title: `${name}.json`, text, filename: `${name}.json`,
  }))
}

// Two steps, because "copy this reference and work out what to do with it" is
// not an instruction. Say what you want in your own words; the prompt is built
// around it, with the reference underneath so the agent cannot invent a step.
const WANT_PLACEHOLDER = 'I want an automation that checks Reddit, Discord, and the News for any new updates on the Robinhood Chain and posts a daily digest for me on Telegram and Discord'

function agentPromptFor(want, reference) {
  return [
    'Write me a Zorilla automation that does this:',
    '',
    `  ${want.trim()}`,
    '',
    'Reply with the JSON and nothing else. Follow the reference below exactly:',
    'the step types that exist, the parameters each one takes, and how a value',
    'from an earlier step is referenced. Name keys, never paste a key value.',
    'If something cannot be done with the steps listed, use the closest that can',
    'and say so in the automation\'s notes rather than inventing a step.',
    '',
    'Then, in Zorilla, press Import and paste what you get back.',
    '',
    '---',
    '',
    reference,
  ].join('\n')
}

async function showAgentPrompt() {
  let reference = ''
  try {
    reference = await (await fetch('/api/agent-doc')).text()
  } catch {
    return toast('Could not read the reference file.', true)
  }

  const box = el('textarea', {
    rows: 5,
    spellcheck: false,
    placeholder: WANT_PLACEHOLDER,
    style: 'width:100%',
  })
  const problem = el('p', { class: 'error' })
  const body = el('div')

  const make = () => {
    const want = box.value.trim()
    if (!want) {
      problem.textContent = 'Say what you want it to do first.'
      return
    }
    problem.textContent = ''
    body.textContent = ''
    body.append(
      el('p', { class: 'hint', style: 'margin:0 0 10px' },
        'Paste this into Claude, ChatGPT or your own agent. Bring the JSON back with Import.'),
      previewBlock({
        title: 'Your prompt',
        text: agentPromptFor(want, reference),
        filename: 'zorilla-automation-prompt.md',
      }),
      el('div', { class: 'row-inline', style: 'margin-top:12px' },
        el('button', { class: 'primary', text: 'Import the JSON', onclick: () => {
          closeSheet()
          showView('home')
          goToPanel('automations')
          showImport()
        } }),
        el('button', { class: 'ghost', text: 'Change what it does', onclick: () => { body.textContent = ''; box.focus() } })),
    )
  }

  box.onkeydown = (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) make()
  }

  openSheet('Have an agent build it', el('div', {},
    el('p', { class: 'hint', style: 'margin:0 0 10px' }, 'What kind of automation do you want to build?'),
    box,
    el('div', { class: 'row-inline', style: 'margin:10px 0 4px' },
      el('button', { class: 'primary', text: 'Make the prompt', onclick: make })),
    problem,
    body))
}

$('agent-build').onclick = showAgentPrompt

async function showIntegrationEditor(sourceId, forService = null) {
  const sheet = $('home-sheet')
  sheet.textContent = ''
  let spec = structuredClone(BLANK_INTEGRATION)
  if (sourceId) {
    const loaded = await api(`/api/integrations/${sourceId}`)
    const editable = state.integrations.find((i) => i.id === sourceId)?.editable
    spec = { ...loaded, id: editable ? loaded.id : `${loaded.id}_copy` }
  }

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: sourceId ? 'Edit integration' : 'Create integration' }),
    el('p', { text: 'Saved as a file in ~/.zorilla/integrations. No code in it.' })))

  // Nobody should have to learn this file format to add a service. Hand the
  // prompt to an assistant, name the service, paste back what it writes.
  if (!sourceId) {
    const which = el('input', { type: 'text', placeholder: 'Stripe, PagerDuty, your company\u2019s own API\u2026', style: 'width:100%', value: forService ?? '' })
    const built = el('div')
    const help = el('div', { class: 'prompt-help' },
      el('h4', { text: 'Have an agent write it' }),
      el('p', { class: 'hint', style: 'margin:0 0 8px', text: 'Which service do you want to connect?' }),
      which,
      el('div', { class: 'row-inline', style: 'margin:10px 0 4px' },
        el('button', { class: 'primary', text: 'Make the prompt', onclick: () => draw() })),
      built)
    sheet.append(help)

    let template = ''
    const draw = () => {
      const service = which.value.trim()
      if (!service) return toast('Name the service first.', true)
      if (!template) return toast('The prompt file is still loading.', true)
      built.textContent = ''
      built.append(
        el('p', { class: 'hint', style: 'margin:0 0 10px' },
          'Paste this into Claude, ChatGPT or your own agent, then paste the JSON it writes into the box below.'),
        // the placeholder is the only thing standing between somebody and a
        // prompt they can use, so it is filled in for them
        previewBlock({
          title: 'Your prompt',
          text: template.replace(/\[THE SERVICE\]/g, service),
          filename: 'zorilla-integration-prompt.md',
        }))
    }
    which.onkeydown = (event) => { if (event.key === 'Enter') draw() }
    api('/api/integration-prompt')
      .then(({ prompt }) => {
        template = prompt
        if (which.value.trim()) draw()
      })
      .catch((err) => toast(err.message, true))
  }

  const editor = el('textarea', { rows: 26, spellcheck: false, value: JSON.stringify(spec, null, 2), class: 'max', style: 'width:100%' })
  const readout = el('div', { style: 'margin:10px 0' })
  const problem = el('p', { class: 'error' })

  // The picture goes into the file itself, so an integration you hand somebody
  // arrives with its own icon and needs nothing else alongside it.
  const preview = el('span', { class: 'logo', style: 'width:28px;height:28px' })
  const drawPreview = () => {
    preview.textContent = ''
    let current = null
    try { current = JSON.parse(editor.value).icon } catch { /* mid-edit */ }
    if (current) preview.append(el('img', { src: current, alt: '', width: 28, height: 28 }))
    else preview.append(el('span', { class: 'hint', text: 'None' }))
  }
  const picker = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' })
  picker.onchange = async () => {
    const file = picker.files?.[0]
    if (!file) return
    if (file.size > 140_000) { problem.textContent = 'That picture is too big. Around 128 pixels square is plenty.'; return }
    const dataUri = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    try {
      const parsed = JSON.parse(editor.value)
      parsed.icon = dataUri
      editor.value = JSON.stringify(parsed, null, 2)
      problem.textContent = ''
      drawPreview()
    } catch (err) { problem.textContent = `fix the json first: ${err.message}` }
  }
  sheet.append(field('Icon', el('div', { class: 'row-inline' }, preview, picker,
    el('button', { class: 'ghost', text: 'Remove', onclick: () => {
      try {
        const parsed = JSON.parse(editor.value)
        delete parsed.icon
        editor.value = JSON.stringify(parsed, null, 2)
        drawPreview()
      } catch { /* leave it */ }
    } })), 'png, jpeg or webp. it is stored inside the integration file.'))
  drawPreview()

  const check = async () => {
    readout.textContent = ''
    problem.textContent = ''
    let parsed
    try {
      parsed = JSON.parse(editor.value)
    } catch (err) {
      problem.textContent = `not valid JSON: ${err.message}`
      return null
    }
    const result = await api('/api/integrations/check', { method: 'POST', body: parsed })
    if (!result.ok) {
      problem.textContent = result.error
      return null
    }
    readout.append(el('span', { class: 'hint', text: `${result.actions} function(s), contacts  ` }))
    for (const host of result.hosts) readout.append(el('span', { class: 'tag', text: host }))
    for (const warning of result.warnings) readout.append(el('span', { class: 'tag warn', text: warning }))
    return parsed
  }

  editor.oninput = () => { problem.textContent = ''; readout.textContent = '' }

  sheet.append(el('div', { class: 'max' }, editor), readout,
    el('div', { class: 'row-inline' },
      el('button', { class: 'ghost', text: 'Check', onclick: check }),
      el('button', { class: 'primary', text: 'Save', onclick: async () => {
        const parsed = await check()
        if (!parsed) return
        try {
          await api(`/api/integrations/${parsed.id}`, { method: 'PUT', body: parsed })
          await reloadIntegrations()
          toast(`saved ${parsed.label}`)
          renderIntegrationsHome()
        } catch (err) { problem.textContent = err.message }
      } }),
      el('button', { class: 'ghost', text: 'Cancel', onclick: renderIntegrationsHome })),
    problem)
  check()
}

async function reloadIntegrations() {
  const boot = await api('/api/state')
  state.defs = new Map(boot.nodes.map((d) => [d.type, d]))
  state.credentialTypes = new Map(boot.credentialTypes.map((t) => [t.type, t]))
  state.integrations = boot.integrations
  state.credentials = boot.credentials
  renderPalette()
}

// ---------------------------------------------------------------- themes

// A theme is a list of colours, so applying one is writing custom properties on
// the root element. Nothing else in the page knows a theme exists.
const CSS_VAR = {
  bg: '--bg', raise: '--raise', sunk: '--sunk', line: '--line',
  text: '--text', dim: '--dim', dimmer: '--dimmer',
  accent: '--accent', onAccent: '--on-accent',
  ok: '--ok', warn: '--warn', bad: '--bad', skip: '--skip',
  grid: '--grid', wire: '--wire', wireHot: '--wire-hot',
}

const themeColor = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888'

function applyTheme(theme) {
  if (!theme) return
  const root = document.documentElement
  for (const [key, variable] of Object.entries(CSS_VAR)) {
    if (theme.colors[key]) root.style.setProperty(variable, theme.colors[key])
  }
  root.style.setProperty('color-scheme', theme.appearance === 'light' ? 'light' : 'dark')
  state.workspace.theme = theme.id
  if (state.view === 'editor' && state.wf) drawWires()
}

function currentTheme() {
  return state.themes.find((t) => t.id === state.workspace.theme) ?? state.themes[0]
}

async function useTheme(id) {
  const theme = state.themes.find((t) => t.id === id)
  if (!theme) return
  applyTheme(theme)
  state.workspace = await api('/api/workspace', { method: 'PUT', body: { theme: id } })
  if (state.view === 'home' && state.panel === 'settings') renderSettings()
}

async function reloadThemes() {
  state.themes = await api('/api/themes')
  applyTheme(currentTheme())
}

function themeSwatch(theme) {
  const c = theme.colors
  return el('div', { class: 'theme-preview', style: `background:${c.bg}` },
    el('div', { class: 'strip' },
      el('div', { class: 'dot', style: `background:${c.accent}` }),
      el('div', { class: 'plank', style: `background:${c.line}` }),
      el('div', { class: 'dot', style: `background:${c.ok}` })),
    el('div', { class: 'swatch-step', style: `background:${c.raise};border:1px solid ${c.line}` },
      el('div', { class: 'dot', style: `background:${c.accent};width:6px;height:6px` }),
      el('span', { style: `background:${c.text};opacity:.7` })),
    el('div', { class: 'swatch-step', style: `background:${c.raise};border:1px solid ${c.line};margin-left:24px` },
      el('div', { class: 'dot', style: `background:${c.warn};width:6px;height:6px` }),
      el('span', { style: `background:${c.dim}` })))
}

function renderSettings() {
  const side = $('home-side')
  const sheet = $('home-sheet')
  side.textContent = ''
  sheet.textContent = ''

  // each line is the thing it names, so pressing it goes there rather than
  // telling you a number and leaving you to find it
  side.append(el('p', { class: 'side-title', text: 'This workspace' }))
  side.append(el('div', {
    class: 'side-item',
    title: 'Rename this workspace',
    onclick: () => $('workspace-name').click(),
  }, el('span', { text: 'Name' }), el('span', { class: 'count', text: state.workspace.name })))
  side.append(el('div', {
    class: 'side-item',
    onclick: () => goToPanel('automations'),
  }, el('span', { text: 'Automations' }), el('span', { class: 'count', text: String(state.workflows.length) })))
  side.append(el('div', {
    class: 'side-item',
    onclick: () => goToPanel('keys'),
  }, el('span', { text: 'Keys' }), el('span', { class: 'count', text: String(state.credentials.length) })))

  // thirteen themes stand between the top of this panel and the rest of it
  side.append(el('p', { class: 'side-title spaced', text: 'On this page' }))
  for (const [label, title] of [['Theme', 'Theme'], ['Run it on a server', 'Run it on a server']]) {
    side.append(el('div', {
      class: 'side-item',
      onclick: () => {
        const heading = [...document.querySelectorAll('#home-sheet .panel-title')].find((e) => e.textContent === title)
        heading?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    }, el('span', { text: label })))
  }

  side.append(el('p', { class: 'side-title spaced', text: 'Kept in' }))
  side.append(el('div', { class: 'hint', style: 'padding:0 9px; overflow-wrap:anywhere' }, state.home.path))

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: 'Settings' })))

  sheet.append(el('div', { class: 'panel-title', style: 'margin-top:22px', text: 'Theme' })) 

  sheet.append(el('div', { class: 'sheet-actions' },
    el('button', { class: 'ghost', text: 'Refresh', onclick: async () => { await reloadThemes(); renderSettings(); toast('Themes reloaded') } }),
    el('button', { class: 'ghost', text: 'Add from JSON', onclick: showThemeEditor }),
    el('button', { class: 'ghost', text: 'Copy current as JSON', onclick: async () => {
      const theme = currentTheme()
      await navigator.clipboard.writeText(JSON.stringify({
        id: `${theme.id}-copy`, label: `${theme.label} copy`, appearance: theme.appearance, colors: theme.colors,
      }, null, 2))
      toast('Copied')
    } })))

  const grid = el('div', { class: 'theme-grid' })
  for (const theme of state.themes) {
    const card = el('div', {
      class: `theme-card${theme.id === state.workspace.theme ? ' active' : ''}`,
      onclick: () => useTheme(theme.id),
    },
      themeSwatch(theme),
      el('div', { class: 'theme-meta' },
        el('strong', { text: theme.label }),
        el('span', { text: theme.source === 'yours' ? 'yours' : theme.appearance })))
    if (theme.source === 'yours') {
      card.append(el('div', { class: 'row-inline', style: 'padding:0 10px 9px' },
        el('button', {
          class: 'ghost', text: 'Remove',
          onclick: async (event) => {
            event.stopPropagation()
            if (!confirm(`remove the "${theme.label}" theme?`)) return
            await api(`/api/themes/${theme.id}`, { method: 'DELETE' })
            await reloadThemes()
            if (!state.themes.some((t) => t.id === state.workspace.theme)) await useTheme('zorilla-dark')
            renderSettings()
          },
        })))
    }
    grid.append(card)
  }
  sheet.append(grid)

  sheet.append(el('div', { class: 'panel-title', style: 'margin-top:30px', text: 'Run it on a server' }))
  sheet.append(el('p', { class: 'hint', style: 'margin:0 0 12px; max-width:70ch' },
    'Automations only run while Zorilla is running. AKA if you close your laptop, the automations '
    + 'pause. To keep it running 24/7, put Zorilla on your own server. The Dockerfile ships in the '
    + 'repository, so there is nothing to write \u2014 these are the commands to run there.'))

  // The passphrase is the one part somebody has to invent, which is how
  // "pick-something-long-and-private" ends up being somebody's real passphrase.
  // One is made here instead, in this browser, and never written down.
  const commands = el('div')
  let passphrase = null
  const drawCommands = () => {
    commands.textContent = ''
    commands.append(previewBlock({
      title: 'On the server',
      text: DOCKER_HOWTO.replace(PASSPHRASE_PLACEHOLDER, passphrase ?? PASSPHRASE_PLACEHOLDER),
      filename: 'zorilla-on-a-server.md',
    }))
  }

  sheet.append(el('div', { class: 'row-inline', style: 'margin:0 0 10px' },
    el('button', {
      class: 'primary',
      text: 'Generate a passphrase',
      onclick: () => showPassphrase((made) => { passphrase = made; drawCommands() }),
    })))
  drawCommands()
  sheet.append(commands)

  sheet.append(el('p', { class: 'hint', style: 'margin:10px 0 0' },
    el('a', { href: 'https://zorilla.io/docs#server', target: '_blank', rel: 'noreferrer', text: 'What each flag does, in the docs' })))
}

// A passphrase belongs on screen for as long as it takes to copy it and no
// longer, so it arrives covered and somebody has to ask to see it.
function showPassphrase(onMade) {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  const made = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32)

  let bare = false
  const field = el('code', { class: 'passphrase' })
  const eye = el('button', { class: 'ghost' })
  const draw = () => {
    field.textContent = bare ? made : '\u2022'.repeat(made.length)
    eye.textContent = bare ? 'Hide' : 'Reveal'
  }
  eye.onclick = () => { bare = !bare; draw() }
  draw()

  onMade(made)

  openSheet('Your passphrase', el('div', {},
    el('p', { class: 'hint', style: 'margin:0 0 12px; max-width:62ch' },
      'This is now in the command on the settings page. Zorilla has not saved it: it was made in '
      + 'this browser and will be gone when you leave this page.'),
    el('div', { class: 'passphrase-box' }, field),
    el('div', { class: 'row-inline', style: 'margin-top:12px' },
      el('button', { class: 'primary', text: 'Copy', onclick: async () => {
        try { await navigator.clipboard.writeText(made); toast('Copied') }
        catch { toast('Reveal it and copy it by hand', true) }
      } }),
      eye),
    el('p', { class: 'hint', style: 'margin:14px 0 0; max-width:62ch' },
      'Keep it where you keep passwords. A vault cannot be opened with a different passphrase, and '
      + 'a lost one cannot be recovered.')))
}

const PASSPHRASE_PLACEHOLDER = 'pick-something-long-and-private'

// Somebody reading this is on the machine they want to stop depending on, so it
// says every step rather than assuming any of them.
const DOCKER_HOWTO = `# On the server, with Docker installed

git clone https://github.com/getzorilla/zorillaApp
cd zorillaApp
docker build -t zorilla .

docker run -d --name zorilla --restart=always --network host \\
  -v zorilla-data:/data \\
  -e ZORILLA_PASSPHRASE=pick-something-long-and-private \\
  zorilla

# Then, from your own computer

ssh -N -L 5177:127.0.0.1:5177 you@your-server

Open http://127.0.0.1:5177. Same editor, same workspace, on a machine that does
not sleep.

# To update

git pull && docker build -t zorilla .
docker rm -f zorilla

Then run it again. The volume carries your automations and keys across.

# What the three flags are for

--network host    Zorilla binds 127.0.0.1 and that is not configurable, because
                  it holds your keys and has no login. Host networking binds the
                  server's own loopback, so the ssh tunnel above is the only way
                  in.
-v zorilla-data   /data holds the vault, the automations and the run history.
                  Without it, replacing the container loses all three.
-e ZORILLA_...    A password you make up. Your laptop unlocks the vault with a
                  machine key; a server has nobody sitting at it, so it needs
                  this. A vault cannot be opened with a different one.`

function showThemeEditor() {
  const sheet = $('home-sheet')
  sheet.textContent = ''
  const theme = currentTheme()
  const start = JSON.stringify({
    id: 'my-theme', label: 'My theme', appearance: theme.appearance, author: '', colors: theme.colors,
  }, null, 2)

  const box = el('textarea', { value: start, style: 'width:100%;min-height:360px' })
  const problem = el('p', { class: 'error' })

  sheet.append(el('div', { class: 'sheet-head' },
    el('h1', { text: 'Add a theme' }),
    el('p', { text: 'Paste one. It is saved as a file in your themes folder.' })))
  sheet.append(box, problem)
  sheet.append(el('div', { class: 'row-inline' },
    el('button', {
      class: 'primary', text: 'Save',
      onclick: async () => {
        problem.textContent = ''
        let parsed
        try { parsed = JSON.parse(box.value) } catch (err) { problem.textContent = `that is not readable json: ${err.message}`; return }
        try {
          const saved = await api('/api/themes', { method: 'POST', body: parsed })
          await reloadThemes()
          await useTheme(saved.theme.id)
          toast(`${saved.theme.label} added`)
          renderSettings()
        } catch (err) { problem.textContent = err.message }
      },
    }),
    el('button', { class: 'ghost', text: 'Back', onclick: renderSettings })))
}

// ---------------------------------------------------------------- editor state

let saveTimer
function touch() {
  $('save-state').textContent = 'Saving…'
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, 600)
}

// ---------------------------------------------------------------- undo

// Snapshots of the whole graph rather than a list of reversible operations.
// A workflow is small, and the alternative is a second implementation of every
// change that has to stay in step with the first one.
const undos = { past: [], future: [], lastTag: null, lastAt: 0 }
const LIMIT = 60

const snapshot = () => JSON.stringify({
  name: state.wf?.name,
  nodes: state.wf?.nodes ?? [],
  edges: state.wf?.edges ?? [],
})

// Typing in a field fires on every keystroke, so changes with the same tag
// inside a second collapse into one step back.
function remember(tag = null) {
  if (!state.wf) return
  const now = Date.now()
  if (tag && tag === undos.lastTag && now - undos.lastAt < 900) {
    undos.lastAt = now
    return
  }
  undos.past.push(snapshot())
  if (undos.past.length > LIMIT) undos.past.shift()
  undos.future.length = 0
  undos.lastTag = tag
  undos.lastAt = now
}

function restore(json) {
  const state_ = JSON.parse(json)
  state.wf.name = state_.name
  state.wf.nodes = state_.nodes
  state.wf.edges = state_.edges
  if (!state.wf.nodes.some((n) => n.id === state.selected)) state.selected = null
  renderCrumbs()
  renderCanvas()
  renderInspector()
  touch()
}

function undo() {
  if (!undos.past.length) return toast('Nothing to undo')
  undos.future.push(snapshot())
  restore(undos.past.pop())
  undos.lastTag = null
  toast('Undone')
}

function redo() {
  if (!undos.future.length) return toast('Nothing to redo')
  undos.past.push(snapshot())
  restore(undos.future.pop())
  undos.lastTag = null
  toast('Redone')
}

async function save() {
  clearTimeout(saveTimer)
  const wf = state.wf
  if (!wf) return null
  try {
    const saved = wf.id
      ? await api(`/api/workflows/${wf.id}`, { method: 'PUT', body: wf })
      : await api('/api/workflows', { method: 'POST', body: wf })
    wf.id = saved.id
    state.workflows = await api('/api/workflows')
    $('save-state').textContent = 'Saved'
    setTimeout(() => { if ($('save-state').textContent === 'Saved') $('save-state').textContent = '' }, 1400)
  } catch (err) {
    $('save-state').textContent = ''
    toast(err.message, true)
  }
  return wf
}

async function openWorkflow(id) {
  location.hash = `a/${id}`
  markHistory()
  undos.past.length = 0
  undos.future.length = 0
  state.wf = await api(`/api/workflows/${id}`)
  state.selected = null
  state.run = null
  showView('editor')
  setActiveButton(Boolean(state.wf.active))
  renderCrumbs()
  renderPurpose()
  renderCanvas()
  renderInspector()
  state.runs = await api('/api/runs')
  renderRunPicker()
  renderRun(null)
  // after the inspector and the run drawer, not before: they decide how much
  // room the canvas actually has, and fitting against the old size drops the
  // graph off the bottom
  requestAnimationFrame(() => fitView())
}

// "on" on its own never said on what. This says whether the automation runs by
// itself, which is the thing people are actually deciding.
function setActiveButton(on) {
  const button = $('active')
  button.classList.toggle('on', on)
  button.setAttribute('aria-pressed', String(on))
  $('active-label').textContent = on ? 'Live' : 'Not live'
}

$('active').onclick = () => {
  state.wf.active = !state.wf.active
  setActiveButton(state.wf.active)
  toast(state.wf.active ? 'Live' : 'Not live')
  touch()
}

// An automation leaves as a file with the names of keys in it and none of their
// values, because the values were never part of it in the first place.
$('share').onclick = async () => {
  if (!state.wf) return
  await save()
  const wf = state.wf
  const shareable = {
    name: wf.name,
    notes: wf.notes ?? '',
    nodes: wf.nodes.map((n) => ({
      id: n.id, type: n.type, name: n.name ?? '', params: n.params ?? {}, position: n.position,
      onError: n.onError ?? 'stop', retries: n.retries ?? 0, retryWait: n.retryWait ?? 0,
    })),
    edges: wf.edges,
  }

  const blob = new Blob([JSON.stringify(shareable, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = el('a', { href: url, download: `${wf.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json` })
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)

  const named = new Set()
  for (const node of wf.nodes) {
    const def = state.defs.get(node.type)
    for (const param of def?.params ?? []) {
      if (param.type === 'credential' && node.params?.[param.key]) named.add(node.params[param.key])
    }
  }
  toast(named.size
    ? `Saved. It asks for ${[...named].join(', ')} by name, never the key itself`
    : 'Saved to a file')
}

$('save-as').onclick = async () => {
  const name = prompt('Save a copy as', `${state.wf.name} copy`)
  if (name === null) return
  const folder = prompt('Into which folder? (blank for none)', state.wf.folder ?? '')
  if (folder === null) return
  const copy = await api('/api/workflows', {
    method: 'POST',
    body: { ...state.wf, id: null, name: name.trim() || state.wf.name, folder: folder.trim(), active: false },
  })
  state.workflows = await api('/api/workflows')
  toast(`saved as ${copy.name}`)
  openWorkflow(copy.id)
}

function nodeById(id) {
  return state.wf.nodes.find((n) => n.id === id)
}

// ---------------------------------------------------------------- panes

// Both side panels can be dragged wider or folded away, and where somebody put
// them is remembered.
const PANES = {
  palette: { grip: 'grip-palette', fold: 'fold-palette', show: 'show-palette', css: '--palette-w', min: 170, max: 460, off: 'no-palette' },
  inspector: { grip: 'grip-inspector', fold: 'fold-inspector', show: 'show-inspector', css: '--inspector-w', min: 220, max: 560, off: 'no-inspector' },
}

function setPaneWidth(name, px) {
  const pane = PANES[name]
  const width = Math.min(pane.max, Math.max(pane.min, Math.round(px)))
  document.documentElement.style.setProperty(pane.css, `${width}px`)
  try { localStorage.setItem(`zorilla.${name}.w`, String(width)) } catch { /* private mode */ }
}

function foldPane(name, folded) {
  const pane = PANES[name]
  $('editor-view').classList.toggle(pane.off, folded)
  $(pane.show).hidden = !folded
  try { localStorage.setItem(`zorilla.${name}.folded`, folded ? '1' : '') } catch { /* private mode */ }
}

for (const [name, pane] of Object.entries(PANES)) {
  try {
    const saved = Number(localStorage.getItem(`zorilla.${name}.w`))
    if (saved) setPaneWidth(name, saved)
    if (localStorage.getItem(`zorilla.${name}.folded`)) foldPane(name, true)
  } catch { /* private mode */ }

  $(pane.fold).onclick = () => foldPane(name, true)
  $(pane.show).onclick = () => foldPane(name, false)

  const grip = $(pane.grip)
  grip.onpointerdown = (event) => {
    event.preventDefault()
    grip.setPointerCapture(event.pointerId)
    grip.classList.add('dragging')
    const move = (e) => {
      const box = $('editor-view').getBoundingClientRect()
      setPaneWidth(name, name === 'palette' ? e.clientX - box.left : box.right - e.clientX)
    }
    const stop = () => {
      grip.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
  }
  grip.ondblclick = () => foldPane(name, !$('editor-view').classList.contains(pane.off))
}

// ---------------------------------------------------------------- right click

// One menu, wherever somebody right clicks. Items are { label, run, disabled }
// or the string 'divider'.
let openMenu = null

function closeMenu() {
  openMenu?.remove()
  openMenu = null
}

function contextMenu(event, items) {
  event.preventDefault()
  event.stopPropagation()
  closeMenu()

  const menu = el('div', { class: 'menu' })
  for (const item of items) {
    if (item === 'divider') { menu.append(el('div', { class: 'menu-divider' })); continue }
    const row = el('button', { class: `menu-item${item.disabled ? ' disabled' : ''}` },
      el('span', { text: item.label }),
      item.hint ? el('kbd', { text: item.hint }) : null)
    if (!item.disabled) row.onclick = () => { closeMenu(); item.run() }
    menu.append(row)
  }

  document.body.append(menu)
  const box = menu.getBoundingClientRect()
  const x = Math.min(event.clientX, window.innerWidth - box.width - 8)
  const y = Math.min(event.clientY, window.innerHeight - box.height - 8)
  menu.style.left = `${Math.max(8, x)}px`
  menu.style.top = `${Math.max(8, y)}px`
  openMenu = menu
}

window.addEventListener('pointerdown', (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeMenu()
}, true)
window.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu() })
window.addEventListener('blur', closeMenu)
window.addEventListener('scroll', closeMenu, true)

// What a copied function is held in until it is pasted somewhere.
let clipboardNode = null

function copyNode(id) {
  const node = state.wf.nodes.find((n) => n.id === id)
  if (!node) return
  clipboardNode = structuredClone(node)
  navigator.clipboard?.writeText(JSON.stringify(clipboardNode, null, 2)).catch(() => {})
  toast('Copied')
}

function pasteNode(x, y) {
  if (!clipboardNode) return toast('Nothing to paste')
  const at = { x: x ?? clipboardNode.position.x + 40, y: y ?? clipboardNode.position.y + 40 }
  remember()
  const node = {
    ...structuredClone(clipboardNode),
    id: `n${Math.random().toString(36).slice(2, 9)}`,
    position: { x: Math.round(at.x), y: Math.round(at.y) },
  }
  state.wf.nodes.push(node)
  renderCanvas()
  selectNode(node.id)
  touch()
}

function duplicateNode(id) {
  const node = state.wf.nodes.find((n) => n.id === id)
  if (!node) return
  clipboardNode = structuredClone(node)
  pasteNode(node.position.x + 40, node.position.y + 40)
}

function selectNode(id) {
  state.selected = id
  for (const node of document.querySelectorAll('.node')) node.classList.toggle('selected', node.dataset.id === id)
  renderInspector()
}

function addNode(type, x, y) {
  remember()
  const def = state.defs.get(type)
  const node = {
    id: `n${Math.random().toString(36).slice(2, 9)}`,
    type,
    name: '',
    params: Object.fromEntries((def.params ?? []).map((p) => [p.key, structuredClone(p.default ?? '')])),
    position: { x: Math.round(x), y: Math.round(y) },
  }
  state.wf.nodes.push(node)
  renderCanvas()
  selectNode(node.id)
  touch()
  return node
}

function removeNode(id) {
  remember()
  state.wf.nodes = state.wf.nodes.filter((n) => n.id !== id)
  state.wf.edges = state.wf.edges.filter((e) => e.from !== id && e.to !== id)
  if (state.selected === id) state.selected = null
  renderCanvas()
  renderInspector()
  touch()
}

function connect(from, fromPort, to) {
  if (from === to) return toast('A function cannot feed itself.', true)
  remember()
  if (state.wf.edges.some((e) => e.from === from && e.fromPort === fromPort && e.to === to)) return
  state.wf.edges.push({ from, fromPort, to, toPort: 'main' })
  renderCanvas()
  touch()
}

// ---------------------------------------------------------------- palette

const CATEGORY_ORDER = ['trigger', 'logic', 'transform', 'web3', 'action', 'output']
const CATEGORY_LABEL = {
  trigger: 'Triggers', action: 'Actions', logic: 'Logic',
  transform: 'Transform', output: 'Output', web3: 'Onchain',
}

// Anything somebody might retype into an expression or a prompt is one click
// away from the clipboard instead.
function copyChip(text, label = text) {
  const chip = el('button', { class: 'copy-chip', title: `Copy ${text}` }, el('code', { text: label }))
  chip.onclick = async (event) => {
    event.stopPropagation()
    await navigator.clipboard.writeText(text)
    chip.classList.add('copied')
    setTimeout(() => chip.classList.remove('copied'), 1200)
  }
  return chip
}

function stepItem(def) {
  const service = serviceOf(def)
  const item = el('div', { class: 'palette-item' },
    service ? logoEl(service, 18) : null,
    el('div', { class: 'palette-text' },
      el('div', { text: def.label }),
      el('small', { text: def.description ?? '' })),
    copyChip(def.type))
  item.dataset.type = def.type
  item.title = 'Drag onto the canvas, or click'
  return item
}

// Steps from services are behind their service rather than poured into one long
// list: fifteen services times three actions each is not a list anybody reads.
function renderPalette() {
  const host = $('palette')
  if (!host) return
  const term = ($('palette-search')?.value ?? '').trim().toLowerCase()
  host.textContent = ''

  const all = [...state.defs.values()]

  if (term) {
    const hits = all.filter((def) =>
      `${def.label} ${def.type} ${def.description ?? ''} ${serviceOf(def) ?? ''}`.toLowerCase().includes(term))
    host.append(el('h4', { text: `${hits.length} function${hits.length === 1 ? '' : 's'} matching` }))
    for (const def of hits.sort((a, b) => a.label.localeCompare(b.label))) host.append(stepItem(def))
    if (!hits.length) host.append(el('p', { class: 'hint', text: 'No match.' }))
    return
  }

  // One row per service, opening onto its own steps. Fifteen services with two
  // or three steps each is a list nobody reads if it is poured out flat.
  const services = new Map()
  for (const def of all) {
    const id = serviceOf(def)
    if (!id) continue
    if (!services.has(id)) services.set(id, [])
    services.get(id).push(def)
  }

  if (services.size) {
    host.append(el('h4', { text: 'Services' }))
    for (const [id, defs] of [...services].sort((a, b) => a[0].localeCompare(b[0]))) {
      host.append(serviceRow(id, defs))
    }
  }

  const byCategory = new Map()
  for (const def of all) {
    if (serviceOf(def)) continue
    if (!byCategory.has(def.category)) byCategory.set(def.category, [])
    byCategory.get(def.category).push(def)
  }
  const rank = (c) => (CATEGORY_ORDER.indexOf(c) === -1 ? 99 : CATEGORY_ORDER.indexOf(c))
  for (const category of [...byCategory.keys()].sort((a, b) => rank(a) - rank(b))) {
    host.append(el('h4', { text: CATEGORY_LABEL[category] ?? category }))
    for (const def of byCategory.get(category).sort((a, b) => a.label.localeCompare(b.label))) {
      host.append(stepItem(def))
    }
  }
}

function serviceRow(id, defs) {
  const spec = state.integrations.find((i) => i.id === id)
  const label = spec?.label ?? SERVICE_LABEL[id] ?? state.credentialTypes.get(id)?.label ?? id.charAt(0).toUpperCase() + id.slice(1)
  const open = state.paletteService === id

  const row = el('button', {
    class: `service-row${open ? ' open' : ''}`,
    onclick: () => { state.paletteService = open ? null : id; renderPalette() },
  },
    logoEl(id, 22),
    el('span', { class: 'service-name', text: label }),
    el('span', { class: 'service-count', text: `${defs.length}` }),
    el('span', { class: 'chevron', text: open ? '\u2013' : '+' }))

  const wrap = el('div', { class: 'service-block' }, row)
  if (!open) return wrap

  const credType = defs.map((d) => (d.params ?? []).find((p) => p.type === 'credential')?.credentialType).find(Boolean)
  if (credType) {
    const saved = state.credentials.filter((c) => c.type === credType)
    wrap.append(el('div', { class: 'service-note hint' }, saved.length
      ? `key: ${saved.map((c) => c.name).join(', ')}`
      : el('span', {}, `no ${label} key yet. `,
          el('a', { href: '#', onclick: (e) => { e.preventDefault(); openKeysTab(credType) }, text: 'Add one' }))))
  }

  // inside Discord, a label like "Post to Discord" is saying the word twice
  const strip = new RegExp(`\\s*(to|from|a|an)?\\s*\\b${label}\\b\\s*`, 'i')
  for (const def of defs.sort((a, b) => a.label.localeCompare(b.label))) {
    const short = def.label.replace(strip, ' ').replace(/\s+/g, ' ').trim()
    wrap.append(stepItem({ ...def, label: short ? short.charAt(0).toUpperCase() + short.slice(1) : def.label }))
  }
  return wrap
}

$('palette-search').oninput = renderPalette

function openKeysTab(credentialType) {
  // the draft type has to be set before the tab renders, not after
  state.keyDraftType = credentialType ?? null
  const tab = document.querySelector('.tab[data-tab="keys"]')
  if (tab) tab.click()
  else renderKeysInto($('tab-keys'))
}

// ---------------------------------------------------------------- canvas

const world = () => $('world')
const wireLayer = () => $('wire-layer')

function outPorts(node) {
  const ports = [...(state.defs.get(node.type)?.outputs ?? ['main'])]
  if (node.onError === 'errorOutput' && !ports.includes('error')) ports.push('error')
  return ports
}

function portPoint(node, port) {
  if (port === null) return { x: node.position.x, y: node.position.y + IN_Y }
  const i = Math.max(0, outPorts(node).indexOf(port))
  return { x: node.position.x + NODE_W, y: node.position.y + OUT_Y + i * OUT_STEP }
}

function applyView() {
  const { x, y, k } = state.viewBox
  world().style.transform = `translate(${x}px, ${y}px) scale(${k})`
  wireLayer().setAttribute('transform', `translate(${x} ${y}) scale(${k})`)
}

// Opening something somebody else built should show all of it, not a corner of
// it. Nobody thinks to scroll a canvas they have never seen before.
function fitView(padding = 60) {
  const nodes = state.wf?.nodes ?? []
  const box = $('canvas').getBoundingClientRect()
  if (!nodes.length || !box.width) {
    state.viewBox = { x: 60, y: 40, k: 1 }
    applyView()
    return
  }

  const left = Math.min(...nodes.map((n) => n.position.x))
  const right = Math.max(...nodes.map((n) => n.position.x + NODE_W))
  const top = Math.min(...nodes.map((n) => n.position.y))
  const bottom = Math.max(...nodes.map((n) => n.position.y + 90))

  // never shrink past readable: a wide automation stays legible and the person
  // pans to the rest of it
  const k = Math.max(0.5, Math.min(1, (box.width - padding * 2) / (right - left), (box.height - padding * 2) / (bottom - top)))
  state.viewBox = {
    k,
    x: (box.width - (right - left) * k) / 2 - left * k,
    y: (box.height - (bottom - top) * k) / 2 - top * k,
  }
  applyView()
}

// a window that changes shape leaves the graph wherever it was, which on a
// smaller one means off screen entirely
let refit = null
window.addEventListener('resize', () => {
  if (state.view !== 'editor' || !state.wf) return
  clearTimeout(refit)
  refit = setTimeout(() => fitView(), 150)
})

function toWorld(clientX, clientY) {
  const box = $('canvas').getBoundingClientRect()
  const { x, y, k } = state.viewBox
  return { x: (clientX - box.left - x) / k, y: (clientY - box.top - y) / k }
}

function disconnectNode(id) {
  const before = state.wf.edges.length
  remember()
  state.wf.edges = state.wf.edges.filter((e) => e.from !== id && e.to !== id)
  renderCanvas()
  touch()
  toast(`${before - state.wf.edges.length} wire(s) removed`)
}

function canvasMenu(event) {
  if (event.target.closest('.node')) return
  const at = toWorld(event.clientX, event.clientY)
  contextMenu(event, [
    { label: 'Paste', hint: '⌘V', run: () => pasteNode(at.x - NODE_W / 2, at.y - 20), disabled: !clipboardNode },
    'divider',
    { label: 'Undo', hint: '⌘Z', run: undo, disabled: !undos.past.length },
    { label: 'Redo', hint: '⌘⇧Z', run: redo, disabled: !undos.future.length },
    'divider',
    { label: 'Fit to window', run: () => fitView() },
    { label: 'Add a function', run: () => $('palette-search')?.focus() },
  ])
}

// An expression is a setting like any other on a card. The braces and the $json
// are scaffolding the reader already knows about.
const plain = (value) => String(value ?? '')
  .replace(/\{\{\s*|\s*\}\}/g, '')
  .replace(/\$json\./g, '')
  .trim()

const short = (address) => {
  const text = plain(address)
  return /^0x[0-9a-fA-F]{40}$/.test(text) ? `${text.slice(0, 6)}…${text.slice(-4)}` : text
}

const plural = (word, count) => (Number(count) === 1 ? word.replace(/s$/, '') : word)

const OPERATIONS = {
  equals: 'is', notEquals: 'is not',
  contains: 'contains', notContains: 'does not contain',
  greater: 'is over', less: 'is under',
  isEmpty: 'is empty', isNotEmpty: 'is not empty', isTrue: 'is true',
}

function condition(params) {
  const left = plain(params.value)
  const how = OPERATIONS[params.operation] ?? params.operation
  if (!left) return ''
  return ['isEmpty', 'isNotEmpty', 'isTrue'].includes(params.operation)
    ? `${left} ${how}`
    : `${left} ${how} ${plain(params.compare)}`.trim()
}

// The name of a step says what kind of thing it is. This says what this one,
// with the settings it has, is actually going to do.
const SUMMARY = {
  'core.manual': () => 'When you press run',
  'core.schedule': (p) => (p.mode === 'once'
    ? (p.at ? `Once, at ${String(p.at).replace('T', ' ')}` : 'Once, at a time you pick')
    : `Every ${p.every ?? 1} ${plural(p.unit ?? 'minutes', p.every ?? 1)}`),
  'core.webhook': (p) => (p.path ? `When something posts to /hook/${p.path}` : 'When something posts to an address of yours'),
  'logic.if': (p) => condition(p),
  'logic.filter': (p) => (condition(p) ? `Keeps the ones where ${condition(p)}` : ''),
  'logic.once': (p) => (p.key ? `Once per ${plain(p.key)}, ever` : 'The first time only'),
  'logic.changed': (p) => (p.value ? `Only when ${plain(p.value)} changes` : ''),
  'logic.moved': (p) => (p.value
    ? `only when ${plain(p.value)} moves by ${p.amount ?? 0}${p.unit === 'percent' ? '%' : ''}`
    : ''),
  'flow.stop': () => 'Switches this automation off',
  'output.log': (p) => plain(p.message),
  'code.js': () => 'JavaScript you wrote',
  'transform.set': (p) => {
    const names = (p.fields ?? []).map((f) => f.name).filter(Boolean)
    return names.length ? `Sets ${names.join(', ')}` : ''
  },
  'net.http': (p) => {
    const url = plain(p.url)
    let where = url
    try { where = new URL(url).host } catch { /* templated, so show it as written */ }
    return where ? `${p.method ?? 'GET'} ${where}` : ''
  },
  'web3.balance': (p) => (p.address ? `${short(p.address)} on ${p.chain ?? 'ethereum'}` : ''),
  'web3.erc20Balance': (p) => [short(p.token), p.address ? `held by ${short(p.address)}` : '']
    .filter(Boolean).join(' '),
  'web3.read': (p) => {
    const fn = /function\s+([a-zA-Z0-9_]+)/.exec(String(p.signature ?? ''))
    return [fn?.[1], p.address ? `on ${short(p.address)}` : ''].filter(Boolean).join(' ')
  },
  'web3.logs': (p) => {
    const name = /event\s+([a-zA-Z0-9_]+)/.exec(String(p.event ?? ''))
    const where = (p.match ?? []).map((m) => `${m.name} = ${short(m.value)}`).join(', ')
    return [
      [name?.[1], p.address ? `on ${short(p.address)}` : ''].filter(Boolean).join(' '),
      where ? `where ${where}` : '',
    ].filter(Boolean).join(', ')
  },
  'web3.gas': (p) => `on ${p.chain ?? 'ethereum'}`,
  'web3.ens': (p) => plain(p.value),
  'web3.prepare': (p) => [
    p.value && p.value !== '0' ? `${plain(p.value)} ETH` : '',
    p.to ? `to ${short(p.to)}` : '',
  ].filter(Boolean).join(' ') || 'Works out what it would cost, sends nothing',
  'coingecko.price': (p) => [plain(p.ids), p.currency ? `in ${plain(p.currency)}` : ''].filter(Boolean).join(' '),
  'slack.post': (p) => plain(p.channel),
  'anthropic.ask': (p) => plain(p.model),
  'openai.ask': (p) => plain(p.model),
  'gemini.ask': (p) => plain(p.model),
  'deepseek.ask': (p) => plain(p.model),
}

function summaryOf(node, def) {
  if (!def) return { text: 'Not installed', unknown: true }
  let text = ''
  try { text = SUMMARY[node.type]?.(node.params ?? {}) ?? '' } catch { text = '' }
  return { text: text || def.description || def.type, unknown: false }
}

function renderCanvas() {
  const host = world()
  host.textContent = ''
  for (const node of state.wf.nodes) {
    const def = state.defs.get(node.type)
    const box = el('div', { class: 'node' })
    box.dataset.id = node.id
    box.style.left = `${node.position.x}px`
    box.style.top = `${node.position.y}px`
    if (node.id === state.selected) box.classList.add('selected')
    const service = def ? serviceOf(def) : null
    box.append(el('div', { class: 'node-head' },
      service ? logoEl(service, 16) : null,
      el('div', { class: 'title', text: node.name || def?.label || node.type })))
    const said = summaryOf(node, def)
    box.append(el('div', { class: `what${said.unknown ? ' unknown' : ''}`, text: said.text }))

    // a step that authenticates says whose key it is using, on the card itself,
    // because "post to discord" on its own never answers "as who?"
    // only the key a step actually needs; an optional one saying "no key chosen"
    // reads like something is wrong when nothing is
    const credParam = (def?.params ?? []).find((p) => p.type === 'credential' && p.key === 'credential' && p.required !== false)
    if (credParam) {
      const chosen = node.params[credParam.key]
      const points = state.credentials.find((c) => c.name === chosen)?.points
      box.append(chosen
        ? el('div', { class: 'node-key', text: points ? `${chosen} · ${points}` : `as ${chosen}` })
        : el('div', { class: 'node-key missing', text: 'No key chosen' }))
    }

    if (def?.category !== 'trigger') {
      const input = el('div', { class: 'port in' })
      input.dataset.node = node.id
      box.append(input)
    }
    const ports = outPorts(node)
    ports.forEach((port, i) => {
      const dot = el('div', { class: `port out${port === 'error' ? ' error' : ''}` })
      dot.dataset.node = node.id
      dot.dataset.port = port
      dot.style.top = `${20 + i * OUT_STEP}px`
      box.append(dot)
      if (ports.length > 1) {
        const label = el('div', { class: 'port-label', text: port })
        label.style.top = `${18 + i * OUT_STEP}px`
        box.append(label)
      }
    })
    box.oncontextmenu = (event) => {
      selectNode(node.id)
      contextMenu(event, [
        { label: 'Copy', hint: '⌘C', run: () => copyNode(node.id) },
        { label: 'Duplicate', hint: '⌘D', run: () => duplicateNode(node.id) },
        { label: 'Paste', run: () => pasteNode(), disabled: !clipboardNode },
        'divider',
        { label: 'Disconnect wires', run: () => disconnectNode(node.id) },
        { label: 'Delete', hint: '⌫', run: () => removeNode(node.id) },
      ])
    }
    host.append(box)
  }
  drawWires()
  applyView()
  $('empty-hint').style.display = state.wf.nodes.length ? 'none' : 'grid'
}

function bezier(a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) / 2)
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`
}

function drawWires(temp = null) {
  const layer = wireLayer()
  layer.textContent = ''
  const NS = 'http://www.w3.org/2000/svg'

  for (const edge of state.wf.edges) {
    const from = nodeById(edge.from)
    const to = nodeById(edge.to)
    if (!from || !to) continue
    const d = bezier(portPoint(from, edge.fromPort), portPoint(to, null))

    const hit = document.createElementNS(NS, 'path')
    hit.setAttribute('d', d)
    hit.setAttribute('stroke', 'transparent')
    hit.setAttribute('stroke-width', '14')
    hit.setAttribute('fill', 'none')
    hit.style.cursor = 'pointer'

    const line = document.createElementNS(NS, 'path')
    line.setAttribute('d', d)
    line.setAttribute('stroke', themeColor('--wire'))
    line.setAttribute('stroke-width', '2')
    line.setAttribute('fill', 'none')

    hit.addEventListener('mouseenter', () => line.setAttribute('stroke', themeColor('--bad')))
    hit.addEventListener('mouseleave', () => line.setAttribute('stroke', themeColor('--wire')))
    hit.addEventListener('click', () => {
      remember()
      state.wf.edges = state.wf.edges.filter((e) => e !== edge)
      renderCanvas()
      touch()
      toast('Connection removed')
    })

    const group = document.createElementNS(NS, 'g')
    group.append(hit, line)
    layer.append(group)
  }

  if (temp) {
    const line = document.createElementNS(NS, 'path')
    line.setAttribute('d', bezier(temp.a, temp.b))
    line.setAttribute('stroke', themeColor('--wire-hot'))
    line.setAttribute('stroke-width', '2')
    line.setAttribute('stroke-dasharray', '5 4')
    line.setAttribute('fill', 'none')
    layer.append(line)
  }
}

let drag = null

// Clicking adds the step in the middle of the canvas; dragging puts it where
// you let go. Both, because a click that does nothing reads as a broken button.
$('palette').addEventListener('click', (event) => {
  const item = event.target.closest('.palette-item')
  if (!item || item.dataset.dragged === 'yes') return
  const box = $('canvas').getBoundingClientRect()
  const at = toWorld(box.left + box.width / 2, box.top + box.height / 2)
  addNode(item.dataset.type, at.x - NODE_W / 2, at.y - 20)
  toast('Added')
})

$('palette').addEventListener('pointerdown', (event) => {
  const item = event.target.closest('.palette-item')
  if (!item) return
  event.preventDefault()
  item.dataset.dragged = 'no'
  drag = { kind: 'palette', type: item.dataset.type, item, startX: event.clientX, startY: event.clientY, node: null }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
})

$('canvas').addEventListener('contextmenu', canvasMenu)

$('canvas').addEventListener('pointerdown', (event) => {
  const port = event.target.closest('.port')
  if (port?.classList.contains('out')) {
    port.classList.add('armed')
    const node = nodeById(port.dataset.node)
    drag = { kind: 'link', from: node.id, fromPort: port.dataset.port, port, a: portPoint(node, port.dataset.port) }
  } else {
    const box = event.target.closest('.node')
    if (box) {
      const node = nodeById(box.dataset.id)
      selectNode(node.id)
      remember(`move:${node.id}`)
      const start = toWorld(event.clientX, event.clientY)
      drag = { kind: 'node', id: node.id, dx: start.x - node.position.x, dy: start.y - node.position.y, moved: false }
    } else {
      selectNode(null)
      drag = { kind: 'pan', startX: event.clientX, startY: event.clientY, ox: state.viewBox.x, oy: state.viewBox.y }
      $('canvas').classList.add('panning')
    }
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
})

function onMove(event) {
  if (!drag) return
  if (drag.kind === 'palette') {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return
    // while the pointer is still over the palette there is nowhere sensible to
    // put it, so it starts in the middle and follows the pointer from there
    const box = $('canvas').getBoundingClientRect()
    const inside = event.clientX > box.left
    const at = inside
      ? toWorld(event.clientX, event.clientY)
      : toWorld(box.left + box.width / 2, box.top + box.height / 2)
    if (drag.item) drag.item.dataset.dragged = 'yes'
    const created = addNode(drag.type, at.x - NODE_W / 2, at.y - 20)
    drag = { kind: 'node', id: created.id, dx: NODE_W / 2, dy: 20, moved: true }
    return
  }
  if (drag.kind === 'node') {
    const at = toWorld(event.clientX, event.clientY)
    const node = nodeById(drag.id)
    node.position = { x: Math.round(at.x - drag.dx), y: Math.round(at.y - drag.dy) }
    const box = document.querySelector(`.node[data-id="${node.id}"]`)
    box.style.left = `${node.position.x}px`
    box.style.top = `${node.position.y}px`
    drag.moved = true
    drawWires()
    return
  }
  if (drag.kind === 'link') {
    drawWires({ a: drag.a, b: toWorld(event.clientX, event.clientY) })
    return
  }
  if (drag.kind === 'pan') {
    state.viewBox.x = drag.ox + (event.clientX - drag.startX)
    state.viewBox.y = drag.oy + (event.clientY - drag.startY)
    applyView()
  }
}

function onUp(event) {
  window.removeEventListener('pointermove', onMove)
  $('canvas').classList.remove('panning')
  if (!drag) return
  if (drag.kind === 'link') {
    drag.port.classList.remove('armed')
    const target = document.elementFromPoint(event.clientX, event.clientY)
    const input = target?.closest('.port.in') || target?.closest('.node')?.querySelector('.port.in')
    if (input) connect(drag.from, drag.fromPort, input.dataset.node)
    else drawWires()
  }
  if (drag.kind === 'node' && drag.moved) touch()
  drag = null
}

$('canvas').addEventListener('wheel', (event) => {
  event.preventDefault()
  const box = $('canvas').getBoundingClientRect()
  const next = Math.min(2, Math.max(0.35, state.viewBox.k * Math.exp(-event.deltaY * 0.0015)))
  const px = event.clientX - box.left
  const py = event.clientY - box.top
  state.viewBox.x = px - (px - state.viewBox.x) * (next / state.viewBox.k)
  state.viewBox.y = py - (py - state.viewBox.y) * (next / state.viewBox.k)
  state.viewBox.k = next
  applyView()
}, { passive: false })

window.addEventListener('keydown', (event) => {
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
  if (state.view !== 'editor') return

  const meta = event.metaKey || event.ctrlKey
  if (meta && event.key.toLowerCase() === 'z') {
    event.preventDefault()
    if (event.shiftKey) redo()
    else undo()
    return
  }
  if (meta && event.key.toLowerCase() === 'y') {
    event.preventDefault()
    redo()
    return
  }

  if (typing || !state.selected) return
  if (event.key === 'Delete' || event.key === 'Backspace') {
    event.preventDefault()
    removeNode(state.selected)
  }
})

// ---------------------------------------------------------------- inspector

function field(label, control, description) {
  return el('div', { class: 'field' },
    el('label', { text: label }),
    control,
    description ? el('div', { class: 'desc', text: description }) : null)
}

function keyValueControl(rows, onChange) {
  const host = el('div')
  const list = Array.isArray(rows) ? rows : []
  const redraw = () => {
    host.textContent = ''
    list.forEach((row, i) => {
      const name = el('input', { type: 'text', placeholder: 'Name', value: row.name ?? '' })
      const value = el('input', { type: 'text', placeholder: 'Value', value: row.value ?? '' })
      name.oninput = () => { list[i].name = name.value; onChange(list) }
      value.oninput = () => { list[i].value = value.value; onChange(list) }
      host.append(el('div', { class: 'kv-row' }, name, value,
        el('button', { class: 'ghost', text: '×', onclick: () => { list.splice(i, 1); onChange(list); redraw() } })))
    })
    host.append(el('button', { class: 'ghost', text: '+ Add', onclick: () => { list.push({ name: '', value: '' }); onChange(list); redraw() } }))
  }
  redraw()
  return host
}

function listControl(rows, onChange) {
  const host = el('div')
  const list = Array.isArray(rows) ? rows : []
  const redraw = () => {
    host.textContent = ''
    list.forEach((row, i) => {
      const value = el('input', { type: 'text', placeholder: `value ${i + 1}`, value: row ?? '' })
      value.oninput = () => { list[i] = value.value; onChange(list) }
      host.append(el('div', { class: 'kv-row list-row' }, value,
        el('button', { class: 'ghost', text: '×', onclick: () => { list.splice(i, 1); onChange(list); redraw() } })))
    })
    host.append(el('button', { class: 'ghost', text: '+ Add', onclick: () => { list.push(''); onChange(list); redraw() } }))
  }
  redraw()
  return host
}

function visible(param, params) {
  if (!param.showWhen) return true
  return Object.entries(param.showWhen).every(([key, want]) => {
    const value = params[key]
    return Array.isArray(want) ? want.includes(value) : value === want
  })
}

// Everything needed to make a webhook reachable, in one place: the address to
// hand over, whether the outside world can actually get to it, and the button
// that changes that.
function webhookAddress(node) {
  const box = el('div')
  const tunnel = state.tunnel ?? {}
  const base = tunnel.url || state.home.publicUrl || `http://127.0.0.1:${state.home.port}`
  const secret = String(node.params.secret ?? '')
  const address = `${base}/hook/${String(node.params.path ?? '').replace(/^\//, '')}${secret ? `?secret=${encodeURIComponent(secret)}` : ''}`
  const reachable = Boolean(tunnel.url || state.home.publicUrl)

  box.append(field('The address to give them',
    el('div', { class: 'hook-address' }, el('code', { text: address })),
    reachable
      ? 'Anyone on the internet can reach this. Keep a secret on it.'
      : 'This machine only. Stripe and GitHub cannot reach it yet.'))

  box.append(el('div', { class: 'row-inline', style: 'margin:-8px 0 8px' },
    el('button', { class: 'ghost', text: 'Copy', onclick: async () => { await navigator.clipboard.writeText(address); toast('Copied') } }),
    el('button', { class: 'ghost', text: secret ? 'New secret' : 'Add a secret', onclick: () => {
      node.params.secret = newSecret()
      touch()
      renderInspector()
    } })))

  if (tunnel.url) {
    box.append(el('div', { class: 'row-inline' },
      el('span', { class: 'tag on', text: 'Reachable' }),
      el('button', { class: 'ghost', text: 'Stop', onclick: async () => {
        state.tunnel = await api('/api/tunnel', { method: 'DELETE' })
        toast('The address is gone')
        renderInspector()
      } })))
    box.append(el('p', { class: 'hint', style: 'margin:6px 0 12px' },
      'A restart gives you a new address, and whoever you gave it to will need it.'))
    return box
  }

  const note = el('p', { class: 'hint', style: 'margin:4px 0 0' })
  const open = el('button', { class: 'primary', text: 'Create address' })
  open.onclick = async () => {
    open.disabled = true
    note.textContent = 'Starting…'
    try {
      if (!node.params.secret) {
        node.params.secret = newSecret()
        touch()
      }
      state.tunnel = await api('/api/tunnel', { method: 'POST', body: {} })
      toast('Reachable')
      renderInspector()
    } catch (err) {
      note.textContent = err.message
      open.disabled = false
    }
  }

  // what it is for, out of the way until somebody asks
  const why = el('p', { class: 'hint why', hidden: true },
    'Stripe, Shopify and GitHub send you a message when something happens. They '
    + 'cannot reach your computer, so this gives you an address to paste into them. '
    + 'Nothing else on your computer becomes reachable, and the address stops working '
    + 'when you stop it.'
    + (tunnel.installed ? '' : ` The first time, Zorilla fetches Cloudflare's tunnel program, about 30MB.`))
  const info = el('button', {
    class: 'info-dot',
    text: 'i',
    title: 'What is this for?',
    'aria-label': 'What is this for?',
    onclick: () => { why.hidden = !why.hidden },
  })

  box.append(el('div', { class: 'row-inline' }, open, info), note, why)
  return box
}

const newSecret = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

// A step nothing provides. Saying "not installed" and stopping leaves somebody
// with a broken automation and nowhere to go, so this works out what is
// actually wrong: usually the service is here and the action name is not, and
// then the fix is one press.
function missingStep(node) {
  const box = el('div')
  const [prefix] = String(node.type).split('.')
  const siblings = [...state.defs.values()].filter((d) => d.type.startsWith(`${prefix}.`))
  const spec = state.integrations.find((i) => i.id === prefix)

  box.append(el('div', { class: 'kind', text: node.type }))

  if (siblings.length) {
    const name = spec?.label ?? prefix
    box.append(el('div', { class: 'checklist' },
      el('h4', { text: `${name} is here, but has nothing called "${node.type.split('.').slice(1).join('.')}"` }),
      el('p', { class: 'hint', style: 'margin:0 0 10px' }, 'Swap it for one of these and the automation works again:')))
    const list = el('div', { class: 'row-inline', style: 'flex-wrap:wrap; margin:-6px 0 12px' })
    for (const other of siblings) {
      list.append(el('button', {
        class: 'ghost',
        text: other.label,
        title: other.type,
        onclick: () => {
          remember()
          node.type = other.type
          renderCanvas()
          renderInspector()
          touch()
          toast(`Now using ${other.label}`)
        },
      }))
    }
    box.append(list)
    return box
  }

  box.append(el('div', { class: 'checklist' },
    el('h4', { text: `Nothing here provides "${prefix}"` }),
    el('p', { class: 'hint', style: 'margin:0' },
      'This automation was written against something this copy of Zorilla does not have. '
      + 'Add the service under Integrations, or write it with the prompt there.')))
  box.append(el('div', { class: 'row-inline' },
    el('button', {
      class: 'primary',
      text: 'Open Integrations',
      onclick: () => { showView('home'); goToPanel('integrations') },
    })))
  return box
}

function renderInspector() {
  const host = $('inspector')
  host.textContent = ''
  const node = state.selected && state.wf ? nodeById(state.selected) : null
  if (!node) {
    $('inspector-title').textContent = 'Nothing selected'
    // with nothing selected, the panel is free to say what the whole thing
    // still needs before it could run
    if (state.wf) {
      if (state.wf.notes) host.append(el('p', { class: 'hint', style: 'margin-bottom:12px', text: state.wf.notes }))
      const needs = whatItNeeds(state.wf)
      if (needs.length) {
        const list = el('ul')
        for (const line of needs) list.append(el('li', { text: line }))
        host.append(el('div', { class: 'checklist' }, el('h4', { text: 'The following are required:' }), list))
      } else {
        host.append(el('p', { class: 'hint' }, 'Ready. Press run to try it, or switch it to live so it runs on its own.'))
      }
    }
    return
  }
  const def = state.defs.get(node.type)
  $('inspector-title').textContent = def?.label ?? node.type
  // the card used to carry the type; it says what the step will do now, so the
  // one place left that names the kind is here
  if (def) host.append(el('div', { class: 'kind', text: def.type }))
  if (def?.description) host.append(el('p', { class: 'hint', text: def.description }))
  if (!def) {
    host.append(missingStep(node))
    return
  }

  // a webhook is only useful if you can see the address to paste elsewhere
  if (node.type === 'core.webhook') host.append(webhookAddress(node))

  const service = def ? serviceOf(def) : null
  const spec = service ? state.integrations.find((i) => i.id === service) : null
  if (spec?.hosts?.length) {
    const tags = el('div', { style: 'margin:-2px 0 12px' })
    tags.append(el('span', { class: 'hint', text: 'Contacts  ' }))
    for (const h of spec.hosts) tags.append(el('span', { class: 'tag', text: h }))
    host.append(tags)
  }

  const name = el('input', { type: 'text', value: node.name ?? '', placeholder: def?.label ?? node.type })
  name.oninput = () => {
    remember(`name:${node.id}`)
    node.name = name.value
    document.querySelector(`.node[data-id="${node.id}"] .title`).textContent = node.name || def?.label || node.type
    touch()
  }
  host.append(field('Name on the canvas', name))

  for (const param of def?.params ?? []) {
    if (!visible(param, node.params)) continue
    const value = node.params[param.key]
    const set = (next) => {
      remember(`param:${node.id}:${param.key}`)
      node.params[param.key] = next
      touch()
    }
    let control

    if (param.type === 'select') {
      control = el('select')
      for (const option of param.options ?? []) control.append(new Option(option.label ?? option, option.value ?? option))
      control.value = value ?? ''
      control.onchange = () => { set(control.value); renderInspector() }
    } else if (param.type === 'boolean') {
      control = el('input', { type: 'checkbox', checked: Boolean(value) })
      control.onchange = () => { set(control.checked); renderInspector() }
    } else if (param.type === 'datetime') {
      control = el('input', { type: 'datetime-local', value: value ?? '' })
      control.oninput = () => set(control.value)
    } else if (param.type === 'number') {
      control = el('input', { type: 'number', value: value ?? '' })
      if (param.min !== undefined) control.min = param.min
      control.oninput = () => set(control.value === '' ? '' : Number(control.value))
    } else if (param.type === 'textarea' || param.type === 'code') {
      control = el('textarea', { rows: param.type === 'code' ? 10 : 4, value: value ?? '' })
      control.oninput = () => set(control.value)
    } else if (param.type === 'keyvalue') {
      control = keyValueControl(value, set)
    } else if (param.type === 'list') {
      control = listControl(value, set)
    } else if (param.type === 'credential') {
      control = el('select')
      control.append(new Option('— pick a saved key —', ''))
      const matching = state.credentials.filter((c) => !param.credentialType || c.type === param.credentialType)
      for (const cred of matching) {
        control.append(new Option(cred.points ? `${cred.name} · ${cred.points}` : `${cred.name} · ${typeLabel(cred.type)}`, cred.name))
      }
      control.value = value ?? ''
      control.onchange = () => { set(control.value); renderCanvas(); selectNode(node.id) }

      if (!matching.length) {
        const wanted = param.credentialType ? typeLabel(param.credentialType) : 'key'
        const add = el('button', {
          class: 'ghost', text: `add a ${wanted} key`,
          onclick: () => { openKeysTab(param.credentialType) },
        })
        host.append(field(param.label, el('div', {}, control, add),
          `no ${wanted} key yet.`))
        continue
      }
      host.append(field(param.label, control,
        param.description ?? 'The account this runs as.'))
      continue
    } else {
      control = el('input', { type: 'text', placeholder: param.placeholder ?? '', value: value ?? '' })
      control.oninput = () => set(control.value)
    }
    host.append(field(param.label, control, param.description))
  }

  // the steps that keep something between runs can be made to forget it
  if (['logic.once', 'logic.changed', 'logic.moved'].includes(node.type)) {
    host.append(el('div', { class: 'panel-title', style: 'margin-top:18px', text: 'What it remembers' }))
    const note = el('p', { class: 'hint', text: 'It remembers between runs, so it knows what it has already told you.' })
    const forget = el('button', {
      class: 'ghost', text: 'Make it forget',
      onclick: async () => {
        if (!state.wf?.id) return toast('Save this automation first', true)
        await api(`/api/workflows/${state.wf.id}/memory/${node.id}`, { method: 'DELETE' })
        toast('Forgotten. The next run starts fresh')
      },
    })
    host.append(note, el('div', { class: 'row-inline', style: 'margin-bottom:6px' }, forget))
  }

  host.append(el('div', { class: 'panel-title', style: 'margin-top:18px', text: 'When it fails' }))

  const onError = el('select')
  for (const [value, label] of [
    ['stop', 'Stop this branch'],
    ['continue', 'Carry on, with the error attached'],
    ['errorOutput', 'Send it down an error wire'],
  ]) onError.append(new Option(label, value))
  onError.value = node.onError ?? 'stop'
  onError.onchange = () => {
    node.onError = onError.value
    touch()
    renderCanvas()
    selectNode(node.id)
  }
  host.append(field('If this function fails', onError))

  const retries = el('input', { type: 'number', min: 0, max: 5, value: node.retries ?? 0 })
  retries.oninput = () => { node.retries = Math.min(5, Math.max(0, Number(retries.value) || 0)); touch() }
  host.append(field('Try again', retries, 'How many extra attempts before it counts as failed.'))

  if ((node.retries ?? 0) > 0) {
    const wait = el('input', { type: 'number', min: 0, value: Math.round((node.retryWait ?? 2000) / 1000) })
    wait.oninput = () => { node.retryWait = Math.max(0, Number(wait.value) || 0) * 1000; touch() }
    host.append(field('Wait between tries (seconds)', wait))
  }

  host.append(el('button', { class: 'ghost', style: 'margin-top:16px', text: 'Delete function', onclick: () => removeNode(node.id) }))
}

// ---------------------------------------------------------------- runs

function setNodeStatus(id, status) {
  const box = document.querySelector(`.node[data-id="${id}"]`)
  if (!box) return
  box.classList.remove('status-ok', 'status-error', 'status-skipped', 'status-running')
  if (status) box.classList.add(`status-${status}`)
}

function renderRun(run) {
  state.run = run
  const body = $('run-body')
  body.textContent = ''
  if (!run) {
    $('run-summary').textContent = ''
    return
  }
  const failed = Object.values(run.nodes).filter((n) => n.status === 'error').length
  $('run-summary').textContent = run.error
    ? run.error
    : `${run.status === 'ok' ? 'Finished' : 'Finished with problems'} · ${Object.keys(run.nodes).length} functions${failed ? ` · ${failed} failed` : ''}`

  for (const [id, result] of Object.entries(run.nodes)) {
    const node = state.wf.nodes.find((n) => n.id === id)
    const def = node && state.defs.get(node.type)
    const out = Object.entries(result.itemsOut ?? {}).map(([port, n]) => `${port} ${n}`).join(', ')
    const row = el('div', { class: 'run-node' },
      el('div', { class: 'head' },
        el('span', { class: 'name', text: node?.name || def?.label || id }),
        el('span', { class: `badge ${result.status}`, text: result.status }),
        el('span', { class: 'hint', text: result.status === 'skipped'
          ? (result.reason ?? '')
          : `in ${result.itemsIn}${out ? ` · out ${out}` : ''} · ${result.ms}ms` })))
    for (const line of result.logs ?? []) row.append(el('div', { class: 'msg', text: line.message }))
    if (result.error) row.append(el('div', { class: 'msg bad', text: result.error }))
    body.append(row)
  }
}

function renderRunPicker() {
  const picker = $('run-picker')
  picker.textContent = ''
  const mine = state.runs.filter((r) => r.workflowId === state.wf?.id)
  if (!mine.length) {
    picker.append(new Option('No runs yet', ''))
    return
  }
  for (const run of mine) {
    picker.append(new Option(`${new Date(run.startedAt).toLocaleTimeString()} · ${run.status}`, run.runId))
  }
  if (state.run) picker.value = state.run.runId
}

$('run').onclick = async () => {
  await save()
  const triggers = state.wf.nodes.filter((n) => state.defs.get(n.type)?.category === 'trigger')
  if (!triggers.length) return toast('Add a trigger function first.', true)
  const selected = state.selected ? nodeById(state.selected) : null
  const trigger = (selected && state.defs.get(selected.type)?.category === 'trigger') ? selected : triggers[0]

  for (const box of document.querySelectorAll('.node')) setNodeStatus(box.dataset.id, null)
  $('drawer').classList.add('open')
  $('run-summary').textContent = 'running…'
  try {
    const run = await api(`/api/workflows/${state.wf.id}/run`, { method: 'POST', body: { triggerNodeId: trigger.id } })
    state.runs = await api('/api/runs')
    renderRunPicker()
    renderRun(run)
    for (const [id, result] of Object.entries(run.nodes)) setNodeStatus(id, result.status === 'ok' ? 'ok' : result.status)
  } catch (err) {
    toast(err.message, true)
    $('run-summary').textContent = err.message
  }
}

function toggleDrawer(open) {
  const drawer = $('drawer')
  const now = open ?? !drawer.classList.contains('open')
  drawer.classList.toggle('open', now)
  $('drawer-toggle').title = now ? 'Close the run log (⌘J)' : 'Open the run log (⌘J)'
}
$('drawer-toggle').onclick = () => toggleDrawer()
$('run-picker').onchange = async (event) => {
  if (event.target.value) renderRun(await api(`/api/runs/${event.target.value}`))
}

// A page that throws goes blank and takes the reason with it. This keeps the
// reason on screen, says the files are fine, and gives somewhere to send it.
let crashShown = false
function showCrash(what, where) {
  if (crashShown) return
  crashShown = true
  const detail = [
    what,
    where ? `at ${where}` : '',
    navigator.userAgent,
    new Date().toISOString(),
  ].filter(Boolean).join('\n')
  $('crashed-detail').textContent = detail
  $('crashed').hidden = false
  $('crashed-reload').onclick = () => location.reload()
  $('crashed-copy').onclick = async () => {
    await navigator.clipboard.writeText(detail)
    $('crashed-copy').textContent = 'Copied'
  }
  $('crashed-dismiss').onclick = () => { $('crashed').hidden = true; crashShown = false }
}

window.addEventListener('error', (event) => {
  showCrash(event.error?.stack || event.message, `${event.filename}:${event.lineno}`)
})
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason
  showCrash(reason?.stack || reason?.message || String(reason), '')
})

// Everywhere you can get to, in one list. A workspace with fifty automations
// is faster to search than to scroll, and the panels are here so the same key
// gets you anywhere rather than only to automations.
function finderEntries() {
  const out = []
  for (const w of state.workflows) {
    out.push({ label: w.name, kind: w.folder || 'Automation', run: () => { closeFinder(); openWorkflow(w.id) } })
  }
  for (const [panel, label] of [['automations', 'Workspace'], ['keys', 'Keys'], ['integrations', 'Integrations'], ['settings', 'Settings']]) {
    out.push({ label, kind: 'Panel', run: () => { closeFinder(); showView('home'); goToPanel(panel) } })
  }
  for (const c of state.credentials) {
    out.push({ label: c.name, kind: 'Key', run: () => { closeFinder(); showView('home'); goToPanel('keys') } })
  }
  for (const w of state.workspaces?.list ?? []) {
    if (w.id === state.workspaces.current) continue
    out.push({ label: w.name, kind: 'Workspace', run: () => { closeFinder(); switchWorkspace(w.id) } })
  }
  out.push(
    { label: 'New Automation', kind: 'Do', run: () => { closeFinder(); newAutomation() } },
    { label: 'Import an automation', kind: 'Do', run: () => { closeFinder(); showView('home'); goToPanel('automations'); showImport() } },
    { label: 'Have an agent build it', kind: 'Do', run: () => { closeFinder(); showAgentPrompt() } },
    { label: 'Create New workspace', kind: 'Do', run: () => { closeFinder(); newWorkspace() } },
  )
  return out
}

let finderPick = 0
let finderShown = []

function renderFinder() {
  const term = $('finder-input').value.trim().toLowerCase()
  finderShown = finderEntries()
    .filter((e) => !term || e.label.toLowerCase().includes(term) || e.kind.toLowerCase().includes(term))
    .slice(0, 40)
  if (finderPick >= finderShown.length) finderPick = 0
  const body = $('finder-results')
  body.textContent = ''
  if (!finderShown.length) {
    body.append(el('div', { class: 'finder-empty', text: 'Nothing here by that name.' }))
    return
  }
  finderShown.forEach((entry, i) => {
    const row = el('button', { class: `finder-row${i === finderPick ? ' on' : ''}`, onclick: entry.run },
      el('span', { text: entry.label }),
      el('span', { class: 'finder-kind', text: entry.kind }))
    row.onmousemove = () => { if (finderPick !== i) { finderPick = i; renderFinder() } }
    body.append(row)
  })
}

function openFinder() {
  finderPick = 0
  $('finder-input').value = ''
  $('finder').hidden = false
  renderFinder()
  $('finder-input').focus()
}

function closeFinder() { $('finder').hidden = true }

$('palette-open').onclick = openFinder
$('finder-input').oninput = () => { finderPick = 0; renderFinder() }
$('finder').onclick = (event) => { if (event.target.id === 'finder') closeFinder() }
$('finder-input').onkeydown = (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); finderPick = Math.min(finderPick + 1, finderShown.length - 1); renderFinder() }
  if (event.key === 'ArrowUp') { event.preventDefault(); finderPick = Math.max(finderPick - 1, 0); renderFinder() }
  if (event.key === 'Enter') { event.preventDefault(); finderShown[finderPick]?.run() }
  if (event.key === 'Escape') closeFinder()
}

window.addEventListener('keydown', (event) => {
  const meta = event.metaKey || event.ctrlKey
  if (meta && event.key.toLowerCase() === 'k') {
    event.preventDefault()
    $('finder').hidden ? openFinder() : closeFinder()
  }
  if (meta && event.key.toLowerCase() === 'j' && state.view === 'editor') {
    event.preventDefault()
    toggleDrawer()
  }
})

// The guide. Real screenshots of this app, one line each, because somebody
// opening it for the first time wants to know where things are, not to read.
const GUIDE = [
  {
    shot: 'workspace',
    title: 'Your workspace',
    body: 'Everything you build is on this screen. Ten demos are in the Examples group already. Open one and press "Run". Press "New Automation" to start your own.',
  },
  {
    shot: 'agent',
    title: 'Or have an agent build it',
    body: 'Say what you want in your own words. Zorilla writes the prompt, your agent writes the automation, and "Import" brings it in.',
  },
  {
    shot: 'canvas',
    title: 'Build it on the canvas',
    body: 'Drag functions in from the left and wire them together. Each one says what it will do with the settings it has.',
  },
  {
    shot: 'keys',
    title: 'Your keys never leave',
    body: 'Save a key once under "Keys". An automation names the key, never its value, so sharing one never shares your keys.',
  },
  {
    shot: 'run',
    title: 'Run it, read the log',
    body: 'Press "Run". The log shows what every function got and what it sent. Switch it to "Live" and its trigger runs it for you.',
  },
  {
    shot: 'live',
    title: 'It runs while your computer is awake',
    body: 'Zorilla runs on this machine, so a live automation only fires while the machine is on. For something that runs around the clock, put Zorilla on a server you own. Encrypted servers hosted in-house are coming soon.',
  },
  {
    shot: 'finder',
    title: 'Press ⌘K to go anywhere',
    body: 'Any automation, panel, key or workspace by name.',
  },
]

let guideAt = 0

function drawGuide() {
  const slide = GUIDE[guideAt]
  $('guide-img').src = `/guide/${slide.shot}.png`
  $('guide-step').textContent = `${guideAt + 1} of ${GUIDE.length}`
  $('guide-title').textContent = slide.title
  $('guide-body').textContent = slide.body
  $('guide-back').disabled = guideAt === 0
  $('guide-next').textContent = guideAt === GUIDE.length - 1 ? 'Done' : 'Next'
  const dots = $('guide-dots')
  dots.textContent = ''
  GUIDE.forEach((_, i) => {
    dots.append(el('button', {
      class: `guide-dot${i === guideAt ? ' on' : ''}`,
      title: `${i + 1}`,
      onclick: () => { guideAt = i; drawGuide() },
    }))
  })
}

function openGuide() {
  guideAt = 0
  $('guide-again').checked = Boolean(state.preferences?.guideDone)
  $('guide').hidden = false
  drawGuide()
}

// The checkbox is the setting, so it is saved when the guide closes however it
// closes: the button, the backdrop or escape.
async function closeGuide() {
  $('guide').hidden = true
  const done = $('guide-again').checked
  if (done === Boolean(state.preferences?.guideDone)) return
  state.preferences = { ...state.preferences, guideDone: done }
  try {
    await api('/api/preferences', { method: 'PUT', body: { guideDone: done } })
  } catch {
    toast('That preference could not be saved.', true)
  }
}

$('guide-next').onclick = () => {
  if (guideAt === GUIDE.length - 1) return closeGuide()
  guideAt += 1
  drawGuide()
}
$('guide-back').onclick = () => { guideAt = Math.max(0, guideAt - 1); drawGuide() }
$('guide').onclick = (event) => { if (event.target.id === 'guide') closeGuide() }
window.addEventListener('keydown', (event) => {
  if ($('guide').hidden) return
  if (event.key === 'Escape') closeGuide()
  if (event.key === 'ArrowRight') { guideAt = Math.min(guideAt + 1, GUIDE.length - 1); drawGuide() }
  if (event.key === 'ArrowLeft') { guideAt = Math.max(guideAt - 1, 0); drawGuide() }
})

const LIVE_LOG_LINES = 500

const events = new EventSource('/api/events')
events.onmessage = (message) => {
  const event = JSON.parse(message.data)
  if (state.view !== 'editor') return
  if (event.type === 'node:start') setNodeStatus(event.nodeId, 'running')
  if (event.type === 'node:end') setNodeStatus(event.nodeId, event.status === 'ok' ? 'ok' : event.status)
  if (event.type === 'node:log') {
    const body = $('run-body')
    body.append(el('div', { class: 'log-line', text: event.message }))
    // a live automation logging on a timer runs for days. without a cap the
    // page grows a node per line until the tab is unusable
    while (body.childElementCount > LIVE_LOG_LINES) body.firstElementChild.remove()
    body.scrollTop = body.scrollHeight
  }
}

for (const tab of document.querySelectorAll('.tab')) {
  tab.onclick = () => {
    for (const other of document.querySelectorAll('.tab')) other.classList.toggle('active', other === tab)
    $('tab-steps').hidden = tab.dataset.tab !== 'steps'
    $('tab-keys').hidden = tab.dataset.tab !== 'keys'
    if (tab.dataset.tab === 'keys') renderKeysInto($('tab-keys'))
  }
}

// ---------------------------------------------------------------- boot

const boot = await api('/api/state')
state.defs = new Map(boot.nodes.map((d) => [d.type, d]))
state.credentialTypes = new Map(boot.credentialTypes.map((t) => [t.type, t]))
state.integrations = boot.integrations
state.credentials = boot.credentials
state.workflows = boot.workflows
state.runs = boot.runs
state.armed = boot.armed ?? []
state.workspaces = await api('/api/workspaces')
state.preferences = await api('/api/preferences').catch(() => ({ guideDone: false }))
state.workspace = boot.workspace
state.themes = boot.themes ?? []
state.home = { port: boot.port, path: boot.home, publicUrl: boot.publicUrl ?? '' }
state.tunnel = boot.tunnel ?? {}
applyTheme(currentTheme())

renderPalette()

// a link straight to a panel, or to one automation
// The address bar was written to but never read after boot, so the browser's
// own back and forward did nothing. Routing on hashchange makes those work, and
// the two arrows drive the same history.
let routing = false

// Firefox throws rather than shrugging when window.history.back() has nowhere to go,
// and an arrow that looks pressable but is not is the same bug either way. Every
// entry is stamped with its position, so both arrows know whether they lead
// anywhere and grey out when they do not.
let here = 0
let top = 0
history.replaceState({ ...(history.state ?? {}), z: 0 }, '')

function markHistory() {
  const z = history.state?.z
  if (typeof z === 'number') {
    here = z
  } else {
    here = ++top
    history.replaceState({ ...(history.state ?? {}), z: here }, '')
  }
  drawArrows()
}

function drawArrows() {
  $('go-back').disabled = here <= 0
  $('go-forward').disabled = here >= top
}

async function routeTo(hash) {
  const at = String(hash).replace(/^#/, '')
  if (at.startsWith('a/')) {
    const id = at.slice(2)
    if (state.wf?.id === id && state.view === 'editor') return
    if (state.workflows.some((w) => w.id === id)) return openWorkflow(id)
    return
  }
  const panel = ['keys', 'integrations', 'settings', 'automations'].includes(at) ? at : 'automations'
  // goToPanel writes the hash itself, so this fires a tick after whatever it
  // drew. Re-rendering here would wipe that — the import screen's "Get the
  // prompt" landed on an empty panel for exactly this reason.
  const alreadyThere = state.view === 'home' && state.panel === panel
  state.panel = panel
  for (const item of document.querySelectorAll('.rail-item')) {
    item.classList.toggle('active', item.dataset.panel === panel)
  }
  if (!alreadyThere) showView('home')
}

window.addEventListener('hashchange', async () => {
  // openWorkflow and goToPanel set the hash themselves; without this they would
  // route a second time on their own write
  if (routing) return
  routing = true
  try {
    markHistory()
    await routeTo(location.hash)
  } finally {
    routing = false
  }
})

$('go-back').onclick = () => { if (here > 0) history.back() }
$('go-forward').onclick = () => { if (here < top) history.forward() }
drawArrows()

const wanted = applyHash()
if (wanted.open && state.workflows.some((w) => w.id === wanted.open)) {
  await openWorkflow(wanted.open)
} else {
  for (const item of document.querySelectorAll('.rail-item')) {
    item.classList.toggle('active', item.dataset.panel === state.panel)
  }
  showView('home')
}

if (boot.problems?.length) {
  $('palette-problems').textContent = boot.problems.map((p) => `${p.file}: ${p.message}`).join('\n')
}

// Every start until somebody says otherwise.
if (!state.preferences?.guideDone) openGuide()
