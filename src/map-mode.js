// Loads Roosevelt Island geography (island boundary, building footprints, and
// the building-to-actor mapping) for use as a reference layer in map mode.
// The geometry is pre-baked into a single SVG (see scripts/build-map-overlay.mjs)
// so the app only needs one small request instead of ~70 GeoJSON fetches.
const base = import.meta.env.BASE_URL;
const mapOverlayUrl = `${base}data/buildings/map-overlay.svg`;

// Parses a path's "d" attribute (built only from M/L/Z commands, see the
// build script) back into an array of rings of {lng, lat} points.
function ringsFromPathD(d) {
  const rings = [];
  let current = null;
  const commandPattern = /([ML])([^MLZ]*)|Z/gi;
  let match = commandPattern.exec(d);
  while (match) {
    const [token] = match;
    if (token.toUpperCase() === 'Z') {
      current = null;
    } else {
      const command = match[1].toUpperCase();
      const [x, y] = match[2].trim().split(',').map(Number);
      const point = { lng: x, lat: -y };
      if (command === 'M' || !current) {
        current = [];
        rings.push(current);
      }
      current.push(point);
    }
    match = commandPattern.exec(d);
  }
  return rings;
}

function centroidOfRings(rings) {
  let sumLng = 0;
  let sumLat = 0;
  let count = 0;
  rings.forEach((ring) => ring.forEach((point) => {
    sumLng += point.lng;
    sumLat += point.lat;
    count += 1;
  }));
  return count ? { lng: sumLng / count, lat: sumLat / count } : null;
}

// Fetches the pre-built map overlay SVG, returning geographic (lng/lat) data
// plus per-actor building centroids to be projected into the network
// diagram's coordinate space.
export async function loadMapGeography() {
  const response = await fetch(mapOverlayUrl);
  if (!response.ok) throw new Error('Map overlay SVG is unavailable');
  const svgText = await response.text();
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');

  const [minLng, minY, width, height] = (svgEl?.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number);
  const bounds = {
    minLng,
    maxLng: minLng + width,
    minLat: -(minY + height),
    maxLat: -minY,
  };

  const islandRings = ringsFromPathD(doc.querySelector('#island')?.getAttribute('d') || '');

  const footprints = [...doc.querySelectorAll('.building')].map((pathEl) => {
    const bin = pathEl.getAttribute('data-bin') || '';
    const actorId = pathEl.getAttribute('data-actor') || null;
    const rings = ringsFromPathD(pathEl.getAttribute('d') || '');
    return { bin, rings, centroid: centroidOfRings(rings), actorId };
  });

  const pointsByActor = new Map();
  footprints.forEach(({ actorId, centroid }) => {
    if (!actorId || !centroid) return;
    if (!pointsByActor.has(actorId)) pointsByActor.set(actorId, []);
    pointsByActor.get(actorId).push(centroid);
  });

  const actorCentroids = new Map();
  pointsByActor.forEach((points, actorId) => {
    actorCentroids.set(actorId, {
      lng: points.reduce((sum, point) => sum + point.lng, 0) / points.length,
      lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    });
  });

  return { islandRings, buildingFootprints: footprints, actorCentroids, bounds };
}

