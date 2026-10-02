import Papa from 'papaparse';
import { DATA } from './config.js';

export const dataLoadState = {
  usedLocalFallback: false,
  sheetOnlyActorIds: new Set(),
};

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
  dataLoadState.sheetOnlyActorIds.clear();
  const text = fromGoogleSheets
    ? await fetchSheetOrLocal(DATA.googleSheets.actorGid, DATA.actorsFile)
    : await fetchText(DATA.actorsFile);
  let localActorIds = null;
  if (fromGoogleSheets && !dataLoadState.usedLocalFallback) {
    try {
      const localText = await fetchText(DATA.actorsFile);
      const { data: localRows } = Papa.parse(localText, { header: true, skipEmptyLines: true });
      localActorIds = new Set(localRows.map((row) => (row[DATA.nodeIdField] || '').trim()).filter(Boolean));
    } catch (error) {
      console.warn('Unable to compare published actors with the local snapshot.', error);
    }
  }
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
    if (localActorIds && !localActorIds.has(id)) dataLoadState.sheetOnlyActorIds.add(id);
    // Google Sheets export can leave stray whitespace on every cell.
    const trimmed = {};
    for (const [key, value] of Object.entries(row)) {
      trimmed[key] = typeof value === 'string' ? value.trim() : value;
    }
    actors.push(trimmed);
  }
  return actors;
}

export async function loadAdjacencyRows(fromGoogleSheets = false) {
  const text = fromGoogleSheets
    ? await fetchSheetOrLocal(DATA.googleSheets.adjacencyGid, DATA.adjacencyFile)
    : await fetchText(DATA.adjacencyFile);
  const { data, meta } = Papa.parse(text, { header: true, skipEmptyLines: true });
  const requiredHeaders = [
    'source-target relationship',
    'source',
    'target',
    'parameter 0',
    'parameter 1',
    'parameter 2',
  ];
  const missingHeaders = requiredHeaders.filter((header) => !meta.fields?.includes(header));
  if (missingHeaders.length) {
    throw new Error(`Adjacency tab is missing columns: ${missingHeaders.join(', ')}`);
  }
  const rows = data
    .map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [
      key.trim(), typeof value === 'string' ? value.trim() : value,
    ])))
    .filter((row) => row['source-target relationship'] && row.source && row.target);
  if (!rows.length) throw new Error('Adjacency tab contains no populated relationships');
  return rows;
}

export async function loadEdgeManifest() {
  const res = await fetch(DATA.edgesManifest);
  if (!res.ok) throw new Error(`Failed to fetch ${DATA.edgesManifest}: ${res.status}`);
  return res.json();
}
