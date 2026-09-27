/**
 * Starting a new Vibez project: from a template, from a graph of ideas, or
 * from someone's X profile.
 *
 * Every way in ends at the same place — a small **project spec**: a name, a
 * theme, a few pages made of sections, and the page data and actions those
 * pages use. Grok writes one when asked (under a strict JSON schema), the
 * templates below are written by hand, and `normalizeSpec` checks any of them
 * before anything is built, since a model's answer is data, not code. The
 * files themselves are built by the `.ui` and `.vi` packages, handed in by
 * whoever calls `projectFiles`, so this file stays free of both.
 */

export type ValueType = 'String' | 'Number' | 'Boolean' | 'List';
export type ThemeId = 'clean' | 'paper' | 'playful' | 'mono' | 'midnight';
export const THEME_IDS: ThemeId[] = ['clean', 'paper', 'playful', 'mono', 'midnight'];

export interface SpecValue { name: string; type: ValueType; fields?: Record<string, 'String' | 'Number' | 'Boolean'>; sample: unknown; about?: string }
export interface SpecAction { name: string; inputs: { name: string; type: 'String' | 'Number' | 'Boolean' }[]; reply: string; about?: string }
export type SpecButton = { label: string; action?: string; goTo?: string };
export type SpecSection =
  | { kind: 'hero'; title: string; subtitle?: string; button?: SpecButton }
  | { kind: 'text'; heading?: string; body: string }
  | { kind: 'list'; heading?: string; list: string; show: string; detail?: string; button?: SpecButton }
  | { kind: 'stat'; label: string; value: string }
  | { kind: 'form'; heading?: string; fields: { name: string; label: string; type?: 'text' | 'email' | 'multiline' }[]; submit: { label: string; action: string } };
export interface SpecPage { file: string; name: string; route: string; sections: SpecSection[] }
export interface ProjectSpec { name: string; theme: ThemeId; pages: SpecPage[]; logic: { values: SpecValue[]; actions: SpecAction[] } }

// ---------------------------------------------------------------- the graph a person draws

/** A graph of ideas: text nodes, and which ones lead to which. */
export interface IdeaGraph {
  nodes: { id: string; text: string }[];
  edges: { from: string; to: string }[];
}

/** The graph in plain words, the way a person would read it out. */
export function describeGraph(graph: IdeaGraph): string {
  const text = new Map(graph.nodes.map((n) => [n.id, n.text.trim()]));
  const lines = graph.nodes.filter((n) => n.text.trim()).map((n) => `- ${n.text.trim()}`);
  const links = graph.edges
    .filter((e) => text.get(e.from) && text.get(e.to))
    .map((e) => `- "${text.get(e.from)}" → "${text.get(e.to)}"`);
  return [`Ideas:`, ...lines, ...(links.length ? ['', 'How they connect:', ...links] : [])].join('\n');
}

// ---------------------------------------------------------------- asking Grok

const RULES = `
You design small starter websites for Vibez, a visual website builder with no code. Keep it small and real:
- 2 to 4 pages. The first page's file is "home". Files are short lowercase words (home, menu, about). Every page is reachable from the others.
- Each page has 2 to 5 sections. Section kinds:
  hero: title (required), subtitle, and optionally a button.
  text: heading and body (a paragraph).
  list: repeats over a page-data List. "list" is that List's name; "show" is one of its item fields (shown large); "detail" another field (shown small). Optionally a button, which runs an action with the item's "show" field.
  stat: shows one page-data value that is a String, Number or Boolean, under a "label".
  form: input fields and a submit button that runs an action. Each input's "name" must equal the name of one of that action's inputs.
- A button either runs an action (buttonAction) or goes to another page (buttonGoTo = that page's file). Never both.
- Page data ("values"): camelCase names. A List has 3 to 6 example items, each an object whose keys are exactly the List's "fields". Give realistic, specific example content — real-sounding names, prices, dates — never "Item 1" or lorem ipsum. sampleJson is that example value written as JSON.
- Actions: camelCase names, at most 2 inputs. "reply" is what the site says back after it runs, written as a short, friendly sentence; it may mention a text input as {inputName}.
- Every value, action, field and page named in a section must exist exactly as spelled.
- Write every heading, subtitle and paragraph as the real site would say it, in the voice of whoever runs it.`;

const nullable = (type: string | string[]) => ({ type: [...(Array.isArray(type) ? type : [type]), 'null'] });

/** The JSON Grok has to answer with. Strict: every field present, unused ones null. */
export const PROJECT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'theme', 'pages', 'values', 'actions'],
  properties: {
    name: { type: 'string' },
    theme: { type: 'string', enum: THEME_IDS },
    pages: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['file', 'name', 'sections'],
        properties: {
          file: { type: 'string' }, name: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              required: ['kind', 'title', 'subtitle', 'heading', 'body', 'list', 'show', 'detail', 'label', 'value', 'buttonLabel', 'buttonAction', 'buttonGoTo', 'fields', 'submitLabel', 'submitAction'],
              properties: {
                kind: { type: 'string', enum: ['hero', 'text', 'list', 'stat', 'form'] },
                title: nullable('string'), subtitle: nullable('string'), heading: nullable('string'), body: nullable('string'),
                list: nullable('string'), show: nullable('string'), detail: nullable('string'),
                label: nullable('string'), value: nullable('string'),
                buttonLabel: nullable('string'), buttonAction: nullable('string'), buttonGoTo: nullable('string'),
                fields: {
                  type: ['array', 'null'],
                  items: { type: 'object', additionalProperties: false, required: ['name', 'label', 'type'], properties: { name: { type: 'string' }, label: { type: 'string' }, type: { type: 'string', enum: ['text', 'email', 'multiline'] } } },
                },
                submitLabel: nullable('string'), submitAction: nullable('string'),
              },
            },
          },
        },
      },
    },
    values: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'type', 'fields', 'sampleJson', 'about'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string', enum: ['String', 'Number', 'Boolean', 'List'] },
          fields: { type: ['array', 'null'], items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string', enum: ['String', 'Number', 'Boolean'] } } } },
          sampleJson: { type: 'string' },
          about: nullable('string'),
        },
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['name', 'inputs', 'reply', 'about'],
        properties: {
          name: { type: 'string' },
          inputs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: { name: { type: 'string' }, type: { type: 'string', enum: ['String', 'Number', 'Boolean'] } } } },
          reply: { type: 'string' },
          about: nullable('string'),
        },
      },
    },
  },
} as const;

export interface GrokRequest { model: string; input: { role: 'system' | 'user'; content: string }[]; tools?: unknown[]; text?: unknown }

/** Ask for a project spec, from anything described in words. */
export function projectRequest(model: string, brief: string): GrokRequest {
  return {
    model,
    input: [
      { role: 'system', content: RULES.trim() },
      { role: 'user', content: `Design a starter website from this:\n\n${brief.trim()}` },
    ],
    text: { format: { type: 'json_schema', name: 'vibez_project', strict: true, schema: PROJECT_SCHEMA } },
  };
}

/** Ask Grok to look someone up on X, for a site about them. */
export function profileRequest(model: string, handle: string): GrokRequest {
  const who = cleanHandle(handle);
  return {
    model,
    input: [{
      role: 'user',
      content: `Look up @${who} on X. In plain notes, no more than 250 words: who they are, what they do, what they post about most, `
        + `their tone, anything they make, sell, run or link to, and a few specific recent things they posted. Only what you can find; say so if the account is missing or private.`,
    }],
    tools: [{ type: 'x_search', allowed_x_handles: [who] }],
  };
}

/** "@Name", "x.com/name", " name " → "name". */
export function cleanHandle(handle: string): string {
  return handle.trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?#\s]/)[0]!.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
}

/** The words of a Responses API answer: every output_text of its message. */
export function grokText(response: unknown): string {
  const r = response as { error?: { message?: string } | string | null; output?: { type?: string; content?: { type?: string; text?: string }[] }[] };
  if (r?.error) throw new Error(typeof r.error === 'string' ? r.error : r.error.message ?? 'Grok returned an error.');
  const text = (r?.output ?? [])
    .filter((o) => o.type === 'message')
    .flatMap((o) => o.content ?? [])
    .filter((c) => c.type === 'output_text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('');
  if (!text.trim()) throw new Error('Grok did not answer with anything.');
  return text;
}

// ---------------------------------------------------------------- checking a spec

const ident = (s: unknown, fallback: string): string => {
  const words = String(s ?? '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  const camel = words.map((w, i) => (i ? w[0]!.toUpperCase() + w.slice(1) : w[0]!.toLowerCase() + w.slice(1))).join('');
  const name = /^[A-Za-z_]/.test(camel) ? camel : camel ? `v${camel}` : fallback;
  return name.slice(0, 40);
};
const slug = (s: unknown, fallback: string): string => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || fallback;
/** `{ key: value }`, or nothing at all when there is no value. */
const some = <K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> => (value === undefined ? {} : { [key]: value } as Partial<Record<K, V>>);
const words = (s: unknown, max = 400): string | undefined => {
  const t = typeof s === 'string' ? s.trim() : '';
  return t ? t.slice(0, max) : undefined;
};

/**
 * Turn whatever came back into a spec that builds: names made safe, every
 * reference checked against what exists, and anything that does not hold up
 * left out rather than guessed at. Throws only when there is nothing usable.
 */
export function normalizeSpec(raw: unknown): ProjectSpec {
  const r = (raw ?? {}) as Record<string, any>;
  // Grok answers with values and actions at the top; a finished spec keeps them under logic.
  const rawValues = r.values ?? r.logic?.values;
  const rawActions = r.actions ?? r.logic?.actions;
  // Page data first, since everything else refers to it.
  const values: SpecValue[] = [];
  for (const v of Array.isArray(rawValues) ? rawValues.slice(0, 12) : []) {
    const name = ident(v?.name, `value${values.length + 1}`);
    if (values.some((x) => x.name === name)) continue;
    const type: ValueType = ['String', 'Number', 'Boolean', 'List'].includes(v?.type) ? v.type : 'String';
    let sample: unknown = v?.sample;
    if (sample === undefined && typeof v?.sampleJson === 'string') {
      try { sample = JSON.parse(v.sampleJson); } catch { sample = undefined; }
    }
    if (type === 'List') {
      const list = Array.isArray(v?.fields) ? v.fields : Object.entries(v?.fields ?? {}).map(([n, t]) => ({ name: n, type: t }));
      const fields: Record<string, 'String' | 'Number' | 'Boolean'> = {};
      for (const f of list.slice(0, 8)) {
        const fname = ident(f?.name, '');
        if (fname) fields[fname] = ['Number', 'Boolean'].includes(f?.type) ? f.type : 'String';
      }
      if (!Object.keys(fields).length) continue;
      // Items keep only the declared fields, each coerced to its type.
      const items = (Array.isArray(sample) ? sample : []).slice(0, 12).filter((it: unknown) => it && typeof it === 'object').map((it: Record<string, unknown>) => {
        const item: Record<string, unknown> = {};
        for (const [fname, ftype] of Object.entries(fields)) {
          const raw = Object.entries(it).find(([k]) => ident(k, '') === fname)?.[1];
          item[fname] = ftype === 'Number' ? (Number.isFinite(Number(raw)) ? Number(raw) : 0) : ftype === 'Boolean' ? Boolean(raw) : String(raw ?? '');
        }
        return item;
      });
      values.push({ name, type, fields, sample: items, ...some('about', words(v?.about)) });
    } else {
      const s = type === 'Number' ? (Number.isFinite(Number(sample)) ? Number(sample) : 0) : type === 'Boolean' ? Boolean(sample) : String(sample ?? '');
      values.push({ name, type, sample: s, ...some('about', words(v?.about)) });
    }
  }

  const actions: SpecAction[] = [];
  for (const a of Array.isArray(rawActions) ? rawActions.slice(0, 12) : []) {
    const name = ident(a?.name, `action${actions.length + 1}`);
    if (actions.some((x) => x.name === name) || values.some((x) => x.name === name)) continue;
    const inputs = (Array.isArray(a?.inputs) ? a.inputs : []).slice(0, 4).map((i: any) => ({ name: ident(i?.name, 'input'), type: ['Number', 'Boolean'].includes(i?.type) ? i.type : 'String' }))
      .filter((i: { name: string }, at: number, all: { name: string }[]) => all.findIndex((x) => x.name === i.name) === at);
    actions.push({ name, inputs, reply: words(a?.reply, 200) ?? 'Done.', ...some('about', words(a?.about)) });
  }

  // Pages, and the sections on them, keeping only references that exist.
  const rawPages = (Array.isArray(r.pages) ? r.pages : []).slice(0, 6);
  const files: string[] = [];
  for (const p of rawPages) {
    let file = slug(p?.file ?? p?.name, `page${files.length + 1}`);
    while (files.includes(file)) file = `${file}-2`;
    files.push(file);
  }
  if (!files.length) throw new Error('The project has no pages.');
  const value = (n: unknown) => values.find((v) => v.name === ident(n, '_'));
  const action = (n: unknown) => actions.find((a) => a.name === ident(n, '_'));
  const button = (label: unknown, act: unknown, goTo: unknown): SpecButton | undefined => {
    const text = words(label, 40);
    if (!text) return undefined;
    const run = act ? action(act) : undefined;
    if (run) return { label: text, action: run.name };
    const to = goTo ? slug(goTo, '') : '';
    return files.includes(to) ? { label: text, goTo: to } : { label: text };
  };
  const pages: SpecPage[] = rawPages.map((p: any, at: number) => {
    const sections: SpecSection[] = [];
    for (const s of (Array.isArray(p?.sections) ? p.sections : []).slice(0, 8)) {
      const b = s?.button ?? {};
      const btn = button(s?.buttonLabel ?? b.label, s?.buttonAction ?? b.action, s?.buttonGoTo ?? b.goTo);
      switch (s?.kind) {
        case 'hero': { const title = words(s.title, 120); if (title) sections.push({ kind: 'hero', title, ...some('subtitle', words(s.subtitle, 240)), ...(btn ? { button: btn } : {}) }); break; }
        case 'text': { const body = words(s.body, 1200); if (body) sections.push({ kind: 'text', body, ...some('heading', words(s.heading, 120)) }); break; }
        case 'list': {
          const list = value(s.list);
          if (list?.type !== 'List' || !list.fields) break;
          const field = (n: unknown) => Object.keys(list.fields!).find((f) => f === ident(n, '_'));
          const show = field(s.show) ?? Object.keys(list.fields).find((f) => list.fields![f] === 'String') ?? Object.keys(list.fields)[0]!;
          const detail = field(s.detail);
          sections.push({ kind: 'list', list: list.name, show, ...(detail && detail !== show ? { detail } : {}), ...some('heading', words(s.heading, 120)), ...(btn ? { button: btn } : {}) });
          break;
        }
        case 'stat': { const v = value(s.value); if (v && v.type !== 'List') sections.push({ kind: 'stat', label: words(s.label, 60) ?? v.name, value: v.name }); break; }
        case 'form': {
          const run = action(s.submitAction ?? s.submit?.action);
          const fields = (Array.isArray(s.fields) ? s.fields : []).slice(0, 6).map((f: any) => ({ name: ident(f?.name, 'field'), label: words(f?.label, 60) ?? String(f?.name ?? 'Field'), type: ['email', 'multiline'].includes(f?.type) ? f.type : 'text' }));
          if (run && fields.length) sections.push({ kind: 'form', fields, submit: { label: words(s.submitLabel ?? s.submit?.label, 40) ?? 'Send', action: run.name }, ...some('heading', words(s.heading, 120)) });
          break;
        }
      }
    }
    const file = files[at]!;
    return { file, name: words(p?.name, 60) ?? file, route: at === 0 ? '/' : `/${file}`, sections };
  }).filter((p: SpecPage) => p.sections.length);
  if (!pages.length) throw new Error('None of the pages had anything on them.');

  return {
    name: words(r.name, 60) ?? 'New project',
    theme: THEME_IDS.includes(r.theme) ? r.theme : 'clean',
    pages,
    logic: { values, actions },
  };
}

// ---------------------------------------------------------------- building it

/** The builders from the `.vi` and `.ui` packages, handed in so this file needs neither. */
export interface ProjectBuilders {
  logic: (logic: ProjectSpec['logic']) => string;
  page: (page: SpecPage, logic: { file: string; values: SpecValue[]; actions: SpecAction[] }, others: SpecPage[], theme: ThemeId) => string;
}

/** Every file of the project, by path: `pages/home.ui`, `logic/main.vi`, and a README. */
export function projectFiles(spec: ProjectSpec, build: ProjectBuilders): Record<string, string> {
  const files: Record<string, string> = {};
  const hasLogic = spec.logic.values.length > 0 || spec.logic.actions.length > 0;
  if (hasLogic) files['logic/main.vi'] = build.logic(spec.logic);
  const logic = { file: '../logic/main.vi', values: spec.logic.values, actions: spec.logic.actions };
  for (const page of spec.pages) {
    files[`pages/${page.file}.ui`] = build.page(page, logic, spec.pages.filter((p) => p !== page), spec.theme);
  }
  files['README.md'] = [
    `# ${spec.name}`, '',
    'A Vibez project. Open any page in `pages/` to edit it on the site canvas, and `logic/main.vi` for what the pages show and do.', '',
    '## Pages', ...spec.pages.map((p) => `- \`pages/${p.file}.ui\` — ${p.name}`), '',
    ...(hasLogic ? ['## Logic', ...spec.logic.values.map((v) => `- ${v.name} (${v.type})${v.about ? ` — ${v.about}` : ''}`), ...spec.logic.actions.map((a) => `- ${a.name}() — ${a.about ?? a.reply}`), ''] : []),
  ].join('\n');
  return files;
}

// ---------------------------------------------------------------- templates

/** Ready-made starting points, written in the same form Grok answers in. */
export const PROJECT_TEMPLATES: { id: string; name: string; description: string; spec: ProjectSpec }[] = [
  {
    id: 'blank', name: 'Blank', description: 'One empty page and an empty logic file.',
    spec: { name: 'New project', theme: 'clean', pages: [{ file: 'home', name: 'Home', route: '/', sections: [{ kind: 'hero', title: 'A new page', subtitle: 'Double-click anything to change it.' }] }], logic: { values: [], actions: [] } },
  },
  {
    id: 'shop', name: 'Shop', description: 'Products from page data, an Add to cart button, and a cart page.',
    spec: {
      name: 'Shop', theme: 'paper',
      pages: [
        { file: 'home', name: 'Shop', route: '/', sections: [
          { kind: 'hero', title: 'Small-batch goods', subtitle: 'Made by hand, shipped in a day.', button: { label: 'See your cart', goTo: 'cart' } },
          { kind: 'list', heading: 'This week', list: 'products', show: 'name', detail: 'price', button: { label: 'Add to cart', action: 'addToCart' } },
        ] },
        { file: 'cart', name: 'Cart', route: '/cart', sections: [
          { kind: 'stat', label: 'Items in your cart', value: 'cartCount' },
          { kind: 'hero', title: 'Ready when you are', button: { label: 'Place order', action: 'placeOrder' } },
        ] },
      ],
      logic: {
        values: [
          { name: 'products', type: 'List', fields: { name: 'String', price: 'Number' }, sample: [{ name: 'Linen apron', price: 38 }, { name: 'Ash cutting board', price: 54 }, { name: 'Stoneware mug', price: 24 }] },
          { name: 'cartCount', type: 'Number', sample: 0 },
        ],
        actions: [
          { name: 'addToCart', inputs: [{ name: 'name', type: 'String' }], reply: 'Added {name} to your cart.' },
          { name: 'placeOrder', inputs: [], reply: 'Order placed — thank you!' },
        ],
      },
    },
  },
  {
    id: 'portfolio', name: 'Portfolio', description: 'Your work as a list of projects, an about page, and a contact form.',
    spec: {
      name: 'Portfolio', theme: 'mono',
      pages: [
        { file: 'home', name: 'Work', route: '/', sections: [
          { kind: 'hero', title: 'I design and build things for the web', subtitle: 'Selected work, 2024–2026.', button: { label: 'Get in touch', goTo: 'contact' } },
          { kind: 'list', heading: 'Projects', list: 'projects', show: 'title', detail: 'summary' },
        ] },
        { file: 'about', name: 'About', route: '/about', sections: [{ kind: 'text', heading: 'About me', body: 'I’m a designer and developer who likes small teams, clear writing and fast websites.' }] },
        { file: 'contact', name: 'Contact', route: '/contact', sections: [
          { kind: 'form', heading: 'Say hello', fields: [{ name: 'email', label: 'Your email', type: 'email' }, { name: 'message', label: 'Message', type: 'multiline' }], submit: { label: 'Send', action: 'sendMessage' } },
        ] },
      ],
      logic: {
        values: [{ name: 'projects', type: 'List', fields: { title: 'String', summary: 'String' }, sample: [{ title: 'Tidewater', summary: 'Booking for a kayak outfitter.' }, { title: 'Ledger', summary: 'A budgeting app for freelancers.' }, { title: 'Fieldnotes', summary: 'A field guide to local birds.' }] }],
        actions: [{ name: 'sendMessage', inputs: [{ name: 'email', type: 'String' }, { name: 'message', type: 'String' }], reply: 'Thanks — I’ll write back to {email} soon.' }],
      },
    },
  },
  {
    id: 'landing', name: 'Landing page', description: 'A launch page with features and a waitlist signup.',
    spec: {
      name: 'Launch', theme: 'playful',
      pages: [{ file: 'home', name: 'Home', route: '/', sections: [
        { kind: 'hero', title: 'The simplest way to plan a trip with friends', subtitle: 'One link, everyone’s dates, no group chat.' },
        { kind: 'list', heading: 'What it does', list: 'features', show: 'title', detail: 'body' },
        { kind: 'form', heading: 'Join the waitlist', fields: [{ name: 'email', label: 'Email', type: 'email' }], submit: { label: 'Join', action: 'joinWaitlist' } },
      ] }],
      logic: {
        values: [{ name: 'features', type: 'List', fields: { title: 'String', body: 'String' }, sample: [{ title: 'Pick dates together', body: 'Everyone marks when they’re free.' }, { title: 'Split costs', body: 'See who owes what as you go.' }, { title: 'One itinerary', body: 'Plans, bookings and maps in one place.' }] }],
        actions: [{ name: 'joinWaitlist', inputs: [{ name: 'email', type: 'String' }], reply: 'You’re on the list, {email}!' }],
      },
    },
  },
];
