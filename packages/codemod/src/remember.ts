import type { Node, ParameterDeclaration, SourceFile } from 'typescript';
import { type Edit, fold, lineOf, lineStart, nextLineStart } from './edits.ts';
import type { BranchPlan } from './branches.ts';

/**
 * Remember a lookup's answers for a while, so asking again is free.
 *
 *   export const getBilling = (orgId: number) =>      export const getBilling = remember(30_000, (orgId: number) =>
 *     query(...);                                 ->     query(...));
 *
 * The helper is written into the file once, above its first use, so nothing
 * is installed and the whole change is readable in one diff. Answers are kept
 * per set of arguments and forgotten after the time given; a failed lookup is
 * forgotten straight away, so an error is never remembered.
 *
 * It refuses anything that looks like it changes data, because remembering a
 * write means skipping it, and anything taking objects or lists, because two
 * calls with the "same" object are not reliably the same question.
 */

type TS = typeof import('typescript');

export const REMEMBER = 'remember';

const helperTs = `/** Keeps each answer for \`ms\`, per set of arguments. Added by Vibez. */
function ${REMEMBER}<A extends unknown[], R>(ms: number, lookup: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  const kept = new Map<string, { at: number; answer: Promise<R> }>();
  return (...args: A) => {
    const key = JSON.stringify(args);
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.answer;
    const answer = lookup(...args);
    kept.set(key, { at: Date.now(), answer });
    answer.catch(() => kept.delete(key));
    return answer;
  };
}
`;

const helperJs = `/** Keeps each answer for \`ms\`, per set of arguments. Added by Vibez. */
function ${REMEMBER}(ms, lookup) {
  const kept = new Map();
  return (...args) => {
    const key = JSON.stringify(args);
    const hit = kept.get(key);
    if (hit && Date.now() - hit.at < ms) return hit.answer;
    const answer = lookup(...args);
    kept.set(key, { at: Date.now(), answer });
    answer.catch(() => kept.delete(key));
    return answer;
  };
}
`;

const WRITES = /\b(INSERT|UPDATE|DELETE|UPSERT|REPLACE\s+INTO|MERGE\s+INTO)\b|\.(create|createMany|update|updateMany|upsert|delete|deleteMany|save|destroy|insert|remove)\s*\(|method:\s*['"](POST|PUT|PATCH|DELETE)['"]/i;
const WRITE_NAME = /^(create|update|delete|remove|save|send|post|put|patch|set|add|insert|upsert|write|clear|reset|mark)(?![a-z])/;
const PRIMITIVE = new Set(['string', 'number', 'boolean', 'bigint']);

const pretty = (ms: number): string => ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1000} s`;
const literal = (ms: number): string => ms >= 10_000 ? String(ms).replace(/\B(?=(\d{3})+(?!\d))/g, '_') : String(ms);

export function planRemember(ts: TS, source: string, fileName: string, symbol: string, ms = 30_000): BranchPlan {
  const file: SourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const typed = /\.(ts|tsx|mts|cts)$/.test(fileName);

  type Found =
    | { kind: 'const'; fn: import('typescript').ArrowFunction | import('typescript').FunctionExpression; declaration: import('typescript').VariableDeclaration }
    | { kind: 'function'; fn: import('typescript').FunctionDeclaration };
  const found: Found[] = [];
  let already = false;
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === symbol && statement.body) {
      found.push({ kind: 'function', fn: statement });
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== symbol || !declaration.initializer) continue;
        const init = declaration.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) found.push({ kind: 'const', fn: init, declaration });
        else if (ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === REMEMBER) already = true;
      }
    }
  }
  if (already) return { ok: false, reason: `${symbol} already remembers its answers.` };
  if (found.length === 0) return { ok: false, reason: `Could not find a function called ${symbol} at the top of the file.` };
  if (found.length > 1) return { ok: false, reason: `${symbol} is defined more than once in this file.` };
  const target = found[0]!;
  const fn = target.fn;

  if (WRITE_NAME.test(symbol) || WRITES.test(fn.getText(file))) {
    return { ok: false, reason: `${symbol} looks like it changes data. Remembering it would skip the change.` };
  }
  const isAsync = fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false;
  const returnsPromise = fn.type !== undefined && /^Promise</.test(fn.type.getText(file));
  if (!isAsync && !returnsPromise && !(fn.body && !ts.isBlock(fn.body))) {
    return { ok: false, reason: `${symbol} does not return a promise, so there is no waiting to save.` };
  }
  const objectParam = fn.parameters.find((p: ParameterDeclaration) => {
    if (p.dotDotDotToken || !ts.isIdentifier(p.name)) return true;
    if (p.type === undefined) return false;
    return !p.type.getText(file).split('|').map((t) => t.trim()).every((t) => PRIMITIVE.has(t) || t === 'undefined' || t === 'null' || /^['"\d]/.test(t));
  });
  if (objectParam !== undefined) {
    return { ok: false, reason: `${symbol} takes ${objectParam.name.getText(file)}, which is not a plain value, so two calls cannot be told apart reliably.` };
  }

  // A function declaration becomes a const, which is not hoisted: refuse if
  // the file uses it at the top level before that line.
  if (target.kind === 'function') {
    const at = target.fn.getStart(file);
    let early = false;
    const visit = (node: Node): void => {
      if (early || node.getStart(file) >= at) return;
      if (ts.isFunctionLike(node)) return;
      if (ts.isIdentifier(node) && node.text === symbol) early = true;
      ts.forEachChild(node, visit);
    };
    file.statements.forEach(visit);
    if (early) return { ok: false, reason: `${symbol} is used before it is defined, which only works for a plain function.` };
  }

  const edits: Edit[] = [];
  const hasHelper = file.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === REMEMBER);
  const clash = !hasHelper && new RegExp(`\\b${REMEMBER}\\b`).test(source);
  if (clash) return { ok: false, reason: `This file already uses the name ${REMEMBER} for something else.` };
  if (!hasHelper) {
    // Just below the imports, so it reads as part of the file's setup.
    const lastImport = [...file.statements].reverse().find((s) => ts.isImportDeclaration(s) || ts.isImportEqualsDeclaration(s));
    const at = lastImport ? nextLineStart(source, lastImport.getEnd()) : 0;
    edits.push({ start: at, end: at, text: `${lastImport ? '\n' : ''}${typed ? helperTs : helperJs}${lastImport ? '' : '\n'}` });
  }

  if (target.kind === 'const') {
    edits.push({ start: fn.getStart(file), end: fn.getStart(file), text: `${REMEMBER}(${literal(ms)}, ` });
    edits.push({ start: fn.getEnd(), end: fn.getEnd(), text: ')' });
  } else {
    const decl = target.fn;
    const exported = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const isDefault = decl.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;
    if (isDefault) return { ok: false, reason: `${symbol} is the default export, which Vibez does not rewrite yet.` };
    const keywordStart = decl.modifiers?.find((m) => m.kind === ts.SyntaxKind.AsyncKeyword)?.getStart(file)
      ?? decl.getChildren(file).find((c) => c.kind === ts.SyntaxKind.FunctionKeyword)!.getStart(file);
    edits.push({ start: decl.getStart(file), end: keywordStart,
      text: `${exported ? 'export ' : ''}const ${symbol} = ${REMEMBER}(${literal(ms)}, ` });
    edits.push({ start: decl.getEnd(), end: decl.getEnd(), text: ');' });
  }

  const folded = fold(source, edits);
  return {
    ok: true,
    ...folded,
    line: lineOf(source, lineStart(source, fn.getStart(file))),
    summary: `${symbol} keeps each answer for ${pretty(ms)}. Asking again in that time returns straight away, without running it.`,
  };
}
