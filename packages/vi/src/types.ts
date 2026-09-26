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
export type AuthoredKind = 'entry' | 'return' | 'branch' | 'loop' | 'literal' | 'variable' | 'compute' | 'data' | 'effect' | 'external' | 'call';

/** What each block needs, beyond its ports, to generate code. Read via `configOf`. */
export type AuthoredConfig =
  | { kind: 'entry' }
  | { kind: 'return' }
  | { kind: 'branch'; condition: string }
  | { kind: 'loop'; item: string; itemType: ViType }
  | { kind: 'literal'; value: unknown; type: ViType }
  | { kind: 'variable'; name: string; type: ViType; mode: 'get' | 'set'; mutable: boolean }
  | { kind: 'compute'; expr: string }
  | { kind: 'data'; query: string; returns: ViType }
  | { kind: 'effect'; op: string }
  | { kind: 'external'; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string }
  | { kind: 'call'; file: string; name: string };

export function configOf(node: GNode): AuthoredConfig | undefined {
  return node.config as AuthoredConfig | undefined;
}

/**
 * One authored graph: an exported action or value's logic, or a private
 * helper. It is a `Graph` with nothing measured yet — `runs: 0`, no critical
 * path, every node's timings zeroed — so it lays out and renders exactly like
 * one built from a capture.
 */
export type AuthoredGraph = Graph;

export interface ViDoc {
  /** `'vi/0'` (exports only, the format before the graph editor existed) or `'vi/1'` (exports + logic). */
  vibez: string;
  about?: string;
  exports: ViExports;
  /** One authored graph per exported action or value, keyed by export name. */
  logic: Record<string, AuthoredGraph>;
  /** Reusable private subgraphs a `call` block can target instead of an export. */
  helpers?: Record<string, AuthoredGraph>;
}

export interface PortRef { node: string; port: string }

/** Where a port sits, for a search-dropdown opened by dragging off it. */
export interface DragOrigin {
  node: string;
  port: Port;
  side: 'in' | 'out';
}
