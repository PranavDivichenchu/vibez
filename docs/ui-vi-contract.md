# How `.ui` pages and `.vi` files talk

A `.ui` file is one page, laid out visually. A `.vi` file is logic, edited as a
graph. A page never contains logic and a graph never contains layout; they meet
at a small, explicit boundary described here. Both editors build against this
document, so either side can change freely behind it.

## 1. What a `.vi` file offers

The UI editor reads exactly one thing from a `.vi` file: a top-level `exports`
object. Everything else in the file belongs to the graph editor.

```json
{
  "exports": {
    "values": [
      { "name": "orders", "type": "List",
        "fields": { "customer": "String", "total": "Number", "logo": "Url" },
        "sample": [{ "customer": "Lantern Bay", "total": 12043, "logo": "https://…" }] },
      { "name": "plan", "type": "Object", "fields": { "tier": "String" }, "sample": { "tier": "Pro" } },
      { "name": "orgName", "type": "String", "sample": "Northwind" }
    ],
    "actions": [
      { "name": "inviteTeammate", "inputs": [{ "name": "email", "type": "String" }], "returns": "Object" }
    ]
  }
}
```

- **values** are things a page can show. `type` is one of `String`, `Number`,
  `Boolean`, `Url`, `Date`, `Object`, `List`. `fields` describes one item of a
  `List`, or the parts of an `Object`.
- **actions** are things a page can run, with named inputs.
- **sample** is what the page shows while it is being built and before
  anything is serving the real value. Give every value one; it is what makes a
  linked page look real on the canvas.
- `about` (optional, on either) is one short line for the link picker.

Names are the contract. Renaming an export breaks pages that use it, and the UI
editor lists those links as broken rather than silently dropping them.

## 2. What a page stores

A page stores references, never data:

| On the page | Stored as |
|---|---|
| Text showing a value | `"bind": { "from": "vi", "file": "dashboard.vi", "name": "plan", "field": "tier" }` |
| A frame repeated per item | `"repeat": { "from": "vi", "file": "dashboard.vi", "name": "orders" }` |
| Text inside that frame | `"bind": { "from": "item", "field": "customer" }` |
| A button that runs something | `"on": { "run": "vi", "file": "dashboard.vi", "name": "inviteTeammate", "args": { "email": { "from": "input", "name": "email" } } }` |
| A link to another page | `"to": "gallery.ui"` or `"on": { "run": "navigate", "to": "gallery.ui" }` |

`file` is relative to the `.ui` file. A page lists the `.vi` files it uses in
its own `links` array.

The editor only offers links whose types fit: text is offered words and
numbers, a repeating frame and a gallery are offered lists, a button is offered
actions. An action's inputs are filled automatically from inputs on the page
with the same name, so a button running `inviteTeammate(email)` sends what was
typed into the input saved as `email`.

## 3. At runtime

A compiled page is one HTML file. It reaches `.vi` exports over HTTP, one
address per export, on the same origin by default:

```
GET  /vibez/<file>/<value>     -> the value, as JSON
POST /vibez/<file>/<action>    body: the inputs, as JSON  -> the result, as JSON
```

`<file>` is the path as the page wrote it, URL-encoded. After an action
succeeds the page fetches its values again, so a list updates after "add".

Until something answers at those addresses, the page shows each value's
`sample`, and an action shows a short note saying what would have run and with
what. Serving these addresses is the `.vi` side's job: its compiler or dev
server.

## 4. Who owns what

| | `.ui` side | `.vi` side |
|---|---|---|
| The `exports` block format | reads it | writes it |
| Everything else in `.vi` | never reads it | owns it |
| Layout, style, which element shows which value | owns it | never reads it |
| Serving `/vibez/<file>/<export>` | calls it | serves it |

Changes to anything in the left column of §1 or §3 go through this document.
