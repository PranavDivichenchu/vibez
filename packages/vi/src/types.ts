import type { Graph, GNode, Port } from '../../core/src/types.ts';

/**
 * A `.vi` file's logic, as a graph you build by hand rather than one
 * reconstructed from a trace.
 *
 * It reuses `@vibez/core`'s `Graph`/`GNode` exactly: an authored node is a
 * `GNode` with `config` set and its `metrics`/`heat`/`band`/`facts` zeroed,
 * because nothing has run it yet. That is what lets the same graph, and the
 * same layout and rendering code, carry a chart you just drew and a chart
 * measured from production — a node only grows real timings once its
 * generated code actually runs. See `packages/core/src/types.ts`.
 */

export const FORMAT = 'vi/1';

export type ViType = 'String' | 'Number' | 'Boolean' | 'Url' | 'Date' | 'Object' | 'List';

export interface ViValue {
  name: string;
  type: ViType;
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

/** Every kind of block the graph editor can place. */
export type AuthoredKind = 'entry' | 'return' | 'branch' | 'loop' | 'literal' | 'variable' | 'compute' | 'data' | 'effect' | 'external' | 'boundary' | 'group' | 'debug' | 'call' | 'object';

/** One block per operator, the Unreal way, rather than a single "Compute" node with a free-text expression. */
export type MathOp = '+' | '-' | '*' | '/' | '%' | 'pow' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||' | 'xor';

/** Fixed pure operations. Their catalog entries carry the visible label and typed pin schema. */
export type ComputeOp = MathOp
  | 'not' | 'negate' | 'abs' | 'sqrt' | 'min' | 'max' | 'clamp' | 'floor' | 'ceil' | 'round' | 'random' | 'randomInt' | 'mapRange' | 'percentage'
  | 'isNull' | 'isDefined' | 'isEmpty' | 'between' | 'approximatelyEqual' | 'select'
  | 'formatText' | 'concat' | 'split' | 'join' | 'replace' | 'trim' | 'upper' | 'lower' | 'contains' | 'startsWith' | 'endsWith' | 'length' | 'substring' | 'regex'
  | 'makeList' | 'listGet' | 'listSet' | 'first' | 'last' | 'listAdd' | 'listInsert' | 'listRemove' | 'removeIndex' | 'listContains' | 'findIndex' | 'listLength' | 'listClear' | 'slice' | 'reverse' | 'sort' | 'unique' | 'filter' | 'map' | 'reduce' | 'some' | 'every'
  | 'makeObject' | 'breakObject' | 'getField' | 'setField' | 'hasField' | 'removeField' | 'mergeObjects' | 'objectKeys' | 'objectValues'
  | 'mapAdd' | 'mapFind' | 'mapContains' | 'mapRemove' | 'mapLength' | 'parseJson' | 'stringifyJson'
  | 'now' | 'parseDate' | 'formatDate' | 'addDuration' | 'dateDifference' | 'before' | 'after'
  | 'toString' | 'toNumber' | 'toBoolean' | 'toDate' | 'toUrl' | 'cast';

export interface AuthoredDataPin { name: string; type?: ViType }

/** What a block's header and the search dropdown's dot color it by. `debugging` is the palette's neutral gray — it was held back from the other four on purpose, for exactly this: comments and other organization aids, and the blocks that only exist to help you find a problem. */
export type Category = 'flow' | 'value' | 'data' | 'event' | 'debugging';

/** What each block needs, beyond its ports, to generate code. Read via `configOf`. */
export type AuthoredConfig =
	| { kind: 'entry' }
	| { kind: 'return'; early?: boolean }
	| { kind: 'branch'; condition?: string; mode?: 'if' | 'sequence' | 'switch' | 'valid' | 'success' | 'try'; cases?: string[]; valueType?: ViType }
	| { kind: 'loop'; item: string; itemType: ViType; mode?: 'forEach' | 'for' | 'forWithBreak' | 'while' | 'break' | 'continue'; maxIterations?: number }
	| { kind: 'literal'; value: unknown; type: ViType }
	| { kind: 'variable'; name: string; type: ViType; mode: 'get' | 'set'; mutable: boolean }
	| { kind: 'compute'; op: ComputeOp; label?: string; inputs?: AuthoredDataPin[]; outputs?: AuthoredDataPin[] }
	| { kind: 'data'; query: string; returns: ViType; op?: 'query' | 'findOne' | 'findMany' | 'count' | 'aggregate' | 'cacheGet' | 'environment' | 'currentUser'; resource?: string }
	| { kind: 'effect'; op: string; label?: string; inputs?: AuthoredDataPin[]; outputs?: AuthoredDataPin[]; resource?: string; durationMs?: number; attempts?: number }
	| { kind: 'external'; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; mode?: 'request' | 'decode' }
	| { kind: 'boundary'; op: 'throw' | 'authorize' | 'requireRole' | 'validate' | 'safeCast'; value?: string; type?: ViType }
	| { kind: 'group'; mode: 'reroute' | 'namedReroute' | 'comment' | 'region' | 'helper' | 'bookmark'; name?: string; text?: string }
	| { kind: 'debug'; op: 'log' | 'throw'; level?: 'log' | 'warn' | 'error' }
	| { kind: 'call'; file: string; name: string }
	/**
	 * Classes and objects. `new` makes an object of a class, `get`/`set` read and
	 * change one of its fields, `call` runs one of its methods (the object's own
	 * version, so a child class's override wins), `self` is the object a method
	 * is running on, `super` runs the parent class's version of the method being
	 * written, and `isA` asks whether an object was made from a class (or a
	 * child of it).
	 */
	| { kind: 'object'; op: ObjectOp; class: string; field?: string; method?: string };

export type ObjectOp = 'new' | 'get' | 'set' | 'call' | 'self' | 'super' | 'isA';

export function configOf(node: GNode): AuthoredConfig | undefined {
  const raw = node.config as (Record<string, unknown> & { kind?: string }) | undefined;
  if (!raw?.kind) return undefined;
  // vi/1 originally stored a free-form `expr` on Compute. Convert that old
  // shape as it is read; the graph normalization pass then saves the fixed,
  // explicit operator form back to disk.
  if (raw.kind === 'compute' && typeof raw.op !== 'string') {
    const expr = typeof raw.expr === 'string' ? raw.expr : '';
    const op: MathOp = expr.includes('===') || expr.includes('==') ? '=='
      : expr.includes('!==') || expr.includes('!=') ? '!='
      : expr.includes('&&') ? '&&' : expr.includes('||') ? '||'
      : expr.includes('*') ? '*' : expr.includes('/') ? '/'
      : expr.includes('%') ? '%' : expr.includes('-') ? '-' : '+';
    return { kind: 'compute', op };
  }
  return raw as unknown as AuthoredConfig;
}

/** The one place a block's category is decided — read by both the node header and the search dropdown's color dot, so they can never drift apart. */
export function categoryOf(kind: AuthoredKind): Category {
  switch (kind) {
		case 'branch': case 'loop': case 'return': case 'boundary': return 'flow';
		case 'literal': case 'variable': case 'compute': return 'value';
		case 'data': case 'effect': case 'external': return 'data';
		case 'entry': case 'call': return 'event';
		case 'object': return 'data';
		case 'group': case 'debug': return 'debugging';
  }
}

/**
 * One authored graph: an exported action or value's logic, or a private
 * helper. It is a `Graph` with nothing measured yet — `runs: 0`, no critical
 * path, every node's timings zeroed — so it lays out and renders exactly like
 * one built from a capture.
 */
export type AuthoredGraph = Graph;

/**
 * A variable, declared once — the way Unreal's own "My Blueprint" panel
 * works, rather than however many `Get`/`Set` nodes happen to retype the same
 * name and hope they agree. Every graph in the file can read it; only a
 * `mutable` one ever offers a `Set`.
 */
export interface ViVariable {
  name: string;
  type: ViType;
  mutable: boolean;
  /** Initial file-level value. Mutable variables keep their value while the generated logic server is running. */
  initial?: unknown;
  about?: string;
}

/** One field of a class: a named, typed piece of every object made from it. */
export interface ViField {
  name: string;
  type: ViType;
  /** What a new object starts with. A field without one is asked for when the object is made. */
  initial?: unknown;
  about?: string;
}

/** Something every object of a class can do. Its logic is a graph, like a function's, with the object available as This. */
export interface ViMethod {
  name: string;
  inputs: { name: string; type: ViType }[];
  returns?: ViType;
  about?: string;
}

/**
 * A class: a blueprint for objects. It has fields every object carries and
 * methods every object can do. A class can extend another, taking all of its
 * fields and methods; a method with the same name as the parent's replaces it
 * for objects of the child class (an override).
 */
export interface ViClass {
  name: string;
  extends?: string;
  fields: ViField[];
  methods: ViMethod[];
  about?: string;
}

/** Where a method's graph is kept in `ViDoc.methods`. */
export const methodKey = (className: string, method: string): string => `${className}.${method}`;

export interface ViDoc {
  /** `'vi/0'` (exports only, the format before the graph editor existed) or `'vi/1'` (exports + logic). */
  vibez: string;
  about?: string;
  exports: ViExports;
  /** One authored graph per exported action or value, keyed by export name. */
  logic: Record<string, AuthoredGraph>;
  /** Declared once; every graph's `Get`/`Set Variable` search entries come from this list, not from retyping a name. */
  variables?: ViVariable[];
  /** Reusable graph logic, callable across `.vi` files but never mounted as a page-facing HTTP route. */
  functions?: ViAction[];
  /** One authored graph per reusable function, keyed by name — the internal counterpart to page-facing `logic`. */
  helpers?: Record<string, AuthoredGraph>;
  /** Blueprints for objects: see `ViClass`. */
  classes?: ViClass[];
  /** One authored graph per class method, keyed by `Class.method` (see `methodKey`). */
  methods?: Record<string, AuthoredGraph>;
}

export interface PortRef { node: string; port: string }

/** Where a port sits, for a search-dropdown opened by dragging off it. */
export interface DragOrigin {
  node: string;
  port: Port;
  side: 'in' | 'out';
}
