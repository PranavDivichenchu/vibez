# Vibez MCP server

Lets Claude, or any agent that speaks MCP, read and edit a Vibez app in Vibez's
own terms: pages as outlines, changes as the same moves a person makes in the
editor, links to `.vi` files as `dashboard.vi#orders`.

Every change is checked the way the editor checks it. An agent cannot add a
property an element does not have, put a list in a heading, or wire a button to
an action nothing offers; each refusal lists what would fit. A batch of edits
lands whole or not at all. The Vibez editor watches the files, so an agent's
change appears on the canvas as it is written and is one ⌘Z away.

## Tools

| Tool | What it does |
|---|---|
| `vibez_overview` | every page, every `.vi` file and what it offers, every recorded flow |
| `vibez_reference` | the vocabulary: elements, properties, tokens, themes, link syntax, operations |
| `ui_read` | a page as an outline, one element per line with its id and links (with sample values) |
| `ui_create` | a new page from a template (blank, landing, signup, gallery, dashboard) |
| `ui_edit` | a batch of add / set / move / remove / duplicate / wrap / page operations |
| `ui_options` | what one element can show, repeat over, or run |
| `ui_build` | compile a page to `.vibez/build/<page>.html`, report broken links |
| `vi_read` | the values and actions a `.vi` file exports |
| `vi_declare` | add, replace or remove exports (only the exports block is touched) |
| `flow_read` | what actually ran: steps, timings, the critical path, problems noticed |

The same vocabulary is available as the resource `vibez://reference`.

## Using it

It runs from source on Node 22.18 or newer, with no build step.

In this repo, Claude Code picks it up from `.mcp.json` (pointed at the demo
app in `examples/shop`). For any other project:

```bash
claude mcp add vibez -- node /path/to/vibez/packages/mcp/src/server.ts --root /path/to/project
```

Any other MCP client: run `node packages/mcp/src/server.ts --root <project>`
over stdio. Without `--root` it uses `VIBEZ_ROOT`, then the working directory.
It never reads or writes outside the root.

## How a page reads

```
page · stack "Page" · gap lg · fill page
├─ header · row "Header" · align center · justify between · stacks on phone
│  └─ org-name · text heading "Company" · shows dashboard.vi#orgName → "Northwind"
├─ orders-list · stack "Customer list" · repeats for each of dashboard.vi#orders (4 samples)
│  └─ order-customer · text body "Customer" · shows item.customer
└─ invite-send · button primary "Send invite" · on click dashboard.vi#inviteTeammate(email ← input.email)
```

## How an edit is written

```json
[
  { "op": "add", "element": "card", "as": "invite" },
  { "op": "add", "element": "input", "parent": "$invite", "props": { "field": "email", "label": "Email" } },
  { "op": "add", "element": "button", "parent": "$invite", "props": { "label": "Invite", "onClick": "dashboard.vi#inviteTeammate" } }
]
```

The button's `email` input fills itself from the input saved as `email`.

## Scope

`.vi` files are the graph editor's. This server reads and writes only their
`exports` block, per [docs/ui-vi-contract.md](../../docs/ui-vi-contract.md).
When the graph format settles, graph reading and editing tools belong here too.
