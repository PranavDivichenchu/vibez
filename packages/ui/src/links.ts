import type { ActionRef, UiDoc, UiNode, ValueRef, ViAction, ViExports, ViType, ViValue } from './types.ts';
import { find } from './ops.ts';

/**
 * How a page connects to `.vi` files: which values an element can show, which
 * actions a button can run, and what the canvas shows before anything runs.
 *
 * The page never stores data. It stores references, and a reference is only
 * offered where its type fits: a gallery is offered lists, a text is offered
 * words and numbers, a button is offered actions. A beginner cannot wire a
 * list of orders into a heading by accident.
 */

/** Read the `exports` block of a `.vi` file. Anything else in it is the graph editor's. */
export function parseViExports(text: string): ViExports {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { values: [], actions: [] };
  }
  const exports = (data as { exports?: Partial<ViExports> } | null)?.exports;
  const values = Array.isArray(exports?.values) ? exports.values.filter((v): v is ViValue => typeof v?.name === 'string') : [];
  const actions = Array.isArray(exports?.actions)
    ? exports.actions.filter((a): a is ViAction => typeof a?.name === 'string').map((a) => ({ ...a, inputs: Array.isArray(a.inputs) ? a.inputs : [] }))
    : [];
  return { values, actions };
}

/** The `.vi` files a page can see, by the path the page uses for them. */
export type Linked = Map<string, ViExports>;

export type Slot = 'text' | 'image' | 'gallery' | 'repeat';

const FITS: Record<Slot, ViType[]> = {
  text: ['String', 'Number', 'Date', 'Boolean', 'Url'],
  image: ['Url', 'String'],
  gallery: ['List'],
  repeat: ['List'],
};

export const slotOf = (node: UiNode): Slot | undefined => {
  switch (node.kind) {
    case 'text': return 'text';
    case 'image': return 'image';
    case 'gallery': return 'gallery';
    default: return undefined;
  }
};

export interface ValueChoice {
  ref: ValueRef;
  /** How the picker shows it: `orders`, `plan › tier`, `item › name`. */
  label: string;
  type: ViType;
  /** Which file, or "this list" / "this page". */
  source: string;
  sample?: unknown;
}

export interface ActionChoice {
  ref: ActionRef;
  label: string;
  source: string;
  inputs: { name: string; type: ViType }[];
}

/** The list a node sits inside, if one of its frames repeats. */
function repeatAround(doc: UiDoc, id: string, linked: Linked): { ref: ValueRef; value: ViValue | undefined } | undefined {
  const hit = find(doc, id);
  if (!hit) return undefined;
  for (const ancestorId of [...hit.path].reverse().slice(1)) {
    const ancestor = find(doc, ancestorId)?.node;
    if (ancestor?.kind === 'frame' && ancestor.repeat) {
      const ref = ancestor.repeat;
      const value = ref.from === 'vi' ? linked.get(ref.file)?.values.find((v) => v.name === ref.name) : undefined;
      return { ref, value };
    }
  }
  return undefined;
}

/** Values that fit a slot, nearest first: the current list item, then the page's `.vi` files. */
export function valueChoices(doc: UiDoc, id: string, slot: Slot, linked: Linked): ValueChoice[] {
  const fits = FITS[slot];
  const out: ValueChoice[] = [];

  const around = repeatAround(doc, id, linked);
  if (around && slot !== 'repeat') {
    const sampleItem = Array.isArray(around.value?.sample) ? around.value.sample[0] : undefined;
    for (const [field, type] of Object.entries(around.value?.fields ?? {})) {
      if (fits.includes(type)) {
        out.push({ ref: { from: 'item', field }, label: `item › ${field}`, type, source: 'each item',
          sample: (sampleItem as Record<string, unknown> | undefined)?.[field] });
      }
    }
    if (!around.value?.fields && fits.includes('String')) {
      out.push({ ref: { from: 'item' }, label: 'item', type: 'String', source: 'each item', sample: sampleItem });
    }
  }

  for (const [file, exports] of linked) {
    for (const value of exports.values) {
      if (fits.includes(value.type)) {
        out.push({ ref: { from: 'vi', file, name: value.name }, label: value.name, type: value.type, source: file, sample: value.sample });
      }
      if (value.type === 'Object' && value.fields && slot !== 'repeat') {
        for (const [field, type] of Object.entries(value.fields)) {
          if (fits.includes(type)) {
            out.push({ ref: { from: 'vi', file, name: value.name, field }, label: `${value.name} › ${field}`, type, source: file,
              sample: (value.sample as Record<string, unknown> | undefined)?.[field] });
          }
        }
      }
    }
  }
  return out;
}

export function actionChoices(linked: Linked): ActionChoice[] {
  const out: ActionChoice[] = [];
  for (const [file, exports] of linked) {
    for (const action of exports.actions) {
      out.push({ ref: { run: 'vi', file, name: action.name }, label: action.name, source: file, inputs: action.inputs });
    }
  }
  return out;
}

/** Inputs on the page, by the name what is typed into them is saved under. */
export function pageInputs(doc: UiDoc): string[] {
  const out: string[] = [];
  const walk = (node: UiNode): void => {
    if (node.kind === 'input' && node.field && !out.includes(node.field)) out.push(node.field);
    if (node.kind === 'frame') node.children.forEach(walk);
  };
  walk(doc.root);
  return out;
}

/**
 * Fill an action's inputs from the page by name: an action wanting `email`
 * gets the input saved as `email`. It is how "the button sends what was typed"
 * happens without anyone wiring each argument.
 */
export function autoArgs(doc: UiDoc, inputs: { name: string }[]): Record<string, ValueRef> {
  const fields = new Set(pageInputs(doc));
  const out: Record<string, ValueRef> = {};
  for (const input of inputs) {
    if (fields.has(input.name)) out[input.name] = { from: 'input', name: input.name };
  }
  return out;
}

// ---------------------------------------------------------------- reading values

export interface Scope {
  linked: Linked;
  /** The current item, inside a repeating frame. */
  item?: unknown;
  /** What has been typed so far, by field name. */
  inputs?: Record<string, string>;
  /** Live values, when the page is running; samples are used for anything missing. */
  live?: Map<string, unknown>;
}

export const liveKey = (file: string, name: string): string => `${file}#${name}`;

export function resolve(ref: ValueRef, scope: Scope): unknown {
  switch (ref.from) {
    case 'item': {
      if (ref.field === undefined) return scope.item;
      return (scope.item as Record<string, unknown> | undefined)?.[ref.field];
    }
    case 'input':
      return scope.inputs?.[ref.name];
    case 'vi': {
      const key = liveKey(ref.file, ref.name);
      const whole = scope.live?.has(key)
        ? scope.live.get(key)
        : scope.linked.get(ref.file)?.values.find((v) => v.name === ref.name)?.sample;
      return ref.field === undefined ? whole : (whole as Record<string, unknown> | undefined)?.[ref.field];
    }
  }
}

/** A value as words on the page. */
export function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number') return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `${value.length} items`;
  return undefined;
}

/** How a reference reads in the inspector and on the canvas badge. */
export function describeRef(ref: ValueRef): string {
  switch (ref.from) {
    case 'item': return ref.field ? `item › ${ref.field}` : 'item';
    case 'input': return `typed ${ref.name}`;
    case 'vi': return ref.field ? `${ref.name} › ${ref.field}` : ref.name;
  }
}

export function describeAction(ref: ActionRef): string {
  return ref.run === 'navigate' ? `go to ${ref.to}` : `run ${ref.name}`;
}

/** Every reference a page makes that its linked files no longer offer. */
export function brokenLinks(doc: UiDoc, linked: Linked): { id: string; what: string }[] {
  const out: { id: string; what: string }[] = [];
  const checkValue = (id: string, ref: ValueRef | undefined): void => {
    if (ref?.from !== 'vi') return;
    const exports = linked.get(ref.file);
    if (!exports) out.push({ id, what: `${ref.file} is not linked` });
    else if (!exports.values.some((v) => v.name === ref.name)) out.push({ id, what: `${ref.file} has no ${ref.name}` });
  };
  const checkAction = (id: string, ref: ActionRef | undefined): void => {
    if (ref?.run !== 'vi') return;
    const exports = linked.get(ref.file);
    if (!exports) out.push({ id, what: `${ref.file} is not linked` });
    else if (!exports.actions.some((a) => a.name === ref.name)) out.push({ id, what: `${ref.file} has no ${ref.name}` });
  };
  const walk = (node: UiNode): void => {
    if (node.kind === 'text' || node.kind === 'image' || node.kind === 'gallery') checkValue(node.id, node.bind);
    if (node.kind === 'button' || node.kind === 'input') checkAction(node.id, node.on);
    if (node.kind === 'frame') {
      checkValue(node.id, node.repeat);
      checkAction(node.id, node.on);
      node.children.forEach(walk);
    }
  };
  walk(doc.root);
  return out;
}
