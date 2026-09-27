import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCanvasEdit, blankDoc, compile, find, insert, updateDoc, themeById, themeChoices, CATALOG, makeId, allIds,
  type FrameNode, type TextNode, type UiDoc, type UiNode,
} from '../src/index.ts';
import { annotateHtml } from '../../core/src/pages.ts';

// A title, a paragraph and a card, on the Clean theme.
function page(): { doc: UiDoc; title: string; text: string; card: string } {
  let doc = blankDoc('Home');
  const add = (label: string): string => {
    const node = CATALOG.find((e) => e.label === label)!.make((k) => makeId(k, allIds(doc)));
    doc = insert(doc, 'page', 999, node);
    return node.id;
  };
  return { title: add('Title'), text: add('Text'), card: add('Card'), doc };
}

const html = (doc: UiDoc): string => compile(doc, { linked: new Map() });

// A style edit exactly as the site canvas sends it: against the page as it now stands.
function style(doc: UiDoc, id: string, props: Record<string, string | null>): UiDoc {
  const compiled = html(doc);
  const at = Number(new RegExp(`data-vz-node="${id}"[^>]*data-vz-at="(\\d+)"`).exec(annotateHtml(compiled))![1]);
  const r = applyCanvasEdit(doc, compiled, at, [{ op: 'style', props }]);
  assert.ok(r.ok, !r.ok ? r.reason : '');
  return r.doc;
}

const node = <T extends UiNode>(doc: UiDoc, id: string): T => find(doc, id)!.node as T;
const clean = themeById('clean');

test("the theme's own colour becomes the token, however it is written", () => {
  const { doc, title } = page();
  for (const written of ['#3d63dd', '#3D63DD', 'rgb(61, 99, 221)', 'rgba(61,99,221,1)']) {
    const after = style(doc, title, { color: written });
    assert.equal(node<TextNode>(after, title).color, 'accent', written);
    assert.equal(node(after, title).css, undefined, written);
  }
  // The compiled page draws the theme's accent, from the token, not from CSS.
  const after = style(doc, title, { color: '#3d63dd' });
  assert.match(html(after), new RegExp(`color:${clean.colors.accent}`));
  assert.doesNotMatch(html(after), /color:#3d63dd/);
});

test('a colour a hair off the theme snaps to it; a different colour stays CSS', () => {
  const { doc, title } = page();
  // #3E64DC is one step off the accent in each channel: the same blue to the eye.
  let after = style(doc, title, { color: '#3E64DC' });
  assert.equal(node<TextNode>(after, title).color, 'accent');
  assert.equal(node(after, title).css, undefined);
  // A purple is not the accent, and not any other theme colour.
  after = style(doc, title, { color: '#8A3DDD' });
  assert.equal(node<TextNode>(after, title).color, 'text');
  assert.deepEqual(node(after, title).css, { color: '#8A3DDD' });
  // Something see-through is never a theme colour.
  after = style(doc, title, { color: 'rgba(61, 99, 221, 0.5)' });
  assert.deepEqual(node(after, title).css, { color: 'rgba(61, 99, 221, 0.5)' });
});

test('mapping to a token takes the old CSS for that property off the element', () => {
  const { doc, title } = page();
  let after = style(doc, title, { color: '#8A3DDD', left: '4px' });
  assert.deepEqual(node(after, title).css, { color: '#8A3DDD', left: '4px' });
  after = style(after, title, { color: clean.colors.danger });
  assert.equal(node<TextNode>(after, title).color, 'danger');
  assert.deepEqual(node(after, title).css, { left: '4px' });
});

test('text in a colour its token would not be drawn in stays CSS', () => {
  const { doc, title } = page();
  // The page colour on the page: as a token, render.ts would swap it for
  // readable text, so the colour that was picked would not show.
  const after = style(doc, title, { color: clean.colors.page });
  assert.equal(node<TextNode>(after, title).color, 'text');
  assert.deepEqual(node(after, title).css, { color: clean.colors.page });
});

test("a card's background, padding, gap, radius and shadow map onto the theme's steps", () => {
  const { doc, card } = page();
  let after = style(doc, card, {
    'background-color': 'rgb(230, 236, 252)', padding: '16px', gap: '4px', 'border-radius': '10px', 'box-shadow': clean.shadow.lifted,
  });
  const c = node<FrameNode>(after, card);
  assert.equal(c.fill, 'accentSoft');
  assert.equal(c.layout.padding, 'md');
  assert.equal(c.layout.gap, 'xs');
  assert.equal(c.radius, 'md');
  assert.equal(c.shadow, 'lifted');
  assert.equal(c.css, undefined);
  // A size between steps, or in other units, is kept as it was given.
  after = style(after, card, { padding: '17px', gap: '1rem', 'border-radius': '11px' });
  assert.deepEqual(node(after, card).css, { padding: '17px', gap: '1rem', 'border-radius': '11px' });
  assert.equal(node<FrameNode>(after, card).layout.padding, 'md');
  // Back on a step, each one leaves CSS again. `0` is the `none` step.
  after = style(after, card, { padding: '0', gap: '24px', 'border-radius': '0px', background: 'transparent' });
  const d = node<FrameNode>(after, card);
  assert.deepEqual([d.layout.padding, d.layout.gap, d.radius, d.fill, d.css], ['none', 'lg', 'none', null, undefined]);
});

test('drag and nudge positions, margins and sizes stay CSS exactly as before', () => {
  const { doc, card, title } = page();
  const props = { position: 'relative', left: '12px', top: '-3px', 'margin-top': '16px', width: '240px' };
  assert.deepEqual(node(style(doc, card, props), card).css, props);
  assert.deepEqual(node(style(doc, title, props), title).css, props);
});

test('a font size is only dropped when the text already draws at it', () => {
  const { doc, text } = page();
  // Body text is 15px in Clean: the CSS would change nothing, so none is kept.
  let after = style(doc, text, { 'font-size': '15px' });
  assert.equal(node(after, text).css, undefined);
  assert.equal(node<TextNode>(after, text).variant, 'body');
  // 13px is the caption size, but a caption is more than a size: kept as CSS.
  after = style(doc, text, { 'font-size': '13px' });
  assert.deepEqual(node(after, text).css, { 'font-size': '13px' });
  assert.equal(node<TextNode>(after, text).variant, 'body');
});

test('clearing a style clears it whether it was a token or CSS', () => {
  const { doc, title, card } = page();
  // Kept as a token: clearing puts the title back to its catalog colour.
  let after = style(doc, title, { color: clean.colors.accent });
  assert.equal(node<TextNode>(after, title).color, 'accent');
  after = style(after, title, { color: null });
  assert.equal(node<TextNode>(after, title).color, 'text');
  // A card goes back to being a card, not a bare stack.
  after = style(after, card, { padding: '8px', background: clean.colors.raised, 'border-radius': '6px', 'box-shadow': 'none' });
  after = style(after, card, { padding: '', background: null, 'border-radius': null, 'box-shadow': null });
  const c = node<FrameNode>(after, card);
  assert.deepEqual([c.layout.padding, c.fill, c.radius, c.shadow], ['lg', 'surface', 'lg', 'soft']);
  // Kept as CSS: clearing only takes the CSS off, and the token under it shows again.
  after = style(after, title, { color: clean.colors.success });
  after = style(after, title, { color: '#8A3DDD' });
  assert.equal(node<TextNode>(after, title).color, 'success');
  after = style(after, title, { color: null });
  assert.equal(node<TextNode>(after, title).color, 'success');
  assert.equal(node(after, title).css, undefined);
});

test('switching the theme afterwards re-colours an element styled on the canvas', () => {
  const { doc, title, card } = page();
  let after = style(doc, title, { color: clean.colors.accent });
  after = style(after, card, { background: clean.colors.accentSoft });
  const dark = updateDoc(after, { theme: 'midnight' });
  const midnight = themeById('midnight');
  const out = html(dark);
  assert.match(out, new RegExp(`color:${midnight.colors.accent}`));
  assert.match(out, new RegExp(`background:${midnight.colors.accentSoft}`));
  assert.doesNotMatch(out, new RegExp(clean.colors.accent));
  assert.doesNotMatch(out, new RegExp(clean.colors.accentSoft));
});

test("themeChoices lists the page theme's palette and steps", () => {
  const doc = updateDoc(blankDoc('Home'), { theme: 'paper' });
  const paper = themeById('paper');
  const choices = themeChoices(doc);
  assert.equal(choices.theme, 'paper');
  assert.equal(choices.colors.length, 10);
  assert.deepEqual(choices.colors.find((c) => c.token === 'accent'), { token: 'accent', label: 'Accent', value: paper.colors.accent });
  assert.deepEqual(choices.space.map((s) => s.token), ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl']);
  assert.deepEqual(choices.radius.find((r) => r.token === 'md'), { token: 'md', value: '6px' });
  // Every swatch it offers maps back onto a token when picked for a fill.
  const { doc: home, card } = page();
  const on = updateDoc(home, { theme: 'paper' });
  for (const swatch of choices.colors) {
    const fill = node<FrameNode>(style(on, card, { background: swatch.value }), card).fill;
    assert.equal(paper.colors[fill!], swatch.value, swatch.token);
  }
});
