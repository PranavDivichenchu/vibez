import type { Graph, SemanticKey } from './types.ts';
import { diffGraphs, type NodeChange } from './diff.ts';

/**
 * Turns things that happened into things the canvas does.
 *
 * A pure function, on purpose. The model is never asked to describe an
 * animation: the IDE already sees every tool call the agent makes and every
 * rebuild, and that stream plus a graph diff is enough to derive the whole
 * timeline. So the canvas costs nothing to animate.
 *
 * It is also the honest option. A timeline derived from real file events and
 * real traces cannot show a change that did not happen. A written summary can.
 */

export type AgentEvent =
  | { kind: 'scope'; files: string[] }
  | { kind: 'read'; file: string }
  | { kind: 'grep'; query: string }
  | { kind: 'edit'; file: string; lines?: [number, number] }
  | { kind: 'build'; state: 'start' | 'done' | 'failed' }
  | { kind: 'replay'; run: number; of: number }
  | { kind: 'trace' };

export type Beat =
  | { at: number; ms: number; op: 'scan'; nodes: SemanticKey[] }
  | { at: number; ms: number; op: 'flash'; nodes: SemanticKey[] }
  | { at: number; ms: number; op: 'pulse'; nodes: SemanticKey[] }
  | { at: number; ms: number; op: 'desaturate'; on: boolean }
  | { at: number; ms: number; op: 'flow'; path: SemanticKey[] }
  | { at: number; ms: number; op: 'settle'; changes: NodeChange[] }
  | { at: number; ms: number; op: 'fence'; files: string[] };

export interface Timeline {
  beats: Beat[];
  /** Total wall time. Capped, because nobody should watch an editor emote. */
  durationMs: number;
}

/** A turn's worth of animation is capped; longer work reports on chips instead. */
export const MAX_TIMELINE_MS = 6000;

const DURATION: Record<Beat['op'], number> = {
  scan: 600, flash: 420, pulse: 900, desaturate: 300, flow: 1200, settle: 700, fence: 300,
};

/** Which nodes live in a file. The anchor is the only link back to the source. */
export function nodesInFile(graph: Graph, file: string): SemanticKey[] {
  const suffix = file.replace(/^\.\//, '');
  return graph.nodes
    .filter((node) => node.anchor !== null && (node.anchor.file === suffix || node.anchor.file.endsWith(`/${suffix}`)))
    .map((node) => node.id);
}

function nodesMatching(graph: Graph, query: string): SemanticKey[] {
  const needle = query.toLowerCase();
  return graph.nodes
    .filter((node) => node.label.toLowerCase().includes(needle) || node.anchor?.symbol.toLowerCase().includes(needle))
    .map((node) => node.id);
}

/**
 * Omit distributed across the union. A plain `Omit<Beat, 'at' | 'ms'>` collapses
 * the union into its shared keys, which loses every payload field.
 */
type BeatSpec = Beat extends infer B
  ? B extends Beat ? Omit<B, 'at' | 'ms'> & { ms?: number } : never
  : never;

export function choreograph(events: AgentEvent[], before: Graph, after: Graph): Timeline {
  const beats: Beat[] = [];
  let at = 0;
  const push = (beat: BeatSpec): void => {
    const ms = beat.ms ?? DURATION[beat.op];
    beats.push({ ...beat, at, ms } as Beat);
    at += ms;
  };

  let desaturated = false;
  for (const event of events) {
    switch (event.kind) {
      case 'scope':
        push({ op: 'fence', files: event.files });
        break;
      case 'read': {
        const nodes = nodesInFile(before, event.file);
        if (nodes.length) { push({ op: 'scan', nodes }); }
        break;
      }
      case 'grep': {
        const nodes = nodesMatching(before, event.query);
        if (nodes.length) { push({ op: 'flash', nodes }); }
        break;
      }
      case 'edit': {
        const nodes = nodesInFile(before, event.file);
        if (nodes.length) { push({ op: 'pulse', nodes }); }
        break;
      }
      case 'build':
        if (event.state === 'start' && !desaturated) { desaturated = true; push({ op: 'desaturate', on: true }); }
        break;
      case 'replay':
        // One beat for the whole replay, not one per run: fifteen identical
        // flashes is noise, and the chips already carry the count.
        if (event.run === 1) { push({ op: 'flow', path: after.criticalPath }); }
        break;
      case 'trace':
        break;
    }
  }

  if (desaturated) { push({ op: 'desaturate', on: false }); }

  const changes = diffGraphs(before, after).filter((change) => change.change !== 'unchanged' && change.change !== 'moved');
  if (changes.length) { push({ op: 'settle', changes }); }

  // Scale rather than truncate: a clipped timeline ends mid-pulse and looks
  // like a bug, while a faster one just looks brisk.
  const total = at;
  if (total > MAX_TIMELINE_MS) {
    const factor = MAX_TIMELINE_MS / total;
    for (const beat of beats) {
      beat.at = Math.round(beat.at * factor);
      beat.ms = Math.round(beat.ms * factor);
    }
    return { beats, durationMs: MAX_TIMELINE_MS };
  }
  return { beats, durationMs: total };
}
