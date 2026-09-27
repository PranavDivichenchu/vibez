import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoc, renderDoc, themeById } from '../src/index.ts';
import { readableColor } from '../src/render.ts';

test('text stays readable on the background it sits on', () => {
  const theme = themeById('clean');
  assert.equal(readableColor(theme, 'accent', 'accent'), theme.colors.inverse, 'accent words on an accent chip turn white');
  assert.equal(readableColor(theme, 'accent', 'accentSoft'), theme.colors.accent, 'accent on its soft tint already reads');
  assert.equal(readableColor(theme, 'muted', 'surface'), theme.colors.muted);
  assert.equal(readableColor(theme, 'inverse', 'surface'), theme.colors.text, 'white on white turns dark');
  const parsed = parseDoc(JSON.stringify({ vibez: 'vibez.ui/1', name: 'P', route: '/', theme: 'clean', links: [], root: {
    id: 'page', kind: 'frame', size: { w: { mode: 'fill' }, h: { mode: 'hug' } }, layout: { direction: 'column', gap: 'md', padding: 'md', align: 'stretch', justify: 'start' }, fill: null, radius: 'none', border: false, shadow: 'none', name: 'Page',
    children: [{ id: 'chip', kind: 'frame', size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, layout: { direction: 'row', gap: 'xs', padding: 'sm', align: 'center', justify: 'start' }, fill: 'accent', radius: 'full', border: false, shadow: 'none', name: 'Chip',
      children: [{ id: 'word', kind: 'text', size: { w: { mode: 'hug' }, h: { mode: 'hug' } }, text: 'Pro', variant: 'label', align: 'start', color: 'accent' }] }],
  } }));
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  const tree = renderDoc(parsed.doc, { mode: 'design', scope: { linked: new Map(), inputs: {} } });
  const word = tree.children[0]!.children[0]!;
  assert.equal(word.style['color'], theme.colors.inverse);
});
