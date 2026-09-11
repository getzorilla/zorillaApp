# Signing

## The rule

Nodes never see key material. Not from disk, not from an environment variable,
not from a node parameter, not for testing. A node builds an intent and hands
it to a signer; the signer returns a signature.

```js
{ chain: 'ethereum', chainId: 1, to: '0x…', value: '10000000000000000',
  function: 'transfer', reason: 'Send 1 USDC to the treasury' }
```

## The chosen model: hardware wallet, signed in the browser

The private key lives on a Ledger and never exists on the machine. The editor
page talks to the device over WebHID; the server builds and simulates the
transaction but never handles a key or a signature request. So the two open
weaknesses below cannot cost anyone a wallet: a hostile step cannot steal a key
that is not there. It can only ask for a signature, and a person sees the
decoded effect before approving on the device.

The cost of this choice: **a send cannot happen on a schedule or a webhook.** A
human has to press a physical button. Unattended sending needs the section after
next, and stays off until then.

## Built

`Prepare transaction` resolves the addresses, simulates the call against a
current chain state, refuses anything that would revert, and reports the gas
estimate and the ETH that would leave. It sets `signed: false, sent: false` and
sends nothing. Everything up to the signature already works.

## Next

1. Signer transport in the page: WebHID to a Ledger, `eth_signTransaction` over
   the standard app.
2. An approval screen that decodes the intent into plain language — what leaves
   the wallet, what arrives, what it costs — before the device is asked.
3. A `Send transaction` node that consumes a prepared intent, requests the
   signature from the page, broadcasts, and waits for the receipt.

## Still open, and what they block

**Every step sees every saved key.** A workflow with five steps gives all five
access to every credential in the vault, including the ones with no business
touching them. `authFor()` in the server is the choke point where scoping will
be enforced; today it does not enforce.

**The Run JavaScript step is not isolated.** It runs in the server process with
full access to the machine. Node's `vm` module would not fix this: it scopes
names, it is not a security boundary. The options are a separate process with
restricted syscalls, or an embedded interpreter such as QuickJS.

Both are survivable while signing requires a person and a device. Both must be
done before either of the following:

- **Software keys of any kind**, including an OS keychain. The moment a key can
  be used without a person present, an unsandboxed step next to it is a wallet
  drainer.
- **Bounded session keys** (ERC-4337 / ERC-7710), scoped at creation to specific
  contracts, selectors, spend caps and expiry, with the scope derived from the
  graph and shown at install. This is the only design that allows unattended
  sending, because the limit is enforced by the account rather than by trusting
  zorilla.

## Not defended yet

- A community node file under `~/.zorilla/nodes/` is unrestricted Node code.
  Installing one is equivalent to running `npm install` on a package nobody read.
- The server has no authentication. It binds to `127.0.0.1` and that is the
  whole of its access control.
- The vault's machine key protects the vault file against being read on its own.
  It does not protect against code running as the same user.
