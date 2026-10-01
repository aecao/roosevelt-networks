# Roosevelt Island Building Footprints

This folder contains 68 individually editable GeoJSON Features, one per NYC building identification number (BIN). Filenames use `bin-<BIN>.geojson`. Each file retains its footprint geometry and source attributes, and adds an address and land-use fields where a matching tax lot was available.

The map reads building attributes from [`buildings.csv`](buildings.csv) and joins each row to its footprint by `BIN`. Edit the CSV in a spreadsheet or text editor; the map reloads those values in each building's popup. Non-empty columns are displayed, including additional columns you add. Keep the `BIN` header and values unchanged for existing buildings.

To add a building, add a CSV row with a unique `BIN` and place its GeoJSON Feature in a matching `bin-<BIN>.geojson` file. Keep the file in this folder. Geometry and attributes remain independently editable.

## Sources

- Footprints and optional building names: [NYC DoITT BUILDING](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue), filtered to the Roosevelt Island polygon.
- Tax-lot attributes: [NYC DCP PLUTO](https://data.cityofnewyork.us/Housing-Development/Primary-Land-Use-Tax-Lot-Output-PLUTO/64uk-42ks), version 26v2, joined by BBL.
- Island filter boundary: [OpenStreetMap relation 2389564](https://www.openstreetmap.org/relation/2389564).
- Data retrieved: 2026-09-29.

Three footprints have a `name` in the footprint source. Names are omitted when the source has none; an address is not substituted as a building name. The `building_use` label is derived from PLUTO's land-use code. A null label means the source did not provide a usable code.

PLUTO describes tax lots, not individual structures. Roosevelt Island's 68 footprints match 17 tax lots, so address, land use, building class, year built, floor count, and area figures may be repeated across multiple footprints on a lot. Treat these as parcel-level attributes, not independently verified details about each structure's current occupants or ground-floor use.

The data uses WGS 84 coordinates in longitude, latitude order. Each `.geojson` file is a GeoJSON `Feature` with a `Polygon` or `MultiPolygon` geometry. Commit and deploy CSV or footprint edits for the hosted Pages site to reflect them.