import type { GNode } from '../../core/src/types.ts';
import type { ViDoc, ViType } from './types.ts';
import { addEdge, addNode, blankDoc, graphFor, makeNode, setGraph, takenIds } from './ops.ts';
import { CATALOG } from './catalog.ts';

/**
 * A new project's logic, written from a short description of it.
 *
 * A starter project — from a template, from a graph of ideas, or from
 * someone's X profile — says what its pages need: page data with example
 * values, and actions with what they answer. This turns that into a `.vi`
 * file whose graphs actually run, so the pages it is built beside show real
 * data and their buttons really answer, from the first minute. Every graph is
 * made of ordinary blocks, so a person can open it and keep going.
 */

export interface LogicValueSpec {
  name: string;
  type: ViType;
  /** For a List or an Object: the fields of one item. */
  fields?: Record<string, ViType>;
  /** What it holds to begin with. */
  sample: unknown;
  about?: string;
}

export interface LogicActionSpec {
  name: string;
  inputs: { name: string; type: ViType }[];
  /**
   * What it answers, with `{input}` where an input goes:
   * "Added {label} to your box." Only text inputs are filled in; anything
   * else in braces is kept as written.
   */
  reply: string;
  about?: string;
}

export interface LogicSpec {
  values: LogicValueSpec[];
  actions: LogicActionSpec[];
}

const concatBlock = CATALOG.find((e) => e.label === 'Concatenate')!;

/** The pieces of a reply: plain text, and the names of the text inputs it mentions. */
export function replyParts(reply: string, inputs: { name: string; type: ViType }[]): ({ text: string } | { input: string })[] {
  const text = new Set(inputs.filter((i) => i.type === 'String').map((i) => i.name));
  const out: ({ text: string } | { input: string })[] = [];
  let rest = reply;
  for (;;) {
    const m = /\{([A-Za-z_$][\w$]*)\}/.exec(rest);
    if (!m) break;
    if (!text.has(m[1]!)) {
      // Not an input that can be filled: keep it as written and look past it.
      out.push({ text: rest.slice(0, m.index + m[0].length) });
      rest = rest.slice(m.index + m[0].length);
      continue;
    }
    if (m.index > 0) out.push({ text: rest.slice(0, m.index) });
    out.push({ input: m[1]! });
    rest = rest.slice(m.index + m[0].length);
  }
  if (rest) out.push({ text: rest });
  // Neighbouring plain pieces read as one.
  return out.reduce<({ text: string } | { input: string })[]>((acc, part) => {
    const last = acc[acc.length - 1];
    if (last && 'text' in last && 'text' in part) last.text += part.text;
    else acc.push({ ...part });
    return acc;
  }, []);
}

const nodeOf = (graph: { nodes: GNode[] }, kind: string): GNode => graph.nodes.find((n) => (n as { kind?: string }).kind === kind || n.id.startsWith(kind))!;

export function logicDoc(spec: LogicSpec): ViDoc {
  let doc: ViDoc = {
    ...blankDoc(),
    exports: {
      values: spec.values.map((v) => ({ name: v.name, type: v.type, ...(v.fields ? { fields: v.fields } : {}), sample: v.sample, ...(v.about ? { about: v.about } : {}) })),
      actions: spec.actions.map((a) => ({ name: a.name, inputs: a.inputs, returns: 'String' as ViType, ...(a.about ? { about: a.about } : {}) })),
    },
  };

  // Page data: its example value, handed straight to Return.
  for (const value of spec.values) {
    const scaffolded = graphFor(doc, value.name);
    let graph = scaffolded.graph;
    const ret = nodeOf(graph, 'return');
    const literal = makeNode('literal', { kind: 'literal', value: value.sample, type: value.type }, takenIds(graph));
    graph = addEdge(addNode(graph, literal), literal.id, 'value', ret.id, 'value');
    doc = setGraph(scaffolded.doc, value.name, graph);
  }

  // Actions: the reply, joined from its words and the inputs it mentions.
  for (const action of spec.actions) {
    const scaffolded = graphFor(doc, action.name);
    let graph = scaffolded.graph;
    const start = nodeOf(graph, 'entry');
    const ret = nodeOf(graph, 'return');
    const pieces = replyParts(action.reply, action.inputs).map((part) => {
      if ('input' in part) return { node: start.id, port: `in:${part.input}` };
      const literal = makeNode('literal', { kind: 'literal', value: part.text, type: 'String' }, takenIds(graph));
      graph = addNode(graph, literal);
      return { node: literal.id, port: 'value' };
    });
    if (!pieces.length) {
      const literal = makeNode('literal', { kind: 'literal', value: '', type: 'String' }, takenIds(graph));
      graph = addNode(graph, literal);
      pieces.push({ node: literal.id, port: 'value' });
    }
    // a + b, then that + c, and so on.
    let acc = pieces[0]!;
    for (const next of pieces.slice(1)) {
      const join = makeNode(concatBlock.kind, concatBlock.config(), takenIds(graph));
      graph = addNode(graph, join);
      graph = addEdge(graph, acc.node, acc.port, join.id, 'in:0');
      graph = addEdge(graph, next.node, next.port, join.id, 'in:1');
      acc = { node: join.id, port: 'result' };
    }
    graph = addEdge(graph, acc.node, acc.port, ret.id, 'value');
    doc = setGraph(scaffolded.doc, action.name, graph);
  }
  return doc;
}
