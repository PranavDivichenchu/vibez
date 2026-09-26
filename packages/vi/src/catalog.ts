import type { GNode, PortType, SemanticKey } from '../../core/src/types.ts';
import { makeNode, type PortContext } from './ops.ts';
import type { ScopedVariable } from './scope.ts';
import { categoryOf, type AuthoredConfig, type AuthoredDataPin, type AuthoredKind, type Category, type ComputeOp, type MathOp, type ViAction, type ViType } from './types.ts';

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
  group: string;
  keywords: string[];
  config: () => AuthoredConfig;
}

/** One catalog entry per operator, Unreal-style, rather than one "Compute" node with a free-text expression. */
const MATH_OPS: { op: MathOp; label: string; keywords: string[] }[] = [
  { op: '+', label: 'Add (+)', keywords: ['add', 'plus', 'sum', 'concat'] },
  { op: '-', label: 'Subtract (−)', keywords: ['subtract', 'minus'] },
  { op: '*', label: 'Multiply (×)', keywords: ['multiply', 'times'] },
  { op: '/', label: 'Divide (÷)', keywords: ['divide'] },
  { op: '%', label: 'Modulo (%)', keywords: ['modulo', 'remainder'] },
  { op: 'pow', label: 'Power', keywords: ['power', 'exponent'] },
  { op: '==', label: 'Equals (=)', keywords: ['equals', 'compare', 'equal'] },
  { op: '!=', label: 'Not Equals (≠)', keywords: ['not equals', 'compare', 'different'] },
  { op: '<', label: 'Less Than (<)', keywords: ['less than', 'compare'] },
  { op: '>', label: 'Greater Than (>)', keywords: ['greater than', 'compare'] },
  { op: '<=', label: 'Less Than or Equal (≤)', keywords: ['less than equal', 'compare'] },
  { op: '>=', label: 'Greater Than or Equal (≥)', keywords: ['greater than equal', 'compare'] },
  { op: '&&', label: 'And (&&)', keywords: ['and', 'boolean', 'logic'] },
  { op: '||', label: 'Or (||)', keywords: ['or', 'boolean', 'logic'] },
  { op: 'xor', label: 'XOR', keywords: ['exclusive or', 'boolean', 'logic'] },
];

const pin = (name: string, type?: ViType): AuthoredDataPin => type ? { name, type } : { name };
const pure = (group: string, label: string, op: ComputeOp, inputs: AuthoredDataPin[], outputs: AuthoredDataPin[], keywords: string[] = [], hint = 'Transform values without changing application state'): CatalogEntry => ({
  kind: 'compute', group, label, hint, keywords: [label, op, ...keywords],
  config: () => ({ kind: 'compute', op, label, inputs, outputs }),
});
const flow = (label: string, mode: NonNullable<Extract<AuthoredConfig, { kind: 'branch' }>['mode']>, hint: string, cases?: string[], valueType?: ViType): CatalogEntry => ({
  kind: 'branch', group: 'Flow', label, hint, keywords: [label, 'flow', 'branch'],
  config: () => ({ kind: 'branch', mode, ...(cases ? { cases } : {}), ...(valueType ? { valueType } : {}) }),
});
const loop = (label: string, mode: NonNullable<Extract<AuthoredConfig, { kind: 'loop' }>['mode']>, hint: string): CatalogEntry => ({
  kind: 'loop', group: 'Flow', label, hint, keywords: [label, 'loop', 'iterate'],
  config: () => ({ kind: 'loop', mode, item: 'item', itemType: 'String', ...(mode === 'while' ? { maxIterations: 1000 } : {}) }),
});
const read = (label: string, op: NonNullable<Extract<AuthoredConfig, { kind: 'data' }>['op']>, returns: ViType, hint: string): CatalogEntry => ({
  kind: 'data', group: 'Data', label, hint, keywords: [label, op ?? '', 'read', 'database'],
  config: () => ({ kind: 'data', op, query: '', resource: '', returns }),
});
const effect = (group: string, label: string, op: string, inputs: AuthoredDataPin[], outputs: AuthoredDataPin[], hint: string, keywords: string[] = []): CatalogEntry => ({
  kind: 'effect', group, label, hint, keywords: [label, op, ...keywords],
  config: () => ({ kind: 'effect', op, label, inputs, outputs, resource: '' }),
});
const boundary = (label: string, op: Extract<AuthoredConfig, { kind: 'boundary' }>['op'], hint: string, type?: ViType): CatalogEntry => ({
  kind: 'boundary', group: 'Errors & Validation', label, hint, keywords: [label, op, 'validation', 'error'],
  config: () => ({ kind: 'boundary', op, ...(type ? { type } : {}) }),
});
const organize = (label: string, mode: Extract<AuthoredConfig, { kind: 'group' }>['mode'], hint: string): CatalogEntry => ({
  kind: 'group', group: 'Organization', label, hint, keywords: [label, mode, 'organize'], config: () => ({ kind: 'group', mode, name: label, text: '' }),
});

const numberPins = [pin('a', 'Number'), pin('b', 'Number')];
const boolOut = [pin('result', 'Boolean')];
const numberOut = [pin('result', 'Number')];
const stringOut = [pin('result', 'String')];
const listOut = [pin('result', 'List')];
const objectOut = [pin('result', 'Object')];

export const CATALOG: CatalogEntry[] = [
  // Flow
  { kind: 'return', label: 'Early Return', hint: 'Stop this path and return immediately', group: 'Flow', keywords: ['return', 'end', 'result'], config: () => ({ kind: 'return', early: true }) },
  flow('If / Else', 'if', 'Run one of two paths'),
  flow('Sequence', 'sequence', 'Run several paths in order', ['then 1', 'then 2']),
  flow('Switch on String', 'switch', 'Choose a path by matching text', ['case 1', 'case 2', 'default'], 'String'),
  flow('Switch on Number', 'switch', 'Choose a path by matching a number', ['0', '1', 'default'], 'Number'),
  flow('Switch on Boolean', 'switch', 'Choose a true or false path', ['true', 'false'], 'Boolean'),
  flow('Is Valid', 'valid', 'Branch on whether a value exists'),
  flow('Success / Failure', 'success', 'Branch on a succeeded flag'),
  flow('Try / Catch', 'try', 'Handle an error on a separate path'),
  loop('For Each', 'forEach', 'Run once for every list item'),
  loop('For Loop', 'for', 'Run across a numeric index range'),
  loop('For Loop with Break', 'forWithBreak', 'Run across a range and stop early'),
  loop('While Loop', 'while', 'Repeat while true, with a safety limit'),
  loop('Break Loop', 'break', 'Stop the nearest loop'),
  loop('Continue Loop', 'continue', 'Skip to the next loop iteration'),

  // Values and variables
  { kind: 'literal', label: 'Value', hint: 'A fixed string, number or boolean', group: 'Values', keywords: ['literal', 'constant', 'value', 'string', 'number', 'boolean', 'text'], config: () => ({ kind: 'literal', value: '', type: 'String' }) },
  { kind: 'variable', label: 'Get Variable', hint: 'Read a value by name', group: 'Values', keywords: ['get', 'variable', 'read', 'reference'], config: () => ({ kind: 'variable', name: 'value', type: 'String', mode: 'get', mutable: false }) },
  { kind: 'variable', label: 'Set Variable', hint: 'Store a value by name', group: 'Values', keywords: ['set', 'variable', 'write', 'store', 'assign'], config: () => ({ kind: 'variable', name: 'value', type: 'String', mode: 'set', mutable: true }) },
  pure('Values', 'Select', 'select', [pin('condition', 'Boolean'), pin('true value'), pin('false value')], [pin('result')], ['ternary', 'choose']),
  pure('Values', 'Is Null', 'isNull', [pin('value')], boolOut),
  pure('Values', 'Is Defined', 'isDefined', [pin('value')], boolOut),
  pure('Values', 'Is Empty', 'isEmpty', [pin('value')], boolOut),

  // Boolean and comparison
  ...MATH_OPS.map((m): CatalogEntry => pure('Math & Logic', m.label, m.op, numberPins, ['==', '!=', '<', '>', '<=', '>=', '&&', '||', 'xor'].includes(m.op) ? boolOut : numberOut, ['compute', 'math', ...m.keywords], 'Combine or compare two values')),
  pure('Math & Logic', 'Not', 'not', [pin('value', 'Boolean')], boolOut),
  pure('Math & Logic', 'Negate', 'negate', [pin('value', 'Number')], numberOut),
  pure('Math & Logic', 'Absolute Value', 'abs', [pin('value', 'Number')], numberOut),
  pure('Math & Logic', 'Square Root', 'sqrt', [pin('value', 'Number')], numberOut),
  pure('Math & Logic', 'Minimum', 'min', numberPins, numberOut),
  pure('Math & Logic', 'Maximum', 'max', numberPins, numberOut),
  pure('Math & Logic', 'Clamp', 'clamp', [pin('value', 'Number'), pin('min', 'Number'), pin('max', 'Number')], numberOut),
  pure('Math & Logic', 'Floor', 'floor', [pin('value', 'Number')], numberOut),
  pure('Math & Logic', 'Ceiling', 'ceil', [pin('value', 'Number')], numberOut),
  pure('Math & Logic', 'Round', 'round', [pin('value', 'Number')], numberOut),
  pure('Math & Logic', 'Random Number', 'random', [pin('min', 'Number'), pin('max', 'Number')], numberOut),
  pure('Math & Logic', 'Random Integer', 'randomInt', [pin('min', 'Number'), pin('max', 'Number')], numberOut),
  pure('Math & Logic', 'Map Range', 'mapRange', [pin('value', 'Number'), pin('in min', 'Number'), pin('in max', 'Number'), pin('out min', 'Number'), pin('out max', 'Number')], numberOut),
  pure('Math & Logic', 'Percentage', 'percentage', [pin('part', 'Number'), pin('whole', 'Number')], numberOut),
  pure('Math & Logic', 'Between', 'between', [pin('value', 'Number'), pin('min', 'Number'), pin('max', 'Number')], boolOut),
  pure('Math & Logic', 'Approximately Equal', 'approximatelyEqual', [pin('a', 'Number'), pin('b', 'Number'), pin('tolerance', 'Number')], boolOut),

  // Strings
  pure('Text', 'Format Text', 'formatText', [pin('template', 'String'), pin('values', 'Object')], stringOut, ['interpolate', 'template']),
  pure('Text', 'Concatenate', 'concat', [pin('a', 'String'), pin('b', 'String')], stringOut),
  pure('Text', 'Split', 'split', [pin('text', 'String'), pin('separator', 'String')], listOut),
  pure('Text', 'Join', 'join', [pin('items', 'List'), pin('separator', 'String')], stringOut),
  pure('Text', 'Replace', 'replace', [pin('text', 'String'), pin('find', 'String'), pin('replacement', 'String')], stringOut),
  pure('Text', 'Trim', 'trim', [pin('text', 'String')], stringOut),
  pure('Text', 'Uppercase', 'upper', [pin('text', 'String')], stringOut),
  pure('Text', 'Lowercase', 'lower', [pin('text', 'String')], stringOut),
  pure('Text', 'Contains Text', 'contains', [pin('text', 'String'), pin('search', 'String')], boolOut),
  pure('Text', 'Starts With', 'startsWith', [pin('text', 'String'), pin('prefix', 'String')], boolOut),
  pure('Text', 'Ends With', 'endsWith', [pin('text', 'String'), pin('suffix', 'String')], boolOut),
  pure('Text', 'String Length', 'length', [pin('text', 'String')], numberOut),
  pure('Text', 'Substring', 'substring', [pin('text', 'String'), pin('start', 'Number'), pin('length', 'Number')], stringOut),
  pure('Text', 'Match Pattern', 'regex', [pin('text', 'String'), pin('pattern', 'String')], boolOut, ['regex']),

  // Lists
  pure('Lists', 'Make List', 'makeList', [pin('item 1'), pin('item 2')], listOut),
  pure('Lists', 'Get Item', 'listGet', [pin('list', 'List'), pin('index', 'Number')], [pin('item')]),
  pure('Lists', 'Set Item', 'listSet', [pin('list', 'List'), pin('index', 'Number'), pin('item')], listOut),
  pure('Lists', 'First', 'first', [pin('list', 'List')], [pin('item')]),
  pure('Lists', 'Last', 'last', [pin('list', 'List')], [pin('item')]),
  pure('Lists', 'Add Item', 'listAdd', [pin('list', 'List'), pin('item')], listOut),
  pure('Lists', 'Insert Item', 'listInsert', [pin('list', 'List'), pin('index', 'Number'), pin('item')], listOut),
  pure('Lists', 'Remove Item', 'listRemove', [pin('list', 'List'), pin('item')], listOut),
  pure('Lists', 'Remove at Index', 'removeIndex', [pin('list', 'List'), pin('index', 'Number')], listOut),
  pure('Lists', 'Contains Item', 'listContains', [pin('list', 'List'), pin('item')], boolOut),
  pure('Lists', 'Find Index', 'findIndex', [pin('list', 'List'), pin('item')], numberOut),
  pure('Lists', 'List Length', 'listLength', [pin('list', 'List')], numberOut),
  pure('Lists', 'Clear List', 'listClear', [pin('list', 'List')], listOut),
  pure('Lists', 'Slice', 'slice', [pin('list', 'List'), pin('start', 'Number'), pin('end', 'Number')], listOut),
  pure('Lists', 'Reverse', 'reverse', [pin('list', 'List')], listOut),
  pure('Lists', 'Sort', 'sort', [pin('list', 'List'), pin('field', 'String')], listOut),
  pure('Lists', 'Unique', 'unique', [pin('list', 'List')], listOut),
  pure('Lists', 'Filter', 'filter', [pin('list', 'List'), pin('predicate', 'Object')], listOut),
  pure('Lists', 'Map', 'map', [pin('list', 'List'), pin('transform', 'Object')], listOut),
  pure('Lists', 'Reduce', 'reduce', [pin('list', 'List'), pin('reducer', 'Object'), pin('initial')], [pin('result')]),
  pure('Lists', 'Some', 'some', [pin('list', 'List'), pin('predicate', 'Object')], boolOut),
  pure('Lists', 'Every', 'every', [pin('list', 'List'), pin('predicate', 'Object')], boolOut),

  // Objects, maps and JSON
  pure('Objects', 'Make Object', 'makeObject', [pin('fields', 'Object')], objectOut),
  pure('Objects', 'Break Object', 'breakObject', [pin('object', 'Object')], objectOut),
  pure('Objects', 'Get Field', 'getField', [pin('object', 'Object'), pin('field', 'String')], [pin('value')]),
  pure('Objects', 'Set Field', 'setField', [pin('object', 'Object'), pin('field', 'String'), pin('value')], objectOut),
  pure('Objects', 'Has Field', 'hasField', [pin('object', 'Object'), pin('field', 'String')], boolOut),
  pure('Objects', 'Remove Field', 'removeField', [pin('object', 'Object'), pin('field', 'String')], objectOut),
  pure('Objects', 'Merge Objects', 'mergeObjects', [pin('a', 'Object'), pin('b', 'Object')], objectOut),
  pure('Objects', 'Object Keys', 'objectKeys', [pin('object', 'Object')], listOut),
  pure('Objects', 'Object Values', 'objectValues', [pin('object', 'Object')], listOut),
  pure('Objects', 'Map Add', 'mapAdd', [pin('map', 'Object'), pin('key', 'String'), pin('value')], objectOut),
  pure('Objects', 'Map Find', 'mapFind', [pin('map', 'Object'), pin('key', 'String')], [pin('value')]),
  pure('Objects', 'Map Contains', 'mapContains', [pin('map', 'Object'), pin('key', 'String')], boolOut),
  pure('Objects', 'Map Remove', 'mapRemove', [pin('map', 'Object'), pin('key', 'String')], objectOut),
  pure('Objects', 'Map Length', 'mapLength', [pin('map', 'Object')], numberOut),
  pure('Objects', 'Parse JSON', 'parseJson', [pin('json', 'String')], objectOut),
  pure('Objects', 'Stringify JSON', 'stringifyJson', [pin('value', 'Object')], stringOut),

  // Dates and conversions
  pure('Dates', 'Now', 'now', [], [pin('date', 'Date')]),
  pure('Dates', 'Parse Date', 'parseDate', [pin('text', 'String')], [pin('date', 'Date')]),
  pure('Dates', 'Format Date', 'formatDate', [pin('date', 'Date'), pin('format', 'String')], stringOut),
  pure('Dates', 'Add Duration', 'addDuration', [pin('date', 'Date'), pin('milliseconds', 'Number')], [pin('date', 'Date')]),
  pure('Dates', 'Date Difference', 'dateDifference', [pin('a', 'Date'), pin('b', 'Date')], numberOut),
  pure('Dates', 'Before', 'before', [pin('a', 'Date'), pin('b', 'Date')], boolOut),
  pure('Dates', 'After', 'after', [pin('a', 'Date'), pin('b', 'Date')], boolOut),
  pure('Conversions', 'To String', 'toString', [pin('value')], stringOut),
  pure('Conversions', 'To Number', 'toNumber', [pin('value')], numberOut),
  pure('Conversions', 'To Boolean', 'toBoolean', [pin('value')], boolOut),
  pure('Conversions', 'To Date', 'toDate', [pin('value')], [pin('date', 'Date')]),
  pure('Conversions', 'To URL', 'toUrl', [pin('value')], [pin('url', 'Url')]),
  pure('Conversions', 'Explicit Cast', 'cast', [pin('value')], [pin('result')]),

  // Data and web APIs
  read('Query', 'query', 'List', 'Run a custom data query'),
  read('Find One', 'findOne', 'Object', 'Read one record'),
  read('Find Many', 'findMany', 'List', 'Read matching records'),
  read('Count', 'count', 'Number', 'Count matching records'),
  read('Aggregate', 'aggregate', 'Object', 'Summarize matching records'),
  read('Cache Get', 'cacheGet', 'Object', 'Read a cached value'),
  read('Environment Value', 'environment', 'String', 'Read a configured environment value'),
  read('Current User', 'currentUser', 'Object', 'Read the signed-in user'),
  effect('Data', 'Create Record', 'create', [pin('record', 'Object')], objectOut, 'Create a data record'),
  effect('Data', 'Update Record', 'update', [pin('id', 'String'), pin('changes', 'Object')], objectOut, 'Update a data record'),
  effect('Data', 'Delete Record', 'delete', [pin('id', 'String')], [], 'Delete a data record'),
  effect('Data', 'Upsert Record', 'upsert', [pin('record', 'Object')], objectOut, 'Create or update a record'),
  effect('Data', 'Transaction', 'transaction', [pin('operations', 'List')], objectOut, 'Run operations atomically'),
  effect('Data', 'Cache Set', 'cacheSet', [pin('key', 'String'), pin('value'), pin('ttl', 'Number')], [], 'Store a cached value'),
  effect('Data', 'Cache Remove', 'cacheRemove', [pin('key', 'String')], [], 'Remove a cached value'),
  { kind: 'external', label: 'HTTP Request', hint: 'Call an HTTP service with URL, headers, query and body', group: 'HTTP', keywords: ['api', 'http', 'fetch', 'request', 'webhook'], config: () => ({ kind: 'external', mode: 'request', method: 'GET', url: '' }) },
  pure('HTTP', 'Decode Response', 'parseJson', [pin('response', 'Object')], objectOut, ['http', 'response']),

  // Errors, validation, async and composition
  boundary('Throw Error', 'throw', 'Stop this path with an error'),
  boundary('Validate', 'validate', 'Continue only when a value is valid'),
  boundary('Safe Cast', 'safeCast', 'Cast with success and failure paths', 'Object'),
  boundary('Authorize', 'authorize', 'Require an authenticated user'),
  boundary('Require Role', 'requireRole', 'Require a named user role'),
  effect('Async', 'Delay', 'delay', [pin('milliseconds', 'Number')], [], 'Wait before continuing'),
  effect('Async', 'Parallel / All', 'parallel', [pin('actions', 'List')], listOut, 'Run work concurrently and wait for all'),
  effect('Async', 'Race / First Completed', 'race', [pin('actions', 'List')], objectOut, 'Continue with the first completed result'),
  effect('Async', 'Await Action', 'await', [pin('action', 'Object')], objectOut, 'Wait for an asynchronous action'),
  effect('Async', 'Retry with Backoff', 'retry', [pin('action', 'Object'), pin('attempts', 'Number'), pin('delay', 'Number')], objectOut, 'Retry failed work with increasing delay'),
  effect('Async', 'Timeout', 'timeout', [pin('action', 'Object'), pin('milliseconds', 'Number')], objectOut, 'Fail work that takes too long'),
  effect('Async', 'Debounce', 'debounce', [pin('value'), pin('milliseconds', 'Number')], [pin('value')], 'Wait until changes settle'),
  effect('Async', 'Throttle', 'throttle', [pin('value'), pin('milliseconds', 'Number')], [pin('value')], 'Limit how often work may run'),
  effect('Events', 'Emit Event', 'emit', [pin('name', 'String'), pin('payload', 'Object')], [], 'Publish an application event'),
  effect('Events', 'Listen for Event', 'listen', [pin('name', 'String')], [pin('payload', 'Object')], 'Continue when an application event arrives'),

  // Graph-only organization aids
  organize('Reroute', 'reroute', 'Route a wire without changing behavior'),
  organize('Named Reroute', 'namedReroute', 'Route distant wires through a named point'),
  organize('Comment', 'comment', 'Explain one part of the graph'),
  organize('Comment Region', 'region', 'Group and describe related nodes'),
  organize('Helper', 'helper', 'A reusable private subgraph'),
  organize('Bookmark', 'bookmark', 'Mark a graph location for quick navigation'),
];

export type SearchKind = 'block' | 'get' | 'set' | 'call';

export interface SearchItem {
  id: string;
  kind: SearchKind;
  label: string;
  hint: string;
  group: string;
  /** The same category a placed node's header is colored by — shown as a matching dot in the dropdown, so a block looks the same before and after it's placed. */
  category: Category;
  keywords: string[];
  /** Instantiate the node this item stands for. `taken` avoids id collisions. */
  make: (taken: Set<SemanticKey>) => GNode;
}

function catalogItem(entry: CatalogEntry, ctx: PortContext): SearchItem {
  return {
    id: `block:${entry.kind}:${entry.label}`,
    kind: 'block',
    label: entry.label,
    hint: entry.hint,
    group: entry.group,
    category: categoryOf(entry.kind),
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
    category: categoryOf('variable'),
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
    category: categoryOf('call'),
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
