import type { ForOfStatement, Node, SourceFile, AwaitExpression } from 'typescript';
import { type Edit, fold, freshName, indentAt, lineOf, lineStart, referencedNames } from './edits.ts';
import type { BranchPlan } from './branches.ts';

/**
 * Stop a loop from waiting on each lookup in turn: start them all, then use
 * the results in their original order.
 *
 *   for (const c of customers) {            const pending = customers.map((c) => lookup(c.id));
 *     const [row] = await lookup(c.id);  ->  for (const [index, c] of customers.entries()) {
 *     if (row) out.push(row);                  const [row] = await pending[index];
 *   }                                          if (row) out.push(row);
 *                                            }
 *
 * Order is preserved on purpose. Pushing results as they finish would be
 * shorter and would silently scramble anything that pairs results back up with
 * their inputs by position — a table that lines stats[i] up with customers[i].
 *
 * This is not the same as asking once for everything. That depends on the
 * database library and is a different codemod; this one is safe for any async
 * call in a loop, which is why it is the one that runs without asking a model.
 */

type TS = typeof import('typescript');

export function findFunction(ts: TS, file: SourceFile, symbol: string): Node | undefined {
  let found: Node | undefined;
  const visit = (node: Node): void => {
    if (found) return;
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) && node.name?.getText(file) === symbol && node.body) {
      found = node;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbol && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function awaitsIn(ts: TS, root: Node): AwaitExpression[] {
  const out: AwaitExpression[] = [];
  const visit = (node: Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** Is this await only reached sometimes? Starting it eagerly would change what runs. */
function isConditional(ts: TS, node: Node, stop: Node): boolean {
  for (let cursor = node.parent; cursor && cursor !== stop; cursor = cursor.parent) {
    if (ts.isIfStatement(cursor) || ts.isConditionalExpression(cursor)) return true;
    if (ts.isBinaryExpression(cursor) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.QuestionQuestionToken].includes(cursor.operatorToken.kind)) return true;
  }
  return false;
}

/** Names written inside the loop body: anything the call reads from here depends on earlier passes. */
function namesWritten(ts: TS, body: Node): Set<string> {
  const out = new Set<string>();
  const visit = (node: Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node)) {
      const collect = (binding: Node): void => {
        if (ts.isIdentifier(binding)) out.add(binding.text);
        else ts.forEachChild(binding, collect);
      };
      collect(node.name);
    }
    if (ts.isBinaryExpression(node) && ts.isIdentifier(node.left)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      out.add(node.left.text);
    }
    if ((ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) && ts.isIdentifier(node.operand)) {
      out.add(node.operand.text);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
      && ['push', 'unshift', 'splice', 'set', 'add', 'delete'].includes(node.expression.name.text)) {
      out.add(node.expression.expression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return out;
}

export interface LoopLookup {
  ok: true;
  file: SourceFile;
  fn: Node;
  loop: ForOfStatement;
  waiting: AwaitExpression;
  call: import('typescript').CallExpression;
  /** The loop's own item, as written: a name or a destructuring pattern. */
  item: string;
  /** Every name the item binds. */
  itemNames: Set<string>;
  list: string;
}

/**
 * The one loop in `symbol` that waits on a lookup each pass, and proof that
 * the passes are independent. Shared by every codemod that rewrites that loop.
 */
export function findLoopLookup(ts: TS, source: string, fileName: string, symbol: string): LoopLookup | { ok: false; reason: string } {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const fn = findFunction(ts, file, symbol);
  if (fn === undefined) return { ok: false, reason: `Could not find a function called ${symbol}.` };

  const loops: ForOfStatement[] = [];
  const collectLoops = (node: Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if (ts.isForOfStatement(node) && awaitsIn(ts, node.statement).length > 0) loops.push(node);
    ts.forEachChild(node, collectLoops);
  };
  collectLoops(fn);
  const otherLoops: Node[] = [];
  const collectOther = (node: Node): void => {
    if (node !== fn && ts.isFunctionLike(node)) return;
    if ((ts.isForStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isForInStatement(node))
      && awaitsIn(ts, node).length > 0) otherLoops.push(node);
    ts.forEachChild(node, collectOther);
  };
  collectOther(fn);

  if (loops.length === 0) {
    return { ok: false, reason: otherLoops.length > 0
      ? `The loop in ${symbol} is not a for…of loop, which is the only kind Vibez rewrites so far.`
      : `${symbol} has no loop that waits on each pass.` };
  }
  if (loops.length > 1) return { ok: false, reason: `${symbol} has ${loops.length} loops that wait on each pass. Vibez will not guess which one.` };
  const loop = loops[0]!;
  if (loop.awaitModifier) return { ok: false, reason: `That is a for await loop, which already reads one item at a time by design.` };

  const awaits = awaitsIn(ts, loop.statement);
  if (awaits.length > 1) {
    return { ok: false, reason: `Each pass waits ${awaits.length} times. Vibez only rewrites a loop with exactly one lookup.` };
  }
  const waiting = awaits[0]!;
  if (!ts.isCallExpression(waiting.expression)) return { ok: false, reason: 'The loop waits on something that is not a call.' };
  if (isConditional(ts, waiting, loop.statement)) {
    return { ok: false, reason: 'The lookup only happens on some passes, so starting every one early would change what runs.' };
  }

  const call = waiting.expression.getText(file);
  const written = namesWritten(ts, loop.statement);
  const reads = referencedNames(ts, call);
  const dependsOn = [...written].find((name) => reads.has(name));
  if (dependsOn !== undefined) {
    return { ok: false, reason: `The lookup reads ${dependsOn}, which changes as the loop runs, so the passes are not independent.` };
  }

  const initializer = loop.initializer;
  if (!ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) {
    return { ok: false, reason: 'The loop does not declare its own item, so Vibez cannot rewrite it safely.' };
  }
  // The list is read twice after the rewrite, so it has to be something that
  // reads the same both times: a name, or a property of one.
  let listNode: Node = loop.expression;
  while (ts.isPropertyAccessExpression(listNode)) listNode = listNode.expression;
  if (!ts.isIdentifier(listNode) && listNode.kind !== ts.SyntaxKind.ThisKeyword) {
    return { ok: false, reason: 'The loop runs over the result of a call. Store it in a variable first, then Vibez can rewrite the loop.' };
  }
  const itemNames = new Set<string>();
  const collect = (binding: Node): void => {
    if (ts.isIdentifier(binding)) itemNames.add(binding.text);
    else ts.forEachChild(binding, collect);
  };
  collect(initializer.declarations[0]!.name);
  return {
    ok: true,
    file,
    fn,
    loop,
    waiting,
    call: waiting.expression,
    item: initializer.declarations[0]!.name.getText(file),
    itemNames,
    list: loop.expression.getText(file),
  };
}

export function planBatch(ts: TS, source: string, fileName: string, symbol: string, count?: number): BranchPlan {
  const found = findLoopLookup(ts, source, fileName, symbol);
  if (!found.ok) return found;
  const { file, fn, loop, waiting, item, list } = found;
  const initializer = loop.initializer;
  const call = waiting.expression.getText(file);
  const scope = fn.getText(file);
  const pending = freshName(scope, ['pending', 'started', 'inFlight']);
  const index = freshName(scope, ['index', 'i', 'position']);
  const indent = indentAt(source, loop.getStart(file));

  const edits: Edit[] = [
    { start: lineStart(source, loop.getStart(file)), end: lineStart(source, loop.getStart(file)),
      text: `${indent}const ${pending} = ${list}.map((${item}) => ${call});\n` },
    { start: initializer.getStart(file), end: loop.expression.getEnd(), text: `const [${index}, ${item}] of ${list}.entries()` },
    { start: waiting.getStart(file), end: waiting.getEnd(), text: `await ${pending}[${index}]` },
  ];
  const folded = fold(source, edits);
  const how = count !== undefined && count > 1 ? `All ${count} lookups` : 'Every lookup';
  return {
    ok: true,
    ...folded,
    line: lineOf(source, folded.start),
    summary: `${how} in ${symbol} start at once instead of waiting for the one before. Results are used in their original order.`,
  };
}
