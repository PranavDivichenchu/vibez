import type { ActionRef, NodeId, UiDoc, UiNode, ValueRef } from './types.ts';
import { CATALOG, frame, makeId } from './catalog.ts';
import { THEMES } from './themes.ts';

/**
 * A new project's pages, written from a short description of them.
 *
 * A starter project — from a template, from a graph of ideas, or from
 * someone's X profile — describes each page as a few sections: a hero, some
 * text, a list, a form. This builds a `.ui` page from them out of ordinary
 * elements, already connected to the project's `.vi` logic — a list repeats
 * over its page data, a button runs its action and the page shows what it
 * answered — and linked to the site's other pages. Nothing here is special:
 * it is the page a person would have built by hand, ready to keep editing.
 */

export type SectionSpec =
  | { kind: 'hero'; title: string; subtitle?: string; button?: ButtonSpec }
  | { kind: 'text'; heading?: string; body: string }
  /** Repeats over a List of page data, showing one of its fields per item. */
  | { kind: 'list'; heading?: string; list: string; show: string; detail?: string; button?: ButtonSpec }
  /** One value of page data, with a label over it. */
  | { kind: 'stat'; label: string; value: string }
  /** Inputs, and a button that sends them to an action (by matching names). */
  | { kind: 'form'; heading?: string; fields: { name: string; label: string; type?: 'text' | 'email' | 'multiline' }[]; submit: { label: string; action: string } };

/** A button runs an action (and the page shows what it answered), or goes to another page. */
export interface ButtonSpec { label: string; action?: string; goTo?: string }

export interface PageSpec {
  /** The file's name, without `.ui`: `home`. */
  file: string;
  name: string;
  route: string;
  sections: SectionSpec[];
}

/** What the pages can connect to: the logic file, as the pages name it, and what it offers. */
export interface PageLogic {
  /** The `.vi` file, relative to the pages: `../logic/main.vi`. */
  file: string;
  values: { name: string; type: string; fields?: Record<string, string> }[];
  actions: { name: string; inputs: { name: string; type: string }[] }[];
}

const themeIds = new Set(THEMES.map((t) => t.id));

/** Build one page. `others` are the site's other pages, for the links along the top. */
export function pageDoc(page: PageSpec, logic: PageLogic, others: PageSpec[], theme: string): UiDoc {
  const taken = new Set<string>();
  const id = (kind: string): NodeId => { const made = makeId(kind, taken); taken.add(made); return made; };
  const make = (label: string, over: Record<string, unknown> = {}): UiNode => ({ ...CATALOG.find((e) => e.label === label)!.make(id), ...over } as UiNode);
  const stack = (children: UiNode[], over: Record<string, unknown> = {}): UiNode =>
    ({ ...frame(id('frame'), { name: 'Stack', layout: { direction: 'column', gap: 'sm', padding: 'none', align: 'stretch', justify: 'start' } }), children, ...over } as UiNode);

  const value = (name: string) => logic.values.find((v) => v.name === name);
  const action = (name: string | undefined) => (name ? logic.actions.find((a) => a.name === name) : undefined);
  const vi = (name: string, field?: string): ValueRef => ({ from: 'vi', file: logic.file, name, ...(field ? { field } : {}) });
  const answer = (name: string): UiNode => make('Text', { text: '', color: 'accent', bind: { from: 'answer', file: logic.file, name } satisfies ValueRef });

  /** A button, connected: an action's first text input is filled from `from`, when there is one. */
  const button = (spec: ButtonSpec, from?: ValueRef): UiNode[] => {
    const run = action(spec.action);
    if (run) {
      const first = run.inputs.find((i) => i.type === 'String');
      const on: ActionRef = { run: 'vi', file: logic.file, name: run.name, args: first && from ? { [first.name]: from } : {} };
      return [make('Button', { label: spec.label, on }), answer(run.name)];
    }
    const to = spec.goTo && others.some((o) => o.file === spec.goTo) ? `${spec.goTo}.ui` : undefined;
    return [make('Button', { label: spec.label, ...(to ? { on: { run: 'navigate', to } satisfies ActionRef } : {}) })];
  };

  const sections: UiNode[] = [];
  for (const section of page.sections) {
    switch (section.kind) {
      case 'hero':
        sections.push(stack([
          make('Title', { text: section.title }),
          ...(section.subtitle ? [make('Text', { text: section.subtitle, variant: 'subheading', color: 'muted' })] : []),
          ...(section.button ? button(section.button) : []),
        ], { name: 'Hero', layout: { direction: 'column', gap: 'md', padding: 'lg', align: 'start', justify: 'start' } }));
        break;
      case 'text':
        sections.push(stack([
          ...(section.heading ? [make('Text', { text: section.heading, variant: 'heading' })] : []),
          make('Text', { text: section.body }),
        ]));
        break;
      case 'list': {
        const list = value(section.list);
        if (!list || list.type !== 'List') break;
        // One card per item, repeated by the page itself: the items live in the logic.
        const card = make('Card', {
          name: 'Item',
          children: [
            make('Text', { text: section.show, variant: 'subheading', bind: { from: 'item', field: section.show } satisfies ValueRef }),
            ...(section.detail ? [make('Text', { text: section.detail, color: 'muted', bind: { from: 'item', field: section.detail } satisfies ValueRef })] : []),
            ...(section.button ? button(section.button, { from: 'item', field: section.show }) : []),
          ],
        });
        sections.push(stack([
          ...(section.heading ? [make('Text', { text: section.heading, variant: 'heading' })] : []),
          stack([card], { name: section.list, repeat: vi(list.name), layout: { direction: 'column', gap: 'md', padding: 'none', align: 'stretch', justify: 'start' } }),
        ], { layout: { direction: 'column', gap: 'md', padding: 'none', align: 'stretch', justify: 'start' } }));
        break;
      }
      case 'stat': {
        if (!value(section.value)) break;
        sections.push(make('Card', {
          name: section.label,
          children: [
            make('Text', { text: section.label, variant: 'label', color: 'muted' }),
            make('Text', { text: '—', variant: 'title', bind: vi(section.value) }),
          ],
        }));
        break;
      }
      case 'form': {
        const run = action(section.submit.action);
        const inputs = section.fields.map((f) => make('Input', { field: f.name, label: f.label, placeholder: '', inputType: f.type ?? 'text' }));
        // Each input the action takes is filled from the input of the same name.
        const args: Record<string, ValueRef> = {};
        for (const input of run?.inputs ?? []) {
          if (section.fields.some((f) => f.name === input.name)) args[input.name] = { from: 'input', name: input.name };
        }
        sections.push(make('Card', {
          name: section.heading ?? 'Form',
          children: [
            ...(section.heading ? [make('Text', { text: section.heading, variant: 'heading' })] : []),
            ...inputs,
            make('Button', { label: section.submit.label, ...(run ? { on: { run: 'vi', file: logic.file, name: run.name, args } satisfies ActionRef } : {}) }),
            ...(run ? [answer(run.name)] : []),
          ],
        }));
        break;
      }
    }
  }

  // The rest of the site, along the top.
  const nav = others.length
    ? [stack(others.map((o) => make('Link', { label: o.name, to: `${o.file}.ui` })), {
      name: 'Links', layout: { direction: 'row', gap: 'md', padding: 'none', align: 'center', justify: 'start' },
    })]
    : [];

  const root = frame('page', {
    name: 'Page', fill: 'page',
    layout: { direction: 'column', gap: 'xl', padding: 'xl', align: 'stretch', justify: 'start' },
    children: [...nav, ...sections],
  });
  const uses = sections.length && JSON.stringify(sections).includes(JSON.stringify(logic.file));
  return {
    vibez: 'vibez.ui/1',
    name: page.name,
    route: page.route || `/${page.file}`,
    theme: themeIds.has(theme) ? theme : 'clean',
    links: uses ? [logic.file] : [],
    root,
  };
}
