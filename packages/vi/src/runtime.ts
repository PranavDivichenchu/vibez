import type { ComputeOp } from './types.ts';

/**
 * What every non-operator `compute` block actually does, at runtime.
 *
 * `+`, `==`, `&&` and the rest of `MathOp` compile straight to a JS operator
 * — there is nothing to name. Everything else here compiles to a call of a
 * small named helper, written into the generated file once, above its first
 * use, the same way `packages/codemod`'s `remember()` helper is inlined
 * rather than imported: nothing to install, the whole change readable in one
 * diff, no runtime package the compiled project has to depend on.
 *
 * Each helper is a single arrow function so it reads as one line in the
 * generated file. `params` names the block's own pins, in order, so the
 * compiler can call it positionally without knowing its internals.
 */
export interface RuntimeHelper {
  /** The generated function's name, also its key when several ops share one. */
  name: string;
  params: string[];
  /** Function body as a single expression — becomes `(params) => body`. */
  body: string;
}

type NonMathOp = Exclude<ComputeOp, '+' | '-' | '*' | '/' | '%' | 'pow' | '==' | '!=' | '<' | '>' | '<=' | '>=' | '&&' | '||' | 'xor'>;

/** Ops the runtime cannot honestly run yet: they take a "function" pin, and the type system has no Function type to carry one. */
export const UNSUPPORTED_OPS = new Set<ComputeOp>(['filter', 'map', 'reduce', 'some', 'every']);

export const RUNTIME: Record<NonMathOp, RuntimeHelper> = {
  not: { name: 'vi_not', params: ['value'], body: '!value' },
  negate: { name: 'vi_negate', params: ['value'], body: '-value' },
  abs: { name: 'vi_abs', params: ['value'], body: 'Math.abs(value)' },
  sqrt: { name: 'vi_sqrt', params: ['value'], body: 'Math.sqrt(value)' },
  min: { name: 'vi_min', params: ['a', 'b'], body: 'Math.min(a, b)' },
  max: { name: 'vi_max', params: ['a', 'b'], body: 'Math.max(a, b)' },
  clamp: { name: 'vi_clamp', params: ['value', 'min', 'max'], body: 'Math.min(Math.max(value, min), max)' },
  floor: { name: 'vi_floor', params: ['value'], body: 'Math.floor(value)' },
  ceil: { name: 'vi_ceil', params: ['value'], body: 'Math.ceil(value)' },
  round: { name: 'vi_round', params: ['value'], body: 'Math.round(value)' },
  random: { name: 'vi_random', params: ['min', 'max'], body: 'min + Math.random() * (max - min)' },
  randomInt: { name: 'vi_randomInt', params: ['min', 'max'], body: 'Math.floor(min + Math.random() * (max - min + 1))' },
  mapRange: { name: 'vi_mapRange', params: ['value', 'inMin', 'inMax', 'outMin', 'outMax'], body: 'outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin)' },
  percentage: { name: 'vi_percentage', params: ['part', 'whole'], body: 'whole === 0 ? 0 : (part / whole) * 100' },
  isNull: { name: 'vi_isNull', params: ['value'], body: 'value === null || value === undefined' },
  isDefined: { name: 'vi_isDefined', params: ['value'], body: 'value !== null && value !== undefined' },
  isEmpty: { name: 'vi_isEmpty', params: ['value'], body: 'value === null || value === undefined || value === \'\' || (Array.isArray(value) && value.length === 0)' },
  between: { name: 'vi_between', params: ['value', 'min', 'max'], body: 'value >= min && value <= max' },
  approximatelyEqual: { name: 'vi_approximatelyEqual', params: ['a', 'b', 'tolerance'], body: 'Math.abs(a - b) <= tolerance' },
  select: { name: 'vi_select', params: ['condition', 'whenTrue', 'whenFalse'], body: 'condition ? whenTrue : whenFalse' },

  formatText: { name: 'vi_formatText', params: ['template', 'values'], body: 'template.replace(/\\{(\\w+)\\}/g, (_, key) => String(values?.[key] ?? \'\'))' },
  concat: { name: 'vi_concat', params: ['a', 'b'], body: 'String(a) + String(b)' },
  split: { name: 'vi_split', params: ['text', 'separator'], body: 'text.split(separator)' },
  join: { name: 'vi_join', params: ['items', 'separator'], body: 'items.join(separator)' },
  replace: { name: 'vi_replace', params: ['text', 'find', 'replacement'], body: 'text.split(find).join(replacement)' },
  trim: { name: 'vi_trim', params: ['text'], body: 'text.trim()' },
  upper: { name: 'vi_upper', params: ['text'], body: 'text.toUpperCase()' },
  lower: { name: 'vi_lower', params: ['text'], body: 'text.toLowerCase()' },
  contains: { name: 'vi_contains', params: ['text', 'search'], body: 'text.includes(search)' },
  startsWith: { name: 'vi_startsWith', params: ['text', 'prefix'], body: 'text.startsWith(prefix)' },
  endsWith: { name: 'vi_endsWith', params: ['text', 'suffix'], body: 'text.endsWith(suffix)' },
  length: { name: 'vi_length', params: ['text'], body: 'text.length' },
  substring: { name: 'vi_substring', params: ['text', 'start', 'length'], body: 'text.substring(start, start + length)' },
  regex: { name: 'vi_regex', params: ['text', 'pattern'], body: 'new RegExp(pattern).test(text)' },

  // Any number of items: a Make List block may have two pins or ten.
  makeList: { name: 'vi_makeList', params: ['...items'], body: 'items.filter((v) => v !== undefined)' },
  listGet: { name: 'vi_listGet', params: ['list', 'index'], body: 'list[index]' },
  listSet: { name: 'vi_listSet', params: ['list', 'index', 'item'], body: 'list.map((v, i) => i === index ? item : v)' },
  first: { name: 'vi_first', params: ['list'], body: 'list[0]' },
  last: { name: 'vi_last', params: ['list'], body: 'list[list.length - 1]' },
  listAdd: { name: 'vi_listAdd', params: ['list', 'item'], body: '[...list, item]' },
  listInsert: { name: 'vi_listInsert', params: ['list', 'index', 'item'], body: '[...list.slice(0, index), item, ...list.slice(index)]' },
  listRemove: { name: 'vi_listRemove', params: ['list', 'item'], body: 'list.filter((v) => v !== item)' },
  removeIndex: { name: 'vi_removeIndex', params: ['list', 'index'], body: 'list.filter((_, i) => i !== index)' },
  listContains: { name: 'vi_listContains', params: ['list', 'item'], body: 'list.includes(item)' },
  findIndex: { name: 'vi_findIndex', params: ['list', 'item'], body: 'list.indexOf(item)' },
  listLength: { name: 'vi_listLength', params: ['list'], body: 'list.length' },
  listClear: { name: 'vi_listClear', params: ['list'], body: '[]' },
  slice: { name: 'vi_slice', params: ['list', 'start', 'end'], body: 'list.slice(start, end)' },
  reverse: { name: 'vi_reverse', params: ['list'], body: '[...list].reverse()' },
  sort: { name: 'vi_sort', params: ['list', 'field'], body: '[...list].sort((a, b) => field ? (a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1) : (a === b ? 0 : a > b ? 1 : -1))' },
  unique: { name: 'vi_unique', params: ['list'], body: '[...new Set(list)]' },

  makeObject: { name: 'vi_makeObject', params: ['fields'], body: '{ ...fields }' },
  breakObject: { name: 'vi_breakObject', params: ['object'], body: '{ ...object }' },
  getField: { name: 'vi_getField', params: ['object', 'field'], body: 'object?.[field]' },
  setField: { name: 'vi_setField', params: ['object', 'field', 'value'], body: '{ ...object, [field]: value }' },
  hasField: { name: 'vi_hasField', params: ['object', 'field'], body: 'object != null && Object.prototype.hasOwnProperty.call(object, field)' },
  removeField: { name: 'vi_removeField', params: ['object', 'field'], body: 'Object.fromEntries(Object.entries(object).filter(([k]) => k !== field))' },
  mergeObjects: { name: 'vi_mergeObjects', params: ['a', 'b'], body: '{ ...a, ...b }' },
  objectKeys: { name: 'vi_objectKeys', params: ['object'], body: 'Object.keys(object)' },
  objectValues: { name: 'vi_objectValues', params: ['object'], body: 'Object.values(object)' },
  mapAdd: { name: 'vi_mapAdd', params: ['map', 'key', 'value'], body: '{ ...map, [key]: value }' },
  mapFind: { name: 'vi_mapFind', params: ['map', 'key'], body: 'map?.[key]' },
  mapContains: { name: 'vi_mapContains', params: ['map', 'key'], body: 'map != null && Object.prototype.hasOwnProperty.call(map, key)' },
  mapRemove: { name: 'vi_mapRemove', params: ['map', 'key'], body: 'Object.fromEntries(Object.entries(map).filter(([k]) => k !== key))' },
  mapLength: { name: 'vi_mapLength', params: ['map'], body: 'Object.keys(map).length' },
  parseJson: { name: 'vi_parseJson', params: ['json'], body: 'JSON.parse(json)' },
  stringifyJson: { name: 'vi_stringifyJson', params: ['value'], body: 'JSON.stringify(value)' },

  now: { name: 'vi_now', params: [], body: 'new Date()' },
  parseDate: { name: 'vi_parseDate', params: ['text'], body: 'new Date(text)' },
  formatDate: { name: 'vi_formatDate', params: ['date', 'format'], body: 'format === \'iso\' ? new Date(date).toISOString() : new Date(date).toLocaleDateString()' },
  addDuration: { name: 'vi_addDuration', params: ['date', 'milliseconds'], body: 'new Date(new Date(date).getTime() + milliseconds)' },
  dateDifference: { name: 'vi_dateDifference', params: ['a', 'b'], body: 'new Date(a).getTime() - new Date(b).getTime()' },
  before: { name: 'vi_before', params: ['a', 'b'], body: 'a.getTime() < b.getTime()' },
  after: { name: 'vi_after', params: ['a', 'b'], body: 'a.getTime() > b.getTime()' },

  toString: { name: 'vi_toString', params: ['value'], body: 'String(value)' },
  toNumber: { name: 'vi_toNumber', params: ['value'], body: 'Number(value)' },
  toBoolean: { name: 'vi_toBoolean', params: ['value'], body: 'Boolean(value)' },
  toDate: { name: 'vi_toDate', params: ['value'], body: 'new Date(value)' },
  toUrl: { name: 'vi_toUrl', params: ['value'], body: 'String(value)' },
  cast: { name: 'vi_cast', params: ['value'], body: 'value' },

  // Genuinely unimplemented: see UNSUPPORTED_OPS. Kept here so `RUNTIME` stays
  // total over `NonMathOp` and every op has *a* body, even one that only ever
  // throws — the compiler still refuses to build these, this is the fallback
  // if that check is ever bypassed.
  filter: { name: 'vi_filter', params: ['list', 'predicate'], body: '(() => { throw new Error(\'Filter has no way to run a predicate yet\'); })()' },
  map: { name: 'vi_map', params: ['list', 'transform'], body: '(() => { throw new Error(\'Map has no way to run a transform yet\'); })()' },
  reduce: { name: 'vi_reduce', params: ['list', 'reducer', 'initial'], body: '(() => { throw new Error(\'Reduce has no way to run a reducer yet\'); })()' },
  some: { name: 'vi_some', params: ['list', 'predicate'], body: '(() => { throw new Error(\'Some has no way to run a predicate yet\'); })()' },
  every: { name: 'vi_every', params: ['list', 'predicate'], body: '(() => { throw new Error(\'Every has no way to run a predicate yet\'); })()' },
};

export function helperFor(op: ComputeOp): RuntimeHelper | undefined {
  return Object.prototype.hasOwnProperty.call(RUNTIME, op) ? (RUNTIME as Record<string, RuntimeHelper>)[op] : undefined;
}
