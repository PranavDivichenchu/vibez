import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { compile, parseDoc, parseViExports, type Linked } from '../packages/ui/src/index.ts';

/**
 * Compile `.ui` pages to HTML from the command line: the same compiler the
 * editor runs on every save.
 *
 *   npm run ui:build -- examples/shop/pages/dashboard.ui [out-dir]
 */
const [file, outDir] = process.argv.slice(2);
if (!file) {
  console.error('  usage: npm run ui:build -- <page.ui> [out-dir]');
  process.exit(1);
}
const parsed = parseDoc(readFileSync(file, 'utf8'), basename(file, '.ui'));
if (!parsed.ok) {
  console.error(`  ${file}: ${parsed.reason}`);
  process.exit(1);
}
const linked: Linked = new Map();
for (const link of parsed.doc.links) {
  try {
    linked.set(link, parseViExports(readFileSync(resolve(dirname(file), link), 'utf8')));
  } catch {
    console.warn(`  ${link} is linked but could not be read; its values will be empty`);
  }
}
const out = outDir ?? join(dirname(file), '..', '.vibez', 'build');
mkdirSync(out, { recursive: true });
const target = join(out, `${basename(file, '.ui')}.html`);
writeFileSync(target, compile(parsed.doc, { linked }));
console.log(`  ${target}`);
