#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { posix, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  TEMPLATES, THEMES, brokenLinks, compile, find, slotOf, valueChoices, actionChoices, pageInputs, serialize,
  type UiDoc, type ViAction, type ViValue,
} from '../../ui/src/index.ts';
import type { Graph } from '../../core/src/index.ts';
import { compileFile, parseDoc as parseViDoc } from '../../vi/src/index.ts';
import { Workspace, VibezError, titleFrom } from './workspace.ts';
import { outlinePage, summarizePage, outlineExports, formatValue, formatAction } from './notation.ts';
import { applyOps, type Op } from './edit.ts';
import { reference } from './reference.ts';
import { outlineFlow } from './flows.ts';

/**
 * The Vibez MCP server: how an AI agent reads and edits a Vibez app in
 * Vibez's own terms.
 *
 * Pages are read as outlines and changed with the same moves a person makes
 * in the editor, checked the same way, so an agent cannot write a page the
 * editor would not accept: no unknown properties, no list wired into a
 * heading, no action that nothing offers. Every refusal says what would work
 * instead. The editor watches the files, so an agent's change shows up on the
 * canvas as it lands, and is one ⌘Z away.
 */

const VALUE_TYPES = ['String', 'Number', 'Boolean', 'Url', 'Date', 'Object', 'List'] as const;

/** Where a `.vi` file's compiled module lands — flat by basename, the same convention the editor's own build output and `.ui`'s `.vibez/build/<name>.html` already use. */
const buildPathFor = (relativeVi: string): string => posix.join('.vibez', 'build', `${basename(relativeVi, '.vi')}.vi.js`);

type Reply = { content: { type: 'text'; text: string }[]; isError?: boolean };
const say = (text: string): Reply => ({ content: [{ type: 'text', text }] });
const refuse = (text: string): Reply => ({ content: [{ type: 'text', text }], isError: true });

/** Run a tool body, turning a refusal into an answer the agent can act on. */
async function guard(body: () => Promise<Reply>): Promise<Reply> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof VibezError) return refuse(error.message);
    return refuse(`Something went wrong: ${(error as Error).message}`);
  }
}

const opSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    element: z.string().describe('stack, row, grid, card, title, text, divider, button, input, link, image or gallery'),
    parent: z.string().optional().describe('Id of the frame to add into, or $name from earlier in the batch. Defaults to "page".'),
    index: z.number().int().min(0).optional().describe('Position among the parent\'s children; 0 is first. Defaults to the end.'),
    as: z.string().optional().describe('A name for the new element, to refer to later in this batch as $name.'),
    props: z.record(z.string(), z.unknown()).optional().describe('Settings for the element; see vibez_reference.'),
  }),
  z.object({ op: z.literal('set'), id: z.string(), props: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('move'), id: z.string(), parent: z.string(), index: z.number().int().min(0).optional() }),
  z.object({ op: z.literal('remove'), id: z.string() }),
  z.object({ op: z.literal('duplicate'), id: z.string(), as: z.string().optional() }),
  z.object({ op: z.literal('wrap'), id: z.string(), direction: z.enum(['stack', 'column', 'row']).optional(), as: z.string().optional() }),
  z.object({ op: z.literal('page'), props: z.record(z.string(), z.unknown()).describe('name, route and/or theme') }),
]);

const valueSchema = z.object({
  name: z.string(),
  type: z.enum(VALUE_TYPES),
  fields: z.record(z.string(), z.enum(VALUE_TYPES)).optional().describe('For a List or Object: the fields of one item.'),
  sample: z.unknown().optional().describe('Realistic example data. The canvas and compiled page show it until the real value is served.'),
  about: z.string().optional(),
});

const actionSchema = z.object({
  name: z.string(),
  inputs: z.array(z.object({ name: z.string(), type: z.enum(VALUE_TYPES) })).default([]),
  returns: z.enum(VALUE_TYPES).optional(),
  about: z.string().optional(),
});

export function createVibezServer(root: string): McpServer {
  const ws = new Workspace(root);
  const server = new McpServer(
    { name: 'vibez', version: '0.1.0' },
    {
      instructions: 'Vibez apps are .ui pages (visual layout) and .vi files (logic, exposing values and actions). '
        + 'Call vibez_overview first, vibez_reference for the vocabulary, ui_read before editing a page, and ui_edit to change it. '
        + 'Pages reference .vi exports as file.vi#name; declare missing data with vi_declare.',
    },
  );

  /** Other pages, as the page at `pagePath` refers to them. */
  const pagesFrom = async (pagePath: string): Promise<string[]> =>
    (await ws.find(['.ui'])).filter((p) => p !== pagePath).map((p) => posix.relative(posix.dirname(pagePath), p));

  // ---------------------------------------------------------- orientation

  server.registerTool('vibez_overview', {
    title: 'Overview of the Vibez project',
    description: 'Lists every .ui page, every .vi file with what it offers, and every recorded flow. Start here.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => guard(async () => {
    const lines = [`Vibez project at ${ws.root}`, ''];
    const pages = await ws.find(['.ui']);
    lines.push(`pages (${pages.length}):`);
    for (const page of pages) {
      try {
        lines.push(`  ${summarizePage(page, await ws.readPage(page))}`);
      } catch (error) {
        lines.push(`  ${page} · cannot be read: ${(error as Error).message}`);
      }
    }
    const vis = await ws.find(['.vi']);
    lines.push('', `.vi files (${vis.length}):`);
    for (const vi of vis) {
      try {
        const { exports } = await ws.readExports(vi);
        lines.push(`  ${vi} · values ${exports.values.map((v) => v.name).join(', ') || 'none'} · actions ${exports.actions.map((a) => a.name).join(', ') || 'none'}`);
      } catch (error) {
        lines.push(`  ${vi} · cannot be read: ${(error as Error).message}`);
      }
    }
    const flows = (await ws.find(['.flow'])).filter((f) => f.startsWith('.vibez/'));
    lines.push('', `recorded flows (${flows.length}):`);
    for (const flow of flows) {
      try {
        const graph = JSON.parse(await ws.read(flow)) as Graph;
        lines.push(`  ${flow} · ${graph.flow} · ${graph.nodes.length} steps · ${Math.round(graph.rootTotalMs)} ms per run over ${graph.runs} runs`);
      } catch {
        lines.push(`  ${flow} · cannot be read`);
      }
    }
    if (pages.length === 0 && vis.length === 0) lines.push('', 'Nothing yet. Make a page with ui_create.');
    return say(lines.join('\n'));
  }));

  server.registerTool('vibez_reference', {
    title: 'Vibez vocabulary',
    description: 'Elements, their properties, tokens, themes, how links to .vi files are written, and the ui_edit operations. Read once before editing.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => guard(async () => say(reference())));

  server.registerResource('reference', 'vibez://reference', {
    title: 'Vibez vocabulary',
    description: 'How .ui pages and .vi exports are written, for agents.',
    mimeType: 'text/markdown',
  }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: reference() }] }));

  // ---------------------------------------------------------- pages

  server.registerTool('ui_read', {
    title: 'Read a page',
    description: 'A .ui page as an outline: one element per line with its id, what it is, its settings that differ from the defaults, and what it is connected to (with sample values).',
    inputSchema: {
      path: z.string().describe('Path of the .ui file, relative to the project folder.'),
      json: z.boolean().optional().describe('Also return the raw JSON of the page.'),
    },
    annotations: { readOnlyHint: true },
  }, ({ path, json }) => guard(async () => {
    const doc = await ws.readPage(path);
    const outline = outlinePage(path, doc, await ws.linkedFor(path));
    return say(json ? `${outline}\n\n${serialize(doc)}` : outline);
  }));

  server.registerTool('ui_create', {
    title: 'Create a page',
    description: `Makes a new .ui page from a template: ${TEMPLATES.map((t) => `${t.id} (${t.hint.toLowerCase()})`).join(', ')}.`,
    inputSchema: {
      path: z.string().describe('Where to create it, like pages/pricing.ui.'),
      template: z.enum(TEMPLATES.map((t) => t.id) as [string, ...string[]]).optional().describe('Defaults to blank.'),
      name: z.string().optional().describe('The page title. Defaults to one made from the file name.'),
      route: z.string().optional().describe('The address it is served at. Defaults to /<file name>.'),
      theme: z.enum(THEMES.map((t) => t.id) as [string, ...string[]]).optional(),
    },
  }, ({ path, template, name, route, theme }) => guard(async () => {
    if (!path.endsWith('.ui')) throw new VibezError(`${path} must end in .ui.`);
    if (await ws.exists(path)) throw new VibezError(`${path} already exists. Read it with ui_read and change it with ui_edit.`);
    const chosen = TEMPLATES.find((t) => t.id === (template ?? 'blank'))!;
    const slug = basename(path, '.ui');
    let doc: UiDoc = chosen.make(name ?? titleFrom(path), route ?? `/${slug}`);
    if (theme) doc = { ...doc, theme };
    await ws.writePage(path, doc);
    return say(`Created ${path} from the ${chosen.name} template.\n\n${outlinePage(path, doc, await ws.linkedFor(path))}`);
  }));

  server.registerTool('ui_edit', {
    title: 'Edit a page',
    description: 'Applies a batch of operations (add, set, move, remove, duplicate, wrap, page) to a .ui page, all or nothing. '
      + 'Every property and link is checked; a refusal says what would fit. Returns what changed and the new outline. '
      + 'Name new elements with "as" and use them later in the batch as $name.',
    inputSchema: {
      path: z.string().describe('Path of the .ui file.'),
      ops: z.array(opSchema).min(1).describe('Operations, applied in order.'),
    },
  }, ({ path, ops }) => guard(async () => {
    const doc = await ws.readPage(path);
    const linked = await ws.linkedFor(path);
    const result = applyOps(doc, ops as Op[], { linked, pages: await pagesFrom(path) });
    await ws.writePage(path, result.doc);
    const names = Object.entries(result.created);
    const broken = brokenLinks(result.doc, linked);
    return say([
      `Changed ${path}:`,
      ...result.log.map((line) => `  - ${line}`),
      ...(names.length ? ['', `new ids: ${names.map(([k, v]) => `${k} = ${v}`).join(', ')}`] : []),
      ...(broken.length ? ['', `broken links: ${broken.map((b) => `${b.id} (${b.what})`).join('; ')}`] : []),
      '',
      outlinePage(path, result.doc, linked),
    ].join('\n'));
  }));

  server.registerTool('ui_options', {
    title: 'What an element can connect to',
    description: 'For one element on a page: the .vi values it can show or repeat over (with samples), the actions it can run, the page inputs available as arguments, and the pages it can link to.',
    inputSchema: {
      path: z.string(),
      id: z.string().describe('The element id from ui_read.'),
    },
    annotations: { readOnlyHint: true },
  }, ({ path, id }) => guard(async () => {
    const doc = await ws.readPage(path);
    const hit = find(doc, id);
    if (!hit) throw new VibezError(`There is no element with id ${id} on ${path}.`);
    const linked = await ws.linkedFor(path);
    const node = hit.node;
    const lines = [`${id} is a ${node.kind}.`];
    const slot = slotOf(node);
    const sample = (v: unknown) => v === undefined ? '' : ` = ${JSON.stringify(v).slice(0, 60)}`;
    if (slot) {
      const choices = valueChoices(doc, id, slot, linked);
      lines.push('', `shows (set props.shows):`, ...(choices.length ? choices.map((c) => `  ${formatValue(c.ref)} : ${c.type}${sample(c.sample)}`) : ['  nothing fits yet']));
      if (slot === 'text' && pageInputs(doc).length) lines.push(...pageInputs(doc).map((f) => `  input.${f} : what was typed`));
    }
    if (node.kind === 'frame') {
      const lists = valueChoices(doc, id, 'repeat', linked);
      lines.push('', 'repeat (set props.repeat):', ...(lists.length ? lists.map((c) => `  ${formatValue(c.ref)} : List${Array.isArray(c.sample) ? ` of ${c.sample.length} samples` : ''}`) : ['  no lists yet']));
    }
    if (node.kind === 'button' || node.kind === 'frame' || node.kind === 'input') {
      const actions = actionChoices(linked);
      lines.push('', `${node.kind === 'input' ? 'onEnter' : 'onClick'}:`,
        ...actions.map((a) => `  ${formatAction(a.ref)}(${a.inputs.map((i) => `${i.name}: ${i.type}`).join(', ')})`),
        ...(await pagesFrom(path)).map((p) => `  go:${p}`));
      if (actions.length + (await pagesFrom(path)).length === 0) lines.push('  nothing yet');
      lines.push('', `page inputs for args: ${pageInputs(doc).map((f) => `input.${f}`).join(', ') || 'none'}`);
    }
    if (!slot && node.kind !== 'frame' && node.kind !== 'button' && node.kind !== 'input') lines.push('It does not connect to anything.');
    return say(lines.join('\n'));
  }));

  server.registerTool('ui_build', {
    title: 'Compile a page',
    description: 'Compiles a .ui page to one self-contained HTML file in .vibez/build/ and reports any broken links.',
    inputSchema: { path: z.string() },
  }, ({ path }) => guard(async () => {
    const doc = await ws.readPage(path);
    const linked = await ws.linkedFor(path);
    const routes: Record<string, string> = {};
    for (const page of await ws.find(['.ui'])) routes[posix.relative(posix.dirname(path), page)] = `./${basename(page, '.ui')}.html`;
    const out = `.vibez/build/${basename(path, '.ui')}.html`;
    await ws.write(out, compile(doc, { linked, routes }));
    const broken = brokenLinks(doc, linked);
    return say(`Compiled ${path} to ${out}.${broken.length ? `\nBroken links: ${broken.map((b) => `${b.id} (${b.what})`).join('; ')}` : '\nNo broken links.'}`);
  }));

  // ---------------------------------------------------------- .vi

  server.registerTool('vi_read', {
    title: 'Read what a .vi file offers',
    description: 'The values and actions a .vi file exports, with types, fields and samples, written the way pages refer to them.',
    inputSchema: { path: z.string() },
    annotations: { readOnlyHint: true },
  }, ({ path }) => guard(async () => {
    const { exports, raw } = await ws.readExports(path);
    return say(outlineExports(path, exports, Object.keys(raw)));
  }));

  server.registerTool('vi_declare', {
    title: 'Declare .vi exports',
    description: 'Adds or replaces values and actions in a .vi file\'s exports block (creating the file if needed) and removes ones by name. '
      + 'Only the exports block is touched; the rest of the file belongs to the graph editor. Give every value a realistic sample.',
    inputSchema: {
      path: z.string().describe('Path of the .vi file, like pages/dashboard.vi.'),
      values: z.array(valueSchema).optional(),
      actions: z.array(actionSchema).optional(),
      remove: z.array(z.string()).optional().describe('Names of values or actions to remove.'),
    },
  }, ({ path, values, actions, remove }) => guard(async () => {
    if (!path.endsWith('.vi')) throw new VibezError(`${path} must end in .vi.`);
    const existing = await ws.exists(path);
    const raw: Record<string, unknown> = existing ? (await ws.readExports(path)).raw : { vibez: 'vi/0' };
    const block = (raw['exports'] ?? {}) as { values?: ViValue[]; actions?: ViAction[] };
    let nextValues = [...(block.values ?? [])];
    let nextActions = [...(block.actions ?? [])];
    const log: string[] = [];
    for (const value of values ?? []) {
      if (!/^[A-Za-z_]\w*$/.test(value.name)) throw new VibezError(`"${value.name}" is not a usable name: letters, numbers and _ only.`);
      if ((value.type === 'List' || value.type === 'Object') && value.sample !== undefined
        && (value.type === 'List') !== Array.isArray(value.sample)) {
        throw new VibezError(`The sample for ${value.name} should be ${value.type === 'List' ? 'a list' : 'an object'}.`);
      }
      const at = nextValues.findIndex((v) => v.name === value.name);
      log.push(`${at >= 0 ? 'replaced' : 'added'} value ${path}#${value.name}: ${value.type}`);
      const clean = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as unknown as ViValue;
      if (at >= 0) nextValues[at] = clean; else nextValues.push(clean);
    }
    for (const action of actions ?? []) {
      if (!/^[A-Za-z_]\w*$/.test(action.name)) throw new VibezError(`"${action.name}" is not a usable name: letters, numbers and _ only.`);
      const at = nextActions.findIndex((a) => a.name === action.name);
      log.push(`${at >= 0 ? 'replaced' : 'added'} action ${path}#${action.name}(${action.inputs.map((i) => i.name).join(', ')})`);
      const clean = Object.fromEntries(Object.entries(action).filter(([, v]) => v !== undefined)) as unknown as ViAction;
      if (at >= 0) nextActions[at] = clean; else nextActions.push(clean);
    }
    for (const name of remove ?? []) {
      const before = nextValues.length + nextActions.length;
      nextValues = nextValues.filter((v) => v.name !== name);
      nextActions = nextActions.filter((a) => a.name !== name);
      log.push(before === nextValues.length + nextActions.length ? `${name} was not declared` : `removed ${path}#${name}`);
    }
    raw['exports'] = { ...block, values: nextValues, actions: nextActions };
    await ws.write(path, `${JSON.stringify(raw, null, 2)}\n`);

    // Say which pages now point at something that is gone.
    const broken: string[] = [];
    for (const page of await ws.find(['.ui'])) {
      try {
        const doc = await ws.readPage(page);
        for (const b of brokenLinks(doc, await ws.linkedFor(page))) broken.push(`${page} ${b.id}: ${b.what}`);
      } catch {
        // Unreadable pages are reported by vibez_overview.
      }
    }
    return say([
      `${existing ? 'Updated' : 'Created'} ${path}:`,
      ...log.map((l) => `  - ${l}`),
      ...(broken.length ? ['', 'pages with broken links now:', ...broken.map((b) => `  ${b}`)] : []),
      '',
      outlineExports(path, { values: nextValues, actions: nextActions }, Object.keys(raw)),
    ].join('\n'));
  }));

  server.registerTool('vi_run', {
    title: 'Test .vi logic',
    description: 'Compiles a .vi file for real and runs one value, action or function directly — no page, no browser, no server to start. '
      + 'The fastest way to check logic while building it. Refuses with the exact reason if the block isn\'t connected properly yet.',
    inputSchema: {
      path: z.string().describe('Path of the .vi file, like pages/dashboard.vi.'),
      export: z.string().describe('The value, action or function name to test.'),
      args: z.record(z.string(), z.unknown()).optional().describe('Named inputs, for an action that takes them.'),
    },
  }, ({ path, export: exportName, args }) => guard(async () => {
    if (!path.endsWith('.vi')) throw new VibezError(`${path} must end in .vi.`);
    const parsed = parseViDoc(await ws.read(path));
    if (!parsed.ok) throw new VibezError(`${path}: ${parsed.reason}`);
    const doc = parsed.doc;
    const value = doc.exports.values.find((v) => v.name === exportName);
    const action = [...doc.exports.actions, ...(doc.functions ?? [])].find((a) => a.name === exportName);
    if (!value && !action) {
      throw new VibezError(`${path} has no value or action called ${exportName}. It offers: ${[...doc.exports.values, ...doc.exports.actions].map((e) => e.name).join(', ') || 'nothing yet'}.`);
    }

    // Compile every dependency against the same snapshot and run in a fresh
    // process. This prevents stale ESM imports and keeps console.log off MCP stdio.
    const sources = [{ path, doc }];
    for (const other of (await ws.find(['.vi'])).filter(p => p !== path)) {
      const parsed = parseViDoc(await ws.read(other));
      if (!parsed.ok) throw new VibezError(`${other}: ${parsed.reason}`);
      sources.push({ path: other, doc: parsed.doc });
    }
    const names = sources.map(source => basename(source.path));
    if (new Set(names).size !== names.length) throw new VibezError('Logic files must have unique filenames in the shared build folder.');
    const build = `.vibez/build/test-${randomUUID()}`;
    try {
      await ws.write(`${build}/package.json`, '{"type":"module","private":true}');
      let warnings: string[] = [];
      for (const source of sources) {
        const siblings = new Map(sources.filter(other => other !== source).map(other => [posix.relative(posix.dirname(source.path), other.path), [...other.doc.exports.actions, ...(other.doc.functions ?? [])]]));
        const result = compileFile(source.doc.exports.values, source.doc.exports.actions, source.doc.logic, siblings, file => `./${basename(file, '.vi')}.vi.js`, source.doc.functions ?? [], source.doc.helpers ?? {}, source.doc.variables ?? []);
        if (source.path === path) {
          const issues = result.issues.filter(issue => issue.exportName === exportName);
          const errors = issues.filter(issue => issue.severity === 'error');
          if (errors.length) throw new VibezError(`${exportName} isn't ready to run:\n${errors.map(error => error.message).join('\n')}`);
          warnings = issues.filter(issue => issue.severity === 'warning').map(issue => issue.message);
        }
        await ws.write(`${build}/${basename(source.path, '.vi')}.vi.js`, result.code);
      }
      const target = pathToFileURL(ws.path(`${build}/${basename(path, '.vi')}.vi.js`)).href;
      const kind = value ? 'values' : doc.exports.actions.some(a => a.name === exportName) ? 'actions' : 'functions';
      const callArgs = (action?.inputs ?? []).map(input => (args ?? {})[input.name]);
      const runner = `const mod = await import(${JSON.stringify(target)}); const fn = mod.__vibezTest[${JSON.stringify(kind)}][${JSON.stringify(exportName)}]; const result = await fn(...${JSON.stringify(callArgs)}); console.log(${JSON.stringify(exportName + ' -> ')} + (JSON.stringify(result, null, 2) ?? 'undefined'));`;
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', runner], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      return say([stdout.trim(), stderr.trim(), ...warnings.map(warning => `Warning: ${warning}`)].filter(Boolean).join('\n'));
    } catch (error) {
      if (error instanceof VibezError) throw error;
      return refuse(`${exportName} could not finish: ${(error as Error).message}`);
    } finally {
      await rm(ws.path(build), { recursive: true, force: true });
    }
  }));

  // ---------------------------------------------------------- flows

  server.registerTool('flow_read', {
    title: 'Read a recorded flow',
    description: 'What actually ran when the app was used: each step in order with its time, how often it ran, whether it is on the critical path, and problems Vibez noticed (like an N+1 query), with the fix.',
    inputSchema: { path: z.string().optional().describe('Defaults to .vibez/flows/default.flow.') },
    annotations: { readOnlyHint: true },
  }, ({ path }) => guard(async () => {
    const file = path ?? '.vibez/flows/default.flow';
    if (!(await ws.exists(file))) throw new VibezError(`There is no recorded flow at ${file}. Flows appear once the app runs inside Vibez.`);
    return say(outlineFlow(file, JSON.parse(await ws.read(file)) as Graph));
  }));

  return server;
}

// ------------------------------------------------------------ stdio

function rootFromArgs(argv: string[]): string {
  const at = argv.indexOf('--root');
  if (at >= 0 && argv[at + 1]) return argv[at + 1]!;
  return process.env['VIBEZ_ROOT'] ?? process.cwd();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = rootFromArgs(process.argv.slice(2));
  const server = createVibezServer(root);
  await server.connect(new StdioServerTransport());
  console.error(`vibez mcp ready for ${root}`);
}
