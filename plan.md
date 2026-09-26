# Vibez

**B**ezier **V**isual **I**nterface. An IDE where your codebase is a node graph built from what actually ran.

A fork of VS Code. Open a folder, get a map.

---

## 1. What it is

Vibez is a code editor that adds one thing: a canvas tab showing your app as a bezier node graph, drawn from real execution traces rather than static analysis. Slow paths are visually loud. The agent panel edits your code, and you watch the graph change as it works.

Everything else is VS Code, because everything else in VS Code is fine.

### Who it's for

Someone who built an app with an AI assistant, does not fully understand the code that came out, and wants to see it before changing it.

### What it is not

Not a CLI. Not an extension you install into someone else's editor. Not a web app. Not an iPad tool. Those are all cut.

---

## 2. Load-bearing decisions

### 2.1 The graph is read-only. The code is the source of truth.

Unity Bolt and Unreal Blueprints are visual *programming languages* where the graph is the source of truth. Every attempt to do that for an existing codebase has failed, because the graph must become as expressive as the language, at which point it is a worse text editor.

Vibez's graph is a **projection**. You point at it, the agent edits the files, the graph redraws. It never round-trips, which frees it to be lossy, opinionated and beautiful.

### 2.2 The graph is built from runtime traces.

Static dependency graphs are hairballs nobody opens twice. Sourcetrail and CodeSee are both dead.

OpenTelemetry spans give three things free: only code that really ran appears, so the graph is small; every node carries a measured duration, so "this is slow" is data; and there is no parser to maintain.

This is **a profiler you can point at**, not a code viewer.

### 2.3 Vibez is the editor. The graph is part of it.

An earlier draft had the graph as an extension bundled into the fork, on the
theory that it keeps the merge tax down. That was wrong, and shipping it proved
it: the window said "Get Started with VS Code", `.flow` opened as plain JSON,
and the product was visibly VS Code with a guest running inside it.

The graph is a **workbench contribution compiled into the product**, at
`src/vs/workbench/contrib/vibez/`. It registers a real `EditorPane` and
`EditorInput`, so `.flow` opens as a graph on first launch with no extensions
installed at all, and it inherits the window's theming, tabs, splits, history
and keybindings like any other editor.

Only the pure, dependency-free parts of `@vibez/core` make that trip — types,
heat, layout — synced by `npm run sync:core`, since the renderer runs in a
browser context with no Node. Anything needing Node (capture, detectors, the
agent) stays a service on the other side of the process boundary.

**The merge budget is on modified upstream files, not lines.** Line count is the
wrong metric: a 5,000-line directory upstream has never heard of conflicts
never, while a twenty-line edit inside `workbench.common.main.ts` conflicts most
months. Budget is 12 modified files. Current count is **4**: `product.json`, one import
in `workbench.common.main.ts`, one in `workbench.desktop.main.ts`, and a service
plus channel registration in `app.ts`. Sixteen new files carry everything else.
`npm run fork:diff` prints both and fails on the first number only.

### 2.4 Animation is programmatic, never generated.

The agent must not spend a single token describing what the canvas should do. The IDE already observes every tool call the agent makes and every file that changes. That event stream, plus the graph diff, is enough to choreograph everything deterministically.

Full mechanism in §5.

### 2.5 Short text, or no text.

The canvas is the explanation. Prose is the fallback when a picture cannot carry it. Hard caps, enforced in code:

| Surface | Cap |
|---|---|
| Node fact strip | 1 line, 48 chars |
| Agent chat message | 3 lines before it collapses |
| Lesson tooltip | 1 sentence |
| Empty state | 2 lines |

If an explanation needs more room, the answer is a better visual, not a longer paragraph.

---

## 3. The IDE

### 3.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│ vibez — northwind                                            │  title 34
├──┬──────────┬─────────────────────────────────┬─────────────┤
│  │ EXPLORER │ queries.ts │ dashboard ⬡ │ Preview│   AGENT    │
│▣ │          ├─────────────────────────────────┤             │
│⌕ │ app/     │                                 │  chat +     │  body
│⑂ │ lib/     │        node graph               │  activity   │
│⬡ │ compo…   │                    ┌─────────┐  │  chips      │
│◆ │          │                    │ preview │  │             │
├──┴──────────┴────────────────────┴─────────┴──┴─────────────┤
│ 14 runs · measured · 2.40 s                                  │  status 24
└──────────────────────────────────────────────────────────────┘
```

- **Activity bar** gains one icon: the graph (`⬡`). Agent panel (`◆`) is the second addition.
- **Editor tabs** are normal VS Code tabs. `dashboard ⬡` is a custom editor. `Preview` is a live iframe against the dev server.
- **Agent panel** docks right, resizable, closable.
- **Status bar** carries the current flow's headline number and measurement mode.

Everything is standard VS Code furniture. A person who has used Cursor knows where everything is on first launch.

### 3.2 The graph is a custom editor

Registered against `*.flow` files in `.vibez/flows/`. That means tabs, split view, side-by-side with code, and back/forward navigation all work for free because VS Code already does them.

Opening the folder auto-creates `.vibez/flows/default.flow` on the first trace.

### 3.3 Click a node, open the code

Selecting a node reveals its anchor in a real editor tab at the real line. Not a side panel, not a popover. The IDE already has the best code viewer in it; use that one.

Ctrl-click opens it in a split beside the graph, which is the layout most people settle into.

### 3.4 The preview, and the link back

`Preview` is a tab holding an iframe against the dev server, which Vibez proxies so it can inject a dev-only bridge script without touching the user's source.

The bridge walks the React fiber tree on each commit, tags host DOM nodes with `data-vibez-node="<semanticKey>"`, and posts their rectangles up over `postMessage`.

| From | Action | Result |
|---|---|---|
| Graph | select node | matching region of the preview gets outlined |
| Preview | click region | graph tab activates with that node selected |
| Preview | always | warm tint over regions, proportional to cost |

Data nodes have no DOM. They inherit the region of the nearest ancestor render node that awaited them, which is why clicking a table selects `getUserStats` rather than `StatsGrid`.

Whichever of graph/preview is not the active tab appears as a 280px inset in the corner of the other. Click it to swap. Both stay mounted, so the iframe never reloads and client state survives.

Non-React frameworks need their own adapter. React only in v1; keep the `postMessage` contract framework-agnostic.

---

## 4. The agent panel

### 4.1 Short messages, loud canvas

The agent writes three lines at most. What it is actually doing shows up as **activity chips** in the transcript and as animation on the graph.

```
  you   why is the dashboard slow?

  ⬡     One query runs 12 times instead of once.

        ◦ read  lib/db/queries.ts              ✓
        ◦ found the loop at line 88            ✓
        ◦ editing  getUserStats                ⟳
        ◦ rebuild
        ◦ replay 15 runs
```

Each chip corresponds to an animation on the canvas. You watch it work rather than reading about it.

### 4.2 Chips are derived, not written

A chip is emitted by the IDE from an agent tool call, never by the model. The model calls `read_file`; the IDE renders `read lib/db/queries.ts` and sweeps the matching nodes. The model never knows chips exist.

### 4.3 Scoped by selection

Selecting nodes on the canvas before you type sets a **scope fence**: the agent may only edit those files, enforced server-side before writes reach disk. The chip row shows the fence as a first chip: `scoped to 2 files`.

This is the single biggest quality lever. The thing agents do worst in a large codebase is wander.

---

## 5. Choreography

How the canvas animates without costing tokens.

### 5.1 The pure function

```ts
choreograph(
  events: AgentEvent[],     // tool calls, already streamed by the SDK
  before: Graph,
  after: Graph
): Timeline                 // ordered animation steps
```

No model call. No prompt. A reducer over events the IDE already receives.

### 5.2 The mapping

| Source event | Canvas animation |
|---|---|
| `read_file(X)` | nodes anchored in X get a 600ms scan sweep |
| `grep(sym)` | matching nodes flash their outline twice |
| `edit_file(X, lines)` | affected nodes pulse a blue ring, gain a diff badge |
| new symbol appears | ghost node fades in, dashed border until first traced |
| symbol removed | node dims to 25%, collapses after 400ms |
| build starts | whole canvas desaturates to 70% |
| replay running | exec wires dash-flow along the executing path, node by node |
| new trace lands | heat tweens, numbers count up, wires re-weight |
| significance test | improved nodes flash once; unchanged ones do nothing |

### 5.3 Why this is the actual feature

Watching an agent edit your architecture is a fundamentally better interface than reading a summary of what it did. It is also honest: the animation is derived from real file events and real traces, so it cannot describe a change that did not happen. A model-written summary can.

### 5.4 Rules

- Every animation is interruptible. Clicking anything cancels the timeline and jumps to the end state.
- Total choreography for one agent turn is capped at 6 seconds. Longer work shows progress on chips, not on the canvas.
- Animations never move the camera without a user gesture. Auto-panning while someone is reading is hostile.
- `prefers-reduced-motion` collapses every animation to a 1-frame state change.

---

## 6. Learning, quietly

After ten sessions the person should understand their codebase better. Without lectures.

### 6.1 The ratchet

Every concept carries an exposure count in `~/.vibez/learned.db`. How it renders depends on the count.

| Seen | Renders as |
|---|---|
| 1–2 | `asks the database the same thing 12 times` |
| 3–5 | `asks the database the same thing 12 times · N+1` |
| 6+ | `N+1 · 12 duplicate queries` |

Nobody is asked to level up. One day the interface is speaking to them as a peer. Counts are per concept, so learning about N+1s does not promote hydration. A manual override exists in both directions.

### 6.2 One sentence, never a paragraph

Hovering a fact gives exactly one sentence about the pattern:

> Every pass of this loop waits for the one before it.

That is the whole lesson. The twelve stacked identical nodes on the canvas already did the teaching.

### 6.3 Never a magic button

`Fix it` states its technique in one line before running, and names it after:

> **Will do:** one query for all rows, then match in memory.
> *(after)* `2.40 s → 0.31 s` · that technique is called batching

### 6.4 Banned

Badges. Streaks. XP. Visible levels. Progress bars toward mastery. Quizzes. Tutorial mode. Mascots. Tips of the day. Celebration animations. Walls of explanatory text.

These are the default things people build when told to make software teach, and each one tells the user they are being handled.

---

## 7. Visual design

### 7.1 It is a node editor, not a dashboard

Three things are mandatory, and skipping any one produces boxes near lines:

1. **Ports.** Wires terminate on visible pins.
2. **Header bands.** Tonally distinct, carrying icon, name and cost. This is what
   makes a node read as an object.
3. **Weighted bezier wires.** Two kinds, visibly different.

### 7.1a Inputs and outputs must not look the same

Blueprints separates execution from data. Scratch makes direction obvious to
someone who has never seen a node editor, because a plug and a socket cannot be
confused. Take both.

| | Input, on the left | Output, on the right |
|---|---|---|
| **Exec** | hollow outlined arrow, set into the edge | solid arrow protruding past it |
| **Data** | ring socket, recessed, hollow when unwired | filled dot on a short stem, sticking out |

The rule underneath: **an input is a socket, an output is a plug.** Direction is
then readable on a single node, without tracing a wire to its other end. A loose
output keeps its stem but hollows out, so "nothing consumes this" still reads.

### 7.2 Beziers, not right angles

Right angles read as a flowchart. Bolt and Blueprints both use beziers and both read as tools. It is in the name.

Horizontal control points offset `clamp(|dx| * 0.6, 40, 120)` from each endpoint, so wires always leave and arrive horizontally. That one constraint is most of why professional node editors look tidy.

### 7.3 Two color channels that never collide

- **Node body and header carry latency.** Neutral when fast, warm when slow.
- **Pins and data wires carry type.** Green String, blue Object, purple List, amber Number, pink Boolean, grey Unknown.
- **Exec wires carry neither.** Grey, except the critical path in clay.

Fast things recede. There is no green-for-good; quiet is the reward for being fast.

### 7.4 Tokens

| Token | Value |
|---|---|
| Canvas | `#0B0C0E` |
| Dot lattice, 26px | `#1C1F24` |
| Node body | `#15171B` |
| Node header | `#1B1E23` |
| Border / hover / selected | `#282C33` / `#3C4550` / `#5B8DEF` |
| Text | `#EDEFF2` / `#98A0AA` / `#6E767F` |
| Exec wire / critical | `#454D57` / `#C4785A` |
| IDE chrome | `#111316`, panels `#0E1013` |

Dark only. The preview is light, which is correct: the tool and the thing under test should never be confusable.

### 7.5 Heat

Self time as a percentile of total flow time, not absolute milliseconds. Lands on header tint, border and the time figure. No rail.

| Band | Header | Border | Time |
|---|---|---|---|
| p0–75 | `#1B1E23` | `#282C33` | `#98A0AA` |
| p75–90 | `#1F1C19` | `#282C33` | `#A8905E` |
| p90–97 | `#221E17` | `#33291F` | `#C79A53` |
| p97+ | `#221815` | `#3A2721` | `#E0705B` |

Never color alone: the number is always printed, and p97+ takes a warm border. Legible in greyscale.

### 7.6 Node anatomy

```
    ┌─────────────────────────────────┐
  ▸ │ ⛁  getUserStats         2.10 s  │  header 34
    ├─────────────────────────────────┤
  ● │ userId  String          then  ▸ │  port row 24
    │                   rows  Stats[] ●│
    │ ⚠ 12 identical queries          │  fact strip, 1 line
    ├─────────────────────────────────┤
    │ 12 calls            queries.ts:88│  footer 26
    └─────────────────────────────────┘
```

Fixed width per column with middle-ellipsis truncation. Exec pins are 9×12 triangles, data pins 9px circles, a hollow circle means an output nothing consumes. Corner radius 9px, border 1px, no shadow except the selection ring.

### 7.7 Wires

Exec 2.5px, critical 3.5px clay, data 1.5px at 85% tinted by type. Critical path at full opacity and everything else at 45% **only above eight nodes** — below that, dimming reads as a bug. Routing reserves vertical lanes between columns rather than routing each wire alone.

### 7.8 Motion

| Event | Animation |
|---|---|
| Relayout | 220ms `cubic-bezier(.2,0,0,1)` position tween |
| Node added | opacity 0→1, scale .97→1, 160ms |
| Node removed | fade to .25, remove at 400ms |
| Tab/inset swap | 200ms transform tween |
| Timing changed | 300ms count-up, tabular figures |
| Replay | exec wires dash-flow along the running path |

### 7.9 Banned

Gradients as decoration. Drop shadows. Glow. Neon. Emoji. More than one accent hue. Skeuomorphic node headers. Hand-tuned per-node widths. Anything that would look dated in three years.

---

## 8. The graph IR

The contract. Everything else is replaceable behind it, including the renderer.

```ts
type NodeKind = 'entry' | 'render' | 'compute' | 'data'
              | 'external' | 'boundary' | 'effect' | 'group'

type PortType = 'String' | 'Number' | 'Boolean' | 'Object' | 'List' | 'Unknown'

interface Port { id: string; name: string; kind: 'exec' | 'data'
                 type?: PortType; connected: boolean }

interface Stats { p50: number; p95: number; min: number; max: number; n: number }

interface GNode {
  id: SemanticKey
  kind: NodeKind
  label: string
  anchor: { file: string; line: number; symbol: string } | null
  ports: { in: Port[]; out: Port[] }
  metrics: { calls: number; selfMs: Stats; totalMs: Stats }
  heat: number                 // 0..1, self-time percentile within flow
  facts: Fact[]
  domKey?: string              // preview mapping, §3.4
  coverage?: { branches: number; hit: number }
}

interface GEdge {
  id: string; from: PortRef; to: PortRef
  wire: 'exec' | 'data'
  metrics: { count: number; gapMs: Stats }
  onCriticalPath: boolean
}

interface Fact {
  code: 'n+1' | 'sequential-awaits' | 'waterfall' | 'uncached' | 'cold-render'
  strip: string       // ≤48 chars, on the node
  lesson: string      // one sentence, on hover
  technique: string   // one line, shown before a fix runs
  evidence: Record<string, unknown>
}
```

### 8.1 Exec wires are free, data wires are inferred

Exec wires fall out of span parent/child plus sibling ordering. A trace already is an execution graph.

Data wires need value capture, which OTel does not do. **v1 infers them from source**: the anchor's parameter names and the call site's arguments give you `userId: String` flowing between nodes without capturing a single value. Cheap, static, right most of the time. Measured wires are Phase 6, and only if inference proves wrong often enough to matter.

### 8.2 Stable identity

IDs that shift on rebuild reshuffle the canvas and make before/after meaningless.

```ts
semanticKey = hash(kind, normalizedName, parentChainOfKinds)   // stable, never a path
anchor      = { file, line, symbol }                            // volatile, re-resolved
```

| Kind | Normalized name |
|---|---|
| entry | `GET /dashboard/[id]` — route pattern, not concrete URL |
| render | React display name |
| data | SQL with literals stripped and IN-arity collapsed, hashed |
| external | method + URL with path params templated |
| compute | repo-relative module path + exported symbol |

Positions persist in `.vibez/layout/<flow>.json` keyed by semantic key, and that file is worth committing. New nodes are placed near their parent rather than triggering a full relayout.

---

## 9. Fact detectors

Deterministic rules over the span tree. No model involved. Five good ones beat twenty sloppy ones.

| Code | Rule | Strip text |
|---|---|---|
| `n+1` | ≥3 sibling spans, same normalized SQL fingerprint | `12 identical queries` |
| `sequential-awaits` | Siblings that never overlap, no data dependency | `3 waits that could overlap` |
| `waterfall` | ≥3 chained external calls | `4 requests in a chain` |
| `uncached` | Identical external call, identical args, across runs | `refetched every load` |
| `cold-render` | Render self time exceeds children's total | `400 ms before any data` |

Each carries its one-sentence `lesson` and one-line `technique`.

---

## 10. Architecture

### 10.1 The fork

Base: **Code – OSS**. Track upstream `release/*` branches, merge monthly.

| Layer | What changes |
|---|---|
| Branding | product.json, icons, welcome page, title bar. Thin, isolated, rarely conflicts. |
| Defaults | settings, keybindings, first-run walkthrough |
| Bundled extension | `vibez-core`, shipped built-in, not from a marketplace |
| Everything else | untouched |

**Keep the diff against upstream under ~2000 lines.** Every line beyond branding and bundling is a merge tax forever. If a feature needs core changes, ask first whether the extension API can do it.

### 10.2 The extension

`vibez-core` is a normal VS Code extension:

- Custom editor provider for `.flow` files → the graph webview
- Webview view provider → the agent panel
- Task provider → dev server, build, replay
- Language client → anchor resolution via the existing TS server rather than our own parser

### 10.3 Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | TypeScript | One language, extension host to webview |
| Trace capture | OpenTelemetry Node SDK + `@vercel/otel` | Next has first-class OTel via `instrumentation.ts` |
| DB spans | `instrumentation-pg`, Prisma tracing | SQL text and timing as span attributes |
| Client metrics | `PerformanceObserver` + React `<Profiler>` shim | ~50 lines vs 90kb for the OTel web SDK |
| Preview bridge | fiber walk + `postMessage`, injected by the proxy | User source never modified |
| Ingest | OTLP/HTTP inside the extension host | No collector process |
| Storage | SQLite via `better-sqlite3` | Spans, layouts, exposure counts |
| Layout | `elkjs` layered, in a worker | Fixed port sides, reserved lanes |
| Renderer | React Flow (xyflow) in the webview | Graphs capped at ~40 visible by design |
| Replay | Playwright | What makes before/after mean anything |
| Agent | Claude Agent SDK in the extension host | Tool events feed §5 choreography |
| Coverage | `NODE_V8_COVERAGE` | Unobserved branches, no parser |

### 10.4 Processes

```
Vibez (Electron)
 ├─ extension host
 │   ├─ otlp receiver        ← the user's dev server posts spans here
 │   ├─ dev-server proxy     ← injects the preview bridge
 │   ├─ graph builder        ← spans + anchors → IR
 │   ├─ detectors            ← IR → facts
 │   ├─ choreographer        ← agent events + graph diff → timeline
 │   ├─ playwright driver    ← records and replays flows
 │   └─ agent sdk            ← scope-fenced edits
 └─ webviews
     ├─ graph canvas
     ├─ agent panel
     └─ preview iframe
```

### 10.5 Security

The agent writes to the user's repo. Same posture as Cursor, plus one addition:

- **Scope fence enforced in the extension host**, not in the prompt. Writes outside the selected file set are rejected before reaching disk.
- Every applied change is a `git stash` entry, so Undo is one action.
- Refuse to run the agent on a dirty tree without confirmation.

---

## 11. The loop

```
selection + prompt
      │
      ▼
scope fence ──► Agent SDK ──► writes files
                    │              │
        tool events ▼   file watch ▼
        choreographer              rebuild
                    │              │
                    │  replay ×N   ▼
                    │         Playwright
                    │              │
                    └──► timeline ◄┴─ new trace → graph diff
                             │
                             ▼
                       canvas animates
```

### 11.1 Dev-mode timings are lies

Next compiles routes lazily in dev, so the first hit is mostly compilation. Two modes, always labeled in the status bar:

- **Fast** — dev server, 3 warmup runs discarded, relative only, reads `rough`
- **True** — production build, 15–20 runs, real percentiles, reads `measured`

Never blur them.

### 11.2 Significance, not deltas

At 15 samples a 12% p50 change is noise. Mann-Whitney U before drawing a node as improved or regressed. Twenty lines, and it stops the canvas crying wolf after every rebuild.

### 11.3 Diff classification

Match by semantic key: `unchanged | moved | slower | faster | added | removed`. **`moved` renders as no change** — anchors shift constantly, and treating that as change makes every rebuild look like a catastrophe.

---

## 12. Roadmap — five phases

### Phase 1 — Core: prove the map is worth drawing  ✅

- [x] IR types, semantic keys, span classification
- [x] Span tree with union-based self time
- [x] Reducer: spans → Graph, aggregated per run
- [x] Five fact detectors with strip / lesson / technique
- [x] Heat as share of flow, verdict scale, graph diff
- [x] Planted-problem fixture and a `demo` that prints the IR
- [x] 23 tests
- [ ] `packages/capture`: real OTLP receiver + SQLite
- [ ] `examples/next-shop`: a real Next app replacing the fixture

**Gate:** the printed IR must say something true about an app you know. Passed —
it reports `getUserStats 2.08 s · 86% of flow · 12 × 173 ms`.

### Phase 2 — Canvas: the node editor

- [ ] `vibez-core` extension scaffold, custom editor for `.flow`
- [ ] Tokens §7.4, heat bands §7.5, node anatomy §7.6
- [ ] Bezier wires, two weights, type-colored data wires
- [ ] ELK worker, fixed port sides, reserved lanes
- [ ] Click node → reveal anchor in a real editor tab
- [ ] Layout persistence keyed by semantic key

### Phase 3 — Fork and preview  ✅

- [x] Fork Code – OSS, branding, `vibez` CLI, `.vibez-ide` data folder
- [x] The graph as a workbench `EditorPane`, exclusive for `.flow`
- [x] Vibez in the activity bar with a Flows view
- [x] Trace receiver in the main process, over IPC to the renderer
- [x] Recording starts with the window; flows appear because the app ran
- [x] Upstream's walkthrough replaced: a window opens on its own graph
- [x] Dev-server proxy injecting the bridge, so the app is never modified
- [x] Heat tint and outlines over the real page
- [x] Click a region → the graph opens on the node that drew it
- [x] Graph and preview side by side on a fresh window
- [ ] Build and sign for macOS and Windows

### Phase 4 — Agent and choreographer

- [ ] Agent panel, 3-line cap, activity chips
- [ ] Scope fence from canvas selection, enforced host-side
- [ ] `choreograph()` as a pure reducer over tool events + graph diff
- [ ] Every animation in §5.2, interruptible, 6s cap, reduced-motion path
- [ ] Playwright recorder and replayer
- [ ] Mann-Whitney significance on the diff
- [ ] Git-stash undo

### Phase 5 — Teaching and depth

- [ ] Exposure counts and the ratchet §6.1
- [ ] Per-node one-line descriptions, cached
- [ ] Collapsed-by-default grouping
- [ ] V8 coverage, greyed unobserved branches
- [ ] Measured data wires via SWC transform
- [ ] Vue and Svelte preview adapters
- [ ] Python and Go backends

---

## 13. Repo layout

```
vibez/
├── plan.md
├── vscode/                      Code – OSS fork, thin branding diff
│   └── product.json             name, icons, builtin extensions
├── packages/
│   ├── core/                    IR types, semantic keys, detectors,
│   │                            diff, significance, vocabulary
│   ├── capture/                 otlp receiver, sqlite store, client shim
│   ├── bridge/                  fiber walk, rect postMessage
│   ├── replay/                  playwright recorder + driver, stats
│   ├── choreo/                  agent events + diff → timeline
│   └── vibez-core/              the VS Code extension
│       ├── src/extension.ts
│       └── webview/             react flow canvas, agent panel
└── examples/
    └── next-shop/               planted n+1, waterfall, cold render
```

Build `examples/next-shop` in week one. Planted problems are the only honest way to test detectors, and it doubles as the demo.

---

## 14. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The graph is not actually informative | Fatal | Phase 0 gate. Read the raw JSON before writing a renderer. |
| It looks like a dashboard, not a tool | High | Already happened once. Ports, header bands, weighted beziers are non-negotiable, §7.1. |
| Fork merge tax compounds | High | Keep the upstream diff under 2000 lines. Everything real lives in the bundled extension, §10.1. |
| Choreography costs tokens after all | High | `choreograph()` is a pure function with no model call. If a feature needs the model to describe animation, cut the feature. |
| Text creeps back in | Medium | Caps in §2.5 are enforced in components, not left to judgment. |
| Trace coverage misses unexercised paths | Medium | Playwright recorder early, V8 coverage to grey in the rest. |
| Hairball on the second flow | Medium | One flow per tab, collapse by folder, hard cap at 40 visible. |
| Fiber mapping breaks on React internals | Medium | Framework-agnostic `postMessage` contract so adapters are swappable. |
| Semantic keys churn | Medium | Test explicitly: rename a file, move a function, confirm nothing moves. |
| Only Next.js | Low | Deliberate for v1. OTLP as the sole input boundary keeps the door open. |

---

## 15. Definition of done for v1

Someone opens their own folder in Vibez and, in under two minutes:

1. Sees their app as a graph without configuring anything
2. Spots the slow node because it is the loud one
3. Clicks it and lands on the real line in a real editor tab
4. Types one sentence in the agent panel
5. **Watches** the fix happen on the canvas instead of reading about it
6. Sees the number drop, and undoes it in one action if they want

And by the tenth time, the interface is calling it an N+1 query, because they now know what that is.

---

## 16+. After v1

Three v2 features are planned in [plan-v2.md](plan-v2.md), in dependency order: the agent queue, the voice, the iPad slate. None of them start until §15 is real.

Two v1 changes they depend on: stack capture at span start, so compute nodes have anchors (§3.3), and trace-context propagation into the HTML, so a preview region can reach a server-side node (§3.4).
