# Vibez MCP server

Lets Claude, or any agent that speaks MCP, read and edit a Vibez app in Vibez's
own terms: `.ui` pages as outlines, `.vi` logic as graphs of blocks, plain HTML
sites as elements with addresses, and every change as the same move a person
makes in the matching editor.

Every change is checked the way the editor checks it. An agent cannot add a
property an element does not have, put a list in a heading, or wire a button to
an action nothing offers; each refusal lists what would fit. A batch of edits
lands whole or not at all. The Vibez editor watches the files, so an agent's
change appears on the canvas as it is written and is one ⌘Z away.

## Tools

| Tool | What it does |
|---|---|
| `vibez_overview` | every page, every `.vi` file (what it offers, whether it is ready), every HTML page, every recorded flow |
| `vibez_reference` | the vocabulary: elements, properties, tokens, themes, link syntax, logic blocks, site edits |
| **Pages (.ui)** | |
| `ui_read` | a page as an outline, one element per line with its id and links (with sample values) |
| `ui_create` | a new page from a template (blank, landing, signup, gallery, dashboard) |
| `ui_edit` | a batch of add / set / move / remove / duplicate / wrap / page operations |
| `ui_options` | what one element can show, repeat over, or run |
| `ui_build` | compile a page to `.vibez/build/<page>.html`, report broken links |
| **Logic (.vi)** | |
| `vi_read` | every value, action, function and variable and whether each is ready; or one graph block by block with ports, wiring and problems |
| `vi_blocks` | the blocks a graph can use (the logic editor's own search), with their ports |
| `vi_edit` | declare / rename / remove items; add, set, connect, disconnect and delete blocks; all or nothing |
| `vi_declare` | shortcut for declaring page values and actions, each with a starting Start → Return graph |
| `vi_run` | compile and run one value, action or function in a fresh process, with logs and a 10-second timeout |
| **Sites (plain HTML)** | |
| `site_map` | every HTML page, its address, and every link on it, including the ones that go nowhere |
| `site_read` | one page as its visible elements, each addressed by `@offset` |
| `site_edit` | change an element's words, style or one attribute; remove, move, or add a library element |
| `site_add_page` | a new page from a template, with the site's own header and footer, linked from the navigation |
| `site_delete_page` | delete a page and its navigation links; a copy is kept in `.vibez/trash` |
| `site_library` | the elements and page templates to choose from |
| **Team** (when the project has a `vibez.team.json`) | |
| `team_status` | everyone on the team, each person's agents with their task, the files they hold, and whether they are active; recent activity |
| `team_start` | say what this agent is doing and claim its files; hear who else is on them or nearby, the team's notes, and unread messages |
| `team_check` | would these files or this task run into someone's work, without claiming anything |
| `team_claim` / `team_release` | hold more files, or let go of some or all |
| `team_remember` / `team_recall` | leave a note (decision, gotcha, convention) on a file for every agent, and read them |
| `team_message` / `team_inbox` | message a teammate or everyone; read what came in |
| `team_handoff` / `team_accept` | pass a task, its next steps and its files to someone; take one over |
| `team_done` | finish: every claim released |
| **Measured runs** | |
| `flow_read` | what actually ran: steps, timings, the critical path, problems noticed |

The same vocabulary is available as the resource `vibez://reference`.

On a team project, `ui_edit`, `vi_edit` and `site_edit` also check the team before writing. When another person's agent holds the file (or the page's linked `.vi` file, or another element on the same page), the reply starts with a heads-up naming them and their task. The edit still goes ahead: claims warn, they never block. The file is then claimed for this agent. Without a team these tools behave exactly as before.

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

`.vi` files are the graph editor's. Declaration editing changes their
`exports` block; `vi_run` compiles their existing graphs and executes one selected item, per [docs/ui-vi-contract.md](../../docs/ui-vi-contract.md).
When the graph format settles, graph reading and editing tools belong here too.
