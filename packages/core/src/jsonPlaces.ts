/**
 * Where each value of a JSON file sits in its text.
 *
 * `.ui` pages and `.vi` logic are JSON files, and a person selects parts of
 * them on a canvas: elements of a page, blocks of a graph. To hand that
 * selection to a text tool (an agent's context, a file reference with line
 * numbers) it has to become ranges of the file. JSON.parse keeps no
 * positions, so this reads the text once more and keeps them.
 */

export interface JsonPlace {
  /** Offset of the value's first character, and just past its last. */
  start: number;
  end: number;
  /** An object's members by key, an array's items; a string's value. */
  keys?: Map<string, JsonPlace>;
  items?: JsonPlace[];
  text?: string;
}

/** The places of every value in `text`, or undefined when it is not JSON. */
export function jsonPlaces(text: string): JsonPlace | undefined {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i]!)) i++; };
  const fail = (): never => { throw new Error(`not JSON at ${i}`); };
  const string = (): string => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (text[i] !== '"') fail();
    i++;
    return JSON.parse(text.slice(start, i)) as string;
  };
  const value = (): JsonPlace => {
    ws();
    const start = i;
    const c = text[i];
    if (c === '{') {
      i++;
      const keys = new Map<string, JsonPlace>();
      ws();
      if (text[i] === '}') { i++; return { start, end: i, keys }; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const key = string();
        ws();
        if (text[i] !== ':') fail();
        i++;
        keys.set(key, value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return { start, end: i, keys }; }
        fail();
      }
    }
    if (c === '[') {
      i++;
      const items: JsonPlace[] = [];
      ws();
      if (text[i] === ']') { i++; return { start, end: i, items }; }
      for (;;) {
        items.push(value());
        ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return { start, end: i, items }; }
        fail();
      }
    }
    if (c === '"') { const s = string(); return { start, end: i, text: s }; }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (!m) fail();
    i += m![0].length;
    return { start, end: i };
  };
  try {
    const root = value();
    ws();
    return i === text.length ? root : undefined;
  } catch {
    return undefined;
  }
}

/** A range of a file, from the first character of a value to just past its last. */
export interface JsonRange { id: string; start: number; end: number }

const idOf = (place: JsonPlace): string | undefined => place.keys?.get('id')?.text;

/** Where the elements of a `.ui` page with these ids are written, in the order of the file. */
export function uiNodeRanges(text: string, ids: Iterable<string>): JsonRange[] {
  const want = new Set(ids);
  const out: JsonRange[] = [];
  const walk = (node: JsonPlace | undefined): void => {
    if (!node?.keys) return;
    const id = idOf(node);
    if (id !== undefined && want.has(id)) out.push({ id, start: node.start, end: node.end });
    for (const child of node.keys.get('children')?.items ?? []) walk(child);
  };
  walk(jsonPlaces(text)?.keys?.get('root'));
  return out;
}

/**
 * Where the blocks of one graph of a `.vi` file with these ids are written.
 * A graph is found by where it lives (`logic`, `helpers` or `methods`) and
 * its name there, since every graph numbers its blocks on its own.
 */
export function viNodeRanges(text: string, where: 'logic' | 'helpers' | 'methods', name: string, ids: Iterable<string>): JsonRange[] {
  const want = new Set(ids);
  const nodes = jsonPlaces(text)?.keys?.get(where)?.keys?.get(name)?.keys?.get('nodes')?.items ?? [];
  return nodes.flatMap((node) => {
    const id = idOf(node);
    return id !== undefined && want.has(id) ? [{ id, start: node.start, end: node.end }] : [];
  });
}
