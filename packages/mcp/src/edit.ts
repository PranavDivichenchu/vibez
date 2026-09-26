import type { ActionRef, FrameNode, Linked, Sizing, UiDoc, UiNode, ValueRef } from '../../ui/src/index.ts';
import {
  CATALOG, THEMES, allIds, autoArgs, displayName, find, insert, makeId, move, pageInputs, remove, duplicate, wrap,
  update, updateDoc, valueChoices, actionChoices, slotOf, type NodePatch,
} from '../../ui/src/index.ts';
import { formatAction, formatValue, parseAction, parseValue } from './notation.ts';
import { VibezError } from './workspace.ts';

/**
 * The operations an agent edits a page with.
 *
 * They are the same moves a person makes in the editor (add, set, move,
 * remove, duplicate, wrap, connect), applied as one batch: every operation is
 * checked against the page as it stands after the ones before it, and if any
 * is refused nothing is written. A batch is how an agent builds a whole
 * section in one call without leaving a half-made page behind.
 *
 * New elements can be named in the batch with `as` and referred to later in
 * the same batch as `$name`, so "add a card, then put a title in it" is one
 * call rather than two round trips.
 */

export type Props = Record<string, unknown>;

export type Op =
  | { op: 'add'; element: string; parent?: string; index?: number; as?: string; props?: Props }
  | { op: 'set'; id: string; props: Props }
  | { op: 'move'; id: string; parent: string; index?: number }
  | { op: 'remove'; id: string }
  | { op: 'duplicate'; id: string; as?: string }
  | { op: 'wrap'; id: string; direction?: 'column' | 'row' | 'stack'; as?: string }
  | { op: 'page'; props: Props };

export interface EditContext {
  linked: Linked;
  /** Other pages in the project, as this page refers to them. */
  pages: string[];
}

export interface EditResult {
  doc: UiDoc;
  /** One line per operation, saying what happened. */
  log: string[];
  /** Names given with `as`, and the ids they became. */
  created: Record<string, string>;
}

// ------------------------------------------------------------ vocabulary

export const SPACE = ['none', 'xs', 'sm', 'md', 'lg', 'xl', '2xl'] as const;
export const RADIUS = ['none', 'sm', 'md', 'lg', 'full'] as const;
export const COLORS = ['page', 'surface', 'raised', 'accent', 'accentSoft', 'text', 'muted', 'inverse', 'danger', 'success'] as const;
export const SHADOW = ['none', 'soft', 'lifted'] as const;
export const RATIOS = ['free', '1:1', '4:3', '3:2', '16:9', '3:4', '9:16'] as const;
export const TEXT_VARIANTS = ['title', 'heading', 'subheading', 'body', 'caption', 'label'] as const;
export const BUTTON_VARIANTS = ['primary', 'secondary', 'ghost', 'danger'] as const;
export const INPUT_TYPES = ['text', 'email', 'number', 'password', 'search', 'multiline'] as const;

type Check =
  | { t: 'enum'; values: readonly string[]; nullable?: boolean }
  | { t: 'string' }
  | { t: 'bool' }
  | { t: 'int'; min: number; max: number }
  | { t: 'strings' }
  | { t: 'size' };

const COMMON: Record<string, Check> = {
  name: { t: 'string' },
  hidden: { t: 'bool' },
  width: { t: 'size' },
  height: { t: 'size' },
};

/** Every property each kind of element has, and what it accepts. */
export const PROPS: Record<UiNode['kind'], Record<string, Check>> = {
  frame: {
    direction: { t: 'enum', values: ['stack', 'column', 'row', 'grid'] },
    gap: { t: 'enum', values: SPACE },
    padding: { t: 'enum', values: SPACE },
    align: { t: 'enum', values: ['start', 'center', 'end', 'stretch'] },
    justify: { t: 'enum', values: ['start', 'center', 'end', 'between'] },
    columns: { t: 'int', min: 1, max: 12 },
    stackOnPhone: { t: 'bool' },
    fill: { t: 'enum', values: COLORS, nullable: true },
    radius: { t: 'enum', values: RADIUS },
    border: { t: 'bool' },
    shadow: { t: 'enum', values: SHADOW },
  },
  text: {
    text: { t: 'string' },
    variant: { t: 'enum', values: TEXT_VARIANTS },
    align: { t: 'enum', values: ['start', 'center', 'end'] },
    color: { t: 'enum', values: COLORS },
  },
  button: {
    label: { t: 'string' },
    variant: { t: 'enum', values: BUTTON_VARIANTS },
  },
  input: {
    field: { t: 'string' },
    label: { t: 'string' },
    placeholder: { t: 'string' },
    inputType: { t: 'enum', values: INPUT_TYPES },
    required: { t: 'bool' },
  },
  image: {
    src: { t: 'string' },
    alt: { t: 'string' },
    ratio: { t: 'enum', values: RATIOS },
    fit: { t: 'enum', values: ['cover', 'contain'] },
    radius: { t: 'enum', values: RADIUS },
  },
  gallery: {
    images: { t: 'strings' },
    columns: { t: 'int', min: 1, max: 6 },
    ratio: { t: 'enum', values: RATIOS.filter((r) => r !== 'free') },
    gap: { t: 'enum', values: SPACE },
    radius: { t: 'enum', values: RADIUS },
  },
  link: {
    label: { t: 'string' },
    to: { t: 'string' },
    color: { t: 'enum', values: COLORS },
  },
  divider: {
    color: { t: 'enum', values: COLORS },
  },
};

/** Properties that connect an element to a .vi file, and which kinds have them. */
export const LINK_PROPS: Record<string, UiNode['kind'][]> = {
  shows: ['text', 'image', 'gallery'],
  repeat: ['frame'],
  onClick: ['button', 'frame'],
  onEnter: ['input'],
  args: ['button', 'frame', 'input'],
};

/** The elements `add` knows, by the name used in the palette. */
export const ELEMENTS = new Map(CATALOG.map((entry) => [entry.label.toLowerCase(), entry]));

// ------------------------------------------------------------ checking props

function checkValue(kind: UiNode['kind'], key: string, value: unknown, check: Check): void {
  const bad = (expected: string) => new VibezError(`${key} on a ${kind} takes ${expected}, not ${JSON.stringify(value)}.`);
  switch (check.t) {
    case 'enum':
      if (value === null && check.nullable) return;
      if (typeof value !== 'string' || !check.values.includes(value)) throw bad(`one of ${check.values.join(', ')}${check.nullable ? ', or null for none' : ''}`);
      return;
    case 'string':
      if (typeof value !== 'string') throw bad('text');
      return;
    case 'bool':
      if (typeof value !== 'boolean') throw bad('true or false');
      return;
    case 'int':
      if (typeof value !== 'number' || !Number.isInteger(value) || value < check.min || value > check.max) throw bad(`a whole number from ${check.min} to ${check.max}`);
      return;
    case 'strings':
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw bad('a list of addresses');
      return;
    case 'size':
      if (!(value === 'fill' || value === 'fit' || value === 'hug' || (typeof value === 'number' && value > 0 && value <= 4000))) {
        throw bad('"fill", "fit", or a number of pixels');
      }
  }
}

const toSizing = (value: unknown): Sizing =>
  value === 'fill' ? { mode: 'fill' } : value === 'fit' || value === 'hug' ? { mode: 'hug' } : { mode: 'fixed', px: Math.round(value as number) };

/** Split props into plain settings (checked and applied here) and links (applied against the page). */
function splitProps(node: UiNode, props: Props): { plain: Props; links: Props } {
  const plain: Props = {};
  const links: Props = {};
  const own = PROPS[node.kind];
  for (const [key, value] of Object.entries(props)) {
    if (key in LINK_PROPS) {
      if (!LINK_PROPS[key]!.includes(node.kind)) {
        throw new VibezError(`A ${node.kind} has no ${key}. ${key} is for ${LINK_PROPS[key]!.join(' and ')} elements.`);
      }
      links[key] = value;
      continue;
    }
    const check = own[key] ?? COMMON[key];
    if (!check) {
      const all = [...Object.keys(own), ...Object.keys(COMMON), ...Object.keys(LINK_PROPS).filter((k) => LINK_PROPS[k]!.includes(node.kind))];
      throw new VibezError(`A ${node.kind} has no property "${key}". It has: ${all.join(', ')}.`);
    }
    checkValue(node.kind, key, value, check);
    plain[key] = value;
  }
  return { plain, links };
}

function applyPlain(node: UiNode, plain: Props): NodePatch {
  const patch: Record<string, unknown> = {};
  const layout: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(plain)) {
    if (key === 'width' || key === 'height') {
      patch['size'] = { ...(patch['size'] as object ?? node.size), [key === 'width' ? 'w' : 'h']: toSizing(value) };
    } else if (node.kind === 'frame' && ['direction', 'gap', 'padding', 'align', 'justify', 'columns', 'stackOnPhone'].includes(key)) {
      layout[key] = key === 'direction' && value === 'stack' ? 'column' : value;
    } else {
      patch[key] = value;
    }
  }
  if (node.kind === 'frame' && Object.keys(layout).length) {
    const next = { ...node.layout, ...layout } as FrameNode['layout'];
    if (next.direction === 'grid' && next.columns === undefined) next.columns = 3;
    // Stacking on phones only means something for a row.
    if (next.direction !== 'row') delete next.stackOnPhone;
    patch['layout'] = next;
    // A frame still named after its old shape is renamed to its new one.
    const shapeNames: Record<string, string> = { column: 'Stack', row: 'Row', grid: 'Grid' };
    if (!('name' in plain) && node.name && Object.values(shapeNames).includes(node.name) && next.direction !== node.layout.direction) {
      patch['name'] = shapeNames[next.direction];
    }
  }
  return patch as NodePatch;
}

// ------------------------------------------------------------ links

const SLOT_WORDS = {
  text: 'words and numbers (String, Number, Date, Boolean, Url)',
  image: 'a picture address (Url or String)',
  gallery: 'a List',
  repeat: 'a List',
} as const;

function linkValue(doc: UiDoc, node: UiNode, key: 'shows' | 'repeat', raw: unknown, ctx: EditContext): { doc: UiDoc; said: string } {
  if (raw === null || raw === '') {
    return { doc: update(doc, node.id, (key === 'shows' ? { bind: undefined } : { repeat: undefined }) as NodePatch), said: `${key === 'shows' ? 'shows its own content' : 'shows once'}` };
  }
  if (typeof raw !== 'string') throw new VibezError(`${key} takes a value like dashboard.vi#orders, or null to disconnect.`);
  const ref = parseValue(raw);
  const slot = key === 'repeat' ? 'repeat' : slotOf(node)!;

  if (ref.from === 'input') {
    if (slot !== 'text') throw new VibezError(`Only a text can show what was typed; ${raw} cannot go on a ${node.kind}.`);
    if (!pageInputs(doc).includes(ref.name)) {
      throw new VibezError(`No input on this page is saved as ${ref.name}. Inputs here: ${pageInputs(doc).join(', ') || 'none'}.`);
    }
    return { doc: update(doc, node.id, { bind: ref } as NodePatch), said: `shows ${raw}` };
  }
  if (ref.from === 'vi') {
    const exports = ctx.linked.get(ref.file);
    if (!exports) {
      throw new VibezError(`There is no ${ref.file} next to this page. .vi files it can use: ${[...ctx.linked.keys()].join(', ') || 'none yet (create one with vi_declare)'}.`);
    }
    const value = exports.values.find((v) => v.name === ref.name);
    if (!value) {
      throw new VibezError(`${ref.file} has no value called ${ref.name}. It has: ${exports.values.map((v) => v.name).join(', ') || 'no values yet'}.`);
    }
  }
  const choices = valueChoices(doc, node.id, slot, ctx.linked);
  const wanted = formatValue(ref);
  if (!choices.some((c) => formatValue(c.ref) === wanted)) {
    const fitting = choices.map((c) => formatValue(c.ref));
    const where = ref.from === 'item' ? ' Item fields are only offered inside a frame that repeats over a list.' : '';
    throw new VibezError(`A ${key === 'repeat' ? 'repeating frame' : node.kind} needs ${SLOT_WORDS[slot]}, and ${raw} is not one.${where} Values that fit here: ${fitting.join(', ') || 'none yet'}.`);
  }
  let next = update(doc, node.id, (key === 'shows' ? { bind: ref } : { repeat: ref }) as NodePatch);
  if (ref.from === 'vi' && !next.links.includes(ref.file)) next = updateDoc(next, { links: [...next.links, ref.file] });
  return { doc: next, said: key === 'repeat' ? `repeats for each of ${raw}` : `shows ${raw}` };
}

function linkAction(doc: UiDoc, node: UiNode, raw: unknown, args: unknown, ctx: EditContext): { doc: UiDoc; said: string } {
  if (raw === null || raw === '') return { doc: update(doc, node.id, { on: undefined } as NodePatch), said: 'does nothing when used' };
  if (typeof raw !== 'string') throw new VibezError('An action is written like dashboard.vi#inviteTeammate, or go:other.ui to open a page.');
  let ref: ActionRef = parseAction(raw);
  if (ref.run === 'navigate') {
    if (!/^https?:\/\//.test(ref.to) && !ctx.pages.includes(ref.to)) {
      throw new VibezError(`There is no page ${ref.to}. Pages next to this one: ${ctx.pages.join(', ') || 'none'}. A web address must start with http:// or https://.`);
    }
  } else {
    const found = actionChoices(ctx.linked).find((c) => c.ref.run === 'vi' && c.ref.file === (ref as { file: string }).file && c.ref.name === (ref as { name: string }).name);
    if (!found) {
      const available = actionChoices(ctx.linked).map((c) => formatAction(c.ref));
      throw new VibezError(`${raw} is not an action any .vi file offers. Actions available: ${available.join(', ') || 'none yet (declare one with vi_declare)'}.`);
    }
    const given = args === undefined ? {} : parseArgs(args, found.inputs.map((i) => i.name));
    ref = { ...ref, args: { ...autoArgs(doc, found.inputs), ...given } };
  }
  let next = update(doc, node.id, { on: ref } as NodePatch);
  if (ref.run === 'vi' && !next.links.includes(ref.file)) next = updateDoc(next, { links: [...next.links, ref.file] });
  const missing = ref.run === 'vi'
    ? actionChoices(ctx.linked).find((c) => c.ref.run === 'vi' && c.ref.name === (ref as { name: string }).name)!.inputs.filter((i) => !(ref as { args?: object }).args || !(i.name in ((ref as { args: object }).args)))
    : [];
  return { doc: next, said: `${node.kind === 'input' ? 'on enter' : 'on click'} ${formatAction(ref)}${missing.length ? ` (nothing yet gives it ${missing.map((m) => m.name).join(', ')})` : ''}` };
}

function parseArgs(raw: unknown, names: string[]): Record<string, ValueRef> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new VibezError('args maps each input of the action to a value, like { "email": "input.email" }.');
  }
  const out: Record<string, ValueRef> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!names.includes(key)) throw new VibezError(`That action has no input called ${key}. Its inputs: ${names.join(', ') || 'none'}.`);
    out[key] = parseValue(String(value));
  }
  return out;
}

function applyLinks(doc: UiDoc, id: string, links: Props, ctx: EditContext): { doc: UiDoc; said: string[] } {
  const said: string[] = [];
  let next = doc;
  for (const key of ['repeat', 'shows', 'onClick', 'onEnter'] as const) {
    if (!(key in links)) continue;
    const node = find(next, id)!.node;
    const result = key === 'repeat' || key === 'shows'
      ? linkValue(next, node, key, links[key], ctx)
      : linkAction(next, node, links[key], links['args'], ctx);
    next = result.doc;
    said.push(result.said);
  }
  if ('args' in links && !('onClick' in links) && !('onEnter' in links)) {
    const node = find(next, id)!.node as UiNode & { on?: ActionRef };
    if (node.on?.run !== 'vi') throw new VibezError(`${id} does not run an action, so it has no args to set.`);
    const result = linkAction(next, node, `${node.on.file}#${node.on.name}`, links['args'], ctx);
    next = result.doc;
    said.push(result.said);
  }
  return { doc: next, said };
}

// ------------------------------------------------------------ the batch

const label = (doc: UiDoc, id: string): string => {
  const node = find(doc, id)?.node;
  return node ? `${node.kind} ${JSON.stringify(displayName(node))} (${id})` : id;
};

export function applyOps(start: UiDoc, ops: Op[], ctx: EditContext): EditResult {
  let doc = start;
  const log: string[] = [];
  const created: Record<string, string> = {};

  const idOf = (ref: string | undefined, fallback?: string): string => {
    const raw = ref ?? fallback;
    if (raw === undefined) throw new VibezError('An element id is missing.');
    if (raw.startsWith('$')) {
      const id = created[raw.slice(1)];
      if (!id) throw new VibezError(`Nothing earlier in this batch was named ${raw.slice(1)} (with "as").`);
      return id;
    }
    if (!find(doc, raw)) throw new VibezError(`There is no element with id ${raw} on this page.`);
    return raw;
  };
  const frameOf = (id: string): FrameNode => {
    const node = find(doc, id)!.node;
    if (node.kind !== 'frame') throw new VibezError(`${label(doc, id)} is not a frame, so nothing can go inside it. Use its parent, or wrap it first.`);
    return node;
  };
  const remember = (as: string | undefined, id: string): void => {
    if (as === undefined) return;
    if (!/^[A-Za-z_][\w-]*$/.test(as)) throw new VibezError(`"${as}" cannot be used as a name; use letters, numbers, - and _.`);
    created[as] = id;
  };

  ops.forEach((op, i) => {
    try {
      switch (op.op) {
        case 'add': {
          const entry = ELEMENTS.get(String(op.element).toLowerCase());
          if (!entry) throw new VibezError(`There is no element called "${op.element}". Elements: ${[...ELEMENTS.keys()].join(', ')}.`);
          const parent = frameOf(idOf(op.parent, 'page'));
          let node = entry.make((kind) => makeId(kind, allIds(doc)));
          const { plain, links } = splitProps(node, op.props ?? {});
          // A text that shows a value gets a stand-in that says which, not the palette's sample sentence.
          if (node.kind === 'text' && typeof links['shows'] === 'string' && !('text' in plain)) {
            const shown = String(links['shows']);
            plain['text'] = shown.split(/[#.]/).pop() || shown;
          }
          node = { ...node, ...applyPlain(node, plain) } as UiNode;
          const index = op.index ?? parent.children.length;
          doc = insert(doc, parent.id, index, node);
          const linked = applyLinks(doc, node.id, links, ctx);
          doc = linked.doc;
          remember(op.as, node.id);
          log.push(`added ${label(doc, node.id)} to ${label(doc, parent.id)} at position ${Math.min(index, parent.children.length)}${linked.said.length ? `; ${linked.said.join(', ')}` : ''}`);
          break;
        }
        case 'set': {
          const id = idOf(op.id);
          const node = find(doc, id)!.node;
          const { plain, links } = splitProps(node, op.props ?? {});
          if (id === 'page' && ('width' in plain || 'height' in plain)) throw new VibezError('The page is always the full width of the screen.');
          doc = update(doc, id, applyPlain(node, plain));
          const linked = applyLinks(doc, id, links, ctx);
          doc = linked.doc;
          const changed = Object.keys(plain);
          log.push(`set ${[...changed, ...linked.said].join(', ') || 'nothing'} on ${label(doc, id)}`);
          break;
        }
        case 'move': {
          const id = idOf(op.id);
          if (id === 'page') throw new VibezError('The page itself cannot move.');
          const parent = frameOf(idOf(op.parent));
          if (find(doc, parent.id)!.path.includes(id)) throw new VibezError(`${label(doc, id)} cannot go inside itself.`);
          const before = doc;
          doc = move(doc, id, parent.id, op.index ?? parent.children.length);
          log.push(doc === before ? `${label(doc, id)} was already there` : `moved ${label(doc, id)} into ${label(doc, parent.id)}`);
          break;
        }
        case 'remove': {
          const id = idOf(op.id);
          if (id === 'page') throw new VibezError('The page itself cannot be removed.');
          const what = label(doc, id);
          doc = remove(doc, id);
          log.push(`removed ${what}`);
          break;
        }
        case 'duplicate': {
          const id = idOf(op.id);
          if (id === 'page') throw new VibezError('The page itself cannot be duplicated.');
          const result = duplicate(doc, id);
          doc = result.doc;
          remember(op.as, result.id);
          log.push(`duplicated ${label(doc, id)} as ${result.id}`);
          break;
        }
        case 'wrap': {
          const id = idOf(op.id);
          if (id === 'page') throw new VibezError('The page itself cannot be wrapped.');
          const result = wrap(doc, id, op.direction === 'row' ? 'row' : 'column');
          doc = result.doc;
          remember(op.as, result.id);
          log.push(`put ${label(doc, id)} inside a new ${op.direction === 'row' ? 'row' : 'stack'} (${result.id})`);
          break;
        }
        case 'page': {
          const props = op.props ?? {};
          const patch: Partial<UiDoc> = {};
          for (const [key, value] of Object.entries(props)) {
            if (key === 'name' && typeof value === 'string') patch.name = value;
            else if (key === 'route' && typeof value === 'string') patch.route = value.startsWith('/') ? value : `/${value}`;
            else if (key === 'theme' && typeof value === 'string') {
              if (!THEMES.some((t) => t.id === value)) throw new VibezError(`There is no theme ${value}. Themes: ${THEMES.map((t) => t.id).join(', ')}.`);
              patch.theme = value;
            } else {
              throw new VibezError(`A page has name, route and theme; "${key}" is not one of them. The page's own layout is set on the element "page".`);
            }
          }
          doc = updateDoc(doc, patch);
          log.push(`page ${Object.entries(patch).map(([k, v]) => `${k} ${v}`).join(', ')}`);
          break;
        }
        default:
          throw new VibezError(`There is no operation "${(op as { op: string }).op}". Operations: add, set, move, remove, duplicate, wrap, page.`);
      }
    } catch (error) {
      if (error instanceof VibezError) throw new VibezError(`Operation ${i + 1} (${op.op}) was refused, so nothing was changed: ${error.message}`);
      throw error;
    }
  });
  return { doc, log, created };
}
