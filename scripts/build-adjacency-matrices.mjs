import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Papa from 'papaparse';
import { getSheetRelationshipCode } from '../src/edge-types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.join(__dirname, '..');
const dataDir = path.join(projectDir, 'public', 'data');
const edgesDir = path.join(dataDir, 'edges');

function parseCsv(text) {
  return Papa.parse(text, { header: true, skipEmptyLines: true }).data;
}

function quoteCsv(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const [actorText, adjacencyText, manifestText] = await Promise.all([
    readFile(path.join(dataDir, 'actors.csv'), 'utf8'),
    readFile(path.join(edgesDir, 'adjacency.csv'), 'utf8'),
    readFile(path.join(edgesDir, 'manifest.json'), 'utf8'),
  ]);
  const actorIds = [...new Set(parseCsv(actorText)
    .map((row) => row.actor?.trim())
    .filter(Boolean))].sort((first, second) => first.localeCompare(second, 'en'));
  const actorIdSet = new Set(actorIds);
  const manifest = JSON.parse(manifestText);
  const matrixByType = new Map(manifest.map(({ type }) => [type, new Set()]));
  const seenPairs = new Set();
  const missingActors = new Set();
  let skippedRows = 0;
  let duplicateRows = 0;

  for (const row of parseCsv(adjacencyText)) {
    const relationship = row['source-target relationship']?.trim();
    const source = row.source?.trim();
    const target = row.target?.trim();
    if (!relationship || !source || !target) continue;

    const type = getSheetRelationshipCode(relationship);
    if (!matrixByType.has(type)) throw new Error(`No matrix manifest entry for relationship "${relationship}"`);
    if (!actorIdSet.has(source) || !actorIdSet.has(target)) {
      if (!actorIdSet.has(source)) missingActors.add(source);
      if (!actorIdSet.has(target)) missingActors.add(target);
      skippedRows += 1;
      continue;
    }

    const pair = type === 'col' ? [source, target].sort((a, b) => a.localeCompare(b, 'en')) : [source, target];
    const key = JSON.stringify([type, ...pair]);
    if (seenPairs.has(key)) {
      duplicateRows += 1;
      continue;
    }
    seenPairs.add(key);
    matrixByType.get(type).add(JSON.stringify([source, target]));
  }

  const newline = '\n';
  const header = ['', ...actorIds].map(quoteCsv).join(',');
  for (const { file, type } of manifest) {
    const pairs = matrixByType.get(type);
    const targetsBySource = new Map();
    pairs.forEach((pair) => {
      const [source, target] = JSON.parse(pair);
      if (!targetsBySource.has(source)) targetsBySource.set(source, new Set());
      targetsBySource.get(source).add(target);
    });
    const lines = [header];
    actorIds.forEach((source) => {
      const targets = targetsBySource.get(source) || new Set();
      lines.push([source, ...actorIds.map((target) => targets.has(target) ? '1' : '0')]
        .map(quoteCsv)
        .join(','));
    });
    await writeFile(path.join(edgesDir, file), `${lines.join(newline)}${newline}`, 'utf8');
  }

  console.log(JSON.stringify({
    actorCount: actorIds.length,
    populatedRows: seenPairs.size + duplicateRows + skippedRows,
    matrixEdges: seenPairs.size,
    duplicateRows,
    skippedRows,
    missingActors: [...missingActors].sort((a, b) => a.localeCompare(b, 'en')),
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});