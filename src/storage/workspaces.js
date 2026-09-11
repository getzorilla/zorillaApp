// More than one workspace in a single Zorilla folder.
//
// A workspace owns its automations, its run history, its scratch memory and its
// vault. The keys are deliberately not shared: folders already group automations
// inside one workspace, so the only thing a second workspace can be for is
// keeping things apart — work from personal, a client's from your own — and that
// means nothing if both see the same keys.
//
// The first workspace is the folder itself, exactly as it was before any of this
// existed, so nobody's data moves and an old install opens unchanged. Every
// workspace after it lives under workspaces/<id>/.
import path from 'node:path'
import { readJson, writeJson, ensureDir } from './files.js'

export const DEFAULT_ID = 'default'

const FILE = 'workspaces.json'
const slug = (name) => String(name).toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)

export function dirFor(home, id) {
  return id === DEFAULT_ID ? home : path.join(home, 'workspaces', id)
}

async function read(home) {
  const saved = await readJson(path.join(home, FILE), null)
  if (saved?.list?.length) {
    return { current: saved.current ?? DEFAULT_ID, list: saved.list }
  }
  return { current: DEFAULT_ID, list: [{ id: DEFAULT_ID, name: 'My Workspace' }] }
}

const save = (home, state) => writeJson(path.join(home, FILE), state, { mode: 0o600 })

export async function list(home) {
  const state = await read(home)
  // the name on disk wins: it is what the person edited in the breadcrumb
  const withNames = await Promise.all(state.list.map(async (entry) => {
    const own = await readJson(path.join(dirFor(home, entry.id), 'workspace.json'), null)
    return { ...entry, name: own?.name ?? entry.name }
  }))
  return { current: withNames.some((w) => w.id === state.current) ? state.current : DEFAULT_ID, list: withNames }
}

export async function create(home, name) {
  const state = await read(home)
  const wanted = slug(name) || 'workspace'
  if (wanted === DEFAULT_ID || state.list.some((w) => w.id === wanted)) {
    throw new Error(`There is already a workspace called "${name}".`)
  }
  const dir = dirFor(home, wanted)
  await ensureDir(dir)
  await writeJson(path.join(dir, 'workspace.json'), { name: String(name).trim() || 'Workspace', folders: [], theme: 'zorilla-dark' })
  state.list.push({ id: wanted, name: String(name).trim() })
  state.current = wanted
  await save(home, state)
  return { id: wanted, name: String(name).trim() }
}

export async function choose(home, id) {
  const state = await read(home)
  if (!state.list.some((w) => w.id === id)) throw new Error('That workspace is not here any more.')
  state.current = id
  await save(home, state)
  return id
}

// Removing one leaves its folder alone. Deleting somebody's automations because
// they wanted the name out of a list is not a trade worth making; the folder is
// named in the message so they can remove it themselves if they meant to.
export async function forget(home, id) {
  if (id === DEFAULT_ID) throw new Error('The first workspace cannot be removed.')
  const state = await read(home)
  state.list = state.list.filter((w) => w.id !== id)
  if (state.current === id) state.current = DEFAULT_ID
  await save(home, state)
  return { removed: id, kept: dirFor(home, id) }
}
