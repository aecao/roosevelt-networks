import Papa from 'papaparse';
import { DATA } from './config.js';

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.text();
}

export async function loadActors() {
  const text = await fetchText(DATA.actorsFile);
  const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
  return data.map((row) => ({
    ...row,
    [DATA.nodeIdField]: (row[DATA.nodeIdField] || '').trim(),
  }));
}

export async function loadEdgeManifest() {
  const res = await fetch(DATA.edgesManifest);
  if (!res.ok) throw new Error(`Failed to fetch ${DATA.edgesManifest}: ${res.status}`);
  return res.json();
}

// Parses a square adjacency matrix CSV (actor ids as both the header row and
// the first column) into a flat list of { source, target, weight } edges.
// A cell counts as an edge when it is non-empty and not "0".
export async function loadAdjacencyMatrix(file) {
  const text = await fetchText(`${DATA.edgesDir}${file}`);
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
