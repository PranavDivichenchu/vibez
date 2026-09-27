import type { NodeId, TextVariant, UiNode } from './types.ts';
import { frame } from './catalog.ts';

/**
 * The site canvas's element library, made out of a drawn page's own parts.
 *
 * The canvas offers the same library on every page: a title, a card, a hero,
 * a contact form. On a page written in HTML it pastes in HTML. On a `.ui`
 * page there is no HTML to paste into, so each item is built from the
 * elements the page is made of — a card is a raised frame holding a heading,
 * some text and a link — and it arrives looking the way the page's theme
 * draws things, not in borrowed markup.
 *
 * Returns undefined for the few items a drawn page has no part for (a video,
 * an embed, a map), so the canvas can say so instead of guessing.
 */
export function libraryNode(element: string, id: (kind: string) => NodeId): UiNode | undefined {
  const hug = { w: { mode: 'hug' as const }, h: { mode: 'hug' as const } };
  const fillW = { w: { mode: 'fill' as const }, h: { mode: 'hug' as const } };
  const text = (words: string, variant: TextVariant = 'body', color: 'text' | 'muted' = 'text'): UiNode =>
    ({ id: id('text'), kind: 'text', size: fillW, text: words, variant, align: 'start', color });
  const button = (label: string, variant: 'primary' | 'secondary' | 'ghost' = 'primary'): UiNode =>
    ({ id: id('button'), kind: 'button', size: hug, label, variant });
  const link = (label: string): UiNode =>
    ({ id: id('link'), kind: 'link', size: hug, label, to: '#', color: 'accent' });
  const image = (alt: string): UiNode =>
    ({ id: id('image'), kind: 'image', size: fillW, src: '', alt, ratio: '16:9', fit: 'cover', radius: 'md' });
  const input = (field: string, label: string, placeholder: string, inputType: 'text' | 'email' | 'multiline' = 'text'): UiNode =>
    ({ id: id('input'), kind: 'input', size: fillW, field, label, placeholder, inputType });
  const card = (children: UiNode[]): UiNode =>
    frame(id('frame'), { name: 'Card', fill: 'surface', radius: 'md', border: true, shadow: 'soft', layout: { direction: 'column', gap: 'sm', padding: 'lg', align: 'stretch', justify: 'start' }, children });
  const row = (children: UiNode[], name = 'Row'): UiNode =>
    frame(id('frame'), { name, layout: { direction: 'row', gap: 'md', padding: 'none', align: 'center', justify: 'start', stackOnPhone: true }, children });

  switch (element) {
    case 'title': return text('A big, clear title', 'title');
    case 'heading': return text('Section heading', 'heading');
    case 'subheading': return text('Subheading', 'subheading');
    case 'paragraph': return text('Write something here. Double-click any text on the canvas to change it.');
    case 'lead': return text('An opening sentence that sets the scene, a little larger than the rest.', 'subheading', 'muted');
    case 'small': return text('Small print, a note or a caption.', 'caption', 'muted');
    case 'quote': return frame(id('frame'), { name: 'Quote', layout: { direction: 'column', gap: 'xs', padding: 'md', align: 'stretch', justify: 'start' },
      children: [text('“A line worth showing bigger.”', 'subheading'), text('Someone worth quoting', 'caption', 'muted')] });
    case 'bullets': return text('• First point\n• Second point\n• Third point');
    case 'numbers': return text('1. First step\n2. Second step\n3. Third step');
    case 'link': return link('Read more');
    case 'button': return button('Button');
    case 'button-outline': return button('Button', 'secondary');
    case 'button-big': return button('Book now');
    case 'button-pair': return row([button('Get started'), button('Learn more', 'secondary')], 'Buttons');
    case 'image': return image('Describe the picture');
    case 'figure': return frame(id('frame'), { name: 'Figure', layout: { direction: 'column', gap: 'xs', padding: 'none', align: 'stretch', justify: 'start' },
      children: [image('Describe the picture'), text('A caption for the picture.', 'caption', 'muted')] });
    case 'gallery': return { id: id('gallery'), kind: 'gallery', size: fillW, images: [], columns: 3, ratio: '1:1', gap: 'sm', radius: 'md' };
    case 'divider': return { id: id('divider'), kind: 'divider', size: fillW, color: 'raised' };
    case 'spacer': return { ...frame(id('frame'), { name: 'Spacer' }), css: { height: '48px' } };
    case 'section': return frame(id('frame'), { name: 'Section', layout: { direction: 'column', gap: 'sm', padding: 'xl', align: 'stretch', justify: 'start' },
      children: [text('New section', 'heading'), text('Add what this part of the page is about.')] });
    case 'card': return card([text('Card title', 'subheading'), text('A short description.'), link('Learn more')]);
    case 'columns-2': return row([
      frame(id('frame'), { name: 'Column', children: [text('Left column', 'subheading'), text('Text for the left side.')] }),
      frame(id('frame'), { name: 'Column', children: [text('Right column', 'subheading'), text('Text for the right side.')] }),
    ], 'Columns');
    case 'cards-3': return frame(id('frame'), { name: 'Cards', layout: { direction: 'grid', gap: 'md', padding: 'none', align: 'stretch', justify: 'start', columns: 3 },
      children: ['First', 'Second', 'Third'].map((n) => card([text(n, 'subheading'), text('Describe it in a sentence.')])) });
    case 'callout': return frame(id('frame'), { name: 'Callout', fill: 'accentSoft', radius: 'md', layout: { direction: 'column', gap: 'xs', padding: 'md', align: 'stretch', justify: 'start' },
      children: [text('Good to know', 'label'), text('Something visitors should not miss.')] });
    case 'hero': return frame(id('frame'), { name: 'Hero', layout: { direction: 'column', gap: 'md', padding: 'xl', align: 'start', justify: 'start' },
      children: [text('A headline that says what you do', 'title'), text('One sentence about who it is for and why it matters.', 'subheading', 'muted'), button('Get started')] });
    case 'contact-form': return frame(id('frame'), { name: 'Contact form', layout: { direction: 'column', gap: 'sm', padding: 'none', align: 'stretch', justify: 'start' },
      children: [input('name', 'Your name', 'Jane Doe'), input('email', 'Email', 'you@example.com', 'email'), input('message', 'Message', 'How can we help?', 'multiline'), button('Send message')] });
    case 'newsletter': return row([input('email', 'Email', 'you@example.com', 'email'), button('Subscribe')], 'Newsletter');
    default: return undefined;
  }
}
