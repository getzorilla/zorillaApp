import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { readFile, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { dataDir, ensureDir, readJson, writeJson } from '../storage/files.js'

const KDF = { name: 'scrypt', N: 32768, r: 8, p: 1 }
const MAXMEM = 96 * 1024 * 1024

function deriveKey(secret, saltB64) {
  return scryptSync(secret, Buffer.from(saltB64, 'base64'), 32, { ...KDF, maxmem: MAXMEM })
}

// Used when no passphrase is set. This protects the vault against something
// reading the file alone; it does not protect against code running as this
// user. When packaged, the OS keychain replaces this on macOS and Windows.
async function machineSecret(dir) {
  const file = path.join(dir, 'machine.key')
  try {
    return (await readFile(file, 'utf8')).trim()
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    const secret = randomBytes(32).toString('base64')
    await ensureDir(dir)
    await writeFile(file, `${secret}\n`, { mode: 0o600 })
    await chmod(file, 0o600)
    return secret
  }
}

export class Vault {
  constructor(file, key, data) {
    this.file = file
    this.key = key
    this.data = data
  }

  static async open({ dir = dataDir(), passphrase = null, keyDir = null } = {}) {
    const file = path.join(dir, 'vault.json')
    const existing = await readJson(file, null)
    const data = existing ?? {
      v: 1,
      kdf: { ...KDF, salt: randomBytes(16).toString('base64'), source: passphrase ? 'passphrase' : 'machine' },
      items: {},
    }
    if (passphrase && data.kdf.source !== 'passphrase') data.kdf.source = 'passphrase'
    // the machine key belongs to the install, not to one workspace, so every
    // workspace's vault unlocks with it while the keys inside stay separate
    const secret = data.kdf.source === 'passphrase' ? passphrase : await machineSecret(keyDir ?? dir)
    if (!secret) throw new Error('This vault is protected by a passphrase. Unlock it before running workflows.')
    const key = deriveKey(secret, data.kdf.salt)
    const vault = new Vault(file, key, data)
    if (!existing) await vault.save()
    // fail fast on a wrong passphrase rather than at the first workflow run
    for (const name of Object.keys(data.items)) vault.read(name)
    return vault
  }

  async save() {
    await writeJson(this.file, this.data)
  }

  names() {
    return Object.keys(this.data.items).sort()
  }

  // Names and field names only. Values never leave the vault except through
  // get(), which the engine calls to build $creds.
  summary() {
    return this.names().map((name) => {
      const { type, values, points } = this.read(name)
      // "points" is where this key actually goes, in words: a channel, a bot,
      // a workspace. Never a secret, so it can be shown next to the name.
      return { name, type, points: points ?? '', fields: Object.keys(values).sort() }
    })
  }

  // A stored record is { type, values }. Vaults written before credential types
  // existed hold the bare values object, so those read back as generic.
  read(name) {
    const record = this.data.items[name]
    if (!record) throw new Error(`There is no saved key set called "${name}".`)
    let plain
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(record.iv, 'base64'))
      decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
      const bytes = Buffer.concat([decipher.update(Buffer.from(record.ct, 'base64')), decipher.final()])
      plain = JSON.parse(bytes.toString('utf8'))
    } catch {
      throw new Error(`"${name}" could not be decrypted. The passphrase is wrong, or the vault file was changed.`)
    }
    if (plain && typeof plain.type === 'string' && plain.values && typeof plain.values === 'object') return plain
    return { type: 'generic', values: plain ?? {} }
  }

  get(name) {
    return this.read(name).values
  }

  async set(name, { type = 'generic', values, points = '' }) {
    if (!name || !/^[a-z0-9_.-]+$/i.test(name)) {
      const bad = new Error('A key set name can contain letters, numbers, dots, dashes and underscores.')
      bad.badRequest = true
      throw bad
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('A key set is a set of named fields.')
    }
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ct = Buffer.concat([cipher.update(JSON.stringify({ type, values, points }), 'utf8'), cipher.final()])
    this.data.items[name] = {
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ct: ct.toString('base64'),
    }
    await this.save()
  }

  async remove(name) {
    delete this.data.items[name]
    await this.save()
  }

  // What the engine hands nodes as $creds.
  all() {
    const out = {}
    for (const name of this.names()) out[name] = this.get(name)
    return out
  }

  secrets() {
    const found = new Set()
    const walk = (value) => {
      if (typeof value === 'string') {
        if (value.length > 4) found.add(value)
      } else if (value && typeof value === 'object') {
        for (const v of Object.values(value)) walk(v)
      }
    }
    for (const name of this.names()) walk(this.get(name))
    return [...found]
  }
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A backstop, not a licence. Nodes are still expected to keep secrets out of
// their logs; this catches the ones that slip through, before anything is
// written to disk or sent to the browser.
export function makeScrubber(secrets) {
  const sorted = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)
  if (!sorted.length) return (value) => value
  const pattern = new RegExp(sorted.map(escape).join('|'), 'g')

  const scrub = (value) => {
    if (typeof value === 'string') return value.replace(pattern, '••••')
    if (Array.isArray(value)) return value.map(scrub)
    if (value && typeof value === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[k] = scrub(v)
      return out
    }
    return value
  }
  return scrub
}
