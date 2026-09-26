import type {
  Block, CallExpression, Expression, Node, SourceFile, Statement, VariableStatement,
} from 'typescript';

/**
 * What dragging one node onto another does: run the two calls together.
 *
 * The gesture has exactly one sane reading in code, so no model is involved.
 * This finds the two awaited calls, checks that overlapping them cannot break
 * anything it can see, and merges them into one Promise.all. When it cannot
 * prove that, it refuses and says why in a sentence someone can act on.
 *
 * `ts` is passed in rather than imported. The same file runs under Node in
 * tests and inside the editor's main process, and those two load the compiler
 * differently; taking it as an argument sidesteps that entirely.
 */

type TS = typeof import('typescript');

export interface MergePlan {
  ok: boolean;
  /** Why it could not be done, phrased for the person who dragged. */
  reason?: string;
  /** What will happen, phrased the same way. */
  summary?: string;
  /** Character offsets into the original source, and what replaces them. */
  start?: number;
  end?: number;
  replacement?: string;
  /** The original text in [start, end), for showing the change. */
  original?: string;
  /** 1-based line of the change. */
  line?: number;
  /** True when one statement had to move to sit beside the other. */
  hoisted?: boolean;
}

interface Awaited {
  statement: VariableStatement;
  /** One name per call, in order. A plain `const x = await f()` has one of each. */
  bindings: string[];
  calls: string[];
  callees: string[];
}

const calleeOf = (ts: TS, call: CallExpression): string => {
  const target = call.expression;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isIdentifier(target)) return target.text;
  return '';
};

/**
 * Recognises the two shapes a merge can involve:
 *   const x = await f(...)
 *   const [x, y] = await Promise.all([f(...), g(...)])
 * Anything more elaborate is left alone rather than half-understood.
 */
function readAwaited(ts: TS, statement: Statement, file: SourceFile): Awaited | undefined {
  if (!ts.isVariableStatement(statement)) return undefined;
  const declarations = statement.declarationList.declarations;
  if (declarations.length !== 1) return undefined;
  const declaration = declarations[0]!;
  const init = declaration.initializer;
  if (init === undefined || !ts.isAwaitExpression(init) || !ts.isCallExpression(init.expression)) return undefined;
  const call = init.expression;

  if (ts.isIdentifier(declaration.name)) {
    return {
      statement,
      bindings: [declaration.name.text],
      calls: [call.getText(file)],
      callees: [calleeOf(ts, call)],
    };
  }

  const isPromiseAll = ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && call.expression.expression.text === 'Promise'
    && call.expression.name.text === 'all';
  if (!isPromiseAll || !ts.isArrayBindingPattern(declaration.name)) return undefined;
  const list = call.arguments[0];
  if (list === undefined || !ts.isArrayLiteralExpression(list)) return undefined;

  const bindings: string[] = [];
  for (const element of declaration.name.elements) {
    if (ts.isOmittedExpression(element) || !ts.isIdentifier(element.name)) return undefined;
    bindings.push(element.name.text);
  }
  const elements = [...list.elements] as Expression[];
  if (elements.length !== bindings.length || !elements.every((e) => ts.isCallExpression(e))) return undefined;
  const calls = elements as CallExpression[];
  return {
    statement,
    bindings,
    calls: calls.map((c) => c.getText(file)),
    callees: calls.map((c) => calleeOf(ts, c)),
  };
}

const mentions = (text: string, name: string): boolean =>
  new RegExp(`(^|[^A-Za-z0-9_$.])${name.replace(/\$/g, '\\$')}(?![A-Za-z0-9_$])`).test(text);

/** Names a statement introduces or reassigns, which anything after it may depend on. */
function namesTouchedBy(ts: TS, statement: Statement): string[] {
  const names: string[] = [];
  const visit = (node: Node): void => {
    if (ts.isVariableDeclaration(node)) {
      const collect = (binding: Node): void => {
        if (ts.isIdentifier(binding)) names.push(binding.text);
        else ts.forEachChild(binding, collect);
      };
      collect(node.name);
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      names.push(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(statement);
  return names;
}

const containsAwait = (ts: TS, node: Node): boolean => {
  let found = false;
  const visit = (child: Node): void => {
    if (found) return;
    if (ts.isAwaitExpression(child)) { found = true; return; }
    // A nested function's awaits belong to that function, not this block.
    if (ts.isFunctionLike(child) && child !== node) return;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(source.slice(lineStart, offset))?.[0] ?? '';
}

const lineOf = (source: string, offset: number): number => source.slice(0, offset).split('\n').length;

export function planMerge(ts: TS, source: string, fileName: string, a: string, b: string): MergePlan {
  if (a === b) return { ok: false, reason: 'That is the same step twice.' };
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  let best: MergePlan | undefined;
  const consider = (plan: MergePlan): void => {
    // A successful plan always wins; otherwise keep the most specific refusal.
    if (best === undefined || (plan.ok && !best.ok)) best = plan;
  };

  const inspect = (block: Block | SourceFile): void => {
    const statements = [...block.statements];
    const read = statements.map((s) => readAwaited(ts, s, file));
    const indexOf = (name: string): number => read.findIndex((r) => r?.callees.includes(name) ?? false);
    const ia = indexOf(a);
    const ib = indexOf(b);
    if (ia === -1 || ib === -1) return;

    if (ia === ib) {
      consider({ ok: false, reason: `${a} and ${b} already run together.` });
      return;
    }

    const [i, j] = ia < ib ? [ia, ib] : [ib, ia];
    const first = read[i]!;
    const second = read[j]!;
    const [early, late] = ia < ib ? [a, b] : [b, a];

    // The later call must not need anything the earlier one produced.
    const needed = first.bindings.find((name) => second.calls.some((call) => mentions(call, name)));
    if (needed !== undefined) {
      consider({
        ok: false,
        reason: `${late} needs ${needed} from ${early}, so it has to wait for it.`,
      });
      return;
    }

    // Anything in between has to be safe to step over. An await in between
    // might be something the later call relies on having finished, and there
    // is no way to know from here, so that is a refusal rather than a guess.
    const between = statements.slice(i + 1, j);
    for (const statement of between) {
      const blocker = read[statements.indexOf(statement)];
      if (containsAwait(ts, statement)) {
        const name = blocker?.callees[0] ?? 'Another step';
        consider({
          ok: false,
          reason: `${name} runs between them and might need to finish first. Drag it in too, or move ${late} next to ${early}.`,
        });
        return;
      }
      const touched = namesTouchedBy(ts, statement).find((name) => second.calls.some((call) => mentions(call, name)));
      if (touched !== undefined) {
        consider({ ok: false, reason: `${late} uses ${touched}, which is set between the two, so it cannot move up.` });
        return;
      }
    }

    const bindings = [...first.bindings, ...second.bindings];
    const calls = [...first.calls, ...second.calls];
    const start = first.statement.getStart(file);
    const indent = indentAt(source, start);
    const merged = `const [${bindings.join(', ')}] = await Promise.all([\n`
      + calls.map((call) => `${indent}  ${call},`).join('\n')
      + `\n${indent}]);`;

    // Keep whatever sat between the two exactly as it was, and drop the later
    // statement along with the line it lived on.
    const kept = source.slice(first.statement.getEnd(), second.statement.getFullStart());
    const end = second.statement.getEnd();
    const hoisted = j > i + 1;

    consider({
      ok: true,
      start,
      end,
      replacement: merged + kept,
      original: source.slice(start, end),
      line: lineOf(source, start),
      hoisted,
      summary: calls.length > 2
        ? `${calls.length} steps start at the same time instead of one after another.`
        : `${early} and ${late} start at the same time instead of one after another.`,
    });
  };

  const walk = (node: Node): void => {
    if (ts.isBlock(node)) inspect(node);
    ts.forEachChild(node, walk);
  };
  inspect(file);
  walk(file);

  return best ?? { ok: false, reason: `Could not find ${a} and ${b} awaited in the same place.` };
}

/** Apply a plan to its source. Kept separate so callers can preview first. */
export function applyPlan(source: string, plan: MergePlan): string {
  if (!plan.ok || plan.start === undefined || plan.end === undefined || plan.replacement === undefined) return source;
  return source.slice(0, plan.start) + plan.replacement + source.slice(plan.end);
}
