#!/usr/bin/env node
/**
 * build-shows.js
 * Reads every show file in _data/shows/, parses the YAML front matter,
 * and writes a single combined shows.json that the website fetches.
 *
 * Runs automatically on Netlify during each deploy. No manual step.
 */

const fs = require('fs');
const path = require('path');

const SHOWS_DIR = path.join(__dirname, '..', '_data', 'shows');
const OUTPUT = path.join(__dirname, '..', 'shows.json');

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

function build() {
  if (!fs.existsSync(SHOWS_DIR)) {
    fs.writeFileSync(OUTPUT, JSON.stringify({ shows: [], schools: [] }, null, 2));
    console.log('No _data/shows directory; wrote empty shows.json');
    return;
  }

  const files = fs.readdirSync(SHOWS_DIR).filter(f => f.endsWith('.md') || f.endsWith('.json'));
  const shows = [];

  files.forEach(file => {
    const full = path.join(SHOWS_DIR, file);
    const text = fs.readFileSync(full, 'utf8');

    let data;
    if (file.endsWith('.json')) {
      try { data = JSON.parse(text); } catch (e) { console.warn('Bad JSON skipped:', file); return; }
    } else {
      data = parseFrontMatter(text);
    }
    if (!data || !data.title) { console.warn('No title, skipped:', file); return; }

    if (Array.isArray(data.performances)) {
      data.performances = data.performances.map(p => ({
        weekday: p.weekday || '',
        month: p.month || '',
        day: parseInt(p.day, 10),
        year: p.year ? parseInt(p.year, 10) : null,
        time: p.time || ''
      }));
    } else {
      data.performances = [];
    }

    data.school_slug = (data.organization || '')
      .toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    shows.push(data);
  });

  const orgMap = {};
  shows.forEach(s => { if (s.school_slug && !orgMap[s.school_slug]) orgMap[s.school_slug] = s.organization; });
  const schools = Object.keys(orgMap)
    .map(slug => ({ slug, label: orgMap[slug] }))
    .sort((a, b) => a.label.localeCompare(b.label));

  fs.writeFileSync(OUTPUT, JSON.stringify({ shows, schools }, null, 2));
  console.log(`Built shows.json: ${shows.length} production(s), ` +
    `${shows.reduce((n,s)=>n+s.performances.length,0)} performance(s), ${schools.length} org(s).`);
}

build();
