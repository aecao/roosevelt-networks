// Loads Roosevelt Island geography (island boundary, building footprints, and
// actor points) for use as a reference layer in map mode.
// The geometry is pre-baked into a single SVG (see scripts/build-map-overlay.mjs)
// so the app only needs one small request instead of ~70 GeoJSON fetches.
const base = import.meta.env.BASE_URL;
const mapOverlayUrl = `${base}data/buildings/map-overlay.svg`;
// Generated from the "buildings" sheet by scripts/build-map-overlay.mjs.
const mapPointsManifestUrl = `${base}data/buildings/map-points.json`;

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

function multiplyTransforms(left, right) {
  const [a, b, c, d, e, f] = left;
  const [g, h, i, j, k, l] = right;
  return [
    a * g + c * h,
    b * g + d * h,
    a * i + c * j,
    b * i + d * j,
    a * k + c * l + e,
    b * k + d * l + f,
  ];
}

function parseTransform(value = '') {
  let matrix = [1, 0, 0, 1, 0, 0];
  const transformPattern = /([a-z]+)\(([^)]*)\)/gi;
  let match = transformPattern.exec(value);
  while (match) {
    const values = match[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let next;
    switch (match[1].toLowerCase()) {
      case 'matrix':
        if (values.length !== 6) throw new Error('Invalid SVG matrix transform');
        next = values;
        break;
      case 'translate':
        next = [1, 0, 0, 1, values[0] || 0, values[1] || 0];
        break;
      case 'scale':
        if (!values.length || !Number.isFinite(values[0])) throw new Error('Invalid SVG scale transform');
        next = [values[0], 0, 0, values.length > 1 ? values[1] : values[0], 0, 0];
        break;
      case 'skewx':
        next = [1, 0, Math.tan((values[0] * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewy':
        next = [1, Math.tan((values[0] * Math.PI) / 180), 0, 1, 0, 0];
        break;
      case 'rotate': {
        const angle = (values[0] * Math.PI) / 180;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const rotation = [cos, sin, -sin, cos, 0, 0];
        if (values.length < 3) next = rotation;
        else {
          const [centerX, centerY] = values.slice(1);
          next = multiplyTransforms(
            [1, 0, 0, 1, centerX, centerY],
            multiplyTransforms(rotation, [1, 0, 0, 1, -centerX, -centerY]),
          );
        }
        break;
      }
      default:
        throw new Error(`Unsupported SVG transform: ${match[1]}`);
    }
    matrix = multiplyTransforms(matrix, next);
    match = transformPattern.exec(value);
  }
  return matrix;
}

function transformForElement(element, root) {
  const ancestors = [];
  let current = element;
  while (current && current !== root.parentElement) {
    ancestors.unshift(current);
    if (current === root) break;
    current = current.parentElement;
  }
  return ancestors.reduce(
    (matrix, ancestor) => multiplyTransforms(matrix, parseTransform(ancestor.getAttribute('transform') || '')),
    [1, 0, 0, 1, 0, 0],
  );
}

function transformPoint([a, b, c, d, e, f], x, y) {
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

function pathVertices(d) {
  const tokens = d.match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.)?\d+(?:[eE][-+]?\d+)?/g) || [];
  const points = [];
  let command = '';
  let index = 0;
  let x = 0;
  let y = 0;
  while (index < tokens.length) {
    if (/^[a-zA-Z]$/.test(tokens[index])) {
      command = tokens[index];
      index += 1;
      if (command.toLowerCase() === 'z') command = '';
      continue;
    }
    if (!command) throw new Error('Unsupported or malformed SVG boundary path');
    const relative = command === command.toLowerCase();
    switch (command.toLowerCase()) {
      case 'm':
      case 'l': {
        const nextX = Number(tokens[index]);
        const nextY = Number(tokens[index + 1]);
        if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) {
          throw new Error('Malformed SVG boundary path coordinates');
        }
        x = relative ? x + nextX : nextX;
        y = relative ? y + nextY : nextY;
        points.push([x, y]);
        index += 2;
        if (command.toLowerCase() === 'm') command = relative ? 'l' : 'L';
        break;
      }
      case 'h': {
        const nextX = Number(tokens[index]);
        if (!Number.isFinite(nextX)) throw new Error('Malformed SVG boundary path coordinate');
        x = relative ? x + nextX : nextX;
        points.push([x, y]);
        index += 1;
        break;
      }
      case 'v': {
        const nextY = Number(tokens[index]);
        if (!Number.isFinite(nextY)) throw new Error('Malformed SVG boundary path coordinate');
        y = relative ? y + nextY : nextY;
        points.push([x, y]);
        index += 1;
        break;
      }
      default:
        throw new Error(`Unsupported SVG boundary path command: ${command}`);
    }
  }
  return points;
}

function parseMapPoint(svgText, actorId, targetRings, filename) {
  const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error(`Point SVG is not valid XML: ${filename}`);
  const root = doc.querySelector('svg');
  if (!root) throw new Error(`Point SVG does not contain an SVG root element: ${filename}`);
  const boundary = [...root.querySelectorAll('g')].find((group) => group.getAttribute('id') === 'boundary');
  if (!boundary) throw new Error(`Point SVG must contain a group with id="boundary": ${filename}`);
  const boundaryPaths = [...boundary.querySelectorAll('path')];
  const sourceBoundaryPoints = boundaryPaths.flatMap((path) => {
    const transform = transformForElement(path, root);
    return pathVertices(path.getAttribute('d') || '').map(([x, y]) => transformPoint(transform, x, y));
  });
  if (!sourceBoundaryPoints.length) throw new Error(`Point SVG boundary contains no path geometry: ${filename}`);

  const sourceBounds = sourceBoundaryPoints.reduce((bounds, point) => ({
    minX: Math.min(bounds.minX, point.x),
    maxX: Math.max(bounds.maxX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxY: Math.max(bounds.maxY, point.y),
  }), { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
  const targetBounds = targetRings.flat().reduce((bounds, point) => ({
    minLng: Math.min(bounds.minLng, point.lng),
    maxLng: Math.max(bounds.maxLng, point.lng),
    minLat: Math.min(bounds.minLat, point.lat),
    maxLat: Math.max(bounds.maxLat, point.lat),
  }), { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });
  const sourceWidth = sourceBounds.maxX - sourceBounds.minX;
  const sourceHeight = sourceBounds.maxY - sourceBounds.minY;
  if (!sourceWidth || !sourceHeight) throw new Error(`Point SVG boundary has zero width or height: ${filename}`);

  const pointElements = [...root.querySelectorAll('circle, ellipse')]
    .filter((element) => !boundary.contains(element));
  if (pointElements.length !== 1) {
    throw new Error(`Expected exactly one point outside the boundary in ${filename}; found ${pointElements.length}`);
  }
  const element = pointElements[0];
  const x = Number(element.getAttribute('cx'));
  const y = Number(element.getAttribute('cy'));
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error(`Point in ${filename} has invalid coordinates`);
  }
  const sourcePoint = transformPoint(transformForElement(element, root), x, y);
  return {
    actorId,
    lng: targetBounds.minLng
      + ((sourcePoint.x - sourceBounds.minX) / sourceWidth) * (targetBounds.maxLng - targetBounds.minLng),
    lat: targetBounds.maxLat
      - ((sourcePoint.y - sourceBounds.minY) / sourceHeight) * (targetBounds.maxLat - targetBounds.minLat),
  };
}

// Fetches the map overlay and point SVGs, returning geometry and actor
// locations in map coordinates for use in the network diagram.
export async function loadMapGeography() {
  const manifestResponse = await fetch(mapPointsManifestUrl);
  if (!manifestResponse.ok) throw new Error(`Map points manifest is unavailable: ${manifestResponse.status}`);
  const mapPointFiles = (await manifestResponse.json()).map(({ file, actor }) => [file, actor]);
  const [overlayResponse, ...pointResponses] = await Promise.all([
    fetch(mapOverlayUrl),
    ...mapPointFiles.map(([filename]) => fetch(`${base}data/buildings/${encodeURIComponent(filename)}`)),
  ]);
  if (!overlayResponse.ok) throw new Error(`Map overlay SVG is unavailable: ${overlayResponse.status}`);
  const failedPointResponse = pointResponses.findIndex((response) => !response.ok);
  if (failedPointResponse !== -1) {
    const [filename] = mapPointFiles[failedPointResponse];
    throw new Error(`Map point SVG is unavailable (${pointResponses[failedPointResponse].status}): ${filename}`);
  }
  const [svgText, ...pointSvgTexts] = await Promise.all([
    overlayResponse.text(),
    ...pointResponses.map((response) => response.text()),
  ]);
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
    const name = pathEl.getAttribute('data-name') || '';
    const rings = ringsFromPathD(pathEl.getAttribute('d') || '');
    return { bin, name, rings, centroid: centroidOfRings(rings), actorId };
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

  const mapPoints = pointSvgTexts.map((pointSvgText, index) => {
    const [filename, actorId] = mapPointFiles[index];
    return parseMapPoint(pointSvgText, actorId, islandRings, filename);
  });
  mapPoints.forEach(({ actorId, lng, lat }) => {
    actorCentroids.set(actorId, { lng, lat });
  });

  return { islandRings, buildingFootprints: footprints, mapPoints, actorCentroids, bounds };
}
