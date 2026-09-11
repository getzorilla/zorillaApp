# automations

One file per automation, as plain JSON. The same shape the editor saves and the
same shape a shared package carries. Read one before you run it. The steps say
exactly what it contacts.

Nothing here is installed for you. The workspace offers them, and pressing add
copies one in, so editing it afterwards changes your copy, not the repo. They
are also listed on the marketplace, with a picture of the steps.

All of them arrive switched off. Nothing here can move funds. The only chain
steps are reads, plus `prepare a transaction`, which signs and sends nothing.

| file | needs |
| --- | --- |
| `contract-event-to-telegram.json` | `claude_key`, `telegram_key` |
| `news-to-x.json` | `claude_key`, `x_key` |
| `payment-to-slack-and-notion.json` | `notion_key`, `slack_key`, `stripe_key` |
| `prepare-transaction.json` | nothing |
| `sol-price-moves-to-discord.json` | `discord_key` |
| `telegram-post-to-group.json` | `telegram_key`, `x_key` |
| `usdc-landing-to-telegram.json` | `telegram_key` |
| `wallet-balance-watch.json` | nothing |
| `web3-digest-email.json` | `resend_key` |
| `webhook-to-slack.json` | `slack_key` |
