import type { ActionRef, NodeId, UiDoc, ValueRef, ViType } from './types.ts';
import { find, update, updateDoc, type NodePatch } from './ops.ts';
import { actionChoices, pageInputs, slotOf, valueChoices, type Linked } from './links.ts';

/**
 * Connecting a page to its logic, from the site canvas.
 *
 * An element on a `.ui` page can show a `.vi` value, repeat over a `.vi`
 * list, or run a `.vi` action when it is clicked. The canvas asks what one
 * element could connect to and gets back every choice that fits — a heading
 * is only offered words and numbers, a repeating frame only lists, and an
 * action's inputs only values of their type — so a person picks from a list
 * and cannot wire something that would not work.
 */

export type ConnectKey = 'shows' | 'repeat' | 'on' | 'to';

export interface ConnectOption {
  label: string;
  /** Where it comes from, and what it looks like now. */
  detail?: string;
  /** What is written into the page; null disconnects. */
  ref: ValueRef | ActionRef | string | null;
}

export interface ConnectArg {
  name: string;
  type: ViType;
  /** What fills it now, if anything. */
  current: ValueRef | null;
  options: ConnectOption[];
}

export interface ConnectSlot {
  key: ConnectKey;
  title: string;
  current: ConnectOption['ref'];
  options: ConnectOption[];
  /** For an action that is connected: what each of its inputs is filled from. */
  args?: ConnectArg[];
}

export interface ConnectPanel {
  node: NodeId;
  kind: string;
  slots: ConnectSlot[];
  /** Said when there is nothing to connect to yet. */
  note?: string;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

const preview = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'object') return '';
  const text = String(value);
  return text.length > 40 ? `“${text.slice(0, 39)}…”` : `“${text}”`;
};

/** What fills an action's inputs, in the order a person would expect to pick from. */
function argOptions(doc: UiDoc, id: NodeId, type: ViType, linked: Linked): ConnectOption[] {
  const out: ConnectOption[] = [{ label: 'Nothing', ref: null }];
  // A value on the page: an item's field inside a repeat, or a .vi value.
  const slot = type === 'List' ? 'repeat' : 'text';
  for (const c of valueChoices(doc, id, slot, linked)) {
    if (c.ref.from === 'answer') continue;
    if (c.type !== type && !(type === 'String' && c.type !== 'List' && c.type !== 'Object')) continue;
    out.push({ label: c.label, detail: [c.source, preview(c.sample)].filter(Boolean).join(' · '), ref: c.ref });
  }
  // What someone typed into an input on this page.
  for (const name of pageInputs(doc)) out.push({ label: `typed ${name}`, detail: 'an input on this page', ref: { from: 'input', name } });
  return out;
}

/**
 * The first guess for each input of an action, so connecting a button usually
 * needs one pick, not four: an input on the page with the same name, then a
 * field of the current item with the same name, then — inside a repeat — the
 * item's first field of the right type.
 */
export function guessArgs(doc: UiDoc, id: NodeId, inputs: { name: string; type: ViType }[], linked: Linked): Record<string, ValueRef> {
  const typed = new Set(pageInputs(doc));
  const items = valueChoices(doc, id, 'text', linked).filter((c) => c.ref.from === 'item');
  const out: Record<string, ValueRef> = {};
  for (const input of inputs) {
    if (typed.has(input.name)) { out[input.name] = { from: 'input', name: input.name }; continue; }
    const named = items.find((c) => c.ref.from === 'item' && c.ref.field === input.name);
    if (named) { out[input.name] = named.ref; continue; }
    const typedLike = items.find((c) => c.type === input.type);
    if (typedLike) out[input.name] = typedLike.ref;
  }
  return out;
}

/** What one element of a page can be connected to, and what it is connected to now. */
export function connectPanel(doc: UiDoc, id: NodeId, linked: Linked, pages: string[]): ConnectPanel | undefined {
  const hit = find(doc, id);
  if (!hit) return undefined;
  const node = hit.node;
  const slots: ConnectSlot[] = [];

  const slot = slotOf(node);
  if (slot) {
    const current = (node as { bind?: ValueRef }).bind ?? null;
    const options: ConnectOption[] = [{ label: 'Its own words', ref: null }];
    if (slot === 'image') options[0] = { label: 'Its own picture', ref: null };
    if (slot === 'gallery') options[0] = { label: 'Its own pictures', ref: null };
    for (const c of valueChoices(doc, id, slot, linked)) {
      options.push({ label: c.label, detail: [c.source, c.ref.from === 'answer' ? 'empty until it runs' : preview(c.sample)].filter(Boolean).join(' · '), ref: c.ref });
    }
    slots.push({ key: 'shows', title: slot === 'text' ? 'Shows' : slot === 'image' ? 'Picture from' : 'Pictures from', current, options });
  }

  if (node.kind === 'frame') {
    const options: ConnectOption[] = [{ label: 'Once — no list', ref: null }];
    for (const c of valueChoices(doc, id, 'repeat', linked)) {
      options.push({ label: c.label, detail: [c.source, preview(c.sample)].filter(Boolean).join(' · '), ref: c.ref });
    }
    slots.push({ key: 'repeat', title: 'Repeats for each of', current: node.repeat ?? null, options });
  }

  if (node.kind === 'button' || node.kind === 'input' || node.kind === 'frame') {
    const current = node.on ?? null;
    const options: ConnectOption[] = [{ label: 'Nothing', ref: null }];
    const actions = actionChoices(linked);
    for (const a of actions) {
      // Offered with its inputs already filled in as well as they can be.
      const ref: ActionRef = { run: 'vi', file: a.source, name: a.label, args: guessArgs(doc, id, a.inputs, linked) };
      const selected = current?.run === 'vi' && current.file === a.source && current.name === a.label;
      options.push({ label: `Run ${a.label}`, detail: a.source, ref: selected ? current : ref });
    }
    for (const page of pages) options.push({ label: `Go to ${page.replace(/\.ui$/, '')}`, detail: 'another page', ref: { run: 'navigate', to: page } });
    let args: ConnectArg[] | undefined;
    if (current?.run === 'vi') {
      const action = linked.get(current.file)?.actions.find((a) => a.name === current.name);
      args = (action?.inputs ?? []).map((input) => ({
        name: input.name, type: input.type,
        current: current.args?.[input.name] ?? null,
        options: argOptions(doc, id, input.type, linked),
      }));
    }
    slots.push({ key: 'on', title: node.kind === 'input' ? 'When Enter is pressed' : 'When clicked', current, options, ...(args ? { args } : {}) });
  }

  if (node.kind === 'link') {
    const options: ConnectOption[] = pages.map((page) => ({ label: page.replace(/\.ui$/, ''), detail: 'a page of this site', ref: page }));
    if (node.to && !pages.includes(node.to)) options.unshift({ label: node.to, detail: 'where it goes now', ref: node.to });
    slots.push({ key: 'to', title: 'Goes to', current: node.to || null, options });
  }

  if (!slots.length) return undefined;
  const nothing = !linked.size && !pages.length;
  return { node: id, kind: node.kind, slots, ...(nothing ? { note: 'There is no .vi file in this project yet. Make one, and its page data and actions show up here.' } : {}) };
}

/**
 * Write one choice into the page. Only a choice the panel offered is taken:
 * anything else is refused rather than trusted, since it arrives from the
 * canvas as data.
 */
export function applyConnect(doc: UiDoc, id: NodeId, key: ConnectKey, ref: ConnectOption['ref'], linked: Linked, pages: string[]): { ok: true; doc: UiDoc } | { ok: false; reason: string } {
  const panel = connectPanel(doc, id, linked, pages);
  const slot = panel?.slots.find((s) => s.key === key);
  if (!panel || !slot) return { ok: false, reason: 'That cannot be connected to anything.' };
  const node = find(doc, id)!.node;

  if (key === 'on' && ref && typeof ref === 'object' && 'run' in ref && ref.run === 'vi') {
    // An action is checked by which action it is; its arguments separately,
    // each against the values that fit that input.
    const offered = slot.options.some((o) => o.ref && typeof o.ref === 'object' && 'run' in o.ref && o.ref.run === 'vi' && o.ref.file === ref.file && o.ref.name === ref.name);
    if (!offered) return { ok: false, reason: `${ref.name} is not an action this page can run.` };
    const action = linked.get(ref.file)!.actions.find((a) => a.name === ref.name)!;
    for (const [name, value] of Object.entries(ref.args ?? {})) {
      const input = action.inputs.find((i) => i.name === name);
      if (!input) return { ok: false, reason: `${ref.name} has no input called ${name}.` };
      if (!argOptions(doc, id, input.type, linked).some((o) => same(o.ref, value))) return { ok: false, reason: `That does not fit ${name}, which takes ${input.type}.` };
    }
  } else if (ref !== null && !slot.options.some((o) => same(o.ref, ref))) {
    return { ok: false, reason: 'That is not one of the choices for this element.' };
  }

  const patch: Record<string, unknown> =
    key === 'shows' ? { bind: ref ?? undefined }
      : key === 'repeat' ? { repeat: ref ?? undefined }
        : key === 'on' ? { on: ref ?? undefined }
          : { to: ref ?? '' };
  let next = update(doc, node.id, patch as NodePatch);
  // A page names the .vi files it uses, so the file travels with the link.
  const file = ref && typeof ref === 'object' && 'file' in ref ? ref.file : undefined;
  if (file && !next.links.includes(file)) next = updateDoc(next, { links: [...next.links, file] });
  return { ok: true, doc: next };
}
