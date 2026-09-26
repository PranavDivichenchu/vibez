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
| `packages/vibez-core` | the VS Code extension and its canvas webview |
| `examples/shop` | a real instrumented app with a planted N+1 |
| `fork/` | the Code – OSS overlay: branding only, 42 lines against upstream |
| `vscode/` | the Code – OSS fork *(phase 3)* |

## The fork

The Code – OSS checkout lives at `~/.vibez/vscode`, outside the repo, because
node-gyp does not quote paths and a space anywhere above it breaks every native
module build. `fork/` holds an overlay that is merged into it. Everything that makes Vibez what it is
lives in `packages/vibez-core`, an ordinary extension the fork ships as a
built-in, so divergence from upstream stays near zero.

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
