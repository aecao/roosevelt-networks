import Graph from 'graphology';
import Sigma from 'sigma';
import EdgeCurveProgram, { EdgeCurvedArrowProgram } from '@sigma/edge-curve';
import betweennessCentrality from 'graphology-metrics/centrality/betweenness';
import closenessCentrality from 'graphology-metrics/centrality/closeness';
import eigenvectorCentrality from 'graphology-metrics/centrality/eigenvector';
import { drawDiscNodeHover, drawDiscNodeLabel, EdgeArrowProgram, EdgeLineProgram } from 'sigma/rendering';
import { animateNodes } from 'sigma/utils';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { circular } from 'graphology-layout';
import { DATA, PALETTE } from './config.js';
import { dataLoadState, loadActors, loadEdgeManifest, loadAdjacencyMatrix } from './data.js';

const mapGeoModule = import('./map-mode.js');

const MIN_SIZE = 4;
const MAX_SIZE = 8;
const CORE_NODE_SIZE = 2;
const REFERENCE_CAMERA_RATIO = 0.3;
const REFERENCE_SIZE_RATIO = Math.sqrt(REFERENCE_CAMERA_RATIO);
const POSITION_EDGE_TYPE = 'pos';
// The gravity slider's displayed value is intentionally inverted (higher slider value
// = looser/more spread out), since that reads more intuitively than raw ForceAtlas2
// gravity (where higher actually pulls tighter). state.layoutGravity holds the
// displayed slider value; this converts it to the real gravity fed to ForceAtlas2.
const LAYOUT_GRAVITY_MAX = 25;
function actualGravityFromDisplayValue(displayValue) {
  return LAYOUT_GRAVITY_MAX - displayValue;
}
function buildLayoutSettings() {
  return { iterations: 150, settings: { gravity: actualGravityFromDisplayValue(state.layoutGravity), scalingRatio: 10 } };
}
// Maps the 0-100% curvature slider onto the actual curvature scale: 20% reproduces
// today's default look (scale 1), 100% is far more curved (scale 5).
const EDGE_CURVATURE_MAX_SCALE = 5;
function edgeCurvaturePercentToScale(percent) {
  return (percent / 100) * EDGE_CURVATURE_MAX_SCALE;
}

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
  zoomToSelected: true,
  sizeMode: 'scale-of-actor',
  centralityFilterType: 'degree-centrality',
  centralityThreshold: 0,
  edgeCurvatureScale: 1,
  layoutGravity: 20,
  yearFilterEnabled: false,
  selectedYear: 2026,
  detailsManuallyCollapsed: true,
  selectedEdgeIds: new Set(),
  hoveredEdgeIds: new Set(),
  currentSelection: null,
  pinnedSelections: [],
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

function createSvgElement(name, attributes = {}, text = null) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text !== null) element.textContent = text;
  return element;
}

function sizeForActorScale(scale) {
  const scaleRank = { MICRO: 0, MESO: 1, MACRO: 2 }[scale];
  if (scaleRank === undefined) return (MIN_SIZE + MAX_SIZE) / 2;
  return MIN_SIZE + (scaleRank / 2) * (MAX_SIZE - MIN_SIZE);
}

function assignParallelEdgeCurves(graph) {
  const edgesByPair = new Map();
  graph.forEachEdge((edge, attrs, source, target) => {
    const pair = [source, target].sort();
    const key = JSON.stringify(pair);
    if (!edgesByPair.has(key)) edgesByPair.set(key, { pair, edges: [] });
    edgesByPair.get(key).edges.push({ edge, source, attrs });
  });

  edgesByPair.forEach(({ pair, edges }) => {
    if (edges.length < 2) return;
    edges.slice(1).forEach(({ edge, source, attrs }, index) => {
      const magnitude = 0.05 + Math.floor(index / 2) * 0.025;
      const side = index % 2 === 0 ? 1 : -1;
      const direction = source === pair[0] ? 1 : -1;
      graph.setEdgeAttribute(edge, 'type', attrs.type === 'arrow' ? 'curvedArrow' : 'curve');
      // 'baseCurvature' is the un-scaled value; the rendered 'curvature' is this scaled by state.edgeCurvatureScale.
      graph.setEdgeAttribute(edge, 'baseCurvature', side * direction * magnitude);
      graph.setEdgeAttribute(edge, 'curvature', side * direction * magnitude);
    });
  });
}

// Rescales every curved edge's rendered 'curvature' from its unscaled 'baseCurvature',
// so the slider can flatten (0) or exaggerate (>1) curves without recomputing offsets.
function applyEdgeCurvatureScale(graph) {
  graph.forEachEdge((edge, attrs) => {
    if (!Number.isFinite(attrs.baseCurvature)) return;
    graph.setEdgeAttribute(edge, 'curvature', attrs.baseCurvature * state.edgeCurvatureScale);
  });
}

async function buildGraph(fromGoogleSheets = false, onProgress = () => {}) {
  const graph = new Graph({ multi: true });

  const actors = await loadActors(fromGoogleSheets);
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
    const fullName = actor[DATA.nodeLabelField] || id;
    const abbreviation = (actor[DATA.nodeAbbreviationField] || '').trim();
    const actorTopics = (actor[DATA.nodeTopicField] || '')
      .split(',')
      .map((topic) => topic.trim().toUpperCase())
      .filter(Boolean);
    graph.addNode(id, {
      label: abbreviation || fullName,
      size: sizeForActorScale(parseScale(actor[DATA.nodeScaleField])),
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

  const totalSteps = manifest.length + 1;
  let completedSteps = 1;
  onProgress(completedSteps, totalSteps);

  const adjacencyMatrices = await Promise.all(manifest.map(async (entry) => {
    const edges = await loadAdjacencyMatrix(entry.file, fromGoogleSheets);
    completedSteps += 1;
    onProgress(completedSteps, totalSteps);
    return { entry, edges };
  }));

  for (const { entry, edges } of adjacencyMatrices) {
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

  assignParallelEdgeCurves(graph);

  state.activeEdgeTypes = new Set(edgeTypes);
  state.activeNodeTypes = new Set(categories);
  state.activeTopics = new Set(topics);
  state.activeScales = new Set(scales);

  const positions = computeFilteredLayout(graph, state.activeEdgeTypes);
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'x', positions[node].x);
    graph.setNodeAttribute(node, 'y', positions[node].y);
  });

  return { graph, categories, scales, manifest };
}

// Lays out a copy of the graph containing only the currently active adjacency
// types, so the layout reflects what's actually selected.
function computeFilteredLayout(graph, activeEdgeTypes, includeNode = () => true) {
  const temp = new Graph({ multi: true });
  graph.forEachNode((node) => {
    if (includeNode(node)) temp.addNode(node);
  });
  graph.forEachEdge((edge, attrs, source, target) => {
    if (activeEdgeTypes.has(attrs.adjacencyType) && temp.hasNode(source) && temp.hasNode(target)) {
      temp.addEdge(source, target);
    }
  });
  if (temp.order === 0) return {};
  circular.assign(temp);
  forceAtlas2.assign(temp, buildLayoutSettings());

  const positions = {};
  temp.forEachNode((node, attrs) => {
    positions[node] = { x: attrs.x, y: attrs.y };
  });
  return positions;
}

function buildFilterCheckboxes(container, items, activeSet, colorFor, onChange, selectAllId) {
  container.innerHTML = '';
  const selectAll = document.getElementById(selectAllId);
  const syncSelectAll = () => {
    const activeCount = items.filter((item) => activeSet.has(item.value)).length;
    selectAll.checked = activeCount === items.length;
    selectAll.indeterminate = activeCount > 0 && activeCount < items.length;
  };

  selectAll.addEventListener('change', () => {
    activeSet.clear();
    if (selectAll.checked) items.forEach((item) => activeSet.add(item.value));
    container.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
      checkbox.checked = selectAll.checked;
    });
    selectAll.indeterminate = false;
    onChange();
  });


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
      syncSelectAll();
      onChange();
    });
  });
  syncSelectAll();
}

function syncDetailsSidebar() {
  const detailsSidebar = document.getElementById('details-sidebar');
  const hasContent = Boolean(state.currentSelection) || state.pinnedSelections.length > 0;
  detailsSidebar.classList.toggle('has-selection', hasContent);
  if (state.detailsManuallyCollapsed
    && !window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
    detailsSidebar.classList.add('has-unread');
  }
}

function createNodeSelection(graph, nodeId) {
  const attrs = graph.getNodeAttribute(nodeId, 'attributes') || {};
  const fullName = attrs[DATA.nodeLabelField] || graph.getNodeAttribute(nodeId, 'label');
  return {
    key: `node:${nodeId}`,
    kind: 'node',
    title: fullName,
    nodeIds: [nodeId],
    nodeIds: [nodeId],
    fields: Object.entries(attrs).filter(([, value]) => value),
  };
}

function createEdgeSelection(graph, edge) {
  const [source, target] = graph.extremities(edge);
  const getFullName = (node) => {
    const attrs = graph.getNodeAttribute(node, 'attributes') || {};
    return attrs[DATA.nodeLabelField] || graph.getNodeAttribute(node, 'label') || node;
  };
  const actorNames = [getFullName(source), getFullName(target)];
  const adjacencyTypes = new Set();
  const selectedEdgeIds = new Set();

  graph.forEachEdge((candidate, attrs, edgeSource, edgeTarget) => {
    const samePair = (edgeSource === source && edgeTarget === target)
      || (edgeSource === target && edgeTarget === source);
    if (samePair) {
      selectedEdgeIds.add(candidate);
      adjacencyTypes.add(attrs.label || attrs.adjacencyType);
    }
  });

  return {
    key: `edge:${JSON.stringify([source, target].sort())}`,
    kind: 'edge',
    title: actorNames.join(' ↔ '),
    nodeIds: [source, target],
    nodeIds: [source, target],
    actorNames,
    adjacencyTypes: [...adjacencyTypes],
    edgeIds: [...selectedEdgeIds],
  };
}

function renderSelectionDetails(selection, container) {
  container.replaceChildren();
  const details = document.createElement('dl');
  if (selection.kind === 'node') {
    selection.fields.forEach(([name, value]) => {
      const term = document.createElement('dt');
      term.textContent = name;
      const description = document.createElement('dd');
      description.textContent = value;
      details.append(term, description);
    });
  } else {
    const actorsTerm = document.createElement('dt');
    actorsTerm.textContent = 'Connected actors';
    details.appendChild(actorsTerm);
    selection.actorNames.forEach((name) => {
      const actor = document.createElement('dd');
      actor.textContent = name;
      details.appendChild(actor);
    });

    const typesTerm = document.createElement('dt');
    typesTerm.textContent = 'Adjacency types';
    const typesDescription = document.createElement('dd');
    const types = document.createElement('ul');
    types.className = 'detail-list';
    selection.adjacencyTypes.forEach((type) => {
      const item = document.createElement('li');
      item.textContent = type;
      types.appendChild(item);
    });
    typesDescription.appendChild(types);
    details.append(typesTerm, typesDescription);
  }
  container.appendChild(details);
}

function renderCurrentSelection() {
  const section = document.getElementById('active-selection');
  const title = document.getElementById('current-selection-title');
  const pinButton = document.getElementById('pin-selection');
  section.hidden = !state.currentSelection;
  if (state.currentSelection) {
    title.textContent = state.currentSelection.title;
    const alreadyPinned = state.pinnedSelections.some(({ key }) => key === state.currentSelection.key);
    pinButton.disabled = false;
    pinButton.textContent = alreadyPinned ? 'Unpin' : 'Pin';
    pinButton.setAttribute('aria-pressed', String(alreadyPinned));
    renderSelectionDetails(state.currentSelection, document.getElementById('node-details'));
  }
  syncDetailsSidebar();
}

function syncSearchPinButtons() {
  document.querySelectorAll('.search-result-pin').forEach((button) => {
    const selectionKey = `node:${button.dataset.nodeId}`;
    const isPinned = state.pinnedSelections.some(({ key }) => key === selectionKey);
    button.textContent = isPinned ? 'Unpin' : 'Pin';
    button.setAttribute('aria-pressed', String(isPinned));
    button.setAttribute('aria-label', `${isPinned ? 'Unpin' : 'Pin'} ${button.dataset.actorName}`);
  });
}

function togglePinnedSelection(selection) {
  const existingIndex = state.pinnedSelections.findIndex(({ key }) => key === selection.key);
  if (existingIndex >= 0) {
    state.pinnedSelections.splice(existingIndex, 1);
  } else {
    state.pinnedSelections.push({ ...selection, collapsed: true });
  }
  renderPinnedSelections();
  renderCurrentSelection();
  syncSearchPinButtons();
}

function movePinnedSelection(sourceKey, targetKey, insertBefore) {
  if (sourceKey === targetKey) return;
  const sourceIndex = state.pinnedSelections.findIndex(({ key }) => key === sourceKey);
  if (sourceIndex < 0) return;
  const [selection] = state.pinnedSelections.splice(sourceIndex, 1);
  const targetIndex = state.pinnedSelections.findIndex(({ key }) => key === targetKey);
  if (targetIndex < 0) {
    state.pinnedSelections.push(selection);
  } else {
    state.pinnedSelections.splice(targetIndex + (insertBefore ? 0 : 1), 0, selection);
  }
  renderPinnedSelections();
}

function renderPinnedSelections() {
  const section = document.getElementById('pinned-section');
  const list = document.getElementById('pinned-list');
  document.getElementById('pinned-count').textContent = String(state.pinnedSelections.length);
  section.hidden = state.pinnedSelections.length === 0;
  list.replaceChildren();

  state.pinnedSelections.forEach((selection) => {
    const item = document.createElement('li');
    item.className = 'pinned-item';
    item.dataset.key = selection.key;

    const header = document.createElement('div');
    header.className = 'pinned-item-header';

    const grip = document.createElement('span');
    grip.className = 'pinned-grip';
    grip.textContent = '⋮⋮';
    grip.draggable = true;
    grip.title = 'Drag to reorder';
    grip.setAttribute('aria-label', `Reorder ${selection.title}`);
    grip.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', selection.key);
      event.dataTransfer.effectAllowed = 'move';
      item.classList.add('dragging');
    });
    grip.addEventListener('dragend', () => item.classList.remove('dragging'));

    const disclosure = document.createElement('button');
    disclosure.className = 'pinned-disclosure';
    disclosure.type = 'button';
    disclosure.textContent = selection.collapsed ? '▸' : '▾';
    disclosure.title = selection.collapsed ? 'Expand selection' : 'Collapse selection';
    disclosure.setAttribute('aria-label', disclosure.title);
    disclosure.setAttribute('aria-expanded', String(!selection.collapsed));
    disclosure.addEventListener('click', () => {
      selection.collapsed = !selection.collapsed;
      renderPinnedSelections();
    });

    const title = document.createElement('span');
    title.className = 'pinned-title';
    title.textContent = selection.title;

    const unpin = document.createElement('button');
    unpin.className = 'unpin-selection';
    unpin.type = 'button';
    unpin.textContent = '×';
    unpin.title = 'Unpin selection';
    unpin.setAttribute('aria-label', `Unpin ${selection.title}`);
    unpin.addEventListener('click', () => {
      state.pinnedSelections = state.pinnedSelections.filter(({ key }) => key !== selection.key);
      renderPinnedSelections();
      renderCurrentSelection();
      syncSearchPinButtons();
    });

    header.append(grip, disclosure, title, unpin);
    item.appendChild(header);
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      item.classList.add('drag-over');
    });
    item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('drag-over');
      const rect = item.getBoundingClientRect();
      movePinnedSelection(event.dataTransfer.getData('text/plain'), selection.key, event.clientY < rect.top + rect.height / 2);
    });

    const content = document.createElement('div');
    content.className = 'pinned-content details';
    content.hidden = selection.collapsed;
    if (!selection.collapsed) renderSelectionDetails(selection, content);
    item.appendChild(content);
    list.appendChild(item);
  });

  syncDetailsSidebar();
}

function showNodeDetails(graph, nodeId) {
  state.selectedEdgeIds.clear();
  state.renderer?.refresh();
  state.currentSelection = createNodeSelection(graph, nodeId);
  renderCurrentSelection();
}

function showEdgeDetails(graph, edge) {
  state.currentSelection = createEdgeSelection(graph, edge);
  state.selectedEdgeIds = new Set(state.currentSelection.edgeIds);
  state.renderer?.refresh();
  renderCurrentSelection();
}

async function main() {
  const workspace = document.getElementById('workspace');
  const sizeModeSelect = document.getElementById('size-mode');
  state.sizeMode = sizeModeSelect.value;
  const centralityTypeSelect = document.getElementById('centrality-type');
  const centralityThresholdSlider = document.getElementById('centrality-threshold-slider');
  const centralityThresholdValue = document.getElementById('centrality-threshold-value');
  const centralityThresholdTicks = document.getElementById('centrality-threshold-ticks');
  const centralityThresholdDecrement = document.getElementById('centrality-threshold-decrement');
  const centralityThresholdIncrement = document.getElementById('centrality-threshold-increment');
  state.centralityFilterType = centralityTypeSelect.value;
  state.centralityThreshold = Number(centralityThresholdSlider.value);
  const edgeCurvatureSlider = document.getElementById('edge-curvature-slider');
  const edgeCurvatureValue = document.getElementById('edge-curvature-value');
  const edgeCurvatureDecrement = document.getElementById('edge-curvature-decrement');
  const edgeCurvatureIncrement = document.getElementById('edge-curvature-increment');
  state.edgeCurvatureScale = edgeCurvaturePercentToScale(Number(edgeCurvatureSlider.value));
  const layoutGravitySlider = document.getElementById('layout-gravity-slider');
  const layoutGravityValue = document.getElementById('layout-gravity-value');
  const layoutGravityDecrement = document.getElementById('layout-gravity-decrement');
  const layoutGravityIncrement = document.getElementById('layout-gravity-increment');
  state.layoutGravity = Number(layoutGravitySlider.value);
  const sidebar = document.getElementById('sidebar');
  const panelDock = document.getElementById('panel-dock');
  const detailsSidebar = document.getElementById('details-sidebar');
  const graphContainer = document.getElementById('graph-container');
  const modeTabs = [...document.querySelectorAll('.mode-tab')];
  const panelTabs = [...document.querySelectorAll('.panel-tab')];
  const pinSelectionButton = document.getElementById('pin-selection');
  const selectionContextMenu = document.getElementById('selection-context-menu');
  const contextPinToggle = document.getElementById('context-pin-toggle');
  const timelineView = document.getElementById('timeline-view');
  const timelineAxis = document.getElementById('timeline-axis');
  const timelineChart = document.getElementById('timeline-chart');
  const timelineSummary = document.getElementById('timeline-summary');
  const timelineStartInput = document.getElementById('timeline-start');
  const timelineEndInput = document.getElementById('timeline-end');
  const mapCaption = document.getElementById('map-caption');
  let timelineStart = 1920;
  let timelineEnd = 2026;
  let contextSelection = null;
  let mapGeography = null;
  let mapModeApplied = false;
  let mapGeoCanvas = null;
  let mapGeoContext = null;
  let mapGeoFrontCanvas = null;
  let mapGeoFrontContext = null;
  let mapProjection = null;
  let mapCenterX = 0;
  let mapCenterY = 0;
  let mapCancelAnimation = null;
  const mapOriginalPositions = new Map();
  let frozenRelationshipsPositions = null;

  function setPanel(panel) {
    panelDock.dataset.panel = panel;
    panelTabs.forEach((tab) => {
      tab.setAttribute('aria-pressed', String(tab.dataset.panel === panel));
    });
  }

  panelTabs.forEach((tab) => {
    tab.addEventListener('click', () => setPanel(tab.dataset.panel));
  });

  function togglePinnedSelectionAndZoom(selection) {
    togglePinnedSelection(selection);
    if (state.zoomToSelected) zoomToCurrentAndPinned();
  }

  pinSelectionButton.addEventListener('click', () => {
    if (state.currentSelection) togglePinnedSelectionAndZoom(state.currentSelection);
  });

  function setMode(mode) {
    const isMap = mode === 'map';
    const leavingRelationships = workspace.dataset.mode === 'relationships' && mode !== 'relationships';
    if (leavingRelationships && state.freezePositions) {
      frozenRelationshipsPositions = new Map();
      graph.forEachNode((node, attrs) => frozenRelationshipsPositions.set(node, { x: attrs.x, y: attrs.y }));
    }
    workspace.dataset.mode = mode;
    timelineView.setAttribute('aria-hidden', String(mode !== 'timeline'));
    mapCaption.hidden = !isMap;
    modeTabs.forEach((tab) => {
      tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
    });
    if (!isMap) restoreRelationshipsLayout();
    if (mode === 'timeline' && state.graph) renderTimeline();
    if (mode === 'relationships' && state.renderer) {
      refresh();
      relayout();
    }
    if (isMap) applyMapLayout();
  }

  modeTabs.forEach((tab) => {
    tab.addEventListener('click', () => setMode(tab.dataset.mode));
  });
  setMode(workspace.dataset.mode);

  function showPinContextMenu(selection, mouseCoords) {
    contextSelection = selection;
    const isPinned = state.pinnedSelections.some(({ key }) => key === selection.key);
    contextPinToggle.textContent = isPinned ? 'Unpin selection' : 'Pin selection';
    const mouseEvent = mouseCoords.original;
    mouseEvent.preventDefault();
    selectionContextMenu.hidden = false;
    const menuBounds = selectionContextMenu.getBoundingClientRect();
    selectionContextMenu.style.left = `${Math.max(8, Math.min(mouseEvent.clientX, window.innerWidth - menuBounds.width - 8))}px`;
    selectionContextMenu.style.top = `${Math.max(8, Math.min(mouseEvent.clientY, window.innerHeight - menuBounds.height - 8))}px`;
  }

  function updateHoveredEdgePair(edge) {
    const [source, target] = graph.extremities(edge);
    const hoveredEdges = new Set();
    graph.forEachEdge((candidate, attrs, edgeSource, edgeTarget) => {
      const samePair = (edgeSource === source && edgeTarget === target)
        || (edgeSource === target && edgeTarget === source);
      if (samePair) hoveredEdges.add(candidate);
    });
    state.hoveredEdgeIds = hoveredEdges;
    refresh();
  }

  function clearHoveredEdges() {
    if (state.hoveredEdgeIds.size === 0) return;
    state.hoveredEdgeIds.clear();
    refresh();
  }

  contextPinToggle.addEventListener('click', () => {
    if (!contextSelection) return;
    togglePinnedSelectionAndZoom(contextSelection);
    selectionContextMenu.hidden = true;
    if (window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
      setPanel('details');
    }
  });
  selectionContextMenu.addEventListener('pointerdown', (event) => event.stopPropagation());
  document.addEventListener('pointerdown', (event) => {
    if (!selectionContextMenu.contains(event.target)) selectionContextMenu.hidden = true;
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') selectionContextMenu.hidden = true;
  });

  const refreshButton = document.getElementById('refresh-sheets');
  const refreshStatus = document.getElementById('refresh-status');
  const refreshProgress = document.getElementById('refresh-progress');
  const refreshProgressBar = document.getElementById('refresh-progress-bar');
  const fromGoogleSheets = new URL(window.location.href).searchParams.get('source') === 'sheets';

  function updateRefreshProgress(completed, total) {
    const percent = total ? Math.round((completed / total) * 100) : 0;
    refreshProgressBar.style.width = `${percent}%`;
    refreshProgress.setAttribute('aria-valuenow', String(percent));
  }

  refreshButton.addEventListener('click', () => {
    refreshButton.disabled = true;
    refreshStatus.hidden = false;
    refreshStatus.textContent = 'Fetching published sheets…';
    const url = new URL(window.location.href);
    url.searchParams.set('source', 'sheets');
    url.searchParams.set('refresh', String(Date.now()));
    window.location.assign(url);
  });

  refreshButton.disabled = true;
  refreshStatus.hidden = false;
  refreshStatus.textContent = fromGoogleSheets ? 'Loading published sheets…' : 'Loading local data…';
  if (fromGoogleSheets) {
    refreshProgress.hidden = false;
    updateRefreshProgress(0, 1);
  }

  const { graph, categories, scales, manifest } = await buildGraph(fromGoogleSheets, updateRefreshProgress);
  refreshButton.disabled = false;
  refreshProgress.hidden = true;
  refreshStatus.textContent = !fromGoogleSheets
    ? 'Using local data'
    : dataLoadState.usedLocalFallback
      ? 'Sheets incomplete; local CSV fallback used'
      : 'Updated from Google Sheets';
  const url = new URL(window.location.href);
  url.searchParams.delete('refresh');
  window.history.replaceState(null, '', url);
  state.graph = graph;
  if (workspace.dataset.mode === 'map') applyMapLayout();

  const container = document.getElementById('graph-container');
  const renderer = new Sigma(graph, container, {
    minCameraRatio: 0.05,
    maxCameraRatio: 10,
    doubleClickZoomingRatio: 1,
    doubleClickZoomingRatio: 1,
    zoomToSizeRatioFunction: (ratio) => (ratio / REFERENCE_CAMERA_RATIO) * REFERENCE_SIZE_RATIO,
    labelDensity: 0.35,
    labelRenderedSizeThreshold: 10,
    labelColor: { color: '#ffffff' },
    labelFont: '"Helvetica Neue Light", "Helvetica Neue", Helvetica, Arial, sans-serif',
    labelWeight: '300',
    labelSize: 10,
    defaultDrawNodeLabel: (context, data, settings) => {
      const size = Math.max(9, Math.min(15, 8 + data.size * 0.3));
      drawDiscNodeLabel(context, data, { ...settings, labelSize: size });
      const attributes = graph.getNodeAttribute(data.key, 'attributes') || {};
      const fullName = attributes[DATA.nodeLabelField] || data.label;
      if (fullName === data.label || data.size < 12) return;
      const secondarySize = Math.max(7, Math.min(9, size * 0.7));
      const textColor = settings.labelColor.attribute
        ? graph.getNodeAttribute(data.key, settings.labelColor.attribute) || settings.labelColor.color || '#000000'
        : settings.labelColor.color;
      context.font = `${settings.labelWeight} ${secondarySize}px ${settings.labelFont}`;
      context.fillStyle = textColor;
      context.fillText(fullName, data.x + data.size + 3, data.y + size / 3 + secondarySize + 2);
    },
    defaultDrawNodeHover: (context, data, settings) => {
      const size = Math.max(10, Math.min(16, 9 + data.size * 0.3));
      drawDiscNodeHover(context, data, {
        ...settings,
        labelSize: size,
        labelColor: { color: '#171717' },
      });
    },
    enableEdgeEvents: true,
    defaultEdgeType: 'line',
    edgeProgramClasses: {
      line: EdgeLineProgram,
      arrow: EdgeArrowProgram,
      curve: EdgeCurveProgram,
      curvedArrow: EdgeCurvedArrowProgram,
    },
  });
  state.renderer = renderer;
  // Starts the relationship diagram ~2x as zoomed in as Sigma's default full-extent fit.
  renderer.getCamera().setState({ ...renderer.getCamera().getState(), ratio: 0.5 });

  function refresh() {
    renderer.refresh();
  }

  let cancelAnimation = null;
  let centralityFilterScoreCache = null;
  // 1-based rank (ascending by connection count) per node, and the connection count
  // shown at each slider index; index 0 always means "no node filtered out".
  let centralityThresholdRanks = new Map();
  let centralityThresholdSteps = [0];
  let centralityThresholdTickIndices = [0];
  function relayout() {
    centralityFilterScoreCache = null;
    if (workspace.dataset.mode === 'timeline') {
      renderTimeline();
      return;
    }
    if (workspace.dataset.mode === 'map') {
      if (mapModeApplied) runMapForceLayout();
      return;
    }
    if (workspace.dataset.mode !== 'relationships') return;
    updateNodeSizes();
    updateCentralityThresholdRange();
    if (state.freezePositions) {
      renderer.refresh();
      return;
    }
    if (cancelAnimation) cancelAnimation();
    const positions = computeFilteredLayout(graph, state.activeEdgeTypes, isNodeVisible);
    if (!Object.keys(positions).length) {
      renderer.refresh();
      return;
    }
    cancelAnimation = animateNodes(graph, positions, { duration: 700, easing: 'quadraticInOut' });
  }

  sizeModeSelect.addEventListener('change', relayout);

  function isNodeVisibleBase(node) {
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

  function getCentralityFilterScores() {
    if (!centralityFilterScoreCache) centralityFilterScoreCache = centralityScores(state.centralityFilterType);
    return centralityFilterScoreCache;
  }

  function updateCentralityThresholdRange() {
    if (state.centralityFilterType !== 'degree-centrality') return;
    const scores = getCentralityFilterScores();
    const sortedEntries = Object.entries(scores).sort((first, second) => first[1] - second[1]);
    centralityThresholdRanks = new Map(sortedEntries.map(([node], rank) => [node, rank + 1]));
    centralityThresholdSteps = [0, ...sortedEntries.map(([, value]) => value)];
    const maxIndex = sortedEntries.length;
    centralityThresholdSlider.min = '0';
    centralityThresholdSlider.max = String(maxIndex);
    centralityThresholdSlider.step = '1';
    const index = Math.min(state.centralityThreshold, maxIndex);
    state.centralityThreshold = index;
    centralityThresholdSlider.value = String(index);
    centralityThresholdValue.textContent = String(centralityThresholdSteps[index] ?? 0);
    // Only mark indices where the connection-count value actually changes, so ticks
    // cluster where many nodes tie (usually the low end) and spread out where values
    // are mostly unique (usually the high end).
    const tickIndices = centralityThresholdSteps
      .map((value, stepIndex) => (stepIndex === 0 || value !== centralityThresholdSteps[stepIndex - 1] ? stepIndex : null))
      .filter((stepIndex) => stepIndex !== null);
    centralityThresholdTickIndices = tickIndices;
    centralityThresholdTicks.replaceChildren(...tickIndices.map((tickIndex) => {
      const option = document.createElement('option');
      option.value = String(tickIndex);
      return option;
    }));
    centralityThresholdDecrement.disabled = index <= tickIndices[0];
    centralityThresholdIncrement.disabled = index >= tickIndices[tickIndices.length - 1];
  }

  function passesCentralityThreshold(node) {
    if (state.centralityThreshold <= 0) return true;
    // Only degree centrality filtering is implemented so far; other types pass through.
    if (state.centralityFilterType !== 'degree-centrality') return true;
    const rank = centralityThresholdRanks.get(node) ?? 0;
    return rank > state.centralityThreshold;
  }

  function isNodeVisible(node) {
    return isNodeVisibleBase(node) && passesCentralityThreshold(node);
  }

  function isTimelineActorVisible(node) {
    const attrs = graph.getNodeAttributes(node);
    const hasSelectedTopic = state.activeTopics.size === state.allTopics.size
      || attrs.topics.some((topic) => state.activeTopics.has(topic));
    return state.activeNodeTypes.has(attrs.category)
      && hasSelectedTopic
      && state.activeScales.has(attrs.scale);
  }

  function renderTimeline() {
    if (!state.graph || workspace.dataset.mode !== 'timeline') return;

    const width = Math.max(320, Math.floor(timelineView.clientWidth));
    const labelWidth = Math.min(260, Math.max(150, Math.floor(width * 0.27)));
    const plotLeft = labelWidth;
    const plotRight = width - 14;
    const plotWidth = Math.max(1, plotRight - plotLeft);
    const yearCount = timelineEnd - timelineStart + 1;
    const axisHeight = 54;
    const rowHeight = 28;
    const rowTop = 8;
    const actors = graph.nodes().filter(isTimelineActorVisible).map((node) => ({
      id: node,
      ...graph.getNodeAttributes(node),
    }));
    const undatedCount = actors.filter((actor) => actor.yearStart === null && actor.yearEnd === null).length;
    const datedActors = actors.filter((actor) => actor.yearStart !== null || actor.yearEnd !== null)
      .map((actor) => ({
        ...actor,
        start: Math.max(timelineStart, actor.yearStart ?? timelineStart),
        end: Math.min(timelineEnd, actor.yearEnd ?? timelineEnd),
      }))
      .filter((actor) => actor.start <= actor.end)
      .sort((first, second) => first.start - second.start
        || String(first.label).localeCompare(String(second.label)));
    const outsideRangeCount = actors.length - undatedCount - datedActors.length;
      const actorsById = new Map(datedActors.map((actor) => [actor.id, actor]));
      const actorParents = new Map(datedActors.map((actor) => [actor.id, actor.id]));
      const findActorRoot = (actorId) => {
        const currentParent = actorParents.get(actorId);
        if (currentParent === actorId) return actorId;
        const root = findActorRoot(currentParent);
        actorParents.set(actorId, root);
        return root;
      };
      const joinPredecessors = (source, target) => {
        const sourceRoot = findActorRoot(source);
        const targetRoot = findActorRoot(target);
        if (sourceRoot === targetRoot) return;
        if (sourceRoot.localeCompare(targetRoot) < 0) actorParents.set(targetRoot, sourceRoot);
        else actorParents.set(sourceRoot, targetRoot);
      };
      const predecessorEdges = [];
      graph.forEachEdge((edge, attributes, source, target) => {
        if (attributes.adjacencyType !== 'pre' || !actorsById.has(source) || !actorsById.has(target)) return;
        predecessorEdges.push({ source, target });
        joinPredecessors(source, target);
      });

      const unitsById = new Map();
      const unitByActor = new Map();
      datedActors.forEach((actor) => {
        const unitId = findActorRoot(actor.id);
        if (!unitsById.has(unitId)) {
          unitsById.set(unitId, {
            id: unitId,
            members: [],
            children: new Set(),
            allChildren: new Set(),
            parents: new Set(),
            parentActorIds: new Set(),
            predecessorEdges: [],
            primaryParent: null,
          });
        }
        unitsById.get(unitId).members.push(actor);
        unitByActor.set(actor.id, unitId);
      });
      const units = [...unitsById.values()];
      const compareUnits = (first, second) => first.start - second.start
        || first.label.localeCompare(second.label);
      units.forEach((unit) => {
        unit.members.sort((first, second) => first.start - second.start
          || String(first.label).localeCompare(String(second.label)));
        unit.start = unit.members[0].start;
        unit.label = unit.members.map((actor) => actor.attributes?.[DATA.nodeLabelField] || actor.label || actor.id)
          .join(' → ');
      });
      predecessorEdges.forEach((edge) => {
        const unit = unitsById.get(unitByActor.get(edge.source));
        if (unit) unit.predecessorEdges.push(edge);
      });
      units.forEach((unit) => {
        const inDegree = new Map(unit.members.map((actor) => [actor.id, 0]));
        unit.predecessorEdges.forEach(({ target }) => inDegree.set(target, (inDegree.get(target) || 0) + 1));
        const ready = unit.members.filter((actor) => inDegree.get(actor.id) === 0);
        const ordered = [];
        const sortActors = (first, second) => first.start - second.start
          || String(first.label).localeCompare(String(second.label));
        while (ready.length) {
          ready.sort(sortActors);
          const actor = ready.shift();
          ordered.push(actor);
          unit.predecessorEdges.filter((edge) => edge.source === actor.id).forEach((edge) => {
            inDegree.set(edge.target, inDegree.get(edge.target) - 1);
            if (inDegree.get(edge.target) === 0) ready.push(actorsById.get(edge.target));
          });
        }
        unit.members = ordered.concat(unit.members.filter((actor) => !ordered.includes(actor)));
        unit.label = unit.members.map((actor) => actor.attributes?.[DATA.nodeLabelField] || actor.label || actor.id)
          .join(' → ');
      });

      graph.forEachEdge((edge, attributes, source, target) => {
        if (attributes.adjacencyType !== 'par') return;
        const parentUnit = unitsById.get(unitByActor.get(source));
        const childUnit = unitsById.get(unitByActor.get(target));
        if (!parentUnit || !childUnit || parentUnit === childUnit) return;
        parentUnit.parentActorIds.add(source);
        parentUnit.allChildren.add(childUnit);
        childUnit.parents.add(parentUnit);
      });
      units.forEach((unit) => {
        const candidates = [...unit.parents].sort((first, second) => {
          const firstDistance = first.start <= unit.start ? unit.start - first.start : 100000 + first.start - unit.start;
          const secondDistance = second.start <= unit.start ? unit.start - second.start : 100000 + second.start - unit.start;
          return firstDistance - secondDistance || compareUnits(first, second);
        });
        unit.primaryParent = candidates[0] || null;
        if (unit.primaryParent) unit.primaryParent.children.add(unit);
      });

      const timelineRows = [];
      const placedUnits = new Set();
      function placeUnit(unit, depth = 0) {
        if (placedUnits.has(unit)) return;
        placedUnits.add(unit);
        unit.rowIndex = timelineRows.length;
        unit.depth = depth;
        timelineRows.push(unit);
        [...unit.children].sort(compareUnits).forEach((child) => placeUnit(child, depth + 1));
      }
      units.filter((unit) => !unit.primaryParent).sort(compareUnits).forEach((unit) => placeUnit(unit));
      units.sort(compareUnits).forEach((unit) => placeUnit(unit));

      function calculateParentSpan(unit, visiting = new Set()) {
        if (unit.parentSpan) return unit.parentSpan;
        if (visiting.has(unit)) return { start: unit.rowIndex, end: unit.rowIndex };
        const nextVisiting = new Set(visiting);
        nextVisiting.add(unit);
        const span = { start: unit.rowIndex, end: unit.rowIndex };
        unit.allChildren.forEach((child) => {
          const childSpan = calculateParentSpan(child, nextVisiting);
          span.start = Math.min(span.start, childSpan.start);
          span.end = Math.max(span.end, childSpan.end);
        });
        unit.parentSpan = span;
        return span;
      }
      units.forEach((unit) => calculateParentSpan(unit));
      const chartHeight = Math.max(80, rowTop + timelineRows.length * rowHeight + 8);
    const boundaryX = (year) => plotLeft + ((year - timelineStart) / yearCount) * plotWidth;
    const yearCenterX = (year) => boundaryX(year) + plotWidth / yearCount / 2;
    const targetLabelCount = Math.max(2, Math.floor(plotWidth / 44));
    const requiredLabelStep = Math.ceil(yearCount / targetLabelCount);
    const labelStep = [1, 2, 5, 10, 20, 25, 50, 100]
      .find((step) => step >= requiredLabelStep) || requiredLabelStep;
    const labelCandidates = new Set([timelineStart, timelineEnd]);
    for (let year = timelineStart; year <= timelineEnd; year += 1) {
      if ((year - timelineStart) % labelStep === 0) labelCandidates.add(year);
    }
    const labeledYears = [timelineStart];
    [...labelCandidates].sort((first, second) => first - second).forEach((year) => {
      if (year === timelineStart) return;
      if (year === timelineEnd) {
        while (labeledYears.length > 1
          && yearCenterX(year) - yearCenterX(labeledYears[labeledYears.length - 1]) < 36) {
          labeledYears.pop();
        }
        labeledYears.push(year);
      } else if (yearCenterX(year) - yearCenterX(labeledYears[labeledYears.length - 1]) >= 36) {
        labeledYears.push(year);
      }
    });

    timelineAxis.setAttribute('viewBox', `0 0 ${width} ${axisHeight}`);
    timelineChart.setAttribute('viewBox', `0 0 ${width} ${chartHeight}`);
    timelineChart.style.height = `${chartHeight}px`;
    timelineAxis.replaceChildren();
    timelineChart.replaceChildren();

    timelineAxis.appendChild(createSvgElement('text', {
      x: 12,
      y: 34,
      fill: '#c5d1cc',
      'font-size': 10,
      'font-weight': 600,
      'letter-spacing': 1,
    }, 'ACTOR'));

    for (let year = timelineStart; year <= timelineEnd + 1; year += 1) {
      const x = boundaryX(year);
      const major = labeledYears.includes(year) || year === timelineEnd + 1;
      timelineAxis.appendChild(createSvgElement('line', {
        x1: x,
        x2: x,
        y1: major ? 34 : 42,
        y2: axisHeight,
        stroke: major ? '#b8c7c0' : '#82938b',
        'stroke-opacity': major ? 0.48 : 0.22,
        'stroke-width': 1,
      }));
      if (year <= timelineEnd && labeledYears.includes(year)) {
        timelineAxis.appendChild(createSvgElement('text', {
          x: yearCenterX(year),
          y: 26,
          fill: '#e5ece8',
          'font-size': 10,
          'text-anchor': 'middle',
        }, String(year)));
      }
    }

    const definitions = createSvgElement('defs');
    const labelClip = createSvgElement('clipPath', { id: 'timeline-label-clip' });
    labelClip.appendChild(createSvgElement('rect', {
      x: 0,
      y: 0,
      width: labelWidth - 10,
      height: chartHeight,
    }));
    definitions.appendChild(labelClip);
    timelineChart.appendChild(definitions);

    for (let year = timelineStart; year <= timelineEnd + 1; year += 1) {
      const x = boundaryX(year);
      timelineChart.appendChild(createSvgElement('line', {
        x1: x,
        x2: x,
        y1: 0,
        y2: chartHeight,
        stroke: '#d7e1dc',
        'stroke-opacity': year === timelineStart || year === timelineEnd + 1 ? 0.32 : 0.12,
        'stroke-width': 1,
      }));
    }

    timelineRows.forEach((unit) => {
      const y = rowTop + unit.rowIndex * rowHeight;
      const row = createSvgElement('g', { 'data-row-unit': unit.id });
      row.appendChild(createSvgElement('line', {
        x1: 0,
        x2: width,
        y1: y + rowHeight,
        y2: y + rowHeight,
        stroke: '#d7e1dc',
        'stroke-opacity': 0.08,
        'stroke-width': 1,
      }));
      const rowLabel = createSvgElement('text', {
        x: 12 + unit.depth * 10,
        y: y + 17,
        fill: '#e3e9e6',
        'font-size': 11,
        'font-weight': unit.parentActorIds.size ? 600 : 400,
        'clip-path': 'url(#timeline-label-clip)',
      }, unit.label);
      rowLabel.appendChild(createSvgElement('title', {}, unit.label));
      row.appendChild(rowLabel);

      const laneHeight = (rowHeight - 4) / unit.members.length;
      const actorLaneCenter = new Map();
      unit.members.forEach((actor, actorIndex) => {
        const color = state.categoryColors.get(actor.category) || '#9ca3af';
        const isParentActor = unit.parentActorIds.has(actor.id);
        const parentSpan = unit.parentSpan;
        const fullName = actor.attributes?.[DATA.nodeLabelField] || actor.label || actor.id;
        const laneY = unit.members.length > 1 ? y + 2 + actorIndex * laneHeight : y + 7;
        const laneBarHeight = unit.members.length > 1 ? Math.max(4, laneHeight - 2) : 12;
        actorLaneCenter.set(actor.id, laneY + laneBarHeight / 2);
        const actorGroup = createSvgElement('g', {
          'data-actor-id': actor.id,
          'data-row-unit': unit.id,
        });
        const bar = createSvgElement('rect', {
          x: boundaryX(actor.start),
          y: isParentActor ? rowTop + parentSpan.start * rowHeight + 3 : laneY,
          width: Math.max(2, boundaryX(actor.end + 1) - boundaryX(actor.start)),
          height: isParentActor
            ? Math.max(rowHeight - 6, (parentSpan.end - parentSpan.start + 1) * rowHeight - 6)
            : laneBarHeight,
          rx: isParentActor ? 3 : 2,
          fill: color,
          'fill-opacity': isParentActor ? 0.24 : 0.88,
          stroke: isParentActor ? color : 'none',
          'stroke-opacity': isParentActor ? 0.7 : 0,
          'stroke-width': 1,
          ...(isParentActor ? { 'data-parent-actor': actor.id } : {}),
        });
        bar.appendChild(createSvgElement('title', {}, `${fullName}: ${actor.yearStart ?? 'before range'}–${actor.yearEnd ?? 'ongoing'}`));
        actorGroup.appendChild(bar);
        row.appendChild(actorGroup);
      });

      unit.predecessorEdges.forEach(({ source, target }) => {
        const predecessor = actorsById.get(source);
        const successor = actorsById.get(target);
        if (!predecessor || !successor) return;
        const connectorStart = boundaryX(predecessor.end + 1);
        const connectorEnd = boundaryX(successor.start);
        const flowDirection = connectorEnd >= connectorStart ? 1 : -1;
        const arrowX = Math.max(plotLeft + 3, Math.min(plotRight - 3, connectorEnd));
        if (Math.abs(connectorEnd - connectorStart) > 3) {
          row.appendChild(createSvgElement('line', {
            x1: connectorStart,
            x2: arrowX - flowDirection * 2,
            y1: actorLaneCenter.get(source),
            y2: actorLaneCenter.get(target),
            stroke: '#f2f5f3',
            'stroke-opacity': 0.8,
            'stroke-width': 1.5,
          }));
        }
        const arrow = createSvgElement('path', {
          d: `M ${arrowX - flowDirection * 4} ${actorLaneCenter.get(target) - 4} L ${arrowX} ${actorLaneCenter.get(target)} L ${arrowX - flowDirection * 4} ${actorLaneCenter.get(target) + 4}`,
          fill: 'none',
          stroke: '#f2f5f3',
          'stroke-opacity': 0.9,
          'stroke-width': 1.5,
        });
        arrow.appendChild(createSvgElement('title', {}, `${predecessor.label} precedes ${successor.label}`));
        row.appendChild(arrow);
      });
      timelineChart.appendChild(row);
    });

    const summary = [`${datedActors.length} dated actors`];
    if (undatedCount) summary.push(`${undatedCount} undated`);
    if (outsideRangeCount) summary.push(`${outsideRangeCount} outside range`);
    timelineSummary.textContent = summary.join(' · ');
  }

  const timelineResizeObserver = new ResizeObserver(() => {
    if (workspace.dataset.mode === 'timeline') renderTimeline();
  });
  timelineResizeObserver.observe(graphContainer);

  function updateTimelineRange(event) {
    let start = Math.max(1920, Math.min(2025, Number(timelineStartInput.value) || 1920));
    let end = Math.max(1921, Math.min(2026, Number(timelineEndInput.value) || 2026));
    if (start >= end) {
      if (event.target === timelineStartInput) end = Math.min(2026, start + 1);
      else start = Math.max(1920, end - 1);
    }
    timelineStart = start;
    timelineEnd = end;
    timelineStartInput.value = String(start);
    timelineEndInput.value = String(end);
    renderTimeline();
  }

  timelineStartInput.addEventListener('change', updateTimelineRange);
  timelineEndInput.addEventListener('change', updateTimelineRange);

  function buildMetricGraph() {
    const metricGraph = new Graph({ multi: true });
    graph.forEachNode((node) => {
      if (isNodeVisibleBase(node)) metricGraph.addNode(node);
    });
    graph.forEachEdge((edge, attrs, source, target) => {
      if (!state.activeEdgeTypes.has(attrs.adjacencyType)
        || !metricGraph.hasNode(source)
        || !metricGraph.hasNode(target)) return;
      const metricEdge = { weight: 1 };
      if (DATA.undirectedEdgeTypes.includes(attrs.adjacencyType)) {
        metricGraph.addUndirectedEdge(source, target, metricEdge);
      } else {
        metricGraph.addDirectedEdge(source, target, metricEdge);
      }
    });
    return metricGraph;
  }

  function centralityScores(mode) {
    const metricGraph = buildMetricGraph();
    if (metricGraph.order < 2) return {};
    try {
      if (mode === 'degree-centrality') {
        // Raw connection counts (not the normalized degreeCentrality score) so the
        // threshold slider and its label can speak in whole connections.
        const scores = {};
        metricGraph.forEachNode((node) => { scores[node] = metricGraph.degree(node); });
        return scores;
      }
      if (mode === 'closeness-centrality') {
        return closenessCentrality(metricGraph, { wassermanFaust: true });
      }
      if (mode === 'betweenness-centrality') {
        return betweennessCentrality(metricGraph, { getEdgeWeight: null });
      }
      if (mode === 'eigenvector-centrality') {
        return eigenvectorCentrality(metricGraph, { getEdgeWeight: null, maxIterations: 500 });
      }
    } catch (error) {
      console.warn(`Unable to calculate ${mode}: ${error.message}`);
    }
    return {};
  }

  function updateNodeSizes() {
    const mode = sizeModeSelect.value;
    state.sizeMode = mode;
    const scores = mode.endsWith('-centrality') ? centralityScores(mode) : {};
    const visibleScores = new Map(graph.nodes().filter(isNodeVisible).map((node) => {
      if (mode === 'scale-of-actor') {
        const scaleRank = { MICRO: 0, MESO: 0.5, MACRO: 1 }[graph.getNodeAttribute(node, 'scale')];
        return [node, scaleRank ?? 0.5];
      }
      if (mode === 'public-interest') {
        const attributes = graph.getNodeAttribute(node, 'attributes') || {};
        const value = Number.parseFloat(attributes['public sentiment']);
        return [node, Number.isFinite(value) ? value : 0];
      }
      if (mode === 'plain') return [node, 0];
      return [node, Number.isFinite(scores[node]) ? scores[node] : 0];
    }));
    const values = [...visibleScores.values()];
    const minimum = values.length ? Math.min(...values) : 0;
    const maximum = values.length ? Math.max(...values) : 0;

    graph.forEachNode((node) => {
      const value = visibleScores.get(node);
      const ratio = value === undefined ? 0 : maximum === minimum ? 0.5 : (value - minimum) / (maximum - minimum);
      graph.setNodeAttribute(node, 'size', MIN_SIZE + ratio * (MAX_SIZE - MIN_SIZE));
    });
  }

  updateNodeSizes();
  updateCentralityThresholdRange();

  renderer.createCanvasContext('size-halos', {
    beforeLayer: 'nodes',
    style: { pointerEvents: 'none' },
  });
  const sizeHaloContext = renderer.getCanvases()['size-halos'].getContext('2d');
  renderer.resize(true);
  renderer.on('afterRender', () => {
    if (!sizeHaloContext) return;
    const { width, height } = renderer.getDimensions();
    sizeHaloContext.clearRect(0, 0, width, height);
    sizeHaloContext.globalAlpha = 0.16;
    graph.forEachNode((node, attributes) => {
      if (!isNodeVisible(node) || attributes.size <= MIN_SIZE) return;
      const { x, y } = renderer.graphToViewport({ x: attributes.x, y: attributes.y });
      sizeHaloContext.fillStyle = attributes.color;
      sizeHaloContext.beginPath();
      sizeHaloContext.arc(x, y, renderer.scaleSize(attributes.size), 0, Math.PI * 2);
      sizeHaloContext.fill();
    });
    sizeHaloContext.globalAlpha = 1;
  });

  // Hints that there are more actors off-screen, by drawing small triangles pointing
  // toward them at the viewport edge. Dismissed for good (this browser session) the
  // first time the user zooms/pans out far enough to see every filtered node at once.
  const OFFSCREEN_HINT_SESSION_KEY = 'roosevelt-networks:offscreen-hint-dismissed';
  let offscreenHintDismissed = sessionStorage.getItem(OFFSCREEN_HINT_SESSION_KEY) === '1';
  renderer.createCanvasContext('offscreen-indicators', {
    style: { pointerEvents: 'none' },
  });
  // Resize again: this canvas was created after the renderer's own resize() call above,
  // so without this it would stay at its unset default size instead of the container's.
  renderer.resize(true);
  const offscreenIndicatorContext = renderer.getCanvases()['offscreen-indicators'].getContext('2d');
  renderer.on('afterRender', () => {
    if (!offscreenIndicatorContext) return;
    const { width, height } = renderer.getDimensions();
    offscreenIndicatorContext.clearRect(0, 0, width, height);
    if (offscreenHintDismissed || workspace.dataset.mode !== 'relationships') return;

    const margin = 12;
    const centerX = width / 2;
    const centerY = height / 2;
    const octantDirections = new Set();
    let sawAnyNode = false;
    let sawOffscreenNode = false;
    graph.forEachNode((node, attributes) => {
      if (!isNodeVisible(node)) return;
      sawAnyNode = true;
      const { x, y } = renderer.graphToViewport({ x: attributes.x, y: attributes.y });
      if (x >= -margin && x <= width + margin && y >= -margin && y <= height + margin) return;
      sawOffscreenNode = true;
      const angle = Math.atan2(y - centerY, x - centerX);
      octantDirections.add((Math.round(angle / (Math.PI / 4)) + 8) % 8);
    });

    if (sawAnyNode && !sawOffscreenNode) {
      offscreenHintDismissed = true;
      sessionStorage.setItem(OFFSCREEN_HINT_SESSION_KEY, '1');
      return;
    }

    // Index order must match atan2's angle convention (0 = East, increasing clockwise
    // in screen space), so each bucketed direction points at the correct edge anchor.
    const anchorPoints = [
      { x: width - margin, y: centerY }, // E
      { x: width - margin, y: height - margin }, // SE
      { x: centerX, y: height - margin }, // S
      { x: margin, y: height - margin }, // SW
      { x: margin, y: centerY }, // W
      { x: margin, y: margin }, // NW
      { x: centerX, y: margin }, // N
      { x: width - margin, y: margin }, // NE
    ];
    const triangleSize = 9;
    offscreenIndicatorContext.fillStyle = '#ffffff';
    offscreenIndicatorContext.globalAlpha = 0.85;
    octantDirections.forEach((octant) => {
      const anchor = anchorPoints[octant];
      const pointAngle = (octant * Math.PI) / 4;
      const tipX = anchor.x + Math.cos(pointAngle) * triangleSize;
      const tipY = anchor.y + Math.sin(pointAngle) * triangleSize;
      const baseAngleA = pointAngle + (Math.PI * 2) / 3;
      const baseAngleB = pointAngle - (Math.PI * 2) / 3;
      offscreenIndicatorContext.beginPath();
      offscreenIndicatorContext.moveTo(tipX, tipY);
      offscreenIndicatorContext.lineTo(anchor.x + Math.cos(baseAngleA) * triangleSize, anchor.y + Math.sin(baseAngleA) * triangleSize);
      offscreenIndicatorContext.lineTo(anchor.x + Math.cos(baseAngleB) * triangleSize, anchor.y + Math.sin(baseAngleB) * triangleSize);
      offscreenIndicatorContext.closePath();
      offscreenIndicatorContext.fill();
    });
    offscreenIndicatorContext.globalAlpha = 1;
  });

  async function ensureMapGeography() {
    if (mapGeography) return mapGeography;
    const { loadMapGeography } = await mapGeoModule;
    mapGeography = await loadMapGeography();
    return mapGeography;
  }

  function computeGraphBounds() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    graph.forEachNode((node, attrs) => {
      minX = Math.min(minX, attrs.x);
      maxX = Math.max(maxX, attrs.x);
      minY = Math.min(minY, attrs.y);
      maxY = Math.max(maxY, attrs.y);
    });
    return { minX, maxX, minY, maxY };
  }

  // Maps lng/lat onto the network's existing coordinate space, preserving
  // the island's aspect ratio and centering it within the graph's spread.
  function createGeoProjection(geoBounds, target) {
    const geoWidth = geoBounds.maxLng - geoBounds.minLng || 1;
    const geoHeight = geoBounds.maxLat - geoBounds.minLat || 1;
    const scale = geoWidth / geoHeight > target.width / target.height
      ? target.width / geoWidth
      : target.height / geoHeight;
    const geoCenterLng = (geoBounds.minLng + geoBounds.maxLng) / 2;
    const geoCenterLat = (geoBounds.minLat + geoBounds.maxLat) / 2;
    return (lng, lat) => ({
      x: target.centerX + (lng - geoCenterLng) * scale,
      y: target.centerY + (lat - geoCenterLat) * scale,
    });
  }

  function ensureMapGeoLayer() {
    if (mapGeoCanvas) return;
    renderer.createCanvasContext('geo', { beforeLayer: 'edges', style: { pointerEvents: 'none' } });
    mapGeoCanvas = renderer.getCanvases().geo;
    mapGeoContext = mapGeoCanvas.getContext('2d');
    // Appended last (no beforeLayer/afterLayer) so the island outline sits above every other layer.
    renderer.createCanvasContext('geoFront', { style: { pointerEvents: 'none' } });
    mapGeoFrontCanvas = renderer.getCanvases().geoFront;
    mapGeoFrontContext = mapGeoFrontCanvas.getContext('2d');
    renderer.on('afterRender', drawMapGeoLayer);
    renderer.resize(true);
  }

  function drawRings(ctx, rings, fillStyle, strokeStyle) {
    rings.forEach((ring) => {
      if (ring.length < 3) return;
      ctx.beginPath();
      ring.forEach((point, index) => {
        // graphToViewport normalizes raw graph-space coordinates before projecting to pixels.
        const viewportPoint = renderer.graphToViewport(mapProjection(point.lng, point.lat));
        if (index === 0) ctx.moveTo(viewportPoint.x, viewportPoint.y);
        else ctx.lineTo(viewportPoint.x, viewportPoint.y);
      });
      ctx.closePath();
      if (fillStyle) {
        ctx.fillStyle = fillStyle;
        ctx.fill();
      }
      if (strokeStyle) {
        ctx.strokeStyle = strokeStyle;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
  }

  function drawMapGeoLayer() {
    if (!mapGeoContext || !mapModeApplied || !mapGeography || !mapProjection) return;
    const { width, height } = renderer.getDimensions();
    mapGeoContext.clearRect(0, 0, width, height);
    mapGeography.buildingFootprints.forEach((footprint) => {
      drawRings(
        mapGeoContext,
        footprint.rings,
        footprint.actorId ? 'rgba(255, 255, 255, 0.28)' : 'rgba(255, 255, 255, 0.1)',
        'rgba(255, 255, 255, 0.6)',
      );
    });

    if (!mapGeoFrontContext) return;
    mapGeoFrontContext.clearRect(0, 0, width, height);
    drawRings(mapGeoFrontContext, mapGeography.islandRings, null, 'rgba(160, 200, 255, 0.9)');
  }

  // Pins actors tied to a building at that building's projected location and
  // lets the rest of the network settle around that fixed geography.
  async function applyMapLayout() {
    if (mapModeApplied || !state.graph || !state.renderer) return;
    mapModeApplied = true;
    const geo = await ensureMapGeography();
    const graphBounds = computeGraphBounds();
    const graphWidth = (graphBounds.maxX - graphBounds.minX) || 1;
    const graphHeight = (graphBounds.maxY - graphBounds.minY) || 1;
    mapCenterX = (graphBounds.minX + graphBounds.maxX) / 2;
    mapCenterY = (graphBounds.minY + graphBounds.maxY) / 2;
    mapProjection = createGeoProjection(geo.bounds, {
      centerX: mapCenterX,
      centerY: mapCenterY,
      width: graphWidth * 0.6,
      height: graphHeight * 0.6,
    });

    // Sigma normally rescales its view to fit the live extent of all nodes, which would
    // make the (otherwise static) island/building overlay drift as free nodes move under
    // gravity. Locking it to the island's own footprint keeps the overlay fixed on screen.
    const islandBBoxPoints = geo.islandRings.flat().map((point) => mapProjection(point.lng, point.lat));
    if (islandBBoxPoints.length) {
      renderer.setCustomBBox({
        x: [Math.min(...islandBBoxPoints.map((point) => point.x)), Math.max(...islandBBoxPoints.map((point) => point.x))],
        y: [Math.min(...islandBBoxPoints.map((point) => point.y)), Math.max(...islandBBoxPoints.map((point) => point.y))],
      });
    }

    ensureMapGeoLayer();
    runMapForceLayout();
    drawMapGeoLayer();

    // Defaults to framing the whole island boundary (not just the actor
    // nodes, which can cluster far tighter than the island itself).
    renderer.resize(true);
    const islandPoints = geo.islandRings.flat().map((point) => mapProjection(point.lng, point.lat));
    if (islandPoints.length) {
      const viewportPoints = islandPoints.map((point) => renderer.graphToViewport(point));
      const minPx = {
        x: Math.min(...viewportPoints.map((point) => point.x)),
        y: Math.min(...viewportPoints.map((point) => point.y)),
      };
      const maxPx = {
        x: Math.max(...viewportPoints.map((point) => point.x)),
        y: Math.max(...viewportPoints.map((point) => point.y)),
      };
      const camera = renderer.getCamera();
      const dimensions = renderer.getDimensions();
      const spanX = Math.max(maxPx.x - minPx.x, 1);
      const spanY = Math.max(maxPx.y - minPx.y, 1);
      const fitFactor = Math.min((dimensions.width * 0.85) / spanX, (dimensions.height * 0.85) / spanY);
      const ratio = camera.getBoundedRatio(camera.getState().ratio / fitFactor);
      const center = renderer.viewportToFramedGraph({
        x: (minPx.x + maxPx.x) / 2,
        y: (minPx.y + maxPx.y) / 2,
      });
      camera.animate({ x: center.x, y: center.y, ratio }, { duration: 500, easing: 'quadraticInOut' });
    }
    // Same selection-framing behavior as relationships mode, applied on top of the default island view.
    if (state.zoomToSelected) zoomToCurrentAndPinned();
  }

  // Re-runs just the force layout pass (anchored nodes stay fixed; everything else
  // responds to the current gravity/curvature settings), without resetting the camera.
  function runMapForceLayout() {
    if (!mapGeography || !mapProjection) return;

    // Compute the target layout on a throwaway copy of the graph so the live
    // graph's positions aren't touched until animateNodes interpolates them.
    const temp = new Graph({ multi: true });
    graph.forEachNode((node, attrs) => temp.addNode(node, { x: attrs.x, y: attrs.y }));
    graph.forEachEdge((edge, attrs, source, target) => {
      if (graph.isDirected(edge)) temp.addDirectedEdge(source, target);
      else temp.addUndirectedEdge(source, target);
    });

    mapGeography.actorCentroids.forEach((centroid, actorId) => {
      if (!graph.hasNode(actorId)) return;
      if (!mapOriginalPositions.has(actorId)) {
        const attrs = graph.getNodeAttributes(actorId);
        mapOriginalPositions.set(actorId, { x: attrs.x, y: attrs.y });
      }
      const projected = mapProjection(centroid.lng, centroid.lat);
      temp.setNodeAttribute(actorId, 'x', projected.x);
      temp.setNodeAttribute(actorId, 'y', projected.y);
      temp.setNodeAttribute(actorId, 'fixed', true);
      graph.setNodeAttribute(actorId, 'fixed', true);
    });

    // Gravity always pulls toward (0,0), so temporarily recenter the layout on the
    // anchored cluster's center; otherwise free-floating (non-fixed) nodes would
    // drift toward the absolute origin instead of settling around the map anchors.
    temp.forEachNode((node, attrs) => {
      temp.setNodeAttribute(node, 'x', attrs.x - mapCenterX);
      temp.setNodeAttribute(node, 'y', attrs.y - mapCenterY);
    });
    forceAtlas2.assign(temp, buildLayoutSettings());
    const positions = {};
    temp.forEachNode((node, attrs) => {
      positions[node] = { x: attrs.x + mapCenterX, y: attrs.y + mapCenterY };
    });

    if (mapCancelAnimation) mapCancelAnimation();
    mapCancelAnimation = animateNodes(graph, positions, { duration: 700, easing: 'quadraticInOut' });
  }

  function restoreRelationshipsLayout() {
    if (!mapModeApplied) return;
    renderer.setCustomBBox(null);
    mapOriginalPositions.forEach((pos, actorId) => {
      if (!graph.hasNode(actorId)) return;
      graph.setNodeAttribute(actorId, 'x', pos.x);
      graph.setNodeAttribute(actorId, 'y', pos.y);
      graph.removeNodeAttribute(actorId, 'fixed');
    });
    mapOriginalPositions.clear();
    // Building-anchored nodes are restored above; frozen snapshot covers every node that drifted during the map layout.
    if (state.freezePositions && frozenRelationshipsPositions) {
      frozenRelationshipsPositions.forEach((pos, actorId) => {
        if (!graph.hasNode(actorId)) return;
        graph.setNodeAttribute(actorId, 'x', pos.x);
        graph.setNodeAttribute(actorId, 'y', pos.y);
      });
    }
    mapModeApplied = false;
    if (mapGeoContext) {
      const { width, height } = renderer.getDimensions();
      mapGeoContext.clearRect(0, 0, width, height);
      if (mapGeoFrontContext) mapGeoFrontContext.clearRect(0, 0, width, height);
    }
    refresh();
  }

  function zoomToCurrentAndPinned() {
    if (!state.zoomToSelected) return;
    const selectedNodeIds = new Set([
      ...(state.currentSelection?.nodeIds || []),
      ...state.pinnedSelections.flatMap((selection) => selection.nodeIds || []),
    ].filter((node) => graph.hasNode(node) && isNodeVisible(node)));
    if (!selectedNodeIds.size) return;

    const framingNodeIds = new Set(selectedNodeIds);
    graph.forEachEdge((edge, attrs, source, target) => {
      if (!state.activeEdgeTypes.has(attrs.adjacencyType)
        || !isNodeVisible(source)
        || !isNodeVisible(target)) return;
      if (selectedNodeIds.has(source)) framingNodeIds.add(target);
      if (selectedNodeIds.has(target)) framingNodeIds.add(source);
    });

    renderer.resize(true);
    const getPoints = (nodeIds) => nodeIds.map((node) => {
      const displayData = renderer.getNodeDisplayData(node);
      const graphPoint = { x: displayData.x, y: displayData.y };
      return {
        graph: graphPoint,
        viewport: renderer.framedGraphToViewport(graphPoint),
      };
    });
    const selectionPoints = getPoints([...selectedNodeIds]);
    const framingPoints = getPoints([...framingNodeIds]);
    const selectionBounds = selectionPoints.reduce((result, point) => ({
      minGraphX: Math.min(result.minGraphX, point.graph.x),
      minGraphY: Math.min(result.minGraphY, point.graph.y),
      maxGraphX: Math.max(result.maxGraphX, point.graph.x),
      maxGraphY: Math.max(result.maxGraphY, point.graph.y),
    }), {
      minGraphX: Infinity,
      minGraphY: Infinity,
      maxGraphX: -Infinity,
      maxGraphY: -Infinity,
    });
    const frameBounds = framingPoints.reduce((result, point) => ({
      minX: Math.min(result.minX, point.viewport.x),
      minY: Math.min(result.minY, point.viewport.y),
      maxX: Math.max(result.maxX, point.viewport.x),
      maxY: Math.max(result.maxY, point.viewport.y),
    }), {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
    });
    const center = {
      x: (selectionBounds.minGraphX + selectionBounds.maxGraphX) / 2,
      y: (selectionBounds.minGraphY + selectionBounds.maxGraphY) / 2,
    };
    const camera = renderer.getCamera();
    let ratio = camera.getBoundedRatio(REFERENCE_CAMERA_RATIO);
    const spanX = frameBounds.maxX - frameBounds.minX;
    const spanY = frameBounds.maxY - frameBounds.minY;
    if (framingNodeIds.size > 1 && (spanX > 1 || spanY > 1)) {
      const dimensions = renderer.getDimensions();
      const fitFactor = Math.min(
        dimensions.width * 0.78 / Math.max(spanX, 1),
        dimensions.height * 0.78 / Math.max(spanY, 1),
      );
      ratio = camera.getBoundedRatio(camera.getState().ratio / fitFactor);
    }

    camera.animate({ x: center.x, y: center.y, ratio }, { duration: 500, easing: 'quadraticInOut' });
  }

  renderer.setSetting('nodeReducer', (node, data) => {
    const hidden = !isNodeVisible(node);
    return hidden ? { ...data, hidden: true } : { ...data, size: CORE_NODE_SIZE };
  });

  renderer.setSetting('edgeReducer', (edge, data) => {
    const [source, target] = graph.extremities(edge);
    const nodesVisible = isNodeVisible(source) && isNodeVisible(target);
    const hidden = !state.activeEdgeTypes.has(data.adjacencyType) || !nodesVisible;
    if (hidden) return { ...data, hidden: true };
    if (state.selectedEdgeIds.has(edge)) {
      return { ...data, color: '#ffffff', size: Math.max(data.size || 1, 3) };
    }
    return state.hoveredEdgeIds.has(edge)
      ? { ...data, color: '#ffd166', size: Math.max(data.size || 1, 2.5) }
      : data;
  });

  // Edge type filters
  buildFilterCheckboxes(
    document.getElementById('edge-type-filters'),
    manifest
      .filter((m) => m.type !== POSITION_EDGE_TYPE)
      .map((m) => ({ value: m.type, label: m.label })),
    state.activeEdgeTypes,
    (value) => state.edgeTypeColors.get(value),
    () => {
      refresh();
      relayout();
    },
    'edge-type-select-all',
  );

  // Position–Incumbent isn't part of the select-all set, but still reads as one of
  // the relationship toggles, so it's nested in the same list.
  const positionFilterRow = document.createElement('label');
  const positionFilterCheckbox = document.createElement('input');
  positionFilterCheckbox.type = 'checkbox';
  positionFilterCheckbox.id = 'position-filter-toggle';
  positionFilterCheckbox.checked = true;
  const positionFilterSwatch = document.createElement('span');
  positionFilterSwatch.className = 'swatch';
  positionFilterSwatch.style.background = state.edgeTypeColors.get(POSITION_EDGE_TYPE);
  positionFilterRow.append(positionFilterCheckbox, positionFilterSwatch, document.createTextNode('Position–Incumbent'));
  document.getElementById('edge-type-filters').appendChild(positionFilterRow);

  function applyEdgeCurvaturePercent(percent) {
    const clamped = Math.max(0, Math.min(100, percent));
    edgeCurvatureSlider.value = String(clamped);
    state.edgeCurvatureScale = edgeCurvaturePercentToScale(clamped);
    edgeCurvatureValue.textContent = `${Math.round(clamped)}%`;
    applyEdgeCurvatureScale(graph);
    refresh();
  }

  edgeCurvatureSlider.addEventListener('input', () => {
    applyEdgeCurvaturePercent(Number(edgeCurvatureSlider.value));
  });

  edgeCurvatureDecrement.addEventListener('click', () => {
    applyEdgeCurvaturePercent(Number(edgeCurvatureSlider.value) - 10);
  });

  edgeCurvatureIncrement.addEventListener('click', () => {
    applyEdgeCurvaturePercent(Number(edgeCurvatureSlider.value) + 10);
  });

  // Rerunning forceAtlas2 is too expensive to do on every 'input' tick while dragging,
  // so only the readout updates live; the layout only recomputes once the drag ends.
  function setLayoutGravityDisplay(value) {
    layoutGravitySlider.value = String(value);
    layoutGravityValue.textContent = String(value);
  }
  layoutGravitySlider.addEventListener('input', () => {
    setLayoutGravityDisplay(Number(layoutGravitySlider.value));
  });
  layoutGravitySlider.addEventListener('change', () => {
    state.layoutGravity = Number(layoutGravitySlider.value);
    relayout();
  });

  layoutGravityDecrement.addEventListener('click', () => {
    const clamped = Math.max(0, Number(layoutGravitySlider.value) - 5);
    setLayoutGravityDisplay(clamped);
    state.layoutGravity = clamped;
    relayout();
  });

  layoutGravityIncrement.addEventListener('click', () => {
    const clamped = Math.min(25, Number(layoutGravitySlider.value) + 5);
    setLayoutGravityDisplay(clamped);
    state.layoutGravity = clamped;
    relayout();
  });

  document.getElementById('freeze-positions').addEventListener('change', (e) => {
    state.freezePositions = e.target.checked;
    if (!state.freezePositions) frozenRelationshipsPositions = null;
  });

  const zoomToSelectedToggle = document.getElementById('zoom-to-selected');
  zoomToSelectedToggle.addEventListener('change', () => {
    state.zoomToSelected = zoomToSelectedToggle.checked;
    if (state.zoomToSelected) zoomToCurrentAndPinned();
  });

  // Node category filters
  buildFilterCheckboxes(
    document.getElementById('node-type-filters'),
    categories.map((category) => ({
      value: category,
      label: category === 'COMMUNITY' ? 'VOLUNTARY' : category,
    })),
    state.activeNodeTypes,
    (value) => state.categoryColors.get(value),
    () => {
      refresh();
      relayout();
    },
    'node-type-select-all',
  );

  buildFilterCheckboxes(
    document.getElementById('topic-filters'),
    [...state.allTopics].map((topic) => ({ value: topic, label: topic })),
    state.activeTopics,
    (value) => state.topicColors.get(value),
    () => {
      refresh();
      relayout();
    },
    'topic-select-all',
  );

  // Scale filters
  buildFilterCheckboxes(
    document.getElementById('scale-filters'),
    scales.map((s) => ({ value: s, label: s })),
    state.activeScales,
    () => '#9a9a9a',
    () => {
      refresh();
      relayout();
    },
    'scale-select-all',
  );

  document.querySelectorAll('.filter-group-toggle').forEach((toggle) => {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      const content = document.getElementById(toggle.getAttribute('aria-controls'));
      toggle.setAttribute('aria-expanded', String(!expanded));
      toggle.querySelector('.filter-group-chevron').textContent = expanded ? '▸' : '▾';
      content.hidden = expanded;
    });
  });

  const yearToggle = document.getElementById('year-filter-toggle');
  const yearControls = document.getElementById('year-controls');
  const yearSlider = document.getElementById('year-slider');
  const yearValue = document.getElementById('year-value');
  yearToggle.addEventListener('change', () => {
    state.yearFilterEnabled = yearToggle.checked;
    yearControls.hidden = !state.yearFilterEnabled;
    refresh();
    relayout();
  });
  yearSlider.addEventListener('input', () => {
    state.selectedYear = Number(yearSlider.value);
    yearValue.textContent = String(state.selectedYear);
    refresh();
    relayout();
  });

  const positionToggle = document.getElementById('position-filter-toggle');
  positionToggle.addEventListener('change', () => {
    if (positionToggle.checked) state.activeEdgeTypes.add(POSITION_EDGE_TYPE);
    else state.activeEdgeTypes.delete(POSITION_EDGE_TYPE);
    refresh();
    relayout();
  });

  centralityTypeSelect.addEventListener('change', () => {
    state.centralityFilterType = centralityTypeSelect.value;
    refresh();
    relayout();
  });

  function applyCentralityThresholdIndex(index) {
    centralityThresholdSlider.value = String(index);
    state.centralityThreshold = index;
    centralityThresholdValue.textContent = String(centralityThresholdSteps[index] ?? 0);
    refresh();
    relayout();
  }

  centralityThresholdSlider.addEventListener('input', () => {
    const raw = Number(centralityThresholdSlider.value);
    // Snap to the nearest tick index so the slider only rests on achievable thresholds.
    const index = centralityThresholdTickIndices.reduce((closest, candidate) => (
      Math.abs(candidate - raw) < Math.abs(closest - raw) ? candidate : closest
    ), centralityThresholdTickIndices[0] ?? 0);
    applyCentralityThresholdIndex(index);
  });

  centralityThresholdDecrement.addEventListener('click', () => {
    const current = Number(centralityThresholdSlider.value);
    const previous = [...centralityThresholdTickIndices].reverse().find((tickIndex) => tickIndex < current);
    if (previous !== undefined) applyCentralityThresholdIndex(previous);
  });

  centralityThresholdIncrement.addEventListener('click', () => {
    const current = Number(centralityThresholdSlider.value);
    const next = centralityThresholdTickIndices.find((tickIndex) => tickIndex > current);
    if (next !== undefined) applyCentralityThresholdIndex(next);
  });

  // #sidebar and #details-sidebar are absolute-positioned overlays on top of
  // #graph-container (which always fills the workspace), so toggling them never
  // resizes the renderer's container and content never needs to be re-centered.
  const sidebarToggle = document.getElementById('sidebar-toggle');
  sidebarToggle.addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('collapsed');
    panelDock.classList.toggle('filters-collapsed', collapsed);
    sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
    sidebarToggle.setAttribute('aria-label', collapsed ? 'Show filters' : 'Hide filters');
    sidebarToggle.textContent = collapsed ? '+' : '−';
  });

  const detailsToggle = document.getElementById('details-toggle');
  detailsToggle.addEventListener('click', () => {
    const collapsed = detailsSidebar.classList.toggle('collapsed');
    state.detailsManuallyCollapsed = collapsed;
    if (!collapsed) detailsSidebar.classList.remove('has-unread');
    detailsToggle.setAttribute('aria-expanded', String(!collapsed));
    detailsToggle.setAttribute('aria-label', collapsed ? 'Show details' : 'Minimize details');
    detailsToggle.textContent = collapsed ? '+' : '−';
  });

  const detailsResizeHandle = document.getElementById('details-resize-handle');
  detailsResizeHandle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0
      || window.innerWidth <= 700
      || window.matchMedia('(pointer: coarse)').matches
      || detailsSidebar.classList.contains('collapsed')) return;

    event.preventDefault();
    const startX = event.clientX;
    const startWidth = detailsSidebar.getBoundingClientRect().width;
    const minimumWidth = 300;
    const originalUserSelect = document.body.style.userSelect;
    const originalCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    detailsSidebar.classList.add('resizing');
    detailsResizeHandle.setPointerCapture(event.pointerId);

    const stopResizing = () => {
      document.removeEventListener('pointermove', resize);
      document.removeEventListener('pointerup', stopResizing);
      document.removeEventListener('pointercancel', stopResizing);
      document.body.style.userSelect = originalUserSelect;
      document.body.style.cursor = originalCursor;
      detailsSidebar.classList.remove('resizing');
    };

    const resize = (moveEvent) => {
      const maximumWidth = window.innerWidth / 2;
      const width = Math.max(minimumWidth, Math.min(maximumWidth, startWidth + startX - moveEvent.clientX));
      detailsSidebar.style.setProperty('--details-sidebar-width', `${width}px`);
    };

    document.addEventListener('pointermove', resize);
    document.addEventListener('pointerup', stopResizing);
    document.addEventListener('pointercancel', stopResizing);
  });

  // Search
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');
  function openNodeDetails(nodeId) {
    if (workspace.dataset.mode === 'timeline') {
      const row = [...timelineChart.querySelectorAll('[data-actor-id]')]
        .find((candidate) => candidate.dataset.actorId === nodeId);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('timeline-highlight');
        window.setTimeout(() => row.classList.remove('timeline-highlight'), 900);
      }
      return;
    }
    showNodeDetails(graph, nodeId);
    zoomToCurrentAndPinned();
    if (window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
      setPanel('details');
    }
  }

  function openEdgeDetails(edge) {
    showEdgeDetails(graph, edge);
    zoomToCurrentAndPinned();
    if (window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
      setPanel('details');
    }
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    searchResults.innerHTML = '';
    if (!q) return;
    const matches = graph.nodes()
      .filter((n) => {
        const attrs = graph.getNodeAttribute(n, 'attributes') || {};
        const fullName = (attrs[DATA.nodeLabelField] || '').toLowerCase();
        const abbreviation = (attrs[DATA.nodeAbbreviationField] || '').toLowerCase();
        return fullName.includes(q) || abbreviation.includes(q);
      })
      .slice(0, 10);
    matches.forEach((n) => {
      const attrs = graph.getNodeAttribute(n, 'attributes') || {};
      const actorName = attrs[DATA.nodeLabelField] || graph.getNodeAttribute(n, 'label');
      const row = document.createElement('div');
      row.className = 'search-result-row';

      const selectButton = document.createElement('button');
      selectButton.className = 'search-result-name';
      selectButton.type = 'button';
      selectButton.textContent = actorName;
      selectButton.addEventListener('click', () => {
        openNodeDetails(n);
      });

      const pinButton = document.createElement('button');
      pinButton.className = 'search-result-pin';
      pinButton.type = 'button';
      pinButton.dataset.nodeId = n;
      pinButton.dataset.actorName = actorName;
      pinButton.addEventListener('click', () => {
        togglePinnedSelectionAndZoom(createNodeSelection(graph, n));
        if (window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
          setPanel('details');
        }
      });

      row.append(selectButton, pinButton);
      searchResults.appendChild(row);
    });
    syncSearchPinButtons();
  });

  renderer.on('clickNode', ({ node }) => openNodeDetails(node));
  renderer.on('clickEdge', ({ edge }) => openEdgeDetails(edge));
  renderer.on('rightClickNode', ({ node, event }) => showPinContextMenu(createNodeSelection(graph, node), event));
  renderer.on('rightClickEdge', ({ edge, event }) => showPinContextMenu(createEdgeSelection(graph, edge), event));
  renderer.on('enterEdge', ({ edge }) => updateHoveredEdgePair(edge));
  renderer.on('leaveEdge', clearHoveredEdges);

  // Zoom controls — appended to #workspace (not #graph-container) so their z-index
  // is compared directly against the overlay sidebars instead of being trapped inside
  // the canvas's own isolated stacking context (where it would always lose).
  const zoomWrapper = document.createElement('div');
  zoomWrapper.className = 'zoom-controls';
  zoomWrapper.innerHTML = `
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-fit" title="Reset zoom">⤢</button>
  `;
  workspace.appendChild(zoomWrapper);

  document.getElementById('zoom-in').addEventListener('click', () => renderer.getCamera().animatedZoom({ duration: 300 }));
  document.getElementById('zoom-out').addEventListener('click', () => renderer.getCamera().animatedUnzoom({ duration: 300 }));
  document.getElementById('zoom-fit').addEventListener('click', () => renderer.getCamera().animatedReset({ duration: 300 }));

}

main().catch((err) => {
  console.error(err);
  const refreshButton = document.getElementById('refresh-sheets');
  const refreshStatus = document.getElementById('refresh-status');
  refreshButton.disabled = false;
  refreshStatus.hidden = false;
  refreshStatus.textContent = `Google Sheets refresh failed: ${err.message}`;
  document.getElementById('graph-container').innerHTML =
    `<p style="padding:20px;color:#ff6b6b">Failed to load network data: ${err.message}. Check the console and the files in /public/data.</p>`;
});
