import Graph from 'graphology';
import Sigma from 'sigma';
import EdgeCurveProgram, { EdgeCurvedArrowProgram } from '@sigma/edge-curve';
import betweennessCentrality from 'graphology-metrics/centrality/betweenness';
import closenessCentrality from 'graphology-metrics/centrality/closeness';
import eigenvectorCentrality from 'graphology-metrics/centrality/eigenvector';
import { drawDiscNodeHover, EdgeArrowProgram, EdgeLineProgram, EdgeRectangleProgram } from 'sigma/rendering';
import { animateNodes } from 'sigma/utils';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import { circular } from 'graphology-layout';
import { DATA, PALETTE, SHEET_ADJACENCY_TYPES } from './config.js';
import { dataLoadState, loadActors, loadActorNewsMetrics, loadAdjacencyRows, loadEdgeManifest } from './data.js';

const mapGeoModule = import('./map-mode.js');

const MIN_SIZE = 4;
const MAX_SIZE = 8;
const CORE_NODE_SIZE = 2;
const MIN_EDGE_WIDTH = 1;
const MAX_WEIGHTED_EDGE_WIDTH = 5;
const EDGE_WIDTH_BUCKET_COUNT = 5;
function zoomPercentFromRatio(ratio) {
  return Number.isFinite(ratio) && ratio > 0 ? Math.round(100 / ratio) : 100;
}

function labelScaleAtZoom(ratio) {
  const zoomPercent = zoomPercentFromRatio(ratio);
  const progress = Math.max(0, Math.min(1, (zoomPercent - 86) / (146 - 86)));
  return 0.8 - progress * 0.3;
}

const EDGE_TYPE_COLORS = {
  fin: '#9CFF40',
  rep: '#3374FF',
  own: '#40FFCC',
  pre: '#C9C9C9',
  par: '#FFB433',
  col: '#FFC2F4',
  adm: '#FF4F2E',
  pos: '#7733FF',
  cre: '#33DAFF',
};
const REFERENCE_CAMERA_RATIO = 0.3;
const REFERENCE_SIZE_RATIO = Math.sqrt(REFERENCE_CAMERA_RATIO);
// Maps the node size slider's abstract 1-100 display scale onto the actual size
// multiplier: 1 -> 1.0x, 50 (default) -> 1.5x, 100 -> 2.0x.
function nodeSizeDisplayToScale(display) {
  if (display <= 50) return 1 + ((display - 1) / 49) * 0.5;
  return 1.5 + ((display - 50) / 50) * 0.5;
}

function haloSizeForScore(scale, value, minimum, maximum) {
  const ratio = !Number.isFinite(value) || maximum <= minimum
    ? 0
    : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  const nodeRadius = coreNodeSize(scale);
  return nodeRadius + ratio * (50 - nodeRadius);
}

function hitTestHaloBoundary(targets, x, y, tolerance = 2) {
  let closest = null;
  let closestDistance = tolerance;
  targets.forEach((target) => {
    const distance = Math.abs(Math.hypot(x - target.x, y - target.y) - target.radius);
    if (distance <= closestDistance) {
      closest = target.node;
      closestDistance = distance;
    }
  });
  return closest;
}

function coreNodeSize(scale) {
  if (!state.sizeNodesByScale) return CORE_NODE_SIZE * state.nodeSizeScale;
  const defaultSizes = {
    MICRO: CORE_NODE_SIZE * nodeSizeDisplayToScale(1) * 0.5,
    MESO: CORE_NODE_SIZE * nodeSizeDisplayToScale(50),
    MACRO: CORE_NODE_SIZE * nodeSizeDisplayToScale(100) * 2,
  };
  const defaultSize = defaultSizes[scale] ?? defaultSizes.MESO;
  return defaultSize * state.nodeSizeScale / nodeSizeDisplayToScale(50);
}
// Label text sizes for the bottom/middle/top thirds of nodes by centrality rank
// (the current/old label-size formula topped out at 15, so the top two tiers exceed it).
const LABEL_TIER_SIZES = [11, 19, 26];
// Max camera ratio (how zoomed OUT the view can be) at which each tier's label still
// shows; more central nodes (higher tier) keep their label visible from further away.
// The top tier still disappears once zoomed out somewhat past the starting ratio (0.5),
// so panning/zooming far out doesn't leave the view cluttered with large labels.
const LABEL_TIER_MAX_RATIO = [0.35, 0.8, 1];
const FIRST_VISIBLE_LABEL_TIER = LABEL_TIER_MAX_RATIO.indexOf(Math.max(...LABEL_TIER_MAX_RATIO));
const FOCUS_DIM_OPACITY = 0.2;
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
  colorMode: 'sector',
  sentimentMaxAbs: 1,
  edgeTypeColors: new Map(),
  freezePositions: false,
  zoomToSelected: true,
  nodeSizeScale: 1,
  sizeNodesByScale: true,
  showLabels: true,
  sizeMode: 'public-interest',
  centralityFilterType: 'degree-centrality',
  centralityThreshold: 0,
  edgeCurvatureScale: 1,
  layoutGravity: 20,
  yearFilterEnabled: false,
  selectedYear: 2026,
  detailsManuallyCollapsed: true,
  hasAutoExpandedDetails: false,
  selectedEdgeIds: new Set(),
  hoveredEdgeIds: new Set(),
  hoveredSearchNodeId: null,
  emphasizedNodeIds: new Set(),
  focusOpacityActive: false,
  focusNodeIds: new Set(),
  focusEdgeIds: new Set(),
  pinnedGraphNodeIds: new Set(),
  pinnedGraphEdgeIds: new Set(),
  updateFocusOpacity: null,
  currentSelection: null,
  pinnedSelections: [],
};

function syncEmphasizedNodes() {
  state.emphasizedNodeIds = new Set([
    ...(state.currentSelection?.nodeIds || []),
    ...state.pinnedSelections.flatMap(({ nodeIds }) => nodeIds || []),
    ...(state.hoveredSearchNodeId ? [state.hoveredSearchNodeId] : []),
  ]);
  state.updateFocusOpacity?.();
  state.renderer?.refresh();
}

function colorWithOpacity(color, opacity) {
  const match = /^#([\da-f]{6})$/i.exec(color);
  if (!match) return color;
  const value = Number.parseInt(match[1], 16);
  const red = value >> 16;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return `rgba(${Math.round(red * opacity)}, ${Math.round(green * opacity)}, ${Math.round(blue * opacity)}, ${opacity})`;
}

function nodeColorForMode(attributes, isEmphasized = false) {
  if (state.colorMode === 'plain') return isEmphasized ? '#d0d0d0' : '#ffffff';
  if (state.colorMode === 'public-sentiment') {
    const sentiment = attributes.sentiment;
    if (!Number.isFinite(sentiment)) return '#8a8a8a';
    const intensity = Math.pow(Math.min(1, Math.abs(sentiment) / state.sentimentMaxAbs), 0.7);
    const endpoint = sentiment < 0 ? [220, 28, 42] : [0, 154, 70];
    const channels = endpoint.map((channel) => Math.round(255 + (channel - 255) * intensity));
    return `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
  }
  if (state.colorMode === 'category') {
    const topic = (attributes.topics || []).find((value) => state.activeTopics.has(value));
    return topic ? state.topicColors.get(topic) || '#8a8a8a' : '#8a8a8a';
  }
  return attributes.color || '#ffffff';
}

function drawCategoryPie(context, x, y, radius, topics) {
  const activeTopics = [...new Set((topics || []).filter((topic) => state.activeTopics.has(topic)))];
  if (activeTopics.length < 2) return false;
  const sliceAngle = (Math.PI * 2) / activeTopics.length;
  activeTopics.forEach((topic, index) => {
    const startAngle = -Math.PI / 2 + sliceAngle * index;
    context.beginPath();
    context.moveTo(x, y);
    context.arc(x, y, radius, startAngle, startAngle + sliceAngle);
    context.closePath();
    context.fillStyle = state.topicColors.get(topic) || '#8a8a8a';
    context.fill();
  });
  return true;
}

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

function parseParcelArea(raw) {
  const match = /^\s*([\d,]+(?:\.\d+)?)\s*(?:sq\s*ft|sq\.?\s*feet|ft2)?\s*$/i.exec(String(raw || ''));
  if (!match) return null;
  const area = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(area) && area > 0 ? area : null;
}

function applyOwnerTenantWidths(graph) {
  const areas = [];
  graph.forEachEdge((edge, attributes) => {
    if (attributes.adjacencyType === 'own' && Number.isFinite(attributes.parcelArea)) {
      areas.push(attributes.parcelArea);
    }
  });
  if (!areas.length) return;
  const minimum = Math.sqrt(Math.min(...areas));
  const maximum = Math.sqrt(Math.max(...areas));
  graph.forEachEdge((edge, attributes) => {
    if (attributes.adjacencyType !== 'own' || !Number.isFinite(attributes.parcelArea)) return;
    const proportion = maximum > minimum
      ? (Math.sqrt(attributes.parcelArea) - minimum) / (maximum - minimum)
      : 0;
    graph.setEdgeAttribute(edge, 'size', MIN_EDGE_WIDTH
      + Math.max(0, Math.min(1, proportion)) * (MAX_WEIGHTED_EDGE_WIDTH - MIN_EDGE_WIDTH));
  });
}

function parseCollaborationCloseness(raw) {
  const value = String(raw ?? '').trim();
  if (!/^\d+$/.test(value)) return null;
  const closeness = Number(value);
  return Number.isSafeInteger(closeness) && closeness > 0 ? closeness : null;
}

function applyCollaborationWidths(graph) {
  const edges = graph.edges().filter((edge) => graph.getEdgeAttribute(edge, 'adjacencyType') === 'col');
  const values = edges.map((edge) => graph.getEdgeAttribute(edge, 'collaborationCloseness')).filter(Number.isFinite);
  if (!values.length) return;
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  edges.forEach((edge) => {
    const closeness = graph.getEdgeAttribute(edge, 'collaborationCloseness');
    if (!Number.isFinite(closeness)) return;
    const proportion = maximum > minimum ? (closeness - minimum) / (maximum - minimum) : 0;
    graph.setEdgeAttribute(edge, 'size', MIN_EDGE_WIDTH
      + Math.max(0, Math.min(1, proportion)) * (MAX_WEIGHTED_EDGE_WIDTH - MIN_EDGE_WIDTH));
  });
}

function parseFinancialAmount(raw) {
  const match = /^\s*\$?\s*([\d,]+(?:\.\d+)?)\s*$/i.exec(String(raw ?? ''));
  if (!match) return null;
  const amount = Number(match[1].replaceAll(',', ''));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function applyFinancialWidths(graph) {
  const financialEdges = graph.edges().filter((edge) => graph.getEdgeAttribute(edge, 'adjacencyType') === 'fin');
  const widthFor = (field) => {
    const amounts = financialEdges.map((edge) => graph.getEdgeAttribute(edge, field)).filter(Number.isFinite);
    const minimum = amounts.length ? Math.min(...amounts) : 0;
    const maximum = amounts.length ? Math.max(...amounts) : 0;
    return (amount) => {
      const proportion = maximum > minimum ? (amount - minimum) / (maximum - minimum) : 0;
      return MIN_EDGE_WIDTH
        + Math.max(0, Math.min(1, proportion)) * (MAX_WEIGHTED_EDGE_WIDTH - MIN_EDGE_WIDTH);
    };
  };
  const ongoingWidth = widthFor('ongoingFunds');
  const upfrontWidth = widthFor('upfrontInvestment');
  financialEdges.forEach((edge) => {
    const attributes = graph.getEdgeAttributes(edge);
    if (Number.isFinite(attributes.ongoingFunds)) {
      graph.setEdgeAttribute(edge, 'size', ongoingWidth(attributes.ongoingFunds));
      if (Number.isFinite(attributes.upfrontInvestment)) {
        graph.setEdgeAttribute(edge, 'upfrontSize', upfrontWidth(attributes.upfrontInvestment));
      }
    }
  });
}

function reverseFinancialProgram(Program) {
  return class extends Program {
    process(edgeIndex, offset, sourceData, targetData, data) {
      if (data.adjacencyType !== 'fin') {
        return super.process(edgeIndex, offset, sourceData, targetData, data);
      }
      return super.process(edgeIndex, offset, targetData, sourceData, {
        ...data,
        curvature: Number.isFinite(data.curvature) ? -data.curvature : data.curvature,
      });
    }
  };
}

function edgeWidthBucket(size) {
  const proportion = (Math.max(MIN_EDGE_WIDTH, Math.min(MAX_WEIGHTED_EDGE_WIDTH, size)) - MIN_EDGE_WIDTH)
    / (MAX_WEIGHTED_EDGE_WIDTH - MIN_EDGE_WIDTH);
  return Math.min(EDGE_WIDTH_BUCKET_COUNT - 1, Math.floor(proportion * EDGE_WIDTH_BUCKET_COUNT));
}

function edgeProgramType(baseType, size) {
  return `edge-width-${edgeWidthBucket(size)}-${baseType}`;
}

function buildEdgeProgramClasses() {
  const basePrograms = {
    line: EdgeLineProgram,
    collaboration: EdgeRectangleProgram,
    arrow: reverseFinancialProgram(EdgeArrowProgram),
    curve: EdgeCurveProgram,
    curvedArrow: reverseFinancialProgram(EdgeCurvedArrowProgram),
  };
  const classes = {};
  for (let bucket = EDGE_WIDTH_BUCKET_COUNT - 1; bucket >= 0; bucket -= 1) {
    Object.entries(basePrograms).forEach(([baseType, Program]) => {
      classes[`edge-width-${bucket}-${baseType}`] = Program;
    });
  }
  return classes;
}

function drawFinancialUpfront(context, renderer, graph) {
  const { width, height } = renderer.getDimensions();
  context.clearRect(0, 0, width, height);
  graph.forEachEdge((edge, attributes, source, target) => {
    if (attributes.adjacencyType !== 'fin' || !Number.isFinite(attributes.upfrontSize)) return;
    const displayData = renderer.getEdgeDisplayData(edge);
    const sourceData = renderer.getNodeDisplayData(source);
    const targetData = renderer.getNodeDisplayData(target);
    if (!displayData || displayData.hidden || !sourceData || sourceData.hidden || !targetData || targetData.hidden) return;
    const start = renderer.framedGraphToViewport(sourceData);
    const end = renderer.framedGraphToViewport(targetData);
    const deltaX = end.x - start.x;
    const deltaY = end.y - start.y;
    const length = Math.hypot(deltaX, deltaY);
    if (!length) return;
    const selected = state.selectedEdgeIds.has(edge);
    const hovered = state.hoveredEdgeIds.has(edge);
    const size = Math.max(attributes.upfrontSize, selected ? 3 : hovered ? 2.5 : 1);
    const lineWidth = Math.max(1, renderer.scaleSize(size));
    const offset = (renderer.scaleSize(displayData.size) + lineWidth) / 2 + 2;
    const normalX = -deltaY / length;
    const normalY = deltaX / length;
    const curvature = Number.isFinite(displayData.curvature) ? displayData.curvature : 0;
    const control = {
      x: (start.x + end.x) / 2 - deltaY * curvature + normalX * offset,
      y: (start.y + end.y) / 2 + deltaX * curvature + normalY * offset,
    };
    start.x += normalX * offset;
    start.y += normalY * offset;
    end.x += normalX * offset;
    end.y += normalY * offset;
    const tangentX = curvature ? start.x - control.x : -deltaX;
    const tangentY = curvature ? start.y - control.y : -deltaY;
    const tangentLength = Math.hypot(tangentX, tangentY) || 1;
    const unitX = tangentX / tangentLength;
    const unitY = tangentY / tangentLength;
    const sourceRadius = renderer.scaleSize(sourceData.size);
    const tipX = start.x - unitX * sourceRadius;
    const tipY = start.y - unitY * sourceRadius;
    const headLength = Math.max(5, lineWidth * 3.5);
    const halfWidth = Math.max(3, lineWidth * 2);
    const baseX = tipX - unitX * headLength;
    const baseY = tipY - unitY * headLength;
    const color = attributes.color;
    context.save();
    context.globalAlpha = !selected && !hovered && state.focusOpacityActive && !state.focusEdgeIds.has(edge)
      ? FOCUS_DIM_OPACITY
      : 1;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = lineWidth;
    context.lineCap = 'round';
    context.setLineDash([lineWidth * 3, lineWidth * 2]);
    context.beginPath();
    context.moveTo(end.x, end.y);
    if (curvature) context.quadraticCurveTo(control.x, control.y, baseX, baseY);
    else context.lineTo(baseX, baseY);
    context.stroke();
    context.setLineDash([]);
    context.beginPath();
    context.moveTo(tipX, tipY);
    context.lineTo(baseX - unitY * halfWidth, baseY + unitX * halfWidth);
    context.lineTo(baseX + unitY * halfWidth, baseY - unitX * halfWidth);
    context.closePath();
    context.fill();
    context.restore();
  });
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

  const [actors, newsMetricsByActor] = await Promise.all([
    loadActors(fromGoogleSheets),
    loadActorNewsMetrics(),
  ]);
  const sentimentValues = actors
    .map((actor) => newsMetricsByActor.get((actor[DATA.nodeIdField] || '').trim().toLowerCase())?.sentiment)
    .filter(Number.isFinite);
  state.sentimentMaxAbs = Math.max(0, ...sentimentValues.map(Math.abs)) || 1;
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
      sentiment: newsMetricsByActor.get(id.trim().toLowerCase())?.sentiment ?? null,
      hits: newsMetricsByActor.get(id.trim().toLowerCase())?.hits ?? null,
      category,
      newFromSheet: dataLoadState.sheetOnlyActorIds.has(id),
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
  const typeDetails = new Map(manifest.map((entry) => [entry.type, entry]));
  const edgeTypes = [...typeDetails.keys()];
  manifest.forEach((entry, i) => {
    state.edgeTypeColors.set(entry.type, EDGE_TYPE_COLORS[entry.type] || PALETTE[i % PALETTE.length]);
  });

  const totalSteps = 2;
  onProgress(1, totalSteps);
  const adjacencyRows = await loadAdjacencyRows(fromGoogleSheets);
  const seenPairs = new Set();
  adjacencyRows.forEach((row) => {
    const relationship = String(row['source-target relationship'] || '').trim().toUpperCase();
    const type = SHEET_ADJACENCY_TYPES[relationship];
    const entry = typeDetails.get(type);
    const source = String(row.source || '').trim();
    const target = String(row.target || '').trim();
    if (!entry || !source || !target || source === target) return;

    const directed = !DATA.undirectedEdgeTypes.includes(type);
    const pair = directed ? [source, target] : [source, target].sort();
    const key = JSON.stringify([type, ...pair]);
    if (seenPairs.has(key)) return;
    seenPairs.add(key);
    if (!graph.hasNode(source) || !graph.hasNode(target)) {
      console.warn(`Skipping adjacency ${source} -> ${target}: unknown actor id (check "${DATA.nodeIdField}" matches actors.csv)`);
      return;
    }

    const attrs = {
      type: type === 'col' ? 'collaboration' : directed ? 'arrow' : 'line',
      adjacencyType: type,
      label: entry.label,
      weight: 1,
      size: MIN_EDGE_WIDTH,
      parcelArea: type === 'own' ? parseParcelArea(row['parameter 0']) : null,
      collaborationCloseness: type === 'col' ? parseCollaborationCloseness(row['parameter 1']) : null,
      upfrontInvestment: type === 'fin' ? parseFinancialAmount(row['parameter 0']) : null,
      ongoingFunds: type === 'fin' ? parseFinancialAmount(row['parameter 1']) : null,
      color: state.edgeTypeColors.get(type),
    };
    if (directed) graph.addDirectedEdge(source, target, attrs);
    else graph.addUndirectedEdge(source, target, attrs);
  });
  onProgress(2, totalSteps);

  applyOwnerTenantWidths(graph);
  applyCollaborationWidths(graph);
  applyFinancialWidths(graph);
  assignParallelEdgeCurves(graph);
  graph.forEachEdge((edge, attributes) => {
    graph.mergeEdgeAttributes(edge, {
      baseRenderType: attributes.type,
      type: edgeProgramType(attributes.type, attributes.size),
    });
  });

  state.activeEdgeTypes = new Set(edgeTypes);
  state.activeNodeTypes = new Set(categories);
  state.activeTopics = new Set(topics);
  state.activeScales = new Set(scales);

  const positions = computeFilteredLayout(graph, state.activeEdgeTypes);
  graph.forEachNode((node) => {
    graph.setNodeAttribute(node, 'x', positions[node].x);
    graph.setNodeAttribute(node, 'y', positions[node].y);
  });

  return { graph, categories, scales, manifest, actorCount: actors.length };
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

// Lets a slider's <output> readout be clicked to type an exact value directly;
// out-of-range entries clamp to the nearest bound instead of being rejected.
function makeSliderOutputEditable(output, getBounds, onCommit) {
  output.classList.add('slider-value-editable');
  output.style.cursor = 'text';
  output.title = 'Click to enter a value';
  output.addEventListener('click', () => {
    if (output.querySelector('input')) return;
    const currentText = output.textContent;
    const { min, max } = getBounds();
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'slider-value-input';
    input.min = String(min);
    input.max = String(max);
    input.value = (currentText.match(/-?\d+(\.\d+)?/) || [''])[0];
    output.textContent = '';
    output.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const raw = Number(input.value);
      const clamped = Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : min;
      onCommit(clamped);
    };
    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        input.removeEventListener('blur', commit);
        output.textContent = currentText;
      }
    });
  });
}

function syncDetailsSidebar() {
  const detailsSidebar = document.getElementById('details-sidebar');
  const hasContent = Boolean(state.currentSelection) || state.pinnedSelections.length > 0;
  detailsSidebar.classList.toggle('has-selection', hasContent);
  // The very first selection (node or edge) of the session auto-reveals the details
  // panel; after that, the user's own collapse/expand choice is respected.
  if (hasContent && !state.hasAutoExpandedDetails) {
    state.hasAutoExpandedDetails = true;
    if (detailsSidebar.classList.contains('collapsed')) {
      detailsSidebar.classList.remove('collapsed');
      state.detailsManuallyCollapsed = false;
      const detailsToggle = document.getElementById('details-toggle');
      detailsToggle.setAttribute('aria-expanded', 'true');
      detailsToggle.setAttribute('aria-label', 'Minimize details');
      detailsToggle.textContent = '−';
      document.getElementById('workspace').style.setProperty('--zoom-controls-details-offset', `${detailsSidebar.offsetWidth}px`);
    }
  }
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

function getNodeNetworkSummary(graph, nodeId) {
  const isVisible = state.isNodeVisible || (() => true);
  const relationships = new Map();
  const connectedActors = new Set();
  let incoming = 0;
  let outgoing = 0;
  let undirected = 0;
  graph.forEachEdge((edge, attributes, source, target) => {
    if (source !== nodeId && target !== nodeId) return;
    if (!state.activeEdgeTypes.has(attributes.adjacencyType) && !state.pinnedGraphEdgeIds.has(edge)) return;
    const neighbor = source === nodeId ? target : source;
    if (!isVisible(nodeId) || !isVisible(neighbor)) return;
    connectedActors.add(neighbor);
    const relationship = attributes.label || attributes.adjacencyType;
    relationships.set(relationship, (relationships.get(relationship) || 0) + 1);
    if (!graph.isDirected(edge)) undirected += 1;
    else if (source === nodeId) outgoing += 1;
    else incoming += 1;
  });
  const attributes = graph.getNodeAttributes(nodeId);
  return {
    mode: attributes.haloMode,
    score: attributes.haloScore,
    connectionCount: incoming + outgoing + undirected,
    actorCount: connectedActors.size,
    incoming,
    outgoing,
    undirected,
    relationships: [...relationships].sort(([first], [second]) => first.localeCompare(second)),
  };
}

function renderSelectionDetails(selection, container) {
  container.replaceChildren();
  const details = document.createElement('dl');
  if (selection.kind === 'node') {
    const networkDetails = document.createElement('dl');
    const graph = state.graph;
    const nodeId = selection.nodeIds[0];
    if (graph?.hasNode(nodeId)) {
      const network = getNodeNetworkSummary(graph, nodeId);
      const modeLabels = {
        'public-interest': 'Public interest (hits)',
        'degree-centrality': 'Degree centrality',
        'closeness-centrality': 'Closeness centrality',
        'betweenness-centrality': 'Betweenness centrality',
        'eigenvector-centrality': 'Eigenvector centrality',
        plain: 'Plain halo mode',
      };
      const centralityTerm = document.createElement('dt');
      centralityTerm.textContent = 'Current centrality';
      const centralityDescription = document.createElement('dd');
      const score = Number.isFinite(network.score)
        ? network.mode === 'public-interest' || network.mode === 'degree-centrality'
          ? String(network.score)
          : network.score.toPrecision(4)
        : 'Not available';
      centralityDescription.textContent = `${modeLabels[network.mode] || 'Current halo metric'}: ${score}`;
      networkDetails.append(centralityTerm, centralityDescription);

      const connectionsTerm = document.createElement('dt');
      connectionsTerm.textContent = 'Current connections';
      const connectionsDescription = document.createElement('dd');
      connectionsDescription.textContent = `${network.connectionCount} connections to ${network.actorCount} actors (${network.outgoing} outgoing, ${network.incoming} incoming, ${network.undirected} undirected)`;
      networkDetails.append(connectionsTerm, connectionsDescription);

      if (network.relationships.length) {
        const relationshipTerm = document.createElement('dt');
        relationshipTerm.textContent = 'Connections by relationship';
        const relationshipDescription = document.createElement('dd');
        const relationshipList = document.createElement('ul');
        relationshipList.className = 'detail-list';
        network.relationships.forEach(([name, count]) => {
          const item = document.createElement('li');
          item.textContent = `${name}: ${count}`;
          relationshipList.appendChild(item);
        });
        relationshipDescription.appendChild(relationshipList);
        networkDetails.append(relationshipTerm, relationshipDescription);
      }
    }
    selection.fields.forEach(([name, value]) => {
      const term = document.createElement('dt');
      term.textContent = name;
      const description = document.createElement('dd');
      description.textContent = value;
      details.append(term, description);
    });
    if (networkDetails.childElementCount) details.appendChild(networkDetails);
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

function refreshVisibleNodeDetails() {
  const currentDetails = document.getElementById('node-details');
  if (state.currentSelection?.kind === 'node' && currentDetails && !currentDetails.hidden) {
    renderSelectionDetails(state.currentSelection, currentDetails);
  }
  document.querySelectorAll('.pinned-item').forEach((item) => {
    const selection = state.pinnedSelections.find(({ key }) => key === item.dataset.selectionKey);
    const content = item.querySelector('.pinned-content');
    if (selection?.kind === 'node' && !selection.collapsed && content) {
      renderSelectionDetails(selection, content);
    }
  });
}

function renderCurrentSelection() {
  const section = document.getElementById('active-selection');
  const title = document.getElementById('current-selection-title');
  const pinButton = document.getElementById('pin-selection');
  const heading = section.querySelector('.selection-heading');
  const noSelectionMessage = document.getElementById('no-selection-message');
  const details = document.getElementById('node-details');
  const hasSelection = Boolean(state.currentSelection);
  noSelectionMessage.hidden = hasSelection;
  heading.hidden = !hasSelection;
  details.hidden = !hasSelection;
  if (hasSelection) {
    title.textContent = state.currentSelection.title;
    const alreadyPinned = state.pinnedSelections.some(({ key }) => key === state.currentSelection.key);
    pinButton.disabled = false;
    pinButton.textContent = alreadyPinned ? 'Unpin' : 'Pin';
    pinButton.setAttribute('aria-pressed', String(alreadyPinned));
    renderSelectionDetails(state.currentSelection, details);
  } else {
    details.replaceChildren();
  }
  syncEmphasizedNodes();
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
    item.dataset.selectionKey = selection.key;
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

    const title = document.createElement('button');
    title.className = 'pinned-title';
    title.type = 'button';
    title.textContent = selection.title;
    title.setAttribute('aria-label', `Zoom to ${selection.title}`);
    title.title = 'Zoom to this selection';
    title.addEventListener('click', () => {
      state.currentSelection = selection;
      state.selectedEdgeIds = new Set(selection.edgeIds || []);
      state.renderer?.refresh();
      renderCurrentSelection();
      state.zoomToSelection?.(selection);
    });

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
  state.currentSelection = createNodeSelection(graph, nodeId);
  state.renderer?.refresh();
  renderCurrentSelection();
}

function showEdgeDetails(graph, edge) {
  state.currentSelection = createEdgeSelection(graph, edge);
  state.selectedEdgeIds = new Set(state.currentSelection.edgeIds);
  state.renderer?.refresh();
  renderCurrentSelection();
}

// Clears the active selection when clicking empty canvas; pinned entries remain listed.
function clearCurrentSelection() {
  if (!state.currentSelection) return;
  state.currentSelection = null;
  state.selectedEdgeIds.clear();
  state.renderer?.refresh();
  renderCurrentSelection();
}

async function main() {
  const workspace = document.getElementById('workspace');
  // Node -> tier (0 small/close-only, 1 medium, 2 large/visible-from-far), keyed by
  // the centrality type currently selected in the CENTRALITY panel.
  let labelTierByNode = new Map();
  let hoveredLabelNode = null;
  let hoveredHaloNode = null;
  // Bounding boxes of labels already drawn this frame, used to nudge/fade new labels
  // that would otherwise overlap them. Reset at the start of each render.
  let placedLabelBoxes = [];
  const rectsOverlap = (a, b) => !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
  const getHoveredLabelSize = (tier, cameraRatio) => {
    if (cameraRatio <= LABEL_TIER_MAX_RATIO[tier]) return LABEL_TIER_SIZES[tier];
    const visibleSizes = LABEL_TIER_MAX_RATIO
      .map((maxRatio, visibleTier) => cameraRatio <= maxRatio ? LABEL_TIER_SIZES[visibleTier] : null)
      .filter((size) => size !== null);
    return visibleSizes.length
      ? Math.min(...visibleSizes)
      : LABEL_TIER_SIZES[FIRST_VISIBLE_LABEL_TIER];
  };
  const getSmallestVisibleLabelSize = (cameraRatio) => {
    const visibleSizes = LABEL_TIER_MAX_RATIO
      .map((maxRatio, tier) => cameraRatio <= maxRatio ? LABEL_TIER_SIZES[tier] : null)
      .filter((size) => size !== null);
    return visibleSizes.length
      ? Math.min(...visibleSizes)
      : LABEL_TIER_SIZES[FIRST_VISIBLE_LABEL_TIER];
  };
  const sizeModeSelect = document.getElementById('size-mode');
  state.sizeMode = sizeModeSelect.value;
  const colorModeSelect = document.getElementById('color-mode');
  state.colorMode = colorModeSelect.value;
  const labelsToggle = document.getElementById('labels-toggle');
  state.showLabels = labelsToggle.checked;
  const nodeSizeSlider = document.getElementById('node-size-slider');
  const nodeSizeValue = document.getElementById('node-size-value');
  const nodeSizeDecrement = document.getElementById('node-size-decrement');
  const nodeSizeIncrement = document.getElementById('node-size-increment');
  state.nodeSizeScale = nodeSizeDisplayToScale(Number(nodeSizeSlider.value));
  const sizeNodesByScaleToggle = document.getElementById('size-nodes-by-scale');
  state.sizeNodesByScale = sizeNodesByScaleToggle.checked;
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
  let mapLayoutGeneration = 0;
  let relationshipsCameraState = null;
  let mapGeoCanvas = null;
  let mapGeoContext = null;
  let mapGeoFrontCanvas = null;
  let mapGeoFrontContext = null;
  let mapProjection = null;
  let hoveredBuildingActorId = null;
  let mapFootprintHitTargets = [];
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
    hoveredHaloNode = null;
    const leavingRelationships = workspace.dataset.mode === 'relationships' && mode !== 'relationships';
    if (!isMap) hoveredBuildingActorId = null;
    if (leavingRelationships && state.renderer) {
      relationshipsCameraState = state.renderer.getCamera().getState();
    }
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
      if (relationshipsCameraState) {
        state.renderer.getCamera().animate(relationshipsCameraState, { duration: 500, easing: 'quadraticInOut' });
      }
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

  const { graph, categories, scales, manifest, actorCount } = await buildGraph(fromGoogleSheets, updateRefreshProgress);
  refreshButton.disabled = false;
  refreshProgress.hidden = true;
  refreshStatus.textContent = !fromGoogleSheets
    ? `Using local data (${actorCount} actors)`
    : dataLoadState.usedLocalFallback
      ? `Sheets incomplete; local CSV fallback used (${actorCount} actors)`
      : `Updated from Google Sheets (${actorCount} actors)`;
  const url = new URL(window.location.href);
  url.searchParams.delete('refresh');
  window.history.replaceState(null, '', url);
  state.graph = graph;
  if (workspace.dataset.mode === 'map') applyMapLayout();

  const container = document.getElementById('graph-container');
  const renderer = new Sigma(graph, container, {
    minCameraRatio: 0.05,
    maxCameraRatio: 10,
    zIndex: true,
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
      const tier = labelTierByNode.get(data.key) ?? 1;
      const isHovered = data.key === hoveredLabelNode;
      const isEmphasized = isHovered || state.emphasizedNodeIds.has(data.key);
      const isFocusLabel = state.focusNodeIds.has(data.key);
      const cameraRatio = state.renderer?.getCamera().getState().ratio ?? REFERENCE_CAMERA_RATIO;
      const baseSize = isEmphasized
        ? getHoveredLabelSize(tier, cameraRatio)
        : isFocusLabel
          ? getSmallestVisibleLabelSize(cameraRatio)
          : LABEL_TIER_SIZES[tier];
      const size = baseSize * labelScaleAtZoom(cameraRatio);
      const labelWeight = isEmphasized ? '700' : settings.labelWeight;
      const labelFont = isEmphasized ? '"Helvetica Neue", Helvetica, Arial, sans-serif' : settings.labelFont;
      context.font = `${labelWeight} ${size}px ${labelFont}`;
      const textWidth = context.measureText(data.label).width;
      const attributes = graph.getNodeAttribute(data.key, 'attributes') || {};
      const fullName = attributes[DATA.nodeLabelField] || data.label;
      const secondarySize = Math.max(7, Math.min(9, baseSize * 0.4)) * labelScaleAtZoom(cameraRatio);
      const hasSecondaryLabel = fullName !== data.label && tier !== 0;
      let boxWidth = textWidth;
      if (hasSecondaryLabel) {
        context.font = `${labelWeight} ${secondarySize}px ${labelFont}`;
        boxWidth = Math.max(boxWidth, context.measureText(fullName).width);
        context.font = `${labelWeight} ${size}px ${labelFont}`;
      }

      // Try the usual spot (right of the node) first, then nudge up/down, then try
      // the opposite side, before giving up and fading out in favor of whatever
      // more-central label is already occupying that space.
      const lineStep = size * 0.95;
      const positions = isFocusLabel
        ? [1, -1].flatMap((dx) => [0, 1, -1, 2, -2, 3, -3, 4, -4].map((dy) => ({ dx, dy })))
        : [
          { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 1, dy: -1 },
          { dx: -1, dy: 0 }, { dx: -1, dy: 1 }, { dx: -1, dy: -1 },
        ];
      const candidates = positions.map(({ dx, dy }) => {
        const x = dx > 0 ? data.x + data.size + 3 : data.x - data.size - 3 - boxWidth;
        const y = data.y + size / 3 + dy * lineStep;
        const boxBottom = hasSecondaryLabel ? secondarySize + secondarySize * 0.3 : size * 0.3;
        return { x, y, box: { x1: x, y1: y - size * 0.8, x2: x + boxWidth, y2: y + boxBottom } };
      });

      let chosen = candidates[0];
      let chosenOverlaps = placedLabelBoxes.filter((placed) => rectsOverlap(candidates[0].box, placed.box));
      for (const candidate of candidates) {
        const overlapping = placedLabelBoxes.filter((placed) => rectsOverlap(candidate.box, placed.box));
        if (overlapping.length === 0) {
          chosen = candidate;
          chosenOverlaps = overlapping;
          break;
        }
      }
      const nearMoreCentralLabel = chosenOverlaps.some((placed) => placed.tier > tier);
      const alpha = nearMoreCentralLabel ? 0.4 : 1;
      const focusAlpha = state.focusOpacityActive && !state.focusNodeIds.has(data.key)
        ? FOCUS_DIM_OPACITY
        : 1;
      placedLabelBoxes.push({ box: chosen.box, tier });

      const textColor = settings.labelColor.attribute
        ? graph.getNodeAttribute(data.key, settings.labelColor.attribute) || settings.labelColor.color || '#000000'
        : settings.labelColor.color;
      context.save();
      context.globalAlpha = alpha * focusAlpha;
      context.fillStyle = textColor;
      context.fillText(data.label, chosen.x, chosen.y);
      context.restore();

      if (!hasSecondaryLabel) return;
      context.font = `${labelWeight} ${secondarySize}px ${labelFont}`;
      context.save();
      context.globalAlpha = alpha * focusAlpha;
      context.fillStyle = textColor;
      context.fillText(fullName, chosen.x, chosen.y + secondarySize);
      context.restore();
    },
    defaultDrawNodeHover: (context, data, settings) => {
      const attributes = graph.hasNode(data.key) ? graph.getNodeAttributes(data.key) : {};
      const nodeData = { ...attributes, ...data };
      const hoverData = { ...nodeData, color: nodeColorForMode(nodeData, true), label: null };
      drawDiscNodeHover(context, hoverData, settings);
    },
    enableEdgeEvents: true,
    defaultEdgeType: 'line',
    edgeProgramClasses: buildEdgeProgramClasses(),
  });
  state.renderer = renderer;
  // Starts the relationship diagram ~2x as zoomed in as Sigma's default full-extent fit.
  renderer.getCamera().setState({ ...renderer.getCamera().getState(), ratio: fromGoogleSheets ? 1 : 0.5 });
  relationshipsCameraState = renderer.getCamera().getState();

  function refresh() {
    updateFocusOpacity();
    renderer.refresh();
  }

  colorModeSelect.addEventListener('change', () => {
    state.colorMode = colorModeSelect.value;
    refresh();
  });

  sizeNodesByScaleToggle.addEventListener('change', () => {
    state.sizeNodesByScale = sizeNodesByScaleToggle.checked;
    refresh();
  });

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
    updateLabelTiers();
    refreshVisibleNodeDetails();
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

  function applyNodeSizeDisplay(display) {
    const clamped = Math.max(1, Math.min(100, display));
    nodeSizeSlider.value = String(clamped);
    state.nodeSizeScale = nodeSizeDisplayToScale(clamped);
    nodeSizeValue.textContent = String(Math.round(clamped));
    refresh();
  }

  nodeSizeSlider.addEventListener('input', () => {
    applyNodeSizeDisplay(Number(nodeSizeSlider.value));
  });

  nodeSizeDecrement.addEventListener('click', () => {
    applyNodeSizeDisplay(Number(nodeSizeSlider.value) - 25);
  });

  nodeSizeIncrement.addEventListener('click', () => {
    applyNodeSizeDisplay(Number(nodeSizeSlider.value) + 25);
  });

  makeSliderOutputEditable(nodeSizeValue, () => ({ min: 1, max: 100 }), applyNodeSizeDisplay);

  labelsToggle.addEventListener('change', () => {
    state.showLabels = labelsToggle.checked;
    refresh();
  });

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

  // Buckets nodes into 3 label tiers (by rank, not raw value) based on whichever
  // centrality type is currently selected, so label prominence/visibility tracks it.
  // The top tier (largest text) is capped at 10 nodes; the rest split evenly below it.
  const MAX_TOP_LABEL_TIER_NODES = 10;
  function updateLabelTiers() {
    const scores = getCentralityFilterScores();
    const sortedEntries = Object.entries(scores).sort((first, second) => first[1] - second[1]);
    const tiers = new Map();
    const topCount = Math.min(MAX_TOP_LABEL_TIER_NODES, sortedEntries.length);
    const topEntries = sortedEntries.slice(sortedEntries.length - topCount);
    const remainingEntries = sortedEntries.slice(0, sortedEntries.length - topCount);
    topEntries.forEach(([node]) => tiers.set(node, 2));
    remainingEntries.forEach(([node], index) => {
      const percentile = remainingEntries.length > 1 ? index / (remainingEntries.length - 1) : 1;
      tiers.set(node, percentile >= 0.5 ? 1 : 0);
    });
    labelTierByNode = tiers;
  }

  function passesCentralityThreshold(node) {
    if (state.centralityThreshold <= 0) return true;
    // Only degree centrality filtering is implemented so far; other types pass through.
    if (state.centralityFilterType !== 'degree-centrality') return true;
    const rank = centralityThresholdRanks.get(node) ?? 0;
    return rank > state.centralityThreshold;
  }

  function isNodeVisible(node) {
    return state.pinnedGraphNodeIds.has(node)
      || (isNodeVisibleBase(node) && passesCentralityThreshold(node));
  }
  state.isNodeVisible = isNodeVisible;

  function updateFocusOpacity() {
    const pinnedGraphNodeIds = new Set();
    const pinnedGraphEdgeIds = new Set();
    state.pinnedSelections.forEach((selection) => {
      const nodeIds = selection.nodeIds || [];
      nodeIds.forEach((node) => {
        if (graph.hasNode(node)) pinnedGraphNodeIds.add(node);
      });
      if (selection.kind === 'node') {
        const pinnedActors = new Set(nodeIds);
        graph.forEachEdge((edge, attributes, source, target) => {
          if (!pinnedActors.has(source) && !pinnedActors.has(target)) return;
          pinnedGraphEdgeIds.add(edge);
          pinnedGraphNodeIds.add(source);
          pinnedGraphNodeIds.add(target);
        });
      }
      (selection.edgeIds || []).forEach((edge) => {
        if (!graph.hasEdge(edge)) return;
        pinnedGraphEdgeIds.add(edge);
        graph.extremities(edge).forEach((node) => pinnedGraphNodeIds.add(node));
      });
    });
    state.pinnedGraphNodeIds = pinnedGraphNodeIds;
    state.pinnedGraphEdgeIds = pinnedGraphEdgeIds;

    const hoveredNodeIds = [hoveredLabelNode, hoveredHaloNode, hoveredBuildingActorId, state.hoveredSearchNodeId]
      .filter((node) => node && graph.hasNode(node));
    const hoveredEdgeIds = [...state.hoveredEdgeIds];
    const hoveredEdgeSelection = hoveredEdgeIds.length
      ? {
        kind: 'edge',
        nodeIds: [...new Set(hoveredEdgeIds.flatMap((edge) => graph.extremities(edge)))],
        edgeIds: hoveredEdgeIds,
      }
      : null;
    const currentSelection = state.currentSelection;
    const isPinnedNode = (node) => state.pinnedSelections.some((selection) =>
      selection.kind === 'node' && selection.nodeIds.includes(node));
    const isPinnedEdge = (edge) => state.pinnedSelections.some((selection) =>
      selection.kind === 'edge' && selection.edgeIds.includes(edge));
    const focusIsPinned = Boolean(currentSelection
      && state.pinnedSelections.some(({ key }) => key === currentSelection.key))
      || hoveredNodeIds.some(isPinnedNode)
      || hoveredEdgeIds.some(isPinnedEdge);
    const focusSelections = focusIsPinned
      ? state.pinnedSelections
      : [
        ...(currentSelection ? [currentSelection] : []),
        ...hoveredNodeIds.map((node) => ({ kind: 'node', nodeIds: [node] })),
        ...(hoveredEdgeSelection ? [hoveredEdgeSelection] : []),
      ];
    const focusNodeIds = new Set();
    const focusEdgeIds = new Set();

    const addNodeFocus = (node) => {
      if (!graph.hasNode(node) || !isNodeVisible(node)) return;
      focusNodeIds.add(node);
      graph.forEachEdge((edge, attributes, source, target) => {
        if (!state.activeEdgeTypes.has(attributes.adjacencyType) && !state.pinnedGraphEdgeIds.has(edge)
          || !isNodeVisible(source)
          || !isNodeVisible(target)
          || (source !== node && target !== node)) return;
        focusEdgeIds.add(edge);
        focusNodeIds.add(source === node ? target : source);
      });
    };

    focusSelections.forEach((selection) => {
      if (selection.kind === 'node') {
        (selection.nodeIds || []).forEach(addNodeFocus);
        return;
      }
      (selection.nodeIds || []).forEach((node) => {
        if (graph.hasNode(node) && isNodeVisible(node)) focusNodeIds.add(node);
      });
      (selection.edgeIds || []).forEach((edge) => {
        if (!graph.hasEdge(edge)) return;
        const attributes = graph.getEdgeAttributes(edge);
        const [source, target] = graph.extremities(edge);
        if ((state.activeEdgeTypes.has(attributes.adjacencyType) || state.pinnedGraphEdgeIds.has(edge))
          && isNodeVisible(source)
          && isNodeVisible(target)) focusEdgeIds.add(edge);
      });
    });

    state.focusOpacityActive = focusSelections.length > 0;
    state.focusNodeIds = focusNodeIds;
    state.focusEdgeIds = focusEdgeIds;
    state.emphasizedNodeIds = new Set([
      ...state.pinnedSelections.flatMap(({ nodeIds }) => nodeIds || []),
      ...(currentSelection?.nodeIds || []),
      ...hoveredNodeIds,
      ...(hoveredEdgeSelection?.nodeIds || []),
      ...focusSelections
        .filter((selection) => selection.kind === 'edge')
        .flatMap(({ nodeIds }) => nodeIds || []),
    ]);
  }
  state.updateFocusOpacity = updateFocusOpacity;

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
      if (mode === 'public-interest') {
        return [node, graph.getNodeAttribute(node, 'hits')];
      }
      if (mode === 'plain') return [node, 0];
      return [node, Number.isFinite(scores[node]) ? scores[node] : 0];
    }));
    const values = [...visibleScores.values()].filter(Number.isFinite);
    const minimum = values.length ? Math.min(...values) : 0;
    const maximum = values.length ? Math.max(...values) : 0;

    graph.forEachNode((node) => {
      const value = visibleScores.get(node);
      const ratio = !Number.isFinite(value) || maximum <= minimum
        ? 0
        : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
      graph.setNodeAttribute(node, 'haloRatio', mode === 'plain' ? null : ratio);
      graph.setNodeAttribute(node, 'haloMode', mode);
      graph.setNodeAttribute(node, 'haloScore', mode !== 'plain' && Number.isFinite(value) ? value : null);
    });
  }

  updateNodeSizes();
  updateCentralityThresholdRange();
  updateLabelTiers();

  renderer.on('beforeRender', () => {
    placedLabelBoxes = [];
  });

  renderer.createCanvasContext('financial-upfront', {
    beforeLayer: 'nodes',
    style: { pointerEvents: 'none' },
  });
  const financialUpfrontContext = renderer.getCanvases()['financial-upfront'].getContext('2d');
  renderer.on('afterRender', () => {
    if (financialUpfrontContext) drawFinancialUpfront(financialUpfrontContext, renderer, graph);
  });
  renderer.createCanvasContext('size-halos', {
    beforeLayer: 'edges',
    style: { pointerEvents: 'none' },
  });
  const sizeHaloContext = renderer.getCanvases()['size-halos'].getContext('2d');
  renderer.createCanvasContext('halo-outlines', {
    beforeLayer: 'edges',
    style: { pointerEvents: 'none' },
  });
  const haloOutlineContext = renderer.getCanvases()['halo-outlines'].getContext('2d');
  let haloHitTargets = [];
  renderer.createCanvasContext('category-pies', {
    afterLayer: 'hoverNodes',
    style: { pointerEvents: 'none' },
  });
  const categoryPieContext = renderer.getCanvases()['category-pies'].getContext('2d');
  renderer.resize(true);
  renderer.on('afterRender', () => {
    if (!sizeHaloContext) return;
    const { width, height } = renderer.getDimensions();
    sizeHaloContext.clearRect(0, 0, width, height);
    haloOutlineContext?.clearRect(0, 0, width, height);
    haloHitTargets = [];
    graph.forEachNode((node, attributes) => {
      if (!isNodeVisible(node) || !Number.isFinite(attributes.haloRatio)) return;
      const haloSize = haloSizeForScore(attributes.scale, attributes.haloRatio, 0, 1);
      if (haloSize <= coreNodeSize(attributes.scale)) return;
      const focusAlpha = state.focusOpacityActive && !state.focusNodeIds.has(node)
        ? FOCUS_DIM_OPACITY
        : 1;
      sizeHaloContext.globalAlpha = 0.16 * focusAlpha;
      const { x, y } = renderer.graphToViewport({ x: attributes.x, y: attributes.y });
      const radius = renderer.scaleSize(haloSize);
      haloHitTargets.push({ node, x, y, radius });
      const isEmphasized = node === hoveredLabelNode || state.emphasizedNodeIds.has(node);
      sizeHaloContext.fillStyle = nodeColorForMode(attributes, isEmphasized);
      sizeHaloContext.beginPath();
      sizeHaloContext.arc(x, y, renderer.scaleSize(haloSize), 0, Math.PI * 2);
      sizeHaloContext.fill();
      const directlyFocused = node === hoveredLabelNode
        || node === hoveredHaloNode
        || node === hoveredBuildingActorId
        || node === state.hoveredSearchNodeId
        || (state.currentSelection?.kind === 'node' && state.currentSelection.nodeIds.includes(node))
        || state.pinnedSelections.some((selection) => selection.kind === 'node' && selection.nodeIds.includes(node));
      if (haloOutlineContext) {
        const outlinedFocus = state.focusOpacityActive && directlyFocused;
        haloOutlineContext.strokeStyle = outlinedFocus ? '#ffffff' : `rgba(255, 255, 255, ${0.2 * focusAlpha})`;
        haloOutlineContext.lineWidth = outlinedFocus ? 1 : 0.5;
        haloOutlineContext.beginPath();
        haloOutlineContext.arc(x, y, radius, 0, Math.PI * 2);
        haloOutlineContext.stroke();
      }
    });
    sizeHaloContext.globalAlpha = 1;
  });
  renderer.on('afterRender', () => {
    if (!categoryPieContext) return;
    const { width, height } = renderer.getDimensions();
    categoryPieContext.clearRect(0, 0, width, height);
    if (state.colorMode !== 'category') return;
    graph.forEachNode((node, attributes) => {
      if (!isNodeVisible(node)) return;
      const displayData = renderer.getNodeDisplayData(node);
      if (!displayData || displayData.hidden) return;
      const { x, y } = renderer.framedGraphToViewport(displayData);
      const focusAlpha = state.focusOpacityActive && !state.focusNodeIds.has(node)
        ? FOCUS_DIM_OPACITY
        : 1;
      categoryPieContext.globalAlpha = focusAlpha;
      drawCategoryPie(categoryPieContext, x, y, renderer.scaleSize(displayData.size), attributes.topics);
    });
    categoryPieContext.globalAlpha = 1;
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

  function setCustomBBoxPreservingCamera(customBBox) {
    const camera = renderer.getCamera();
    const cameraState = camera.getState();
    const getNormalization = (bbox) => {
      const minX = bbox.x[0];
      const maxX = bbox.x[1];
      const minY = bbox.y[0];
      const maxY = bbox.y[1];
      const scale = Math.max(maxX - minX, maxY - minY);
      return {
        centerX: Number.isFinite(minX + maxX) ? (minX + maxX) / 2 : 0,
        centerY: Number.isFinite(minY + maxY) ? (minY + maxY) / 2 : 0,
        scale: Number.isFinite(scale) && scale > 0 ? scale : 1,
      };
    };
    const previousNormalization = getNormalization(renderer.getCustomBBox() || renderer.getBBox());
    renderer.setCustomBBox(customBBox);
    const nextNormalization = getNormalization(customBBox || renderer.getBBox());
    const worldCenterX = previousNormalization.centerX
      + (cameraState.x - 0.5) * previousNormalization.scale;
    const worldCenterY = previousNormalization.centerY
      + (cameraState.y - 0.5) * previousNormalization.scale;

    camera.setState({
      ...cameraState,
      x: 0.5 + (worldCenterX - nextNormalization.centerX) / nextNormalization.scale,
      y: 0.5 + (worldCenterY - nextNormalization.centerY) / nextNormalization.scale,
      ratio: camera.getBoundedRatio(cameraState.ratio * previousNormalization.scale / nextNormalization.scale),
    });
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
    graphContainer.addEventListener('pointermove', updateHoveredBuilding);
    graphContainer.addEventListener('pointerleave', clearHoveredBuilding);
    renderer.resize(true);
  }

  function createProjectedPath(rings) {
    const path = new Path2D();
    rings.forEach((ring) => {
      if (ring.length < 3) return;
      ring.forEach((point, index) => {
        // graphToViewport normalizes raw graph-space coordinates before projecting to pixels.
        const viewportPoint = renderer.graphToViewport(mapProjection(point.lng, point.lat));
        if (index === 0) path.moveTo(viewportPoint.x, viewportPoint.y);
        else path.lineTo(viewportPoint.x, viewportPoint.y);
      });
      path.closePath();
    });
    return path;
  }

  function drawRings(ctx, rings, fillStyle, strokeStyle, lineWidth = 1) {
    const path = createProjectedPath(rings);
    if (fillStyle) {
      ctx.fillStyle = fillStyle;
      ctx.fill(path);
    }
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke(path);
    }
  }

  function updateHoveredBuilding(event) {
    if (workspace.dataset.mode !== 'map' || !mapGeoContext) {
      clearHoveredBuilding();
      return;
    }
    const bounds = graphContainer.getBoundingClientRect();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    let actorId = null;
    for (let index = mapFootprintHitTargets.length - 1; index >= 0; index -= 1) {
      const target = mapFootprintHitTargets[index];
      if (target.actorId && mapGeoContext.isPointInPath(target.path, x, y)) {
        actorId = target.actorId;
        break;
      }
    }
    if (actorId === hoveredBuildingActorId) return;
    hoveredBuildingActorId = actorId;
    refresh();
  }

  function clearHoveredBuilding() {
    if (!hoveredBuildingActorId) return;
    hoveredBuildingActorId = null;
    refresh();
  }

  function drawMapGeoLayer() {
    if (!mapGeoContext || !mapModeApplied || !mapGeography || !mapProjection) return;
    const { width, height } = renderer.getDimensions();
    mapGeoContext.clearRect(0, 0, width, height);
    mapFootprintHitTargets = mapGeography.buildingFootprints.map((footprint) => {
      const actorId = footprint.actorId && graph.hasNode(footprint.actorId) ? footprint.actorId : null;
      const path = createProjectedPath(footprint.rings);
      const attributes = actorId ? graph.getNodeAttributes(actorId) : null;
      const isEmphasized = actorId === hoveredBuildingActorId || state.emphasizedNodeIds.has(actorId);
      const color = attributes ? nodeColorForMode(attributes, isEmphasized) : '#ffffff';
      const opacity = actorId && state.focusOpacityActive && !state.focusNodeIds.has(actorId)
        ? FOCUS_DIM_OPACITY
        : 1;
      mapGeoContext.globalAlpha = opacity;
      mapGeoContext.fillStyle = color;
      mapGeoContext.fill(path);
      mapGeoContext.strokeStyle = color;
      mapGeoContext.lineWidth = 1;
      mapGeoContext.stroke(path);
      return { actorId, path };
    });
    mapGeoContext.globalAlpha = 1;

    if (!mapGeoFrontContext) return;
    mapGeoFrontContext.clearRect(0, 0, width, height);
    drawRings(mapGeoFrontContext, mapGeography.islandRings, null, 'rgba(160, 200, 255, 0.9)');
    mapFootprintHitTargets.forEach(({ actorId, path }) => {
      if (!actorId || (actorId !== hoveredBuildingActorId && !state.emphasizedNodeIds.has(actorId))) return;
      mapGeoFrontContext.beginPath();
      mapGeoFrontContext.strokeStyle = '#ffffff';
      mapGeoFrontContext.lineWidth = 2;
      mapGeoFrontContext.stroke(path);
    });
  }

  // Pins actors tied to a building at that building's projected location and
  // lets the rest of the network settle around that fixed geography.
  async function applyMapLayout() {
    if (mapModeApplied || !state.graph || !state.renderer) return;
    mapModeApplied = true;
    const generation = ++mapLayoutGeneration;
    const geo = await ensureMapGeography();
    if (generation !== mapLayoutGeneration || workspace.dataset.mode !== 'map') return;
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
      setCustomBBoxPreservingCamera({
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
    mapLayoutGeneration += 1;
    setCustomBBoxPreservingCamera(null);
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

  function zoomToCurrentAndPinned(selectionToZoom = null) {
    if (!state.zoomToSelected) return;
    const nodeIds = selectionToZoom
      ? selectionToZoom.nodeIds || []
      : [
        ...(state.currentSelection?.nodeIds || []),
        ...state.pinnedSelections.flatMap((selection) => selection.nodeIds || []),
      ];
    const selectedNodeIds = new Set(nodeIds.filter((node) => graph.hasNode(node) && isNodeVisible(node)));
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

  state.zoomToSelection = zoomToCurrentAndPinned;

  renderer.on('enterNode', ({ node }) => {
    hoveredLabelNode = node;
    refresh();
  });
  renderer.on('leaveNode', () => {
    hoveredLabelNode = null;
    refresh();
  });

  renderer.setSetting('nodeReducer', (node, data) => {
    const hidden = !isNodeVisible(node);
    if (hidden) return { ...data, hidden: true };
    const tier = labelTierByNode.get(node) ?? 1;
    const isEmphasized = node === hoveredLabelNode || state.emphasizedNodeIds.has(node);
    const isFocusLabel = state.focusNodeIds.has(node);
    const isNewFromSheet = data.newFromSheet === true;
    const isDimmed = state.focusOpacityActive && !state.focusNodeIds.has(node);
    const nodeColor = nodeColorForMode(data, isEmphasized);
    const zoomEligible = renderer.getCamera().getState().ratio <= LABEL_TIER_MAX_RATIO[tier];
    const labelVisible = isEmphasized || isFocusLabel || isNewFromSheet || (state.showLabels && zoomEligible);
    return {
      ...data,
      size: coreNodeSize(data.scale),
      color: isDimmed ? colorWithOpacity(nodeColor, FOCUS_DIM_OPACITY) : nodeColor,
      // Only force the top tier (bypassing Sigma's overlap avoidance); lower tiers still
      // go through the normal spacing algorithm once in-range, to avoid a wall of text.
      forceLabel: isEmphasized || isFocusLabel || isNewFromSheet || (tier === 2 && state.showLabels && zoomEligible),
      highlighted: isEmphasized,
      label: labelVisible ? data.label : null,
    };
  });

  renderer.setSetting('edgeReducer', (edge, data) => {
    const [source, target] = graph.extremities(edge);
    const nodesVisible = isNodeVisible(source) && isNodeVisible(target);
    const hidden = (!state.activeEdgeTypes.has(data.adjacencyType) && !state.pinnedGraphEdgeIds.has(edge))
      || !nodesVisible;
    if (hidden) return { ...data, hidden: true };
    const withWidthOrder = (size, attributes = data) => ({
      ...attributes,
      type: edgeProgramType(data.baseRenderType, size),
      size,
      zIndex: Math.max(0, MAX_WEIGHTED_EDGE_WIDTH - size),
    });
    if (state.selectedEdgeIds.has(edge)) {
      return withWidthOrder(Math.max(data.size || MIN_EDGE_WIDTH, 3));
    }
    return state.hoveredEdgeIds.has(edge)
      ? withWidthOrder(Math.max(data.size || MIN_EDGE_WIDTH, 2.5))
      : state.focusOpacityActive && !state.focusEdgeIds.has(edge)
        ? withWidthOrder(data.size || MIN_EDGE_WIDTH, { ...data, color: colorWithOpacity(data.color, FOCUS_DIM_OPACITY) })
        : withWidthOrder(data.size || MIN_EDGE_WIDTH);
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

  makeSliderOutputEditable(edgeCurvatureValue, () => ({ min: 0, max: 100 }), applyEdgeCurvaturePercent);

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

  makeSliderOutputEditable(layoutGravityValue, () => ({ min: 0, max: 25 }), (value) => {
    setLayoutGravityDisplay(value);
    state.layoutGravity = value;
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
  const yearDecrement = document.getElementById('year-decrement');
  const yearIncrement = document.getElementById('year-increment');
  yearToggle.addEventListener('change', () => {
    state.yearFilterEnabled = yearToggle.checked;
    yearControls.hidden = !state.yearFilterEnabled;
    refresh();
    relayout();
  });
  function applyYear(year) {
    const clamped = Math.max(1920, Math.min(2026, year));
    yearSlider.value = String(clamped);
    state.selectedYear = clamped;
    yearValue.textContent = String(clamped);
    refresh();
    relayout();
  }
  yearSlider.addEventListener('input', () => {
    applyYear(Number(yearSlider.value));
  });
  yearDecrement.addEventListener('click', () => {
    applyYear(Number(yearSlider.value) - 5);
  });
  yearIncrement.addEventListener('click', () => {
    applyYear(Number(yearSlider.value) + 5);
  });
  makeSliderOutputEditable(yearValue, () => ({ min: 1920, max: 2026 }), applyYear);

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

  makeSliderOutputEditable(
    centralityThresholdValue,
    () => ({
      min: centralityThresholdSteps[0] ?? 0,
      max: centralityThresholdSteps[centralityThresholdSteps.length - 1] ?? 0,
    }),
    (value) => {
      // Snap the typed connection count to whichever achievable tick is closest.
      const closestIndex = centralityThresholdTickIndices.reduce((closest, candidate) => (
        Math.abs(centralityThresholdSteps[candidate] - value) < Math.abs(centralityThresholdSteps[closest] - value)
          ? candidate
          : closest
      ), centralityThresholdTickIndices[0] ?? 0);
      applyCentralityThresholdIndex(closestIndex);
    },
  );

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
  // Keeps the zoom controls clear of the details panel regardless of its collapsed/
  // expanded/resized width, since both are anchored to the workspace's right edge.
  function updateZoomControlsOffset() {
    workspace.style.setProperty('--zoom-controls-details-offset', `${detailsSidebar.offsetWidth}px`);
  }
  updateZoomControlsOffset();
  detailsToggle.addEventListener('click', () => {
    const collapsed = detailsSidebar.classList.toggle('collapsed');
    state.detailsManuallyCollapsed = collapsed;
    if (!collapsed) detailsSidebar.classList.remove('has-unread');
    detailsToggle.setAttribute('aria-expanded', String(!collapsed));
    detailsToggle.setAttribute('aria-label', collapsed ? 'Show details' : 'Minimize details');
    detailsToggle.textContent = collapsed ? '+' : '−';
    updateZoomControlsOffset();
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
      updateZoomControlsOffset();
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
    zoomToCurrentAndPinned(state.currentSelection);
    if (window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
      setPanel('details');
    }
  }

  function openEdgeDetails(edge) {
    showEdgeDetails(graph, edge);
    zoomToCurrentAndPinned(state.currentSelection);
    if (window.matchMedia('(max-width: 700px) and (orientation: portrait)').matches) {
      setPanel('details');
    }
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    state.hoveredSearchNodeId = null;
    syncEmphasizedNodes();
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
      row.addEventListener('pointerenter', () => {
        state.hoveredSearchNodeId = n;
        syncEmphasizedNodes();
      });
      row.addEventListener('pointerleave', () => {
        if (state.hoveredSearchNodeId !== n) return;
        state.hoveredSearchNodeId = null;
        syncEmphasizedNodes();
      });

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
  function haloBoundaryNodeAt(event) {
    if (workspace.dataset.mode === 'timeline'
      || renderer.getNodeAtPosition(event)
      || renderer.getEdgeAtPoint(event.x, event.y)) return null;
    return hitTestHaloBoundary(haloHitTargets, event.x, event.y);
  }

  function setHoveredHalo(node) {
    if (hoveredHaloNode === node) return;
    hoveredHaloNode = node;
    refresh();
  }

  const mouseCaptor = renderer.getMouseCaptor();
  mouseCaptor.on('mousemove', (event) => {
    setHoveredHalo(mouseCaptor.isMouseDown ? null : haloBoundaryNodeAt(event));
  });
  mouseCaptor.on('mousedown', () => setHoveredHalo(null));
  renderer.on('leaveStage', () => setHoveredHalo(null));
  renderer.on('clickStage', ({ event }) => {
    const node = haloBoundaryNodeAt(event);
    if (node) openNodeDetails(node);
    else clearCurrentSelection();
  });
  renderer.on('rightClickStage', ({ event }) => {
    const node = haloBoundaryNodeAt(event);
    if (node) showPinContextMenu(createNodeSelection(graph, node), event);
  });
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

  const zoomLevel = document.createElement('output');
  zoomLevel.className = 'zoom-level-indicator';
  zoomLevel.setAttribute('aria-label', 'Zoom level');
  zoomLevel.title = 'Current zoom level';
  workspace.appendChild(zoomLevel);
  const updateZoomLevel = ({ ratio }) => {
    zoomLevel.textContent = `${zoomPercentFromRatio(ratio)}%`;
  };
  const camera = renderer.getCamera();
  camera.on('updated', updateZoomLevel);
  updateZoomLevel(camera.getState());

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
