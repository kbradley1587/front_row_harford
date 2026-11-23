#!/usr/bin/env node
/**
 * build-weekly-email.js
 * Builds the "This Weekend on Maryland Stages" email from shows.json and,
 * when asked, hands it to Kit (kit.com) to send to every subscriber.
 *
 *   node scripts/build-weekly-email.js            -> writes weekly-email-preview.html only
 *   node scripts/build-weekly-email.js --send     -> also creates + schedules the Kit broadcast
 *
 * Environment (set as GitHub Actions secrets / variables):
 *   KIT_API_KEY        required for --send. Kit -> Settings -> Developer -> API Keys (v4).
 *   KIT_FROM_EMAIL     optional. Sending address; defaults to the Kit account's address.
 *   KIT_TEMPLATE_ID    optional. Kit email template id; defaults to the account default.
 *   SITE_URL           optional. Defaults to https://frontrowmaryland.com
 *   WEEKEND_START      optional. YYYY-MM-DD to force a window (testing). Default: upcoming Thursday.
 *
 * The weekend is Thursday through Sunday. Run on a Monday or Tuesday it picks the
 * Thursday of that same week. If no show has a performance in the window, nothing is sent.
 * Runs with TZ=America/New_York so "today" is Maryland's today.
 */

const fs   = require('fs');
const path = require('path');

const ROOT     = path.join(__dirname, '..');
const SHOWS    = path.join(ROOT, 'shows.json');
const PREVIEW  = path.join(ROOT, 'weekly-email-preview.html');
const SITE_URL = (process.env.SITE_URL || 'https://frontrowmaryland.com').replace(/\/$/, '');
const SEND     = process.argv.includes('--send');

const MONTH_INDEX = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, june:5, jul:6, july:6,
                      aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };
const MONTH_LABEL = ['Jan','Feb','Mar','Apr','May','June','July','Aug','Sept','Oct','Nov','Dec'];
const WEEKDAY     = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const COUNTY_LABEL = {
  harford:'Harford', cecil:'Cecil', 'baltimore-county':'Baltimore County', 'baltimore-city':'Baltimore City',
  carroll:'Carroll', wicomico:'Wicomico', worcester:'Worcester', 'st-marys':"St. Mary's",
  'anne-arundel':'Anne Arundel', washington:'Washington', frederick:'Frederick', howard:'Howard',
  'prince-georges':"Prince George's", montgomery:'Montgomery', calvert:'Calvert', charles:'Charles',
  'queen-annes':"Queen Anne's", talbot:'Talbot', kent:'Kent', dorchester:'Dorchester', caroline:'Caroline',
  somerset:'Somerset', allegany:'Allegany', garrett:'Garrett'
};

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function ymd(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function fmtTime(t) {
  const m = String(t || '').trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/);
  if (!m) return String(t || '');
  return m[1] + (m[2] && m[2] !== '00' ? ':' + m[2] : '') + ' ' + m[3].toUpperCase();
}

// ---- 1. The weekend window -------------------------------------------------
function weekendWindow() {
  let thu;
  if (process.env.WEEKEND_START) {
    const [y, m, d] = process.env.WEEKEND_START.split('-').map(Number);
    thu = new Date(y, m - 1, d);
  } else {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    thu = new Date(today);
    thu.setDate(today.getDate() + ((4 - today.getDay() + 7) % 7));   // next Thursday (today if Thursday)
  }
  const sun = new Date(thu); sun.setDate(thu.getDate() + 3); sun.setHours(23, 59, 59, 0);
  return { start: thu, end: sun };
}

// ---- 2. Collect the shows -------------------------------------------------
function collect(window) {
  const data = JSON.parse(fs.readFileSync(SHOWS, 'utf8'));
  const out = [];
  data.shows.forEach(s => {
    const perfs = (s.performances || []).map(p => {
      const mi = MONTH_INDEX[String(p.month).toLowerCase()];
      if (mi === undefined || !p.day || !p.year) return null;
      return { dt: new Date(p.year, mi, p.day), time: fmtTime(p.time) };
    }).filter(Boolean).filter(p => p.dt >= window.start && p.dt <= window.end)
      .sort((a, b) => a.dt - b.dt);
    if (!perfs.length) return;

    // group times by day: "Fri Nov 20 · 7 PM", "Sat Nov 21 · 2 & 7 PM"
    const days = [];
    perfs.forEach(p => {
      const key = ymd(p.dt);
      let d = days.find(x => x.key === key);
      if (!d) { d = { key, dt: p.dt, times: [] }; days.push(d); }
      if (!d.times.includes(p.time)) d.times.push(p.time);
    });
    const ticket = /^https?:\/\//i.test(String(s.ticket_url || '').trim()) ? s.ticket_url.trim() : '';
    out.push({
      title: String(s.title || '').trim(),
      org: String(s.organization || '').trim(),
      venue: String(s.venue || '').trim(),
      city: String(s.city || '').trim(),
      county: s.county,
      countyLabel: COUNTY_LABEL[s.county] || s.county,
      genre: s.genre, audience: s.audience, price: s.price || '',
      ticket, days, first: perfs[0].dt
    });
  });
  out.sort((a, b) => a.countyLabel.localeCompare(b.countyLabel) || a.first - b.first || a.title.localeCompare(b.title));
  return out;
}

// ---- 3. Render the email ---------------------------------------------------
function render(shows, window) {
  const gold = '#c9a24a', ink = '#1a1a1f', muted = '#6b6b78', line = '#e6e3da', bg = '#f6f4ee';
  const rangeLabel = MONTH_LABEL[window.start.getMonth()] + ' ' + window.start.getDate() + '–' +
    (window.end.getMonth() === window.start.getMonth() ? '' : MONTH_LABEL[window.end.getMonth()] + ' ') + window.end.getDate();
  const counties = [...new Set(shows.map(s => s.countyLabel))];

  const showBlock = s => `
    <tr><td style="padding:14px 0;border-bottom:1px solid ${line};">
      <div style="font-size:18px;font-weight:700;color:${ink};line-height:1.25;">${esc(s.title)}</div>
      <div style="font-size:14px;color:${ink};margin-top:2px;">${esc(s.org)}</div>
      <div style="font-size:13px;color:${muted};margin-top:1px;">${esc(s.venue)}${s.city ? ' · ' + esc(s.city) : ''}</div>
      <div style="font-size:14px;color:${ink};margin-top:8px;line-height:1.5;">
        ${s.days.map(d => `<span style="white-space:nowrap;"><strong>${WEEKDAY[d.dt.getDay()]} ${MONTH_LABEL[d.dt.getMonth()]} ${d.dt.getDate()}</strong> · ${esc(d.times.join(' & '))}</span>`).join('<br>')}
      </div>
      ${s.ticket ? `<div style="margin-top:10px;"><a href="${esc(s.ticket)}" style="display:inline-block;background:${gold};color:#111;text-decoration:none;font-weight:700;font-size:13px;padding:8px 16px;border-radius:999px;">Get Tickets</a></div>` : ''}
    </td></tr>`;

  const countySection = c => `
    <tr><td style="padding:26px 0 4px;">
      <div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:${gold};font-weight:700;border-bottom:2px solid ${gold};padding-bottom:6px;">${esc(c)}</div>
    </td></tr>
    ${shows.filter(s => s.countyLabel === c).map(showBlock).join('')}`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>This Weekend on Maryland Stages · ${esc(rangeLabel)}</title></head>
<body style="margin:0;padding:0;background:${bg};font-family:Poppins,'Segoe UI',Helvetica,Arial,sans-serif;color:${ink};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;">
  <tr><td style="background:#0f0f12;padding:26px 28px;">
    <div style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:${gold};font-weight:700;">Front Row Maryland</div>
    <div style="font-size:26px;font-weight:700;color:#ffffff;line-height:1.15;margin-top:6px;">This Weekend on Maryland Stages</div>
    <div style="font-size:15px;color:#c9c9d4;margin-top:6px;">${esc(rangeLabel)} · ${shows.length} production${shows.length === 1 ? '' : 's'} · ${counties.length} count${counties.length === 1 ? 'y' : 'ies'}</div>
  </td></tr>
  <tr><td style="padding:6px 28px 24px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      ${counties.map(countySection).join('')}
    </table>
    <div style="margin-top:28px;text-align:center;">
      <a href="${SITE_URL}/" style="display:inline-block;background:#0f0f12;color:${gold};text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:999px;">See every upcoming show →</a>
    </div>
  </td></tr>
  <tr><td style="background:${bg};padding:18px 28px;font-size:12px;color:${muted};line-height:1.6;text-align:center;">
    Dates and times come straight from the listings on <a href="${SITE_URL}/" style="color:${muted};">frontrowmaryland.com</a> as of this morning — always confirm with the box office.<br>
    Know a show we're missing? <a href="${SITE_URL}/submit.html" style="color:${muted};">Submit it free.</a><br><br>
    You're getting this because you signed up at frontrowmaryland.com.
    <a href="{{ unsubscribe_url }}" style="color:${muted};">Unsubscribe</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ---- 4. Send via Kit -------------------------------------------------------
// Has this week's email already been created? (The workflow runs on two backup
// schedules in case GitHub skips one; this makes a second run a safe no-op.)
async function alreadySentThisWeek(key, subject) {
  try {
    const res = await fetch('https://api.kit.com/v4/broadcasts?per_page=50', { headers: { 'X-Kit-Api-Key': key } });
    if (!res.ok) { console.warn(`Could not list broadcasts (${res.status}); proceeding.`); return false; }
    const json = await res.json();
    const cutoff = Date.now() - 20 * 60 * 60 * 1000;   // same-morning only: covers the backup run, never blocks a later day
    const dup = (json.broadcasts || []).find(b => b.subject === subject && new Date(b.created_at).getTime() > cutoff);
    if (dup) { console.log(`Broadcast #${dup.id} with this subject already exists (created ${dup.created_at}). Skipping send.`); return true; }
    return false;
  } catch (e) { console.warn('Could not check existing broadcasts: ' + e.message + '; proceeding.'); return false; }
}

async function sendViaKit(html, subject, previewText) {
  const key = process.env.KIT_API_KEY;
  if (!key) throw new Error('KIT_API_KEY is not set');
  if (await alreadySentThisWeek(key, subject)) return;
  const sendAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();   // 5 minutes from now
  const body = {
    subject, preview_text: previewText, description: subject,
    content: html, public: false, published_at: new Date().toISOString(),
    send_at: sendAt,
    subscriber_filter: []
  };
  if (process.env.KIT_FROM_EMAIL)  body.email_address = process.env.KIT_FROM_EMAIL;
  if (process.env.KIT_TEMPLATE_ID) body.email_template_id = Number(process.env.KIT_TEMPLATE_ID);

  const res = await fetch('https://api.kit.com/v4/broadcasts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Kit-Api-Key': key },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kit API ${res.status}: ${text}`);
  const json = JSON.parse(text);
  console.log(`Kit broadcast #${json.broadcast && json.broadcast.id} scheduled for ${sendAt} (UTC).`);
}

// ---- main ----------------------------------------------------------------
(async () => {
  if (!fs.existsSync(SHOWS)) { console.error('shows.json not found — run scripts/build-shows.js first'); process.exit(1); }
  const window = weekendWindow();
  const shows  = collect(window);
  const label  = MONTH_LABEL[window.start.getMonth()] + ' ' + window.start.getDate() + '–' + window.end.getDate();
  console.log(`Weekend window: ${ymd(window.start)} → ${ymd(window.end)} — ${shows.length} production(s)`);
  shows.forEach(s => console.log(`  ${s.countyLabel.padEnd(18)} ${s.title} — ${s.org}`));

  if (!shows.length) { console.log('No shows in the window; nothing to send.'); fs.writeFileSync(PREVIEW, '<p>No shows this weekend.</p>'); return; }

  const html = render(shows, window);
  fs.writeFileSync(PREVIEW, html);
  console.log(`Preview written to ${path.relative(ROOT, PREVIEW)}`);

  const counties = new Set(shows.map(s => s.countyLabel)).size;
  const subject  = `This weekend on Maryland stages: ${shows.length} shows, ${label}`;
  const preview  = `${shows.length} productions in ${counties} counties — dates, times and tickets.`;

  if (SEND) await sendViaKit(html, subject, preview);
  else console.log('Dry run (no --send). Subject would be: ' + subject);
})().catch(e => { console.error(e.message || e); process.exit(1); });
