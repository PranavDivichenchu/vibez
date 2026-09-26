import type { Node, SourceFile, Expression, Statement } from 'typescript';

/**
 * Reads if/else and ?: out of source, for the graph.
 *
 * Traces cannot show a branch on their own: the side that did not run leaves
 * no span, and application code does not emit "branch" spans. So the structure
 * comes from the code and the timing from the traces. A call sitting inside an
 * `if` becomes a step under a Branch node, and the other side's calls become
 * ghost steps that never ran.
 *
 * Only branches inside a function that also calls something the traces saw
 * are reported. That is how a branch whose taken side changed, and whose
 * steps therefore vanished from the traces, is still found.
 */

type TS = typeof import('typescript');

export interface BranchSite {
  file: string;
  /** 1-based line of the condition. */
  line: number;
  /** Byte offset of the conditional, stable within one version of the file. */
  at: number;
  condition: string;
  arms: { true: string[]; false: string[] };
  /** Traced calls made in the same function outside this branch, to find its parent. */
  siblings: string[];
}

function calleeName(ts: TS, node: Node): string | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const target = node.expression;
  if (ts.isIdentifier(target)) return target.text;
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  return undefined;
}

/** Calls made directly in a subtree, not inside functions defined there. */
function callsIn(ts: TS, root: Node | undefined): string[] {
  if (root === undefined) return [];
  const out: string[] = [];
  const visit = (node: Node): void => {
    if (node !== root && ts.isFunctionLike(node)) return;
    const name = calleeName(ts, node);
    if (name !== undefined && name !== 'all' && name !== 'Promise') out.push(name);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return [...new Set(out)];
}

export function findBranches(ts: TS, fileName: string, source: string, traced: Set<string>): BranchSite[] {
  const file: SourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const sites: BranchSite[] = [];

  const inspectFunction = (fn: Node): void => {
    const conditionals: { node: Node; condition: Expression; yes: Node; no: Node | undefined }[] = [];
    const visit = (node: Node): void => {
      if (node !== fn && ts.isFunctionLike(node)) return;
      if (ts.isIfStatement(node)) {
        conditionals.push({ node, condition: node.expression, yes: node.thenStatement, no: node.elseStatement as Statement | undefined });
      } else if (ts.isConditionalExpression(node)) {
        conditionals.push({ node, condition: node.condition, yes: node.whenTrue, no: node.whenFalse });
      }
      ts.forEachChild(node, visit);
    };
    visit(fn);
    if (conditionals.length === 0) return;

    const everything = callsIn(ts, fn);
    if (!everything.some((name) => traced.has(name))) return;

    for (const { node, condition, yes, no } of conditionals) {
      const arms = { true: callsIn(ts, yes), false: callsIn(ts, no) };
      if (arms.true.length === 0 && arms.false.length === 0) continue;
      const inside = new Set([...arms.true, ...arms.false, ...callsIn(ts, condition)]);
      const siblings = everything.filter((name) => traced.has(name) && !inside.has(name));
      sites.push({
        file: fileName,
        line: file.getLineAndCharacterOfPosition(condition.getStart(file)).line + 1,
        at: node.getStart(file),
        condition: condition.getText(file).replace(/\s+/g, ' '),
        arms,
        siblings,
      });
    }
  };

  const walk = (node: Node): void => {
    if (ts.isFunctionLike(node) && (node as { body?: Node }).body !== undefined) {
      inspectFunction(node);
    }
    ts.forEachChild(node, walk);
  };
  walk(file);

  // A call can sit inside nested conditionals. Attribute it to the innermost
  // one only, so one step never hangs under two branches.
  const claimed = new Set<string>();
  const innermostFirst = [...sites].sort((a, b) => b.at - a.at);
  for (const site of innermostFirst) {
    for (const side of ['true', 'false'] as const) {
      site.arms[side] = site.arms[side].filter((name) => {
        const key = `${site.file}|${name}`;
        if (claimed.has(key)) return false;
        return true;
      });
    }
    for (const name of [...site.arms.true, ...site.arms.false]) claimed.add(`${site.file}|${name}`);
  }
  return sites.filter((site) => site.arms.true.length + site.arms.false.length > 0)
    .sort((a, b) => a.at - b.at);
}

export interface BranchPlan {
  ok: boolean;
  reason?: string;
  summary?: string;
  start?: number;
  end?: number;
  replacement?: string;
  original?: string;
  line?: number;
}

/**
 * Put one step behind a condition: the "create an if" gesture.
 *
 *   const x = await f(...)   ->   const x = COND ? await f(...) : EMPTY;
 *   await f(...);            ->   if (COND) { await f(...); }
 *
 * EMPTY comes from the type of the step's output, which the graph already
 * knows, so the code after it keeps working when the condition is false.
 */
export function planBranch(ts: TS, source: string, fileName: string, symbol: string, condition: string, empty: string): BranchPlan {
  const trimmed = condition.trim();
  if (trimmed === '') return { ok: false, reason: 'Write the condition first.' };
  const probe = ts.createSourceFile('c.ts', `(${trimmed});`, ts.ScriptTarget.Latest, true);
  if ((probe as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length > 0) {
    return { ok: false, reason: `"${trimmed}" is not a valid condition.` };
  }

  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const matches: Statement[] = [];
  let insideConditional = false;

  const visit = (node: Node, conditional: boolean): void => {
    const nowConditional = conditional || ts.isIfStatement(node) || ts.isConditionalExpression(node);
    if (ts.isVariableStatement(node) || ts.isExpressionStatement(node)) {
      let found = false;
      let foundUnderCondition = false;
      // The ternary can sit inside the statement rather than around it, as in
      // `const a = flag ? await f() : null`, so conditions are tracked here too.
      const scan = (child: Node, underCondition: boolean): void => {
        if (ts.isFunctionLike(child)) return;
        const under = underCondition || ts.isConditionalExpression(child);
        if (ts.isAwaitExpression(child) && calleeName(ts, child.expression) === symbol) {
          found = true;
          if (under) foundUnderCondition = true;
        }
        ts.forEachChild(child, (next) => scan(next, under));
      };
      scan(node, false);
      if (found) {
        matches.push(node as Statement);
        if (conditional || foundUnderCondition) insideConditional = true;
      }
    }
    ts.forEachChild(node, (child) => visit(child, nowConditional));
  };
  visit(file, false);

  if (matches.length === 0) return { ok: false, reason: `Could not find anywhere that awaits ${symbol}.` };
  if (matches.length > 1) return { ok: false, reason: `${symbol} is awaited in ${matches.length} places here. Vibez will not guess which one you meant.` };
  if (insideConditional) return { ok: false, reason: `${symbol} already runs behind a condition.` };

  const statement = matches[0]!;
  const start = statement.getStart(file);
  const end = statement.getEnd();
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const indent = /^[ \t]*/.exec(source.slice(lineStart, start))?.[0] ?? '';
  let replacement: string;

  if (ts.isVariableStatement(statement)) {
    const declarations = statement.declarationList.declarations;
    const declaration = declarations[0];
    if (declarations.length !== 1 || declaration === undefined || declaration.initializer === undefined
      || !ts.isAwaitExpression(declaration.initializer)) {
      return { ok: false, reason: `${symbol} is used in a way Vibez cannot safely wrap yet.` };
    }
    const keyword = statement.declarationList.getFirstToken(file)?.getText(file) ?? 'const';
    const name = declaration.name.getText(file);
    const call = declaration.initializer.getText(file);
    replacement = `${keyword} ${name} = ${trimmed} ? ${call} : ${empty};`;
  } else {
    const body = statement.getText(file);
    replacement = `if (${trimmed}) {\n${indent}  ${body}\n${indent}}`;
  }

  return {
    ok: true,
    start,
    end,
    replacement,
    original: source.slice(start, end),
    line: file.getLineAndCharacterOfPosition(start).line + 1,
    summary: `${symbol} only runs when ${trimmed}.`,
  };
}
