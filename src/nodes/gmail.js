import nodemailer from 'nodemailer'

// Gmail is the one service here that is not an API key. Its real interface is
// OAuth2 — a Google Cloud project, a consent screen, refresh tokens — which is
// its own piece of work and cannot be reduced to pasting a key. An app password
// over SMTP is the part that works today, and it only sends.
export default {
  type: 'gmail.send',
  label: 'Send email',
  category: 'action',
  description: 'From your Gmail, with an app password. Check Spam and All Mail for the first one.',
  outputs: ['main'],
  params: [
    { key: 'credential', label: 'Gmail key', type: 'credential', credentialType: 'gmail', default: '' },
    { key: 'to', label: 'To', type: 'text', default: '', placeholder: 'someone@example.com' },
    { key: 'subject', label: 'Subject', type: 'text', default: '' },
    { key: 'html', label: 'Message', type: 'textarea', default: '' },
  ],
  async run({ params, creds, log }) {
    if (!params.credential) throw new Error('Pick a Gmail key first, or add one under Keys.')
    const { user, appPassword } = creds[params.credential] ?? {}
    if (!user || !appPassword) throw new Error('That Gmail key is missing the address or the app password.')

    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user, pass: String(appPassword).replace(/\s+/g, '') },
    })

    try {
      const sent = await transport.sendMail({
        from: user,
        to: String(params.to ?? ''),
        subject: String(params.subject ?? ''),
        html: String(params.html ?? ''),
      })
      log(`Sent to ${params.to}`)
      return [{ json: { messageId: sent.messageId, to: params.to, accepted: sent.accepted } }]
    } catch (err) {
      if (/Invalid login|Username and Password not accepted/i.test(err.message)) {
        throw new Error('Google rejected that address and app password. App passwords only exist once 2-step verification is on.')
      }
      throw new Error(`Gmail refused the message: ${err.message}`)
    } finally {
      transport.close()
    }
  },
}
