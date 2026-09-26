/**
 * The element library: the pieces a person can add to a page on the site
 * canvas (text, buttons, pictures, layouts, forms, tables and more), and the
 * code that writes one into the page's HTML.
 *
 * Every element's outermost tag carries the class `vz-el` plus its own, and
 * looks right because of one shared stylesheet (`ELEMENT_CSS`) written into
 * the page's <head> the first time an element is added. That stylesheet only
 * styles `.vz-el` things, inherits the site's fonts and colours, and takes its
 * accent (buttons, links, highlights) from the site's own buttons when the
 * canvas can see one.
 *
 * Pure and isomorphic, like the rest of core.
 */

import { elementAt, moveElement, EditError } from './edit.ts';

export interface PageElement {
  id: string;
  name: string;
  group: 'Text' | 'Buttons' | 'Media' | 'Layout' | 'Forms' | 'Content' | 'Navigation';
  description: string;
  /** A short symbol for the library tile. */
  glyph: string;
  html: string;
}

/** A neutral picture to stand in until a real one is chosen in the Edit panel. */
export const PLACEHOLDER_IMAGE = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='675'%3E%3Crect width='100%25' height='100%25' fill='%23e7e5e4'/%3E%3Cpath d='M480 420l110-130 80 95 55-60 115 95z' fill='%23d6d3d1'/%3E%3Ccircle cx='520' cy='250' r='38' fill='%23d6d3d1'/%3E%3C/svg%3E";

export const ELEMENTS: readonly PageElement[] = [
  // Text
  { id: 'title', name: 'Title', group: 'Text', glyph: 'H1', description: 'The page’s main headline.', html: '<h1 class="vz-el vz-title">A big, clear title</h1>' },
  { id: 'heading', name: 'Heading', group: 'Text', glyph: 'H2', description: 'Starts a new section.', html: '<h2 class="vz-el vz-heading">Section heading</h2>' },
  { id: 'subheading', name: 'Subheading', group: 'Text', glyph: 'H3', description: 'A smaller heading inside a section.', html: '<h3 class="vz-el vz-subheading">Subheading</h3>' },
  { id: 'paragraph', name: 'Text box', group: 'Text', glyph: '¶', description: 'A paragraph of text.', html: '<p class="vz-el vz-text">Write something here. Double-click any text on the canvas to change it.</p>' },
  { id: 'lead', name: 'Intro text', group: 'Text', glyph: 'Aa', description: 'Larger text for an opening line.', html: '<p class="vz-el vz-lead">An opening sentence that sets the scene, a little larger than the rest.</p>' },
  { id: 'quote', name: 'Quote', group: 'Text', glyph: '“', description: 'A pulled-out quote with who said it.', html: '<blockquote class="vz-el vz-quote">\n  <p>“A line worth showing bigger.”</p>\n  <cite>Someone worth quoting</cite>\n</blockquote>' },
  { id: 'bullets', name: 'Bulleted list', group: 'Text', glyph: '•', description: 'A list of points.', html: '<ul class="vz-el vz-list">\n  <li>First point</li>\n  <li>Second point</li>\n  <li>Third point</li>\n</ul>' },
  { id: 'numbers', name: 'Numbered list', group: 'Text', glyph: '1.', description: 'Steps in order.', html: '<ol class="vz-el vz-list">\n  <li>First step</li>\n  <li>Second step</li>\n  <li>Third step</li>\n</ol>' },
  { id: 'small', name: 'Small print', group: 'Text', glyph: 'a', description: 'Notes, captions and fine print.', html: '<p class="vz-el vz-small">Small print, a note or a caption.</p>' },
  { id: 'link', name: 'Text link', group: 'Text', glyph: '↗', description: 'A link written as text.', html: '<p class="vz-el vz-text"><a class="vz-link" href="#">Read more</a></p>' },

  // Buttons
  { id: 'button', name: 'Button', group: 'Buttons', glyph: '▭', description: 'A solid button that links somewhere.', html: '<a class="vz-el vz-button" href="#">Button</a>' },
  { id: 'button-outline', name: 'Outline button', group: 'Buttons', glyph: '▢', description: 'A quieter button with an outline.', html: '<a class="vz-el vz-button vz-outline" href="#">Button</a>' },
  { id: 'button-pair', name: 'Two buttons', group: 'Buttons', glyph: '▭▢', description: 'A main action and a second one side by side.', html: '<div class="vz-el vz-actions">\n  <a class="vz-button" href="#">Get started</a>\n  <a class="vz-button vz-outline" href="#">Learn more</a>\n</div>' },
  { id: 'button-big', name: 'Big button', group: 'Buttons', glyph: '⬛', description: 'A large call to action.', html: '<a class="vz-el vz-button vz-large" href="#">Book now</a>' },

  // Media
  { id: 'image', name: 'Image', group: 'Media', glyph: '▨', description: 'A picture. Choose the file in the Edit panel.', html: `<img class="vz-el vz-image" src="${PLACEHOLDER_IMAGE}" alt="Describe the picture">` },
  { id: 'figure', name: 'Image with caption', group: 'Media', glyph: '▨_', description: 'A picture with a line of text under it.', html: `<figure class="vz-el vz-figure">\n  <img src="${PLACEHOLDER_IMAGE}" alt="Describe the picture">\n  <figcaption>A caption for the picture.</figcaption>\n</figure>` },
  { id: 'gallery', name: 'Gallery', group: 'Media', glyph: '▦', description: 'Three pictures in a row.', html: `<div class="vz-el vz-gallery">\n  <img src="${PLACEHOLDER_IMAGE}" alt="First picture">\n  <img src="${PLACEHOLDER_IMAGE}" alt="Second picture">\n  <img src="${PLACEHOLDER_IMAGE}" alt="Third picture">\n</div>` },
  { id: 'video', name: 'Video', group: 'Media', glyph: '▶', description: 'A video player. Set the video file in the Edit panel.', html: `<video class="vz-el vz-video" controls preload="none" poster="${PLACEHOLDER_IMAGE}" src=""></video>` },
  { id: 'embed', name: 'Embed', group: 'Media', glyph: '⧉', description: 'Another page shown inside this one, like a YouTube video.', html: '<iframe class="vz-el vz-embed" src="about:blank" title="Embedded content" loading="lazy"></iframe>' },
  { id: 'map', name: 'Map', group: 'Media', glyph: '⌖', description: 'A map. Change the address in the Edit panel.', html: '<iframe class="vz-el vz-embed vz-map" title="Map" loading="lazy" src="https://www.openstreetmap.org/export/embed.html?bbox=-0.1400%2C51.5000%2C-0.1100%2C51.5150&amp;layer=mapnik"></iframe>' },
  { id: 'divider', name: 'Divider', group: 'Media', glyph: '—', description: 'A line between parts of the page.', html: '<hr class="vz-el vz-divider">' },
  { id: 'spacer', name: 'Spacer', group: 'Media', glyph: '↕', description: 'Empty space. Change its height in the Edit panel.', html: '<div class="vz-el vz-spacer" aria-hidden="true"></div>' },

  // Layout
  { id: 'section', name: 'Section', group: 'Layout', glyph: '▤', description: 'A full-width block with a heading and text.', html: '<section class="vz-el vz-section">\n  <div class="vz-wrap">\n    <h2>New section</h2>\n    <p>Add what this part of the page is about.</p>\n  </div>\n</section>' },
  { id: 'card', name: 'Card', group: 'Layout', glyph: '▢', description: 'A box with a heading, text and a link.', html: '<div class="vz-el vz-card">\n  <h3>Card title</h3>\n  <p>A short description.</p>\n  <a class="vz-link" href="#">Learn more</a>\n</div>' },
  { id: 'columns-2', name: 'Two columns', group: 'Layout', glyph: '▥', description: 'Two columns side by side (one above the other on phones).', html: '<div class="vz-el vz-columns">\n  <div>\n    <h3>Left column</h3>\n    <p>Text for the left side.</p>\n  </div>\n  <div>\n    <h3>Right column</h3>\n    <p>Text for the right side.</p>\n  </div>\n</div>' },
  { id: 'cards-3', name: 'Three cards', group: 'Layout', glyph: '▦', description: 'Three cards in a row, for features or products.', html: '<div class="vz-el vz-cards">\n  <div class="vz-card">\n    <h3>First</h3>\n    <p>Describe it in a sentence.</p>\n  </div>\n  <div class="vz-card">\n    <h3>Second</h3>\n    <p>Describe it in a sentence.</p>\n  </div>\n  <div class="vz-card">\n    <h3>Third</h3>\n    <p>Describe it in a sentence.</p>\n  </div>\n</div>' },
  { id: 'callout', name: 'Callout', group: 'Layout', glyph: '!', description: 'A highlighted box for a notice or tip.', html: '<div class="vz-el vz-callout">\n  <strong>Good to know</strong>\n  <p>Something visitors should not miss.</p>\n</div>' },
  { id: 'hero', name: 'Hero banner', group: 'Layout', glyph: '▀', description: 'A big headline, a line of text and a button.', html: '<section class="vz-el vz-hero">\n  <div class="vz-wrap">\n    <h1>A headline that says what you do</h1>\n    <p>One sentence about who it is for and why it matters.</p>\n    <a class="vz-button" href="#">Get started</a>\n  </div>\n</section>' },

  // Forms
  { id: 'contact-form', name: 'Contact form', group: 'Forms', glyph: '✉', description: 'Name, email, message and a send button.', html: '<form class="vz-el vz-form" action="#" method="post">\n  <label>Your name<input name="name" placeholder="Jane Doe"></label>\n  <label>Email<input name="email" type="email" placeholder="you@example.com"></label>\n  <label>Message<textarea name="message" rows="4" placeholder="How can we help?"></textarea></label>\n  <button class="vz-button" type="submit">Send message</button>\n</form>' },
  { id: 'newsletter', name: 'Newsletter signup', group: 'Forms', glyph: '@', description: 'An email box and a subscribe button on one line.', html: '<form class="vz-el vz-inline-form" action="#" method="post">\n  <input name="email" type="email" placeholder="you@example.com" aria-label="Email">\n  <button class="vz-button" type="submit">Subscribe</button>\n</form>' },
  { id: 'text-field', name: 'Text field', group: 'Forms', glyph: '⌷', description: 'A labelled box for a line of text.', html: '<label class="vz-el vz-field">Your name<input name="name" placeholder="Type here"></label>' },
  { id: 'email-field', name: 'Email field', group: 'Forms', glyph: '@', description: 'A labelled box for an email address.', html: '<label class="vz-el vz-field">Email<input name="email" type="email" placeholder="you@example.com"></label>' },
  { id: 'phone-field', name: 'Phone field', group: 'Forms', glyph: '☏', description: 'A labelled box for a phone number.', html: '<label class="vz-el vz-field">Phone<input name="phone" type="tel" placeholder="(555) 010-0000"></label>' },
  { id: 'textarea', name: 'Message box', group: 'Forms', glyph: '▤', description: 'A larger box for a few lines of text.', html: '<label class="vz-el vz-field">Message<textarea name="message" rows="4" placeholder="Write your message"></textarea></label>' },
  { id: 'dropdown', name: 'Dropdown', group: 'Forms', glyph: '▾', description: 'Pick one option from a list.', html: '<label class="vz-el vz-field">Choose one\n  <select name="choice">\n    <option>First option</option>\n    <option>Second option</option>\n    <option>Third option</option>\n  </select>\n</label>' },
  { id: 'checkbox', name: 'Checkbox', group: 'Forms', glyph: '☑', description: 'A box to tick, like agreeing to terms.', html: '<label class="vz-el vz-check"><input type="checkbox" name="agree"> I agree to the terms</label>' },
  { id: 'choices', name: 'Choices', group: 'Forms', glyph: '◉', description: 'Pick one of a few options.', html: '<fieldset class="vz-el vz-choices">\n  <legend>Pick one</legend>\n  <label><input type="radio" name="option" value="a" checked> Option A</label>\n  <label><input type="radio" name="option" value="b"> Option B</label>\n  <label><input type="radio" name="option" value="c"> Option C</label>\n</fieldset>' },
  { id: 'date-field', name: 'Date field', group: 'Forms', glyph: '▦', description: 'A labelled date picker.', html: '<label class="vz-el vz-field">Date<input name="date" type="date"></label>' },
  { id: 'submit', name: 'Submit button', group: 'Forms', glyph: '⏎', description: 'Sends the form it is in.', html: '<button class="vz-el vz-button" type="submit">Submit</button>' },

  // Content
  { id: 'table', name: 'Table', group: 'Content', glyph: '▦', description: 'Rows and columns of information.', html: '<table class="vz-el vz-table">\n  <thead>\n    <tr><th>Item</th><th>Details</th><th>Price</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>First</td><td>Something about it</td><td>$10</td></tr>\n    <tr><td>Second</td><td>Something about it</td><td>$20</td></tr>\n  </tbody>\n</table>' },
  { id: 'faq', name: 'Question & answer', group: 'Content', glyph: '?', description: 'A question that opens to show its answer.', html: '<details class="vz-el vz-faq">\n  <summary>A question people ask?</summary>\n  <p>The answer, in a sentence or two.</p>\n</details>' },
  { id: 'stats', name: 'Numbers', group: 'Content', glyph: '#', description: 'Three big numbers with labels.', html: '<div class="vz-el vz-stats">\n  <div><strong>120+</strong><span>Happy customers</span></div>\n  <div><strong>8 yrs</strong><span>In business</span></div>\n  <div><strong>4.9</strong><span>Average rating</span></div>\n</div>' },
  { id: 'testimonial', name: 'Testimonial', group: 'Content', glyph: '☺', description: 'A customer’s words, their name and where they are from.', html: '<figure class="vz-el vz-testimonial">\n  <blockquote>“A short, specific thing a happy customer said.”</blockquote>\n  <figcaption><strong>Customer name</strong> · Where they are from</figcaption>\n</figure>' },
  { id: 'price', name: 'Price box', group: 'Content', glyph: '$', description: 'A plan or product with its price and what is included.', html: '<div class="vz-el vz-card vz-price">\n  <h3>Plan name</h3>\n  <p class="vz-amount">$29<span>/month</span></p>\n  <ul>\n    <li>First thing included</li>\n    <li>Second thing included</li>\n  </ul>\n  <a class="vz-button" href="#">Choose</a>\n</div>' },
  { id: 'code', name: 'Code block', group: 'Content', glyph: '</>', description: 'Text shown exactly as typed, in a fixed-width font.', html: '<pre class="vz-el vz-code"><code>Type or paste code here</code></pre>' },

  // Navigation
  { id: 'nav-links', name: 'Link row', group: 'Navigation', glyph: '⋯', description: 'A row of links, like a small menu.', html: '<nav class="vz-el vz-links">\n  <a href="#">First</a>\n  <a href="#">Second</a>\n  <a href="#">Third</a>\n</nav>' },
  { id: 'social', name: 'Social links', group: 'Navigation', glyph: '◎', description: 'Links to your social profiles.', html: '<nav class="vz-el vz-links vz-social" aria-label="Social">\n  <a href="https://instagram.com/">Instagram</a>\n  <a href="https://facebook.com/">Facebook</a>\n  <a href="https://x.com/">X</a>\n</nav>' },
  { id: 'back-to-top', name: 'Back to top', group: 'Navigation', glyph: '↑', description: 'A link that jumps to the top of the page.', html: '<p class="vz-el vz-small"><a class="vz-link" href="#">Back to top ↑</a></p>' },
];

export function elementById(id: string): PageElement | undefined {
  return ELEMENTS.find(e => e.id === id);
}

/** Styles for everything in the library. Written into a page's <head> once. */
export const ELEMENT_CSS = `.vz-el{--vz-accent:var(--accent,#2563eb);--vz-line:rgba(127,127,127,.28);--vz-soft:rgba(127,127,127,.08);box-sizing:border-box}
.vz-el *{box-sizing:border-box}
.vz-title{font-size:clamp(34px,5vw,56px);line-height:1.08;margin:0 0 16px}
.vz-heading{font-size:clamp(26px,3vw,36px);line-height:1.15;margin:32px 0 14px}
.vz-subheading{font-size:21px;line-height:1.25;margin:24px 0 8px}
.vz-text{margin:0 0 14px}
.vz-lead{font-size:20px;line-height:1.5;opacity:.85;margin:0 0 20px;max-width:60ch}
.vz-small{font-size:13px;opacity:.7;margin:0 0 12px}
.vz-el .vz-link,a.vz-link{color:var(--vz-accent);font-weight:600}
.vz-quote{margin:28px 0;padding:4px 0 4px 20px;border-left:4px solid var(--vz-accent)}
.vz-quote p{font-size:24px;line-height:1.4;margin:0 0 8px}
.vz-quote cite{font-style:normal;opacity:.7}
.vz-list{margin:0 0 16px;padding-left:22px}
.vz-list li{margin:6px 0}
.vz-button,.vz-el .vz-button{display:inline-block;padding:12px 22px;border-radius:999px;background:var(--vz-accent);color:#fff;text-decoration:none;font:inherit;font-weight:600;border:0;cursor:pointer;line-height:1.2}
.vz-button.vz-outline,.vz-el .vz-button.vz-outline{background:transparent;color:inherit;box-shadow:inset 0 0 0 1.5px currentColor}
.vz-button.vz-large{padding:16px 32px;font-size:18px}
.vz-actions{display:flex;flex-wrap:wrap;gap:12px;margin:8px 0 16px}
.vz-image,.vz-figure img,.vz-gallery img{display:block;width:100%;height:auto;border-radius:12px;object-fit:cover}
.vz-figure{margin:24px 0}
.vz-figure figcaption{font-size:14px;opacity:.7;margin-top:8px}
.vz-gallery{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:24px 0}
.vz-gallery img{aspect-ratio:4/3}
.vz-video,.vz-embed{display:block;width:100%;aspect-ratio:16/9;border:0;border-radius:12px;background:#000;margin:24px 0}
.vz-map{background:var(--vz-soft)}
.vz-divider{border:0;border-top:1px solid var(--vz-line);margin:32px 0}
.vz-spacer{height:48px}
.vz-section{padding:64px 0}
.vz-section .vz-wrap,.vz-hero .vz-wrap{max-width:1080px;margin:0 auto;padding:0 28px}
.vz-card,.vz-el .vz-card{border:1px solid var(--vz-line);border-radius:16px;padding:22px;background:rgba(255,255,255,.6)}
.vz-card h3{margin:0 0 6px}
.vz-card p{margin:0 0 12px;opacity:.8}
.vz-columns{display:grid;grid-template-columns:1fr 1fr;gap:32px;margin:24px 0}
.vz-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:24px 0}
.vz-callout{border-left:4px solid var(--vz-accent);background:var(--vz-soft);border-radius:10px;padding:16px 20px;margin:20px 0}
.vz-callout p{margin:4px 0 0}
.vz-hero{padding:96px 0 80px;background:var(--vz-soft)}
.vz-hero h1{font-size:clamp(36px,5vw,60px);line-height:1.05;margin:0 0 16px;max-width:16ch}
.vz-hero p{font-size:20px;opacity:.8;margin:0 0 26px;max-width:52ch}
.vz-form{display:grid;gap:14px;max-width:520px;margin:20px 0}
.vz-form label,.vz-field{display:grid;gap:6px;font-weight:600;font-size:14px;margin:0 0 12px;max-width:520px}
.vz-form .vz-button{justify-self:start}
.vz-el input:not([type=checkbox]):not([type=radio]),.vz-el textarea,.vz-el select{font:inherit;font-weight:400;padding:11px 14px;border-radius:10px;border:1px solid var(--vz-line);background:#fff;color:#1f2328;width:100%}
.vz-inline-form{display:flex;gap:10px;max-width:520px;margin:16px 0}
.vz-inline-form input{flex:1}
.vz-check{display:flex;align-items:center;gap:8px;margin:0 0 12px}
.vz-choices{border:0;padding:0;margin:0 0 14px;display:grid;gap:8px}
.vz-choices legend{font-weight:600;font-size:14px;margin-bottom:6px;padding:0}
.vz-choices label{display:flex;align-items:center;gap:8px}
.vz-table{width:100%;border-collapse:collapse;margin:20px 0}
.vz-table th,.vz-table td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--vz-line)}
.vz-table th{font-size:13px;text-transform:uppercase;letter-spacing:.04em;opacity:.7}
.vz-faq{border-bottom:1px solid var(--vz-line);padding:14px 0}
.vz-faq summary{cursor:pointer;font-weight:600}
.vz-faq p{margin:8px 0 0;opacity:.8}
.vz-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin:28px 0;text-align:center}
.vz-stats strong{display:block;font-size:40px;line-height:1.1;color:var(--vz-accent)}
.vz-stats span{opacity:.7}
.vz-testimonial{margin:28px 0;padding:24px;border-radius:16px;background:var(--vz-soft)}
.vz-testimonial blockquote{margin:0 0 12px;font-size:21px;line-height:1.45}
.vz-testimonial figcaption{opacity:.75}
.vz-price .vz-amount{font-size:36px;font-weight:700;margin:4px 0 10px}
.vz-price .vz-amount span{font-size:15px;font-weight:400;opacity:.7}
.vz-price ul{padding-left:18px;margin:0 0 16px}
.vz-code{background:#1f2328;color:#e6edf3;border-radius:10px;padding:16px 18px;overflow:auto;font:13px/1.55 ui-monospace,Menlo,Consolas,monospace;margin:20px 0}
.vz-links{display:flex;flex-wrap:wrap;gap:18px;margin:12px 0}
.vz-links a{color:inherit;opacity:.85}
@media (max-width:760px){.vz-columns,.vz-cards,.vz-stats{grid-template-columns:1fr}.vz-gallery{grid-template-columns:1fr 1fr}.vz-inline-form{flex-direction:column}}`;

/** A colour from the site, as `rgb(…)` or `#…`, or nothing if it does not look like one. */
function safeColour(colour: string | null | undefined): string | null {
  if (!colour) { return null; }
  const c = colour.trim();
  return /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(c) ? c : null;
}

/**
 * Makes sure the page has the element styles. The first time, they are added
 * just before </head> (after the site's own stylesheets, so these only fill
 * gaps). The accent is the site's button colour when one is given.
 */
export function ensureElementStyles(html: string, accent?: string | null): string {
  if (/<style[^>]*\bdata-vibez-elements\b/i.test(html)) { return html; }
  const colour = safeColour(accent);
  const block = `<style data-vibez-elements>\n${colour ? `.vz-el{--accent:${colour}}\n` : ''}${ELEMENT_CSS}\n</style>`;
  const idx = html.search(/<\/head>/i);
  if (idx >= 0) {
    const lineStart = html.lastIndexOf('\n', idx - 1) + 1;
    const before = html.slice(lineStart, idx);
    if (before.trim() === '') {
      const inner = before + '  ';
      return html.slice(0, lineStart) + block.split('\n').map(l => inner + l).join('\n') + '\n' + html.slice(lineStart);
    }
    return html.slice(0, idx) + block + html.slice(idx);
  }
  return block + '\n' + html;
}

/** The place new content goes when no element is chosen: the end of <main>, else of <body>. */
export function defaultTarget(html: string): number | null {
  for (const tag of ['main', 'body']) {
    const m = new RegExp(`<${tag}\\b`, 'i').exec(html);
    if (m) {
      const el = elementAt(html, m.index);
      if (el && el.closeStart >= 0) { return m.index; }
    }
  }
  return null;
}

/**
 * Writes an element into the page before or after another element, or inside
 * one as its last child, and adds the element styles if the page has none.
 * Returns the new text and where the new element starts.
 */
export function insertElement(html: string, id: string, target: number | null, where: 'before' | 'after' | 'inside', targetTag?: string, accent?: string | null): { html: string; at: number } {
  const element = elementById(id);
  if (!element) { throw new EditError(`There is no “${id}” element.`); }
  let place = target;
  let how = where;
  let tag = targetTag;
  if (place === null) {
    place = defaultTarget(html);
    how = 'inside';
    tag = undefined;
    if (place === null) { throw new EditError('This page has no <body> to add to.'); }
  }
  // Put the element at the very end on a line of its own, then move it into place:
  // moving already knows how to indent a block and where lines begin and end.
  const base = html.endsWith('\n') ? html : html + '\n';
  const parked = base + element.html + '\n';
  const moved = moveElement(parked, base.length, place, how, undefined, tag);
  const start = moved.html.slice(moved.at);
  // Add the styles last, and find the element again after they shift the text.
  const styled = ensureElementStyles(moved.html, accent);
  const shift = styled.length - moved.html.length;
  const headEnd = moved.html.search(/<\/head>/i);
  const at = headEnd >= 0 && headEnd < moved.at ? moved.at + shift : moved.at;
  if (!styled.slice(at).startsWith(start.slice(0, 40))) { throw new EditError('Could not place the element.'); }
  const result = html.endsWith('\n') ? styled : styled.replace(/\n$/, '');
  return { html: result, at };
}
