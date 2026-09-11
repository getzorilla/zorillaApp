import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { dataDir, ensureDir, readJson, writeJson, listJson, removeFile } from './files.js'

const KEEP_RUNS = 200

export class Store {
  constructor(dir) {
    this.dir = dir
    this.problems = []
    this.workflowDir = path.join(dir, 'workflows')
    this.runDir = path.join(dir, 'runs')
    this.runIndexFile = path.join(this.runDir, 'index.json')
  }

  static async open(dir = dataDir()) {
    const store = new Store(dir)
    await ensureDir(store.workflowDir)
    await ensureDir(store.runDir)
    return store
  }

  // One workspace for now, named by whoever is using it, holding folders of
  // automations. The folder is a plain string on each automation rather than a
  // directory, so renaming a folder never moves a file.
  async getWorkspace() {
    const saved = await readJson(path.join(this.dir, 'workspace.json'), null)
    return { name: 'My Workspace', folders: [], theme: 'zorilla-dark', seeded: false, ...(saved ?? {}) }
  }

  async saveWorkspace(input) {
    const current = await this.getWorkspace()
    const workspace = {
      name: String(input.name ?? current.name).trim() || 'My Workspace',
      folders: [...new Set((input.folders ?? current.folders).map((f) => String(f).trim()).filter(Boolean))].sort(),
      // just an id. If the theme it names is gone, the page falls back to the
      // default rather than the workspace becoming unopenable.
      theme: String(input.theme ?? current.theme ?? 'zorilla-dark').trim() || 'zorilla-dark',
      // whether the examples have been put in once. Deleting them has to stick,
      // so this records that they were offered, not how many are left.
      seeded: Boolean(input.seeded ?? current.seeded),
    }
    await writeJson(path.join(this.dir, 'workspace.json'), workspace)
    return workspace
  }

  // One unreadable file used to stop zorilla starting at all. People edit these
  // by hand, and a typo in one automation must not take the other twelve with
  // it, so a bad file is reported and stepped over.
  async listWorkflows() {
    const files = await listJson(this.workflowDir)
    const out = []
    this.problems = []
    for (const file of files) {
      try {
        const wf = await readJson(path.join(this.workflowDir, file))
        if (wf) out.push(wf)
      } catch (err) {
        this.problems.push({ file: path.join(this.workflowDir, file), message: err.message })
      }
    }
    return out.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  }

  async getWorkflow(id) {
    try {
      return await readJson(path.join(this.workflowDir, `${id}.json`))
    } catch (err) {
      throw new Error(`That automation's file cannot be read: ${err.message}`)
    }
  }

  async saveWorkflow(input) {
    const workflow = {
      id: input.id || randomUUID(),
      name: input.name || 'untitled automation',
      folder: String(input.folder ?? '').trim(),
      example: Boolean(input.example),
      notes: String(input.notes ?? '').slice(0, 400),
      active: Boolean(input.active),
      nodes: input.nodes ?? [],
      edges: input.edges ?? [],
      updatedAt: new Date().toISOString(),
    }
    await writeJson(path.join(this.workflowDir, `${workflow.id}.json`), workflow)
    return workflow
  }

  async removeWorkflow(id) {
    await removeFile(path.join(this.workflowDir, `${id}.json`))
  }

  async runIndex() {
    return (await readJson(this.runIndexFile, [])) ?? []
  }

  async saveRun(run) {
    await writeJson(path.join(this.runDir, `${run.runId}.json`), run)
    const index = await this.runIndex()
    index.unshift({
      runId: run.runId,
      workflowId: run.workflowId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      status: run.status,
    })
    const dropped = index.splice(KEEP_RUNS)
    await writeJson(this.runIndexFile, index)
    for (const old of dropped) await removeFile(path.join(this.runDir, `${old.runId}.json`))
    return run
  }

  async listRuns({ workflowId = null, limit = 25 } = {}) {
    const index = await this.runIndex()
    return index.filter((r) => !workflowId || r.workflowId === workflowId).slice(0, limit)
  }

  async getRun(runId) {
    return readJson(path.join(this.runDir, `${runId}.json`))
  }
}
