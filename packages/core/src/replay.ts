/**
 * A flow, recorded once and replayed many times.
 *
 * Recording happens in the preview: open a page, click, type, submit. The
 * steps are saved next to the flow as `.vibez/flows/<name>.replay.json` and
 * replayed in a hidden browser window against whichever copy of the app is
 * being measured, fifteen to twenty times, so every patch is timed doing the
 * same thing.
 */

export type ReplayStep =
  | { kind: 'goto'; path: string }
  | { kind: 'click'; selector: string; text?: string }
  | { kind: 'fill'; selector: string; value: string }
  | { kind: 'submit'; selector: string }
  | { kind: 'wait'; ms: number };

export interface ReplayScript {
  version: 1;
  name: string;
  steps: ReplayStep[];
}

/** Without a recording, a flow is one page load. */
export function defaultScript(path: string, name = 'default'): ReplayScript {
  return { version: 1, name, steps: [{ kind: 'goto', path: path || '/' }] };
}

const MAX_STEPS = 200;

/** Checks a script read from disk. Throws with a sentence a person can act on. */
export function parseScript(text: string): ReplayScript {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('The recorded flow is not valid JSON.');
  }
  const obj = raw as Partial<ReplayScript>;
  if (!obj || obj.version !== 1 || !Array.isArray(obj.steps)) {
    throw new Error('The recorded flow is missing its steps.');
  }
  if (obj.steps.length === 0) { throw new Error('The recorded flow has no steps.'); }
  if (obj.steps.length > MAX_STEPS) { throw new Error(`The recorded flow has ${obj.steps.length} steps; the limit is ${MAX_STEPS}.`); }
  const steps: ReplayStep[] = obj.steps.map((step, i) => {
    const s = step as Record<string, unknown>;
    const str = (key: string): string => {
      if (typeof s[key] !== 'string') { throw new Error(`Step ${i + 1} (${String(s['kind'])}) needs a ${key}.`); }
      return s[key] as string;
    };
    switch (s['kind']) {
      case 'goto': return { kind: 'goto', path: str('path') };
      case 'click': return typeof s['text'] === 'string'
        ? { kind: 'click', selector: str('selector'), text: s['text'] as string }
        : { kind: 'click', selector: str('selector') };
      case 'fill': return { kind: 'fill', selector: str('selector'), value: str('value') };
      case 'submit': return { kind: 'submit', selector: str('selector') };
      case 'wait': {
        const ms = Number(s['ms']);
        if (!(ms >= 0 && ms <= 30000)) { throw new Error(`Step ${i + 1} waits ${String(s['ms'])} ms; use 0 to 30000.`); }
        return { kind: 'wait', ms };
      }
      default: throw new Error(`Step ${i + 1} is a "${String(s['kind'])}", which the replayer does not know.`);
    }
  });
  if (steps[0]!.kind !== 'goto') { throw new Error('A recorded flow starts by opening a page.'); }
  return { version: 1, name: typeof obj.name === 'string' && obj.name ? obj.name : 'default', steps };
}

/**
 * Adds a step while recording, merging what a person would call one action:
 * typing into a field is one `fill` with the final value, not one per key.
 */
export function appendStep(script: ReplayScript, step: ReplayStep): ReplayScript {
  const steps = [...script.steps];
  const last = steps[steps.length - 1];
  if (step.kind === 'fill' && last?.kind === 'fill' && last.selector === step.selector) {
    steps[steps.length - 1] = step;
  } else if (step.kind === 'goto' && last?.kind === 'goto' && last.path === step.path) {
    // A reload of the page already open is not a new step.
  } else {
    steps.push(step);
  }
  return { ...script, steps: steps.slice(0, MAX_STEPS) };
}

/** One line per step, for showing a recording to the person who made it. */
export function describeStep(step: ReplayStep): string {
  switch (step.kind) {
    case 'goto': return `open ${step.path}`;
    case 'click': return step.text ? `click “${step.text}”` : `click ${step.selector}`;
    case 'fill': return `type “${step.value.length > 24 ? step.value.slice(0, 23) + '…' : step.value}” into ${step.selector}`;
    case 'submit': return `submit ${step.selector}`;
    case 'wait': return `wait ${step.ms} ms`;
  }
}

/**
 * The script run inside the page for one step. Returns a promise that
 * resolves to `ok` or to a sentence saying what could not be found.
 */
export function stepScript(step: Exclude<ReplayStep, { kind: 'goto' } | { kind: 'wait' }>): string {
  const sel = JSON.stringify(step.selector);
  const find = `var el = document.querySelector(${sel}); if (!el) { return 'nothing on the page matches ' + ${sel}; }`;
  switch (step.kind) {
    case 'click':
      return `(function(){ ${find} el.scrollIntoView({block:'center'}); el.click(); return 'ok'; })()`;
    case 'fill':
      return `(function(){ ${find} var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;`
        + ` var set = Object.getOwnPropertyDescriptor(proto, 'value'); set && set.set ? set.set.call(el, ${JSON.stringify(step.value)}) : (el.value = ${JSON.stringify(step.value)});`
        + ` el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return 'ok'; })()`;
    case 'submit':
      return `(function(){ ${find} var form = el.tagName === 'FORM' ? el : el.form || el.closest('form'); if (!form) { return 'no form around ' + ${sel}; }`
        + ` if (form.requestSubmit) { form.requestSubmit(); } else { form.submit(); } return 'ok'; })()`;
  }
}

/**
 * Assigns each trace to the replay run it happened in, by start time.
 * `windows` are [start, end] in epoch ms, one per run. Traces outside every
 * window (warm-up, stragglers) are dropped.
 */
export function runOf(startMs: number, windows: [number, number][] | Array<readonly [number, number]>, slackMs = 50): number {
  // A window that contains the start wins outright. Runs are back to back, so
  // slack must only decide what no window contains, or a request at the
  // boundary is counted in the run before it and its own run is lost.
  for (let i = 0; i < windows.length; i++) {
    const [a, b] = windows[i]!;
    if (startMs >= a && startMs <= b) { return i; }
  }
  let best = -1, bestGap = slackMs;
  for (let i = 0; i < windows.length; i++) {
    const [a, b] = windows[i]!;
    const gap = startMs < a ? a - startMs : startMs - b;
    if (gap < bestGap || (best < 0 && gap <= bestGap)) { best = i; bestGap = gap; }
  }
  return best;
}
