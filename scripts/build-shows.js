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

// --- Minimal YAML front matter parser (no external dependencies) ---
// Handles the specific structure our CMS produces: simple key: value pairs
// plus a "performances" list of inline objects.
function parseFrontMatter(text) {
  // Grab everything between the first pair of --- fences
  const match = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return null;
  const body = match[1];
  const lines = body.split('\n');

  const obj = {};
  let currentListKey = null;

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, ''); // rstrip
    if (!line.trim()) continue;

    // Detect a list item for performances:  "  - { weekday: ..., ... }"
    const listItem = line.match(/^\s*-\s*\{(.*)\}\s*$/);
    if (listItem && currentListKey) {
      const inner = listItem[1];
      const entry = {};
      // split on commas not inside quotes (our data has no commas inside values except price, which isn't in performances)
      inner.split(',').forEach(pair => {
        const kv = pair.split(':');
        if (kv.length >= 2) {
          const k = kv[0].trim();
          let v = kv.slice(1).join(':').trim();
          v = v.replace(/^["']|["']$/g, ''); // strip quotes
          entry[k] = v;
        }
      });
      obj[currentListKey] = obj[currentListKey] || [];
      obj[currentListKey].push(entry);
      continue;
    }

    // Detect "key:" with nothing after -> start of a list block
    const keyOnly = line.match(/^([A-Za-z0-9_]+):\s*$/);
    if (keyOnly) {
      currentListKey = keyOnly[1];
      obj[currentListKey] = [];
      continue;
    }

    // Detect "key: value"
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      currentListKey = null;
      let v = kv[2].trim();
      v = v.replace(/^["']|["']$/g, ''); // strip surrounding quotes
      obj[kv[1]] = v;
    }
  }
  return obj;
}

function build() {
  if (!fs.existsSync(SHOWS_DIR)) {
    console.log('No _data/shows directory found; writing empty shows.json');
    fs.writeFileSync(OUTPUT, JSON.stringify([], null, 2));
    return;
  }

  const files = fs.readdirSync(SHOWS_DIR).filter(f => f.endsWith('.md') || f.endsWith('.json'));
  const shows = [];

  files.forEach(file => {
    const full = path.join(SHOWS_DIR, file);
    const text = fs.readFileSync(full, 'utf8');

    let data;
    if (file.endsWith('.json')) {
      try { data = JSON.parse(text); } catch (e) { console.warn('Skipping bad JSON:', file); return; }
    } else {
      data = parseFrontMatter(text);
    }
    if (!data || !data.title) { console.warn('Skipping (no title):', file); return; }

    // Normalize day to a number
    if (Array.isArray(data.performances)) {
      data.performances = data.performances.map(p => ({
        weekday: p.weekday || '',
        month: p.month || '',
        day: parseInt(p.day, 10),
        time: p.time || ''
      }));
    } else {
      data.performances = [];
    }

    // Auto-generate a school/company slug from the Organization text.
    // "Cecil Community College" -> "cecil-community-college"
    // This powers the School/Company filter with zero manual upkeep.
    data.school_slug = (data.organization || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')   // non-alphanumerics -> hyphens
      .replace(/^-+|-+$/g, '');      // trim leading/trailing hyphens

    shows.push(data);
  });

  // Build a sorted, de-duplicated list of {slug,label} for the filter dropdown
  var orgMap = {};
  shows.forEach(function (s) {
    if (s.school_slug && !orgMap[s.school_slug]) {
      orgMap[s.school_slug] = s.organization;
    }
  });
  var schools = Object.keys(orgMap)
    .map(function (slug) { return { slug: slug, label: orgMap[slug] }; })
    .sort(function (a, b) { return a.label.localeCompare(b.label); });

  // Output an object with both the shows and the derived school list
  var payload = { shows: shows, schools: schools };
  fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2));
  console.log(`Built shows.json with ${shows.length} production(s), ` +
    `${shows.reduce((n,s)=>n+s.performances.length,0)} total performance(s), ` +
    `${schools.length} unique organization(s).`);
}

build();
