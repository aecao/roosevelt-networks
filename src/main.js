import Graph from 'graphology';
import Sigma from 'sigma';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { circular } from 'graphology-layout';
import { DATA, PALETTE } from './config.js';
import { loadActors, loadEdgeManifest, loadAdjacencyMatrix } from './data.js';

const state = {
  graph: null,
  renderer: null,
  activeEdgeTypes: new Set(),
  activeNodeTypes: new Set(),
  categoryColors: new Map(),
};

async function buildGraph() {
  const graph = new Graph({ multi: true });

  const actors = await loadActors();
  const categories = [...new Set(actors.map((a) => a[DATA.nodeCategoryField] || 'Unknown'))].sort();
  categories.forEach((cat, i) => state.categoryColors.set(cat, PALETTE[i % PALETTE.length]));

  actors.forEach((actor) => {
    const id = actor[DATA.nodeIdField];
    if (!id) return;
    const category = actor[DATA.nodeCategoryField] || 'Unknown';
    graph.addNode(id, {
      label: actor[DATA.nodeLabelField] || id,
      size: 6,
      color: state.categoryColors.get(category),
      category,
      attributes: actor,
      x: Math.random(),
      y: Math.random(),
    });
  });

  const manifest = await loadEdgeManifest();
  const edgeTypes = [];

  for (const entry of manifest) {
    const edges = await loadAdjacencyMatrix(entry.file);
    edgeTypes.push(entry.type);
    edges.forEach(({ source, target, weight }) => {
      if (!graph.hasNode(source) || !graph.hasNode(target)) {
        console.warn(`Skipping edge ${source} -> ${target}: unknown actor id (check "${DATA.nodeIdField}" matches matrix headers)`);
        return;
      }
      graph.addEdge(source, target, {
        type: 'line',
        adjacencyType: entry.type,
        label: entry.label,
        weight,
        size: 1,
        color: '#4a4f5c',
      });
    });
  }

  state.activeEdgeTypes = new Set(edgeTypes);
  state.activeNodeTypes = new Set(categories);

  circular.assign(graph);
  forceAtlas2.assign(graph, { iterations: 150, settings: { gravity: 1, scalingRatio: 10 } });

  return { graph, categories, manifest };
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
  const { graph, categories, manifest } = await buildGraph();
  state.graph = graph;

  const container = document.getElementById('graph-container');
  const renderer = new Sigma(graph, container, {
    minCameraRatio: 0.05,
    maxCameraRatio: 10,
    labelRenderedSizeThreshold: 8,
    labelColor: { color: '#ffffff' },
    labelFont: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  });
  state.renderer = renderer;

  function refresh() {
    renderer.refresh();
  }

  renderer.setSetting('nodeReducer', (node, data) => {
    const hidden = !state.activeNodeTypes.has(data.category);
    return hidden ? { ...data, hidden: true } : data;
  });

  renderer.setSetting('edgeReducer', (edge, data) => {
    const [source, target] = graph.extremities(edge);
    const nodesVisible = state.activeNodeTypes.has(graph.getNodeAttribute(source, 'category'))
      && state.activeNodeTypes.has(graph.getNodeAttribute(target, 'category'));
    const hidden = !state.activeEdgeTypes.has(data.adjacencyType) || !nodesVisible;
    return hidden ? { ...data, hidden: true } : data;
  });

  // Edge type filters
  buildFilterCheckboxes(
    document.getElementById('edge-type-filters'),
    manifest.map((m) => ({ value: m.type, label: m.label })),
    state.activeEdgeTypes,
    () => '#4a4f5c',
    refresh,
  );

  // Node category filters
  buildFilterCheckboxes(
    document.getElementById('node-type-filters'),
    categories.map((c) => ({ value: c, label: c })),
    state.activeNodeTypes,
    (value) => state.categoryColors.get(value),
    refresh,
  );

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
    document.querySelectorAll('#edge-type-filters input, #node-type-filters input').forEach((cb) => {
      cb.checked = true;
    });
    state.activeEdgeTypes = new Set(manifest.map((m) => m.type));
    state.activeNodeTypes = new Set(categories);
    document.getElementById('node-details').classList.add('hidden');
    renderer.getCamera().animatedReset({ duration: 300 });
    refresh();
  });
}

main().catch((err) => {
  console.error(err);
  document.getElementById('graph-container').innerHTML =
    `<p style="padding:20px;color:#ff6b6b">Failed to load network data: ${err.message}. Check the console and the files in /public/data.</p>`;
});
