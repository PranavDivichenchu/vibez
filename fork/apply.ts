import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Applies the Vibez overlay onto a Code - OSS checkout.
 *
 * product.json is MERGED, never replaced: upstream adds keys constantly and
 * replacing the file wholesale is how a fork quietly loses features.
 */
const root = process.cwd();
const vscodeDir = join(root, 'vscode');
if (!existsSync(vscodeDir)) {
  console.error('  vscode/ is missing. Run: npm run fork:setup');
  process.exit(1);
}

const productPath = join(vscodeDir, 'product.json');
const upstream = JSON.parse(readFileSync(productPath, 'utf8')) as Record<string, unknown>;
const overlay = JSON.parse(readFileSync(join(root, 'fork/overlay/product.json'), 'utf8')) as Record<string, unknown>;

const before = JSON.stringify(upstream);
const merged = { ...upstream, ...overlay };
writeFileSync(productPath, `${JSON.stringify(merged, null, '\t')}\n`);
const changed = Object.keys(overlay).filter((k) => JSON.stringify(upstream[k]) !== JSON.stringify(overlay[k]));
console.log(`  product.json: ${changed.length} keys set${before === JSON.stringify(merged) ? ' (no change)' : ''}`);

// The extension ships as a built-in, which is the whole point of forking:
// it is present on first launch rather than something the user installs.
const target = join(vscodeDir, 'extensions', 'vibez-core');
mkdirSync(target, { recursive: true });
cpSync(join(root, 'packages/vibez-core/dist'), join(target, 'dist'), { recursive: true });
cpSync(join(root, 'packages/vibez-core/webview'), join(target, 'webview'), { recursive: true });

const manifest = JSON.parse(readFileSync(join(root, 'packages/vibez-core/package.json'), 'utf8')) as Record<string, unknown>;
writeFileSync(join(target, 'package.json'), `${JSON.stringify({
  ...manifest,
  type: 'commonjs',          // the 1.99 host predates type stripping and ESM extensions
  main: './dist/extension.js',
  scripts: undefined,
}, null, 2)}\n`);

console.log(`  bundled vibez-core -> vscode/extensions/vibez-core`);
console.log('\n  next: npm run fork:run\n');
