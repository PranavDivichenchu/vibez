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
import { compileFile, matches, parseDoc as parseViDoc, serialize as serializeVi, type ViDoc } from '../../vi/src/index.ts';
import { Workspace, VibezError, titleFrom } from './workspace.ts';
import { outlinePage, summarizePage, formatValue, formatAction } from './notation.ts';
import { applyOps, type Op } from './edit.ts';
import { reference } from './reference.ts';
import { outlineFlow } from './flows.ts';
import { applyLogicOps, blocksFor, compileIssues, contextFor, locate, outlineGraph, outlineLogic, VI_TYPES, type LogicOp, type Siblings } from './logic.ts';
import { addPage, applySiteOps, deletePage, htmlFiles, library, outlineHtml, siteMap, type SiteOp } from './site.ts';
import { registerTeamTools } from './teamTools.ts';

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

const viType = z.enum(VI_TYPES);
const logicOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('declare'),
    what: z.enum(['value', 'action', 'function', 'variable']).describe('value = page data; action = something a page runs; function = reusable logic; variable = shared state'),
    name: z.string(),
    type: viType.optional().describe('For a value or variable.'),
    fields: z.record(z.string(), viType).optional().describe('For a List or Object value: the fields of one item.'),
    sample: z.unknown().optional().describe('For a value: realistic example data the page shows before the logic runs.'),
    inputs: z.array(z.object({ name: z.string(), type: viType })).optional().describe('For an action or function.'),
    returns: viType.optional().describe('For an action or function.'),
    mutable: z.boolean().optional().describe('For a variable: whether graphs may Set it. Defaults to true.'),
    initial: z.unknown().optional().describe('For a variable: its starting value.'),
    about: z.string().optional(),
  }),
  z.object({ op: z.literal('rename'), name: z.string(), to: z.string() }),
  z.object({ op: z.literal('remove'), name: z.string() }),
  z.object({
    op: z.literal('add'),
    graph: z.string().describe('The value, action or function to add the block to.'),
    block: z.string().describe('The block\'s name as vi_blocks shows it, like "Divide (÷)", "If / Else", "Get CompanyName", "Print to Console".'),
    as: z.string().optional().describe('A name for the new block, to use later in this batch as $name.'),
    config: z.record(z.string(), z.unknown()).optional().describe('Settings, like { "value": 4, "type": "Number" } for a Value block.'),
  }),
  z.object({ op: z.literal('set'), graph: z.string(), id: z.string(), config: z.record(z.string(), z.unknown()) }),
  z.object({ op: z.literal('connect'), graph: z.string(), from: z.string().describe('block.port of an output, like entry-1a.exec:out or $div.result'), to: z.string().describe('block.port of an input, like return-2b.value') }),
  z.object({ op: z.literal('disconnect'), graph: z.string(), to: z.string().describe('block.port of the input to clear') }),
  z.object({ op: z.literal('delete'), graph: z.string(), id: z.string(), keepFlow: z.boolean().optional().describe('Join what ran before and after it. Defaults to true.') }),
]);

const siteOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('text'), at: z.number().int(), text: z.string() }),
  z.object({ op: z.literal('style'), at: z.number().int(), style: z.record(z.string(), z.string().nullable()).describe('CSS properties to set; null removes one.') }),
  z.object({ op: z.literal('attr'), at: z.number().int(), name: z.string(), value: z.string().nullable() }),
  z.object({ op: z.literal('remove'), at: z.number().int() }),
  z.object({ op: z.literal('move'), at: z.number().int(), target: z.number().int(), where: z.enum(['before', 'after', 'inside']) }),
  z.object({ op: z.literal('add'), element: z.string().describe('Element id from site_library, like "button" or "contact-form".'), target: z.number().int().optional(), where: z.enum(['before', 'after', 'inside']).optional() }),
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

/**
 * What a page edit touches, as the team names it: page.ui#element for each
 * element changed, moved, removed or added (new elements by their new id),
 * or the whole page when its own settings change. Claims this narrow let two
 * agents work on different parts of one page, warned but not in each other's way.
 */
function touchedOnPage(path: string, ops: Op[], created: Record<string, string>): string[] {
  if (ops.some((op) => op.op === 'page')) return [path];
  const ids = new Set<string>();
  for (const op of ops) {
    if ('id' in op && op.id) ids.add(op.id);
  }
  for (const id of Object.values(created)) ids.add(id);
  const named = [...ids].filter((id) => !id.startsWith('$') && id !== 'page');
  return named.length ? named.map((id) => `${path}#${id}`) : [path];
}

const finishers = new WeakMap<McpServer, () => Promise<void>>();

/** Ends a server's session on the team (its claims are released), then closes it. */
export async function closeVibezServer(server: McpServer): Promise<void> {
  await finishers.get(server)?.();
  await server.close();
}

export function createVibezServer(root: string): McpServer {
  const ws = new Workspace(root);
  const server = new McpServer(
    { name: 'vibez', version: '0.1.0' },
    {
      instructions: 'Vibez apps are .ui pages (visual layout), .vi files (logic drawn as graphs, exposing values and actions to pages), '
        + 'and plain HTML pages. Call vibez_overview first and vibez_reference for the vocabulary. '
        + 'Pages: ui_read then ui_edit. Logic: vi_read, vi_blocks, then vi_edit, and vi_run to test. HTML: site_map, site_read, then site_edit. '
        + 'Pages reference .vi exports as file.vi#name. '
        + 'On a team project, other people\'s agents may be working too: team_status shows them, team_start says what you are doing and claims your files, '
        + 'and edits warn when they touch files another agent holds.',
    },
  );

  const team = registerTeamTools(server, root);
  finishers.set(server, team.finish);

  /** Heads-up lines for an edit's reply when another agent holds these files or files next to them. */
  const headsUp = (warnings: string[]): string[] => warnings.length
    ? ['Heads up, another agent is working here (the edit went ahead):', ...warnings.map((w) => `  ${w}`), '']
    : [];

  /** Broken .vi links, plus links and "go:" actions pointing at pages that do not exist. */
  const problems = async (pagePath: string, doc: UiDoc): Promise<string[]> => {
    const out = brokenLinks(doc, await ws.linkedFor(pagePath)).map((b) => `${b.id} (${b.what})`);
    const pages = new Set(await pagesFrom(pagePath));
    const walk = (node: UiDoc['root'] | UiDoc['root']['children'][number]): void => {
      const target = node.kind === 'link' ? node.to : 'on' in node && node.on?.run === 'navigate' ? node.on.to : undefined;
      if (target && !/^(https?:\/\/|mailto:)/.test(target) && !pages.has(target)) out.push(`${node.id} (goes to ${target}, which does not exist)`);
      if (node.kind === 'frame') node.children.forEach(walk);
    };
    walk(doc.root);
    return out;
  };

  /** Other pages, as the page at `pagePath` refers to them. */
  const pagesFrom = async (pagePath: string): Promise<string[]> =>
    (await ws.find(['.ui'])).filter((p) => p !== pagePath).map((p) => posix.relative(posix.dirname(pagePath), p));

  // ---------------------------------------------------------- orientation

  server.registerTool('vibez_overview', {
    title: 'Overview of the Vibez project',
    description: 'Lists every .ui page, every .vi logic file (what it offers and whether it is ready), every plain HTML page, and every recorded flow. Start here.',
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
        const doc = await readLogic(vi);
        const problems = compileIssues(doc, await siblingsOf(vi)).filter((i) => i.severity === 'error').length;
        const names = (list: { name: string }[] | undefined) => (list ?? []).map((d) => d.name).join(', ') || 'none';
        lines.push(`  ${vi} · values ${names(doc.exports.values)} · actions ${names(doc.exports.actions)}`
          + `${doc.functions?.length ? ` · functions ${names(doc.functions)}` : ''}${doc.variables?.length ? ` · variables ${names(doc.variables)}` : ''}`
          + ` · ${problems ? `${problems} problem${problems > 1 ? 's' : ''}` : 'ready'}`);
      } catch (error) {
        lines.push(`  ${vi} · cannot be read: ${(error as Error).message}`);
      }
    }
    const html = await htmlFiles(ws);
    if (html.length) {
      lines.push('', `HTML pages (${html.length}), edited with site_read / site_edit:`);
      for (const file of html.slice(0, 40)) lines.push(`  ${file}`);
      if (html.length > 40) lines.push(`  …and ${html.length - 40} more`);
    }
    const flows = (await ws.find(['.flow'])).filter((f) => f.includes('.vibez/'));
    lines.push('', `recorded flows (${flows.length}):`);
    for (const flow of flows) {
      try {
        const graph = JSON.parse(await ws.read(flow)) as Graph;
        lines.push(`  ${flow} · ${graph.flow} · ${graph.nodes.length} steps · ${Math.round(graph.rootTotalMs)} ms per run over ${graph.runs} runs`);
      } catch {
        lines.push(`  ${flow} · cannot be read`);
      }
    }
    if (pages.length === 0 && vis.length === 0 && html.length === 0) lines.push('', 'Nothing yet. Make a page with ui_create or site_add_page, and logic with vi_edit.');
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
    const collisions = await team.around(touchedOnPage(path, ops as Op[], result.created), result.doc.links.map((l) => ws.resolveFrom(path, l)));
    await ws.writePage(path, result.doc);
    await collisions.claim();
    const names = Object.entries(result.created);
    const broken = await problems(path, result.doc);
    return say([
      ...headsUp(collisions.warnings),
      `Changed ${path}:`,
      ...result.log.map((line) => `  - ${line}`),
      ...(names.length ? ['', `new ids: ${names.map(([k, v]) => `${k} = ${v}`).join(', ')}`] : []),
      ...(broken.length ? ['', `broken links: ${broken.join('; ')}`] : []),
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
    const broken = await problems(path, doc);
    return say(`Compiled ${path} to ${out}.${broken.length ? `\nBroken links: ${broken.join('; ')}` : '\nNo broken links.'}`);
  }));

  // ---------------------------------------------------------- .vi

  /** Other .vi files' callable actions and functions, as a file at `path` names them. */
  const siblingsOf = async (path: string): Promise<Siblings> => {
    const out: Siblings = new Map();
    for (const other of (await ws.find(['.vi'])).filter((p) => p !== path)) {
      const parsed = parseViDoc(await ws.read(other));
      if (parsed.ok) out.set(posix.relative(posix.dirname(path), other), { actions: parsed.doc.exports.actions, functions: parsed.doc.functions ?? [] });
    }
    return out;
  };

  const readLogic = async (path: string): Promise<ViDoc> => {
    if (!path.endsWith('.vi')) throw new VibezError(`${path} is not a .vi file.`);
    const parsed = parseViDoc(await ws.read(path));
    if (!parsed.ok) throw new VibezError(`${path}: ${parsed.reason}`);
    return parsed.doc;
  };

  /** Pages whose links to this file broke. */
  const brokenPagesFor = async (): Promise<string[]> => {
    const broken: string[] = [];
    for (const page of await ws.find(['.ui'])) {
      try {
        const doc = await ws.readPage(page);
        for (const b of brokenLinks(doc, await ws.linkedFor(page))) broken.push(`${page} ${b.id}: ${b.what}`);
      } catch {
        // Unreadable pages are reported by vibez_overview.
      }
    }
    return broken;
  };

  server.registerTool('vi_read', {
    title: 'Read a .vi logic file',
    description: 'Without graph: every page value, page action, function and variable in the file, whether each is ready to run, and its problems. '
      + 'With graph: that one graph block by block, with every port (id and type), what feeds each input, the run order and the problems.',
    inputSchema: {
      path: z.string().describe('Path of the .vi file.'),
      graph: z.string().optional().describe('A value, action or function name to read in full.'),
    },
    annotations: { readOnlyHint: true },
  }, ({ path, graph }) => guard(async () => {
    const doc = await readLogic(path);
    const siblings = await siblingsOf(path);
    if (!graph) return say(outlineLogic(path, doc, siblings));
    const located = locate(doc, graph);
    const issues = compileIssues(located.doc, siblings).filter((i) => i.exportName === graph);
    return say(outlineGraph(located, graph, issues));
  }));

  server.registerTool('vi_blocks', {
    title: 'Find blocks for a graph',
    description: 'The blocks that can be added to a graph, the same list the logic editor\'s search shows: flow, math, text, lists, objects, dates, '
      + 'data, HTTP, this file\'s variables (Get/Set) and callable actions and functions. Each result shows its ports.',
    inputSchema: {
      path: z.string(),
      graph: z.string().describe('The value, action or function the blocks are for.'),
      search: z.string().optional().describe('Words to filter by, like "divide", "text", "list", "if".'),
    },
    annotations: { readOnlyHint: true },
  }, ({ path, graph, search }) => guard(async () => {
    const doc = await readLogic(path);
    const located = locate(doc, graph);
    const items = blocksFor(located.doc, contextFor(located.where, located.decl), await siblingsOf(path)).filter((b) => matches(b, search ?? ''));
    if (!items.length) return say(`No blocks match "${search}".`);
    const lines = [`${items.length} block${items.length > 1 ? 's' : ''}${search ? ` matching "${search}"` : ''} (use the name in quotes with vi_edit add):`];
    let group = '';
    for (const item of items.slice(0, 80)) {
      if (item.group !== group) {
        group = item.group;
        lines.push(`  ${group}:`);
      }
      const probe = item.make(new Set());
      const ports = (list: typeof probe.ports.in) => list.map((p) => `${p.name}${p.id !== p.name ? ` [${p.id}]` : ''}`).join(', ');
      lines.push(`    "${item.label}" · ${item.hint} · in: ${ports(probe.ports.in) || '–'} · out: ${ports(probe.ports.out) || '–'}`);
    }
    if (items.length > 80) lines.push(`  …${items.length - 80} more; narrow the search.`);
    return say(lines.join('\n'));
  }));

  server.registerTool('vi_edit', {
    title: 'Edit .vi logic',
    description: 'Applies a batch of logic operations, all or nothing: declare / rename / remove a value, action, function or variable; '
      + 'add a block to a graph (by its search name, see vi_blocks), set its settings, connect two ports (block.port, by port id or name), '
      + 'disconnect an input, delete a block. Name new blocks with "as" and use them later in the batch as $name. Returns what changed, each touched graph, and its problems.',
    inputSchema: {
      path: z.string().describe('Path of the .vi file; created if it does not exist.'),
      ops: z.array(logicOpSchema).min(1),
    },
  }, ({ path, ops }) => guard(async () => {
    if (!path.endsWith('.vi')) throw new VibezError(`${path} must end in .vi.`);
    const existing = await ws.exists(path);
    const doc = existing ? await readLogic(path) : { vibez: 'vi/1', exports: { values: [], actions: [] }, logic: {} } as ViDoc;
    const siblings = await siblingsOf(path);
    const result = applyLogicOps(doc, ops as LogicOp[], siblings);
    const collisions = await team.around([path]);
    await ws.write(path, serializeVi(result.doc));
    await collisions.claim();
    const names = Object.entries(result.created);
    const graphs = [...result.touched].filter((name) => [...result.doc.exports.values, ...result.doc.exports.actions, ...(result.doc.functions ?? [])].some((d) => d.name === name));
    const issues = compileIssues(result.doc, siblings);
    const broken = await brokenPagesFor();
    return say([
      ...headsUp(collisions.warnings),
      `${existing ? 'Changed' : 'Created'} ${path}:`,
      ...result.log.map((line) => `  - ${line}`),
      ...(names.length ? ['', `new blocks: ${names.map(([k, v]) => `${k} = ${v}`).join(', ')}`] : []),
      ...(broken.length ? ['', 'pages with broken links now:', ...broken.map((b) => `  ${b}`)] : []),
      ...graphs.flatMap((name) => ['', outlineGraph(locate(result.doc, name), name, issues.filter((i) => i.exportName === name))]),
    ].join('\n'));
  }));

  server.registerTool('vi_declare', {
    title: 'Declare .vi exports',
    description: 'Adds or replaces page values and page actions (creating the file if needed, each with a starting Start → Return graph) and removes ones by name. '
      + 'A shortcut for vi_edit declare/remove, for pages that need data before its logic exists. Give every value a realistic sample.',
    inputSchema: {
      path: z.string().describe('Path of the .vi file, like pages/dashboard.vi.'),
      values: z.array(valueSchema).optional(),
      actions: z.array(actionSchema).optional(),
      remove: z.array(z.string()).optional().describe('Names of values or actions to remove.'),
    },
  }, ({ path, values, actions, remove }) => guard(async () => {
    if (!path.endsWith('.vi')) throw new VibezError(`${path} must end in .vi.`);
    const existing = await ws.exists(path);
    const doc = existing ? await readLogic(path) : { vibez: 'vi/1', exports: { values: [], actions: [] }, logic: {} } as ViDoc;
    const ops: LogicOp[] = [
      ...(values ?? []).map((v): LogicOp => ({ op: 'declare', what: 'value', name: v.name, type: v.type, ...(v.fields ? { fields: v.fields } : {}), ...(v.sample !== undefined ? { sample: v.sample } : {}), ...(v.about ? { about: v.about } : {}) })),
      ...(actions ?? []).map((a): LogicOp => ({ op: 'declare', what: 'action', name: a.name, inputs: a.inputs, ...(a.returns ? { returns: a.returns } : {}), ...(a.about ? { about: a.about } : {}) })),
      ...(remove ?? []).map((name): LogicOp => ({ op: 'remove', name })),
    ];
    if (!ops.length) throw new VibezError('Nothing to declare or remove.');
    const result = applyLogicOps(doc, ops, await siblingsOf(path));
    await ws.write(path, serializeVi(result.doc));
    const broken = await brokenPagesFor();
    return say([
      `${existing ? 'Updated' : 'Created'} ${path}:`,
      ...result.log.map((l) => `  - ${l}`),
      ...(broken.length ? ['', 'pages with broken links now:', ...broken.map((b) => `  ${b}`)] : []),
      '',
      outlineLogic(path, result.doc, await siblingsOf(path)),
    ].join('\n'));
  }));

  // ---------------------------------------------------------- sites (plain HTML)

  server.registerTool('site_map', {
    title: 'Map the website',
    description: 'Every HTML page in the project, the address it is served at, and every link on it: where each goes, and which go nowhere.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => guard(async () => say(await siteMap(ws))));

  server.registerTool('site_read', {
    title: 'Read an HTML page',
    description: 'One HTML page as an outline of its visible elements: each line starts with @<offset>, which is how site_edit addresses that element, '
      + 'then its tag, id and classes, its words, and its link, image and style attributes. Offsets change when the file changes; read again before editing.',
    inputSchema: { path: z.string().describe('The .html file, like index.html or about.html.') },
    annotations: { readOnlyHint: true },
  }, ({ path }) => guard(async () => {
    if (!/\.html?$/.test(path)) throw new VibezError(`${path} is not an HTML page.`);
    return say(outlineHtml(path, await ws.read(path)));
  }));

  server.registerTool('site_edit', {
    title: 'Edit an HTML page',
    description: 'Applies edits to one HTML page, all or nothing, touching only the elements named: change an element\'s words (text), its look (style), '
      + 'one attribute like href or src (attr), remove it, move it before/after/inside another, or add a ready-made element from site_library. '
      + 'Offsets (@at) are from the latest site_read. A move must be sent on its own.',
    inputSchema: {
      path: z.string(),
      ops: z.array(siteOpSchema).min(1),
    },
  }, ({ path, ops }) => guard(async () => {
    if (!/\.html?$/.test(path)) throw new VibezError(`${path} is not an HTML page.`);
    const result = applySiteOps(await ws.read(path), ops as SiteOp[]);
    const collisions = await team.around([path]);
    await ws.write(path, result.html);
    await collisions.claim();
    return say([...headsUp(collisions.warnings), `Changed ${path}:`, ...result.log.map((l) => `  - ${l}`), '', outlineHtml(path, result.html)].join('\n'));
  }));

  server.registerTool('site_add_page', {
    title: 'Add an HTML page',
    description: 'Adds a page from a template (see site_library), wearing the site\'s own header, footer and styles copied from its home page, '
      + 'and links it from every page\'s navigation unless told not to.',
    inputSchema: {
      name: z.string().describe('The page name, like "Pricing". The file name comes from it.'),
      template: z.string().optional().describe('Template id; defaults to blank.'),
      dir: z.string().optional().describe('Folder for the page, relative to the project; defaults to the top.'),
      addToNav: z.boolean().optional().describe('Link it from the navigation of every page. Defaults to true.'),
    },
  }, ({ name, template, dir, addToNav }) => guard(async () => say(await addPage(ws, {
    name, ...(template ? { template } : {}), ...(dir ? { dir } : {}), ...(addToNav !== undefined ? { addToNav } : {}),
  }))));

  server.registerTool('site_delete_page', {
    title: 'Delete an HTML page',
    description: 'Deletes a page and takes its links out of every page\'s navigation. A copy is kept in .vibez/trash. The home page cannot be deleted.',
    inputSchema: { path: z.string() },
  }, ({ path }) => guard(async () => say(await deletePage(ws, path))));

  server.registerTool('site_library', {
    title: 'Ready-made elements and page templates',
    description: 'The elements site_edit can add (text, buttons, media, layout, forms, content, navigation) and the templates site_add_page can use.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => guard(async () => say(library())));

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
  // The client ends a session by closing stdin or stopping the process; either way the agent's claims go with it.
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    const timeout = setTimeout(() => process.exit(0), 3000);
    void closeVibezServer(server).finally(() => { clearTimeout(timeout); process.exit(0); });
  };
  process.stdin.on('end', stop);
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
