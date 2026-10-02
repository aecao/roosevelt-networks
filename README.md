# Roosevelt Networks

Interactive network model of New Deal-era actors, built with [sigma.js](https://www.sigmajs.org/) + [graphology](https://graphology.github.io/).

Live site: https://imadeitfor.you/app/roosevelt-networks/ (not yet linked from the portfolio's own pages)

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

The imported `adjacency.csv` is the local source for these matrices. After updating it, run `node scripts/build-adjacency-matrices.mjs` to regenerate the matrix snapshots.

### Refresh from Google Sheets

Use **Refresh from Google Sheets** in the sidebar to fetch the published `actor_working` tab, the `adjacency` tab, and the nine `matrix_*` tabs, then rebuild the graph. The adjacency tab's parameter columns are attached to matching graph edges and shown in connection details. Financial frequency is read from the sheet's `parameter 2` column (the third parameter column). Normal startup uses the bundled CSV snapshots; after refresh, the page stays in sheet mode on subsequent reloads. Published tab IDs are configured in `src/config.js`.

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

Pushing to `main` runs two workflows:

- [.github/workflows/deploy-portfolio.yml](.github/workflows/deploy-portfolio.yml) builds the site with Vite (base path `/app/roosevelt-networks/`) and publishes `dist/` into the `aecao/portfolio` repo's `main` branch under `app/roosevelt-networks/`, leaving the rest of that repo untouched. This is the canonical deployment, served at https://imadeitfor.you/app/roosevelt-networks/.
- [.github/workflows/deploy.yml](.github/workflows/deploy.yml) publishes a tiny redirect page to this repo's own GitHub Pages site (https://aecao.github.io/roosevelt-networks/), so the old URL forwards visitors to the new one.

One-time setup for the portfolio deployment:

1. In GitHub, create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens) scoped to the `aecao/portfolio` repo with read/write access to contents.
2. In this repo, add it as a secret named `PORTFOLIO_DEPLOY_TOKEN` (Settings → Secrets and variables → Actions).

One-time setup for the redirect alias: **Settings → Pages → Source → GitHub Actions** (already configured if the old workflow was running before).
