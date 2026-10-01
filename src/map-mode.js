import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const base = import.meta.env.BASE_URL;
const buildingsDir = `${base}data/buildings/`;
const islandBoundaryUrl = `${buildingsDir}roosevelt_island_boundary.geojson`;
const actorMappingUrl = `${buildingsDir}building_actors.csv`;
const DEFAULT_ACTOR_COLOR = '#9ca3af';

// Mixes a hex color toward white, used to tint buildings linked to an actor.
function lightenColor(hex, amount = 0.6) {
  const clean = (hex || '').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((ch) => ch + ch).join('') : clean;
  const num = Number.parseInt(full, 16);
  if (Number.isNaN(num)) return DEFAULT_ACTOR_COLOR;
  const mix = (channel) => Math.round(channel + (255 - channel) * amount);
  const r = mix((num >> 16) & 255);
  const g = mix((num >> 8) & 255);
  const b = mix(num & 255);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

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

function createActorPopup(actorStyle, bins) {
  const content = document.createElement('div');
  content.className = 'building-popup-content';

  const kicker = document.createElement('div');
  kicker.className = 'popup-kicker';
  kicker.textContent = bins.length > 1 ? `ACTOR / ${bins.length} BUILDINGS` : 'ACTOR';
  content.append(kicker);

  const title = document.createElement('h2');
  title.textContent = actorStyle.label;
  content.append(title);

  if (actorStyle.category) {
    const details = document.createElement('dl');
    details.className = 'popup-details';
    const term = document.createElement('dt');
    term.textContent = 'Sector';
    const description = document.createElement('dd');
    description.textContent = actorStyle.category;
    details.append(term, description);
    content.append(details);
  }
  return content;
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
export function mountMap(container, statusEl, options = {}) {
  const getActorStyle = options.getActorStyle || (() => null);
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

  const buildingLayersByBin = new Map();
  const actorOverlayGroup = L.layerGroup().addTo(map);

  function buildingStyleFor(actorId) {
    if (!actorId) {
      return {
        color: '#a85e2a',
        weight: 1.2,
        opacity: 0.95,
        fillColor: '#e9ad73',
        fillOpacity: 0.66,
      };
    }
    const actorColor = (getActorStyle(actorId) || {}).color || DEFAULT_ACTOR_COLOR;
    return {
      color: actorColor,
      weight: 1.2,
      opacity: 0.95,
      fillColor: lightenColor(actorColor),
      fillOpacity: 0.75,
    };
  }

  // Draws an actor node over a single linked building, or a central actor node
  // plus small unclickable per-building nodes and connecting lines when an
  // actor spans multiple buildings. Safe to call repeatedly (e.g. once actor
  // colors become available after the relationships graph finishes loading).
  function applyActorOverlay() {
    actorOverlayGroup.clearLayers();

    const actorBins = new Map();
    buildingLayersByBin.forEach(({ layer, actorId }, bin) => {
      if (!actorId) return;
      layer.setStyle(buildingStyleFor(actorId));
      if (!actorBins.has(actorId)) actorBins.set(actorId, []);
      actorBins.get(actorId).push({ bin, latlng: layer.getBounds().getCenter() });
    });

    actorBins.forEach((bins, actorId) => {
      const style = getActorStyle(actorId) || { label: actorId, color: DEFAULT_ACTOR_COLOR };
      const color = style.color || DEFAULT_ACTOR_COLOR;

      if (bins.length === 1) {
        L.circleMarker(bins[0].latlng, {
          radius: 7,
          color: '#0b0d10',
          weight: 1.5,
          fillColor: color,
          fillOpacity: 0.95,
        })
          .bindPopup(createActorPopup(style, bins), { maxWidth: 300, className: 'building-popup' })
          .addTo(actorOverlayGroup);
        return;
      }

      const centerLat = bins.reduce((sum, b) => sum + b.latlng.lat, 0) / bins.length;
      const centerLng = bins.reduce((sum, b) => sum + b.latlng.lng, 0) / bins.length;
      const center = L.latLng(centerLat, centerLng);

      bins.forEach(({ latlng }) => {
        L.polyline([latlng, center], {
          color,
          weight: 1.5,
          opacity: 0.6,
          dashArray: '3,4',
          interactive: false,
        }).addTo(actorOverlayGroup);
        L.circleMarker(latlng, {
          radius: 4,
          color: '#0b0d10',
          weight: 1,
          fillColor: color,
          fillOpacity: 0.9,
          interactive: false,
        }).addTo(actorOverlayGroup);
      });

      L.circleMarker(center, {
        radius: 8,
        color: '#0b0d10',
        weight: 1.5,
        fillColor: color,
        fillOpacity: 0.95,
      })
        .bindPopup(createActorPopup(style, bins), { maxWidth: 300, className: 'building-popup' })
        .addTo(actorOverlayGroup);
    });
  }

  async function loadBuildings() {
    try {
      const [csvResponse, actorCsvResponse] = await Promise.all([
        fetch(`${buildingsDir}buildings.csv`),
        fetch(actorMappingUrl),
      ]);
      if (!csvResponse.ok) throw new Error('Building data is unavailable');
      const records = parseCsv(await csvResponse.text()).filter((record) => record.BIN?.trim());

      const actorByBin = new Map();
      if (actorCsvResponse.ok) {
        parseCsv(await actorCsvResponse.text()).forEach((row) => {
          const bin = row.BIN?.trim();
          const actor = row.Actor?.trim();
          if (bin && actor) actorByBin.set(bin, actor);
        });
      }

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
          style(feature) {
            return buildingStyleFor(actorByBin.get(String(feature.properties.bin)));
          },
          onEachFeature(feature, layer) {
            const bin = String(feature.properties.bin);
            const record = recordsByBin.get(bin);
            const label = record?.Name?.trim() || record?.Address?.trim() || `BIN ${bin}`;
            const labelOffsets = [
              [0, -16], [14, -14], [20, 0], [14, 14],
              [0, 16], [-14, 14], [-20, 0], [-14, -14],
            ];
            layer.bindTooltip(label, {
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
            const baseStyle = layer.options;
            const hoverFill = actorByBin.has(bin) ? baseStyle.fillColor : '#f1c756';
            const hoverColor = actorByBin.has(bin) ? baseStyle.color : '#70431f';
            layer.on('mouseover', () => layer.setStyle({ color: hoverColor, fillColor: hoverFill, fillOpacity: 0.9, weight: 2 }));
            layer.on('mouseout', () => layer.setStyle(layer.options));

            buildingLayersByBin.set(bin, { layer, actorId: actorByBin.get(bin) || null });
          },
        },
      ).addTo(map);

      applyActorOverlay();

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

  return { map, setStyle, zoomIn, zoomOut, resetView, invalidateSize, refreshActorStyles: applyActorOverlay };
}
