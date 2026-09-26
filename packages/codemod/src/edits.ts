/**
 * Small helpers shared by the codemods.
 *
 * Every codemod answers with ONE contiguous range and its replacement, because
 * that is what previews as a readable diff and applies as a single undoable
 * edit. Internally a change is often several edits; these fold them together.
 */

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export const lineStart = (source: string, offset: number): number =>
  source.lastIndexOf('\n', offset - 1) + 1;

/** Offset just past the newline that ends the line containing `offset`. */
export const nextLineStart = (source: string, offset: number): number => {
  const newline = source.indexOf('\n', offset);
  return newline === -1 ? source.length : newline + 1;
};

export const indentAt = (source: string, offset: number): string =>
  /^[ \t]*/.exec(source.slice(lineStart(source, offset), offset))?.[0] ?? '';

export const lineOf = (source: string, offset: number): number =>
  source.slice(0, offset).split('\n').length;

/** Fold non-overlapping edits into one range and the text that replaces it. */
export function fold(source: string, edits: Edit[]): { start: number; end: number; replacement: string; original: string } {
  const start = Math.min(...edits.map((edit) => edit.start));
  const end = Math.max(...edits.map((edit) => edit.end));
  let text = source.slice(start, end);
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start - start) + edit.text + text.slice(edit.end - start);
  }
  return { start, end, replacement: text, original: source.slice(start, end) };
}

export const mentions = (text: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$.])${name.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`).test(text);

/** A name not already used in `scope`, from a list of readable candidates. */
export function freshName(scope: string, candidates: string[]): string {
  for (const name of candidates) {
    if (!mentions(scope, name)) return name;
  }
  let n = 2;
  while (mentions(scope, `${candidates[0]}${n}`)) n++;
  return `${candidates[0]}${n}`;
}

type TS = typeof import('typescript');

/**
 * The variables a piece of code actually reads.
 *
 * Text matching is not enough: `{ out: 'rows' }` contains the word `out` but
 * reads no variable called out, and `config.plan` reads `config`, not `plan`.
 * Treating either as a dependency makes a codemod refuse work it could do.
 * Shorthand `{ out }` really does read `out`, and counts.
 */
export function referencedNames(ts: TS, code: string): Set<string> {
  const file = ts.createSourceFile('refs.ts', `(${code});`, ts.ScriptTarget.Latest, true);
  const statementFile = (file as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0
    ? ts.createSourceFile('refs.ts', code, ts.ScriptTarget.Latest, true)
    : file;
  const out = new Set<string>();
  const visit = (node: import('typescript').Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const isKey = (ts.isPropertyAssignment(parent) && parent.name === node)
        || (ts.isPropertyAccessExpression(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
        || (ts.isPropertyDeclaration(parent) && parent.name === node)
        || (ts.isBindingElement(parent) && parent.propertyName === node)
        || (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node)
        || ts.isTypeReferenceNode(parent);
      if (!isKey) out.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(statementFile);
  return out;
}
