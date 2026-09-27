import type { FrameNode, Kind, NodeId, UiNode } from './types.ts';

/**
 * Every element someone can add, with the words the palette shows.
 *
 * `hint` is one short line, not a tooltip essay. Beginners learn what a frame
 * is by dropping one, not by reading about it.
 */
export interface CatalogEntry {
  kind: Kind;
  /** A variant of the kind, when one kind has several starting points. */
  preset?: string;
  label: string;
  hint: string;
  group: 'Layout' | 'Content' | 'Interactive' | 'Media';
  make: (id: (kind: string) => NodeId) => UiNode;
}

let counter = 0;
/** Short, readable ids: `button-k3f9`. Unique within a document is all that matters. */
export function makeId(kind: string, taken?: Set<string>): NodeId {
  for (;;) {
    counter = (counter + 1) % 1_000_000;
    const salt = (Date.now() + counter * 7919).toString(36).slice(-4);
    const id = `${kind}-${salt}`;
    if (!taken?.has(id)) return id;
  }
}

const hug = { w: { mode: 'hug' as const }, h: { mode: 'hug' as const } };
const fillW = { w: { mode: 'fill' as const }, h: { mode: 'hug' as const } };

export const frame = (id: NodeId, over: Partial<FrameNode> = {}): FrameNode => ({
  id,
  kind: 'frame',
  size: fillW,
  layout: { direction: 'column', gap: 'md', padding: 'md', align: 'stretch', justify: 'start' },
  fill: null,
  radius: 'none',
  border: false,
  shadow: 'none',
  children: [],
  ...over,
});

export const CATALOG: CatalogEntry[] = [
  {
    kind: 'frame', label: 'Stack', hint: 'Things on top of each other', group: 'Layout',
    make: (id) => frame(id('frame'), { name: 'Stack' }),
  },
  {
    kind: 'frame', preset: 'row', label: 'Row', hint: 'Things side by side', group: 'Layout',
    make: (id) => frame(id('frame'), {
      name: 'Row',
      layout: { direction: 'row', gap: 'md', padding: 'none', align: 'center', justify: 'start', stackOnPhone: true },
    }),
  },
  {
    kind: 'frame', preset: 'grid', label: 'Grid', hint: 'Tiles in columns', group: 'Layout',
    make: (id) => frame(id('frame'), {
      name: 'Grid',
      layout: { direction: 'grid', gap: 'md', padding: 'none', align: 'stretch', justify: 'start', columns: 3 },
    }),
  },
  {
    kind: 'frame', preset: 'card', label: 'Card', hint: 'A raised box', group: 'Layout',
    make: (id) => frame(id('frame'), {
      name: 'Card', fill: 'surface', radius: 'lg', border: true, shadow: 'soft',
      layout: { direction: 'column', gap: 'sm', padding: 'lg', align: 'stretch', justify: 'start' },
    }),
  },
  {
    kind: 'text', preset: 'title', label: 'Title', hint: 'The big words', group: 'Content',
    make: (id) => ({ id: id('text'), kind: 'text', size: fillW, text: 'A clear title', variant: 'title', align: 'start', color: 'text' }),
  },
  {
    kind: 'text', label: 'Text', hint: 'A paragraph', group: 'Content',
    make: (id) => ({ id: id('text'), kind: 'text', size: fillW, text: 'Say what this is for, in a sentence or two.', variant: 'body', align: 'start', color: 'muted' }),
  },
  {
    kind: 'divider', label: 'Divider', hint: 'A thin line', group: 'Content',
    make: (id) => ({ id: id('divider'), kind: 'divider', size: fillW, color: 'raised' }),
  },
  {
    kind: 'button', label: 'Button', hint: 'Does something when clicked', group: 'Interactive',
    make: (id) => ({ id: id('button'), kind: 'button', size: hug, label: 'Continue', variant: 'primary' }),
  },
  {
    kind: 'input', label: 'Input', hint: 'Somewhere to type', group: 'Interactive',
    make: (id) => ({ id: id('input'), kind: 'input', size: fillW, field: 'text', label: 'Label', placeholder: 'Type here', inputType: 'text' }),
  },
  {
    kind: 'link', label: 'Link', hint: 'Goes to a page', group: 'Interactive',
    make: (id) => ({ id: id('link'), kind: 'link', size: hug, label: 'Learn more', to: '', color: 'accent' }),
  },
  {
    kind: 'image', label: 'Image', hint: 'A picture', group: 'Media',
    make: (id) => ({ id: id('image'), kind: 'image', size: fillW, src: '', alt: '', ratio: '16:9', fit: 'cover', radius: 'md' }),
  },
  {
    kind: 'gallery', label: 'Gallery', hint: 'Many pictures in a grid', group: 'Media',
    make: (id) => ({ id: id('gallery'), kind: 'gallery', size: fillW, images: [], columns: 3, ratio: '1:1', gap: 'sm', radius: 'md' }),
  },
];

export const NAMES: Record<Kind, string> = {
  frame: 'Frame', text: 'Text', button: 'Button', input: 'Input', image: 'Image', gallery: 'Gallery', link: 'Link', divider: 'Divider',
};

export const displayName = (node: UiNode): string => {
  if (node.name) return node.name;
  if (node.kind === 'text') return node.text.slice(0, 28) || 'Text';
  if (node.kind === 'button' || node.kind === 'link') return node.label || NAMES[node.kind];
  if (node.kind === 'input') return node.label || 'Input';
  return NAMES[node.kind];
};

export const isContainer = (node: UiNode): node is FrameNode => node.kind === 'frame';
