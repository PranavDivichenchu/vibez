import type { ButtonNode, FrameNode, ImageNode, InputNode, TextNode, UiDoc, UiNode } from './types.ts';
import { frame } from './catalog.ts';
import { blankDoc } from './ops.ts';

/**
 * Pages to start from. Each is small enough to understand at a glance and
 * built only from the palette's own elements, so nothing in a template is
 * something a beginner could not have made themselves.
 */
export interface Template {
  id: string;
  name: string;
  hint: string;
  make: (name: string, route: string) => UiDoc;
}

let n = 0;
const id = (kind: string): string => `${kind}-${(++n).toString(36).padStart(3, '0')}`;
const fillW = { w: { mode: 'fill' as const }, h: { mode: 'hug' as const } };
const hug = { w: { mode: 'hug' as const }, h: { mode: 'hug' as const } };

const text = (value: string, variant: TextNode['variant'], over: Partial<TextNode> = {}): TextNode =>
  ({ id: id('text'), kind: 'text', size: fillW, text: value, variant, align: 'start', color: variant === 'body' || variant === 'caption' ? 'muted' : 'text', ...over });
const button = (label: string, variant: ButtonNode['variant'] = 'primary', over: Partial<ButtonNode> = {}): ButtonNode =>
  ({ id: id('button'), kind: 'button', size: hug, label, variant, ...over });
const input = (field: string, label: string, placeholder: string, inputType: InputNode['inputType'] = 'text'): InputNode =>
  ({ id: id('input'), kind: 'input', size: fillW, field, label, placeholder, inputType });
const image = (over: Partial<ImageNode> = {}): ImageNode =>
  ({ id: id('image'), kind: 'image', size: fillW, src: '', alt: '', ratio: '16:9', fit: 'cover', radius: 'lg', ...over });
const stack = (children: UiNode[], over: Partial<FrameNode> = {}): FrameNode =>
  frame(id('frame'), { name: 'Stack', children, layout: { direction: 'column', gap: 'md', padding: 'none', align: 'stretch', justify: 'start' }, ...over });
const row = (children: UiNode[], over: Partial<FrameNode> = {}): FrameNode =>
  frame(id('frame'), { name: 'Row', children, layout: { direction: 'row', gap: 'md', padding: 'none', align: 'center', justify: 'start', stackOnPhone: true }, ...over });
const card = (children: UiNode[], over: Partial<FrameNode> = {}): FrameNode =>
  frame(id('frame'), { name: 'Card', fill: 'surface', radius: 'lg', border: true, shadow: 'soft', children,
    layout: { direction: 'column', gap: 'sm', padding: 'lg', align: 'stretch', justify: 'start' }, ...over });

const page = (name: string, route: string, children: UiNode[], layout: Partial<FrameNode['layout']> = {}): UiDoc => {
  const doc = blankDoc(name, route);
  return { ...doc, root: { ...doc.root, layout: { ...doc.root.layout, ...layout }, children } };
};

export const TEMPLATES: Template[] = [
  {
    id: 'blank', name: 'Blank', hint: 'An empty page',
    make: (name, route) => blankDoc(name, route),
  },
  {
    id: 'landing', name: 'Landing', hint: 'Headline, pitch, three features',
    make: (name, route) => page(name, route, [
      row([
        text(name, 'subheading', { size: hug }),
        row([button('Sign in', 'ghost'), button('Get started')], { size: hug, name: 'Actions', layout: { direction: 'row', gap: 'sm', padding: 'none', align: 'center', justify: 'end' } }),
      ], { name: 'Top bar', layout: { direction: 'row', gap: 'md', padding: 'none', align: 'center', justify: 'between' } }),
      stack([
        text('Launch', 'label', { color: 'accent', align: 'center' }),
        text('Build the thing people keep asking for', 'title', { align: 'center' }),
        text('One sentence on what it does and who it is for. Keep it short enough to read in a breath.', 'body', { align: 'center' }),
        row([button('Get started'), button('See how it works', 'secondary')], { size: hug, name: 'Buttons', layout: { direction: 'row', gap: 'sm', padding: 'none', align: 'center', justify: 'center' } }),
      ], { name: 'Hero', layout: { direction: 'column', gap: 'md', padding: 'xl', align: 'center', justify: 'start' } }),
      image({ ratio: '16:9', name: 'Hero image' }),
      frame(id('frame'), {
        name: 'Features',
        layout: { direction: 'grid', gap: 'md', padding: 'none', align: 'stretch', justify: 'start', columns: 3 },
        children: [
          card([text('Fast', 'subheading'), text('Say why speed matters to the person reading.', 'body')]),
          card([text('Simple', 'subheading'), text('Name the one thing they no longer have to do.', 'body')]),
          card([text('Yours', 'subheading'), text('Explain what they keep control of.', 'body')]),
        ],
      }),
    ]),
  },
  {
    id: 'signup', name: 'Sign up', hint: 'A form that runs an action',
    make: (name, route) => page(name, route, [
      card([
        text('Create your account', 'heading'),
        text('It takes less than a minute.', 'body'),
        input('name', 'Name', 'Ada Lovelace'),
        input('email', 'Email', 'you@example.com', 'email'),
        input('password', 'Password', 'At least 8 characters', 'password'),
        button('Create account', 'primary', { size: fillW }),
        text('By continuing you agree to the terms.', 'caption', { align: 'center' }),
      ], { name: 'Form', size: { w: { mode: 'fixed', px: 420 }, h: { mode: 'hug' } },
        layout: { direction: 'column', gap: 'md', padding: 'xl', align: 'stretch', justify: 'start' } }),
    ], { align: 'center', padding: '2xl' }),
  },
  {
    id: 'gallery', name: 'Gallery', hint: 'A grid of pictures',
    make: (name, route) => page(name, route, [
      text(name, 'title'),
      text('A short line about what these pictures are.', 'body'),
      { id: id('gallery'), kind: 'gallery', size: fillW, images: [], columns: 3, ratio: '4:3', gap: 'md', radius: 'md' },
    ]),
  },
  {
    id: 'dashboard', name: 'Dashboard', hint: 'Numbers up top, a list below',
    make: (name, route) => page(name, route, [
      row([text(name, 'heading', { size: hug }), button('New', 'primary')], { name: 'Header', layout: { direction: 'row', gap: 'md', padding: 'none', align: 'center', justify: 'between' } }),
      frame(id('frame'), {
        name: 'Stats',
        layout: { direction: 'grid', gap: 'md', padding: 'none', align: 'stretch', justify: 'start', columns: 3 },
        children: [
          card([text('Customers', 'label', { color: 'muted' }), text('128', 'heading')]),
          card([text('Revenue', 'label', { color: 'muted' }), text('$24,310', 'heading')]),
          card([text('Open orders', 'label', { color: 'muted' }), text('17', 'heading')]),
        ],
      }),
      card([
        text('Recent', 'subheading'),
        stack([
          row([text('Customer name', 'body', { color: 'text' }), text('$1,240', 'body', { size: hug, align: 'end' })],
            { name: 'Line', layout: { direction: 'row', gap: 'md', padding: 'sm', align: 'center', justify: 'between' } }),
        ], { name: 'List', layout: { direction: 'column', gap: 'none', padding: 'none', align: 'stretch', justify: 'start' } }),
      ]),
    ]),
  },
];
