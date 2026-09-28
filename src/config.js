// Central place to tweak how CSV data is interpreted.
const base = import.meta.env.BASE_URL;

export const DATA = {
  actorsFile: `${base}data/actors.csv`,
  edgesManifest: `${base}data/edges/manifest.json`,
  edgesDir: `${base}data/edges/`,
  // Column in actors.csv used as the graph node id. Must match the row/column
  // headers used in the adjacency matrix CSVs.
  nodeIdField: 'actor',
  nodeLabelField: 'actor',
  // Column used to build the "Actor category" filter + node color.
  nodeCategoryField: 'type',
  nodeTopicField: 'topic',
  // Column used to build the "Scale" filter, e.g. "0 - MICRO", "1 - MESO".
  nodeScaleField: 'scale',
  // Adjacency types that are symmetric (rendered as plain undirected lines).
  // Every other type is treated as directional and rendered with an arrow.
  undirectedEdgeTypes: ['col'],
};

export const PALETTE = [
  '#4f9dff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff',
  '#f4845f', '#5eead4', '#f472b6', '#a3e635', '#fbbf24',
];
