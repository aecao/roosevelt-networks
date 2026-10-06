// Converts the island boundary + per-building GeoJSON footprints into a single
// static SVG so the app can load one small file instead of ~70 GeoJSON requests.
// Also writes map-points.json, linking point-*.svg files to actors via the
// "point - "name"" rows of building_actors.csv.
// Run with: node scripts/build-map-overlay.mjs
// Add --sync to first download the "buildings" sheet into building_actors.csv.
// Custom datasets can override the defaults with:
//   --sheet=<published buildings CSV URL>   (used with --sync)
//   --boundary=<GeoJSON file in public/data/buildings>
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildingsDir = path.join(__dirname, '..', 'public', 'data', 'buildings');
const cliOption = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const BUILDINGS_SHEET_CSV_URL = cliOption('sheet') || 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTWRxyJfkdgZ_KTQJ_gWNCHiWeIp5ciie9yx02upPZG489o8NYQER8R8tPiXK0Qz_pewTz8N2TqQAaJ/pub?gid=1593670637&single=true&output=csv';
const BOUNDARY_FILE = cliOption('boundary') || 'roosevelt_island_boundary.geojson';

async function syncBuildingsSheet() {
  const response = await fetch(BUILDINGS_SHEET_CSV_URL);
  if (!response.ok) throw new Error(`Could not download buildings sheet: ${response.status}`);
  const text = await response.text();
  if (!/^\uFEFF?BIN,/.test(text)) throw new Error('Buildings sheet did not return the expected CSV (missing BIN header)');
  await writeFile(path.join(buildingsDir, 'building_actors.csv'), text, 'utf8');
  console.log('Downloaded buildings sheet to building_actors.csv');
}

const normalizePointName = (value) => value.toLowerCase().replace(/\s+/g, ' ').trim();

// Matches each sheet row named `point - "<name>"` to point-<name>.svg. Falls
// back to the longest filename contained in the sheet name (e.g. sheet
// "fdr four freedoms state park" -> point-four freedoms state park.svg).
async function buildMapPointManifest(actorRows) {
  const files = (await readdir(buildingsDir)).filter((file) => /^point-.+\.svg$/i.test(file));
  const fileNames = files.map((file) => ({ file, name: normalizePointName(file.slice(6, -4)) }));
  const points = [];
  actorRows.forEach((row) => {
    const match = /^point\s*-\s*"?(.+?)"?\s*$/i.exec(row.Name?.trim() || '');
    if (!match) return;
    const actor = row.Actor?.trim();
    const name = normalizePointName(match[1]);
    const file = fileNames.find((entry) => entry.name === name)
      || fileNames.filter((entry) => name.includes(entry.name)).sort((a, b) => b.name.length - a.name.length)[0];
    if (!file) console.warn(`No point SVG found for sheet row "${row.Name}"`);
    else if (!actor) console.warn(`Point ${file.file} has no actor in the sheet; skipping`);
    else points.push({ file: file.file, actor });
  });
  files.filter((file) => !points.some((point) => point.file === file))
    .forEach((file) => console.warn(`Point SVG ${file} has no matching sheet row; it will not be shown`));
  return points;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^\uFEFF/, '');

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (character === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  return rows
    .filter((values) => values.some((value) => value.trim()))
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function ringsFromGeometry(geometry) {
  if (!geometry) return [];
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  // Reproject from EPSG:4326 (lng/lat degrees) to EPSG:3857 (Web Mercator
  // meters) so shapes keep their true proportions instead of the east-west
  // stretch you get from treating degrees of longitude and latitude as equal.
  return polygons.flat().map((ring) => ring.map(([lng, lat]) => toWebMercator(lng, lat)));
}

const EARTH_RADIUS = 6378137;

function toWebMercator(lng, lat) {
  const x = EARTH_RADIUS * (lng * Math.PI / 180);
  const clampedLat = Math.max(Math.min(lat, 85.05112878), -85.05112878);
  const y = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + (clampedLat * Math.PI / 180) / 2));
  // Field names stay `lng`/`lat` for compatibility with the rest of the
  // pipeline, but they now hold projected meters, not degrees.
  return { lng: x, lat: y };
}

function ringToPathD(ring) {
  return ring
    .map(({ lng, lat }, index) => `${index === 0 ? 'M' : 'L'}${lng.toFixed(3)},${(-lat).toFixed(3)}`)
    .join(' ') + ' Z';
}

function ringsToPathD(rings) {
  return rings.map(ringToPathD).join(' ');
}

function escapeAttr(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

async function main() {
  if (process.argv.includes('--sync')) await syncBuildingsSheet();
  const islandGeojson = JSON.parse(await readFile(path.join(buildingsDir, BOUNDARY_FILE), 'utf8'));
  const islandRings = ringsFromGeometry(islandGeojson.features?.[0]?.geometry);

  const actorRows = parseCsv(await readFile(path.join(buildingsDir, 'building_actors.csv'), 'utf8'));

  const buildings = [];
  for (const row of actorRows) {
    const bin = row.BIN?.trim();
    if (!bin) continue;
    const filePath = path.join(buildingsDir, `bin-${bin}.geojson`);
    let feature;
    try {
      feature = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      console.warn(`Skipping BIN ${bin}: footprint file unavailable`);
      continue;
    }
    const rings = ringsFromGeometry(feature.geometry);
    if (!rings.length) continue;
    buildings.push({
      bin,
      actor: row.Actor?.trim() || '',
      name: row.Name?.trim() || String(feature.properties?.name ?? '').trim(),
      rings,
    });
  }

  const allPoints = [...islandRings.flat(), ...buildings.flatMap((b) => b.rings.flat())];
  const bounds = allPoints.reduce((result, point) => ({
    minLng: Math.min(result.minLng, point.lng),
    maxLng: Math.max(result.maxLng, point.lng),
    minLat: Math.min(result.minLat, point.lat),
    maxLat: Math.max(result.maxLat, point.lat),
  }), { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });

  const width = bounds.maxLng - bounds.minLng;
  const height = bounds.maxLat - bounds.minLat;
  const viewBox = `${bounds.minLng.toFixed(3)} ${(-bounds.maxLat).toFixed(3)} ${width.toFixed(3)} ${height.toFixed(3)}`;

  const islandPath = `  <path id="island" class="island" d="${ringsToPathD(islandRings)}" />`;
  const buildingPaths = buildings.map(({ bin, actor, name, rings }) => (
    `  <path class="building" data-bin="${escapeAttr(bin)}" data-actor="${escapeAttr(actor)}" data-name="${escapeAttr(name)}" d="${ringsToPathD(rings)}" />`
  ));

  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">`,
    islandPath,
    ...buildingPaths,
    '</svg>',
    '',
  ].join('\n');

  const outPath = path.join(buildingsDir, 'map-overlay.svg');
  await writeFile(outPath, svg, 'utf8');
  console.log(`Wrote ${outPath} (${buildings.length} buildings)`);

  const mapPoints = await buildMapPointManifest(actorRows);
  const pointsPath = path.join(buildingsDir, 'map-points.json');
  await writeFile(pointsPath, `${JSON.stringify(mapPoints, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${pointsPath} (${mapPoints.length} points)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
