# Vibez

**B**ezier **V**isual **I**nterface. An IDE where your codebase is a node graph
built from what actually ran.

A fork of VS Code. Open a folder, get a map.

```
  GET /dashboard   14 runs · measured · 2.42 s

  ›█ getUserStats       data       2.08 s slow        86% of flow   12×  173 ms  lib/db/queries.ts:88
        ⚠ 12 identical queries  —  Every pass of this loop waits for the one before it.
     listCustomers      data        96 ms instant      4% of flow    1×   96 ms  lib/db/queries.ts:70
  ›  DashboardPage      render      87 ms instant      4% of flow    1×   87 ms  app/dashboard/page.tsx:42
     getBilling         data        81 ms instant      3% of flow    1×   81 ms  lib/db/queries.ts:140
     StatsGrid          render      60 ms instant      3% of flow    1×   60 ms  components/StatsGrid.tsx:8
  ›  GET /dashboard     entry       15 ms instant      1% of flow    1×   15 ms

  critical path: GET /dashboard → DashboardPage → getUserStats
```

## Why

Static dependency graphs of real codebases are hairballs nobody opens twice.
Vibez builds its graph from OpenTelemetry traces instead, so only code that
really ran appears, and every node carries a measured duration.

It is a profiler you can point at, not a code viewer.

## Status

Phase 2 of 5. The graph is built from a genuinely instrumented app and renders
as a node editor. Not shipping yet. See [plan.md](plan.md).

## Try it

Needs Node 22.18+. Node runs the TypeScript, so there is no build step, and
nothing outside the example app has a runtime dependency.

```bash
npm run trace      # runs the example app, records 14 traces, prints the graph
npm run view       # bundles graph + layout, writes a standalone preview.html
npm test           # 38 tests
npm run typecheck
```

`npm run trace` starts the OTLP receiver, spawns `examples/shop`, discards three
warmup runs, measures fourteen, and writes `.vibez/graph.json`. Then `npm run view`
produces `packages/vibez-core/webview/preview.html`, a self-contained page you can
open in any browser to see the canvas.

## Layout

| Package | What |
|---|---|
| `packages/core` | IR, semantic keys, span reducer, detectors, diff |
| `packages/capture` | OTLP receiver, SQLite store, graph endpoint |
| `tools/preview` | standalone graph preview, for looking at a flow without the IDE |
| `examples/shop` | a real instrumented app with a planted N+1 |
| `fork/` | the Code – OSS overlay: branding only, 42 lines against upstream |
| `vscode/` | the Code – OSS fork *(phase 3)* |

## The fork

The Code – OSS checkout lives at `~/.vibez/vscode`, outside the repo, because
node-gyp does not quote paths and a space anywhere above it breaks every native
module build. `fork/` holds an overlay that is merged into it. The graph is a workbench contribution compiled into the
product at `src/vs/workbench/contrib/vibez/` — not an extension — so `.flow`
opens as a graph on first launch with no extensions installed at all.

Divergence is measured in **modified upstream files**, not lines, because that
is what actually conflicts on a merge. Currently **2**.

```bash
npm run fork:setup    # clone Code - OSS at the pinned tag
npm run fork:build    # bundle the extension, apply the overlay
npm run fork:diff     # measure divergence against the 2000-line budget
npm run fork:run      # launch it
```

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
- **Delete something**: select it and press Delete (or Backspace), or use
  **Delete** at the bottom of its Edit panel. It is removed from the HTML file
  with everything inside it, without leaving a blank line behind. The page's
  `<html>`, `<head>`, `<body>` and `<main>` cannot be deleted.
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
  needs [Claude Code](https://claude.ai/code) installed and logged in.
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

Drag a tile onto a page (a blue line or box shows where it will land), or
click it to add it right after the selected element. The new element is
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
**Your pages** lists every page with Show (on the canvas), Code and
**Delete**. Delete asks once, then moves the file to the Trash and takes its
link out of the navigation on the other pages, as one step that ⌘Z on the
canvas undoes. Links to it elsewhere in the content are left alone and
counted. The home page, which new pages copy their header and footer from,
cannot be deleted.

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
