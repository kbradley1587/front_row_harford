#!/usr/bin/env node
/**
 * build-shows.js
 * Reads every show file in _data/shows/, parses the YAML front matter,
 * and writes a single combined shows.json that the website fetches.
 *
 * Runs automatically on Netlify during each deploy. No manual step.
 *
 * YEAR HANDLING (added for the 2027 season)
 *   * Each production has ONE "show_year" (the year of its first performance).
 *   * Each performance may carry its own "year". If it is blank, the build
 *     fills it in from show_year, so the website never has to guess.
 *   * If show_year itself is missing (older 2026 entries), it is derived
 *     from the earliest performance year, so nothing already live changes.
 *   * The build then sanity-checks every performance and records any
 *     problems in shows.json -> "warnings". /data-check.html displays them.
 *     Checks: weekday doesn't match the date (classic wrong-year symptom),
 *     performance year far from show_year, performances with no usable year.
 *   * Warnings never fail the deploy — fixing a bad entry in the CMS is a
 *     normal publish, and the next build clears the warning.
 */

const fs = require('fs');
const path = require('path');

const SHOWS_DIR = path.join(__dirname, '..', '_data', 'shows');
const OUTPUT = path.join(__dirname, '..', 'shows.json');

const MONTH_INDEX = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, june:5, jul:6, july:6,
                      aug:7, sep:8, sept:8, oct:9, nov:10, dec:11 };
const WEEKDAY = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function stripQuotes(v) {
  return v.replace(/^["']|["']$/g, '');
}

function parseFrontMatter(text) {
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const lines = match[1].split('\n');

  const obj = {};
  let inListKey = null;
  let currentItem = null;

  function indentOf(line) {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\s+$/, '');
    if (!raw.trim()) continue;

    const indent = indentOf(raw);
    const trimmed = raw.trim();

    if (inListKey) {
      const topKey = raw.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (indent === 0 && topKey) {
        if (currentItem) { obj[inListKey].push(currentItem); currentItem = null; }
        inListKey = null;
      } else {
        if (trimmed.startsWith('-')) {
          if (currentItem) { obj[inListKey].push(currentItem); currentItem = null; }
          const afterDash = trimmed.replace(/^-\s*/, '');
          const inline = afterDash.match(/^\{(.*)\}$/);
          if (inline) {
            const entry = {};
            inline[1].split(',').forEach(pair => {
              const idx = pair.indexOf(':');
              if (idx !== -1) {
                const k = pair.slice(0, idx).trim();
                const v = stripQuotes(pair.slice(idx + 1).trim());
                entry[k] = v;
              }
            });
            obj[inListKey].push(entry);
            currentItem = null;
          } else {
            currentItem = {};
            const kv = afterDash.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
            if (kv) currentItem[kv[1]] = stripQuotes(kv[2].trim());
          }
          continue;
        }
        const kv = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
        if (kv && currentItem) {
          currentItem[kv[1]] = stripQuotes(kv[2].trim());
          continue;
        }
        continue;
      }
    }

    const keyOnly = raw.match(/^([A-Za-z0-9_]+):\s*$/);
    if (keyOnly) {
      inListKey = keyOnly[1];
      obj[inListKey] = [];
      currentItem = null;
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      obj[kv[1]] = stripQuotes(kv[2].trim());
    }
  }
  if (inListKey && currentItem) obj[inListKey].push(currentItem);

  return obj;
}

function toInt(v) {
  const n = parseInt(v, 10);
  return isNaN(n) ? null : n;
}

function build() {
  if (!fs.existsSync(SHOWS_DIR)) {
    fs.writeFileSync(OUTPUT, JSON.stringify({ shows: [], schools: [], warnings: [], built_at: new Date().toISOString() }, null, 2));
    console.log('No _data/shows directory; wrote empty shows.json');
    return;
  }

  const files = fs.readdirSync(SHOWS_DIR).filter(f => f.endsWith('.md') || f.endsWith('.json'));
  const shows = [];
  const warnings = [];

  function warn(file, title, message) {
    warnings.push({ file, title: title || '(untitled)', message });
    console.warn(`  ⚠ ${file}: ${message}`);
  }

  files.forEach(file => {
    const full = path.join(SHOWS_DIR, file);
    const text = fs.readFileSync(full, 'utf8');

    let data;
    if (file.endsWith('.json')) {
      try { data = JSON.parse(text); } catch (e) { warn(file, '', 'Bad JSON — file skipped'); return; }
    } else {
      data = parseFrontMatter(text);
    }
    if (!data || !data.title) { warn(file, '', 'No title — file skipped'); return; }

    const rawPerfs = Array.isArray(data.performances) ? data.performances : [];

    // 1. Settle the production's year.
    //    Prefer the explicit show_year field; otherwise use the earliest
    //    performance year (keeps all existing 2026 entries working unchanged).
    let showYear = toInt(data.show_year);
    if (!showYear) {
      const years = rawPerfs.map(p => toInt(p.year)).filter(Boolean);
      if (years.length) showYear = Math.min.apply(null, years);
    }
    if (!showYear) {
      warn(file, data.title, 'No Show Year and no performance has a year — dates will be wrong. Set "Show Year" in the CMS.');
    }
    data.show_year = showYear;

    // 2. Normalise performances, filling blank years from show_year.
    data.performances = rawPerfs.map(p => {
      const year = toInt(p.year) || showYear || null;
      return {
        weekday: p.weekday || '',
        month: p.month || '',
        day: toInt(p.day),
        year: year,
        time: p.time || ''
      };
    });

    // 3. Sanity checks — these are the "is this really 2027?" guards.
    data.performances.forEach((p, i) => {
      const label = `performance ${i + 1} (${p.weekday} ${p.month} ${p.day}${p.year ? ' ' + p.year : ''} ${p.time})`;
      const mi = MONTH_INDEX[String(p.month).toLowerCase()];

      if (mi === undefined) { warn(file, data.title, `${label}: month "${p.month}" not recognised`); return; }
      if (!p.day)           { warn(file, data.title, `${label}: missing day`); return; }
      if (!p.year)          { warn(file, data.title, `${label}: no year — will not display correctly`); return; }

      // Year drifts more than one away from the show's year → almost certainly a typo
      if (showYear && Math.abs(p.year - showYear) > 1) {
        warn(file, data.title, `${label}: year ${p.year} is far from Show Year ${showYear}`);
      }

      // Weekday check: "Fri Dec 4" is only true in 2026 — in 2027 Dec 4 is a Saturday.
      // A mismatch almost always means the YEAR is wrong (or the weekday was mistyped).
      const dt = new Date(p.year, mi, p.day);
      if (dt.getMonth() !== mi) {
        warn(file, data.title, `${label}: ${p.month} ${p.day} is not a real date`);
        return;
      }
      const actual = WEEKDAY[dt.getDay()];
      const entered = String(p.weekday || '').slice(0, 3).toLowerCase();
      if (entered && actual.toLowerCase() !== entered) {
        let hint = '';
        for (let y = p.year - 2; y <= p.year + 2; y++) {
          if (y !== p.year && WEEKDAY[new Date(y, mi, p.day).getDay()].toLowerCase() === entered) { hint = ` (it IS a ${p.weekday} in ${y} — wrong year?)`; break; }
        }
        warn(file, data.title, `${label}: ${p.month} ${p.day}, ${p.year} is a ${actual}, not a ${p.weekday}${hint}`);
      }
    });

    data.school_slug = (data.organization || '')
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    data.source_file = file;   // lets /data-check.html say exactly which file to open
    shows.push(data);
  });

  const orgMap = {};
  shows.forEach(s => { if (s.school_slug && !orgMap[s.school_slug]) orgMap[s.school_slug] = s.organization; });
  const schools = Object.keys(orgMap)
    .map(slug => ({ slug, label: orgMap[slug] }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const byYear = {};
  shows.forEach(s => { const y = s.show_year || 'none'; byYear[y] = (byYear[y] || 0) + 1; });

  fs.writeFileSync(OUTPUT, JSON.stringify({ shows, schools, warnings, built_at: new Date().toISOString() }, null, 2));
  console.log(`Built shows.json: ${shows.length} production(s), ` +
    `${shows.reduce((n,s)=>n+s.performances.length,0)} performance(s), ${schools.length} org(s).`);
  console.log('Productions by year: ' + Object.keys(byYear).sort().map(y => `${y}: ${byYear[y]}`).join(', '));
  if (warnings.length) {
    console.log(`${warnings.length} data warning(s) — see /data-check.html on the live site.`);
  } else {
    console.log('No data warnings.');
  }
}

build();
