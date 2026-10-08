import Graph from 'graphology';
import betweennessCentrality from 'graphology-metrics/centrality/betweenness.js';
import closenessCentrality from 'graphology-metrics/centrality/closeness.js';
import eigenvectorCentrality from 'graphology-metrics/centrality/eigenvector.js';

function shortestPathGraph(graph) {
  // Neighborhood indices require one arc per reachable neighbor. Parallel
  // relationships do not change unweighted shortest-path distances.
  const paths = new Graph({ type: 'directed' });
  graph.forEachNode((node) => paths.addNode(node));
  graph.forEachEdge((edge, attributes, source, target, sourceAttributes, targetAttributes, undirected) => {
    if (!paths.hasDirectedEdge(source, target)) paths.addDirectedEdge(source, target);
    if (undirected && !paths.hasDirectedEdge(target, source)) paths.addDirectedEdge(target, source);
  });
  return paths;
}

export function calculateCentralityScores(mode, graph) {
  if (!graph.order) return {};
  if (mode === 'degree-centrality') {
    return Object.fromEntries(graph.nodes().map((node) => [node, graph.degree(node)]));
  }
  if (mode === 'closeness-centrality') {
    return closenessCentrality(shortestPathGraph(graph), { wassermanFaust: true });
  }
  if (mode === 'betweenness-centrality') {
    return betweennessCentrality(shortestPathGraph(graph), { getEdgeWeight: null });
  }
  if (mode === 'eigenvector-centrality') {
    return eigenvectorCentrality(graph, { getEdgeWeight: null, maxIterations: 500 });
  }
  throw new Error(`Unknown centrality measure: ${mode}`);
}

export function formatCentralityScore(mode, score) {
  return mode === 'degree-centrality' ? String(score) : Number(score.toPrecision(3)).toString();
}
