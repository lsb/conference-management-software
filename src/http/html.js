// HTML rendering.
//
// A tagged template that escapes every interpolation by default. The only way to
// inject markup is to opt in with `raw()`, so a speaker biography containing
// `<script>` is inert everywhere without anyone having to remember to escape it.
//
//   html`<h1>${event.name}</h1>`          escaped
//   html`<div>${raw(renderedMarkdown)}</div>`  trusted, and visibly so

const ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Markup that is already safe. Wrapping a string here is the audit point. */
export class SafeHtml {
  constructor(value) {
    this.value = String(value);
  }
  toString() {
    return this.value;
  }
}

export function raw(value) {
  return new SafeHtml(value);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + strings[i + 1];
  }
  return new SafeHtml(out);
}

function render(value) {
  if (value == null || value === false) return '';
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return escapeHtml(value);
}

/** Join a list of values with a separator, escaping each. */
export function join(values, separator = '') {
  return raw(values.map(render).join(separator));
}

/**
 * A full page.
 *
 * Deliberately one stylesheet, inlined. Every action on every page is a link or
 * a form submission, so the whole app works with scripting off, over `curl`, and
 * for anything driving it programmatically.
 *
 * `script` exists for progressive enhancement only -- something that makes a
 * page nicer and that nothing depends on. If a page stops working without it,
 * the script is doing too much.
 */
export function page({ title, nav = null, body, wide = false, script = null }) {
  return new SafeHtml(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body>
${nav ? render(nav) : ''}
<main class="${wide ? 'wide' : ''}">
${render(body)}
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>
`);
}

const STYLES = `
:root {
  --bg: #ffffff; --fg: #16181d; --muted: #5b6472; --line: #dfe3e8;
  --accent: #1f52c8; --accent-fg: #ffffff; --panel: #f7f8fa;
  --ok-bg: #e3f5e9; --ok-fg: #10632f;
  --wait-bg: #fdf1d8; --wait-fg: #7a5210;
  --stop-bg: #fbe4e4; --stop-fg: #8c1c1c;
  --info-bg: #e6edfb; --info-fg: #1b3f8f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14161a; --fg: #e9ecf1; --muted: #98a2b3; --line: #2c3038;
    --accent: #7ba2ff; --accent-fg: #10131a; --panel: #1b1e24;
    --ok-bg: #14361f; --ok-fg: #86e0a4;
    --wait-bg: #3a2e12; --wait-fg: #f0c66b;
    --stop-bg: #3d1b1b; --stop-fg: #f2a0a0;
    --info-bg: #1a2542; --info-fg: #a8c3ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 60rem; margin: 0 auto; padding: 1.5rem 1.25rem 4rem; }
main.wide { max-width: 84rem; }
a { color: var(--accent); }
h1 { font-size: 1.5rem; margin: 0 0 .25rem; }
h2 { font-size: 1.15rem; margin: 2rem 0 .5rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
p.sub { color: var(--muted); margin: 0 0 1.5rem; }

header.bar { border-bottom: 1px solid var(--line); background: var(--panel); }
header.bar .inner {
  max-width: 84rem; margin: 0 auto; padding: .6rem 1.25rem;
  display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap;
}
header.bar strong { font-size: .95rem; }
header.bar nav { display: flex; gap: .9rem; flex-wrap: wrap; }
header.bar nav a { color: var(--fg); text-decoration: none; font-size: .9rem; }
header.bar nav a:hover, header.bar nav a[aria-current] { color: var(--accent); text-decoration: underline; }
header.bar .spacer { flex: 1; }
header.bar .who { color: var(--muted); font-size: .85rem; }

nav.tabs { display: flex; gap: .25rem; flex-wrap: wrap; border-bottom: 1px solid var(--line); margin: 1rem 0 1.25rem; }
nav.tabs a {
  padding: .4rem .7rem; text-decoration: none; color: var(--muted);
  border-bottom: 2px solid transparent; font-size: .9rem;
}
nav.tabs a[aria-current] { color: var(--fg); border-bottom-color: var(--accent); font-weight: 600; }
nav.tabs .count { color: var(--muted); font-variant-numeric: tabular-nums; }

table { border-collapse: collapse; width: 100%; font-size: .9rem; }
.scroll { overflow-x: auto; }
th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
tbody tr:hover { background: var(--panel); }
td.num { text-align: right; font-variant-numeric: tabular-nums; }

.pill {
  display: inline-block; padding: .1rem .5rem; border-radius: 999px;
  font-size: .75rem; font-weight: 600; white-space: nowrap;
}
.pill.accepted, .pill.done { background: var(--ok-bg); color: var(--ok-fg); }
.pill.accept_queue { background: var(--ok-bg); color: var(--ok-fg); opacity: .75; }
.pill.pending, .pill.todo { background: var(--wait-bg); color: var(--wait-fg); }
.pill.declined, .pill.withdrawn { background: var(--stop-bg); color: var(--stop-fg); }
.pill.decline_queue { background: var(--stop-bg); color: var(--stop-fg); opacity: .75; }
.pill.draft { background: var(--panel); color: var(--muted); }

.cards { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); margin: 1rem 0; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: .75rem .9rem; background: var(--panel); }
.card .n { font-size: 1.6rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.card .label { color: var(--muted); font-size: .8rem; }
.card a { text-decoration: none; }

ul.alerts { list-style: none; padding: 0; margin: 1rem 0; display: grid; gap: .4rem; }
ul.alerts li { padding: .55rem .8rem; border-radius: 6px; background: var(--info-bg); color: var(--info-fg); font-size: .9rem; }
ul.alerts li.warn { background: var(--wait-bg); color: var(--wait-fg); }
ul.alerts li.stop { background: var(--stop-bg); color: var(--stop-fg); }

form.inline { display: inline; }
fieldset { border: 1px solid var(--line); border-radius: 8px; padding: 1rem; margin: 0 0 1.25rem; }
legend { font-weight: 600; padding: 0 .4rem; }
label { display: block; margin: .9rem 0 .25rem; font-weight: 600; font-size: .9rem; }
label .req { color: var(--stop-fg); }
label small { display: block; font-weight: 400; color: var(--muted); }
input[type=text], input[type=email], input[type=url], input[type=tel],
input[type=number], input[type=date], input[type=datetime-local], select, textarea {
  width: 100%; padding: .45rem .55rem; font: inherit; font-size: .95rem;
  border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg);
}
textarea { min-height: 7rem; resize: vertical; }
button, .button {
  font: inherit; font-size: .9rem; font-weight: 600; padding: .45rem .9rem;
  border-radius: 6px; border: 1px solid var(--accent); cursor: pointer;
  background: var(--accent); color: var(--accent-fg); text-decoration: none; display: inline-block;
}
button.secondary, .button.secondary { background: transparent; color: var(--accent); }
button.danger { background: var(--stop-fg); border-color: var(--stop-fg); color: #fff; }
.actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1rem; }

.empty { padding: 2.5rem 1rem; text-align: center; color: var(--muted); border: 1px dashed var(--line); border-radius: 8px; }
.flash { padding: .6rem .8rem; border-radius: 6px; margin: 0 0 1rem; background: var(--ok-bg); color: var(--ok-fg); }
.flash.error { background: var(--stop-bg); color: var(--stop-fg); }
code, kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .87em; }
.muted { color: var(--muted); }
.stack { display: grid; gap: 1rem; }
.row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; }
.row > * { flex: 1 1 12rem; }
.grid2 { display: grid; gap: 1rem 1.5rem; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); }
`;
