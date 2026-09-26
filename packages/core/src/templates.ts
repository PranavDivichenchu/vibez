/**
 * Page templates for the dashboard, and the code that turns one into a page
 * that belongs to the site it is added to.
 *
 * A template is only the middle of a page. The page around it (the <head>
 * with the site's stylesheet, the header and navigation, the footer and the
 * site's scripts) is copied from a page the site already has, so a new page
 * looks like the rest of the site from the start. Each template brings a small
 * stylesheet of its own, scoped to `.vz-page`, that inherits the site's fonts
 * and colours rather than replacing them.
 *
 * Pure and isomorphic: the editor and the tests run the same code.
 */

import { elementAt, removeElement } from './edit.ts';

export interface PageTemplate {
  id: string;
  name: string;
  /** One line for the dashboard card. */
  description: string;
  /** Suggested page name, which becomes the title and the file name. */
  title: string;
  /** The page's content. `{{title}}` is replaced with the page name. */
  body: string;
  /** Styles for this template only, scoped under `.vz-page.vz-<id>`. */
  css: string;
}

const BASE_CSS = `.vz-page{--vz-accent:var(--accent,#2563eb);--vz-line:rgba(127,127,127,.25);--vz-soft:rgba(127,127,127,.08)}
.vz-page .vz-wrap{max-width:1080px;margin:0 auto;padding:0 28px}
.vz-page .vz-section{padding:72px 0}
.vz-page .vz-section.vz-tint{background:var(--vz-soft)}
.vz-page h1{font-size:clamp(34px,5vw,56px);line-height:1.08;margin:0 0 16px}
.vz-page h2{font-size:clamp(26px,3vw,36px);line-height:1.15;margin:0 0 18px}
.vz-page h3{font-size:20px;margin:0 0 6px}
.vz-page .vz-lead{font-size:20px;opacity:.8;max-width:56ch;margin:0 0 28px}
.vz-page .vz-muted{opacity:.7}
.vz-page .vz-btn{display:inline-block;padding:12px 22px;border-radius:999px;background:var(--vz-accent);color:#fff;text-decoration:none;font-weight:600;border:0;cursor:pointer;font:inherit;font-weight:600}
.vz-page .vz-btn.vz-ghost{background:transparent;color:inherit;box-shadow:inset 0 0 0 1.5px currentColor}
.vz-page .vz-actions{display:flex;gap:12px;flex-wrap:wrap}
.vz-page .vz-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.vz-page .vz-card{border:1px solid var(--vz-line);border-radius:16px;padding:22px;background:rgba(255,255,255,.55)}
.vz-page .vz-pic{border-radius:12px;background:linear-gradient(135deg,rgba(127,127,127,.28),rgba(127,127,127,.1));min-height:160px}
@media (max-width:760px){.vz-page .vz-grid{grid-template-columns:1fr}.vz-page .vz-section{padding:48px 0}}`;

export const TEMPLATES: readonly PageTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'An empty page with your header and footer. Start from nothing.',
    title: 'New page',
    body: `<section class="vz-section">
  <div class="vz-wrap">
    <h1>{{title}}</h1>
  </div>
</section>`,
    css: `.vz-page.vz-blank{min-height:50vh}`,
  },
  {
    id: 'landing',
    name: 'Landing page',
    description: 'A big headline, three features, a quote and a call to action.',
    title: 'Welcome',
    body: `<section class="vz-section vz-hero">
  <div class="vz-wrap">
    <h1>A clear headline that says what you do</h1>
    <p class="vz-lead">One or two sentences that explain who this is for and why they should care. Keep it short and specific.</p>
    <div class="vz-actions">
      <a class="vz-btn" href="#get-started">Get started</a>
      <a class="vz-btn vz-ghost" href="#features">Learn more</a>
    </div>
  </div>
</section>
<section class="vz-section" id="features">
  <div class="vz-wrap">
    <h2>Why people choose us</h2>
    <div class="vz-grid">
      <div class="vz-card">
        <h3>First benefit</h3>
        <p class="vz-muted">Describe one thing you do better than anyone else, in a sentence or two.</p>
      </div>
      <div class="vz-card">
        <h3>Second benefit</h3>
        <p class="vz-muted">Say what problem it solves, not just what it is.</p>
      </div>
      <div class="vz-card">
        <h3>Third benefit</h3>
        <p class="vz-muted">Something people are pleasantly surprised by.</p>
      </div>
    </div>
  </div>
</section>
<section class="vz-section vz-tint">
  <div class="vz-wrap">
    <blockquote class="vz-quote">“A short quote from a happy customer goes here. It says more than any feature list.”</blockquote>
    <p class="vz-muted">Customer name, where they are from</p>
  </div>
</section>
<section class="vz-section vz-cta" id="get-started">
  <div class="vz-wrap">
    <h2>Ready to begin?</h2>
    <p class="vz-lead">Tell visitors exactly what to do next.</p>
    <a class="vz-btn" href="#">Contact us</a>
  </div>
</section>`,
    css: `.vz-page.vz-landing .vz-hero{padding:110px 0 90px}
.vz-page.vz-landing .vz-hero h1{max-width:16ch}
.vz-page.vz-landing .vz-quote{font-size:clamp(22px,2.6vw,30px);line-height:1.35;margin:0 0 12px;max-width:40ch}
.vz-page.vz-landing .vz-cta{text-align:center}
.vz-page.vz-landing .vz-cta .vz-lead{margin-left:auto;margin-right:auto}`,
  },
  {
    id: 'about',
    name: 'About / team',
    description: 'Your story, a short timeline and the people behind it.',
    title: 'About us',
    body: `<section class="vz-section">
  <div class="vz-wrap">
    <h1>{{title}}</h1>
    <p class="vz-lead">How it started, what you care about, and why you do this work. Two or three honest sentences are enough.</p>
  </div>
</section>
<section class="vz-section vz-tint">
  <div class="vz-wrap">
    <h2>Our story so far</h2>
    <ol class="vz-timeline">
      <li><b>2020</b>Where it began.</li>
      <li><b>2022</b>A milestone worth mentioning.</li>
      <li><b>2024</b>Where you are today.</li>
    </ol>
  </div>
</section>
<section class="vz-section">
  <div class="vz-wrap">
    <h2>The team</h2>
    <div class="vz-grid">
      <div class="vz-person">
        <div class="vz-face">A</div>
        <h3>First person</h3>
        <p class="vz-muted">Role, and one line about them.</p>
      </div>
      <div class="vz-person">
        <div class="vz-face">B</div>
        <h3>Second person</h3>
        <p class="vz-muted">Role, and one line about them.</p>
      </div>
      <div class="vz-person">
        <div class="vz-face">C</div>
        <h3>Third person</h3>
        <p class="vz-muted">Role, and one line about them.</p>
      </div>
    </div>
  </div>
</section>`,
    css: `.vz-page.vz-about .vz-timeline{list-style:none;margin:0;padding:0 0 0 22px;border-left:2px solid var(--vz-line)}
.vz-page.vz-about .vz-timeline li{margin:0 0 20px}
.vz-page.vz-about .vz-timeline b{display:block;color:var(--vz-accent)}
.vz-page.vz-about .vz-face{width:88px;height:88px;border-radius:50%;display:grid;place-items:center;font-size:30px;font-weight:700;color:#fff;background:var(--vz-accent);margin-bottom:12px}`,
  },
  {
    id: 'contact',
    name: 'Contact',
    description: 'A message form beside your address, hours and phone.',
    title: 'Contact',
    body: `<section class="vz-section">
  <div class="vz-wrap vz-split">
    <div>
      <h1>{{title}}</h1>
      <p class="vz-lead">Questions, bookings or just saying hello. We reply within a day.</p>
      <form class="vz-form" action="#" method="post">
        <label>Your name<input name="name" placeholder="Jane Doe"></label>
        <label>Email<input name="email" type="email" placeholder="you@example.com"></label>
        <label>Message<textarea name="message" rows="5" placeholder="How can we help?"></textarea></label>
        <button class="vz-btn" type="submit">Send message</button>
      </form>
    </div>
    <aside class="vz-card vz-details">
      <h3>Visit</h3>
      <p class="vz-muted">123 Example Street<br>Your City</p>
      <h3>Hours</h3>
      <p class="vz-muted">Monday to Friday, 9am to 5pm</p>
      <h3>Call or write</h3>
      <p class="vz-muted">(555) 010-0000<br>hello@example.com</p>
      <div class="vz-pic vz-map">Map</div>
    </aside>
  </div>
</section>`,
    css: `.vz-page.vz-contact .vz-split{display:grid;grid-template-columns:1.3fr 1fr;gap:40px;align-items:start}
.vz-page.vz-contact .vz-form{display:grid;gap:14px;max-width:520px}
.vz-page.vz-contact .vz-form label{display:grid;gap:6px;font-weight:600;font-size:14px}
.vz-page.vz-contact .vz-form input,.vz-page.vz-contact .vz-form textarea{font:inherit;font-weight:400;padding:12px 14px;border-radius:10px;border:1px solid var(--vz-line);background:#fff}
.vz-page.vz-contact .vz-form .vz-btn{justify-self:start}
.vz-page.vz-contact .vz-details h3{margin-top:14px}
.vz-page.vz-contact .vz-map{display:grid;place-items:center;margin-top:18px;opacity:.7}
@media (max-width:760px){.vz-page.vz-contact .vz-split{grid-template-columns:1fr}}`,
  },
  {
    id: 'pricing',
    name: 'Pricing',
    description: 'Three plans side by side, the middle one highlighted, and FAQs.',
    title: 'Pricing',
    body: `<section class="vz-section">
  <div class="vz-wrap">
    <h1>{{title}}</h1>
    <p class="vz-lead">Simple plans. Change or cancel any time.</p>
    <div class="vz-grid vz-plans">
      <div class="vz-card">
        <h3>Starter</h3>
        <p class="vz-price">$9<span>/month</span></p>
        <ul><li>First feature</li><li>Second feature</li><li>Email support</li></ul>
        <a class="vz-btn vz-ghost" href="#">Choose Starter</a>
      </div>
      <div class="vz-card vz-featured">
        <p class="vz-badge">Most popular</p>
        <h3>Standard</h3>
        <p class="vz-price">$29<span>/month</span></p>
        <ul><li>Everything in Starter</li><li>A bigger feature</li><li>Priority support</li></ul>
        <a class="vz-btn" href="#">Choose Standard</a>
      </div>
      <div class="vz-card">
        <h3>Pro</h3>
        <p class="vz-price">$79<span>/month</span></p>
        <ul><li>Everything in Standard</li><li>Advanced feature</li><li>A named contact</li></ul>
        <a class="vz-btn vz-ghost" href="#">Choose Pro</a>
      </div>
    </div>
  </div>
</section>
<section class="vz-section vz-tint">
  <div class="vz-wrap">
    <h2>Questions</h2>
    <details><summary>Can I change plans later?</summary><p class="vz-muted">Yes. Changes apply from your next billing date.</p></details>
    <details><summary>Is there a free trial?</summary><p class="vz-muted">Explain your trial or money-back promise here.</p></details>
    <details><summary>How do I cancel?</summary><p class="vz-muted">Tell people it is easy, and how.</p></details>
  </div>
</section>`,
    css: `.vz-page.vz-pricing .vz-plans{align-items:stretch;margin-top:12px}
.vz-page.vz-pricing .vz-card{display:flex;flex-direction:column}
.vz-page.vz-pricing .vz-card ul{padding-left:18px;margin:0 0 22px;flex:1}
.vz-page.vz-pricing .vz-card li{margin:6px 0}
.vz-page.vz-pricing .vz-price{font-size:40px;font-weight:700;margin:6px 0 14px}
.vz-page.vz-pricing .vz-price span{font-size:15px;font-weight:400;opacity:.7}
.vz-page.vz-pricing .vz-featured{box-shadow:0 0 0 2px var(--vz-accent),0 12px 30px rgba(0,0,0,.08)}
.vz-page.vz-pricing .vz-badge{margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--vz-accent)}
.vz-page.vz-pricing details{border-bottom:1px solid var(--vz-line);padding:14px 0}
.vz-page.vz-pricing summary{cursor:pointer;font-weight:600}`,
  },
  {
    id: 'menu',
    name: 'Menu / products',
    description: 'A grid of items with pictures, descriptions, prices and buttons.',
    title: 'Menu',
    body: `<section class="vz-section">
  <div class="vz-wrap">
    <h1>{{title}}</h1>
    <p class="vz-lead">A sentence about what is on offer and how to order.</p>
    <h2>First category</h2>
    <div class="vz-grid">
      <article class="vz-card vz-item">
        <div class="vz-pic"></div>
        <h3>Item name</h3>
        <p class="vz-muted">A short, tempting description.</p>
        <p class="vz-row"><b>$10</b><a class="vz-btn" href="#">Add</a></p>
      </article>
      <article class="vz-card vz-item">
        <div class="vz-pic"></div>
        <h3>Item name</h3>
        <p class="vz-muted">A short, tempting description.</p>
        <p class="vz-row"><b>$12</b><a class="vz-btn" href="#">Add</a></p>
      </article>
      <article class="vz-card vz-item">
        <div class="vz-pic"></div>
        <h3>Item name</h3>
        <p class="vz-muted">A short, tempting description.</p>
        <p class="vz-row"><b>$8</b><a class="vz-btn" href="#">Add</a></p>
      </article>
    </div>
  </div>
</section>`,
    css: `.vz-page.vz-menu h2{margin-top:36px}
.vz-page.vz-menu .vz-item{padding:0;overflow:hidden}
.vz-page.vz-menu .vz-item .vz-pic{border-radius:0}
.vz-page.vz-menu .vz-item h3,.vz-page.vz-menu .vz-item p{margin-left:20px;margin-right:20px}
.vz-page.vz-menu .vz-item h3{margin-top:16px}
.vz-page.vz-menu .vz-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
.vz-page.vz-menu .vz-row .vz-btn{padding:8px 16px}`,
  },
  {
    id: 'blog',
    name: 'Blog post',
    description: 'An article with a title, author, picture, quote and related posts.',
    title: 'Blog post',
    body: `<article class="vz-section vz-post">
  <div class="vz-wrap">
    <p class="vz-meta">Category · 5 minute read</p>
    <h1>{{title}}</h1>
    <p class="vz-byline">By Author Name · January 1, 2025</p>
    <div class="vz-pic vz-cover"></div>
    <p class="vz-lead">The opening paragraph that makes people want to keep reading.</p>
    <h2>A section heading</h2>
    <p>Write the body of your post here. Short paragraphs are easier to read on screens, and a heading every few paragraphs helps people find their place.</p>
    <blockquote>“A line worth pulling out and showing bigger.”</blockquote>
    <h2>Another section</h2>
    <p>Keep going. Double-click any of this text on the canvas to change it.</p>
  </div>
</article>
<section class="vz-section vz-tint">
  <div class="vz-wrap">
    <h2>Keep reading</h2>
    <div class="vz-grid">
      <a class="vz-card vz-related" href="#"><h3>Another post title</h3><p class="vz-muted">A one-line summary.</p></a>
      <a class="vz-card vz-related" href="#"><h3>Another post title</h3><p class="vz-muted">A one-line summary.</p></a>
      <a class="vz-card vz-related" href="#"><h3>Another post title</h3><p class="vz-muted">A one-line summary.</p></a>
    </div>
  </div>
</section>`,
    css: `.vz-page.vz-blog .vz-post .vz-wrap{max-width:740px}
.vz-page.vz-blog .vz-meta{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--vz-accent);margin:0 0 10px}
.vz-page.vz-blog .vz-byline{opacity:.7;margin:0 0 26px}
.vz-page.vz-blog .vz-cover{min-height:320px;margin:0 0 28px}
.vz-page.vz-blog .vz-post p{font-size:18px;line-height:1.7}
.vz-page.vz-blog .vz-post h2{margin-top:36px}
.vz-page.vz-blog blockquote{margin:30px 0;padding-left:20px;border-left:4px solid var(--vz-accent);font-size:24px;line-height:1.4}
.vz-page.vz-blog .vz-related{text-decoration:none;color:inherit}`,
  },
];

export function templateById(id: string): PageTemplate | undefined {
  return TEMPLATES.find(t => t.id === id);
}

/** "Our Team!" → "our-team". */
export function slugify(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return slug || 'page';
}

/** A path from one file to another, for an href: `blog/post.html` → `about.html` is `../about.html`. */
export function relativeHref(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1);
  const to = toFile.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) { i++; }
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function firstElement(html: string, tag: string, from = 0, to = html.length): { start: number; end: number; openEnd: number; closeStart: number } | null {
  const re = new RegExp(`<${tag}\\b`, 'gi');
  re.lastIndex = from;
  for (let m = re.exec(html); m && m.index < to; m = re.exec(html)) {
    const el = elementAt(html, m.index);
    if (el && el.closeStart >= 0) { return el; }
  }
  return null;
}

/** "Home · Juniper & Rye" with a new page name → "Pricing · Juniper & Rye". */
export function retitle(oldTitle: string, name: string): string {
  const m = /^(.*?)(\s+[·|•–—-]\s+)(.+)$/.exec(oldTitle.trim());
  return m ? `${name}${m[2]}${m[3]}` : name;
}

export interface BuiltPage { html: string; title: string }

/**
 * A whole page from a template.
 *
 * With `shell` (the HTML of a page the site already has), everything outside
 * that page's <main> is kept: the <head>, header and navigation, footer and
 * scripts. Without a <main>, the first <header> (or <nav>) and <footer> are
 * kept. Without a shell, the page stands on its own with a plain base style.
 */
export function buildPage(template: PageTemplate, name: string, shell?: string | null): BuiltPage {
  const clean = name.trim() || template.title;
  const body = template.body.replace(/\{\{title\}\}/g, escapeText(clean));
  const style = `<style data-vibez-template="${template.id}">\n${BASE_CSS}\n${template.css}\n</style>`;
  const main = `<main class="vz-page vz-${template.id}">\n${body.split('\n').map(l => '    ' + l).join('\n')}\n  </main>`;

  if (!shell || !/<body\b/i.test(shell)) {
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeText(clean)}</title>
  ${style}
  <style>body{margin:0;font:17px/1.6 -apple-system,system-ui,"Segoe UI",sans-serif;color:#1f2328;background:#fff}</style>
</head>
<body>
  ${main}
</body>
</html>
`;
    return { html, title: clean };
  }

  const oldTitle = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(shell)?.[1]?.trim() ?? '';
  const title = oldTitle ? retitle(oldTitle.replace(/&amp;/g, '&'), clean) : clean;
  let html = shell;
  const found = firstElement(html, 'main');
  if (found) {
    html = html.slice(0, found.start) + main + html.slice(found.end);
  } else {
    const bodyEl = firstElement(html, 'body');
    if (!bodyEl) { return buildPage(template, name, null); }
    const inner = html.slice(bodyEl.openEnd, bodyEl.closeStart);
    const top = firstElement(inner, 'header') ?? firstElement(inner, 'nav');
    const foot = firstElement(inner, 'footer');
    const scripts = [...inner.matchAll(/<script\b[^>]*\bsrc=[^>]*>\s*<\/script>/gi)].map(m => m[0]);
    const parts = [
      top ? '  ' + inner.slice(top.start, top.end) : '',
      '  ' + main,
      foot ? '  ' + inner.slice(foot.start, foot.end) : '',
      ...scripts.map(s => '  ' + s),
    ].filter(Boolean);
    html = html.slice(0, bodyEl.openEnd) + '\n' + parts.join('\n') + '\n' + html.slice(bodyEl.closeStart);
  }
  html = html.replace(/<title([^>]*)>[\s\S]*?<\/title>/i, (_all, attrs: string) => `<title${attrs}>${escapeText(title)}</title>`);
  html = html.replace(/\s+aria-current=("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  html = /<\/head>/i.test(html) ? html.replace(/(\s*)<\/head>/i, (all, space: string) => `${space}  ${style}${space}</head>`) : style + html;
  return { html, title };
}

/**
 * Adds a link to the page's navigation, copying how the other links there
 * are written (their classes, and any <li> around them). Returns null when
 * the page has no <nav>, or already links there.
 */
export function addNavLink(html: string, href: string, label: string): string | null {
  const nav = firstElement(html, 'nav');
  if (!nav) { return null; }
  const inner = html.slice(nav.openEnd, nav.closeStart);
  const hrefs = [...inner.matchAll(/<a\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)].map(m => m[2] ?? m[3] ?? m[4] ?? '');
  if (hrefs.some(h => h.split(/[?#]/)[0] === href)) { return null; }

  // The last link (or the <li> holding it) is the model for the new one.
  let model: { start: number; end: number } | null = null;
  let isItem = false;
  const items = [...inner.matchAll(/<li\b/gi)].map(m => elementAt(html, nav.openEnd + m.index!)).filter(Boolean);
  const anchors = [...inner.matchAll(/<a\b/gi)].map(m => elementAt(html, nav.openEnd + m.index!)).filter(a => a && a.closeStart >= 0);
  const last = anchors[anchors.length - 1];
  if (last) {
    const li = items.filter(i => i!.closeStart >= 0 && i!.start < last.start && i!.end >= last.end).pop();
    model = li ?? last;
    isItem = !!li;
  }
  const text = escapeText(label);
  let piece: string;
  if (model) {
    const source = html.slice(model.start, model.end);
    const anchorSource = isItem ? html.slice(last!.start, last!.end) : source;
    const open = /^<a\b[^>]*>/i.exec(anchorSource)![0]
      .replace(/\s+aria-current=("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+href\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, ` href="${href.replace(/"/g, '&quot;')}"`)
      .replace(/\s+class\s*=\s*("[^"]*"|'[^']*')/i, (all) => all.replace(/\b(active|current|is-active|selected)\b/g, '').replace(/\s+"/, '"').replace(/"\s+/, '"'));
    const withHref = /\shref=/.test(open) ? open : open.replace(/^<a\b/i, `<a href="${href.replace(/"/g, '&quot;')}"`);
    const anchor = `${withHref}${text}</a>`;
    piece = isItem ? source.replace(anchorSource, anchor).replace(/\s+aria-current=("[^"]*"|'[^']*'|[^\s>]+)/gi, '') : anchor;
    const lineStart = html.lastIndexOf('\n', model.start - 1) + 1;
    const indent = html.slice(lineStart, model.start);
    if (indent.trim() === '') {
      return html.slice(0, model.end) + '\n' + indent + piece + html.slice(model.end);
    }
    return html.slice(0, model.end) + ' ' + piece + html.slice(model.end);
  }
  piece = `<a href="${href.replace(/"/g, '&quot;')}">${text}</a>`;
  return html.slice(0, nav.closeStart) + piece + html.slice(nav.closeStart);
}

function hrefsOf(tagSource: string): string | null {
  const m = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tagSource);
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null;
}

/**
 * Takes the links to `href` out of the page's first `<nav>`: the reverse of
 * `addNavLink`. A link alone in its `<li>` takes the `<li>` with it. Returns
 * null when the navigation has no such link.
 */
export function removeNavLink(html: string, href: string): string | null {
  const nav = firstElement(html, 'nav');
  if (!nav) { return null; }
  const inner = html.slice(nav.openEnd, nav.closeStart);
  const targets: { at: number; tag: string }[] = [];
  for (const m of inner.matchAll(/<a\b[^>]*>/gi)) {
    const at = nav.openEnd + m.index!;
    if ((hrefsOf(m[0]) ?? '').split(/[?#]/)[0] !== href) { continue; }
    const anchor = elementAt(html, at);
    if (!anchor || anchor.closeStart < 0) { continue; }
    // Alone in an <li>: the item goes, not just the link.
    const items = [...inner.matchAll(/<li\b/gi)].map(li => elementAt(html, nav.openEnd + li.index!)).filter(Boolean);
    const li = items.filter(i => i!.closeStart >= 0 && i!.start < anchor.start && i!.end >= anchor.end).pop();
    const alone = li && html.slice(li.openEnd, li.closeStart).trim() === html.slice(anchor.start, anchor.end);
    targets.push(alone ? { at: li!.start, tag: 'li' } : { at, tag: 'a' });
  }
  if (!targets.length) { return null; }
  let out = html;
  for (const t of targets.sort((a, b) => b.at - a.at)) {
    out = removeElement(out, t.at, t.tag);
  }
  return out;
}

/** How many links on the page, outside its navigation, still lead to `href`. */
export function linksTo(html: string, href: string): number {
  const nav = firstElement(html, 'nav');
  let count = 0;
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    if (nav && m.index! >= nav.start && m.index! < nav.end) { continue; }
    if ((hrefsOf(m[0]) ?? '').split(/[?#]/)[0] === href) { count++; }
  }
  return count;
}
