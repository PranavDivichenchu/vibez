/** Static page navigation, independent of runtime traces. No project code is executed. */
export interface PageLink { label: string; href: string; file: string; line: number; target: string | null; status: 'resolved' | 'unresolved' | 'external'; }
export interface PageNode { id: string; route: string; file: string; links: PageLink[]; }
export interface PageMap { pages: PageNode[]; }

const clean = (text: string): string => text.replace(/<!--[\s\S]*?-->|\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
function normalize(path: string): string {
  const parts: string[] = [];
  for (const p of path.split('/')) { if (p === '..') { parts.pop(); } else if (p && p !== '.') { parts.push(p); } }
  return '/' + parts.join('/');
}
function route(file: string): { scope: string; path: string } | null {
  if (/\.html?$/.test(file)) { return { scope: 'html', path: normalize(file.replace(/index\.html?$/, '').replace(/\.html?$/, '')) }; }
  const app = /^(.*?)(?:src\/)?app\/(.*)page\.[jt]sx?$/.exec(file);
  if (app) { return { scope: app[1]! + 'next', path: normalize(app[2]!.split('/').filter(p => !/^\(.*\)$/.test(p)).join('/')) }; }
  const pages = /^(.*?)(?:src\/)?pages\/(.+)\.[jt]sx?$/.exec(file);
  if (pages && !/^(?:api\/|_)/.test(pages[2]!)) { return { scope: pages[1]! + 'next', path: normalize(pages[2]!.replace(/(?:^|\/)index$/, '')) }; }
  return null;
}

/** Conservative literal-link discovery. Computed expressions stay unresolved. */
export function discoverPages(files: ReadonlyMap<string, string>): PageMap {
  const routes = new Map<string, { scope: string; path: string }>();
  for (const file of files.keys()) { const r = route(file); if (r) { routes.set(file, r); } }
  const pages: PageNode[] = [];
  const imported = (file: string, seen = new Set<string>()): string[] => {
    if (seen.has(file)) { return []; } seen.add(file);
    const found = [file];
    for (const m of clean(files.get(file) ?? '').matchAll(/\bimport\s+(?:[^;\n]*?\s+from\s*)?['"](\.[^'"]+)['"]/g)) {
      const base = normalize(file.slice(0, file.lastIndexOf('/') + 1) + m[1]).slice(1);
      const path = [base, ...['.tsx', '.jsx', '.ts', '.js', '/index.tsx', '/index.jsx'].map(e => base + e)].find(p => files.has(p));
      if (path) { found.push(...imported(path, seen)); }
    }
    return found;
  };
  for (const [file, r] of routes) {
    const sources = imported(file);
    // App-router layouts contribute navigation to every descendant page.
    if (r.scope !== 'html') {
      const parts = file.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!/(?:^|\/)app(?:\/|$)/.test(dir)) { continue; }
        for (const ext of ['tsx', 'jsx', 'ts', 'js']) { const layout = dir + '/layout.' + ext; if (files.has(layout)) { sources.push(...imported(layout)); } }
      }
    }
    const links: PageLink[] = [];
    for (const source of new Set(sources)) {
      const text = clean(files.get(source) ?? '');
      for (const m of text.matchAll(/<(a|Link|button)\b((?:"[^"]*"|'[^']*'|\{[^}]*\}|[^>])*)>([\s\S]*?)<\/\1\s*>/g)) {
        const attr = /\bhref\s*=\s*(?:(["'])(.*?)\1|\{\s*(["'])(.*?)\3\s*\}|\{([^}]+)\})/.exec(m[2]!);
        const handler = m[1] === 'button' ? /\bonClick\s*=\s*\{([\s\S]*)\}/.exec(m[2]!) : null;
        const call = handler ? /(?:\brouter\.(?:push|replace)|\bnavigate|\blocation\.(?:assign|replace))\s*\(\s*(["'])(.*?)\1\s*\)/.exec(handler[1]!) : null;
        if (!attr && !handler) { continue; }
        const literal = attr ? attr[2] ?? attr[4] : call?.[2];
        const href = literal ?? `{${attr?.[5] ?? handler?.[1]}}`;
        const label = m[3]!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim() || href;
        const external = literal !== undefined && /^(?:[a-z][\w+.-]*:|\/\/)/i.test(literal);
        let target: string | null = null;
        if (literal !== undefined && !external) {
          const path = literal.split(/[?#]/)[0]!;
          const base = r.scope === 'html' ? file : r.path + '/';
          const resolved = !path ? r.path : normalize(path.startsWith('/') ? path : base.slice(0, base.lastIndexOf('/') + 1) + path).replace(/\/index\.html?$/, '').replace(/\.html?$/, '').replace(/\/$/, '') || '/';
          const matches = [...routes].filter(([, dest]) => dest.scope === r.scope && dest.path === resolved);
          if (matches.length === 1) { target = matches[0]![0]; }
        }
        links.push({ label, href, file: source, line: text.slice(0, m.index).split('\n').length, target, status: external ? 'external' : target ? 'resolved' : 'unresolved' });
      }
    }
    pages.push({ id: file, route: r.path, file, links });
  }
  return { pages: pages.sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file)) };
}

// ---------------------------------------------------------------------------
// The site canvas: live pages, and what an element on them does.
//
// Everything below is pure so it can be tested without a browser. The browser
// side (the bridge injected into each page) reports what it sees as an
// `ElementInfo`; `explainElement` turns that plus the project's files into the
// plain-words answer shown in the inspector.
// ---------------------------------------------------------------------------

/** Where a page's URL path lands on the map: `/about.html`, `/about/` and `/about` are one page. */
export function routeOfPath(pathname: string): string {
  let p = pathname.split(/[?#]/)[0] || '/';
  try { p = decodeURI(p); } catch { /* keep it as sent */ }
  p = p.replace(/\/index\.html?$/, '/').replace(/\.html?$/, '');
  if (p.length > 1) { p = p.replace(/\/+$/, ''); }
  return p || '/';
}

/** The URL path a static HTML file is served at. */
export function urlPathOfFile(file: string): string {
  return '/' + file.replace(/(^|\/)index\.html?$/, '$1');
}

const UNMARKED = new Set(['html', 'head', 'meta', 'link', 'base', 'title', 'script', 'style', 'noscript', 'template']);

/**
 * Marks every start tag with the line it was written on (`data-vz-line`) and
 * where in the file it starts (`data-vz-at`, a character offset).
 *
 * The inspector uses it to jump from an element on the page to the exact line
 * of HTML that wrote it. Only files served from disk are marked; an element a
 * script created has no mark, which is itself useful to know.
 */
export function annotateHtml(html: string): string {
  const out: string[] = [];
  let line = 1;
  let i = 0;
  const tag = /<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/y;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out.push(html.slice(i)); break; }
    const before = html.slice(i, lt);
    out.push(before);
    line += countLines(before);
    i = lt;
    if (html.startsWith('<!--', i)) {
      const end = html.indexOf('-->', i + 4);
      const stop = end < 0 ? html.length : end + 3;
      const chunk = html.slice(i, stop);
      out.push(chunk); line += countLines(chunk); i = stop;
      continue;
    }
    tag.lastIndex = i;
    const m = tag.exec(html);
    if (!m) { out.push('<'); i++; continue; }
    const name = m[1]!.toLowerCase();
    const whole = m[0];
    if (UNMARKED.has(name) || /\sdata-vz-(?:line|at)\s*=/.test(whole)) {
      out.push(whole);
    } else {
      const close = m[3] ? '/>' : '>';
      out.push(whole.slice(0, whole.length - close.length).replace(/\s*$/, '') + ` data-vz-line="${line}" data-vz-at="${i}"` + close);
    }
    line += countLines(whole);
    i += whole.length;
    // Script and style bodies are not markup.
    if (name === 'script' || name === 'style' || name === 'textarea' || name === 'title') {
      const end = html.toLowerCase().indexOf(`</${name}`, i);
      const stop = end < 0 ? html.length : end;
      const body = html.slice(i, stop);
      out.push(body); line += countLines(body); i = stop;
    }
  }
  return out.join('');
}

function countLines(text: string): number {
  let n = 0;
  for (let k = text.indexOf('\n'); k >= 0; k = text.indexOf('\n', k + 1)) { n++; }
  return n;
}

/**
 * Puts a script first in the document so it runs before any of the page's own.
 * The script must be a single line: inline scripts report line numbers relative
 * to the document, and a longer bridge would shift every one of them.
 */
export function injectAtHeadStart(html: string, script: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) { return html.slice(0, head.index + head[0].length) + script + html.slice(head.index + head[0].length); }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) { return doctype[0] + script + html.slice(doctype[0].length); }
  return script + html;
}

export interface CodeRef { file: string; line: number; label: string }

/** What the bridge saw when someone double-clicked an element. */
export interface ElementInfo {
  /** The page it was on: the map's page id (its file). */
  page: string;
  tag: string;
  id: string;
  classes: string[];
  /** Visible text, trimmed and shortened. */
  text: string;
  /** aria-label, title, alt or placeholder: whatever names it for a person. */
  label: string;
  /** `data-vz-line` from the served HTML, or null when a script created it. */
  line: number | null;
  /** `data-vz-at`: where the element's start tag begins in its file. Null when a script created it. */
  at?: number | null;
  /** The href as written, for links. */
  href: string | null;
  /** The same-origin path the href resolves to, or null. */
  path: string | null;
  external: boolean;
  role: string;
  type: string;
  name: string;
  src: string | null;
  form: { action: string; method: string; fields: { name: string; type: string }[]; line: number | null } | null;
  /** onclick="…" and friends, as written. */
  inline: { event: string; code: string }[];
  /** Listeners the page registered, with where they were registered (url:line:col). */
  listeners: { event: string; code: string; where: string | null; on: string; watching?: string }[];
  /** Handlers React attached as props (dev builds only). */
  react: { event: string; code: string }[];
  /** Graph nodes whose region contains this element. */
  nodes: string[];
  /** Breadcrumb from the page down to the element, e.g. `nav`, `a.cta`. */
  path_: string[];
  /** Links inside it. */
  links: number;
  /** Requests the page made while loading (fetch / XHR). */
  requests: string[];
  /** Whether the page was served from disk (true) or from a running app (false). */
  fromDisk: boolean;
}

export interface GraphLike {
  nodes: { id: string; kind: string; label: string; anchor: { file: string; line: number; symbol: string } | null; metrics?: { selfMs?: { p50: number } }; domKey?: string }[];
  edges: { from: { node: string }; to: { node: string } }[];
}

export interface ExplainContext {
  sources: ReadonlyMap<string, string>;
  pages: readonly PageNode[];
  graph?: GraphLike | null;
}

export interface Explanation {
  /** One short name: "Link to /about". */
  title: string;
  kind: string;
  /** One or two sentences, in plain words. */
  summary: string;
  /** Where it is written. */
  code: CodeRef[];
  /** What happens when you use it. */
  actions: { title: string; detail: string; code: CodeRef | null; snippet?: string; phrase?: string }[];
  /** Where what it shows comes from. */
  data: { title: string; detail: string; code: CodeRef | null }[];
  destination: { href: string; route: string | null; page: string | null; external: boolean } | null;
  /** Measured steps from the graph, when the app has been traced. */
  steps: { id: string; label: string; kind: string; ms: number | null; code: CodeRef | null }[];
  breadcrumb: string[];
}

/** Class → name for the element library's pieces (see elements.ts); kept here so pages.ts stays standalone. */
const LIBRARY_NAMES: Record<string, string> = {
  'vz-title': 'Title', 'vz-heading': 'Heading', 'vz-subheading': 'Subheading', 'vz-text': 'Text box', 'vz-lead': 'Intro text',
  'vz-quote': 'Quote', 'vz-list': 'List', 'vz-small': 'Small print', 'vz-button': 'Button', 'vz-actions': 'Two buttons',
  'vz-image': 'Image', 'vz-figure': 'Image with caption', 'vz-gallery': 'Gallery', 'vz-video': 'Video', 'vz-map': 'Map',
  'vz-embed': 'Embed', 'vz-divider': 'Divider', 'vz-spacer': 'Spacer', 'vz-section': 'Section', 'vz-price': 'Price box', 'vz-card': 'Card',
  'vz-columns': 'Two columns', 'vz-cards': 'Three cards', 'vz-callout': 'Callout', 'vz-hero': 'Hero banner', 'vz-form': 'Contact form',
  'vz-inline-form': 'Newsletter signup', 'vz-field': 'Form field', 'vz-check': 'Checkbox', 'vz-choices': 'Choices', 'vz-table': 'Table',
  'vz-faq': 'Question & answer', 'vz-stats': 'Numbers', 'vz-testimonial': 'Testimonial', 'vz-code': 'Code block', 'vz-social': 'Social links', 'vz-links': 'Link row',
};

const NAV_CALL = /(?:\brouter\.(?:push|replace)|\bnavigate|\blocation\.(?:assign|replace)|\blocation\.href\s*=|\bwindow\.location\s*=)\s*\(?\s*(["'`])([^"'`]+)\1/;

/** The literal URL a handler navigates to, if it names one. */
export function navigationInCode(code: string): string | null {
  return NAV_CALL.exec(code)?.[2] ?? null;
}

function describeElement(el: ElementInfo): { kind: string; title: string } {
  const t = el.tag;
  const name = (el.text || el.label || '').slice(0, 40);
  const q = name ? ` “${name}”` : '';
  if ((t === 'a' || t === 'area') && el.href !== null) { return { kind: 'Link', title: `Link${q}` }; }
  if (t === 'button' || el.role === 'button' || (t === 'input' && /^(submit|button|reset|image)$/.test(el.type))) { return { kind: 'Button', title: `Button${q}` }; }
  if (t === 'form') { return { kind: 'Form', title: el.label ? `Form “${el.label}”` : 'Form' }; }
  if (t === 'input' || t === 'textarea' || t === 'select') {
    const what = el.label || el.name || el.type || 'text';
    return { kind: t === 'select' ? 'Dropdown' : el.type === 'checkbox' ? 'Checkbox' : el.type === 'radio' ? 'Option' : 'Input field', title: `${t === 'select' ? 'Dropdown' : 'Field'} “${what}”` };
  }
  if (t === 'img' || t === 'picture' || t === 'svg') { return { kind: 'Image', title: el.label ? `Image “${el.label}”` : 'Image' }; }
  if (t === 'video' || t === 'audio') { return { kind: t === 'video' ? 'Video' : 'Audio', title: t === 'video' ? 'Video' : 'Audio' }; }
  if (/^h[1-6]$/.test(t)) { return { kind: 'Heading', title: `Heading${q}` }; }
  if (t === 'nav') { return { kind: 'Navigation', title: 'Navigation bar' }; }
  if (t === 'header') { return { kind: 'Section', title: 'Page header' }; }
  if (t === 'footer') { return { kind: 'Section', title: 'Page footer' }; }
  if (t === 'main' || t === 'section' || t === 'article' || t === 'aside') { return { kind: 'Section', title: `${t[0]!.toUpperCase()}${t.slice(1)} section` }; }
  if (t === 'ul' || t === 'ol') { return { kind: 'List', title: 'List' }; }
  if (t === 'table') { return { kind: 'Table', title: 'Table' }; }
  if (t === 'iframe') { return { kind: 'Embed', title: 'Embedded page' }; }
  if (/^(p|span|li|label|strong|em|small|blockquote|td|th|dd|dt)$/.test(t)) { return { kind: 'Text', title: `Text${q}` }; }
  return { kind: 'Block', title: el.id ? `Block #${el.id}` : el.classes[0] ? `Block .${el.classes[0]}` : `<${t}> block` };
}

/** Finds where a handler's code is written by matching its first real line. */
export function findCode(code: string, sources: ReadonlyMap<string, string>): { file: string; line: number } | null {
  const body = code.replace(/^[^{]*?=>\s*/, '').replace(/^\s*(?:async\s+)?function\b[^{]*\{/, '').replace(/^\s*\{/, '');
  const probes = body.split('\n').map(l => l.trim().replace(/\s*\}+\)?;?\s*$/, '')).filter(l => l.length >= 8 && !/^[}\])]+;?$/.test(l));
  for (const probe of probes.slice(0, 3)) {
    const needle = probe.replace(/\s+/g, ' ');
    for (const [file, text] of sources) {
      const lines = text.split('\n');
      for (let n = 0; n < lines.length; n++) {
        if (lines[n]!.replace(/\s+/g, ' ').includes(needle)) { return { file, line: n + 1 }; }
      }
    }
  }
  return null;
}

/** `http://127.0.0.1:5123/js/app.js:12:5` → the project file and line, when served from disk. */
export function codeAt(where: string | null, el: ElementInfo, ctx: ExplainContext): { file: string; line: number } | null {
  if (!where || !el.fromDisk) { return null; }
  const m = /^(?:https?:\/\/[^/]+)?(\/[^:?#]*)[^:]*:(\d+)(?::\d+)?$/.exec(where);
  if (!m) { return null; }
  let path = m[1]!;
  try { path = decodeURI(path); } catch { /* as sent */ }
  const rel = path.replace(/^\//, '');
  const candidates = [rel, rel + 'index.html', rel.replace(/\/$/, '') + '/index.html', rel + '.html'];
  const file = candidates.find(c => ctx.sources.has(c));
  return file ? { file, line: Number(m[2]) } : null;
}

/**
 * What a handler does, said the way a person would: "counts up and changes
 * text on the page". Reads the code for a handful of well-known moves; says
 * "runs some code" rather than guess when it recognises none of them.
 */
export function gistOf(code: string, event = 'click'): string {
  const said: string[] = [];
  const say = (p: string) => { if (!said.includes(p)) { said.push(p); } };
  const nav = navigationInCode(code);
  if (nav) { say(`goes to ${nav}`); }
  const req = /\bfetch\(\s*(["'`])([^"'`]+)\1/.exec(code) ?? /\baxios\.\w+\(\s*(["'`])([^"'`]+)\1/.exec(code);
  if (req) { say(`sends a request to ${req[2]}`); } else if (/\bfetch\(|XMLHttpRequest|\baxios\b/.test(code)) { say('sends a request to a server'); }
  for (const m of code.matchAll(/classList\.(toggle|add|remove)\(\s*["'`]([\w-]+)["'`]/g)) {
    say(m[1] === 'toggle' ? `switches “${m[2]}” on and off` : m[1] === 'add' ? `turns on “${m[2]}”` : `turns off “${m[2]}”`);
  }
  if (/\+=\s*1\b|\+\+|-=\s*1\b|--[\w$]/.test(code)) { say('counts up'); }
  if (/\.(?:textContent|innerText|innerHTML|value)\s*=[^=]/.test(code)) { say('changes text on the page'); }
  if (/\b(?:set\w*State|dispatch)\(|\bset[A-Z]\w*\(/.test(code)) { say('updates what the page shows'); }
  if (/(?:local|session)Storage\.setItem|document\.cookie\s*=/.test(code)) { say('saves something in the browser'); }
  if (/\b(?:alert|confirm|prompt)\(/.test(code)) { say('shows a pop-up'); }
  if (/\.style\.\w+\s*=/.test(code)) { say('changes how something looks'); }
  if (/\b(?:appendChild|insertAdjacentHTML|insertBefore|prepend)\(|\.append\(/.test(code)) { say('adds things to the page'); }
  if (/\.remove\(\s*\)/.test(code)) { say('removes something from the page'); }
  if (/\bscroll(?:To|By|IntoView)\(/.test(code)) { say('scrolls the page'); }
  if (/\.play\(\)|\.pause\(\)/.test(code)) { say('plays or pauses media'); }
  if (/\.(?:showModal|show)\(\)|\.open\s*=\s*true/.test(code)) { say('opens a dialog'); }
  if (/\bpreventDefault\(\)/.test(code) && event === 'submit') { say('keeps the page from reloading'); }
  if (!said.length && /console\.\w+\(/.test(code)) { say('writes a note to the developer console'); }
  if (!said.length) { say('runs some code'); }
  if (said.length === 1) { return said[0]!; }
  return said.slice(0, -1).join(', ') + ' and ' + said[said.length - 1];
}

function snippetOf(code: string, max = 420): string {
  const lines = code.replace(/\t/g, '  ').split('\n');
  const indent = Math.min(...lines.slice(1).filter(l => l.trim()).map(l => l.length - l.trimStart().length), 99);
  const text = [lines[0]!, ...lines.slice(1).map(l => l.slice(Math.min(indent, l.length - l.trimStart().length)))].join('\n').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function capital(text: string): string { return text.charAt(0).toUpperCase() + text.slice(1); }

/** The plain-words answer to “what is this and what does it do?”. */
export function explainElement(el: ElementInfo, ctx: ExplainContext): Explanation {
  const page = ctx.pages.find(p => p.id === el.page) ?? null;
  const described = describeElement(el);
  const { kind } = described;
  // Pieces added from the element library say what they are by name.
  const library = el.classes.includes('vz-el') ? el.classes.map(c => LIBRARY_NAMES[c]).find(Boolean) : undefined;
  const quoted = library && /^(Title|Heading|Subheading|Text box|Intro text|Quote|Small print|Button)$/.test(library) && el.text && el.text.length < 40;
  const title = library ? `${library}${quoted ? ` “${el.text}”` : ''}` : described.title;
  const code: CodeRef[] = [];
  const actions: Explanation['actions'] = [];
  const data: Explanation['data'] = [];
  const here: CodeRef | null = page && el.line !== null ? { file: page.file, line: el.line, label: `${page.file}:${el.line}` } : null;
  if (here) { code.push({ ...here, label: `<${el.tag}> in ${page!.file}` }); }

  // Where it goes.
  let destination: Explanation['destination'] = null;
  const pageForPath = (path: string) => {
    const route = routeOfPath(path);
    const hits = ctx.pages.filter(p => p.route === route || routeOfPath(urlPathOfFile(p.file)) === route);
    return { route, page: hits.length === 1 ? hits[0]!.id : null };
  };
  if (kind === 'Link' && el.href !== null) {
    const href = el.href;
    if (/^mailto:/i.test(href)) {
      actions.push({ title: 'Starts an email', detail: `Opens the visitor's email app, addressed to ${href.slice(7).split('?')[0]}.`, code: here });
    } else if (/^tel:/i.test(href)) {
      actions.push({ title: 'Starts a call', detail: `Dials ${href.slice(4)} on phones.`, code: here });
    } else if (href.startsWith('#')) {
      actions.push({ title: 'Jumps within this page', detail: href.length > 1 ? `Scrolls to the part of this page marked “${href.slice(1)}”.` : 'Scrolls back to the top of this page.', code: here });
    } else if (el.external || el.path === null) {
      let host = href; try { host = new URL(href).host; } catch { /* as written */ }
      destination = { href, route: null, page: null, external: true };
      actions.push({ title: 'Leaves the site', detail: `Opens ${host}, which is another website.`, code: here });
    } else {
      const { route, page: target } = pageForPath(el.path);
      destination = { href, route, page: target, external: false };
      const targetFile = target ? ctx.pages.find(p => p.id === target)?.file : null;
      actions.push({
        title: target ? `Opens the ${route} page` : `Goes to ${route}`,
        detail: target ? `Clicking it loads ${targetFile}.` : 'No page in this project answers that address yet, so visitors would see an error.',
        code: here,
      });
    }
  }

  // Code that runs when you use it.
  for (const h of el.inline) {
    const phrase = gistOf(h.code, h.event.replace(/^on/, ''));
    actions.push({ title: `On ${h.event.replace(/^on/, '')}`, detail: `${capital(phrase)}.`, phrase, snippet: snippetOf(h.code), code: here });
  }
  for (const h of el.react) {
    const at = findCode(h.code, ctx.sources);
    const event = h.event.replace(/^on/, '').toLowerCase();
    const phrase = gistOf(h.code, event);
    actions.push({ title: `On ${event}`, detail: `${capital(phrase)}.`, phrase, snippet: snippetOf(h.code), code: at ? { ...at, label: `${at.file}:${at.line}` } : null });
  }
  for (const h of el.listeners) {
    const at = codeAt(h.where, el, ctx) ?? findCode(h.code, ctx.sources);
    const phrase = gistOf(h.code, h.event);
    const who = h.on === 'self' ? '' : h.watching ? ` · handled by ${h.on}` : ` · a listener on ${h.on} that may handle it`;
    const how = h.on === 'self' || !h.watching ? '' : h.watching === 'form' ? ` The form it belongs to (${h.on}) handles sending it.` : ` It listens on ${h.on} and reacts to anything matching ${h.watching}, which includes this.`;
    actions.push({ title: `On ${h.event}${who}`, detail: `${capital(phrase)}.${how}`, phrase, snippet: snippetOf(h.code), code: at ? { ...at, label: `${at.file}:${at.line}` } : null });
  }
  if (el.form && (kind === 'Form' || (kind === 'Button' && (el.type === 'submit' || el.type === '')))) {
    const to = el.form.action ? el.form.action : 'this same page';
    const fields = el.form.fields.map(f => f.name || f.type).filter(Boolean);
    actions.push({
      title: kind === 'Form' ? 'Sends what visitors type' : 'Sends the form',
      detail: `Sends ${fields.length ? fields.join(', ') : 'the form'} to ${to} using ${el.form.method.toUpperCase() || 'GET'}.`,
      code: page && el.form.line !== null ? { file: page.file, line: el.form.line, label: `<form> in ${page.file}` } : here,
    });
  }
  if (kind === 'Input field' || kind === 'Dropdown' || kind === 'Checkbox' || kind === 'Option') {
    actions.push({ title: 'Collects input', detail: el.form ? `What visitors enter here is sent with the form to ${el.form.action || 'this same page'}.` : 'It is not inside a form, so only scripts on the page read it.', code: here });
  }
  if (el.links > 0 && kind !== 'Link') {
    actions.push({ title: `Holds ${el.links} link${el.links === 1 ? '' : 's'}`, detail: 'Double-click one of them to see where it goes.', code: null });
  }

  // Where what it shows comes from.
  const graph = ctx.graph ?? null;
  const steps: Explanation['steps'] = [];
  if (graph && el.nodes.length) {
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    const seen = new Set<string>();
    const queue = el.nodes.map(id => ({ id, depth: 0 }));
    while (queue.length) {
      const { id, depth } = queue.shift()!;
      if (seen.has(id)) { continue; } seen.add(id);
      const n = byId.get(id); if (!n) { continue; }
      const ref = n.anchor ? { file: n.anchor.file, line: n.anchor.line, label: `${n.anchor.symbol} · ${n.anchor.file}:${n.anchor.line}` } : null;
      steps.push({ id: n.id, label: n.anchor?.symbol || n.label, kind: n.kind, ms: n.metrics?.selfMs?.p50 ?? null, code: ref });
      if (n.kind === 'data' || n.kind === 'external') {
        data.push({ title: n.kind === 'data' ? `Loaded from the database by ${n.anchor?.symbol ?? n.label}` : `Fetched from another service by ${n.anchor?.symbol ?? n.label}`, detail: `${n.label}${n.metrics?.selfMs ? ` · about ${Math.round(n.metrics.selfMs.p50)} ms` : ''}`, code: ref });
      } else if (n.kind === 'render') {
        data.push({ title: `Drawn by ${n.anchor?.symbol ?? n.label}`, detail: 'The code that builds this part of the page.', code: ref });
      }
      if (depth < 2) { for (const e of graph.edges) { if (e.from.node === id) { queue.push({ id: e.to.node, depth: depth + 1 }); } } }
    }
  }
  if (kind === 'Image' && el.src) {
    let file: string | null = null;
    if (page && !/^(?:[a-z]+:|\/\/|data:)/i.test(el.src)) {
      const base = page.file.slice(0, page.file.lastIndexOf('/') + 1);
      const rel = el.src.startsWith('/') ? el.src.slice(1) : normalize(base + el.src).slice(1);
      file = rel;
    }
    data.push({ title: 'Picture file', detail: file ? `Shows ${file}${el.label ? `, described as “${el.label}”` : ' (it has no description for screen readers)'}.` : `Shows ${el.src}.`, code: null });
  }
  if (!data.length && el.text && here && kind !== 'Image') {
    data.push({ title: 'Written into the page', detail: `The words are typed directly into ${here.file} on line ${here.line}, so changing them there changes the page.`, code: { ...here, label: `${here.file}:${here.line}` } });
  }
  if (el.line === null && el.fromDisk && !steps.length) {
    data.push({ title: 'Added by a script', detail: 'This is not in the HTML file. A script on the page created it after the page loaded.', code: null });
  }
  if (el.line === null && el.requests.length && !steps.length) {
    data.push({ title: 'Data the page asked for', detail: `While loading, the page requested ${el.requests.slice(0, 4).join(', ')}${el.requests.length > 4 ? '…' : ''}.`, code: null });
  }

  // One or two sentences a person would say.
  let summary: string;
  const first = actions[0];
  const handler = actions.find(a => a.phrase);
  const an = (k: string) => `a${/^[AEIOU]/.test(k) ? 'n' : ''} ${k.toLowerCase()}`;
  if (kind === 'Link' && destination && !destination.external) {
    summary = destination.page ? `A link. Clicking it opens the ${destination.route} page.` : `A link to ${destination.route}, but no page in this project answers there.`;
  } else if (kind === 'Link' && first) {
    summary = `A link. ${first.detail}`;
  } else if (handler) {
    const verb = kind === 'Input field' || kind === 'Dropdown' ? 'Changing it' : kind === 'Form' ? 'Sending it' : 'Clicking it';
    summary = `${capital(kind === 'Block' ? 'an area' : an(kind))}. ${verb} ${handler.phrase}.`;
  } else if (actions.length && first) {
    summary = `${capital(kind === 'Block' ? 'an area' : an(kind))}. ${first.detail}`;
  } else if (kind === 'Heading' || kind === 'Text') {
    summary = `${kind === 'Heading' ? 'A heading' : 'Text'} on the page. It only displays; nothing happens when you click it.`;
  } else {
    summary = `${capital(an(kind))} on the page. Nothing happens when you click it.`;
  }
  if (!actions.length && kind !== 'Heading' && kind !== 'Text') {
    actions.push({ title: 'Nothing on click', detail: 'No link, form or script responds to it. It is there to be seen.', code: null });
  }
  return { title, kind, summary, code, actions, data, destination, steps, breadcrumb: el.path_ };
}
