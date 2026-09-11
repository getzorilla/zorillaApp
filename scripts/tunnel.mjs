// Gives the webhook trigger an address the internet can reach, without opening
// this machine up: cloudflared connects outward and forwards to 127.0.0.1.
//
//   npm run tunnel
//
// It prints the address to put in ZORILLA_PUBLIC_URL, then keep it running
// alongside the app.
import { spawn } from 'node:child_process'

const port = Number(process.env.ZORILLA_PORT) || 5177

const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] })

child.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error('cloudflared is not installed. On a Mac: brew install cloudflared')
    console.error('Or use any other tunnel that forwards to http://127.0.0.1:' + port)
    process.exit(1)
  }
  throw err
})

let announced = false
const watch = (chunk) => {
  const text = String(chunk)
  process.stderr.write(text)
  const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)
  if (found && !announced) {
    announced = true
    console.log('')
    console.log(`  Your address:  ${found[0]}`)
    console.log('')
    console.log('  Start zorilla with it so the editor shows the right address:')
    console.log(`    ZORILLA_PUBLIC_URL=${found[0]} npm start`)
    console.log('')
    console.log('  Put a secret on every webhook step. Anyone who guesses the address can reach it.')
    console.log('')
  }
}
child.stdout.on('data', watch)
child.stderr.on('data', watch)
