import Graph from 'graphology';
import Sigma from 'sigma';
import { drawDiscNodeHover, drawDiscNodeLabel, EdgeArrowProgram, EdgeLineProgram } from 'sigma/rendering';
import { animateNodes } from 'sigma/utils';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { circular } from 'graphology-layout';
import { DATA, PALETTE } from './config.js';
import { loadActors, loadEdgeManifest, loadAdjacencyMatrix } from './data.js';

const MIN_SIZE = 4;
const MAX_SIZE = 8;
const REFERENCE_CAMERA_RATIO = 0.3;
const REFERENCE_SIZE_RATIO = Math.sqrt(REFERENCE_CAMERA_RATIO);
const LAYOUT_SETTINGS = { iterations: 150, settings: { gravity: 1, scalingRatio: 10 } };

const state = {
  graph: null,
  renderer: null,
  activeEdgeTypes: new Set(),
  activeNodeTypes: new Set(),
  activeTopics: new Set(),
  allTopics: new Set(),
  activeScales: new Set(),
  categoryColors: new Map(),
  topicColors: new Map(),
  edgeTypeColors: new Map(),
  freezePositions: false,
  yearFilterEnabled: false,
  selectedYear: 2026,
};

// Turns "1 - MESO" into "MESO"; falls back to the raw value or "Unknown".
function parseScale(raw) {
  const value = (raw || '').trim();
  if (!value) return 'Unknown';
  const parts = value.split('-');
  return parts[parts.length - 1].trim().toUpperCase() || 'Unknown';
}

function parseYear(raw) {
  const year = Number.parseInt((raw || '').trim(), 10);
  return Number.isInteger(year) ? year : null;
}

async function buildGraph() {
  const graph = new Graph({ multi: true });

  const actors = await loadActors();
  const categories = [...new Set(actors.map((a) => a[DATA.nodeCategoryField] || 'Unknown'))].sort();
  categories.forEach((cat, i) => state.categoryColors.set(cat, PALETTE[i % PALETTE.length]));
  const topics = [...new Set(actors.flatMap((actor) =>
    (actor[DATA.nodeTopicField] || '').split(',').map((topic) => topic.trim().toUpperCase()).filter(Boolean),
  ))].sort();
  topics.forEach((topic, i) => state.topicColors.set(topic, PALETTE[i % PALETTE.length]));
  state.allTopics = new Set(topics);

  const scaleOrder = { MICRO: 0, MESO: 1, MACRO: 2 };
  const scales = [...new Set(actors.map((a) => parseScale(a[DATA.nodeScaleField])))]
    .sort((a, b) => (scaleOrder[a] ?? 99) - (scaleOrder[b] ?? 99));

  actors.forEach((actor) => {
    const id = actor[DATA.nodeIdField];
    if (!id) return;
    const category = actor[DATA.nodeCategoryField] || 'Unknown';
    const actorTopics = (actor[DATA.nodeTopicField] || '')
      .split(',')
      .map((topic) => topic.trim().toUpperCase())
      .filter(Boolean);
    graph.addNode(id, {
      label: actor[DATA.nodeLabelField] || id,
      size: 6,
      color: state.categoryColors.get(category),
      category,
      topics: actorTopics,
      scale: parseScale(actor[DATA.nodeScaleField]),
      yearStart: parseYear(actor.year_start),
      yearEnd: parseYear(actor.year_end),
      attributes: actor,
      x: Math.random(),
      y: Math.random(),
    });
  });

  const manifest = await loadEdgeManifest();
  const edgeTypes = [];
  manifest.forEach((entry, i) => state.edgeTypeColors.set(entry.type, PALETTE[i % PALETTE.length]));

  for (const entry of manifest) {
    const edges = await loadAdjacencyMatrix(entry.file);
    edgeTypes.push(entry.type);
    const directed = !DATA.undirectedEdgeTypes.includes(entry.type);
    const color = state.edgeTypeColors.get(entry.type);
    edges.forEach(({ source, target, weight }) => {
      if (!graph.hasNode(source) || !graph.hasNode(target)) {
        console.warn(`Skipping edge ${source} -> ${target}: unknown actor id (check "${DATA.nodeIdField}" matches matrix headers)`);
        return;
      }
      const attrs = {
        type: directed ? 'arrow' : 'line',
        adjacencyType: entry.type,
        label: entry.label,
        weight,
        size: 1,
        color,
      };
      if (directed) graph.addDirectedEdge(source, target, attrs);
      else graph.addUndirectedEdge(source, target, attrs);
    });
  }

  state.activeEdgeTypes = new Set(edgeTypes);
  state.activeNodeTypes = new Set(categories);
  state.activeTopics = new Set(topics);
  state.activeScales = new Set(scales);

  // Bigger nodes = more connections (degree across all adjacency types).
  let maxDegree = 0;
  graph.forEachNode((node) => {
    maxDegree = Math.max(maxDegree, graph.degree(node));
  });
  graph.forEachNode((node) => {
    const ratio = maxDegree > 0 ? graph.degree(node) / maxDegree : 0;
    graph.setNodeAttribute(node, 'size', MIN_SIZE + ratio * (MAX_SIZE - MIN_SIZE));
  });

  circular.assign(graph);
  forceAtlas2.assign(graph, LAYOUT_SETTINGS);

  return { graph, categories, scales, manifest };
}

// Lays out a copy of the graph containing only the currently active adjacency
// types, so the layout reflects what's actually selected.
function computeFilteredLayout(graph, activeEdgeTypes) {
  const temp = new Graph({ multi: true });
  graph.forEachNode((node) => temp.addNode(node));
  graph.forEachEdge((edge, attrs, source, target) => {
    if (activeEdgeTypes.has(attrs.adjacencyType)) {
      temp.addEdge(source, target);
    }
  });
  circular.assign(temp);
  forceAtlas2.assign(temp, LAYOUT_SETTINGS);

  const positions = {};
  temp.forEachNode((node, attrs) => {
    positions[node] = { x: attrs.x, y: attrs.y };
  });
  return positions;
}

function buildFilterCheckboxes(container, items, activeSet, colorFor, onChange) {
  container.innerHTML = '';
  items.forEach((item) => {
    const label = document.createElement('label');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.value = item.value;

    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = colorFor(item.value);

    label.appendChild(checkbox);
    label.appendChild(swatch);
    label.appendChild(document.createTextNode(item.label));
    container.appendChild(label);

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) activeSet.add(item.value);
      else activeSet.delete(item.value);
      onChange();
    });
  });
}

function showNodeDetails(graph, nodeId) {
  const panel = document.getElementById('node-details');
  const attrs = graph.getNodeAttribute(nodeId, 'attributes') || {};
  const rows = Object.entries(attrs)
    .filter(([, v]) => v)
    .map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`)
    .join('');
  panel.innerHTML = `<h3>${graph.getNodeAttribute(nodeId, 'label')}</h3><dl>${rows}</dl>`;
  panel.classList.remove('hidden');
}

async function main() {
  const { graph, categories, scales, manifest } = await buildGraph();
  state.graph = graph;

  const container = document.getElementById('graph-container');
  const renderer = new Sigma(graph, container, {
    minCameraRatio: 0.05,
    maxCameraRatio: 10,
    zoomToSizeRatioFunction: (ratio) => (ratio / REFERENCE_CAMERA_RATIO) * REFERENCE_SIZE_RATIO,
    labelDensity: 0.35,
    labelRenderedSizeThreshold: 10,
    labelColor: { color: '#ffffff' },
    labelFont: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    labelSize: 10,
    defaultDrawNodeLabel: (context, data, settings) => {
      const size = Math.max(9, Math.min(15, 8 + data.size * 0.3));
      drawDiscNodeLabel(context, data, { ...settings, labelSize: size });
    },
    defaultDrawNodeHover: (context, data, settings) => {
      const size = Math.max(10, Math.min(16, 9 + data.size * 0.3));
      drawDiscNodeHover(context, data, {
        ...settings,
        labelSize: size,
        labelColor: { color: '#171717' },
      });
    },
    defaultEdgeType: 'line',
    edgeProgramClasses: { line: EdgeLineProgram, arrow: EdgeArrowProgram },
  });
  state.renderer = renderer;

  function refresh() {
    renderer.refresh();
  }

  let cancelAnimation = null;
  function relayout() {
    if (state.freezePositions) return;
    if (cancelAnimation) cancelAnimation();
    const positions = computeFilteredLayout(graph, state.activeEdgeTypes);
    cancelAnimation = animateNodes(graph, positions, { duration: 700, easing: 'quadraticInOut' });
  }

  function isNodeVisible(node) {
    const attrs = graph.getNodeAttributes(node);
    const hasSelectedTopic = state.activeTopics.size === state.allTopics.size
      || attrs.topics.some((topic) => state.activeTopics.has(topic));
    const hasYearData = attrs.yearStart !== null || attrs.yearEnd !== null;
    const activeInSelectedYear = !state.yearFilterEnabled
      || !hasYearData
      || ((attrs.yearStart === null || attrs.yearStart <= state.selectedYear)
        && (attrs.yearEnd === null || attrs.yearEnd >= state.selectedYear));
    return state.activeNodeTypes.has(attrs.category)
      && hasSelectedTopic
      && state.activeScales.has(attrs.scale)
      && activeInSelectedYear;
  }

  renderer.setSetting('nodeReducer', (node, data) => {
    const hidden = !isNodeVisible(node);
    return hidden ? { ...data, hidden: true } : data;
  });

  renderer.setSetting('edgeReducer', (edge, data) => {
    const [source, target] = graph.extremities(edge);
    const nodesVisible = isNodeVisible(source) && isNodeVisible(target);
    const hidden = !state.activeEdgeTypes.has(data.adjacencyType) || !nodesVisible;
    return hidden ? { ...data, hidden: true } : data;
  });

  // Edge type filters
  buildFilterCheckboxes(
    document.getElementById('edge-type-filters'),
    manifest.map((m) => ({ value: m.type, label: m.label })),
    state.activeEdgeTypes,
    (value) => state.edgeTypeColors.get(value),
    () => {
      refresh();
      relayout();
    },
  );

  document.getElementById('freeze-positions').addEventListener('change', (e) => {
    state.freezePositions = e.target.checked;
  });

  // Node category filters
  buildFilterCheckboxes(
    document.getElementById('node-type-filters'),
    categories.map((c) => ({ value: c, label: c })),
    state.activeNodeTypes,
    (value) => state.categoryColors.get(value),
    refresh,
  );

  buildFilterCheckboxes(
    document.getElementById('topic-filters'),
    [...state.allTopics].map((topic) => ({ value: topic, label: topic })),
    state.activeTopics,
    (value) => state.topicColors.get(value),
    refresh,
  );

  // Scale filters
  buildFilterCheckboxes(
    document.getElementById('scale-filters'),
    scales.map((s) => ({ value: s, label: s })),
    state.activeScales,
    () => '#9a9a9a',
    refresh,
  );

  const yearToggle = document.getElementById('year-filter-toggle');
  const yearControls = document.getElementById('year-controls');
  const yearSlider = document.getElementById('year-slider');
  const yearValue = document.getElementById('year-value');
  yearToggle.addEventListener('change', () => {
    state.yearFilterEnabled = yearToggle.checked;
    yearControls.hidden = !state.yearFilterEnabled;
    refresh();
  });
  yearSlider.addEventListener('input', () => {
    state.selectedYear = Number(yearSlider.value);
    yearValue.textContent = String(state.selectedYear);
    refresh();
  });

  // Search
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    searchResults.innerHTML = '';
    if (!q) return;
    const matches = graph.nodes()
      .filter((n) => graph.getNodeAttribute(n, 'label').toLowerCase().includes(q))
      .slice(0, 10);
    matches.forEach((n) => {
      const div = document.createElement('div');
      div.textContent = graph.getNodeAttribute(n, 'label');
      div.addEventListener('click', () => {
        focusNode(n);
        showNodeDetails(graph, n);
      });
      searchResults.appendChild(div);
    });
  });

  function focusNode(nodeId) {
    const pos = renderer.getNodeDisplayData(nodeId);
    if (!pos) return;
    renderer.getCamera().animate({ x: pos.x, y: pos.y, ratio: 0.3 }, { duration: 400 });
  }

  renderer.on('clickNode', ({ node }) => showNodeDetails(graph, node));

  // Zoom controls
  const zoomWrapper = document.createElement('div');
  zoomWrapper.className = 'zoom-controls';
  zoomWrapper.innerHTML = `
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-fit" title="Reset zoom">⤢</button>
  `;
  container.appendChild(zoomWrapper);

  document.getElementById('zoom-in').addEventListener('click', () => renderer.getCamera().animatedZoom({ duration: 300 }));
  document.getElementById('zoom-out').addEventListener('click', () => renderer.getCamera().animatedUnzoom({ duration: 300 }));
  document.getElementById('zoom-fit').addEventListener('click', () => renderer.getCamera().animatedReset({ duration: 300 }));

  document.getElementById('reset-view').addEventListener('click', () => {
    document.querySelectorAll('#edge-type-filters input, #node-type-filters input, #topic-filters input, #scale-filters input').forEach((cb) => {
      cb.checked = true;
    });
    state.activeEdgeTypes.clear();
    manifest.forEach((m) => state.activeEdgeTypes.add(m.type));
    state.activeNodeTypes.clear();
    categories.forEach((category) => state.activeNodeTypes.add(category));
    state.activeTopics.clear();
    state.allTopics.forEach((topic) => state.activeTopics.add(topic));
    state.activeScales.clear();
    scales.forEach((scale) => state.activeScales.add(scale));
    yearToggle.checked = false;
    state.yearFilterEnabled = false;
    yearControls.hidden = true;
    yearSlider.value = '2026';
    state.selectedYear = 2026;
    yearValue.textContent = '2026';
    document.getElementById('freeze-positions').checked = false;
    state.freezePositions = false;
    document.getElementById('node-details').classList.add('hidden');
    renderer.getCamera().animatedReset({ duration: 300 });
    refresh();
    relayout();
  });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('graph-container').innerHTML =
    `<p style="padding:20px;color:#ff6b6b">Failed to load network data: ${err.message}. Check the console and the files in /public/data.</p>`;
});
