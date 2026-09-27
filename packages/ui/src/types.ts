/**
 * The `.ui` document: one page of an app, as a tree of visual elements.
 *
 * A page is built from frames that stack their children, the way Figma's
 * auto layout does, rather than from boxes pinned at coordinates. Stacks are
 * what a beginner can reason about ("these go in a row"), and they compile to
 * flexbox, so the page still works at a width nobody previewed.
 *
 * Every size, space, color and radius is a token, never a raw number, except
 * a fixed width or height. Tokens are what keep a page built by dragging from
 * looking like a ransom note, and they are what lets one click restyle it: a
 * theme is nothing but a set of values for the tokens.
 *
 * The document is plain JSON so an agent (through MCP, later) can read and
 * write it as easily as the editor does.
 */

export const FORMAT = 'vibez.ui/1';

export type NodeId = string;

export type Space = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
export type Radius = 'none' | 'sm' | 'md' | 'lg' | 'full';
export type ColorToken = 'page' | 'surface' | 'raised' | 'accent' | 'accentSoft' | 'text' | 'muted' | 'inverse' | 'danger' | 'success';
export type Shadow = 'none' | 'soft' | 'lifted';

/** How big an element is along one axis. */
export type Sizing =
  | { mode: 'fill' }
  | { mode: 'hug' }
  | { mode: 'fixed'; px: number };

export interface Size {
  w: Sizing;
  h: Sizing;
}

export type Ratio = 'free' | '1:1' | '4:3' | '3:2' | '16:9' | '3:4' | '9:16';

// ---------------------------------------------------------------- links

/**
 * Where a value on the page comes from.
 *
 *   vi      an export of a `.vi` file: `orders` from `dashboard.vi`
 *   item    a field of the current item, inside a frame that repeats over a list
 *   input   what someone typed into an input on this page
 *   answer  what an action answered the last time it ran: the "Ordered
 *           sourdough!" a button's action gave back. Empty until it runs.
 */
export type ValueRef =
  | { from: 'vi'; file: string; name: string; field?: string }
  | { from: 'item'; field?: string }
  | { from: 'input'; name: string }
  | { from: 'answer'; file: string; name: string; field?: string };

/** What happens on a click or a submit. */
export type ActionRef =
  | { run: 'vi'; file: string; name: string; args?: Record<string, ValueRef> }
  | { run: 'navigate'; to: string };

// ---------------------------------------------------------------- elements

interface Base {
  id: NodeId;
  /** Shown in the layers list. Defaults to a readable name for the kind. */
  name?: string;
  size: Size;
  hidden?: boolean;
  /**
   * How this element was changed by hand on the site canvas: colours, sizes,
   * spacing, where it was dragged to. Plain CSS, laid over what the element's
   * own settings draw, so the canvas edits a drawn page exactly the way it
   * edits one written in HTML — and the change is kept in the page's file.
   */
  css?: Record<string, string>;
}

export type Direction = 'column' | 'row' | 'grid';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'between';

export interface FrameNode extends Base {
  kind: 'frame';
  layout: {
    direction: Direction;
    gap: Space;
    padding: Space;
    align: Align;
    justify: Justify;
    /** Grid only. */
    columns?: number;
    /** A row that becomes a column on a phone-sized screen. */
    stackOnPhone?: boolean;
  };
  fill: ColorToken | null;
  radius: Radius;
  border: boolean;
  shadow: Shadow;
  /** Repeat the frame's children once per item of a list. */
  repeat?: ValueRef;
  /** Frames can be a link, like a card that opens a page. */
  on?: ActionRef;
  children: UiNode[];
}

export type TextVariant = 'title' | 'heading' | 'subheading' | 'body' | 'caption' | 'label';

export interface TextNode extends Base {
  kind: 'text';
  text: string;
  variant: TextVariant;
  align: 'start' | 'center' | 'end';
  color: ColorToken;
  /** When set, the text shows this value instead, and `text` is only the stand-in. */
  bind?: ValueRef;
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonNode extends Base {
  kind: 'button';
  label: string;
  variant: ButtonVariant;
  on?: ActionRef;
}

export type InputType = 'text' | 'email' | 'number' | 'password' | 'search' | 'multiline';

export interface InputNode extends Base {
  kind: 'input';
  /** The name what someone types is saved under, for actions to read. */
  field: string;
  label: string;
  placeholder: string;
  inputType: InputType;
  required?: boolean;
  /** Pressing Enter in the input. */
  on?: ActionRef;
}

export interface ImageNode extends Base {
  kind: 'image';
  src: string;
  alt: string;
  ratio: Ratio;
  fit: 'cover' | 'contain';
  radius: Radius;
  bind?: ValueRef;
}

export interface GalleryNode extends Base {
  kind: 'gallery';
  /** Used when nothing is bound. */
  images: string[];
  columns: number;
  ratio: Ratio;
  gap: Space;
  radius: Radius;
  /** A list of image addresses, or of items with `field` holding one. */
  bind?: ValueRef;
}

export interface LinkNode extends Base {
  kind: 'link';
  label: string;
  /** A page (`about.ui`) or a web address. */
  to: string;
  color: ColorToken;
}

export interface DividerNode extends Base {
  kind: 'divider';
  color: ColorToken;
}

export type UiNode = FrameNode | TextNode | ButtonNode | InputNode | ImageNode | GalleryNode | LinkNode | DividerNode;
export type Kind = UiNode['kind'];

export interface UiDoc {
  vibez: typeof FORMAT;
  name: string;
  /** The address the page is served at, like `/dashboard`. */
  route: string;
  theme: string;
  /** `.vi` files this page reads from and runs, relative to the `.ui` file. */
  links: string[];
  root: FrameNode;
}

// ---------------------------------------------------------------- .vi side

/**
 * What a `.vi` file offers a page. This is the only part of a `.vi` file the
 * UI editor reads; everything else in it belongs to the graph editor.
 *
 * `sample` is what the canvas shows before anything runs, so a page linked to
 * real data looks real while it is being built.
 */
export type ViType = 'String' | 'Number' | 'Boolean' | 'Url' | 'Date' | 'Object' | 'List';

export interface ViValue {
  name: string;
  type: ViType;
  /** For a List or Object: the fields of one item. */
  fields?: Record<string, ViType>;
  sample?: unknown;
  about?: string;
}

export interface ViAction {
  name: string;
  inputs: { name: string; type: ViType }[];
  returns?: ViType;
  about?: string;
}

export interface ViExports {
  values: ViValue[];
  actions: ViAction[];
}
