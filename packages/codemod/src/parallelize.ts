import ts from 'typescript';

/**
 * Turn a run of sequential awaits into one Promise.all.
 *
 * This is what a drag on the graph actually does. The gesture says "these steps
 * should overlap"; this is the only reasonable reading of that in code, so no
 * model is needed to guess at it. Deterministic, instant, free, and reversible.
 *
 * Edits are applied as text at AST positions rather than by reprinting the
 * file. A printer would reformat everything it touched and bury a two-line
 * change in a hundred-line diff.
 */

export interface ParallelizeRequest {
  /** Source text of the file to change. */
  source: string;
  fileName: string;
  /** Names of the awaited calls to run together, in any order. */
  calls: string[];
}

export interface CodemodResult {
  changed: boolean;
  source: string;
  /** Plain-English account of what happened, or why nothing did. */
  summary: string;
}

interface AwaitedDecl {
  statement: ts.VariableStatement;
  binding: string;
  callText: string;
  callee: string;
}

const calleeName = (call: ts.CallExpression): string =>
  ts.isPropertyAccessExpression(call.expression)
    ? call.expression.name.text
    : ts.isIdentifier(call.expression) ? call.expression.text : '';

/** `const x = await foo(...)` and nothing more elaborate. */
function asAwaitedDecl(statement: ts.Statement, source: ts.SourceFile): AwaitedDecl | undefined {
  if (!ts.isVariableStatement(statement)) return undefined;
  const decls = statement.declarationList.declarations;
  if (decls.length !== 1) return undefined;
  const [decl] = decls;
  if (decl === undefined || !ts.isIdentifier(decl.name) || decl.initializer === undefined) return undefined;
  if (!ts.isAwaitExpression(decl.initializer)) return undefined;
  const call = decl.initializer.expression;
  if (!ts.isCallExpression(call)) return undefined;
  return {
    statement,
    binding: decl.name.text,
    callText: call.getText(source),
    callee: calleeName(call),
  };
}

/** Does `later` mention anything `earlier` introduced? Then they cannot overlap. */
function dependsOn(later: AwaitedDecl, earlier: AwaitedDecl[]): boolean {
  return earlier.some((decl) => new RegExp(`\\b${decl.binding}\\b`).test(later.callText));
}

export function parallelize(request: ParallelizeRequest): CodemodResult {
  const { source, fileName, calls } = request;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const wanted = new Set(calls);

  let result: CodemodResult = {
    changed: false,
    source,
    summary: 'Nothing to run together: no back-to-back awaits matched.',
  };

  const visitBlock = (block: ts.Block | ts.SourceFile): void => {
    const statements = [...block.statements];
    let run: AwaitedDecl[] = [];

    const flush = (): void => {
      if (run.length < 2) {
        run = [];
        return;
      }
      const first = run[0]!;
      const last = run[run.length - 1]!;
      const indent = ' '.repeat(first.statement.getStart(file) - first.statement.getFullStart() - 1);
      const bindings = run.map((decl) => decl.binding).join(', ');
      const args = run.map((decl) => decl.callText).join(`,\n${indent}  `);
      const replacement = `const [${bindings}] = await Promise.all([\n${indent}  ${args},\n${indent}]);`;

      const from = first.statement.getStart(file);
      const to = last.statement.getEnd();
      result = {
        changed: true,
        source: source.slice(0, from) + replacement + source.slice(to),
        summary: `${run.length} steps now start together instead of one after another.`,
      };
      run = [];
    };

    for (const statement of statements) {
      const decl = asAwaitedDecl(statement, file);
      // A statement that is not a plain awaited call, or that needs a value an
      // earlier one produced, ends the run rather than being folded into it.
      if (decl === undefined || !wanted.has(decl.callee) || dependsOn(decl, run)) {
        flush();
        continue;
      }
      run.push(decl);
    }
    flush();
  };

  const walk = (node: ts.Node): void => {
    if (ts.isBlock(node)) visitBlock(node);
    ts.forEachChild(node, walk);
  };
  visitBlock(file);
  walk(file);

  return result;
}
