Write a zorilla integration for **[THE SERVICE]**.

zorilla is a local automation tool. An integration is a single JSON file
describing a service: the fields its key needs, how a request authenticates,
and what each of its steps sends. It contains no code, and zorilla refuses any
file that breaks the rules below.

Reply with the JSON and nothing else.

## The shape

```json
{
  "id": "short_lowercase_id",
  "label": "The Service",
  "description": "One line, lowercase, saying what it is.",
  "docs": "https://the-service.com/docs/api-keys",
  "category": "action",
  "credential": {
    "description": "Where somebody finds this key, in one sentence.",
    "fields": [
      { "key": "apiKey", "label": "API key", "secret": true, "required": true, "placeholder": "sk_…" }
    ],
    "auth": { "headers": { "Authorization": "Bearer {{ apiKey }}" } },
    "test": { "method": "GET", "url": "https://api.the-service.com/v1/me" },
    "identity": { "as": "user.name" }
  },
  "actions": [
    {
      "key": "send",
      "label": "Send a message",
      "description": "One line saying what one run of this does.",
      "params": [
        { "key": "to", "label": "To", "type": "text", "placeholder": "someone@example.com" },
        { "key": "body", "label": "Message", "type": "textarea" }
      ],
      "request": {
        "method": "POST",
        "url": "https://api.the-service.com/v1/messages",
        "json": { "to": "{{ to }}", "body": "{{ body }}" }
      },
      "errorPath": "error.message"
    }
  ]
}
```

## Rules zorilla enforces

- Two substitutions exist and no others. `{{ fieldKey }}` is a value from the
  step. `{{ key.fieldName }}` is a field of the saved key. Neither can reach
  anything else.
- Only the **host** has to be literal. Everything after the first slash may be
  filled in at run time, which is how most REST APIs are reached:
  - `https://api.github.com/repos/{{ owner }}/{{ repo }}/issues` — accepted.
  - `https://{{ region }}.api.example.com/v1/send` — refused: nobody could tell
    what it contacts before installing it.
  - `"url": "{{ key.webhookUrl }}"` — accepted: a whole address the person
    filled in themselves.
- A key travelling in the query string is allowed but called out on screen.
  Prefer a header.
- Blank fields are dropped before the request goes out, so an optional
  parameter left empty is simply absent rather than sent as `""`. Set
  `"stripEmpty": false` on an action if the service needs the empty value.
- `id` is lower case letters, numbers and underscores. Every action `key` is
  unique within the file.
- Field types: text, textarea, number, boolean, select, code, keyvalue, list,
  datetime. A select needs `options: [{ "value": "a", "label": "A" }]`.

## A GET, with the key in the query string

Most services are read with a GET and inputs in the query string rather than a
JSON body. `query` and `headers` sit beside `url` in a request, and a credential
authenticates with `query` exactly as it would with `headers`:

```json
{
  "credential": {
    "fields": [{ "key": "apiKey", "label": "API key", "secret": true }],
    "auth": { "query": { "appid": "{{ apiKey }}" } },
    "test": { "method": "GET", "url": "https://api.example.com/v1/ping" }
  },
  "actions": [
    {
      "key": "lookup",
      "label": "Look something up",
      "params": [{ "key": "city", "label": "City", "type": "text" }],
      "request": {
        "method": "GET",
        "url": "https://api.example.com/v1/weather",
        "query": { "q": "{{ city }}", "units": "metric" },
        "headers": { "Accept": "application/json", "User-Agent": "zorilla" }
      }
    }
  ]
}
```

A request carries at most one body: `json`, `form`, `text` or `jsonFrom`. A GET
usually carries none.

Headers an action sets and headers the credential's `auth` sets are merged, and
the credential wins if both name the same one. Put what every call needs
(`Accept`, a version header) on the credential, and put what one action needs on
that action.

## Optional pieces, when the service calls for them

- `"itemsPath": "data"` — where the list is in the answer, so one call becomes
  one item per row. `"$"` means the answer is itself the list.
- `"output": { "id": "data.id", "text": "data.text" }` — reshape what a step
  hands on. `"$"` as a value means the whole answer.
- `"errorPath": "error.message"` and `"okPath": "ok"` — where the service puts
  the reason it refused, and where it puts `false` while still answering 200.
- `"fallbacks": { "from": "{{ key.from }}" }` — sits on the action, beside
  `request`. A field the person left blank falls back to something saved with
  the key.
- `"pagination"` — keep asking until the step has what it was told to bring
  back:
  ```json
  "pagination": {
    "size": 100,
    "sizeInto": { "query": "limit" },
    "next": { "lastItem": "id" },
    "more": "has_more",
    "into": { "query": "starting_after" }
  }
  ```
  `next` is one of `{ "cursor": "path.in.answer" }`, `{ "lastItem": "id" }`,
  `{ "count": true }` for an offset, or `{ "page": true }` for page numbers.
- `"trigger": { "dedupeBy": "id" }` — turns an action into a step that waits.
  zorilla asks on a timer and passes on only what it has not seen. Needs
  `itemsPath`. Name these actions like "New Stripe payment".
- `"attachments": { "into": "attachments", "filenameKey": "filename", "contentKey": "content" }`
  — sends whatever files the item is carrying, base64.
- `"icon": "data:image/png;base64,…"` — a small picture for the file, png,
  jpeg or webp only.

## Write it like this

- Everything lowercase except proper nouns and the service's own field names.
- Labels are what a person would call the thing, not what the API calls it:
  "Message", not "body_text".
- Descriptions are one line. Say what it does, not what it is.
- Add a `test` request that costs nothing, so a wrong paste is caught at once.
  Point `identity` at whatever that answer says about who the key belongs to,
  so zorilla can show "as @yourbot" next to the saved key. Leave `identity` out
  if the service has no endpoint that says who you are.
- Two or three actions is plenty. The ones people will actually use.

If anything above is unclear, read https://zorilla.io/docs. The step catalogue
at https://zorilla.io/docs?for=agents is generated from the running app and
lists every step with its real fields, which is the place to check what an
integration's actions turn into once installed.
