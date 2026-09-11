// The other side of the fence. This process is started with Node's permission
// model on, which means no file access, no spawning anything, no add-ons. It is
// handed the items and the code on stdin and answers on stdout. It never sees
// the vault, the environment, or the rest of the machine.
//
// The parent starts it with an empty environment, but an empty environment is
// not what arrives: windows hands a child a dozen of its own variables whatever
// you pass, and macos writes the unix user id into __CF_USER_TEXT_ENCODING
// after the parent's env is applied, so it cannot be suppressed from out there.
// Emptying it here is the only place that works, and it happens before a line
// of anybody's code runs.
for (const name of Object.keys(process.env)) delete process.env[name]

let input = ''
process.stdin.setEncoding('utf8')
for await (const chunk of process.stdin) input += chunk

const { code, items, creds } = JSON.parse(input)
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

const logs = []
const log = (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))

try {
  const fn = new AsyncFunction('items', '$creds', 'log', `"use strict";\n${code ?? ''}`)
  const result = await fn(items, creds ?? {}, log)
  process.stdout.write(JSON.stringify({ ok: true, result: result ?? null, logs }))
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, error: err?.message ?? String(err), logs }))
}
