import Graph from 'graphology';
import Sigma from 'sigma';
import EdgeCurveProgram, { EdgeCurvedArrowProgram } from '@sigma/edge-curve';
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
const POSITION_EDGE_TYPE = 'pos';
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
  zoomToSelected: true,
  yearFilterEnabled: false,
  selectedYear: 2026,
  detailsManuallyCollapsed: false,
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
      graph.setEdgeAttribute(edge, 'curvature', side * direction * magnitude);
    });
  });
}

async function buildGraph(fromGoogleSheets = false) {
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

  const adjacencyMatrices = await Promise.all(manifest.map(async (entry) => ({
    entry,
    edges: await loadAdjacencyMatrix(entry.file, fromGoogleSheets),
  })));

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

  state.activeEdgeTypes = new Set(edgeTypes.filter((type) => type !== POSITION_EDGE_TYPE));
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
  forceAtlas2.assign(temp, LAYOUT_SETTINGS);

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
  const sidebar = document.getElementById('sidebar');
  const panelDock = document.getElementById('panel-dock');
  const detailsSidebar = document.getElementById('details-sidebar');
  const graphContainer = document.getElementById('graph-container');
  const modePlaceholder = document.getElementById('mode-placeholder');
  const modeTabs = [...document.querySelectorAll('.mode-tab')];
  const panelTabs = [...document.querySelectorAll('.panel-tab')];
  const pinSelectionButton = document.getElementById('pin-selection');
  const selectionContextMenu = document.getElementById('selection-context-menu');
  const contextPinToggle = document.getElementById('context-pin-toggle');
  let contextSelection = null;

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
    const isRelationships = mode === 'relationships';
    workspace.dataset.mode = mode;
    modePlaceholder.hidden = isRelationships;
    modePlaceholder.setAttribute('aria-hidden', String(isRelationships));
    modePlaceholder.setAttribute('aria-label', `${mode[0].toUpperCase()}${mode.slice(1)} view`);
    panelDock.inert = !isRelationships;
    graphContainer.inert = !isRelationships;
    modeTabs.forEach((tab) => {
      tab.setAttribute('aria-pressed', String(tab.dataset.mode === mode));
    });
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
  const fromGoogleSheets = true;

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
  refreshStatus.textContent = 'Loading published sheets…';

  const { graph, categories, scales, manifest } = await buildGraph(fromGoogleSheets);
  refreshButton.disabled = false;
  refreshStatus.textContent = 'Updated from Google Sheets';
  const url = new URL(window.location.href);
  url.searchParams.delete('refresh');
  window.history.replaceState(null, '', url);
  state.graph = graph;

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

  function refresh() {
    renderer.refresh();
  }

  let cancelAnimation = null;
  function relayout() {
    if (state.freezePositions) return;
    if (cancelAnimation) cancelAnimation();
    const positions = computeFilteredLayout(graph, state.activeEdgeTypes, isNodeVisible);
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
    return hidden ? { ...data, hidden: true } : data;
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

  document.getElementById('freeze-positions').addEventListener('change', (e) => {
    state.freezePositions = e.target.checked;
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
  });
  yearSlider.addEventListener('input', () => {
    state.selectedYear = Number(yearSlider.value);
    yearValue.textContent = String(state.selectedYear);
    refresh();
  });

  const positionToggle = document.getElementById('position-filter-toggle');
  positionToggle.addEventListener('change', () => {
    if (positionToggle.checked) state.activeEdgeTypes.add(POSITION_EDGE_TYPE);
    else state.activeEdgeTypes.delete(POSITION_EDGE_TYPE);
    refresh();
    relayout();
  });

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
      renderer.resize(true);
    };

    document.addEventListener('pointermove', resize);
    document.addEventListener('pointerup', stopResizing);
    document.addEventListener('pointercancel', stopResizing);
  });

  // Search
  const searchInput = document.getElementById('search');
  const searchResults = document.getElementById('search-results');
  function openNodeDetails(nodeId) {
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
