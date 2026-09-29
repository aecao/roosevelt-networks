# Roosevelt Networks

Interactive network model of New Deal-era actors, built with [sigma.js](https://www.sigmajs.org/) + [graphology](https://graphology.github.io/), deployed to GitHub Pages.

Live site: https://aecao.github.io/roosevelt-networks/

## Data format

### Nodes — `public/data/actors.csv`

One row per actor:

| column | meaning |
|---|---|
| `actor` | full name / label shown in the graph — **must match the row/column headers in the adjacency matrix CSVs**, and must be unique |
| `abbrev` | short id, shown in the details panel (optional) |
| `topic` | topic tag(s), comma-separated |
| `type` | category used for the "Actor category" filter and node color |
| `scale` | e.g. local / national |
| `year_start`, `year_end` | active date range (optional) |

Blank cells are fine — the loader trims whitespace on every field and skips rows with no `actor` value. If the same actor name appears twice, only the first row is kept (a warning is logged to the browser console).

The optional year filter uses an inclusive `year_start`/`year_end` range from 1920 through 2026. A missing start or end is treated as open-ended; actors with neither year set remain visible for every selected year.

### Edges — `public/data/edges/*.csv` + `manifest.json`

Each relationship is one **square adjacency matrix** CSV: the first row and first column both list actor names (matching `actor` in actors.csv exactly), and a non-empty/non-zero cell `[row, col]` means an edge from `row` to `col`. Numeric values >1 are used as edge weight.

`public/data/edges/manifest.json` lists which matrix files to load and what label/filter each one gets:

```json
[
  { "file": "matrix_par.csv", "type": "par", "label": "Parent–Child" }
]
```

Current relationships:

| file | label |
|---|---|
| `matrix_adm.csv` | Administrator–Administrated |
| `matrix_col.csv` | Collaboration |
| `matrix_cre.csv` | Creator–Creation |
| `matrix_fin.csv` | Financial |
| `matrix_own.csv` | Owner–Tenant |
| `matrix_par.csv` | Parent–Child |
| `matrix_pos.csv` | Position–Incumbent |
| `matrix_pre.csv` | Predecessor–Successor |
| `matrix_rep.csv` | Representative–Elector |

To add another adjacency matrix, drop the CSV in `public/data/edges/` and add an entry to `manifest.json` — no code changes needed.

### Refresh from Google Sheets

Use **Refresh from Google Sheets** in the sidebar to fetch the published `actor_working` tab and the nine `matrix_*` tabs, then rebuild the graph. Other workbook tabs are ignored. The workbook must remain published to the web. Normal startup uses the bundled CSV snapshot; after refresh, the page stays in sheet mode on subsequent reloads. Published tab IDs are configured in `src/config.js`.

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
