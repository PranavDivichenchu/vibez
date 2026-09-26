import type { SemanticKey } from './types.ts';

/**
 * Who did something.
 *
 * v1 had one implicit actor: the selection was *the* selection and the fence
 * belonged to nobody, because nobody else existed. Several agents at once
 * break that on day one, so everything that happens now says who did it.
 *
 * `local` is the person at the keyboard. `agent:<runId>` is one agent run.
 * `pad:<deviceId>` and `peer:<userId>` are reserved for later.
 */
export type ActorId = string;

export type ActorKind = 'human' | 'agent' | 'pad';

export interface Actor {
  id: ActorId;
  kind: ActorKind;
  /** Short, lower case: `you`, `agent-a`. */
  name: string;
  /** Rings, chips and cursors only. Never a node body: heat owns those. */
  hue: number;
}

export const LOCAL_ID: ActorId = 'local';

export const LOCAL: Actor = { id: LOCAL_ID, kind: 'human', name: 'you', hue: 212 };

/**
 * Hues for agents, in lane order. Kept clear of the heat ramp (amber through
 * red) so an agent's ring is never mistaken for a hot node.
 */
const AGENT_HUES = [186, 268, 322, 142, 48, 232];

export function agentId(runId: string): ActorId {
  return `agent:${runId}`;
}

export function actorKind(id: ActorId): ActorKind {
  if (id.startsWith('agent:')) { return 'agent'; }
  if (id.startsWith('pad:')) { return 'pad'; }
  return 'human';
}

/** `a`, `b`, … `z`, then `aa`. Lanes are named by letter on the queue strip. */
export function laneLetter(index: number): string {
  let n = Math.max(0, Math.floor(index));
  let out = '';
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

export function agentActor(runId: string, index: number): Actor {
  return {
    id: agentId(runId),
    kind: 'agent',
    name: `agent-${laneLetter(index)}`,
    hue: AGENT_HUES[index % AGENT_HUES.length]!,
  };
}

/** A selection belongs to someone. Two agents can each have one. */
export interface Selection {
  nodes: SemanticKey[];
  actor: ActorId;
  at: number;
}

export function selection(nodes: SemanticKey[], actor: ActorId = LOCAL_ID, at = Date.now()): Selection {
  return { nodes: [...new Set(nodes)], actor, at };
}
