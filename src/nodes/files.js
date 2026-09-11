import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { dataDir } from '../storage/files.js'

// Files live in one folder under the zorilla directory. A step cannot write
// anywhere else on the machine: a shared automation that could choose its own
// path could overwrite anything its author fancied.
function inFolder(name) {
  const clean = path.basename(String(name ?? '').trim())
  if (!clean || clean === '.' || clean === '..') throw new Error('That is not a file name.')
  return path.join(dataDir(), 'files', clean)
}

const save = {
  type: 'file.save',
  label: 'Save a file',
  category: 'output',
  description: 'Writes a file the run is carrying into your zorilla files folder.',
  outputs: ['main'],
  params: [
    { key: 'which', label: 'Which file', type: 'text', default: 'file',
      description: 'The name it travels under. Downloads arrive as "file".' },
    { key: 'name', label: 'Save it as', type: 'text', default: '',
      placeholder: 'report.csv', description: 'Leave blank to keep its own name.' },
  ],
  async run({ params, item, log }) {
    const carried = item.binary?.[params.which || 'file']
    if (!carried) {
      const names = Object.keys(item.binary ?? {})
      throw new Error(names.length
        ? `This item has no file called "${params.which}". It has: ${names.join(', ')}.`
        : 'This item is not carrying a file. Put a step that downloads one before this.')
    }
    const target = inFolder(params.name || carried.filename || 'download')
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(carried.data, 'base64'))
    log(`Saved ${path.basename(target)}, ${carried.size ?? 'unknown'} bytes.`)
    return [{ ...item, json: { ...item.json, savedAs: target } }]
  },
}

const read = {
  type: 'file.read',
  label: 'Read a file',
  category: 'transform',
  description: 'Picks up a file from your zorilla files folder so a later step can send it.',
  outputs: ['main'],
  params: [
    { key: 'name', label: 'File name', type: 'text', default: '', placeholder: 'report.csv',
      description: 'A file in your zorilla files folder. Nowhere else on the machine.' },
    { key: 'as', label: 'Carry it as', type: 'text', default: 'file',
      description: 'The name it travels under, so a later step can say which file it means.' },
    { key: 'asText', label: 'Also read it as text', type: 'boolean', default: false,
      description: 'Puts the contents in the item as well, for a csv you want to read rather than send.' },
  ],
  async run({ params, item, log }) {
    const target = inFolder(params.name)
    let bytes
    try {
      bytes = await readFile(target)
    } catch {
      throw new Error(`There is no file called "${path.basename(target)}" in your zorilla files folder.`)
    }
    const name = params.as || 'file'
    log(`Read ${path.basename(target)}, ${bytes.length} bytes.`)
    return [{
      json: params.asText ? { ...item.json, text: bytes.toString('utf8') } : item.json,
      binary: {
        ...(item.binary ?? {}),
        [name]: {
          filename: path.basename(target),
          mime: 'application/octet-stream',
          size: bytes.length,
          data: bytes.toString('base64'),
        },
      },
    }]
  },
}

const fromText = {
  type: 'file.fromText',
  label: 'Make a file',
  category: 'transform',
  description: 'Turns text into a file, so a spreadsheet or report can be attached to an email.',
  outputs: ['main'],
  params: [
    { key: 'text', label: 'Contents', type: 'textarea', default: '', placeholder: 'name,amount\nada,42',
      description: 'Expressions work, so a step before this can build the rows.' },
    { key: 'name', label: 'File name', type: 'text', default: 'report.csv',
      description: 'Ending in .csv makes it a spreadsheet when it lands in somebody\'s email.' },
    { key: 'as', label: 'Carry it as', type: 'text', default: 'file' },
  ],
  run({ params, item }) {
    const body = Buffer.from(String(params.text ?? ''), 'utf8')
    const name = params.as || 'file'
    return [{
      json: item.json,
      binary: {
        ...(item.binary ?? {}),
        [name]: {
          filename: params.name || 'file.txt',
          mime: params.name?.endsWith('.csv') ? 'text/csv' : 'text/plain',
          size: body.length,
          data: body.toString('base64'),
        },
      },
    }]
  },
}

export default [save, read, fromText]
