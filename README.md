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

Phase 1 of 5. `packages/core` is real and tested; nothing is shipping yet.
See [plan.md](plan.md).

## Try it

Needs Node 22.18+. No dependencies, no build step — Node runs the TypeScript.

```bash
npm run demo    # builds a graph from a fixture with planted problems
npm test        # 23 tests
```

## Layout

| Package | What |
|---|---|
| `packages/core` | IR, semantic keys, span reducer, detectors, diff |
| `packages/capture` | OTLP receiver and store *(next)* |
| `packages/vibez-core` | the VS Code extension *(phase 2)* |
| `vscode/` | the Code – OSS fork *(phase 3)* |

## Design notes worth knowing

- **Semantic keys never contain a file path.** Moving a function must not move
  its node, or every rebuild reshuffles the canvas.
- **Self time subtracts the union of child intervals, not their sum.** Parallel
  children would otherwise be double counted.
- **Metrics aggregate per run, not per call.** Twelve 173 ms queries are one
  2.08 s problem, not twelve fast ones.
- **Heat is a share of the flow, not a rank.** A fast app has no red nodes.
