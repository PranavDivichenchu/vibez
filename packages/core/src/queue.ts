import type { Actor, ActorId } from './actors.ts';
import type { SemanticKey } from './types.ts';
import { compareSamples, median, relativeChange, type NodeVerdict } from './significance.ts';

/**
 * Several agents editing at once, one lane that measures, and a landing order
 * that shows which patches actually mattered.
 *
 * Editing is parallel: each agent works in its own git worktree. Measuring is
 * serial: one app server alive at a time on an otherwise idle machine, so every
 * number in a session was produced under the same conditions and they can be
 * compared with each other. This file is the bookkeeping for that, kept pure
 * so it can be tested without git, agents or servers.
 */

/**
 * The strip shows three states and no more: editing, queued, measuring.
 * A finished run becomes a patch card (`ready`), and a card ends `landed`,
 * `failed` or `stopped`.
 */
export type LaneState = 'editing' | 'queued' | 'measuring' | 'ready' | 'landed' | 'failed' | 'stopped';

/** Per-run samples from one measurement. `flow` is the whole request, per run. */
export interface Measurement {
  runs: number;
  at: number;
  /** The commit measured. */
  rev: string;
  flow: number[];
  nodes: Record<SemanticKey, number[]>;
  /** Display names by key, so a node can be followed when its key changes. */
  labels?: Record<SemanticKey, string>;
}

export const FLOW_KEY = '__flow__';

/** A change, measured: what the headline number on a card is made of. */
export interface Delta {
  /** What the headline is about: a node's label, or `the flow`. */
  subject: string;
  subjectId: SemanticKey;
  before: number;
  after: number;
  change: number;
  p: number;
  significant: boolean;
  /** Every node that changed significantly, biggest change first. */
  changed: NodeVerdict[];
}

export interface Lane {
  id: string;
  actor: Actor;
  prompt: string;
  /** Files fenced for this lane. Grows when an uncontested extension is granted. */
  fence: string[];
  /** Nodes the lane was started on; the headline number is about these. */
  focus: SemanticKey[];
  state: LaneState;
  /** What it is doing right now, in a few words: `editing queries.ts`, `run 12/20`. */
  detail: string;
  /** Files the agent changed. */
  files: string[];
  queuedAt?: number;
  /** The agent's commit on its own branch, once editing is done. */
  commit?: string;
  /** Measured in its own worktree, against the baseline at the time. */
  claimed?: Delta;
  /** Measured again after the lands before it: the number that survived. */
  measured?: Delta;
  /** The commit it became in your tree, once landed. */
  landedAs?: string;
  error?: string;
  /** How many times it re-planned after a contested fence. */
  replans: number;
  /** The commit the lane started from, and is measured against. */
  base?: string;
  /** Where its copy of the repository is, and its branch there. */
  worktree?: string;
  branch?: string;
  /** What the agent said it did, in its own final line. */
  summary?: string;
  /** What the strip calls it: the first selected node, else its first file, else the ask. */
  title: string;
}

export function newLane(id: string, actor: Actor, prompt: string, fence: string[], focus: SemanticKey[], title?: string): Lane {
  return { id, actor, prompt, fence: [...fence], focus: [...focus], state: 'editing', detail: 'starting', files: [], replans: 0, title: title ?? fence[0] ?? prompt };
}

/** Lanes that still take part: not landed, failed or stopped. */
export function isLive(lane: Lane): boolean {
  return lane.state === 'editing' || lane.state === 'queued' || lane.state === 'measuring' || lane.state === 'ready';
}

/** The measurement lane takes the oldest queued patch next. */
export function nextToMeasure(lanes: Lane[]): Lane | undefined {
  if (lanes.some((lane) => lane.state === 'measuring')) { return undefined; }
  return lanes
    .filter((lane) => lane.state === 'queued')
    .sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0))[0];
}

/** 1 for next in line. 0 when not queued. */
export function queuePosition(lanes: Lane[], id: string): number {
  const queued = lanes.filter((lane) => lane.state === 'queued').sort((a, b) => (a.queuedAt ?? 0) - (b.queuedAt ?? 0));
  return queued.findIndex((lane) => lane.id === id) + 1;
}

/**
 * Compares two measurements. The headline is the focus node that moved most,
 * or the whole flow when the lane had no focus or none of it was traced.
 */
export function measureDelta(
  before: Measurement,
  after: Measurement,
  focus: SemanticKey[] = [],
  labels: Record<SemanticKey, string> = {},
): Delta {
  const a = new Map<string, number[]>(Object.entries(before.nodes));
  const b = new Map<string, number[]>(Object.entries(after.nodes));
  // A focus node whose key changed (rewriting its query changes its identity)
  // is followed by name, when exactly one node on the other side has it.
  for (const id of focus) {
    if (!a.has(id) || b.has(id)) { continue; }
    const name = before.labels?.[id] ?? labels[id];
    const same = Object.entries(after.labels ?? {}).filter(([key, label]) => label === name && !a.has(key));
    if (name && same.length === 1) { b.set(id, after.nodes[same[0]![0]]!); }
  }
  a.set(FLOW_KEY, before.flow);
  b.set(FLOW_KEY, after.flow);
  const verdicts = compareSamples(a, b);
  const byId = new Map(verdicts.map((v) => [v.id, v]));

  const focused = focus.map((id) => byId.get(id)).filter((v): v is NodeVerdict => v !== undefined);
  const flow = byId.get(FLOW_KEY) ?? {
    id: FLOW_KEY, before: median(before.flow), after: median(after.flow),
    change: relativeChange(median(before.flow), median(after.flow)), p: 1, significant: false, verdict: 'no change' as const,
  };
  const head = focused.length
    ? focused.reduce((best, v) => (Math.abs(v.change) > Math.abs(best.change) ? v : best))
    : flow;

  return {
    subject: head.id === FLOW_KEY ? 'the flow' : (labels[head.id] ?? head.id),
    subjectId: head.id,
    before: head.before,
    after: head.after,
    change: head.change,
    p: head.p,
    significant: head.significant,
    changed: verdicts
      .filter((v) => v.significant && v.id !== FLOW_KEY)
      .sort((x, y) => Math.abs(y.change) - Math.abs(x.change)),
  };
}

/** `−87%`, `+12%`, `0%`. A real minus sign, because it is read, not parsed. */
export function percent(change: number): string {
  // Round the size, not the signed value, so −87.5% and +87.5% both read 88%.
  const rounded = Math.sign(change) * Math.round(Math.abs(change) * 100);
  if (rounded === 0) { return '0%'; }
  return `${rounded < 0 ? '−' : '+'}${Math.abs(rounded)}%`;
}

export function ms(value: number): string {
  if (!Number.isFinite(value)) { return '–'; }
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

/** The middle column of a strip row: `edited · queued 2nd`, `measuring ⟳ run 12/20`. */
export function stateText(lane: Lane, lanes: Lane[]): string {
  switch (lane.state) {
    case 'editing': return lane.detail && lane.detail !== 'starting' ? `editing · ${lane.detail}` : 'editing';
    case 'queued': return `edited · queued ${ordinal(queuePosition(lanes, lane.id))}`;
    case 'measuring': return lane.detail ? `measuring ⟳ ${lane.detail}` : 'measuring ⟳';
    case 'ready': return 'measured · ready to land';
    case 'landed': return 'landed';
    case 'failed': return lane.error ? `failed · ${lane.error}` : 'failed';
    case 'stopped': return 'stopped';
  }
}

/**
 * The right-hand column, in the plainest words available. A win that does not
 * survive landing says so, and the card stays visible: that is the honest part.
 *
 *   claims −87%
 *   claimed −70% · measured −4% · not significant
 */
export function claimText(lane: Lane): string {
  const claimed = lane.claimed;
  if (!claimed) { return ''; }
  const claim = claimed.significant ? percent(claimed.change) : `${percent(claimed.change)} (not significant)`;
  const measured = lane.measured;
  if (!measured) { return `claims ${claim}`; }
  return `claimed ${percent(claimed.change)} · measured ${percent(measured.change)}${measured.significant ? '' : ' · not significant'}`;
}

/** One line in `.vibez/room.log`. Append-only; every actor action lands here. */
export interface RoomEntry {
  at: string;
  actor: ActorId;
  action: string;
  lane?: string;
  detail?: Record<string, unknown>;
}

export function roomLine(entry: RoomEntry): string {
  return JSON.stringify(entry) + '\n';
}
