import { THEMES, TEMPLATES } from '../../ui/src/index.ts';
import { CATALOG } from '../../vi/src/index.ts';
import { ELEMENTS as SITE_ELEMENTS, TEMPLATES as PAGE_TEMPLATES } from '../../core/src/index.ts';
import { ELEMENTS, LINK_PROPS, PROPS } from './edit.ts';

/**
 * The vocabulary an agent needs to write Vibez, built from the same tables
 * the edits are checked against so it can never drift from what is accepted.
 */
export function reference(): string {
  const props = Object.entries(PROPS).map(([kind, own]) => {
    const list = Object.entries(own).map(([key, check]) => {
      switch (check.t) {
        case 'enum': return `${key}: ${check.values.join('|')}${check.nullable ? '|null' : ''}`;
        case 'int': return `${key}: ${check.min}–${check.max}`;
        case 'bool': return `${key}: true|false`;
        case 'strings': return `${key}: [addresses]`;
        default: return `${key}: text`;
      }
    });
    const links = Object.entries(LINK_PROPS).filter(([, kinds]) => kinds.includes(kind as never)).map(([key]) => key);
    return `- **${kind}** — ${list.join(', ')}${links.length ? `; connects with ${links.join(', ')}` : ''}`;
  }).join('\n');

  return `# Vibez for agents

Vibez apps are made of two kinds of file:

- **.ui** — one page, laid out visually. Read it with \`ui_read\`, change it with \`ui_edit\`.
- **.vi** — logic, drawn as graphs of blocks. It offers **page data** (values a page shows) and **page actions** (things a page runs), plus reusable **functions**, shared **variables** and **classes** (blueprints for objects). Read it with \`vi_read\`, change it with \`vi_edit\`, test one item with \`vi_run\`.
- **Plain HTML pages** — an existing website. Map it with \`site_map\`, read a page with \`site_read\`, change it with \`site_edit\`, add or delete pages with \`site_add_page\` / \`site_delete_page\`.

A page never holds logic or data. It holds references to .vi exports, and the editor and the compiled page fill them in (with samples until something serves the real values).

## How a page is built

A page is a tree. Frames stack their children as a **stack** (top to bottom), a **row** (side by side) or a **grid** (tiles in columns), like Figma's auto layout. Nothing is placed at coordinates, so pages work at any width. The root frame has the id \`page\`.

Sizes along each axis are \`fill\` (take the room left), \`fit\` (wrap the content) or a number of pixels. Set them with \`width\` and \`height\`.

Spacing, colour, corners and type come from the page's theme, as tokens:

- space (gap, padding): none xs sm md lg xl 2xl  (0 4 8 16 24 40 64 px)
- colour: page surface raised accent accentSoft text muted inverse danger success
- radius: none sm md lg full
- text variant: title heading subheading body caption label
- themes: ${THEMES.map((t) => `${t.id} (${t.mood})`).join(', ')}

## Elements (for \`add\`)

${[...ELEMENTS.values()].map((e) => `- **${e.label.toLowerCase()}** — ${e.hint.toLowerCase()}`).join('\n')}

stack, row, grid and card are all frames with different starting settings.

## Properties (for \`add\` and \`set\`)

Every element also has: name, hidden, width, height.

${props}

## Connecting to .vi files

References are written the same way everywhere, in and out:

| Write | Means |
|---|---|
| \`dashboard.vi#orders\` | the value \`orders\` from dashboard.vi (path relative to the page) |
| \`dashboard.vi#plan.tier\` | one field of an object value |
| \`item.customer\` | a field of the current item, inside a frame that repeats |
| \`input.email\` | what was typed into the input saved as \`email\` |
| \`dashboard.vi#inviteTeammate\` | an action, for onClick / onEnter |
| \`answer:orders.vi#place\` | what that action answered when it last ran |
| \`go:gallery.ui\` | open another page (or \`go:https://…\`) |

- \`shows\` on a text, image or gallery. Text takes words and numbers, an image a picture address, a gallery a List.
- To show the result of a button press, \`shows\` an \`answer:\` — the page keeps what the action answered and redraws when it runs. It is empty until then. The action needs a return type.
- \`repeat\` on a frame takes a List. The frame's children are drawn once per item, and inside it \`item.<field>\` is available.
- \`onClick\` on a button or frame, \`onEnter\` on an input. An action's inputs fill themselves from page inputs with the same name; override with \`args\`, e.g. \`{ "email": "input.email" }\`.
- Set any of them to \`null\` to disconnect.

Links are checked: a list cannot go into a heading, and a value a .vi file does not export is refused with the ones that would fit. \`ui_options\` lists what an element can connect to.

## ui_edit operations

A batch is applied all or nothing. Name new elements with \`as\` and refer to them later in the same batch as \`$name\`.

\`\`\`json
[
  { "op": "add", "element": "card", "parent": "page", "as": "invite", "props": { "padding": "lg" } },
  { "op": "add", "element": "title", "parent": "$invite", "props": { "text": "Invite a teammate", "variant": "subheading" } },
  { "op": "add", "element": "input", "parent": "$invite", "props": { "field": "email", "label": "Email", "inputType": "email" } },
  { "op": "add", "element": "button", "parent": "$invite", "props": { "label": "Send invite", "onClick": "dashboard.vi#inviteTeammate" } },
  { "op": "set", "id": "org-name", "props": { "shows": "dashboard.vi#orgName" } },
  { "op": "move", "id": "stats", "parent": "page", "index": 0 },
  { "op": "remove", "id": "old-banner" },
  { "op": "duplicate", "id": "stat-revenue", "as": "copy" },
  { "op": "wrap", "id": "hero-title", "direction": "row" },
  { "op": "page", "props": { "theme": "paper", "route": "/team" } }
]
\`\`\`

\`index\` is a position among the parent's children (0 is first); leave it out to add at the end.

## Starting a page

\`ui_create\` makes a new page from a template: ${TEMPLATES.map((t) => `${t.id} (${t.hint.toLowerCase()})`).join(', ')}.

## Logic (.vi) with vi_edit

Every value, action and function has one graph, which starts at **Start** and ends at **Return**. Blocks join in two ways:

- **Run wires** (white) set the order things happen: \`Start.exec:out → Print.exec → Return.exec\`.
- **Value wires** (coloured) carry data into inputs: \`Divide.result → Return.value\`.

A port is written \`block.port\`, with the port's id or its name as \`vi_read\` shows them. Start's outputs are the item's inputs (\`entry-1a.in:Revenue\`). Unlike types are converted automatically when that is safe, and otherwise refused.

Block groups: ${[...new Set(CATALOG.map((c) => c.group))].join(', ')}, plus Get/Set for each declared variable and a call block for each action and function. \`vi_blocks\` searches them with their ports.

### Classes and objects

A class is a blueprint for objects: fields every object carries and methods every object can do. Declare one with \`{ "op": "declare", "what": "class", "name": "Animal", "fields": [{ "name": "name", "type": "String" }, { "name": "legs", "type": "Number", "initial": 4 }] }\`, and a method with \`{ "op": "declare", "what": "method", "class": "Animal", "name": "describe", "returns": "String" }\`. A method's graph is named \`Animal.describe\`: add blocks to it like any graph.

\`"extends": "Animal"\` makes a child class: it gets all of Animal's fields and methods, and a method it declares with the same name replaces Animal's (an override). Each class offers these blocks:
- \`New Animal\` makes an object; it asks for every field without an \`initial\` value, the parents' included.
- \`Get Animal.name\` and \`Set Animal.name\` read and change a field. Objects are shared: setting a field changes that object everywhere it is used.
- \`Animal.describe\` runs a method on an object: the object's own class's version, so a Dog's override wins even when it is held as an Animal.
- \`Is a Animal\` asks whether an object was made from Animal or a class that extends it.
- Inside a method: \`This Animal\` is the object the method runs on, and \`Parent describe\` runs the parent class's version of the method being written.

An object sent to a page arrives as its fields.

\`\`\`json
[
  { "op": "declare", "what": "function", "name": "UnitPrice", "inputs": [{ "name": "revenue", "type": "Number" }, { "name": "units", "type": "Number" }], "returns": "Number" },
  { "op": "add", "graph": "UnitPrice", "block": "Divide (÷)", "as": "div" },
  { "op": "connect", "graph": "UnitPrice", "from": "<start id>.revenue", "to": "$div.a" },
  { "op": "connect", "graph": "UnitPrice", "from": "<start id>.units", "to": "$div.b" },
  { "op": "connect", "graph": "UnitPrice", "from": "$div.result", "to": "<return id>.value" }
]
\`\`\`

A new graph's Start and Return ids appear in the reply to the declare (or in \`vi_read\`), so declare first, then wire. Other operations: \`rename\`, \`remove\`, \`set\` (a block's settings, e.g. a Value block's \`value\` and \`type\`), \`disconnect\` (an input), \`delete\` (a block, joining what ran before and after it). Every reply lists the graph's remaining problems; \`vi_run\` runs one item for real.

Some blocks (database queries, effects, authorization) are placeholders that cannot run yet; they are labelled "Not runnable yet".

## Plain HTML pages with site_edit

\`site_read\` shows each visible element on a line starting \`@<offset>\`; that number addresses it. Edits:

- \`text\` — the element's words: \`{ "op": "text", "at": 812, "text": "Order now" }\`
- \`style\` — CSS on that element only: \`{ "op": "style", "at": 812, "style": { "color": "#b4532a", "font-size": "18px" } }\`
- \`attr\` — href, src, alt, class and similar: \`{ "op": "attr", "at": 812, "name": "href", "value": "menu.html" }\`
- \`remove\`, \`move\` (before / after / inside another element; on its own), \`add\` (a ready-made element, after or inside \`target\`).

Elements to add: ${[...new Set(SITE_ELEMENTS.map((e) => e.group))].map((g) => `${g} (${SITE_ELEMENTS.filter((e) => e.group === g).map((e) => e.id).join(', ')})`).join('; ')}.

Page templates for \`site_add_page\`: ${PAGE_TEMPLATES.map((t) => t.id).join(', ')}. New pages copy the site's header, footer and styles, and are linked from the navigation.

## Good habits

- \`ui_read\` before editing, so ids are current. The person may be editing the same page in the editor; it reloads when the file changes.
- Prefer tokens and stacks over fixed pixel sizes. Use a row with stackOnPhone for things side by side.
- If a page needs data that no .vi file offers yet, declare it with \`vi_declare\` (with a realistic sample), then connect it.
- \`ui_build\` compiles the page to HTML and reports broken links.
- For logic, read the graph with \`vi_read\` before wiring it, so the block and port ids are current, and \`vi_run\` it when its problems reach none.
- For HTML, read the page again after a change before editing it again; offsets move.
`;
}
