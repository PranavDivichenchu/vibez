import { build } from 'esbuild';

/**
 * The 1.99 extension host is Node 20 CommonJS: no type stripping, no ESM
 * extensions. So the extension and its workspace deps become one CJS file.
 * `vscode` is provided by the host and must stay external.
 */
const result = await build({
  entryPoints: ['packages/vibez-core/src/extension.ts'],
  outfile: 'packages/vibez-core/dist/extension.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode', 'node:sqlite'],
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`  bundled extension.js  ${(bytes / 1024).toFixed(0)} kB`);
