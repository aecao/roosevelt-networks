import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const base = import.meta.env.BASE_URL;
const buildingsDir = `${base}data/buildings/`;
const islandBoundaryUrl = `${buildingsDir}roosevelt_island_boundary.geojson`;

// Large ring covering the world, so subtracting the island ring (as a hole)
// darkens everywhere outside Roosevelt Island.
const WORLD_RING = [
  [-90, -180], [-90, 180], [90, 180], [90, -180], [-90, -180],
];

const islandCenter = [40.7625, -73.9497];
const islandZoom = 15.2;
const studyBounds = L.latLngBounds(
  [40.744, -73.970],
  [40.780, -73.925],
);

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

function createBuildingPopup(record) {
  const content = document.createElement('div');
  content.className = 'building-popup-content';

  const kicker = document.createElement('div');
  kicker.className = 'popup-kicker';
  kicker.textContent = `BUILDING / BIN ${record.BIN}`;
  content.append(kicker);

  const title = document.createElement('h2');
  title.textContent = record.Name || record.Address || `BIN ${record.BIN}`;
  content.append(title);

  const details = document.createElement('dl');
  details.className = 'popup-details';
  Object.entries(record).forEach(([label, value]) => {
    if (['BIN', 'Name'].includes(label) || !String(value).trim()) return;
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = value;
    details.append(term, description);
  });
  content.append(details);
  return content;
}

// Lazily creates the Leaflet map inside `container` the first time map mode
// is shown, then returns the same instance on subsequent calls.
export function mountMap(container, statusEl) {
  const map = L.map(container, {
    center: islandCenter,
    zoom: islandZoom,
    minZoom: 13,
    maxZoom: 19,
    maxBounds: studyBounds,
    maxBoundsViscosity: 0.95,
    zoomControl: false,
    attributionControl: true,
    scrollWheelZoom: true,
    worldCopyJump: false,
  });

  const lightLayer = L.tileLayer(
    'https://services.arcgisonline.com/arcgis/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      attribution: 'Tiles &copy; Esri, HERE, Garmin, &copy; OpenStreetMap contributors, and the GIS user community',
    },
  );

  const streetLayer = L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
    },
  );

  lightLayer.addTo(map);
  L.control.scale({ position: 'bottomright', metric: true, imperial: false }).addTo(map);

  // Darkens everywhere outside Roosevelt Island by drawing a world-covering
  // polygon with the island geometry cut out as a hole.
  async function loadIslandMask() {
    try {
      const response = await fetch(islandBoundaryUrl);
      if (!response.ok) throw new Error('Island boundary is unavailable');
      const data = await response.json();
      const geometry = data.features?.[0]?.geometry;
      if (!geometry) throw new Error('Island boundary has no geometry');

      const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
      const islandRings = polygons.flat().map((ring) => ring.map(([lng, lat]) => [lat, lng]));

      L.polygon([WORLD_RING, ...islandRings], {
        stroke: false,
        fillColor: '#05070a',
        fillOpacity: 0.72,
        interactive: false,
      }).addTo(map);
    } catch (error) {
      console.error(error);
    }
  }

  loadIslandMask();

  async function loadBuildings() {
    try {
      const csvResponse = await fetch(`${buildingsDir}buildings.csv`);
      if (!csvResponse.ok) throw new Error('Building data is unavailable');
      const records = parseCsv(await csvResponse.text()).filter((record) => record.BIN?.trim());
      const features = await Promise.all(records.map(async (record) => {
        const footprintResponse = await fetch(`${buildingsDir}bin-${encodeURIComponent(record.BIN.trim())}.geojson`);
        if (!footprintResponse.ok) throw new Error(`Footprint unavailable for BIN ${record.BIN}`);
        const feature = await footprintResponse.json();
        feature.properties = { ...feature.properties, bin: record.BIN.trim() };
        return { feature, record };
      }));

      const recordsByBin = new Map(features.map(({ record }) => [record.BIN.trim(), record]));
      L.geoJSON(
        { type: 'FeatureCollection', features: features.map(({ feature }) => feature) },
        {
          style: {
            color: '#a85e2a',
            weight: 1.2,
            opacity: 0.95,
            fillColor: '#e9ad73',
            fillOpacity: 0.66,
          },
          onEachFeature(feature, layer) {
            const bin = String(feature.properties.bin);
            const labelOffsets = [
              [0, -16], [14, -14], [20, 0], [14, 14],
              [0, 16], [-14, 14], [-20, 0], [-14, -14],
            ];
            layer.bindTooltip(`BIN ${bin}`, {
              permanent: true,
              direction: 'center',
              offset: labelOffsets[Number(bin.slice(-2)) % labelOffsets.length],
              className: 'building-bin-label',
              opacity: 0.96,
            });
            layer.bindPopup(createBuildingPopup(recordsByBin.get(bin)), {
              maxWidth: 340,
              className: 'building-popup',
            });
            layer.on('mouseover', () => layer.setStyle({ color: '#70431f', fillColor: '#f1c756', fillOpacity: 0.9, weight: 2 }));
            layer.on('mouseout', () => layer.setStyle({ color: '#a85e2a', fillColor: '#e9ad73', fillOpacity: 0.66, weight: 1.2 }));
          },
        },
      ).addTo(map);

      if (statusEl) {
        statusEl.textContent = `${features.length} ON MAP`;
        statusEl.classList.add('is-ready');
      }
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = 'DATA UNAVAILABLE';
        statusEl.classList.add('is-error');
      }
      console.error(error);
    }
  }

  loadBuildings();

  function setStyle(styleName) {
    const useStreet = styleName === 'street';
    map.removeLayer(useStreet ? lightLayer : streetLayer);
    (useStreet ? streetLayer : lightLayer).addTo(map);
  }

  function zoomIn() {
    map.zoomIn();
  }

  function zoomOut() {
    map.zoomOut();
  }

  function resetView() {
    map.setView(islandCenter, islandZoom, { animate: true });
  }

  function invalidateSize() {
    map.invalidateSize();
  }

  return { map, setStyle, zoomIn, zoomOut, resetView, invalidateSize };
}
