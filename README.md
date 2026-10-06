# Roosevelt Networks

Interactive network model of New Deal-era actors, built with [sigma.js](https://www.sigmajs.org/) + [graphology](https://graphology.github.io/).

Live site: https://imadeitfor.you/app/roosevelt-networks/ (not yet linked from the portfolio's own pages)

Documentation pages, each a static `index.html` in `public/` that reuses the portfolio's stylesheet (plus [public/docs.css](public/docs.css)) and deploys alongside the app: [tutorial](https://imadeitfor.you/app/roosevelt-networks/tutorial/) ([source](public/tutorial/index.html)), [methodology](https://imadeitfor.you/app/roosevelt-networks/methodology/) ([source](public/methodology/index.html)) and [custom datasets](https://imadeitfor.you/app/roosevelt-networks/custom/) ([source](public/custom/index.html)). The app's info menu links to them.

## Data format

### Nodes — `public/data/actors.csv`

One row per actor:

| column | meaning |
|---|---|
| `actor` | full name / label shown in the graph — **must match the `source` and `target` values in `adjacency.csv`**, and must be unique |
| `abbrev` | short id, shown in the details panel (optional) |
| `topic` | topic tag(s), comma-separated |
| `type` | category used for the "Actor category" filter and node color |
| `scale` | e.g. local / national |
| `year_start`, `year_end` | active date range (optional) |

Blank cells are fine — the loader trims whitespace on every field and skips rows with no `actor` value. If the same actor name appears twice, only the first row is kept (a warning is logged to the browser console).

The optional year filter uses an inclusive `year_start`/`year_end` range from 1920 through 2026. A missing start or end is treated as open-ended; actors with neither year set remain visible for every selected year.

### Edges — `public/data/edges/adjacency.csv` + `manifest.json`

The graph is built from the edge-list columns `source-target relationship`, `source`, and `target` in `adjacency.csv`. Actor names must match `actor` in `actors.csv`. Duplicate pairs are collapsed, and Collaboration pairs are deduplicated regardless of endpoint order. `manifest.json` maps relationship types to graph filters, labels, and colors. The `matrix_*.csv` files are legacy snapshots and are not read at runtime.

To add a relationship type, add its label and code to `manifest.json` and add the sheet relationship name-to-code mapping in `src/config.js`.

### Refresh from Google Sheets

Use **Refresh from Google Sheets** in the sidebar to fetch the published `actor_working` and `adjacency` tabs, then rebuild the graph directly from those actors and edge rows. If a sheet request fails, its bundled CSV snapshot is used and the refresh is marked incomplete. The workbook must remain published to the web. Normal startup uses the bundled CSV snapshots; after refresh, the page stays in sheet mode on subsequent reloads. Published tab IDs are configured in `src/config.js`.

### Map points — `public/data/buildings/point-*.svg`

Map-mode point geometry is loaded from separate SVG files, each containing the island outline in a group with `id="boundary"` and exactly one point outside that group. The filename-to-actor mapping comes from the `point - "name"` rows of the "buildings" sheet (written to `map-points.json`); each point file uses the island boundary to align its location to the map. Points are drawn on the map and anchor their matching actors in map mode, taking precedence over building centroids. Hover over a building without an assigned actor to temporarily see its name or, if it has no name, its BIN.

Building footprint parameters and actor links live in the "buildings" sheet of the linked Google Spreadsheet. Run `npm run sync:buildings` to download it into `public/data/buildings/building_actors.csv` and regenerate `map-overlay.svg` and `map-points.json`.

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
