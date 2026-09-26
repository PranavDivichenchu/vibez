import type { Block, Node, SourceFile, Statement, VariableStatement, IfStatement, ConditionalExpression } from 'typescript';
import { type Edit, fold, indentAt, lineOf, lineStart, nextLineStart, referencedNames } from './edits.ts';
import type { BranchPlan } from './branches.ts';

/**
 * Drop a step onto a Branch's True or False output: it moves into that side.
 *
 * "Something happens on both sides" is an if/else statement, so a ternary is
 * rebuilt as one. The value it produced is declared with `let` first and
 * assigned in whichever side produces it, keeping every name in scope for the
 * code after the branch. The step that moved is assigned the same way, with an
 * empty value of its type for the side it does not run on.
 */

type TS = typeof import('typescript');

export interface BranchTarget {
  condition: string;
  /** 1-based line the condition starts on, from the last read of the source. */
  line: number;
}

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

function calleeOf(ts: TS, node: Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

function hasCall(ts: TS, node: Node): boolean {
  let found = false;
  const visit = (child: Node): void => {
    if (found || (child !== node && ts.isFunctionLike(child))) return;
    if (ts.isCallExpression(child)) { found = true; return; }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

const containsAwait = (ts: TS, node: Node): boolean => {
  let found = false;
  const visit = (child: Node): void => {
    if (found || (child !== node && ts.isFunctionLike(child))) return;
    if (ts.isAwaitExpression(child)) { found = true; return; }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

function namesIntroduced(ts: TS, statement: Statement): string[] {
  const out: string[] = [];
  const visit = (node: Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const collect = (binding: Node): void => {
        if (ts.isIdentifier(binding)) out.push(binding.text);
        else ts.forEachChild(binding, collect);
      };
      collect(node.name);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      out.push(node.left.text);
    }
    if (node !== statement && ts.isFunctionLike(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return out;
}

interface Step {
  statement: Statement;
  /** Set for `const y = await f()`; undefined for a bare `await f();`. */
  binding?: string;
  keyword?: string;
  call: string;
}

function readStep(ts: TS, statement: Statement, file: SourceFile, symbol: string): Step | undefined {
  if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    const declaration = declarations[0];
    if (declarations.length !== 1 || declaration === undefined || !ts.isIdentifier(declaration.name)) return undefined;
    const init = declaration.initializer;
    if (init === undefined || !ts.isAwaitExpression(init) || calleeOf(ts, init.expression) !== symbol) return undefined;
    return {
      statement,
      binding: declaration.name.text,
      keyword: statement.declarationList.getFirstToken(file)?.getText(file) ?? 'const',
      call: init.getText(file),
    };
  }
  if (ts.isExpressionStatement(statement) && ts.isAwaitExpression(statement.expression)
    && calleeOf(ts, statement.expression.expression) === symbol) {
    return { statement, call: statement.expression.getText(file) };
  }
  return undefined;
}

type Conditional =
  | { kind: 'ternary'; statement: VariableStatement; name: string; node: ConditionalExpression }
  | { kind: 'if'; statement: IfStatement };

function readConditional(ts: TS, statement: Statement): Conditional | undefined {
  if (ts.isIfStatement(statement)) return { kind: 'if', statement };
  if (ts.isVariableStatement(statement)) {
    const declaration = statement.declarationList.declarations[0];
    if (statement.declarationList.declarations.length === 1 && declaration !== undefined
      && ts.isIdentifier(declaration.name) && declaration.initializer !== undefined
      && ts.isConditionalExpression(declaration.initializer)) {
      return { kind: 'ternary', statement, name: declaration.name.text, node: declaration.initializer };
    }
  }
  return undefined;
}

export function planMoveIntoBranch(
  ts: TS, source: string, fileName: string, target: BranchTarget, symbol: string, side: 'true' | 'false', empty: string,
): BranchPlan {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const wanted = squash(target.condition);
  const sideName = side === 'true' ? 'True' : 'False';

  // Find the branch: a statement-level if, or a ternary initialising one name,
  // whose condition matches and starts on the line the graph last saw.
  let found: { block: Block | SourceFile; index: number; conditional: Conditional } | undefined;
  let byTextOnly: typeof found[] = [];
  const visitBlock = (block: Block | SourceFile): void => {
    block.statements.forEach((statement, index) => {
      const conditional = readConditional(ts, statement);
      if (conditional === undefined) return;
      const condition = conditional.kind === 'if' ? conditional.statement.expression : conditional.node.condition;
      if (squash(condition.getText(file)) !== wanted) return;
      const line = file.getLineAndCharacterOfPosition(condition.getStart(file)).line + 1;
      if (line === target.line) found = { block, index, conditional };
      else byTextOnly.push({ block, index, conditional });
    });
  };
  const walk = (node: Node): void => {
    if (ts.isBlock(node)) visitBlock(node);
    ts.forEachChild(node, walk);
  };
  visitBlock(file);
  walk(file);
  byTextOnly = byTextOnly.filter(Boolean);
  if (found === undefined && byTextOnly.length === 1) found = byTextOnly[0];
  if (found === undefined) {
    return { ok: false, reason: byTextOnly.length > 1
      ? `There are ${byTextOnly.length} branches on "${wanted}" and the source has moved since it was read. Measure again and retry.`
      : `Could not find the branch on "${wanted}" in ${fileName.split('/').pop()}.` };
  }

  const { block, index: at, conditional } = found;
  const statements = [...block.statements];

  // The step has to live beside the branch, in the same block, and not already
  // be conditional itself.
  const candidates = statements
    .map((statement, index) => ({ step: readStep(ts, statement, file, symbol), index }))
    .filter((c): c is { step: Step; index: number } => c.step !== undefined);
  if (candidates.length === 0) {
    const inside = conditional.statement.getText(file).includes(`${symbol}(`);
    return { ok: false, reason: inside
      ? `${symbol} is already in this branch.`
      : `${symbol} is not called beside this branch, so it cannot move into it.` };
  }
  if (candidates.length > 1) return { ok: false, reason: `${symbol} is awaited more than once beside this branch.` };
  const { step, index } = candidates[0]!;

  const [lo, hi] = index < at ? [index, at] : [at, index];
  const between = statements.slice(lo + 1, hi);
  for (const statement of between) {
    if (containsAwait(ts, statement)) {
      return { ok: false, reason: `Another step runs between ${symbol} and the branch and might need to finish first.` };
    }
  }

  const branchNames = conditional.kind === 'ternary' ? [conditional.name] : namesIntroduced(ts, conditional.statement);
  const stepReads = referencedNames(ts, step.call);
  if (index > at) {
    const uses = branchNames.find((name) => stepReads.has(name));
    if (uses !== undefined) return { ok: false, reason: `${symbol} uses ${uses}, which the branch sets, so it cannot run on one side of it.` };
    for (const statement of between) {
      const set = namesIntroduced(ts, statement).find((name) => stepReads.has(name));
      if (set !== undefined) return { ok: false, reason: `${symbol} uses ${set}, which is set after the branch.` };
    }
  } else if (step.binding !== undefined) {
    const name = step.binding;
    if (between.some((statement) => referencedNames(ts, statement.getText(file)).has(name))) {
      return { ok: false, reason: `${name} is used before the branch, so ${symbol} has to run first.` };
    }
    if (referencedNames(ts, conditional.statement.getText(file)).has(name)) {
      return { ok: false, reason: `The branch reads ${name}, so ${symbol} has to run before it.` };
    }
  }

  const indent = indentAt(source, conditional.statement.getStart(file));
  const inner = `${indent}  `;
  const moved = step.binding !== undefined ? `${step.binding} = ${step.call};` : `${step.call};`;
  const declare = step.binding !== undefined ? `${indent}let ${step.binding} = ${empty};\n` : '';
  const edits: Edit[] = [];

  // The moved step's own line goes away.
  edits.push({ start: lineStart(source, step.statement.getStart(file)), end: nextLineStart(source, step.statement.getEnd()), text: '' });

  if (conditional.kind === 'ternary') {
    const { node, name } = conditional;
    const yes = node.whenTrue;
    const no = node.whenFalse;
    const yesCalls = hasCall(ts, yes);
    const noCalls = hasCall(ts, no);
    if (!yesCalls && !noCalls) return { ok: false, reason: 'That branch does not call anything to move beside.' };

    const init = yesCalls && noCalls ? '' : ` = ${(yesCalls ? no : yes).getText(file)}`;
    const trueBody = [...(yesCalls ? [`${name} = ${yes.getText(file)};`] : []), ...(side === 'true' ? [moved] : [])];
    const falseBody = [...(noCalls ? [`${name} = ${no.getText(file)};`] : []), ...(side === 'false' ? [moved] : [])];
    const lines = [
      `${indent}let ${name}${init};`,
      ...(declare ? [declare.trimEnd()] : []),
      `${indent}if (${node.condition.getText(file)}) {`,
      ...trueBody.map((line) => inner + line),
      ...(falseBody.length > 0 ? [`${indent}} else {`, ...falseBody.map((line) => inner + line)] : []),
      `${indent}}`,
    ];
    edits.push({ start: lineStart(source, conditional.statement.getStart(file)), end: conditional.statement.getEnd(), text: lines.join('\n') });
  } else {
    const statement = conditional.statement;
    if (declare) edits.push({ start: lineStart(source, statement.getStart(file)), end: lineStart(source, statement.getStart(file)), text: declare });
    const into = side === 'true' ? statement.thenStatement : statement.elseStatement;
    if (into !== undefined && !ts.isBlock(into)) {
      return { ok: false, reason: `The ${sideName} side of that branch is not a block Vibez can add to safely.` };
    }
    if (into !== undefined) {
      const close = into.getEnd() - 1;
      edits.push({ start: lineStart(source, close), end: lineStart(source, close), text: `${inner}${moved}\n` });
    } else if (side === 'false') {
      edits.push({ start: statement.thenStatement.getEnd(), end: statement.thenStatement.getEnd(), text: ` else {\n${inner}${moved}\n${indent}}` });
    } else {
      return { ok: false, reason: 'That branch has no True side to add to.' };
    }
  }

  const folded = fold(source, edits);
  return {
    ok: true,
    ...folded,
    line: lineOf(source, folded.start),
    summary: `${symbol} now runs only when the branch goes ${sideName}.`,
  };
}
