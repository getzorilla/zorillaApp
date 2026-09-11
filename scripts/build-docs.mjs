// Writes DOCS.md: everything an agent needs to write a working automation,
// generated from the registries the app itself loads, so it cannot describe a
// function that does not exist.
//
//   npm run docs
//
// The website serves this file at /zorilla.md rather than generating its own
// copy, so the app stays the one place any of this is decided.
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadNodes, describe } from '../src/engine/registry.js'
import { loadCredentialTypes, describeType } from '../src/credentials/registry.js'
import { loadIntegrations, nodesFor, credentialTypeFor, describeIntegration } from '../src/integrations/registry.js'
import { renderDocs } from '../src/docs/render.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

const code = await loadNodes({ builtinDir: path.join(root, 'src/nodes') })
const rawTypes = await loadCredentialTypes({})
const { integrations } = await loadIntegrations({ builtinDir: path.join(root, 'src/integrations/builtin') })

const nodeMap = new Map(code.nodes)
const typeMap = new Map(rawTypes)
for (const spec of integrations.values()) {
  const type = credentialTypeFor(spec)
  if (type) typeMap.set(type.type, type)
  for (const def of nodesFor(spec)) nodeMap.set(def.type, def)
}

const nodes = [...nodeMap.values()].map(describe)
const credentialTypes = [...typeMap.values()].map(describeType)
const specs = [...integrations.values()].map(describeIntegration)

const text = await renderDocs({
  nodes,
  credentialTypes,
  specs,
  examplesDir: path.join(root, 'automations'),
})
await writeFile(path.join(root, 'DOCS.md'), text)
console.log(`DOCS.md: ${text.length} characters, ${nodes.length} steps, ${specs.length} integrations`)
