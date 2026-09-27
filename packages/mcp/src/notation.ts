import type { ActionRef, FrameNode, UiDoc, UiNode, ValueRef, ViExports, Linked } from '../../ui/src/index.ts';
import { asText, resolve, NAMES } from '../../ui/src/index.ts';
import { VibezError } from './workspace.ts';

/**
 * How Vibez is written down for an agent.
 *
 * A page is shown as an outline, one element per line, with its id first so
 * the agent can point at it, and only the settings that differ from the
 * element's defaults. Links read the way they are written back:
 *
 *   dashboard.vi#orders          a value from a .vi file
 *   dashboard.vi#plan.tier       one field of it
 *   item.customer                a field of the current item, inside a repeat
 *   input.email                  what was typed into the input saved as email
 *   dashboard.vi#inviteTeammate  an action, for a button
 *   answer:orders.vi#place       what that action answered the last time it ran
 *   go:gallery.ui                go to another page
 *
 * The same strings go in and come out, so what an agent reads is exactly what
 * it can write.
 */

// ------------------------------------------------------------ references

export function formatValue(ref: ValueRef): string {
  switch (ref.from) {
    case 'vi': return `${ref.file}#${ref.name}${ref.field ? `.${ref.field}` : ''}`;
    case 'item': return ref.field ? `item.${ref.field}` : 'item';
    case 'input': return `input.${ref.name}`;
    case 'answer': return `answer:${ref.file}#${ref.name}${ref.field ? `.${ref.field}` : ''}`;
  }
}

export function parseValue(text: string): ValueRef {
  const s = text.trim();
  if (s === 'item') return { from: 'item' };
  if (s.startsWith('item.')) return { from: 'item', field: s.slice(5) };
  if (s.startsWith('input.')) return { from: 'input', name: s.slice(6) };
  // What an action answered, so a page can show the result of a button press.
  const answer = s.startsWith('answer:');
  const body = answer ? s.slice(7).trim() : s;
  const hash = body.indexOf('#');
  if (hash > 0) {
    const file = body.slice(0, hash);
    const [name, ...field] = body.slice(hash + 1).split('.');
    if (!file.endsWith('.vi') || !name) throw new VibezError(`"${text}" is not a value. Write it like dashboard.vi#orders or dashboard.vi#plan.tier.`);
    const from = answer ? 'answer' as const : 'vi' as const;
    return field.length ? { from, file, name, field: field.join('.') } : { from, file, name };
  }
  throw new VibezError(`"${text}" is not a value. Use file.vi#name, file.vi#name.field, answer:file.vi#action, item.field or input.name.`);
}

export function formatAction(ref: ActionRef): string {
  if (ref.run === 'navigate') return `go:${ref.to}`;
  const args = Object.entries(ref.args ?? {});
  return `${ref.file}#${ref.name}${args.length ? `(${args.map(([k, v]) => `${k} ← ${formatValue(v)}`).join(', ')})` : ''}`;
}

export function parseAction(text: string): ActionRef {
  const s = text.trim();
  if (s.startsWith('go:')) return { run: 'navigate', to: s.slice(3).trim() };
  const hash = s.indexOf('#');
  if (hash > 0 && s.slice(0, hash).endsWith('.vi')) return { run: 'vi', file: s.slice(0, hash), name: s.slice(hash + 1).replace(/\(.*$/, '') };
  throw new VibezError(`"${text}" is not an action. Write it like dashboard.vi#inviteTeammate, or go:other.ui for a link to a page.`);
}

// ------------------------------------------------------------ pages

const quote = (text: string, max = 48): string => {
  const flat = text.replace(/\s+/g, ' ');
  return JSON.stringify(flat.length > max ? `${flat.slice(0, max - 1)}…` : flat);
};

const sample = (value: unknown): string => {
  if (Array.isArray(value)) return `${value.length} items`;
  const text = asText(value);
  return text === undefined ? '' : quote(text, 32);
};

function sizeWords(node: UiNode, parent: FrameNode | undefined): string | undefined {
  if (!parent) return undefined;
  const word = (s: UiNode['size']['w']) => s.mode === 'fixed' ? `${s.px}px` : s.mode === 'fill' ? 'fill' : 'fit';
  const w = word(node.size.w);
  const h = word(node.size.h);
  // The usual sizes go unsaid: full width and fitted height for most things.
  const usual = node.kind === 'button' || node.kind === 'link' ? ['fit', 'fit'] : ['fill', 'fit'];
  return w === usual[0] && h === usual[1] ? undefined : `size ${w}×${h}`;
}

function describe(node: UiNode, parent: FrameNode | undefined, linked: Linked): string {
  const bits: string[] = [];
  const name = node.name && node.kind !== 'text' ? ` ${quote(node.name, 32)}` : '';
  switch (node.kind) {
    case 'frame': {
      const l = node.layout;
      bits.push(`${l.direction === 'column' ? 'stack' : l.direction}${name}`);
      if (l.direction === 'grid') bits.push(`${l.columns ?? 3} columns`);
      if (l.gap !== 'md') bits.push(`gap ${l.gap}`);
      if (l.padding !== (parent ? 'none' : 'xl')) bits.push(`padding ${l.padding}`);
      if (l.align !== 'stretch') bits.push(`align ${l.align}`);
      if (l.justify !== 'start') bits.push(`justify ${l.justify}`);
      if (l.stackOnPhone) bits.push('stacks on phone');
      if (node.fill) bits.push(`fill ${node.fill}`);
      if (node.radius !== 'none') bits.push(`radius ${node.radius}`);
      if (node.border) bits.push('border');
      if (node.shadow !== 'none') bits.push(`shadow ${node.shadow}`);
      if (node.repeat) {
        const list = resolve(node.repeat, { linked });
        bits.push(`repeats for each of ${formatValue(node.repeat)}${Array.isArray(list) ? ` (${list.length} samples)` : ''}`);
      }
      if (node.on) bits.push(`on click ${formatAction(node.on)}`);
      break;
    }
    case 'text': {
      bits.push(`text ${node.variant} ${quote(node.text)}`);
      if (node.align !== 'start') bits.push(`align ${node.align}`);
      if (node.color !== (node.variant === 'body' || node.variant === 'caption' ? 'muted' : 'text')) bits.push(`color ${node.color}`);
      if (node.bind) bits.push(`shows ${formatValue(node.bind)}${node.bind.from === 'vi' ? ` → ${sample(resolve(node.bind, { linked }))}` : ''}`);
      break;
    }
    case 'button':
      bits.push(`button ${node.variant} ${quote(node.label)}`);
      if (node.on) bits.push(`on click ${formatAction(node.on)}`);
      break;
    case 'input':
      bits.push(`input ${node.inputType} ${quote(node.label)}`, `saved as ${node.field}`);
      if (node.placeholder) bits.push(`hint ${quote(node.placeholder, 32)}`);
      if (node.required) bits.push('required');
      if (node.on) bits.push(`on enter ${formatAction(node.on)}`);
      break;
    case 'image':
      bits.push(`image ${node.ratio}`);
      if (node.bind) bits.push(`shows ${formatValue(node.bind)}`);
      else bits.push(node.src ? `src ${quote(node.src, 40)}` : 'no picture yet');
      if (node.fit !== 'cover') bits.push(`fit ${node.fit}`);
      if (node.radius !== 'md') bits.push(`radius ${node.radius}`);
      break;
    case 'gallery':
      bits.push(`gallery ${node.columns} columns ${node.ratio}`);
      if (node.bind) bits.push(`shows ${formatValue(node.bind)}`);
      else bits.push(`${node.images.length} pictures`);
      break;
    case 'link':
      bits.push(`link ${quote(node.label)}`, node.to ? `to ${node.to}` : 'goes nowhere yet');
      break;
    case 'divider':
      bits.push('divider');
      break;
  }
  if (node.kind === 'text' && node.name) bits.push(`named ${quote(node.name, 32)}`);
  const size = sizeWords(node, parent);
  if (size) bits.push(size);
  if (node.hidden) bits.push('hidden');
  return bits.join(' · ');
}

/** A page as an outline an agent can read at a glance and point into by id. */
export function outlinePage(path: string, doc: UiDoc, linked: Linked): string {
  const lines = [
    `page ${quote(doc.name)} · ${path} · route ${doc.route} · theme ${doc.theme}`,
    `links: ${doc.links.length ? doc.links.join(', ') : 'none'}`,
    '',
  ];
  const walk = (node: UiNode, parent: FrameNode | undefined, prefix: string, last: boolean, depth: number): void => {
    const branch = depth === 0 ? '' : last ? '└─ ' : '├─ ';
    lines.push(`${prefix}${branch}${node.id} · ${describe(node, parent, linked)}`);
    if (node.kind !== 'frame') return;
    const next = depth === 0 ? '' : prefix + (last ? '   ' : '│  ');
    node.children.forEach((child, i) => walk(child, node, next, i === node.children.length - 1, depth + 1));
    if (node.children.length === 0 && depth > 0) lines.push(`${next}   (empty)`);
  };
  walk(doc.root, undefined, '', true, 0);
  return lines.join('\n');
}

/** A one-line summary of a page, for listings. */
export function summarizePage(path: string, doc: UiDoc): string {
  let count = 0;
  let connected = 0;
  const walk = (node: UiNode): void => {
    count++;
    if (('bind' in node && node.bind) || ('on' in node && node.on) || (node.kind === 'frame' && node.repeat)) connected++;
    if (node.kind === 'frame') node.children.forEach(walk);
  };
  walk(doc.root);
  return `${path} · ${quote(doc.name)} · route ${doc.route} · ${count - 1} elements, ${connected} connected · theme ${doc.theme}${doc.links.length ? ` · links ${doc.links.join(', ')}` : ''}`;
}

// ------------------------------------------------------------ .vi exports

export function outlineExports(path: string, exports: ViExports, otherKeys: string[]): string {
  const lines = [`vi ${path}`, ''];
  lines.push(exports.values.length ? 'values:' : 'values: none');
  for (const v of exports.values) {
    const fields = v.fields ? ` { ${Object.entries(v.fields).map(([k, t]) => `${k}: ${t}`).join(', ')} }` : '';
    const s = v.sample === undefined ? '' : ` = ${JSON.stringify(v.sample).slice(0, 90)}${JSON.stringify(v.sample).length > 90 ? '…' : ''}`;
    lines.push(`  ${path}#${v.name}: ${v.type}${fields}${s}${v.about ? `   — ${v.about}` : ''}`);
  }
  lines.push(exports.actions.length ? 'actions:' : 'actions: none');
  for (const a of exports.actions) {
    lines.push(`  ${path}#${a.name}(${a.inputs.map((i) => `${i.name}: ${i.type}`).join(', ')})${a.returns ? ` → ${a.returns}` : ''}${a.about ? `   — ${a.about}` : ''}`);
  }
  const rest = otherKeys.filter((k) => k !== 'exports');
  if (rest.length) lines.push('', `also in the file (the graph editor's, not shown here): ${rest.join(', ')}`);
  return lines.join('\n');
}

export const kindName = (kind: UiNode['kind']): string => NAMES[kind].toLowerCase();
