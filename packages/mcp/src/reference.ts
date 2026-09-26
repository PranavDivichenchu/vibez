import { THEMES, TEMPLATES } from '../../ui/src/index.ts';
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
- **.vi** — logic. Its \`exports\` block lists the **values** a page can show and the **actions** a page can run, each with sample data. Read it with \`vi_read\`, declare exports with \`vi_declare\`. Everything else in a .vi file belongs to the graph editor.

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
| \`go:gallery.ui\` | open another page (or \`go:https://…\`) |

- \`shows\` on a text, image or gallery. Text takes words and numbers, an image a picture address, a gallery a List.
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

## Good habits

- \`ui_read\` before editing, so ids are current. The person may be editing the same page in the editor; it reloads when the file changes.
- Prefer tokens and stacks over fixed pixel sizes. Use a row with stackOnPhone for things side by side.
- If a page needs data that no .vi file offers yet, declare it with \`vi_declare\` (with a realistic sample), then connect it.
- \`ui_build\` compiles the page to HTML and reports broken links.
`;
}
