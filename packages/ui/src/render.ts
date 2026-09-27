import type { ActionRef, ColorToken, FrameNode, Ratio, Sizing, UiDoc, UiNode, ValueRef } from './types.ts';
import { themeById, type Theme } from './themes.ts';
import { asText, resolve, type Scope } from './links.ts';

/**
 * A page as a tree of plain element descriptions.
 *
 * One function draws the page for everyone: the editor's canvas turns this
 * into DOM, and the compiler turns it into HTML and CSS. So what you arrange is
 * what ships, down to the pixel, instead of a mockup that the real page only
 * resembles.
 */
export interface VNode {
  tag: string;
  attrs: Record<string, string>;
  /** CSS properties, kebab-case. */
  style: Record<string, string>;
  /** Overrides on a phone-sized screen. */
  phone?: Record<string, string>;
  text?: string;
  children: VNode[];
  /** The page element this draws. Missing on inner parts and repeated copies. */
  nodeId?: string;
  /** What the running page fills in. */
  bind?: { kind: 'text' | 'src' | 'gallery' | 'repeat'; ref: ValueRef };
  action?: ActionRef;
  /** For a repeating frame: its children, drawn once, for the running page to copy per item. */
  template?: VNode[];
}

export type Mode = 'design' | 'preview' | 'compile';

export interface RenderOptions {
  mode: Mode;
  scope: Scope;
  /** Draw as a phone-sized screen, which applies "stack on phone". */
  phone?: boolean;
  /** How far a repeating frame is drawn on the canvas. */
  maxRepeat?: number;
  /** Where a link to another page goes: `about.ui` becomes `/about`. */
  routeOf?: (to: string) => string;
}

const RATIO: Record<Ratio, string | undefined> = {
  free: undefined, '1:1': '1 / 1', '4:3': '4 / 3', '3:2': '3 / 2', '16:9': '16 / 9', '3:4': '3 / 4', '9:16': '9 / 16',
};

const ALIGN: Record<string, string> = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', between: 'space-between' };

/** How big a node is, which depends on which way its parent stacks. */
function sizeStyle(size: { w: Sizing; h: Sizing }, parent: FrameNode | undefined, phone: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  if (!parent) {
    out['width'] = '100%';
    out['min-height'] = '100%';
    return out;
  }
  const stacked = parent.layout.direction === 'row' && phone && parent.layout.stackOnPhone === true;
  const direction = stacked ? 'column' : parent.layout.direction;
  // A row that stacks on a phone stretches its children, like any column.
  const align = stacked ? 'stretch' : parent.layout.align;
  const main = direction === 'row' ? 'w' : 'h';
  for (const axis of ['w', 'h'] as const) {
    const s = size[axis];
    const dim = axis === 'w' ? 'width' : 'height';
    if (direction === 'grid') {
      if (s.mode === 'fixed') out[dim] = `${s.px}px`;
      if (axis === 'w' && s.mode === 'hug') out['justify-self'] = 'start';
      continue;
    }
    if (axis === main) {
      if (s.mode === 'fill') {
        out['flex'] = '1 1 0';
        out[axis === 'w' ? 'min-width' : 'min-height'] = '0';
      } else if (s.mode === 'fixed') {
        out[dim] = `${s.px}px`;
        out['flex'] = 'none';
      } else {
        out['flex'] = 'none';
      }
    } else if (s.mode === 'fill') {
      out['align-self'] = 'stretch';
      if (axis === 'w') out['width'] = 'auto';
    } else {
      if (s.mode === 'fixed') out[dim] = `${s.px}px`;
      // A hugging child in a stretching stack sits at the start instead of stretching.
      if (align === 'stretch') out['align-self'] = 'flex-start';
      if (axis === 'w' && s.mode === 'hug') out['max-width'] = '100%';
    }
  }
  return out;
}

const el = (tag: string, style: Record<string, string> = {}, extra: Partial<VNode> = {}): VNode =>
  ({ tag, attrs: {}, style, children: [], ...extra });

export function renderDoc(doc: UiDoc, options: RenderOptions): VNode {
  const theme = themeById(doc.theme);
  const root = renderNode(doc.root, undefined, theme, options, options.scope, 'page');
  root.style['font-family'] = theme.font.body;
  root.style['color'] = theme.colors.text;
  root.style['-webkit-font-smoothing'] = 'antialiased';
  root.style['box-sizing'] = 'border-box';
  return root;
}

/** How light a colour is to the eye (WCAG relative luminance), from #rrggbb. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/**
 * The colour a piece of text is drawn in, on whatever it sits on. Text in
 * the same colour as its background (accent words on an accent chip) would
 * vanish, so below a readable contrast it becomes the theme's text or
 * inverse colour, whichever reads better there.
 */
export function readableColor(theme: Theme, token: ColorToken, backdrop: ColorToken): string {
  const color = theme.colors[token];
  const behind = theme.colors[backdrop];
  if (contrast(color, behind) >= 2.5) return color;
  return contrast(theme.colors.text, behind) >= contrast(theme.colors.inverse, behind) ? theme.colors.text : theme.colors.inverse;
}

function renderNode(node: UiNode, parent: FrameNode | undefined, theme: Theme, options: RenderOptions, scope: Scope, backdrop: ColorToken): VNode {
  const phone = options.phone ?? false;
  const desk = sizeStyle(node.size, parent, false);
  const mobile = sizeStyle(node.size, parent, true);
  const style: Record<string, string> = { 'box-sizing': 'border-box', ...(phone ? mobile : desk) };
  // What changes on a phone, for the compiled page's media query.
  const sizePhone: Record<string, string> = {};
  for (const key of new Set([...Object.keys(desk), ...Object.keys(mobile)])) {
    if (desk[key] !== mobile[key]) sizePhone[key] = mobile[key] ?? 'unset';
  }
  let out: VNode;
  switch (node.kind) {
    case 'frame': out = renderFrame(node, theme, options, scope, style, backdrop); break;
    case 'text': out = renderText(node, theme, options, scope, style, backdrop); break;
    case 'button': out = renderButton(node, theme, style); break;
    case 'input': out = renderInput(node, theme, options, scope, style); break;
    case 'image': out = renderImage(node, theme, options, scope, style); break;
    case 'gallery': out = renderGallery(node, theme, options, scope, style); break;
    case 'link': {
      out = el('a', {
        ...style, color: readableColor(theme, node.color, backdrop), 'text-decoration': 'underline', 'text-underline-offset': '3px',
        'font-size': theme.text.body.size, 'font-weight': '500', cursor: 'pointer',
      }, { text: node.label });
      const to = node.to.endsWith('.ui') && options.routeOf ? options.routeOf(node.to) : node.to;
      if (to) out.attrs['href'] = to;
      if (node.to.endsWith('.ui')) out.action = { run: 'navigate', to: node.to };
      break;
    }
    case 'divider':
      out = el('div', { ...style, height: '1px', 'min-height': '1px', background: theme.colors[node.color], 'align-self': 'stretch' });
      out.attrs['role'] = 'separator';
      break;
  }
  if (Object.keys(sizePhone).length) out.phone = { ...sizePhone, ...out.phone };
  if (node.hidden) {
    if (options.mode === 'design') out.style['opacity'] = '0.35';
    else out.style['display'] = 'none';
  }
  out.nodeId = node.id;
  return out;
}

function frameLayout(node: FrameNode, theme: Theme): { style: Record<string, string>; phone: Record<string, string> | undefined } {
  const l = node.layout;
  const style: Record<string, string> = {
    gap: theme.space[l.gap],
    padding: theme.space[l.padding],
  };
  if (l.direction === 'grid') {
    style['display'] = 'grid';
    style['grid-template-columns'] = `repeat(${Math.max(1, l.columns ?? 3)}, minmax(0, 1fr))`;
    style['align-items'] = ALIGN[l.align] ?? 'stretch';
  } else {
    style['display'] = 'flex';
    style['flex-direction'] = l.direction;
    style['align-items'] = ALIGN[l.align] ?? 'stretch';
    style['justify-content'] = ALIGN[l.justify] ?? 'flex-start';
  }
  if (node.fill) style['background'] = theme.colors[node.fill];
  if (node.radius !== 'none') style['border-radius'] = theme.radius[node.radius];
  if (node.border) style['border'] = `1px solid ${theme.colors.raised}`;
  if (node.shadow !== 'none') style['box-shadow'] = theme.shadow[node.shadow];
  if (node.on) style['cursor'] = 'pointer';

  let phone: Record<string, string> | undefined;
  if (l.direction === 'row' && l.stackOnPhone) phone = { 'flex-direction': 'column', 'align-items': 'stretch', 'justify-content': 'flex-start' };
  if (l.direction === 'grid' && (l.columns ?? 3) > 2) phone = { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' };
  return { style, phone };
}

function renderFrame(node: FrameNode, theme: Theme, options: RenderOptions, scope: Scope, style: Record<string, string>, backdrop: ColorToken): VNode {
  const layout = frameLayout(node, theme);
  const out = el(node.id === 'page' ? 'main' : 'div', { ...style, ...layout.style });
  if (layout.phone) {
    out.phone = layout.phone;
    if (options.phone) Object.assign(out.style, layout.phone);
  }
  if (node.on) out.action = node.on;

  // Children sit on this frame's fill, or on whatever it sits on when it has none.
  const behind: ColorToken = node.fill ?? backdrop;
  const drawChildren = (childScope: Scope): VNode[] => node.children.map((child) => renderNode(child, node, theme, options, childScope, behind));

  if (node.repeat) {
    out.bind = { kind: 'repeat', ref: node.repeat };
    const list = resolve(node.repeat, scope);
    const items = Array.isArray(list) ? list : [];
    if (options.mode === 'compile') {
      out.template = drawChildren({ ...scope, item: items[0] });
      return out;
    }
    if (items.length === 0) {
      out.children = drawChildren({ ...scope, item: undefined });
      return out;
    }
    const limit = options.mode === 'design' ? (options.maxRepeat ?? 6) : items.length;
    items.slice(0, limit).forEach((item, index) => {
      const drawn = drawChildren({ ...scope, item });
      if (index > 0) drawn.forEach(markCopy);
      out.children.push(...drawn);
    });
    return out;
  }

  out.children = drawChildren(scope);
  if (options.mode === 'design' && node.children.length === 0) out.attrs['data-ui-empty'] = '1';
  return out;
}

/** A repeated copy shows the design but is not itself editable: clicks go to the original. */
function markCopy(node: VNode): void {
  if (node.nodeId) node.attrs['data-ui-copy'] = node.nodeId;
  delete node.nodeId;
  node.children.forEach(markCopy);
}

const TEXT_TAG = { title: 'h1', heading: 'h2', subheading: 'h3', body: 'p', caption: 'p', label: 'span' } as const;

function renderText(node: Extract<UiNode, { kind: 'text' }>, theme: Theme, options: RenderOptions, scope: Scope, style: Record<string, string>, backdrop: ColorToken): VNode {
  const t = theme.text[node.variant];
  const shown = node.bind ? asText(resolve(node.bind, scope)) : undefined;
  const out = el(TEXT_TAG[node.variant], {
    ...style,
    margin: '0',
    'font-family': t.display ? theme.font.display : theme.font.body,
    'font-size': t.size,
    'font-weight': String(t.weight),
    'line-height': t.line,
    color: readableColor(theme, node.color, backdrop),
    'text-align': node.align === 'start' ? 'left' : node.align === 'end' ? 'right' : 'center',
    'overflow-wrap': 'break-word',
    ...(t.tracking ? { 'letter-spacing': t.tracking } : {}),
    ...(node.variant === 'label' ? { 'text-transform': 'uppercase', display: 'block' } : {}),
  }, { text: shown ?? node.text });
  if (t.phone) {
    out.phone = { 'font-size': t.phone };
    if (options.phone) out.style['font-size'] = t.phone;
  }
  if (node.bind) out.bind = { kind: 'text', ref: node.bind };
  return out;
}

function renderButton(node: Extract<UiNode, { kind: 'button' }>, theme: Theme, style: Record<string, string>): VNode {
  const c = theme.colors;
  const look: Record<string, Record<string, string>> = {
    primary: { background: c.accent, color: c.inverse, border: `1px solid ${c.accent}` },
    secondary: { background: c.accentSoft, color: c.accent, border: `1px solid ${c.accentSoft}` },
    ghost: { background: 'transparent', color: c.text, border: `1px solid ${c.raised}` },
    danger: { background: c.danger, color: c.inverse, border: `1px solid ${c.danger}` },
  };
  const out = el('button', {
    ...style,
    ...look[node.variant],
    display: 'inline-flex', 'align-items': 'center', 'justify-content': 'center', gap: '8px',
    padding: '10px 18px', 'border-radius': theme.radius.md, 'font-family': theme.font.body,
    'font-size': theme.text.body.size, 'font-weight': '600', 'line-height': '1.2', cursor: 'pointer', 'white-space': 'nowrap',
  }, { text: node.label });
  out.attrs['type'] = 'button';
  if (node.on) out.action = node.on;
  return out;
}

function renderInput(node: Extract<UiNode, { kind: 'input' }>, theme: Theme, options: RenderOptions, scope: Scope, style: Record<string, string>): VNode {
  const c = theme.colors;
  const wrapper = el('label', { ...style, display: 'flex', 'flex-direction': 'column', gap: '6px' });
  if (node.label) {
    wrapper.children.push(el('span', { 'font-size': theme.text.caption.size, 'font-weight': '600', color: c.text }, { text: node.label }));
  }
  const multiline = node.inputType === 'multiline';
  const field = el(multiline ? 'textarea' : 'input', {
    'box-sizing': 'border-box', width: '100%', padding: '10px 12px', 'border-radius': theme.radius.md,
    border: `1px solid ${c.raised}`, background: c.surface, color: c.text, font: 'inherit',
    'font-size': theme.text.body.size, outline: 'none', ...(multiline ? { 'min-height': '96px', resize: 'vertical' } : {}),
  });
  field.attrs['name'] = node.field;
  field.attrs['placeholder'] = node.placeholder;
  if (!multiline) field.attrs['type'] = node.inputType;
  if (node.required) field.attrs['required'] = '';
  const typed = scope.inputs?.[node.field];
  if (typed !== undefined && options.mode !== 'compile') field.attrs['value'] = typed;
  // On the canvas an input is a picture of an input: clicking it selects it.
  if (options.mode === 'design') {
    field.attrs['tabindex'] = '-1';
    field.attrs['readonly'] = '';
    field.style['pointer-events'] = 'none';
  }
  if (node.on) wrapper.action = node.on;
  wrapper.children.push(field);
  return wrapper;
}

function emptyPicture(theme: Theme, ratio: string | undefined, radius: string, words: string): VNode {
  return el('div', {
    'box-sizing': 'border-box', width: '100%', ...(ratio ? { 'aspect-ratio': ratio } : { height: '160px' }),
    'border-radius': radius, display: 'flex', 'align-items': 'center', 'justify-content': 'center',
    background: `repeating-linear-gradient(135deg, ${theme.colors.raised} 0 10px, ${theme.colors.surface} 10px 20px)`,
    color: theme.colors.muted, 'font-size': theme.text.caption.size,
  }, { text: words });
}

function renderImage(node: Extract<UiNode, { kind: 'image' }>, theme: Theme, options: RenderOptions, scope: Scope, style: Record<string, string>): VNode {
  const src = node.bind ? String(resolve(node.bind, scope) ?? '') : node.src;
  const ratio = RATIO[node.ratio];
  const radius = theme.radius[node.radius];
  if (!src && options.mode !== 'compile') {
    const box = emptyPicture(theme, ratio, radius, options.mode === 'design' ? 'Add an image' : '');
    Object.assign(box.style, style);
    if (node.bind) box.bind = { kind: 'src', ref: node.bind };
    return box;
  }
  const out = el('img', {
    ...style, display: 'block', 'max-width': '100%', 'object-fit': node.fit, 'border-radius': radius,
    ...(ratio ? { 'aspect-ratio': ratio } : {}), background: theme.colors.raised,
    ...(node.size.w.mode !== 'fixed' ? { width: '100%' } : {}),
  });
  out.attrs['src'] = src;
  out.attrs['alt'] = node.alt;
  if (options.mode === 'design') out.attrs['draggable'] = 'false';
  if (node.bind) out.bind = { kind: 'src', ref: node.bind };
  return out;
}

function renderGallery(node: Extract<UiNode, { kind: 'gallery' }>, theme: Theme, options: RenderOptions, scope: Scope, style: Record<string, string>): VNode {
  const ratio = RATIO[node.ratio];
  const radius = theme.radius[node.radius];
  const out = el('div', {
    ...style, display: 'grid', gap: theme.space[node.gap],
    'grid-template-columns': `repeat(${Math.max(1, node.columns)}, minmax(0, 1fr))`,
  });
  if (node.columns > 2) out.phone = { 'grid-template-columns': 'repeat(2, minmax(0, 1fr))' };
  if (options.phone && out.phone) Object.assign(out.style, out.phone);

  let sources = node.images;
  if (node.bind) {
    out.bind = { kind: 'gallery', ref: node.bind };
    const list = resolve(node.bind, scope);
    sources = Array.isArray(list) ? list.map((item) => typeof item === 'string' ? item : pictureOf(item)).filter(Boolean) as string[] : [];
  }
  if (sources.length === 0 && options.mode !== 'compile') {
    const count = Math.max(1, node.columns) * 2;
    for (let i = 0; i < count; i++) out.children.push(emptyPicture(theme, ratio, radius, i === 0 && options.mode === 'design' ? 'Add images' : ''));
    return out;
  }
  for (const src of sources) {
    const img = el('img', { display: 'block', width: '100%', 'object-fit': 'cover', 'border-radius': radius,
      ...(ratio ? { 'aspect-ratio': ratio } : {}), background: theme.colors.raised });
    img.attrs['src'] = src;
    img.attrs['alt'] = '';
    img.attrs['loading'] = 'lazy';
    if (options.mode === 'design') img.attrs['draggable'] = 'false';
    out.children.push(img);
  }
  return out;
}

/** The first field of an item that looks like a picture address. */
export function pictureOf(item: unknown): string | undefined {
  if (item === null || typeof item !== 'object') return undefined;
  const record = item as Record<string, unknown>;
  for (const key of ['image', 'src', 'url', 'photo', 'picture', 'thumbnail', 'avatar']) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return Object.values(record).find((v): v is string => typeof v === 'string' && /^(https?:|data:image|\/)/.test(v));
}
