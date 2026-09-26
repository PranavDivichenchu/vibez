import type { GNode, PortType, SemanticKey } from '../../core/src/types.ts';
import { makeNode, type PortContext } from './ops.ts';
import type { ScopedVariable } from './scope.ts';
import type { AuthoredConfig, AuthoredKind, ViAction } from './types.ts';

/**
 * Every block the search dropdown can offer, the Unreal/Blueprints way: type
 * a few letters, see it grouped by what it does, place it.
 *
 * A `CatalogEntry` is a fixed block. `SearchItem` is what the dropdown
 * actually shows, which also includes one entry per variable in scope at the
 * point it was opened (see `scope.ts`) and one per action another `.vi` file
 * in the project offers — neither of those exists until the graph around the
 * click does, so they can't be static.
 */

export interface CatalogEntry {
  kind: AuthoredKind;
  label: string;
  hint: string;
  group: 'Flow' | 'Values' | 'Data' | 'Compose';
  keywords: string[];
  config: () => AuthoredConfig;
}

export const CATALOG: CatalogEntry[] = [
  { kind: 'return', label: 'Return', hint: 'End here with a value', group: 'Flow', keywords: ['return', 'end', 'result'], config: () => ({ kind: 'return' }) },
  { kind: 'branch', label: 'If / Else', hint: 'Run one of two paths', group: 'Flow', keywords: ['if', 'else', 'branch', 'condition'], config: () => ({ kind: 'branch', condition: 'true' }) },
  { kind: 'loop', label: 'For each', hint: 'Run once per item in a list', group: 'Flow', keywords: ['loop', 'for', 'each', 'iterate', 'foreach', 'map'], config: () => ({ kind: 'loop', item: 'item', itemType: 'String' }) },
  { kind: 'literal', label: 'Value', hint: 'A fixed string, number or boolean', group: 'Values', keywords: ['literal', 'constant', 'value', 'string', 'number', 'boolean', 'text'], config: () => ({ kind: 'literal', value: '', type: 'String' }) },
  { kind: 'variable', label: 'New variable', hint: 'Store something to use later', group: 'Values', keywords: ['variable', 'let', 'const', 'set', 'store'], config: () => ({ kind: 'variable', name: 'value', type: 'String', mode: 'set', mutable: true }) },
  { kind: 'compute', label: 'Compute', hint: 'Combine two values into one', group: 'Values', keywords: ['compute', 'expression', 'math', 'add', 'concat', 'compare'], config: () => ({ kind: 'compute', expr: 'a + b' }) },
  { kind: 'data', label: 'Query', hint: 'Read from a data source', group: 'Data', keywords: ['query', 'sql', 'read', 'database', 'select', 'fetch'], config: () => ({ kind: 'data', query: '', returns: 'List' }) },
  { kind: 'effect', label: 'Mutate', hint: 'Write, insert, update or delete', group: 'Data', keywords: ['mutate', 'write', 'insert', 'update', 'delete', 'save', 'effect'], config: () => ({ kind: 'effect', op: '' }) },
  { kind: 'external', label: 'Call API', hint: 'Request a third-party service', group: 'Data', keywords: ['api', 'http', 'fetch', 'external', 'request', 'webhook'], config: () => ({ kind: 'external', method: 'GET', url: '' }) },
];

export type SearchKind = 'block' | 'get' | 'set' | 'call';

export interface SearchItem {
  id: string;
  kind: SearchKind;
  label: string;
  hint: string;
  group: string;
  keywords: string[];
  /** Instantiate the node this item stands for. `taken` avoids id collisions. */
  make: (taken: Set<SemanticKey>) => GNode;
}

function catalogItem(entry: CatalogEntry, ctx: PortContext): SearchItem {
  return {
    id: `block:${entry.kind}`,
    kind: 'block',
    label: entry.label,
    hint: entry.hint,
    group: entry.group,
    keywords: entry.keywords,
    make: (taken) => makeNode(entry.kind, entry.config(), taken, ctx),
  };
}

function variableItem(v: ScopedVariable, mode: 'get' | 'set'): SearchItem {
  return {
    id: `${mode}:${v.name}`,
    kind: mode,
    label: `${mode === 'set' ? 'Set' : 'Get'} ${v.name}`,
    hint: `${v.type} — declared by ${v.declaredAt}`,
    group: 'In scope',
    keywords: [v.name, mode, mode === 'set' ? 'assign' : 'read'],
    make: (taken) => makeNode('variable', { kind: 'variable', name: v.name, type: v.type, mode, mutable: v.mutable }, taken),
  };
}

function callItem(file: string, action: ViAction): SearchItem {
  const local = file === '';
  return {
    id: `call:${file}#${action.name}`,
    kind: 'call',
    label: local ? action.name : `${action.name} — ${file}`,
    hint: action.about ?? (action.inputs.length ? `Needs ${action.inputs.map((i) => i.name).join(', ')}` : 'No inputs'),
    group: 'Actions',
    keywords: [action.name, file],
    make: (taken) => makeNode('call', { kind: 'call', file, name: action.name }, taken, { target: action }),
  };
}

export interface SearchIndexInput {
  /** What a new "New variable" block, or a fresh entry, should look like given the export it's for. */
  ctx: PortContext;
  scope: ScopedVariable[];
  /** Other actions this graph can call: `''` for one in the same file, a relative path otherwise. */
  actions: { file: string; action: ViAction }[];
}

/** Everything the search dropdown can show, unfiltered. Filtering by port and text happens in the caller/UI. */
export function searchIndex(input: SearchIndexInput): SearchItem[] {
  const items: SearchItem[] = CATALOG.map((entry) => catalogItem(entry, input.ctx));
  for (const v of input.scope) {
    items.push(variableItem(v, 'get'));
    if (v.mutable) items.push(variableItem(v, 'set'));
  }
  for (const { file, action } of input.actions) items.push(callItem(file, action));
  return items;
}

/** Simple substring match over label, group and keywords — enough at this catalog's size. */
export function matches(item: SearchItem, query: string): boolean {
  if (!query.trim()) return true;
  const q = query.trim().toLowerCase();
  return item.label.toLowerCase().includes(q) || item.group.toLowerCase().includes(q) || item.keywords.some((k) => k.toLowerCase().includes(q));
}

/** Whether a search item has a port that could plug into the socket a drag started from. */
export function reachesFrom(item: SearchItem, wantKind: 'exec' | 'data', wantType: PortType | undefined, wantSide: 'in' | 'out'): boolean {
  const probe = item.make(new Set());
  // Dragging from an OUT socket looks for something with a compatible IN port, and vice versa.
  const ports = wantSide === 'out' ? probe.ports.in : probe.ports.out;
  return ports.some((p) => {
    if (p.kind !== wantKind) return false;
    if (p.kind === 'exec') return true;
    return wantType === undefined || wantType === 'Unknown' || p.type === undefined || p.type === 'Unknown' || p.type === wantType;
  });
}
