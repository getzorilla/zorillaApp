import path from 'node:path'
import { ensureDir, readJson, writeJson } from './files.js'

// What a step remembers between runs. Without this, a workflow that alerts when
// a price crosses a line cannot tell "it just crossed" from "it is still over",
// and mails you every time it wakes up.
//
// One file per workflow, shaped { nodeId: { key: value } }, so deleting a
// workflow's memory is deleting one file.
export class Memory {
  constructor(dir) {
    this.dir = dir
    this.cache = new Map()
  }

  static async open(dir) {
    const memory = new Memory(path.join(dir, 'memory'))
    await ensureDir(memory.dir)
    return memory
  }

  fileFor(workflowId) {
    return path.join(this.dir, `${workflowId || 'draft'}.json`)
  }

  async load(workflowId) {
    const key = workflowId || 'draft'
    if (!this.cache.has(key)) {
      this.cache.set(key, (await readJson(this.fileFor(key), {})) ?? {})
    }
    return this.cache.get(key)
  }

  async save(workflowId) {
    await writeJson(this.fileFor(workflowId), await this.load(workflowId))
  }

  async forget(workflowId) {
    this.cache.delete(workflowId || 'draft')
    await writeJson(this.fileFor(workflowId), {})
  }

  // Handed to a step already narrowed to itself, so one step cannot read or
  // overwrite what another one remembered.
  scope(workflowId, nodeId) {
    return {
      get: async (key = 'value') => {
        const data = await this.load(workflowId)
        return data[nodeId]?.[key]
      },
      set: async (key, value) => {
        const data = await this.load(workflowId)
        data[nodeId] ??= {}
        data[nodeId][key] = value
        await this.save(workflowId)
        return value
      },
      remove: async (key = 'value') => {
        const data = await this.load(workflowId)
        if (data[nodeId]) delete data[nodeId][key]
        await this.save(workflowId)
      },
      clear: async () => {
        const data = await this.load(workflowId)
        delete data[nodeId]
        await this.save(workflowId)
      },
      everything: async () => {
        const data = await this.load(workflowId)
        return data[nodeId] ?? {}
      },
    }
  }
}

// Used by tests and by any run with no store behind it: remembers within the
// run and forgets afterwards.
export function scratchMemory() {
  const store = new Map()
  return (nodeId) => ({
    get: async (key = 'value') => store.get(`${nodeId}:${key}`),
    set: async (key, value) => (store.set(`${nodeId}:${key}`, value), value),
    remove: async (key = 'value') => void store.delete(`${nodeId}:${key}`),
  })
}
