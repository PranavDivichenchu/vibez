# Vibez

Vibez is a Code – OSS fork for building apps through readable visual logic.
The `.vi` editor is the coding surface; the `.ui` editor connects page elements
to that logic. Files remain the source of truth, so external edits appear in the
editor and work alongside the workbench's chat tools.

## Coding workflow

The Logic panel groups declarations by purpose:

- **Page Data** supplies values a page displays. Its graph starts at Start and returns a typed result; preview samples belong to the page designer.
- **Page Actions** performs work triggered by a page, with named inputs and an optional result.
- **Functions** holds reusable logic called by other graphs. Functions are testable but are not HTTP endpoints.
- **Variables** stores file-wide state shared by those graphs, with a type, initial value and read/write access.

Select an item to edit its graph and Details. White wires control execution;
colored wires supply data. Compile checks and generates code. Run starts the
local logic server. The Run dropdown tests an individual item with typed inputs;
results and Print to Console output appear in the Console panel.

Drag empty canvas or use a middle-button drag to pan. Scroll pans; Ctrl/Cmd-scroll
zooms. Use the zoom controls or **F** to fit the actual node positions. Shift-drag
selects a rectangle; Shift/Ctrl/Cmd-click toggles nodes. Selected nodes move
together, and the context menu offers cleanup and deletion. Logic and Details
can collapse to make room for the graph and chat.

## Development

Use Node **22.18+** and install dependencies with `npm install`.

```bash
npm test
npm run typecheck
npm run fork:setup        # prepare the pinned Code – OSS checkout
npm run fork:build        # apply branding and sync source into the checkout
(cd ~/.vibez/vscode && npm run compile)
npm run fork:run -- /path/to/project
```

`fork:build` syncs source; the upstream `compile` step produces the runnable IDE.
The checkout defaults to `~/.vibez/vscode`; set `VIBEZ_FORK_DIR` to override it.
See [fork/README.md](fork/README.md) for the overlay structure.

## Project map

| Location | Responsibility |
|---|---|
| `packages/vi` | Logic documents, declarations, graph operations, node catalog, validation and JavaScript generation |
| `packages/ui` | Page documents, layouts, themes, logic bindings and HTML generation |
| `packages/mcp` | MCP server for agents: `.ui` pages, `.vi` logic graphs, plain HTML sites, recorded flows; isolated logic tests; fenced inside agent lanes |
| `fork/contrib` | Native workbench editors, execution service and console |
| `packages/core` | Shared graph types, layout, recorded-flow analysis, site pages and templates, and the agent queue (fences, measurement, significance) |
| `packages/capture` | OpenTelemetry capture and trace storage |
| `packages/codemod` | Checked transformations of traced source code |
| `scripts` | Build, synchronization, launch and development harnesses |
| `examples/shop` | Editable demonstration project, separate from test fixtures |

Recorded-flow analysis remains in the codebase, but it is separate from authored
`.vi` logic. `plan.md` and `plan-v2.md` are historical/future design proposals,
not a description of shipped behavior.

## Runtime scope

The generated server is a **local development runtime**, bound to `127.0.0.1`.
It implements the [page/logic contract](docs/ui-vi-contract.md). State is in memory
and resets with the process. Build artifacts live in `.vibez/build`; do not edit them.

Some saved node kinds are still placeholders: data-source operations, effects,
authorization/validation guards, and higher-order collection operations. Search
labels these “Not runnable yet,” and reachable placeholders fail compilation.
Existing graphs retain their nodes and receive actionable errors. Breakpoints
and live pin watches are not implemented and are not offered as working controls.

See [coding-readiness.md](docs/coding-readiness.md) for validation and release limits.
See [fork/README.md](fork/README.md) for why the budget exists.

## Design notes worth knowing

- **Semantic keys never contain a file path.** Moving a function must not move
  its node, or every rebuild reshuffles the canvas.
- **Self time subtracts the union of child intervals, not their sum.** Parallel
  children would otherwise be double counted.
- **Metrics aggregate per run, not per call.** Twelve 173 ms queries are one
  2.08 s problem, not twelve fast ones.
- **Heat is a share of the flow, not a rank.** A fast app has no red nodes.
- **Nanosecond timestamps stay bigint until a trace is rebased.** Epoch nanos
  are ~1.75e18, past what a double holds exactly.
- **Layout is ours, not ELK's.** Fixed column widths, ports on fixed sides, and
  wires that always leave and arrive horizontally are most of what makes a node
  editor look tidy, and they are cheaper to own than a megabyte of WASM.

## Site canvas

Open a website folder, then choose **Vibez: Open Site Canvas** in the command
palette (or **Open Site canvas** in the Vibez sidebar). Every page of the site
appears side by side as the real, running page: styled, scrollable, with its
scripts working. Lines run from each link, where it actually sits on the page,
to the page it opens, and only ever through the gaps between pages, so none
of the page is hidden.

- **Inspect** (default): hover to see what anything is; clicks select instead
  of navigating. **Browse**: the site works normally. Press `I` to switch.
- **Double-click anything** to see what it does, in plain words: where a link
  goes, what a button's code does ("counts up and changes text on the page"),
  what a form sends and where, where the text or data comes from, and the
  file and line that wrote it. Code links open beside the site. When the app
  has been traced, the measured steps behind an element are listed too.
- **Desktop / Tablet / Phone** re-renders every page at that width.
- Scroll over a page to scroll it; scroll or drag the space between pages to
  move around; pinch or ⌘-scroll to zoom; `F` fits every page.

### Editing on the canvas

- **Change how something looks**: double-click it and use the **Edit** section
  of the inspector: text, font, size, weight, colour, italic, alignment, line
  height, letter spacing, background, corner radius, padding and width, plus
  where a link goes and an image's file and description. Changes show on the
  page as you make them and save to that element's own `style` attribute in
  the HTML file, so nothing else on the site changes.
- **Move something**: in Inspect mode, press on anything and drag it. It
  follows the cursor and stays exactly where you drop it. Pink guides snap it
  into line with other elements (hold Option to place it freely), and the
  arrow keys nudge it by 1px (Shift: 10px). Drop it in a different section
  and it moves into that section. The position is saved on that element
  only; **Put back in its place** in the Edit panel undoes the move.
  To move a whole card or section, click the larger element in the
  inspector's breadcrumb first, then drag.
- **Reorder** (toolbar): the other way to drag. The element slots in
  before or after another one (a blue line shows where), which keeps the
  page's layout flowing naturally on every screen size.
- **Delete something**: select an element (click it), or a whole page (click
  its name above the page), then press **Delete** in the toolbar or the Delete
  key. An element is removed from the HTML file with everything inside it,
  without leaving a blank line behind. A page asks for a second press, then
  goes to the Trash along with its links in the navigation of the other pages
  (links to it elsewhere are left alone and counted). ⌘Z brings either back.
  The home page, and a page's `<html>`, `<head>`, `<body>` and `<main>`,
  cannot be deleted.
- **Drag to delete**: drag an element off its page and onto the element
  panel (or, when the panel is closed, the strip on the left that says "Drop
  here to delete"). It is deleted; ⌘Z brings it back.
- **Link a button or link to a page**: double-click it, then choose the page
  under **Links to**, or press **Pick a page** and click the page (its name
  or the page itself). "Another address…" takes any URL.
- **Follow a line**: click a line between pages. The link it starts from and
  the page it leads to are highlighted until you click empty space or press Esc.
- **Full page** (toolbar, on by default): every page is shown at its whole
  length, header to footer, so nothing scrolls inside it; scroll the canvas
  to go down. Turn it off for one screen per page.
- **One page at a time**: choose a page in the toolbar's page list (or
  **⤢ edit alone** beside its name) to edit it on its own; **All pages** or
  **✕ all pages** shows them all again.
- **View site ↗** opens the selected page in your browser, exactly as a
  visitor sees it: plain HTML, with nothing of Vibez in it. Links there keep
  working as long as Vibez is open.
- **Undo / Redo** (`⌘Z`, `⇧⌘Z`, or the toolbar) cover every canvas change.
  A file with unsaved changes in an editor is never written, and a change is
  refused if the file no longer matches the page on screen.

Editing works on pages served from the folder's HTML files; pages from a
running app (App URL) are read-only for now.

## Agents: several at once, one measurement lane

**Vibez: Open Agents** (or **Open Agents** in the Vibez sidebar) opens a strip
under the canvas. Select nodes on the graph (Shift or ⌘ to select several),
type what you want, and press **Start agent**. Start another while the first
works. Each row is one agent:

```
a  getUserStats   edited · queued 2nd        claims −87%
b  StatsGrid      measuring ⟳ run 12/20
c  fetch.ts       editing · editing fetch.ts
```

- **Each agent is Claude Code** running headless in its own git worktree
  (`.vibez/worktrees/<lane>`), with `node_modules` linked from your tree. It
  needs [Claude Code](https://claude.ai/code) installed and logged in. It also
  gets the Vibez MCP server (`packages/mcp`), so it edits `.ui` pages, `.vi`
  logic and HTML pages through the same checks as the editors, fenced like its
  own edits.
- **Fences.** The files of the selected nodes are fenced for that agent;
  a node whose file an agent holds shows a hatched ring and `held by agent-a`
  on the canvas. Nothing ever waits: asking for a held file is refused on the
  spot, and an agent that tries to write one mid-run (every write is checked
  before it reaches disk) is stopped and re-plans without it. Agents get no
  shell, so they cannot write around the fence. Fences end with the run.
- **One measurement lane.** Finished patches queue. One at a time, Vibez
  starts the app in the patch's copy, replays the recorded flow (3 warm-ups,
  then 15 runs) in a hidden window, and stops the server, so every number is
  taken under the same conditions. A change counts only if a Mann-Whitney
  test says so, corrected across every node with Benjamini-Hochberg.
- **Landing** (one patch at a time, your choice of order) makes one commit
  on your branch with `Co-authored-by`, without touching anything else you
  have in progress. Then everything still waiting is re-measured against the
  new baseline, and each card says what survived:
  `claimed −70% · measured −4% · not significant`. **Undo** is a revert commit.
- **Stop all** (⌥⌘.) ends every run and releases every fence.
- Everything any actor does is appended to `.vibez/room.log`.

**Set up measuring** writes `.vibez/measure.json` with a first guess at how to
start your app (`cwd`, optional `build`, `start` with `$PORT`, `path`, `runs`,
`warmup`). **Record flow** opens your app in a window and writes down what you
click and type until you press **Finish recording**; without a recording, the
flow is one visit to `path`. The app should send OpenTelemetry to the address
in `OTEL_EXPORTER_OTLP_ENDPOINT` (or `VIBEZ_OTLP`), which Vibez sets.

### Adding elements

**+ Element** on the site canvas opens a library of 48 ready-made pieces,
searchable and grouped:

- **Text**: Title, heading, subheading, text box, intro text, quote, bulleted
  list, numbered list, small print, text link
- **Buttons**: Button, outline button, two buttons, big button
- **Media**: Image, image with caption, gallery, video, embed, map, divider,
  spacer
- **Layout**: Section, card, two columns, three cards, callout, hero banner
- **Forms**: Contact form, newsletter signup, text field, email field, phone
  field, message box, dropdown, checkbox, choices, date field, submit button
- **Content**: Table, question & answer, numbers, testimonial, price box, code
  block
- **Navigation**: Link row, social links, back to top

Drag a tile onto a page and it lands exactly where you let go: a dashed box
shows its size and place while you drag, and it is saved into the section
under the pointer with that offset, the same way **Move freely** places a
dragged element. With **Reorder** on, it slots into the layout instead (a
blue line or box shows where). Or click a tile to add it right after the
selected element. The new element is
selected with its **Edit** panel open, and adding it is one undo step.

Elements pick up your site's fonts and its accent colour (read from its
buttons and links). Their look comes from one small stylesheet scoped to
`.vz-el`, added to a page's `<head>` the first time an element is added there.
Images start as a placeholder; set the file in the Edit panel.

### Dashboard: add pages from templates

**Vibez: Open Dashboard** (or **+ Add page** on the site canvas, or the
sidebar) shows seven templates as live previews that already wear your site's
header, footer and styles: **Blank**, Landing page, About / team, Contact,
Pricing, Menu / products and Blog post. Pick one, give the page a name (the
file name fills itself in), and choose whether to add it to the navigation on
every page. The new page opens on the site canvas, ready to edit and drag.

New pages copy everything outside the `<main>` of the site's home page (its
head, header, navigation, footer and scripts). Each template brings a small
stylesheet scoped to `.vz-page` that inherits your fonts and colours. Adding a
page is one undo step, links included: ⌘Z on the canvas takes it all back.
**Your pages** lists every page with Show (on the canvas) and Code.

Static sites are served straight from the folder. For an app that needs a
server (Next.js, Vite…), start its dev server and put its address in
**App URL**; pages are then loaded through it. Either way the pages are served
by Vibez on 127.0.0.1 with a small inspector script added at the top of each
HTML page; the files themselves are never changed.

Try `examples/navigation`, a four-page bakery site with a menu, a newsletter
form and a little script.

Limits: pages whose address needs a value (`/product/[id]`) are not shown yet;
a click handler's description comes from reading its code for well-known
moves and says "runs some code" when it recognises none; element-to-line
mapping is exact for HTML files and best-effort for framework components.

## Teams: several people's agents on one project

The Agents strip coordinates agents on one machine. Teams do the same across
people: Pranav's Claude Code and Ashmith's Claude Code, on their own laptops,
see what the other is doing and are warned before they collide. The team
lives in a Supabase project; each person signs in anonymously and joins with
a code.

```
npm run team -- create "Vibez" --as Pranav --url <supabase url> --key <anon key>
npm run team -- join <code> --as Ashmith
npm run team -- status
```

`create` writes `vibez.team.json` (commit it: it holds the project URL, the
public anon key and the team id, never the join code) and prints the code.
Each person's sign-in is kept in `~/.vibez/team/`, readable only by them.
The Supabase project needs the migration in `supabase/migrations` and
anonymous sign-ins turned on. For local work, `npx supabase start` in this
repository runs one in Docker with both already set.

Once a project has a team, every agent using the Vibez MCP server gets the
`team_*` tools (see `packages/mcp/README.md`):

- **Presence.** `team_start` says what the agent is doing and claims the
  files it will change. `team_status` shows each person's agents, their
  task, the files they hold, and whether they are still active (an agent
  quiet for 90 seconds shows as quiet, and its claims say it may have stopped).
- **Overlap warnings.** Claims are graded: the same file or element is
  *overlapping*; another element on the same page, a page's linked `.vi`
  file, or the same folder is *adjacent*; a task described in similar words
  is *related*. `ui_edit`, `vi_edit` and `site_edit` check before writing
  and start their reply with a heads-up when someone is there. Claims warn,
  never block.
- **Shared notes.** `team_remember` leaves a decision, gotcha or convention
  on a file; every agent that starts work near it is shown it.
- **Messages and handoffs.** `team_message` reaches a person (and their
  agents). `team_handoff` passes a task, its next steps and its files to
  someone, and `team_accept` takes it over.

Agents started from the Agents strip are told to use these when the project
has a `vibez.team.json`. Row-level security keeps every table to the team's
members; the anon key alone reads nothing.
