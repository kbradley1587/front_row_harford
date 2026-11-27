#!/usr/bin/env node
/**
 * build-recaps.js  —  "After the Applause" show recaps
 *
 * Reads every recap in _data/recaps/ (front matter + Markdown body, as Decap saves
 * them), and produces:
 *   recaps.json            — all recaps, newest first, body converted to HTML
 *   recaps/<slug>.html     — one static page per recap (from templates/recap-page.html)
 *   shows.json (updated)   — each show that has a recap gets recap_url + recap_title
 *
 * Runs after build-shows.js on every Netlify deploy (see netlify.toml).
 * No manual step; publishing a recap in the CMS is all it takes.
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const RECAPS_DIR = path.join(ROOT, '_data', 'recaps');
const SHOWS_JSON = path.join(ROOT, 'shows.json');
const OUT_JSON   = path.join(ROOT, 'recaps.json');
const OUT_DIR    = path.join(ROOT, 'recaps');
const TEMPLATE   = path.join(ROOT, 'templates', 'recap-page.html');
const SITE_URL   = 'https://frontrowmaryland.com';

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function strip(v) { return String(v == null ? '' : v).trim().replace(/^["']|["']$/g, ''); }

// ---- front matter + body ---------------------------------------------------
function parse(text) {
  const m = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const data = {};
  m[1].split(/\r?\n/).forEach(line => {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) data[kv[1]] = strip(kv[2]);
  });
  data.body = m[2].trim();
  return data;
}

// ---- tiny Markdown -> HTML (paragraphs, bold, italics, links, simple lists) --
function inline(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+?)\*/g, '$1<em>$2</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function markdown(md) {
  const blocks = String(md || '').replace(/\r\n/g, '\n').split(/\n{2,}/);
  return blocks.map(b => {
    const lines = b.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.every(l => /^[-*]\s+/.test(l))) return '<ul>' + lines.map(l => '<li>' + inline(l.replace(/^[-*]\s+/, '')) + '</li>').join('') + '</ul>';
    const h = lines[0].match(/^(#{1,3})\s+(.*)$/);
    if (h && lines.length === 1) return '<h' + (h[1].length + 1) + '>' + inline(h[2]) + '</h' + (h[1].length + 1) + '>';
    if (/^>\s?/.test(lines[0])) return '<blockquote>' + inline(lines.map(l => l.replace(/^>\s?/, '')).join(' ')) + '</blockquote>';
    return '<p>' + lines.map(inline).join('<br>') + '</p>';
  }).join('\n');
}

function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso || '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

function fill(tpl, vars) { return tpl.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, k) => vars[k] != null ? vars[k] : ''); }

// ---- main ----------------------------------------------------------------
function build() {
  const showsPayload = fs.existsSync(SHOWS_JSON) ? JSON.parse(fs.readFileSync(SHOWS_JSON, 'utf8')) : { shows: [] };
  const showsBySlug = {};
  (showsPayload.shows || []).forEach(s => { if (s.source_file) showsBySlug[s.source_file.replace(/\.(md|json)$/, '')] = s; });

  const files = fs.existsSync(RECAPS_DIR) ? fs.readdirSync(RECAPS_DIR).filter(f => f.endsWith('.md')) : [];
  const recaps = [];

  files.forEach(file => {
    const data = parse(fs.readFileSync(path.join(RECAPS_DIR, file), 'utf8'));
    if (!data || !data.title) { console.warn(`  ⚠ recaps/${file}: no title — skipped`); return; }
    if (String(data.published).toLowerCase() === 'false') { console.log(`  · recaps/${file}: unpublished — skipped`); return; }

    const slug = file.replace(/\.md$/, '');
    const show = data.show ? showsBySlug[data.show] : null;
    if (data.show && !show) console.warn(`  ⚠ recaps/${file}: show "${data.show}" not found in shows.json`);

    const r = {
      slug,
      url: `/recaps/${slug}.html`,
      title: data.title,
      show_slug: data.show || '',
      show_title: data.show_title || (show && show.title) || data.title,
      organization: data.organization || (show && show.organization) || '',
      venue: data.venue || (show && show.venue) || '',
      city: data.city || (show && show.city) || '',
      county: show ? show.county : (data.county || ''),
      image: data.image || (show && show.image) || '',
      author: data.author || 'Front Row Maryland',
      date_attended: data.date_attended || '',
      date_attended_label: fmtDate(data.date_attended),
      date_published: data.date || data.date_attended || '',
      summary: data.summary || '',
      body_html: markdown(data.body),
      recognition_html: data.recognition ? markdown(data.recognition) : '',
      ticket_url: show ? show.ticket_url : ''
    };
    recaps.push(r);

    if (show) { show.recap_url = r.url; show.recap_title = r.title; }
  });

  recaps.sort((a, b) => String(b.date_published).localeCompare(String(a.date_published)));

  // recaps.json for the listing page
  fs.writeFileSync(OUT_JSON, JSON.stringify({ recaps, built_at: new Date().toISOString() }, null, 2));

  // shows.json gains recap_url / recap_title
  if (fs.existsSync(SHOWS_JSON)) fs.writeFileSync(SHOWS_JSON, JSON.stringify(showsPayload, null, 2));

  // one static page per recap
  if (!fs.existsSync(TEMPLATE)) { console.warn('templates/recap-page.html missing — no recap pages generated'); }
  else {
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    recaps.forEach(r => {
      const plain = r.body_html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const description = r.summary || plain.slice(0, 155).replace(/\s\S*$/, '') + '…';
      const html = fill(tpl, {
        title: esc(r.title), show_title: esc(r.show_title), organization: esc(r.organization),
        venue_line: esc([r.venue, r.city].filter(Boolean).join(' · ')),
        author: esc(r.author), date_attended: esc(r.date_attended_label),
        image: esc(r.image), image_block: r.image ? `<img class="recap-hero" src="${esc(r.image)}" alt="${esc(r.show_title)}">` : '',
        body: r.body_html,
        recognition_block: r.recognition_html ? `<section class="recognition"><h2>Recognition</h2>${r.recognition_html}</section>` : '',
        description: esc(description), canonical: SITE_URL + r.url,
        og_image: r.image ? SITE_URL + r.image : SITE_URL + '/Front%20Row%20Logo%20v5.jpg'
      });
      fs.writeFileSync(path.join(OUT_DIR, r.slug + '.html'), html);
    });
  }

  console.log(`Built recaps.json: ${recaps.length} recap(s); ${recaps.filter(r => r.show_slug && showsBySlug[r.show_slug]).length} linked to a show.`);
}

build();
