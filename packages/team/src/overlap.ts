/**
 * Whether what one agent is about to do collides with what the team's other
 * agents are doing, the way Amoeba-style coordination works: compare the
 * files (and pages, and elements) each has claimed, the files related to
 * them, and the words of their tasks.
 *
 *   overlapping  the same file, or the same element of a page
 *   adjacent     the same page but a different element, a file linked to the
 *                one you are touching (a page's .vi), or the same folder
 *   related      no shared files, but the tasks describe the same work
 *
 * Pure, so the MCP server, the IDE and the tests share it.
 */

export interface ActiveClaim {
  path: string;
  note: string;
  agentId: string;
  userId: string;
  person: string;
  task: string;
  /** ISO time the claiming agent was last heard from. */
  lastSeen: string;
}

export type OverlapLevel = 'overlapping' | 'adjacent' | 'related';

export interface Overlap {
  level: OverlapLevel;
  claim: ActiveClaim;
  why: string;
  /** Minutes since that agent was last heard from; above STALE_MINUTES it has probably stopped. */
  idleMinutes: number;
}

export const STALE_MINUTES = 10;

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.trim().replace(/\\/g, '/').split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  return parts.join('/');
}

const fileOf = (path: string): string => normalizePath(path.split('#')[0]!);
const elementOf = (path: string): string | undefined => path.includes('#') ? path.slice(path.indexOf('#') + 1) : undefined;
const dirOf = (file: string): string => file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'make', 'have', 'will', 'should', 'page', 'file', 'code', 'some', 'when', 'then', 'them', 'they', 'their', 'there', 'what', 'which', 'also', 'more', 'each', 'every', 'only', 'just', 'like']);

export function taskWords(task: string): Set<string> {
  const words = task.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''));
  return new Set(words);
}

export function taskSimilarity(a: string, b: string): number {
  const x = taskWords(a);
  const y = taskWords(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}

export interface Intent {
  paths: string[];
  task?: string;
  /** Files that go with the ones being touched, like a page's linked .vi files. */
  related?: string[];
  /** Claims by this agent are never an overlap with itself. */
  agentId?: string;
}

export function overlaps(mine: Intent, claims: ActiveClaim[], now = Date.now()): Overlap[] {
  const out: Overlap[] = [];
  const related = new Set((mine.related ?? []).map(fileOf));
  const seen = new Set<string>();
  for (const claim of claims) {
    if (mine.agentId && claim.agentId === mine.agentId) continue;
    const idleMinutes = Math.max(0, Math.round((now - Date.parse(claim.lastSeen)) / 60_000));
    const theirs = fileOf(claim.path);
    let best: { level: OverlapLevel; why: string } | undefined;
    for (const path of mine.paths) {
      const file = fileOf(path);
      if (file === theirs) {
        const a = elementOf(path);
        const b = elementOf(claim.path);
        best = a && b && a !== b
          ? pick(best, { level: 'adjacent', why: `same page (${file}), different element (${b})` })
          : pick(best, { level: 'overlapping', why: b && a ? `the same element, ${file}#${b}` : `the same file, ${file}` });
      } else if (related.has(theirs)) {
        best = pick(best, { level: 'adjacent', why: `${theirs} goes with ${file}` });
      } else if (dirOf(file) && dirOf(file) === dirOf(theirs)) {
        best = pick(best, { level: 'adjacent', why: `the same folder, ${dirOf(file)}/` });
      }
    }
    if (!best && mine.task && claim.task && taskSimilarity(mine.task, claim.task) >= 0.34) {
      best = { level: 'related', why: `their task sounds like the same work: "${claim.task}"` };
    }
    if (!best) continue;
    const key = `${claim.agentId}|${best.level}|${best.why}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ...best, claim, idleMinutes });
  }
  const rank: Record<OverlapLevel, number> = { overlapping: 0, adjacent: 1, related: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || a.idleMinutes - b.idleMinutes);
}

function pick(current: { level: OverlapLevel; why: string } | undefined, next: { level: OverlapLevel; why: string }) {
  const rank: Record<OverlapLevel, number> = { overlapping: 0, adjacent: 1, related: 2 };
  return !current || rank[next.level] < rank[current.level] ? next : current;
}

/** One line a person or an agent can act on. */
export function describeOverlap(o: Overlap): string {
  const who = `${o.claim.person}'s agent`;
  const when = o.idleMinutes >= STALE_MINUTES ? ` (quiet for ${o.idleMinutes} min, it may have stopped)` : '';
  const doing = o.claim.task ? `, working on "${o.claim.task}"` : '';
  const verb = o.level === 'overlapping' ? 'is already on' : o.level === 'adjacent' ? 'is close by:' : 'may be doing the same thing:';
  return `${o.level}: ${who} ${verb} ${o.why}${doing}${when}.`;
}
