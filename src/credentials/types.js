// A credential type describes what a service needs and how a request proves it.
// The point is that nobody types an Authorization header by hand, and nobody
// guesses what goes in a field. A type with fields: null takes freeform pairs.
//
// Values are referenced from auth and test templates as {{ fieldKey }}. That is
// a different, much smaller substitution than workflow expressions: it only
// ever sees this credential's own fields.

const generic = {
  type: 'generic',
  label: 'Anything else',
  description: 'Named fields you fill in yourself. Read them in a step with {{ $creds.name.field }}.',
  fields: null,
}

const bearer = {
  type: 'bearer',
  label: 'Bearer token',
  description: 'Sends Authorization: Bearer <token>. Works for most modern APIs.',
  fields: [{ key: 'token', label: 'Token', secret: true, required: true, placeholder: 'sk_live_…' }],
  auth: { headers: { Authorization: 'Bearer {{ token }}' } },
}

const apiHeader = {
  type: 'apiHeader',
  label: 'API key in a header',
  description: 'Sends the key under a header name of your choosing.',
  fields: [
    { key: 'name', label: 'Header name', default: 'X-API-Key', required: true },
    { key: 'value', label: 'Key', secret: true, required: true },
  ],
  auth: { headers: { '{{ name }}': '{{ value }}' } },
}



const github = {
  type: 'github',
  label: 'GitHub',
  description: 'Personal access token.',
  docs: 'https://github.com/settings/tokens',
  fields: [{ key: 'token', label: 'Token', secret: true, required: true, placeholder: 'ghp_…' }],
  auth: { headers: { Authorization: 'Bearer {{ token }}', 'user-agent': 'zorilla' } },
  test: { method: 'GET', url: 'https://api.github.com/user' },
}

const evmRpc = {
  type: 'evmRpc',
  label: 'Ethereum RPC',
  description: 'Your own node URL from Alchemy, Infura or similar. Steps fall back to free public endpoints without one, which rate limit under load.',
  docs: 'https://dashboard.alchemy.com',
  fields: [
    { key: 'url', label: 'RPC URL', secret: true, required: true, placeholder: 'https://eth-mainnet.g.alchemy.com/v2/…' },
  ],
}


const gmail = {
  type: 'gmail',
  label: 'Gmail',
  description: 'Gmail has no API key. Turn on 2-step verification, then make an app password at myaccount.google.com/apppasswords and paste it here.',
  docs: 'https://myaccount.google.com/apppasswords',
  fields: [
    { key: 'user', label: 'Your Gmail address', required: true, placeholder: 'you@gmail.com' },
    { key: 'appPassword', label: 'App password', secret: true, required: true, placeholder: 'sixteen letters, no spaces' },
  ],
  auth: {},
}

export default [generic, bearer, apiHeader, github, evmRpc, gmail]
