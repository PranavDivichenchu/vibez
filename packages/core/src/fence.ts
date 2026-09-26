import type { ActorId } from './actors.ts';

/**
 * Scope fences as an allocation, with one rule that makes deadlock
 * structurally impossible: nothing ever waits.
 *
 * - An actor asks for a fence from its plan, before any write.
 * - It is granted only if the files are disjoint from every fence another
 *   actor holds.
 * - An actor that finds it needs one more file gets it only if nobody else
 *   holds it.
 * - A contested request is refused on the spot. The caller aborts and
 *   re-plans; it never queues, blocks or retries against a held fence.
 *
 * No waiting means no cycles, so there is no lock manager and no deadlock
 * detector.
 */

export type FenceResult =
  | { ok: true; files: string[] }
  | { ok: false; file: string; heldBy: ActorId };

/** Paths are compared relative to the workspace, forward slashes, no `./`. */
export function normalizePath(file: string): string {
  const parts: string[] = [];
  for (const part of file.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') { continue; }
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/');
}

export class Fences {
  private readonly held = new Map<ActorId, Set<string>>();

  /** Who holds `file`, if anyone. */
  holder(file: string): ActorId | undefined {
    const key = normalizePath(file);
    for (const [actor, files] of this.held) {
      if (files.has(key)) { return actor; }
    }
    return undefined;
  }

  holds(actor: ActorId, file: string): boolean {
    return this.held.get(actor)?.has(normalizePath(file)) ?? false;
  }

  /**
   * All or nothing. Adds to whatever `actor` already holds; refuses, and
   * changes nothing, if any file is held by someone else.
   */
  request(actor: ActorId, files: string[]): FenceResult {
    const keys = [...new Set(files.map(normalizePath).filter(Boolean))];
    for (const key of keys) {
      const owner = this.holder(key);
      if (owner !== undefined && owner !== actor) {
        return { ok: false, file: key, heldBy: owner };
      }
    }
    const mine = this.held.get(actor) ?? new Set<string>();
    for (const key of keys) { mine.add(key); }
    this.held.set(actor, mine);
    return { ok: true, files: [...mine].sort() };
  }

  /** One more file, mid-run. Same rule: granted if uncontested, refused if not. */
  extend(actor: ActorId, file: string): FenceResult {
    return this.request(actor, [file]);
  }

  /** Fences expire when a run ends. Returns what was released. */
  release(actor: ActorId): string[] {
    const files = this.held.get(actor);
    this.held.delete(actor);
    return files ? [...files].sort() : [];
  }

  /** One key ends every run and releases every fence. */
  releaseAll(): void {
    this.held.clear();
  }

  /** Visible to everyone: who holds what. */
  snapshot(): Record<ActorId, string[]> {
    const out: Record<ActorId, string[]> = {};
    for (const [actor, files] of this.held) {
      if (files.size) { out[actor] = [...files].sort(); }
    }
    return out;
  }
}

/** Which actor, if any, holds each file. For drawing `held by agent-a` chips. */
export function heldByFile(snapshot: Record<ActorId, string[]>): Map<string, ActorId> {
  const out = new Map<string, ActorId>();
  for (const [actor, files] of Object.entries(snapshot)) {
    for (const file of files) { out.set(normalizePath(file), actor); }
  }
  return out;
}
