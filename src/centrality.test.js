import assert from 'node:assert/strict';
import test from 'node:test';
import Graph from 'graphology';
import { calculateCentralityScores, formatCentralityScore } from './centrality.js';

const modes = ['degree-centrality', 'closeness-centrality', 'betweenness-centrality', 'eigenvector-centrality'];

function mixedGraph() {
  const graph = new Graph({ multi: true });
  ['a', 'b', 'c', 'isolated'].forEach((node) => graph.addNode(node));
  graph.addDirectedEdge('a', 'b');
  graph.addDirectedEdge('a', 'b');
  graph.addUndirectedEdge('b', 'c');
  return graph;
}

test('degree retains parallel and undirected relationships', () => {
  assert.deepEqual(calculateCentralityScores('degree-centrality', mixedGraph()), {
    a: 2, b: 3, c: 1, isolated: 0,
  });
});

test('closeness follows inbound paths without inventing links for isolated actors', () => {
  assert.deepEqual(calculateCentralityScores('closeness-centrality', mixedGraph()), {
    a: 0, b: 2 / 3, c: 4 / 9, isolated: 0,
  });
});

test('betweenness follows directed paths and treats collaboration as bidirectional', () => {
  assert.deepEqual(calculateCentralityScores('betweenness-centrality', mixedGraph()), {
    a: 0, b: 1 / 6, c: 0, isolated: 0,
  });
});

test('overlapping directed and undirected links do not change shortest-path scores', () => {
  const graph = mixedGraph();
  const before = ['closeness-centrality', 'betweenness-centrality'].map((mode) => calculateCentralityScores(mode, graph));
  graph.addDirectedEdge('b', 'c');
  graph.addDirectedEdge('c', 'b');
  graph.addUndirectedEdge('b', 'c');
  ['closeness-centrality', 'betweenness-centrality'].forEach((mode, index) => {
    assert.deepEqual(calculateCentralityScores(mode, graph), before[index]);
  });
});

test('eigenvector retains relationship multiplicity and ranks incoming prestige', () => {
  const graph = new Graph({ multi: true });
  ['source', 'one', 'two'].forEach((node) => graph.addNode(node));
  graph.addDirectedEdge('source', 'one');
  graph.addDirectedEdge('one', 'source');
  graph.addDirectedEdge('source', 'two');
  graph.addDirectedEdge('source', 'two');
  graph.addDirectedEdge('two', 'source');
  const scores = calculateCentralityScores('eigenvector-centrality', graph);
  assert.ok(scores.two > scores.one);
  assert.ok(Object.values(scores).every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...Object.values(scores)) - 1) < 1e-10);
});

test('empty and singleton networks have well-defined centrality scores', () => {
  const graph = new Graph({ multi: true });
  modes.forEach((mode) => assert.deepEqual(calculateCentralityScores(mode, graph), {}));
  graph.addNode('alone');
  modes.forEach((mode) => assert.deepEqual(calculateCentralityScores(mode, graph), {
    alone: mode === 'eigenvector-centrality' ? 1 : 0,
  }));
});

test('fractional centrality readouts retain small nonzero scores', () => {
  assert.equal(formatCentralityScore('degree-centrality', 46), '46');
  assert.equal(formatCentralityScore('closeness-centrality', 4 / 9), '0.444');
  assert.equal(formatCentralityScore('betweenness-centrality', 1.2345e-8), '1.23e-8');
});

test('unknown measures fail explicitly', () => {
  assert.throws(() => calculateCentralityScores('unknown', mixedGraph()), /Unknown centrality measure/);
});
