# Roosevelt Networks

Interactive network model of New Deal-era actors, built with [sigma.js](https://www.sigmajs.org/) + [graphology](https://graphology.github.io/), deployed to GitHub Pages.

Live site: https://aecao.github.io/roosevelt-networks/

## Data format

### Nodes — `public/data/actors.csv`

One row per actor:

| column | meaning |
|---|---|
| `actor` | full name / label shown in the graph |
| `abbrev` | short id — **must match the row/column headers in the adjacency matrix CSVs** |
| `topic` | topic tag |
| `type` | category used for the "Actor category" filter and node color |
| `scale` | e.g. local / national |
| `year_start`, `year_end` | active date range (optional) |

### Edges — `public/data/edges/*.csv` + `manifest.json`

Each relationship (e.g. parent-child, position-incumbent) is one **square adjacency matrix** CSV: the first row and first column both list actor `abbrev` values, and a non-empty/non-zero cell `[row, col]` means an edge from `row` to `col`. Numeric values >1 are used as edge weight.

`public/data/edges/manifest.json` lists which matrix files to load:

```json
[
  { "file": "parent-child.csv", "type": "parent-child", "label": "Parent–Child" }
]
```

To add your remaining adjacency matrices: drop the CSV in `public/data/edges/`, then add an entry to `manifest.json`. No code changes needed. The two files currently in the repo are placeholder samples — replace all data files with your real CSVs before deploying.

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## Deployment

Pushing to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml), which builds the site with Vite and publishes it via GitHub Pages.

One-time setup in the GitHub repo: **Settings → Pages → Source → GitHub Actions**.
