// Writes one small svg per service into public/logos. The glyphs come from
// simple-icons (CC0); the few services that asked to be removed from that set
// get a monogram in their own colour instead, drawn to the same size so a row
// of them lines up.
//
// Most marks come from the current simple-icons. Three were removed from that
// set after their owners asked, so those come from the last release that had
// them, which is still CC0. Two are not in any icon set, so they are fetched
// from the brand assets the companies publish themselves.
//
//   npm i --no-save simple-icons simple-icons-14@npm:simple-icons@14
//   node scripts/build-logos.mjs
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(here, '../public/logos')
await mkdir(out, { recursive: true })

const si = (await import('simple-icons')).default ?? (await import('simple-icons'))
const older = await import('simple-icons-14').then((m) => m.default ?? m).catch(() => ({}))
const from = (name) => si[name] ?? older[name] ?? null

// published by the companies themselves; no icon set carries them
const FETCHED = {
  coingecko: 'https://www.coingecko.com/favicon-96x96.png',
  etherscan: 'https://etherscan.io/images/brandassets/etherscan-logo-circle.png',
}

// service id in zorilla -> simple-icons key, or a monogram
const SERVICES = {
  resend: { icon: 'siResend', hex: '1F1F1F' },
  gmail: { icon: 'siGmail' },
  discord: { icon: 'siDiscord' },
  telegram: { icon: 'siTelegram' },
  anthropic: { icon: 'siClaude' },
  gemini: { icon: 'siGooglegemini' },
  deepseek: { icon: 'siDeepseek' },
  supabase: { icon: 'siSupabase' },
  notion: { icon: 'siNotion', hex: '1F1F1F' },
  airtable: { icon: 'siAirtable' },
  stripe: { icon: 'siStripe' },
  x: { icon: 'siX', hex: '1A1A1A' },
  // pulled from the last release of simple-icons that carried them
  slack: { icon: 'siSlack' },
  twilio: { icon: 'siTwilio' },
  openai: { icon: 'siOpenai', hex: '1F1F1F' },
  // fetched from the companies' own brand assets
  etherscan: { fetched: true, hex: 'FFFFFF' },
  coingecko: { fetched: true, hex: 'FFFFFF' },
  // categories that are not a company
  web3: { letter: 'Ξ', hex: '3C3C3D' },
}

const light = (hex) => {
  const n = parseInt(hex, 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62
}

const tile = (hex, inner) => {
  const fg = light(hex) ? '#101014' : '#ffffff'
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
    `<rect width="24" height="24" rx="5.5" fill="#${hex}"/>` +
    inner(fg) +
    `</svg>\n`
}

let written = 0
for (const [id, spec] of Object.entries(SERVICES)) {
  let svg
  if (spec.fetched) {
    const url = FETCHED[id]
    const response = await fetch(url)
    if (!response.ok) { console.warn(`${id}: ${url} answered ${response.status}, skipped`); continue }
    const data = Buffer.from(await response.arrayBuffer()).toString('base64')
    // the artwork already carries its own colour, so it sits on a plain tile
    svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">` +
      `<rect width="24" height="24" rx="5.5" fill="#${spec.hex}"/>` +
      `<image href="data:image/png;base64,${data}" x="2" y="2" width="20" height="20"/>` +
      `</svg>\n`
  } else if (spec.icon) {
    const icon = from(spec.icon)
    if (!icon) { console.warn(`${spec.icon} is in no version of simple-icons; ${id} skipped`); continue }
    const hex = spec.hex ?? icon.hex
    svg = tile(hex, (fg) => `<g transform="translate(4.8 4.8) scale(0.6)"><path fill="${fg}" d="${icon.path}"/></g>`)
  } else {
    svg = tile(spec.hex, (fg) =>
      `<text x="12" y="12" fill="${fg}" font-family="ui-sans-serif,-apple-system,system-ui,sans-serif"` +
      ` font-size="13" font-weight="600" text-anchor="middle" dominant-baseline="central">${spec.letter}</text>`)
  }
  await writeFile(path.join(out, `${id}.svg`), svg)
  written += 1
}
console.log(`logos: ${written} files in public/logos`)
