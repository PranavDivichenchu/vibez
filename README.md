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
| `packages/mcp` | MCP page/declaration editing, inspection and isolated logic tests |
| `fork/contrib` | Native workbench editors, execution service and console |
| `packages/core` | Shared graph types, layout and recorded-flow analysis |
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
