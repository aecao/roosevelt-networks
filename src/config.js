// Central place to tweak how CSV data is interpreted.
const base = import.meta.env.BASE_URL;

export const DATA = {
  actorsFile: `${base}data/actors.csv`,
  edgesManifest: `${base}data/edges/manifest.json`,
  edgesDir: `${base}data/edges/`,
  googleSheets: {
    publishedUrl: 'https://docs.google.com/spreadsheets/d/e/2PACX-1vTWRxyJfkdgZ_KTQJ_gWNCHiWeIp5ciie9yx02upPZG489o8NYQER8R8tPiXK0Qz_pewTz8N2TqQAaJ/pub',
    actorGid: '1300872278',
    matrixGids: {
      'matrix_adm.csv': '119384752',
      'matrix_col.csv': '368522815',
      'matrix_cre.csv': '615922550',
      'matrix_fin.csv': '899745488',
      'matrix_own.csv': '816708796',
      'matrix_par.csv': '721788304',
      'matrix_pos.csv': '1399262735',
      'matrix_pre.csv': '1972359226',
      'matrix_rep.csv': '923473874',
    },
  },
  // Column in actors.csv used as the graph node id. Must match the row/column
  // headers used in the adjacency matrix CSVs.
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
};

export const PALETTE = [
  '#4f9dff', '#ff6b6b', '#ffd166', '#06d6a0', '#c77dff',
  '#f4845f', '#5eead4', '#f472b6', '#a3e635', '#fbbf24',
];
