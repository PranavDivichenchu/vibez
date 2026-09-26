# Code – OSS integration

Vibez's editors are native workbench contributions, not a bundled extension.
The pinned upstream checkout lives at `~/.vibez/vscode` by default. Override it
with `VIBEZ_FORK_DIR`; the setup scripts require a path without spaces for native builds.

`fork/overlay/product.json` supplies branding. `fork/contrib` contains the
workbench editor, renderer service and main-process service overlays.
`scripts/sync-core.ts` copies the isomorphic package implementations into the
platform layer and rewrites their imports for the upstream build. Edit package
sources here, not their generated copies in the checkout.

```bash
npm run fork:setup
npm run fork:build
(cd ~/.vibez/vscode && npm run compile)
npm run fork:run -- /path/to/project
npm run fork:diff
```

`fork:build` applies the overlay and syncs contributions; it does not compile
Electron. `fork:run` removes `ELECTRON_RUN_AS_NODE` from the launch environment
and forwards its arguments to the upstream launcher.

Keep upstream modifications small. Workbench and desktop registration are
applied by the sync script. The existing `app.ts` main-process service/channel
registration is maintained in the checkout; inspect `scripts/sync-contrib.ts`
and `vibezCaptureMainService.ts` when updating the pinned upstream version.

The pinned 1.99.x Electron embeds Node 20, while repository tools need Node
22.18+. Generated logic is plain JavaScript and explicitly uses ESM metadata.
Trace storage falls back to memory if `node:sqlite` is unavailable.
