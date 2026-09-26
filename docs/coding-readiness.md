# Coding workflow: scope and release checks

The existing product goal is to make application logic visible, editable and
testable while leaving room for chat. `.vi` files own behavior; `.ui` files own
presentation. The graph and Details panel operate on the same declarations,
and Compile, Run and Test use the same compiler.

## This stabilization pass

- Fixed generated object expressions, switch bodies, reserved names, parameter/global name collisions and imported-call aliases.
- Rejected circular/dangling wires, missing graphs, duplicate declarations, deleted variable reads, read-only writes and values consumed outside their execution path.
- Preserved external-call signatures on reopen and execution nodes when changing a Page Data type.
- Made placeholder runtime operations explicit in search and compile diagnostics. Removed cosmetic breakpoint/watch controls that had no runtime behavior.
- Serialized saves, guarded external reloads against pending local writes, checked build writes, stopped Run on compile errors and made generated output explicitly ESM.
- Compiled sibling graphs using paths relative to each calling file. Duplicate basenames are rejected before output can overwrite another module.
- Isolated MCP tests in fresh processes with a timeout and output limit. Test logs stay off MCP protocol stdout, and temporary output is cleaned up.
- Corrected fit-to-view bounds and group-drag wires; restored wheel navigation over nodes; removed the retired tab renderer.
- Made malformed URLs and invalid/oversized JSON produce request errors without stopping the local server.
- Separated integration fixtures from the editable demo project and corrected stale build/documentation instructions.

## Verification

Verified on this checkout: 207 package tests pass; all six package typechecks pass.
The workbench build passes with zero errors. In the rebuilt IDE,
`CalculateUnitPrice(100, 4)` returned `25` twice and printed `Unit Price: 25`
to Console; fit-to-view visibly framed the full graph.

Run `npm test` and `npm run typecheck` with Node 22.18 or newer. Tests cover the
core, capture, codemod, page, logic and MCP packages. Compiler tests import and
execute generated modules; server tests make actual HTTP requests, including
malformed URL, invalid JSON and oversized-body cases.

Run `npm run fork:build`, then `npm run compile` in the upstream checkout after
changing the editor or service. A package typecheck alone does not check the
workbench contribution. `gulp compile-client` rechecks the workbench/platform
source after a completed extension build.

Manual editor checks: open an existing graph, select/test a function twice,
inspect its logs, fit displaced nodes, collapse the side panels, and reopen the
file. Use a scratch project to verify declaration deletion, undo and rename
propagation without changing the working demo.

## Release boundaries

This is a hardened **local coding workflow**, not a public application hosting
platform or a signed distribution release. Do not interpret a green compiler
result as evidence that an application's data sources, authorization or hosting
are implemented.

- Data-source nodes, effects, authorization/validation guards and higher-order collection callbacks have no complete runtime implementation. They are labeled and refused when reachable. Implementing those integrations is outside this cleanup.
- The server binds to loopback and stores variables in process memory. It does not provide authentication, persistence or production hosting.
- Builds currently require unique `.vi` basenames. Page routes retain their authored relative-link contract; projects with pages in multiple directories need an explicit serving/root arrangement.
- Branch/loop-local results cannot be read outside their execution path. Store shared results in declared variables.
- The IDE compiler and MCP both resolve file-relative calls, but arbitrary graph editing/selected-node context via MCP remains future work.
- Packaging, signing, distribution and cross-platform release qualification were not performed by this source stabilization pass.
