import type { ColorToken, FrameNode, NodeId, Radius, Shadow, Space, UiDoc, UiNode } from './types.ts';
import { themeById, type Theme } from './themes.ts';
import { readableColor } from './render.ts';
import { CATALOG } from './catalog.ts';
import { blankDoc, find, update } from './ops.ts';

/**
 * Styles set by hand on the site canvas, kept as the page theme's tokens
 * wherever the element has a token for them.
 *
 * The canvas speaks CSS: "color: #3D63DD", "padding: 24px". Saved as CSS,
 * that colour is stuck at that blue forever, and switching the page to a
 * dark theme leaves it behind. Saved as `accent`, it is the theme's accent
 * in every theme, which is what someone who picked the theme's own blue
 * meant. So a value that is one of the theme's own becomes that token, and
 * anything the tokens cannot say (where it was dragged to, a margin, a width,
 * a colour the theme does not have) stays CSS exactly as before.
 */

const COLOR_LABELS: Record<ColorToken, string> = {
  page: 'Page', surface: 'Surface', raised: 'Raised', accent: 'Accent', accentSoft: 'Soft accent',
  text: 'Text', muted: 'Muted', inverse: 'Inverse', danger: 'Danger', success: 'Success',
};

/** What the canvas's style panel can offer so that a pick lands exactly on a token. */
export interface ThemeChoices {
  /** The theme's id, like `clean`. */
  theme: string;
  colors: { token: ColorToken; label: string; value: string }[];
  space: { token: Space; value: string }[];
  radius: { token: Radius; value: string }[];
}

/** The page theme's palette and steps, in the theme's own order. */
export function themeChoices(doc: UiDoc): ThemeChoices {
  const theme = themeById(doc.theme);
  return {
    theme: theme.id,
    colors: (Object.keys(theme.colors) as ColorToken[]).map((token) => ({ token, label: COLOR_LABELS[token], value: theme.colors[token] })),
    space: (Object.keys(theme.space) as Space[]).map((token) => ({ token, value: theme.space[token] })),
    radius: (Object.keys(theme.radius) as Radius[]).map((token) => ({ token, value: theme.radius[token] })),
  };
}

// ---------------------------------------------------------------- colours

/** #rgb, #rrggbb, rgb() or rgba(), as 0-255 channels. Anything see-through is not a theme colour. */
export function parseColor(value: string): [number, number, number] | undefined {
  const v = value.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    if (full.length === 8 && full.slice(6) !== 'ff') return undefined;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/.exec(v);
  if (!rgb) return undefined;
  const alpha = rgb[4];
  if (alpha !== undefined && parseFloat(alpha) !== (alpha.endsWith('%') ? 100 : 1)) return undefined;
  const channels = [rgb[1], rgb[2], rgb[3]].map(Number);
  if (channels.some((c) => !(c >= 0 && c <= 255))) return undefined;
  return channels.map(Math.round) as [number, number, number];
}

/** CIE Lab, from sRGB with a D65 white: the space in which equal distances look equally different. */
function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/**
 * How far apart two colours look (CIE76 ΔE, plain distance in Lab).
 *
 * About 2.3 is the smallest difference most people can see with the two side
 * by side. A colour within 3 of a theme colour reads as that colour: it is
 * the theme's blue picked by eye off the page, or nudged a step by a colour
 * picker. Further than that it is most likely a different colour on purpose,
 * so it is kept exactly as picked.
 */
const CLOSE = 3;

function distance(a: [number, number, number], b: [number, number, number]): number {
  const [p, q] = [lab(a), lab(b)];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

// When a theme has one colour under several names (Mono's page, surface and
// inverse are all white), the name that suits the job wins: white words are
// `inverse`, a white box is `surface`.
const TEXT_ORDER: ColorToken[] = ['text', 'muted', 'accent', 'inverse', 'danger', 'success', 'surface', 'page', 'raised', 'accentSoft'];
const FILL_ORDER: ColorToken[] = ['surface', 'page', 'raised', 'accentSoft', 'accent', 'text', 'muted', 'inverse', 'danger', 'success'];

/** The theme colour a value is, or is genuinely close to, among those `allowed`. */
function colorToken(theme: Theme, value: string, order: ColorToken[], allowed: (token: ColorToken) => boolean = () => true): ColorToken | undefined {
  const picked = parseColor(value);
  if (!picked) return undefined;
  let best: { token: ColorToken; far: number } | undefined;
  for (const token of order) {
    const own = parseColor(theme.colors[token]);
    if (!own || !allowed(token)) continue;
    const far = distance(picked, own);
    if (far <= CLOSE && (!best || far < best.far)) best = { token, far };
  }
  return best?.token;
}

// ---------------------------------------------------------------- sizes

/** `16px`, or a bare `0`, as a number of pixels. Other units are left as CSS. */
function pixels(value: string): number | undefined {
  const m = /^(-?\d*\.?\d+)(px)?$/i.exec(value.trim());
  if (!m || (!m[2] && Number(m[1]) !== 0)) return undefined;
  return Number(m[1]);
}

/** The first step of a scale drawn at exactly this size. The scale's own order puts `none` first for 0. */
function step<T extends string>(scale: Record<T, string>, value: string): T | undefined {
  const px = pixels(value);
  if (px === undefined) return undefined;
  return (Object.keys(scale) as T[]).find((token) => pixels(scale[token]) === px);
}

const shadowText = (value: string): string =>
  value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*([(),])\s*/g, '$1');

// ---------------------------------------------------------------- the edit

type Patch = Record<string, unknown>;

/**
 * A CSS property this element keeps as a token.
 *
 *   keys   the CSS it replaces, removed when the token is set: `padding` also
 *          takes `padding-top` and the rest, as the shorthand would in CSS
 *   match  the token for a value, or nothing to keep the value as CSS
 *   reset  what clearing it goes back to
 */
interface Field {
  keys: string[];
  match: (value: string) => Patch | undefined;
  reset: () => Patch;
}

/**
 * Where an element started: the catalog's version of its kind (a Card for a
 * card, a Title for a title), or the page as a blank page has it. This is what
 * clearing a token-backed style goes back to, since the document does not
 * remember what the token was before the canvas changed it.
 */
function startingPoint(doc: UiDoc, node: UiNode): UiNode {
  if (node.id === doc.root.id) return blankDoc().root;
  const made = CATALOG.filter((entry) => entry.kind === node.kind).map((entry) => entry.make((kind) => kind));
  const same = made.find((m) => m.kind === 'text' && node.kind === 'text' ? m.variant === node.variant : m.name !== undefined && m.name === node.name);
  return same ?? made[0]!;
}

/** What the element sits on: the fill of the nearest frame around it that has one. */
function backdropOf(doc: UiDoc, id: NodeId): ColorToken {
  const path = find(doc, id)?.path ?? [];
  for (let i = path.length - 2; i >= 0; i--) {
    const above = find(doc, path[i]!)?.node;
    if (above?.kind === 'frame' && above.fill) return above.fill;
  }
  return 'page';
}

function fieldFor(doc: UiDoc, theme: Theme, node: UiNode, name: string): Field | undefined {
  // Only worked out when something is cleared.
  const start = (): Record<string, unknown> => startingPoint(doc, node) as never;
  const background = name === 'background' || name === 'background-color';
  if (name === 'color' && (node.kind === 'text' || node.kind === 'link')) {
    // Text is drawn in its token only where that reads on what is behind it
    // (render.ts swaps an unreadable one). A token that would be swapped
    // would not draw the colour that was picked, so it stays CSS.
    const behind = backdropOf(doc, node.id);
    const drawnAsIs = (token: ColorToken): boolean => readableColor(theme, token, behind) === theme.colors[token];
    return {
      keys: ['color'],
      match: (value) => {
        const token = colorToken(theme, value, TEXT_ORDER, drawnAsIs);
        return token && { color: token };
      },
      reset: () => ({ color: start()['color'] }),
    };
  }
  if (background && (node.kind === 'frame' || node.kind === 'divider')) {
    const key = node.kind === 'frame' ? 'fill' : 'color';
    return {
      keys: ['background', 'background-color'],
      match: (value) => {
        // A frame with no fill draws no background at all.
        if (node.kind === 'frame' && /^(transparent|none)$/i.test(value.trim())) return { fill: null };
        const token = colorToken(theme, value, FILL_ORDER);
        return token && { [key]: token };
      },
      reset: () => ({ [key]: start()[key] }),
    };
  }
  if ((name === 'padding' || name === 'gap') && node.kind === 'frame') {
    const keys = name === 'padding' ? ['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left'] : ['gap', 'row-gap', 'column-gap'];
    return {
      keys,
      match: (value) => {
        const token = step(theme.space, value);
        return token && { layout: { ...node.layout, [name]: token } };
      },
      reset: () => ({ layout: { ...node.layout, [name]: (start()['layout'] as FrameNode['layout'] | undefined)?.[name] ?? 'md' } }),
    };
  }
  if (name === 'gap' && node.kind === 'gallery') {
    return {
      keys: ['gap', 'row-gap', 'column-gap'],
      match: (value) => {
        const token = step(theme.space, value);
        return token && { gap: token };
      },
      reset: () => ({ gap: start()['gap'] }),
    };
  }
  // A gallery's radius rounds each picture, not the gallery, so a radius set
  // on the gallery itself is a different thing and stays CSS.
  if (name === 'border-radius' && (node.kind === 'frame' || node.kind === 'image')) {
    return {
      keys: ['border-radius', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
      match: (value) => {
        const token = step(theme.radius, value);
        return token && { radius: token };
      },
      reset: () => ({ radius: start()['radius'] }),
    };
  }
  if (name === 'box-shadow' && node.kind === 'frame') {
    return {
      keys: ['box-shadow'],
      match: (value) => {
        const token = (Object.keys(theme.shadow) as Shadow[]).find((s) => shadowText(theme.shadow[s]) === shadowText(value));
        return token && { shadow: token };
      },
      reset: () => ({ shadow: start()['shadow'] }),
    };
  }
  // A text variant is more than a size: it is a weight, a line height, a
  // font, a heading or a paragraph, and a size for phones. Swapping the
  // variant to match a size would change all of those, which nobody asked
  // for, so a font size stays CSS. The one sure case is the size the variant
  // already draws, which needs no CSS at all.
  if (name === 'font-size' && node.kind === 'text') {
    return {
      keys: ['font-size'],
      match: (value) => pixels(value) !== undefined && pixels(value) === pixels(theme.text[node.variant].size) ? {} : undefined,
      reset: () => ({}),
    };
  }
  return undefined;
}

/**
 * A `style` edit from the canvas, applied to one element: tokens where the
 * element has them and the value is the theme's own, CSS for the rest.
 *
 * Clearing a style (null or '') clears it whichever way it was kept. If it
 * was CSS, the CSS goes and the element's own settings show again, the same
 * as before tokens were involved. If it was a token, the token goes back to
 * where the element started (see `startingPoint`).
 */
export function applyStyle(doc: UiDoc, id: NodeId, props: Record<string, string | null>): UiDoc {
  const found = find(doc, id)?.node;
  if (!found) return doc;
  const theme = themeById(doc.theme);
  let node: UiNode = found;
  const css: Record<string, string> = { ...(node.css ?? {}) };
  for (const [name, value] of Object.entries(props)) {
    const field = fieldFor(doc, theme, node, name);
    const clearing = value === null || value === '';
    if (!field) {
      if (clearing) delete css[name];
      else css[name] = String(value);
      continue;
    }
    if (clearing) {
      const wasCss = field.keys.some((key) => key in css);
      field.keys.forEach((key) => delete css[key]);
      if (!wasCss) node = { ...node, ...field.reset() } as UiNode;
      continue;
    }
    const patch = field.match(String(value));
    if (!patch) {
      css[name] = String(value);
      continue;
    }
    field.keys.forEach((key) => delete css[key]);
    node = { ...node, ...patch } as UiNode;
  }
  return update(doc, id, { ...node, css: Object.keys(css).length ? css : undefined } as never);
}
