import { posix } from 'node:path';
import {
  ELEMENTS, TEMPLATES as PAGE_TEMPLATES, addNavLink, attributesAt, buildPage, discoverPages, elementAt, insertElement, isTextOnly,
  linksTo, moveElement, relativeHref, removeElement, removeNavLink, setAttribute, setStyle, setText, slugify, templateById,
  EditError,
} from '../../core/src/index.ts';
import { VibezError, type Workspace } from './workspace.ts';

/**
 * Websites made of plain HTML files, the way Aarav's site canvas edits them:
 * every change goes through the same functions, lands in the page's own file,
 * and touches only the element asked for.
 *
 * An element is addressed by where its start tag begins in the file (`@812`),
 * the same number the canvas stamps on it as `data-vz-at`. Read a page with
 * `site_read` to get current numbers; they change as the file changes.
 */

const SKIP_DIRS = /(^|\/)(\.vibez|node_modules|out|dist|build)\//;
const HIDDEN = new Set(['html', 'head', 'meta', 'link', 'base', 'title', 'script', 'style', 'noscript', 'template', 'br', 'wbr']);

export async function htmlFiles(ws: Workspace): Promise<string[]> {
  return (await ws.find(['.html', '.htm'])).filter((f) => !SKIP_DIRS.test(f) && !/__vibez-preview-/.test(f));
}

export async function siteMap(ws: Workspace): Promise<string> {
  const files = await htmlFiles(ws);
  if (!files.length) return 'No HTML pages in this folder. Add one with site_add_page.';
  const texts = new Map<string, string>();
  for (const f of files) texts.set(f, await ws.read(f));
  const map = discoverPages(texts);
  const lines = [`site · ${map.pages.length} pages`, ''];
  for (const page of map.pages) {
    const broken = page.links.filter((l) => l.status === 'unresolved');
    lines.push(`${page.route} · ${page.file} · ${page.links.length} links${broken.length ? ` · ${broken.length} broken` : ''}`);
    for (const link of page.links) {
      const where = link.status === 'resolved' ? `→ ${link.target}` : link.status === 'external' ? `→ ${link.href} (outside)` : `→ ${link.href} (goes nowhere)`;
      lines.push(`  "${decode(link.label)}" ${where} · line ${link.line}`);
    }
  }
  return lines.join('\n');
}

const decode = (text: string): string => text
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

const squash = (text: string, max = 60): string => {
  const flat = decode(text.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** A page as an outline of its visible elements, each with the offset that addresses it. */
export function outlineHtml(file: string, html: string): string {
  const lines = [`page ${file}`, ''];
  const start = /<([a-zA-Z][\w:-]*)\b/g;
  const open: { end: number }[] = [];
  const bodyAt = /<body\b/i.exec(html)?.index ?? 0;
  let count = 0;
  for (let m = start.exec(html); m; m = start.exec(html)) {
    const at = m.index;
    if (at < bodyAt) continue;
    // Skip comments and raw text blocks: elementAt only answers for real tags.
    const el = elementAt(html, at);
    if (!el) continue;
    while (open.length && open[open.length - 1]!.end <= at) open.pop();
    const tag = el.tag;
    if (HIDDEN.has(tag)) {
      if (el.end > el.openEnd) start.lastIndex = Math.max(start.lastIndex, el.end);
      continue;
    }
    const attrs = attributesAt(html, at);
    const idPart = attrs.get('id') ? `#${attrs.get('id')}` : '';
    const classes = (attrs.get('class') ?? '').split(/\s+/).filter((c) => c && !c.startsWith('vz-')).slice(0, 3);
    const classPart = classes.length ? `.${classes.join('.')}` : '';
    const bits: string[] = [];
    const inner = el.closeStart > el.openEnd ? html.slice(el.openEnd, el.closeStart) : '';
    if (!el.isVoid && isTextOnly(html, at) && inner.trim()) bits.push(`"${squash(inner)}"`);
    else if (!el.isVoid && ['a', 'button', 'h1', 'h2', 'h3', 'h4', 'p', 'li', 'label', 'span'].includes(tag) && inner.trim()) bits.push(`"${squash(inner, 48)}"`);
    for (const name of ['href', 'src', 'alt', 'type', 'name', 'placeholder', 'action']) {
      const v = attrs.get(name);
      if (v !== undefined && v !== '') bits.push(`${name}=${JSON.stringify(v.length > 48 ? `${v.slice(0, 47)}…` : v)}`);
    }
    if (attrs.get('style')) bits.push(`style="${attrs.get('style')!.slice(0, 60)}"`);
    lines.push(`${'  '.repeat(open.length)}@${at} <${tag}${idPart}${classPart}>${bits.length ? ` ${bits.join(' ')}` : ''}`);
    count++;
    if (!el.isVoid && el.closeStart >= 0) open.push({ end: el.end });
  }
  if (!count) lines.push('(no visible elements)');
  return lines.join('\n');
}

export type SiteOp =
  | { op: 'text'; at: number; text: string }
  | { op: 'style'; at: number; style: Record<string, string | null> }
  | { op: 'attr'; at: number; name: string; value: string | null }
  | { op: 'remove'; at: number }
  | { op: 'move'; at: number; target: number; where: 'before' | 'after' | 'inside' }
  | { op: 'add'; element: string; target?: number; where?: 'before' | 'after' | 'inside' };

const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'title', 'id', 'class', 'target', 'rel', 'placeholder', 'name', 'type', 'value', 'action', 'method', 'aria-label', 'width', 'height', 'loading']);

/**
 * Apply edits to one page's HTML, all or nothing. Offsets in a batch refer to
 * the file as it was before the batch, so edits are applied from the end of
 * the file backwards: a change near the end never moves an element before it.
 * A move touches two places at once, so it has to be the only edit in its batch.
 */
export function applySiteOps(html: string, ops: SiteOp[]): { html: string; log: string[] } {
  if (ops.some((o) => o.op === 'move') && ops.length > 1) throw new VibezError('A move has to be the only edit in its batch; send it on its own.');
  const removed = new Set(ops.filter((o) => o.op === 'remove').map((o) => (o as { at: number }).at));
  const clash = ops.find((o) => o.op !== 'remove' && 'at' in o && removed.has(o.at));
  if (clash) throw new VibezError(`@${(clash as { at: number }).at} is removed in the same batch, so it cannot also be edited.`);
  const keyOf = (o: SiteOp): number => o.op === 'add' ? (o.target ?? -1) : o.at;
  const order = ops.map((op, i) => ({ op, i })).sort((a, b) => keyOf(b.op) - keyOf(a.op) || a.i - b.i);
  let out = html;
  const log: string[] = [];
  for (const { op, i } of order) {
    try {
      if ('at' in op && !elementAt(out, op.at)) throw new VibezError(`Nothing starts at @${op.at}. Read the page again with site_read for current positions.`);
      const tag = 'at' in op ? elementAt(out, op.at)!.tag : '';
      switch (op.op) {
        case 'text':
          out = setText(out, op.at, op.text);
          log.push(`@${op.at} <${tag}> now says "${squash(op.text)}"`);
          break;
        case 'style':
          out = setStyle(out, op.at, op.style);
          log.push(`@${op.at} <${tag}> style ${Object.entries(op.style).map(([k, v]) => v === null ? `-${k}` : `${k}: ${v}`).join('; ')}`);
          break;
        case 'attr':
          if (!ALLOWED_ATTRS.has(op.name.toLowerCase())) throw new VibezError(`${op.name} cannot be set here. Attributes that can: ${[...ALLOWED_ATTRS].join(', ')}. Use style for looks.`);
          out = setAttribute(out, op.at, op.name, op.value);
          log.push(`@${op.at} <${tag}> ${op.value === null ? `no longer has ${op.name}` : `${op.name}="${op.value}"`}`);
          break;
        case 'remove':
          out = removeElement(out, op.at);
          log.push(`removed <${tag}> at @${op.at} and everything inside it`);
          break;
        case 'move': {
          if (!elementAt(out, op.target)) throw new VibezError(`Nothing starts at @${op.target}.`);
          const moved = moveElement(out, op.at, op.target, op.where);
          out = moved.html;
          log.push(`moved <${tag}> ${op.where} @${op.target}; it now starts at @${moved.at}`);
          break;
        }
        case 'add': {
          const element = ELEMENTS.find((e) => e.id === op.element || e.name.toLowerCase() === op.element.toLowerCase());
          if (!element) throw new VibezError(`There is no "${op.element}" element. Browse them with site_library.`);
          if (op.target !== undefined && !elementAt(out, op.target)) throw new VibezError(`Nothing starts at @${op.target}.`);
          const added = insertElement(out, element.id, op.target ?? null, op.target === undefined ? 'inside' : (op.where ?? 'after'));
          out = added.html;
          log.push(`added ${element.name} (${element.id}) ${op.target === undefined ? 'at the end of the page' : `${op.where ?? 'after'} @${op.target}`}; it starts at @${added.at}`);
          break;
        }
      }
    } catch (error) {
      const message = error instanceof VibezError || error instanceof EditError ? error.message : String(error);
      throw new VibezError(`Edit ${i + 1} (${op.op}) was refused, so nothing was changed: ${message}`);
    }
  }
  return { html: out, log: log.reverse() };
}

/** The page new pages copy their header and footer from: index.html nearest the top, else the first page. */
async function homeOf(ws: Workspace, dir: string): Promise<string | undefined> {
  const files = await htmlFiles(ws);
  const inDir = files.filter((f) => posix.dirname(f) === (dir || '.'));
  return inDir.find((f) => /(^|\/)index\.html?$/.test(f)) ?? inDir[0] ?? files[0];
}

export async function addPage(ws: Workspace, opts: { name: string; template?: string; dir?: string; addToNav?: boolean }): Promise<string> {
  const template = templateById(opts.template ?? 'blank');
  if (!template) throw new VibezError(`There is no "${opts.template}" template. Templates: ${PAGE_TEMPLATES.map((t) => t.id).join(', ')}.`);
  const dir = (opts.dir ?? '').replace(/^\.\/?|\/$/g, '');
  const slug = slugify(opts.name);
  if (!slug) throw new VibezError('Give the page a name with at least one letter or number.');
  const file = posix.join(dir || '.', `${slug}.html`).replace(/^\.\//, '');
  if (await ws.exists(file)) throw new VibezError(`${file} already exists.`);
  const home = await homeOf(ws, dir);
  const shell = home ? await ws.read(home) : null;
  const built = buildPage(template, opts.name, shell);
  const log = [`created ${file} from the ${template.name} template${home ? `, with the header and footer of ${home}` : ''}`];
  const writes: [string, string][] = [[file, built.html]];
  if (opts.addToNav !== false) {
    for (const page of [...(await htmlFiles(ws)), file]) {
      const html = page === file ? built.html : await ws.read(page);
      const next = addNavLink(html, relativeHref(page, file), opts.name.trim());
      if (next !== null) {
        const at = writes.findIndex(([f]) => f === page);
        if (at >= 0) writes[at] = [page, next]; else writes.push([page, next]);
        log.push(`linked it from the navigation of ${page}`);
      }
    }
  }
  for (const [f, text] of writes) await ws.write(f, text);
  return log.join('\n');
}

export async function deletePage(ws: Workspace, file: string): Promise<string> {
  if (!/\.html?$/.test(file)) throw new VibezError(`${file} is not an HTML page.`);
  const text = await ws.read(file);
  const home = await homeOf(ws, posix.dirname(file) === '.' ? '' : posix.dirname(file));
  if (home === file) throw new VibezError(`${file} is the page new pages copy their header and footer from, so it cannot be deleted.`);
  const log: string[] = [];
  const writes: [string, string][] = [];
  let elsewhere = 0;
  for (const page of (await htmlFiles(ws)).filter((f) => f !== file)) {
    const html = await ws.read(page);
    const href = relativeHref(page, file);
    const next = removeNavLink(html, href);
    if (next !== null) {
      writes.push([page, next]);
      log.push(`took its link out of the navigation of ${page}`);
    }
    elsewhere += linksTo(next ?? html, href);
  }
  // Kept rather than destroyed, so a mistaken delete can be recovered.
  const kept = `.vibez/trash/${Date.now()}-${posix.basename(file)}`;
  await ws.write(kept, text);
  await ws.remove(file);
  for (const [f, t] of writes) await ws.write(f, t);
  log.unshift(`deleted ${file} (a copy is kept at ${kept})`);
  if (elsewhere) log.push(`${elsewhere} link${elsewhere > 1 ? 's' : ''} elsewhere in the content still point to it`);
  return log.join('\n');
}

export function library(): string {
  const lines = ['elements (for site_edit add):'];
  let group = '';
  for (const e of ELEMENTS) {
    if (e.group !== group) {
      group = e.group;
      lines.push(`  ${group}:`);
    }
    lines.push(`    ${e.id} · ${e.name} · ${e.description}`);
  }
  lines.push('', 'page templates (for site_add_page):');
  for (const t of PAGE_TEMPLATES) lines.push(`  ${t.id} · ${t.name} · ${t.description}`);
  return lines.join('\n');
}
