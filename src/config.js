// Central place to tweak how CSV data is interpreted.
const base = import.meta.env.BASE_URL;

export const DATA = {
  actorsFile: `${base}data/actors.csv`,
  sentimentFile: `${base}data/actor%20database%20-%20actor_working%20-%20with%20news%20hits.csv`,
  adjacencyFile: `${base}data/edges/adjacency.csv`,
  edgesManifest: `${base}data/edges/manifest.json`,
  googleSheets: {
    publishedUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTWRxyJfkdgZ_KTQJ_gWNCHiWeIp5ciie9yx02upPZG489o8NYQER8R8tPiXK0Qz_pewTz8N2TqQAaJ/pub',
    actorGid: '1300872278',
    adjacencyGid: '548852791',
  },
  // Column in actors.csv used as the graph node id. Must match adjacency endpoints.
  nodeIdField: 'actor',
  nodeLabelField: 'actor',
  nodeAbbreviationField: 'abbrev',
  // Column used to build the "Actor category" filter + node color.
  nodeCategoryField: 'type',
  nodeTopicField: 'topic',
  // Column used to build the "Scale" filter, e.g. "0 - MICRO", "1 - MESO".
  nodeScaleField: 'scale',
  // Adjacency types that are symmetric (rendered as plain undirected lines).
  // Every other type is treated as directional and rendered with an arrow.
  undirectedEdgeTypes: ['col'],
  // Set to false for datasets without spatial data; hides the Map mode tab.
  mapEnabled: true,
  // Caption shown in the corner of Map mode.
  mapLabel: 'Roosevelt Island',
};

export const SHEET_ADJACENCY_TYPES = {
  'ADMINISTRATOR-ADMINISTRATED': 'adm',
  COLLABORATION: 'col',
  'CREATOR-CREATION': 'cre',
  'FINANCIAL (RECIPIENT-SENDER)': 'fin',
  'OWNER-TENANT': 'own',
  'PARENT-CHILD': 'par',
  'POSITION-INCUMBENT': 'pos',
  'PREDECESSOR-SUCCESSOR': 'pre',
  'REPRESENTATIVE-ELECTOR': 'rep',
};

export const PALETTE = [
  '#4f9dff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff',
  '#f4845f', '#5eead4', '#f472b6', '#a3e635', '#fbbf24',
];

// Fixed colours for sector values (nodeCategoryField); unlisted sectors fall back to PALETTE.
export const SECTOR_COLORS = {
  PUBLIC: '#ffd23d',
  PRIVATE: '#3d94ff',
  COMMUNITY: '#ff3ba9',
  VOLUNTARY: '#ff3ba9',
  OTHER: '#dbdbdb',
};
