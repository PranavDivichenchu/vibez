# The fork

Vibez is a fork of Code – OSS, but the fork is deliberately almost empty.

Everything that makes Vibez what it is lives in `packages/vibez-core`, an
ordinary VS Code extension that the fork ships as a built-in. The fork itself
carries branding and defaults, nothing else.

## Why so little

Every line of divergence from upstream is a merge tax paid every month,
forever. The budget is **2000 lines against upstream**, measured by
`npm run fork:diff`. If a feature seems to need core changes, the first
question is whether the extension API can do it instead.

Cursor and Windsurf forked for real reasons: control of the welcome screen,
defaults, branding, first-run, and the ability to make a surface first-class
rather than a webview guest. Those are the only reasons that justify the tax.

## Layout

```
fork/
  pinned.json          which upstream tag we track
  overlay/
    product.json       merged into upstream's product.json, never replacing it
  apply.ts             copies the overlay in and bundles the extension
~/.vibez/vscode        the clone. Outside the repo, and here is why:
```

**The checkout must live at a path with no spaces.** node-gyp does not quote
paths, so a single space anywhere above the checkout breaks every native module
build with a confusing `clang++: no such file or directory` pointing at half a
path. This repo lives under `georgia tech`, so the default is `~/.vibez/vscode`.
Override with `VIBEZ_FORK_DIR`; the scripts refuse a path containing a space
rather than letting you discover it twenty minutes into a build.

## Commands

```bash
npm run fork:setup     clone Code - OSS at the pinned tag
npm run fork:build     bundle vibez-core, apply the overlay
npm run fork:diff      measure the divergence against upstream
npm run fork:run       launch the built fork from source
```

`fork:setup` needs roughly 5 GB free once upstream's dependencies are installed,
and upstream's own install takes a while the first time.

## Known constraint at the pinned tag

The 1.99.x extension host runs Node 20.18, which has neither `node:sqlite` nor
TypeScript type stripping. Two consequences:

- The extension is bundled to CommonJS by esbuild rather than run as source.
- `SpanStore` degrades to an in-memory driver, so traces do not survive a
  restart. `store.durable` reports which mode it is in.

Both go away on an Electron carrying Node 22.
