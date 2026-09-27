import { blankGraph } from './ops.ts';
import type { GNode, SemanticKey } from '../../core/src/types.ts';
import { helperFor } from './runtime.ts';
import { callableIn, hasErrors, validateGraph, type CompileIssue } from './validate.ts';
import { configOf, methodKey, type AuthoredConfig, type AuthoredGraph, type ComputeOp, type MathOp, type ViAction, type ViClass, type ViType, type ViValue, type ViVariable } from './types.ts';
import { classIssues, parentsFirst, requiredFields } from './classes.ts';

/**
 * The `.vi` graph compiler: turns one export's authored graph into a real
 * `async function` body.
 *
 * Two compilation modes, matching the split the data model already makes:
 * an **action** graph is exec-driven (walk `entry`'s run line, emitting a
 * statement per impure step, recursing through `branch`/`loop`); a **value**
 * graph is dependency-driven (no exec chain exists at all — walk `return`'s
 * data dependencies backward, run whatever impure steps it needs in
 * topological order, then return the expression).
 *
 * A block with no wire into a required pin, an unresolved `call`, or a
 * `compute` op nothing can run yet (see `runtime.ts`'s `UNSUPPORTED_OPS`) is
 * always a *validation* error, caught by `validate.ts` before any of this
 * runs — this file assumes it is only ever handed a graph with none.
 */

const MATH_SYMBOLS: Record<Exclude<MathOp, 'pow' | 'xor'>, string> = {
  '+': '+', '-': '-', '*': '*', '/': '/', '%': '%',
  '==': '===', '!=': '!==', '<': '<', '>': '>', '<=': '<=', '>=': '>=', '&&': '&&', '||': '||',
};

const RESERVED = new Set('await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield implements interface package private protected public static eval arguments Math Date JSON String Number Boolean Object Array Promise Error TypeError URL fetch console undefined NaN Infinity globalThis parseInt parseFloat isNaN Buffer'.split(' '));
function ident(base: string): string {
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(base) && !RESERVED.has(base) && !/^(?:__vi|vi_)/.test(base)) return base;
  return `__vi_name_${Array.from(base).map((c) => c.codePointAt(0)!.toString(16)).join('_')}`;
}
function variableId(name: string): string { return `__vi_var_${ident(name)}`; }

interface ExportCtx {
  graph: AuthoredGraph;
  usedOps: Set<ComputeOp>;
  /** Variable name (as authored) -> its JS identifier, shared for the whole export so every Get/Set of "total" resolves to the same local. */
  varNames: Map<string, string>;
  /** `${nodeId}|${port}` -> the JS identifier already holding that impure node's output. */
  resultOf: Map<string, string>;
  counter: { n: number };
  issues: CompileIssue[];
  callable: (file: string, name: string) => boolean;
  /** How a `call` block's target file maps to an import specifier; `''` (this file) needs none. */
  importFor: (file: string) => string;
  imports: Map<string, Set<string>>; // import specifier -> local names imported from it
  /** A `data`/`effect` block with nowhere real to run yet: function name -> the TODO message its stub throws. */
  stubs: Map<string, string>;
  /** Authored input name -> collision-free JavaScript parameter identifier. */
  params: Map<string, string>;
  classes: ViClass[];
  inMethod?: { class: string; method: string };
}

/** A class's name in the generated code. */
function classId(name: string): string { return `__vi_class_${ident(name)}`; }
/** A field or method, read off an object by its authored name, whatever characters it has. */
const member = (name: string | undefined): string => `[${JSON.stringify(name ?? '')}]`;

function temp(ctx: ExportCtx, hint: string): string {
  ctx.counter.n += 1;
  return `__vi_temp_${ctx.counter.n}`;
}

function varIdent(name: string, ctx: ExportCtx): string {
  let id = ctx.varNames.get(name);
  if (!id) {
    id = variableId(name);
    ctx.varNames.set(name, id);
  }
  return id;
}

function node(ctx: ExportCtx, id: SemanticKey): GNode {
  const found = ctx.graph.nodes.find((n) => n.id === id);
  if (!found) throw new Error(`vi compiler: node ${id} vanished mid-compile`);
  return found;
}

function sourceOf(graph: AuthoredGraph, toNode: SemanticKey, toPort: string): { node: SemanticKey; port: string } | undefined {
  const edge = graph.edges.find((e) => e.wire === 'data' && e.to.node === toNode && e.to.port === toPort);
  return edge ? { node: edge.from.node, port: edge.from.port } : undefined;
}

function execTarget(graph: AuthoredGraph, fromNode: SemanticKey, fromPort: string): SemanticKey | undefined {
  return graph.edges.find((e) => e.wire === 'exec' && e.from.node === fromNode && e.from.port === fromPort)?.to.node;
}

function execChildren(graph: AuthoredGraph): Map<SemanticKey, { port: string; to: SemanticKey }[]> {
  const out = new Map<SemanticKey, { port: string; to: SemanticKey }[]>();
  for (const edge of graph.edges) {
    if (edge.wire !== 'exec') continue;
    out.set(edge.from.node, [...(out.get(edge.from.node) ?? []), { port: edge.from.port, to: edge.to.node }]);
  }
  return out;
}

// ---------------------------------------------------------------- expressions

function literalExpr(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** A value read from a data-in port: the expression wired into it, or an already-executed impure result. */
function emitExpr(atNode: SemanticKey, atPort: string, ctx: ExportCtx): string {
  const src = sourceOf(ctx.graph, atNode, atPort);
  if (!src) return 'undefined'; // validation already refused graphs missing a required wire; this only covers optional-in-practice reads
  const already = ctx.resultOf.get(`${src.node}|${src.port}`);
  if (already !== undefined) return already;
  const from = node(ctx, src.node);
  const config = configOf(from);

  if (from.kind === 'literal' && config?.kind === 'literal') return literalExpr(config.value);
  if (from.kind === 'variable' && config?.kind === 'variable' && config.mode === 'get') return varIdent(config.name, ctx);
  if (from.kind === 'entry') {
    const name = src.port.replace(/^in:/, '');
    return ctx.params.get(name) ?? ident(name);
  }
  if (from.kind === 'group' && config?.kind === 'group' && (config.mode === 'reroute' || config.mode === 'namedReroute')) return emitExpr(src.node, 'value', ctx);
  if (from.kind === 'compute' && config?.kind === 'compute') return computeExpr(from, config, ctx);
  if (from.kind === 'object' && config?.kind === 'object') {
    if (config.op === 'self') return 'this';
    if (config.op === 'get') return `(${emitExpr(from.id, 'object', ctx)})?.${member(config.field)}`;
    if (config.op === 'isA') return `(${emitExpr(from.id, 'object', ctx)} instanceof ${classId(config.class)})`;
  }

  // An impure node reached before it ran — a well-formed graph never wires
  // one this way (see validate.ts), so this is a safety net, not a path.
  ctx.issues.push({ nodeId: src.node, severity: 'error', message: 'This value is read outside its execution path. Connect the producing block before this step, or store the result in a variable.' });
  return 'undefined';
}

function computeExpr(n: GNode, config: Extract<AuthoredConfig, { kind: 'compute' }>, ctx: ExportCtx): string {
  ctx.usedOps.add(config.op);
  const inputs = n.ports.in.filter((p) => p.kind === 'data');
  const args = inputs.map((p) => emitExpr(n.id, p.id, ctx));

  if (config.op === 'xor') return `(Boolean(${args[0]}) !== Boolean(${args[1]}))`;
  if (config.op === 'pow') return `(${args[0]} ** ${args[1]})`;
  if (Object.prototype.hasOwnProperty.call(MATH_SYMBOLS, config.op)) return `(${args[0]} ${MATH_SYMBOLS[config.op as keyof typeof MATH_SYMBOLS]} ${args[1]})`;

  // Make Object with a pin per field ({ name, price }) builds that object directly.
  if (config.op === 'makeObject' && inputs.length && !(inputs.length === 1 && inputs[0]!.name === 'fields')) {
    return `({ ${inputs.map((p, i) => `${JSON.stringify(p.name)}: ${args[i]}`).join(', ')} })`;
  }
  const helper = helperFor(config.op);
  return helper ? `${helper.name}(${args.join(', ')})` : `/* unsupported: ${config.op} */ undefined`;
}

// ---------------------------------------------------------------- impure statements

/** Emits one impure node's statement(s), recording its output(s) in `resultOf` so later `emitExpr` calls resolve to the captured local. */
function emitImpure(n: GNode, config: AuthoredConfig | undefined, ctx: ExportCtx): string[] {
  const dataIn = (portId: string) => emitExpr(n.id, portId, ctx);
  const capture = (portId: string, hint: string): string => {
    const id = temp(ctx, hint);
    ctx.resultOf.set(`${n.id}|${portId}`, id);
    return id;
  };

  switch (n.kind) {
    case 'variable': {
      if (config?.kind !== 'variable' || config.mode !== 'set') return [];
      const value = dataIn('value');
      const id = varIdent(config.name, ctx);
      const first = !ctx.resultOf.has(`declared:${id}`);
      ctx.resultOf.set(`declared:${id}`, id);
      ctx.resultOf.set(`${n.id}|out`, id);
      return [`${first ? (config.mutable ? 'let' : 'const') : ''} ${id} = ${value};`.trim()];
    }
    case 'compute': {
      // Only reached here when a compute node's result has more than one
      // consumer (see the fan-out hoist below): give it a name once.
      if (config?.kind !== 'compute') return [];
      const id = capture('result', config.op);
      return [`const ${id} = ${computeExpr(n, config, ctx)};`];
    }
    case 'data': {
      if (config?.kind !== 'data') return [];
      const id = capture('result', config.op ?? 'query');
      return [`const ${id} = await ${dataSourceStub(n, config, ctx)};`];
    }
    case 'effect': {
      if (config?.kind !== 'effect') return [];
      const inputs = n.ports.in.filter((p) => p.kind === 'data');
      const args = inputs.map((p) => dataIn(p.id));
      const outPorts = n.ports.out.filter((p) => p.kind === 'data' && p.id !== 'ok');
      const resultId = capture(outPorts[0]?.id ?? 'result', outPorts[0]?.name || 'effect');
      const okId = capture('ok', 'ok');
      const fn = stub(ctx, `effect_${config.op || 'run'}_${config.resource || n.id}`, `${n.label} isn't connected to anything yet — add where it should actually run.`);
      return [
        `const ${resultId} = await ${fn}(${args.join(', ')}).catch((error) => ({ __error: error }));`,
        `const ${okId} = !(${resultId} && ${resultId}.__error);`,
      ];
    }
    case 'external': {
      if (config?.kind !== 'external') return [];
      const body = dataIn('body');
      const responseId = temp(ctx, 'response');
      const okId = capture('ok', 'ok');
      const statusId = capture('status', 'status');
      const jsonId = capture('response', 'json');
      const lines = [`const ${responseId} = await fetch(${literalExpr(config.url)}, { method: ${literalExpr(config.method)}, headers: { 'content-type': 'application/json' }, body: ${config.method === 'GET' ? 'undefined' : `JSON.stringify(${body})`} });`];
      lines.push(`const ${okId} = ${responseId}.ok;`);
      lines.push(`const ${statusId} = ${responseId}.status;`);
      lines.push(`const ${jsonId} = await ${responseId}.json().catch(() => undefined);`);
      return lines;
    }
    case 'call': {
      if (config?.kind !== 'call') return [];
      let target = ident(config.name);
      // An empty file means a declaration in this generated module. Asking
      // importFor('') used to produce "./.vi.js", importing the function from
      // this module and then declaring it again at the bottom.
      const specifier = config.file ? ctx.importFor(config.file) : '';
      if (specifier) {
        const alias = `__vi_import_${Array.from(specifier).map(c => c.codePointAt(0)!.toString(16)).join('_')}_${target}`;
        ctx.imports.set(specifier, new Set([...(ctx.imports.get(specifier) ?? []), `${target} as ${alias}`]));
        target = alias;
      }
      const inputs = n.ports.in.filter((p) => p.kind === 'data');
      const args = inputs.map((p) => dataIn(p.id));
      const resultPort = n.ports.out.find((p) => p.kind === 'data');
      const id = resultPort ? capture(resultPort.id, config.name) : temp(ctx, config.name);
      return [`const ${id} = await ${target}(${args.join(', ')});`];
    }
    case 'object': {
      if (config?.kind !== 'object') return [];
      if (config.op === 'new') {
        const fields = requiredFields(ctx.classes, config.class).map((f) => `${JSON.stringify(f.name)}: ${dataIn(`field:${f.name}`)}`);
        const id = capture('object', config.class);
        return [`const ${id} = new ${classId(config.class)}({ ${fields.join(', ')} });`];
      }
      if (config.op === 'set') {
        const id = capture('object', config.class);
        return [`const ${id} = ${dataIn('object')};`, `${id}${member(config.field)} = ${dataIn('value')};`];
      }
      if (config.op === 'call' || config.op === 'super') {
        const args = n.ports.in.filter((p) => p.kind === 'data' && p.id.startsWith('in:')).map((p) => dataIn(p.id));
        const receiver = config.op === 'super' ? 'super' : `(${dataIn('object')})`;
        const resultPort = n.ports.out.find((p) => p.kind === 'data');
        const id = resultPort ? capture(resultPort.id, config.method ?? 'result') : temp(ctx, 'call');
        return [`const ${id} = await ${receiver}${member(config.method)}(${args.join(', ')});`];
      }
      return [];
    }
    case 'boundary':
      return emitBoundaryStatement(n, config, ctx);
    case 'debug': {
      if (config?.kind !== 'debug') return [];
      if (config.op === 'throw') {
        return [`throw new Error(${dataIn('message')});`];
      }
      return [`console.${config.level ?? 'log'}(${dataIn('value')});`];
    }
    case 'group':
      return []; // reroute/helper pass straight through; comment/region/bookmark carry no behavior
    default:
      return [];
  }
}

/** Registers (once) a stub function for a block with nowhere real to run yet, and returns its call — see the compiler plan's "clear stubs" decision. Named after the block so the TODO is easy to find and fill in by hand. */
function stub(ctx: ExportCtx, hint: string, message: string): string {
  const fn = ident(hint);
  if (!ctx.stubs.has(fn)) ctx.stubs.set(fn, message);
  return fn;
}

function dataSourceStub(n: GNode, config: Extract<AuthoredConfig, { kind: 'data' }>, ctx: ExportCtx): string {
  const fn = stub(ctx, `data_${config.op ?? 'query'}_${config.resource || n.id}`, `${n.label} isn't connected to a data source yet.`);
  return `${fn}()`;
}

function emitBoundaryStatement(n: GNode, config: AuthoredConfig | undefined, ctx: ExportCtx): string[] {
  if (config?.kind !== 'boundary') return [];
  if (config.op === 'throw') {
    return [`throw new Error(${emitExpr(n.id, 'error', ctx)}?.message ?? ${emitExpr(n.id, 'error', ctx)});`];
  }
  // authorize / requireRole / validate / safeCast all branch (success/failure
  // or true/false); their control flow is handled by the branch-arm walker
  // that calls this, same as any other multi-exec-out node — nothing to run
  // here beyond computing the guard's own boolean/result, which the arm
  // walker reads back via `ok`/`result`.
  return [];
}

// ---------------------------------------------------------------- structured control flow

function reachableDepths(graph: AuthoredGraph, start: SemanticKey, children: Map<SemanticKey, { port: string; to: SemanticKey }[]>): Map<SemanticKey, number> {
  const depth = new Map<SemanticKey, number>();
  const queue: [SemanticKey, number][] = [[start, 0]];
  while (queue.length) {
    const [id, d] = queue.shift()!;
    if (depth.has(id)) continue;
    depth.set(id, d);
    for (const child of children.get(id) ?? []) queue.push([child.to, d + 1]);
  }
  return depth;
}

/** The closest node every arm eventually reaches, if any — where an if/else's paths reconverge. The graph is acyclic (see the module doc), so a plain multi-source BFS is enough. */
function findJoin(graph: AuthoredGraph, starts: SemanticKey[]): SemanticKey | undefined {
  if (starts.length < 2) return undefined;
  const children = execChildren(graph);
  const sets = starts.map((s) => reachableDepths(graph, s, children));
  let best: SemanticKey | undefined;
  let bestScore = Infinity;
  for (const [id, d0] of sets[0]!) {
    if (sets.every((s) => s.has(id))) {
      const score = sets.reduce((acc, s) => acc + s.get(id)!, d0 - sets[0]!.get(id)!);
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    }
  }
  return best;
}

function indent(lines: string[]): string[] {
  return lines.flatMap((line) => line.split('\n')).map((line) => `  ${line}`);
}

/** Emits `nodeId` and everything reachable from it, stopping (without emitting) at anything in `stop`. */
function emitChain(nodeId: SemanticKey | undefined, stop: ReadonlySet<SemanticKey>, ctx: ExportCtx): string[] {
  if (nodeId === undefined || stop.has(nodeId)) return [];
  const n = node(ctx, nodeId);
  const config = configOf(n);

  if (n.kind === 'return') {
    const value = n.ports.in.some((p) => p.id === 'value') ? emitExpr(n.id, 'value', ctx) : undefined;
    return [value !== undefined ? `return ${value};` : 'return;'];
  }
  if (n.kind === 'loop' && config?.kind === 'loop' && (config.mode === 'break' || config.mode === 'continue')) {
    return [config.mode === 'break' ? 'break;' : 'continue;'];
  }
  if (n.kind === 'loop' && config?.kind === 'loop' && config.mode !== 'break' && config.mode !== 'continue') {
    return emitLoop(n, config, ctx, stop);
  }
  if (n.kind === 'branch' && config?.kind === 'branch') {
    return emitBranch(n, config, ctx, stop);
  }
  if (n.kind === 'boundary' && config?.kind === 'boundary' && config.op !== 'throw') {
    return emitGuard(n, config, ctx, stop);
  }
  if (n.kind === 'boundary' && config?.kind === 'boundary' && config.op === 'throw') {
    return emitImpure(n, config, ctx); // terminal; no exec-out to continue from
  }
  if (n.kind === 'debug' && config?.kind === 'debug' && config.op === 'throw') {
    return emitImpure(n, config, ctx); // terminal, same as boundary's throw
  }

  const before = fanOutHoist(n, ctx);
  const stmts = [...before, ...emitImpure(n, config, ctx)];
  const nextPort = n.ports.out.find((p) => p.kind === 'exec');
  const next = nextPort ? execTarget(ctx.graph, n.id, nextPort.id) : undefined;
  return [...stmts, ...emitChain(next, stop, ctx)];
}

/** A pure node whose output feeds more than one place is computed once, by name, rather than re-inlined at every use. */
function fanOutHoist(n: GNode, ctx: ExportCtx): string[] {
  if (n.kind !== 'compute') return [];
  const config = configOf(n);
  if (config?.kind !== 'compute') return [];
  const consumers = ctx.graph.edges.filter((e) => e.wire === 'data' && e.from.node === n.id);
  if (consumers.length <= 1 || ctx.resultOf.has(`${n.id}|result`)) return [];
  return emitImpure(n, config, ctx); // reuses the "compute" case above, which captures into resultOf
}

function emitBranch(n: GNode, config: Extract<AuthoredConfig, { kind: 'branch' }>, ctx: ExportCtx, stop: ReadonlySet<SemanticKey>): string[] {
  const mode = config.mode ?? 'if';
  if (mode === 'sequence') {
    return n.ports.out.filter((p) => p.kind === 'exec').flatMap((p) => emitChain(execTarget(ctx.graph, n.id, p.id), stop, ctx));
  }

  const arms = n.ports.out.filter((p) => p.kind === 'exec').map((p) => ({ port: p.id, name: p.name, target: execTarget(ctx.graph, n.id, p.id) }));
  const starts = arms.map((a) => a.target).filter((t): t is SemanticKey => t !== undefined);
  const join = findJoin(ctx.graph, starts);
  const innerStop = join ? new Set([...stop, join]) : stop;
  const incomingResults = new Map(ctx.resultOf);
  const armCode = arms.map((a) => {
    ctx.resultOf = new Map(incomingResults);
    return emitChain(a.target, innerStop, ctx);
  });
  ctx.resultOf = incomingResults;

  let stmt: string;
  if (mode === 'switch') {
    const selection = emitExpr(n.id, 'selection', ctx);
    const body = arms.map((a, i) => [`case ${literalExpr(a.name)}:`, ...indent(armCode[i]!), '  break;'].join('\n')).join('\n');
    stmt = `switch (${selection}) {\n${indent([body]).join('\n')}\n}`;
  } else if (mode === 'try') {
    const [tryArm, catchArm] = armCode;
    stmt = `try {\n${indent(tryArm ?? []).join('\n')}\n} catch (${ident('error')}) {\n${indent(catchArm ?? []).join('\n')}\n}`;
  } else {
    const condition = mode === 'valid' ? `(${emitExpr(n.id, 'value', ctx)} !== null && ${emitExpr(n.id, 'value', ctx)} !== undefined)`
      : mode === 'success' ? emitExpr(n.id, 'success', ctx)
      : emitExpr(n.id, 'condition', ctx);
    const [trueArm, falseArm] = armCode;
    stmt = falseArm?.length
      ? `if (${condition}) {\n${indent(trueArm ?? []).join('\n')}\n} else {\n${indent(falseArm).join('\n')}\n}`
      : `if (${condition}) {\n${indent(trueArm ?? []).join('\n')}\n}`;
  }
  return [stmt, ...emitChain(join, stop, ctx)];
}

/** `boundary` ops other than `throw` are two-armed guards — same shape as an if/else, but the "condition" is the guard's own success/failure. */
function emitGuard(n: GNode, config: Extract<AuthoredConfig, { kind: 'boundary' }>, ctx: ExportCtx, stop: ReadonlySet<SemanticKey>): string[] {
  const successTarget = execTarget(ctx.graph, n.id, 'exec:success');
  const failureTarget = execTarget(ctx.graph, n.id, 'exec:failure');
  const starts = [successTarget, failureTarget].filter((t): t is SemanticKey => t !== undefined);
  const join = findJoin(ctx.graph, starts);
  const innerStop = join ? new Set([...stop, join]) : stop;

  const value = config.op === 'requireRole' ? undefined : emitExpr(n.id, 'value', ctx);
  const guard = config.op === 'authorize' ? `${value ?? 'currentUser'} != null`
    : config.op === 'requireRole' ? `Array.isArray(${ident('currentUser')}?.roles) && ${ident('currentUser')}.roles.includes(${literalExpr(config.value)})`
    : config.op === 'safeCast' ? `${value} !== null && ${value} !== undefined`
    : `Boolean(${value})`; // validate

  if (config.op === 'safeCast') {
    const resultId = temp(ctx, 'cast');
    ctx.resultOf.set(`${n.id}|result`, resultId);
    const successArm = [`const ${resultId} = ${value};`, ...emitChain(successTarget, innerStop, ctx)];
    const failureArm = emitChain(failureTarget, innerStop, ctx);
    const stmt = `if (${guard}) {\n${indent(successArm).join('\n')}\n} else {\n${indent(failureArm).join('\n')}\n}`;
    return [stmt, ...emitChain(join, stop, ctx)];
  }

  const okId = temp(ctx, 'ok');
  ctx.resultOf.set(`${n.id}|ok`, okId);
  const successArm = emitChain(successTarget, innerStop, ctx);
  const failureArm = emitChain(failureTarget, innerStop, ctx);
  const stmt = [`const ${okId} = ${guard};`, `if (${okId}) {\n${indent(successArm).join('\n')}\n} else {\n${indent(failureArm).join('\n')}\n}`].join('\n');
  return [stmt, ...emitChain(join, stop, ctx)];
}

function emitLoop(n: GNode, config: Extract<AuthoredConfig, { kind: 'loop' }>, ctx: ExportCtx, stop: ReadonlySet<SemanticKey>): string[] {
  const bodyTarget = execTarget(ctx.graph, n.id, 'exec:body');
  const doneTarget = execTarget(ctx.graph, n.id, 'exec:done');
  const incomingResults = new Map(ctx.resultOf);
  const itemId = temp(ctx, 'item');
  const indexId = temp(ctx, 'index');
  ctx.resultOf.set(`${n.id}|item`, itemId);
  ctx.resultOf.set(`${n.id}|index`, indexId);

  let header: string;
  if (config.mode === 'for' || config.mode === 'forWithBreak') {
    header = `for (let ${indexId} = ${emitExpr(n.id, 'first', ctx)}; ${indexId} <= ${emitExpr(n.id, 'last', ctx)}; ${indexId}++)`;
  } else if (config.mode === 'while') {
    const limit = config.maxIterations ?? 1000;
    header = `for (let ${indexId} = 0; (${emitExpr(n.id, 'condition', ctx)}) && ${indexId} < ${limit}; ${indexId}++)`;
  } else {
    const items = emitExpr(n.id, 'items', ctx);
    header = `for (const [${indexId}, ${itemId}] of (${items}).entries())`;
  }
  const body = emitChain(bodyTarget, stop, ctx);
  ctx.resultOf = incomingResults;
  const stmt = `${header} {\n${indent(body).join('\n')}\n}`;
  return [stmt, ...emitChain(doneTarget, stop, ctx)];
}

// ---------------------------------------------------------------- per-export compilation

export interface CompileFileOptions {
  /** This file's own callable actions, by name. */
  actions: ViAction[];
  /** Another `.vi` file's actions, keyed however `call.file` refers to it (a relative path). */
  siblings: Map<string, ViAction[]>;
  /** The import specifier for a `call.file` reference; `''` (local) is never asked for. */
  importFor: (file: string) => string;
  /** Variables declared at file scope, available to every graph in the file. */
  variables: ViVariable[];
  classes?: ViClass[];
}

export interface CompiledExport {
  name: string;
  code: string;
  issues: CompileIssue[];
  imports: Map<string, Set<string>>;
  /** Merged into the whole file's preamble once, deduplicated — never written per-export, or two exports using the same op would redeclare the same `const`. */
  usedOps: Set<ComputeOp>;
  stubs: Map<string, string>;
}

function newCtx(graph: AuthoredGraph, opts: CompileFileOptions): ExportCtx {
  const varNames = new Map(opts.variables.map((variable) => [variable.name, variableId(variable.name)]));
  const resultOf = new Map(opts.variables.map((variable) => [`declared:${variableId(variable.name)}`, variableId(variable.name)]));
  return {
    graph, usedOps: new Set(), varNames, resultOf, counter: { n: 0 }, issues: [],
    callable: callableIn(opts.actions, opts.siblings),
    importFor: opts.importFor,
    imports: new Map(),
    stubs: new Map(), params: new Map(),
    classes: opts.classes ?? [],
  };
}

function parameterIds(inputs: { name: string }[], ctx: ExportCtx): string[] {
  const used = new Set<string>();
  return inputs.map((input) => {
    const base = `__vi_arg_${used.size}`;
    let next = base;
    let suffix = 2;
    while (used.has(next)) next = `${base}_${suffix++}`;
    used.add(next);
    ctx.params.set(input.name, next);
    return next;
  });
}

function compileAction(name: string, graph: AuthoredGraph, decl: { inputs: { name: string; type: ViType }[]; returns?: ViType }, opts: CompileFileOptions, visibility: 'export' | 'private' | 'method' = 'export', inMethod?: { class: string; method: string }): CompiledExport {
  const ctx = newCtx(graph, opts);
  if (inMethod) ctx.inMethod = inMethod;
  const issues = validateGraph(graph, { requiresReturn: decl.returns !== undefined, callable: ctx.callable, variables: opts.variables, classes: ctx.classes, ...(inMethod ? { inMethod } : {}) });
  const params = parameterIds(decl.inputs, ctx).join(', ');
  if (hasErrors(issues)) {
    return { name, issues, code: refusalStub(name, params, issues, visibility), imports: new Map(), usedOps: new Set(), stubs: new Map() };
  }
  const entry = graph.nodes.find((n) => n.kind === 'entry');
  const body = entry ? emitChain(execTarget(graph, entry.id, 'exec:out'), new Set(), ctx) : [];
  const header = visibility === 'method' ? `async ${member(name)}(${params})` : `${visibility === 'export' ? 'export ' : ''}async function ${ident(name)}(${params})`;
  const code = hasErrors(ctx.issues) ? refusalStub(name, params, ctx.issues, visibility) : `${header} {\n${indent(body).join('\n') || '  return;'}\n}`;
  return { name, issues: [...issues, ...ctx.issues], code, imports: ctx.imports, usedOps: ctx.usedOps, stubs: ctx.stubs };
}

/** A value graph has no exec chain: walk `return`'s data dependencies backward, run whatever's impure in topological order, then return. */
function compileValue(name: string, graph: AuthoredGraph, decl: { returns?: ViType }, opts: CompileFileOptions): CompiledExport {
  // Current value graphs are execution-driven too. They still take no
  // arguments, but their Start line can run queries, effects, debug nodes,
  // and branches before Return supplies the page value.
  if (graph.nodes.some((n) => n.kind === 'entry')) {
    return compileAction(name, graph, { inputs: [], ...(decl.returns !== undefined ? { returns: decl.returns } : {}) }, opts);
  }

  // Legacy files authored before values gained a Start node remain runnable;
  // opening one in the editor migrates it to the execution-driven shape.
  const ctx = newCtx(graph, opts);
  const issues = validateGraph(graph, { requiresReturn: true, callable: ctx.callable, variables: opts.variables });
  if (hasErrors(issues)) {
    return { name, issues, code: refusalStub(name, '', issues), imports: new Map(), usedOps: new Set(), stubs: new Map() };
  }
  const ret = graph.nodes.find((n) => n.kind === 'return');
  const stmts: string[] = [];
  const visited = new Set<SemanticKey>();
  const visit = (id: SemanticKey): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const n = node(ctx, id);
    for (const port of n.ports.in) {
      if (port.kind !== 'data') continue;
      const src = sourceOf(graph, id, port.id);
      if (src) visit(src.node);
    }
    const config = configOf(n);
    if (n.kind === 'data' || n.kind === 'effect' || n.kind === 'external' || n.kind === 'call' || (n.kind === 'variable' && config?.kind === 'variable' && config.mode === 'set')) {
      stmts.push(...emitImpure(n, config, ctx));
    }
  };
  if (ret) visit(ret.id);
  const value = ret?.ports.in.some((p) => p.id === 'value') ? emitExpr(ret.id, 'value', ctx) : 'undefined';
  const code = `export async function ${ident(name)}() {\n${indent([...stmts, `return ${value};`]).join('\n')}\n}`;
  return { name, issues: [...issues, ...ctx.issues], code, imports: ctx.imports, usedOps: ctx.usedOps, stubs: ctx.stubs };
}

function refusalStub(name: string, params: string, issues: CompileIssue[], visibility: 'export' | 'private' | 'method' = 'export'): string {
  const reasons = issues.filter((i) => i.severity === 'error').map((i) => i.message);
  return [
    visibility === 'method' ? `async ${member(name)}(${params}) {` : `${visibility === 'export' ? 'export ' : ''}async function ${ident(name)}(${params}) {`,
    `  // This block can't compile yet:`,
    ...reasons.map((r) => `  //  - ${r.replace(/\n/g, ' ')}`),
    `  throw new Error(${literalExpr(`${name} isn't ready to run: ${reasons.join('; ')}`)});`,
    `}`,
  ].join('\n');
}

// ---------------------------------------------------------------- whole file

export interface CompileFileResult {
  ok: boolean;
  /** The generated module source — always syntactically valid, even when some exports are refusal stubs. */
  code: string;
  issues: (CompileIssue & { exportName: string })[];
}

/**
 * Compiles every value and action a `.vi` file exports into one module, one
 * `async function` each. A `call` block reaching outside this file needs
 * `siblings`/`importFor` from the caller, since this module knows nothing
 * about where other `.vi` files live on disk — see `viEditor.ts`'s
 * `compileAndWrite` for how the editor supplies those from its own
 * workspace scan.
 */
export function compileFile(
  values: ViValue[], actions: ViAction[], logic: Record<string, AuthoredGraph>,
  siblings: Map<string, ViAction[]>, importFor: (file: string) => string,
  functions: ViAction[] = [], helpers: Record<string, AuthoredGraph> = {}, variables: ViVariable[] = [],
  classes: ViClass[] = [], methods: Record<string, AuthoredGraph> = {},
): CompileFileResult {
  // A `call` may target a reusable function exactly as freely as an exposed
  // action — the only difference is a function is never mounted over HTTP —
  // so both go in the same "what can this file's own calls resolve to" list.
  const declared = [...values, ...actions, ...functions];
  const duplicate = declared.find((item, i) => declared.findIndex(other => other.name === item.name) !== i)
    ?? variables.find((item, i) => variables.findIndex(other => other.name === item.name) !== i);
  if (duplicate) {
    const message = `Duplicate declaration: ${duplicate.name}. Give each value, action and function a unique name.`;
    return { ok: false, code: `throw new Error(${JSON.stringify(message)});`, issues: [{ nodeId: '' as SemanticKey, exportName: duplicate.name, severity: 'error', message }] };
  }
  const problems = classIssues(classes, declared.map((d) => d.name)).filter((i) => i.severity === 'error');
  if (problems.length) {
    const message = problems.map((p) => p.message).join(' ');
    return { ok: false, code: `throw new Error(${JSON.stringify(message)});`, issues: problems.map((p) => ({ nodeId: '' as SemanticKey, exportName: p.className, severity: 'error' as const, message: p.message })) };
  }
  const opts: CompileFileOptions = { actions: [...actions, ...functions], siblings, importFor, variables, classes };
  const results: CompiledExport[] = [];
  for (const value of values) {
    const graph = (Object.prototype.hasOwnProperty.call(logic, value.name) ? logic[value.name] : undefined) ?? blankGraph(value.name);
    if (graph) results.push(compileValue(value.name, graph, { returns: value.type }, opts));
  }
  for (const action of actions) {
    const graph = (Object.prototype.hasOwnProperty.call(logic, action.name) ? logic[action.name] : undefined) ?? blankGraph(action.name);
    if (graph) results.push(compileAction(action.name, graph, { inputs: action.inputs, ...(action.returns !== undefined ? { returns: action.returns } : {}) }, opts));
  }
  for (const fn of functions) {
    const graph = (Object.prototype.hasOwnProperty.call(helpers, fn.name) ? helpers[fn.name] : undefined) ?? blankGraph(fn.name);
    if (graph) results.push(compileAction(fn.name, graph, { inputs: fn.inputs, ...(fn.returns !== undefined ? { returns: fn.returns } : {}) }, opts, 'export'));
  }

  // Classes: each becomes a JavaScript class whose methods are its method
  // graphs, so an object runs its own class's version of a method (overrides
  // work) and Call Parent is `super`.
  const methodResults: CompiledExport[] = [];
  const classCode: string[] = [];
  const defaultFor = (type: ViType): unknown => type === 'Number' ? 0 : type === 'Boolean' ? false : type === 'List' ? [] : type === 'Object' ? {} : '';
  for (const cls of parentsFirst(classes)) {
    const own = cls.fields.map((f) => `    this${member(f.name)} = fields${member(f.name)} !== undefined ? fields${member(f.name)} : ${literalExpr(f.initial !== undefined ? f.initial : defaultFor(f.type))};`);
    const body = cls.methods.map((m) => {
      const key = methodKey(cls.name, m.name);
      const graph = (Object.prototype.hasOwnProperty.call(methods, key) ? methods[key] : undefined) ?? blankGraph(key);
      const result = compileAction(m.name, graph, { inputs: m.inputs, ...(m.returns !== undefined ? { returns: m.returns } : {}) }, opts, 'method', { class: cls.name, method: m.name });
      methodResults.push({ ...result, name: key });
      return indent([result.code]).join('\n');
    });
    const ctor = [`  constructor(fields = {}) {`, ...(cls.extends ? ['    super(fields);'] : []), ...own, '  }'];
    classCode.push([`export class ${classId(cls.name)}${cls.extends ? ` extends ${classId(cls.extends)}` : ''} {`, ...ctor, ...body, '}'].join('\n'));
  }
  results.push(...methodResults);
  // Each class is also exported under its own name, for code that imports the compiled module.
  const classAliases = classes.map((c) => `export { ${classId(c.name)} as ${/^[A-Za-z_$][\w$]*$/.test(c.name) ? c.name : JSON.stringify(c.name)} };`);

  const allImports = new Map<string, Set<string>>();
  const allOps = new Set<ComputeOp>();
  const allStubs = new Map<string, string>();
  for (const r of results) {
    for (const [specifier, names] of r.imports) {
      const existing = allImports.get(specifier) ?? new Set<string>();
      for (const name of names) existing.add(name);
      allImports.set(specifier, existing);
    }
    for (const op of r.usedOps) allOps.add(op);
    for (const [fn, message] of r.stubs) if (!allStubs.has(fn)) allStubs.set(fn, message);
  }
  const importLines = [...allImports].map(([specifier, names]) => `import { ${[...names].join(', ')} } from ${JSON.stringify(specifier)};`);
  const helperLines = [...allOps].map((op) => helperFor(op)).filter((h): h is NonNullable<ReturnType<typeof helperFor>> => h !== undefined)
    .map((h) => `const ${h.name} = (${h.params.join(', ')}) => (${h.body});`);
  const stubLines = [...allStubs].map(([fn, message]) => `async function ${fn}() {\n  // TODO: ${message}\n  throw new Error(${literalExpr(`${fn}: not connected to anything real yet`)});\n}`);
  const variableLines = variables.map((variable) => `${variable.mutable ? 'let' : 'const'} ${variableId(variable.name)} = ${literalExpr(variable.initial ?? defaultFor(variable.type))};`);
  const compiledNames = new Set(results.map((result) => result.name));
  const manifestGroup = (items: { name: string }[]) => `{ ${items.filter((item) => compiledNames.has(item.name)).map((item) => `[${JSON.stringify(item.name)}]: ${ident(item.name)}`).join(', ')} }`;
  const classManifest = `{ ${classes.map((c) => `[${JSON.stringify(c.name)}]: ${classId(c.name)}`).join(', ')} }`;
  const testManifest = `export const __vibezTest = { values: ${manifestGroup(values)}, actions: ${manifestGroup(actions)}, functions: ${manifestGroup(functions)}, classes: ${classManifest} };`;
  const code = [
    importLines.join('\n'),
    [...helperLines, ...variableLines, ...stubLines].join('\n'),
    classCode.join('\n\n'),
    results.filter((r) => !methodResults.includes(r)).map((r) => r.code).join('\n\n'),
    classAliases.join('\n'),
    testManifest,
  ].filter(Boolean).join('\n\n');

  return {
    ok: !results.some((r) => hasErrors(r.issues)),
    code: code || 'export {};',
    issues: results.flatMap((r) => r.issues.map((i) => ({ ...i, exportName: r.name }))),
  };
}

// ---------------------------------------------------------------- the served contract

export interface ServerFile {
  /** The path a page's `.ui` links it by, e.g. `dashboard.vi`. */
  relative: string;
  /** Only names are needed here — a value's type and an action's `about` never affect how it's served. */
  exports: { values: { name: string }[]; actions: Pick<ViAction, 'name' | 'inputs'>[] };
  /** Where that file's compiled module lives, as an import specifier relative to the server file — usually `./<name>.vi.js`. */
  moduleSpecifier: string;
}

/**
 * The other half of `docs/ui-vi-contract.md`: a compiled `.ui` page has
 * always fetched `GET/POST /vibez/<file>/<export>`, but nothing has ever
 * answered there. This generates the small server that does — imports every
 * compiled `.vi` module once and mounts exactly those addresses, so a page
 * shows real values instead of samples the moment this is running.
 */
export function compileServer(files: ServerFile[], port = 4310): string {
  const importLines: string[] = [];
  const valueEntries: string[] = [];
  const actionEntries: string[] = [];
  // Keyed by file name alone: a page names a .vi file relative to itself
  // (\`../logic/shop.vi\` from pages/), and logic file names are unique in a
  // project (the shared build folder requires it), so the name is enough.
  const fileName = (path: string): string => path.split('/').pop() ?? path;
  files.forEach((file, i) => {
    const ns = `mod_${i}`;
    importLines.push(`import * as ${ns} from ${JSON.stringify(file.moduleSpecifier)};`);
    for (const value of file.exports.values) {
      valueEntries.push(`  ${JSON.stringify(`${fileName(file.relative)}\u0000${value.name}`)}: ${ns}.__vibezTest?.values[${JSON.stringify(value.name)}] ?? ${ns}[${JSON.stringify(value.name)}],`);
    }
    for (const action of file.exports.actions) {
      actionEntries.push(`  ${JSON.stringify(`${fileName(file.relative)}\u0000${action.name}`)}: { fn: ${ns}.__vibezTest?.actions[${JSON.stringify(action.name)}] ?? ${ns}[${JSON.stringify(action.name)}], inputs: ${JSON.stringify(action.inputs.map((i) => i.name))} },`);
    }
  });

  return `${importLines.join('\n')}
import { createServer } from 'node:http';

// GENERATED by the .vi compiler. Regenerated by Compile, Run or Test —
// hand edits here are lost on the next build. See
// docs/ui-vi-contract.md for the addresses a compiled .ui page expects.

const VALUES = {
${valueEntries.join('\n')}
};
const ACTIONS = {
${actionEntries.join('\n')}
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) { reject(Object.assign(new Error('Request body exceeds 1 MB'), { status: 413 })); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (bytes > 1024 * 1024) return;
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        const input = data ? JSON.parse(data) : {};
        if (input === null || Array.isArray(input) || typeof input !== 'object') throw new Error('Expected a JSON object');
        resolve(input);
      } catch { reject(Object.assign(new Error('Expected a valid JSON object'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  let label = req.method ?? 'request';
  try {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = url.pathname.match(/^\\/vibez\\/([^/]+)\\/([^/]+)$/);
  if (!match) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' })); return; }
  const key = \`\${decodeURIComponent(match[1]).split('/').pop()}\\u0000\${decodeURIComponent(match[2])}\`;
  label = \`\${req.method} \${decodeURIComponent(match[1])}#\${decodeURIComponent(match[2])}\`;
  const started = Date.now();
  res.on('finish', () => console.log(\`\${label} -> \${res.statusCode} (\${Date.now() - started} ms)\`));
    if (req.method === 'GET' && VALUES[key]) {
      const body = JSON.stringify((await VALUES[key]()) ?? null);
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    } else if (req.method === 'POST' && ACTIONS[key]) {
      const input = await readBody(req);
      const args = ACTIONS[key].inputs.map((name) => input[name]);
      const body = JSON.stringify((await ACTIONS[key].fn(...args)) ?? null);
      res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    } else {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
    }
  } catch (error) {
    console.error(\`\${label} failed: \${String(error?.message ?? error)}\`);
    res.writeHead(error instanceof URIError ? 400 : error?.status === 400 || error?.status === 413 ? error.status : 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error?.message ?? error) }));
  }
});

const port = Number(process.env.PORT ?? ${port});
server.listen(port, '127.0.0.1', () => console.log(\`vibez serving on http://127.0.0.1:\${port}\`));
`;
}
