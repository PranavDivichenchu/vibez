/**
 * Edits made on the site canvas, written back into the page's HTML file.
 *
 * Every element the canvas shows from a file carries `data-vz-at`: the offset
 * of its start tag in that file (see `annotateHtml`). These functions take the
 * file's text and that offset and return the new text. They touch only the
 * element asked for, keep the rest of the file byte for byte, and refuse
 * rather than guess when the file no longer matches what the page showed.
 *
 * Pure and isomorphic, so the same code runs in tests and in the editor.
 */

export interface ElementRange {
  tag: string;
  /** Offset of `<` of the start tag. */
  start: number;
  /** Offset just past the start tag's `>`. */
  openEnd: number;
  /** Offset of the end tag's `<`; equals `openEnd` for void elements; -1 when the end tag is implied. */
  closeStart: number;
  /** Offset just past the end tag (or the start tag, for void elements). */
  end: number;
  isVoid: boolean;
}

export class EditError extends Error {}

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'textarea', 'title']);
const START = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
const ATTR = /(\s+)([^\s"'>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/** The element whose start tag begins at `at`, with its end tag found by nesting. */
export function elementAt(html: string, at: number): ElementRange | null {
  START.lastIndex = at;
  const m = START.exec(html);
  if (!m || m.index !== at) { return null; }
  const tag = m[1]!.toLowerCase();
  const openEnd = at + m[0].length;
  if (VOID.has(tag) || m[3]) {
    return { tag, start: at, openEnd, closeStart: openEnd, end: openEnd, isVoid: true };
  }
  const lower = html.toLowerCase();
  if (RAW.has(tag)) {
    const close = lower.indexOf(`</${tag}`, openEnd);
    if (close < 0) { return { tag, start: at, openEnd, closeStart: -1, end: openEnd, isVoid: false }; }
    const gt = html.indexOf('>', close);
    return { tag, start: at, openEnd, closeStart: close, end: gt + 1, isVoid: false };
  }
  let depth = 1;
  const scan = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)\b(?:"[^"]*"|'[^']*'|[^'">])*>/g;
  scan.lastIndex = openEnd;
  for (let t = scan.exec(html); t; t = scan.exec(html)) {
    if (!t[2]) { continue; }
    const name = t[2].toLowerCase();
    if (!t[1] && RAW.has(name)) {
      const close = lower.indexOf(`</${name}`, t.index + t[0].length);
      if (close < 0) { break; }
      scan.lastIndex = close;
      continue;
    }
    if (name !== tag) { continue; }
    if (t[1]) {
      if (--depth === 0) { return { tag, start: at, openEnd, closeStart: t.index, end: t.index + t[0].length, isVoid: false }; }
    } else if (!/\/>$/.test(t[0])) {
      depth++;
    }
  }
  return { tag, start: at, openEnd, closeStart: -1, end: openEnd, isVoid: false };
}

/** Finds the element and checks it is the one the page showed. */
function expect(html: string, at: number, tag?: string): ElementRange {
  const el = elementAt(html, at);
  if (!el || (tag && el.tag !== tag.toLowerCase())) {
    throw new EditError('The file has changed since this page was loaded. Reload the page and try again.');
  }
  return el;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function unescapeAttr(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** The attributes of the start tag at `at`, as written. */
export function attributesAt(html: string, at: number, tag?: string): Map<string, string> {
  const el = expect(html, at, tag);
  const open = html.slice(el.start, el.openEnd);
  const body = open.replace(/^<[a-zA-Z][\w:-]*/, '').replace(/\s*\/?>$/, '');
  const out = new Map<string, string>();
  for (const m of body.matchAll(ATTR)) {
    const raw = m[4] ?? '';
    out.set(m[2]!.toLowerCase(), unescapeAttr(raw.replace(/^["']|["']$/g, '')));
  }
  return out;
}

/** Sets (or, with null, removes) one attribute on the element's start tag. */
export function setAttribute(html: string, at: number, name: string, value: string | null, tag?: string): string {
  const el = expect(html, at, tag);
  const open = html.slice(el.start, el.openEnd);
  const head = /^<[a-zA-Z][\w:-]*/.exec(open)![0];
  const tail = /\s*\/?>$/.exec(open)![0];
  let body = open.slice(head.length, open.length - tail.length);
  let found = false;
  body = body.replace(ATTR, (all, space: string, attr: string) => {
    if (attr.toLowerCase() !== name.toLowerCase()) { return all; }
    found = true;
    return value === null ? '' : `${space}${attr}="${escapeAttr(value)}"`;
  });
  if (!found && value !== null) { body += ` ${name}="${escapeAttr(value)}"`; }
  return html.slice(0, el.start) + head + body + tail + html.slice(el.openEnd);
}

export function parseStyle(style: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of style.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) { continue; }
    const prop = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (prop && value) { out.set(prop, value); }
  }
  return out;
}

export function serializeStyle(style: ReadonlyMap<string, string>): string {
  return [...style].map(([p, v]) => `${p}: ${v}`).join('; ');
}

/**
 * Changes the inline style of that one element: each property is set, or
 * removed when its value is null or empty. Other declarations are kept in
 * their order. The `style` attribute disappears when nothing is left.
 */
export function setStyle(html: string, at: number, props: Readonly<Record<string, string | null>>, tag?: string): string {
  const style = parseStyle(attributesAt(html, at, tag).get('style') ?? '');
  for (const [prop, value] of Object.entries(props)) {
    const key = prop.trim().replace(/[A-Z]/g, c => '-' + c.toLowerCase()).toLowerCase();
    if (!/^-?[a-z][a-z0-9-]*$/.test(key)) { throw new EditError(`“${prop}” is not a style property.`); }
    // Double quotes become single so the attribute stays readable: font-family: 'Helvetica Neue'.
    const v = value === null ? '' : String(value).replace(/[;{}<>]/g, '').replace(/"/g, "'").trim();
    if (v) { style.set(key, v); } else { style.delete(key); }
  }
  return setAttribute(html, at, 'style', style.size ? serializeStyle(style) : null, tag);
}

/** Whether the element holds only text in the file (no tags inside), so its words can be replaced. */
export function isTextOnly(html: string, at: number, tag?: string): boolean {
  const el = expect(html, at, tag);
  return !el.isVoid && el.closeStart >= 0 && !RAW.has(el.tag) && !/<[a-zA-Z!/]/.test(html.slice(el.openEnd, el.closeStart));
}

/** Replaces the words inside a text-only element, keeping the whitespace around them. */
export function setText(html: string, at: number, text: string, tag?: string): string {
  const el = expect(html, at, tag);
  if (!isTextOnly(html, at, tag)) { throw new EditError('This element has other elements inside it, so its text is edited on those instead.'); }
  const inner = html.slice(el.openEnd, el.closeStart);
  const lead = /^\s*/.exec(inner)![0];
  const trail = /\s*$/.exec(inner.slice(lead.length))![0];
  return html.slice(0, el.openEnd) + lead + escapeHtml(text.trim()) + trail + html.slice(el.closeStart);
}

function lineStart(html: string, at: number): number { return html.lastIndexOf('\n', at - 1) + 1; }
function lineEnd(html: string, at: number): number { const n = html.indexOf('\n', at); return n < 0 ? html.length : n; }

/** True when the range is alone on its line(s): only whitespace before it and after it. */
function ownLines(html: string, start: number, end: number): boolean {
  return html.slice(lineStart(html, start), start).trim() === '' && html.slice(end, lineEnd(html, end)).trim() === '';
}

/**
 * Moves an element to just before or after another one, or (`inside`) to
 * the end of another one, as its last child.
 *
 * When both sit on lines of their own, whole lines move and the moved block
 * takes the new neighbour's indentation. Otherwise the element moves inline,
 * separated by a space, which is how siblings on one line are usually written.
 * Returns the new text and the moved element's new offset.
 */
export function moveElement(html: string, at: number, target: number, where: 'before' | 'after' | 'inside', tag?: string, targetTag?: string): { html: string; at: number } {
  const el = expect(html, at, tag);
  const t = expect(html, target, targetTag);
  if (el.closeStart < 0 || el.end <= el.start) { throw new EditError('Could not find where this element ends in the file.'); }
  if (!t.isVoid && t.closeStart < 0 && where !== 'before') { throw new EditError('Could not find where the drop target ends in the file.'); }
  if (where === 'inside' && (t.isVoid || RAW.has(t.tag))) { throw new EditError(`Nothing can be put inside <${t.tag}>.`); }
  if (t.start >= el.start && t.start < el.end) { throw new EditError('An element cannot be moved inside itself.'); }

  const block = ownLines(html, el.start, el.end);
  const cutStart = block ? lineStart(html, el.start) : el.start;
  const cutEnd = block ? Math.min(html.length, lineEnd(html, el.end) + 1) : el.end;
  const oldIndent = /^[ \t]*/.exec(html.slice(lineStart(html, el.start)))![0];
  let piece = html.slice(el.start, el.end);

  let rest = html.slice(0, cutStart) + html.slice(cutEnd);
  const shift = (pos: number) => pos >= cutEnd ? pos - (cutEnd - cutStart) : pos;
  const tStart = shift(t.start);
  const tEnd = shift(t.end);

  // Inline removal can leave a doubled space behind.
  let dropped = -1;
  if (!block) {
    const before = rest.slice(lineStart(rest, cutStart), cutStart);
    const next = rest[cutStart] ?? '\n';
    if (before.endsWith(' ') && (next === ' ' || next === '\n' || next === '\r' || rest.startsWith('</', cutStart))) {
      rest = rest.slice(0, cutStart - 1) + rest.slice(cutStart);
      dropped = cutStart - 1;
    } else if (next === ' ' && (before.trim() === '' || /<[a-zA-Z][^>]*>$/.test(before))) {
      rest = rest.slice(0, cutStart) + rest.slice(cutStart + 1);
      dropped = cutStart;
    }
  }
  const adjust = (pos: number) => dropped >= 0 && pos > dropped ? pos - 1 : pos;
  const ts = adjust(tStart);
  const te = adjust(tEnd);

  if (where === 'inside') {
    // Last child of the target: on a line of its own when the end tag has one.
    const close = adjust(shift(t.closeStart));
    const open = adjust(shift(t.openEnd));
    if (rest.slice(lineStart(rest, close), close).trim() === '') {
      const closeIndent = /^[ \t]*/.exec(rest.slice(lineStart(rest, close)))![0];
      const firstChild = /\n([ \t]*)\S/.exec(rest.slice(open, close));
      const indent = firstChild && firstChild[1]!.length > closeIndent.length ? firstChild[1]! : closeIndent + '  ';
      piece = piece.split('\n').map((l, i) => i === 0 ? l : (l.startsWith(oldIndent) ? indent + l.slice(oldIndent.length) : l)).join('\n');
      const pos = lineStart(rest, close);
      const glue = rest[pos - 1] === '\n' || pos === 0 ? '' : '\n';
      return { html: rest.slice(0, pos) + glue + indent + piece + '\n' + rest.slice(pos), at: pos + glue.length + indent.length };
    }
    const space = open < close && !/\s$/.test(rest.slice(0, close)) ? ' ' : '';
    return { html: rest.slice(0, close) + space + piece + rest.slice(close), at: close + space.length };
  }

  if (ownLines(rest, ts, te)) {
    const indent = /^[ \t]*/.exec(rest.slice(lineStart(rest, ts)))![0];
    piece = piece.split('\n').map((l, i) => i === 0 ? l : (l.startsWith(oldIndent) ? indent + l.slice(oldIndent.length) : l)).join('\n');
    if (where === 'before') {
      const pos = lineStart(rest, ts);
      return { html: rest.slice(0, pos) + indent + piece + '\n' + rest.slice(pos), at: pos + indent.length };
    }
    const endOfLine = lineEnd(rest, te);
    const pos = endOfLine < rest.length ? endOfLine + 1 : endOfLine;
    const glue = endOfLine < rest.length ? '' : '\n';
    return { html: rest.slice(0, pos) + glue + indent + piece + '\n' + rest.slice(pos), at: pos + glue.length + indent.length };
  }
  if (where === 'before') {
    return { html: rest.slice(0, ts) + piece + ' ' + rest.slice(ts), at: ts };
  }
  return { html: rest.slice(0, te) + ' ' + piece + rest.slice(te), at: te + 1 };
}
