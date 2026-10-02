import Papa from 'papaparse';
import { DATA } from './config.js';

export const dataLoadState = { usedLocalFallback: false };

async function fetchText(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

async function fetchGoogleSheetCsv(gid) {
  const url = new URL(DATA.googleSheets.publishedUrl);
  url.searchParams.set('gid', gid);
  url.searchParams.set('single', 'true');
  url.searchParams.set('output', 'csv');
  url.searchParams.set('refresh', String(Date.now()));
  return fetchText(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
}

async function fetchSheetOrLocal(gid, localUrl) {
  try {
    return await fetchGoogleSheetCsv(gid);
  } catch (error) {
    dataLoadState.usedLocalFallback = true;
    console.warn(`Unable to load published sheet ${gid}; falling back to local data.`, error);
    return fetchText(localUrl);
  }
}

export async function loadActors(fromGoogleSheets = false) {
  dataLoadState.usedLocalFallback = false;
  const text = fromGoogleSheets
    ? await fetchSheetOrLocal(DATA.googleSheets.actorGid, DATA.actorsFile)
    : await fetchText(DATA.actorsFile);
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });

  const seen = new Set();
  const actors = [];
  for (const row of data) {
    const id = (row[DATA.nodeIdField] || '').trim();
    if (!id) continue;
    if (seen.has(id)) {
      console.warn(`Skipping duplicate actor id "${id}" (row appears more than once in actors.csv)`);
      continue;
    }
    seen.add(id);
    // Google Sheets export can leave stray whitespace on every cell.
    const trimmed = {};
    for (const [key, value] of Object.entries(row)) {
      trimmed[key] = typeof value === 'string' ? value.trim() : value;
    }
    actors.push(trimmed);
  }
  return actors;
}

export async function loadActorSentiments() {
  try {
    const text = await fetchText(DATA.sentimentFile);
    const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
    return new Map(data.flatMap((row) => {
      const actor = (row[DATA.nodeIdField] || '').trim().toLowerCase();
      if (!actor) return [];
      const sentiment = Number.parseFloat(row.sentiment);
      return [[actor, Number.isFinite(sentiment) ? sentiment : null]];
    }));
  } catch (error) {
    console.warn('Unable to load local actor sentiment data.', error);
    return new Map();
  }
}

export async function loadAdjacencyRows(fromGoogleSheets = false) {
  const text = fromGoogleSheets
    ? await fetchSheetOrLocal(DATA.googleSheets.adjacencyGid, DATA.adjacencyFile)
    : await fetchText(DATA.adjacencyFile);
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
  return data
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key.trim(), typeof value === 'string' ? value.trim() : value,
    ])))
    .filter((row) => row['source-target relationship'] && row.source && row.target);
}

export async function loadEdgeManifest() {
  const res = await fetch(DATA.edgesManifest);
  if (!res.ok) throw new Error(`Failed to fetch ${DATA.edgesManifest}: ${res.status}`);
  return res.json();
}

// Parses a square adjacency matrix CSV (actor ids as both the header row and
// the first column) into a flat list of { source, target, weight } edges.
// A cell counts as an edge when it is non-empty and not "0".
export async function loadAdjacencyMatrix(file, fromGoogleSheets = false) {
  let text;
  if (fromGoogleSheets) {
    const gid = DATA.googleSheets.matrixGids[file];
    if (!gid) throw new Error(`No published Google Sheets tab configured for ${file}`);
    text = await fetchSheetOrLocal(gid, `${DATA.edgesDir}${file}`);
  } else {
    text = await fetchText(`${DATA.edgesDir}${file}`);
  }
  const { data: rows } = Papa.parse(text, { skipEmptyLines: true });
  if (rows.length < 2) return [];

  const header = rows[0].map((cell) => (cell || '').trim());
  const edges = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sourceId = (row[0] || '').trim();
    if (!sourceId) continue;

    for (let j = 1; j < row.length; j++) {
      const targetId = header[j];
      if (!targetId || sourceId === targetId) continue;

      const raw = (row[j] || '').trim();
      if (!raw || raw === '0') continue;

      const weight = Number(raw);
      edges.push({
        source: sourceId,
        target: targetId,
        weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      });
    }
  }

  return edges;
}
