# GSearch vs. Bifrost

A static web page that shows search results from
[GSearch](https://docs.dataforsyningen.dk/) and
[Bifrost](https://bifrost.test42.dataforsyningen.dk/docs/da/) side by side, the way the
QGIS plugin [Geosearch DK](https://github.com/AsgerPetersen/qgis-geosearch) would show them.

It was built while investigating the plugin's migration from GSearch (closing November 2026) to
Bifrost.

**Live:** https://asgerpetersen.github.io/gsearch-bifrost-compare/

## Usage

1. Open the page and enter your Bifrost API key under *Indstillinger og nøgler*.
   - The key is only sent to the Bifrost URL.
   - It is only stored in the browser's `localStorage` if you tick *Husk i browseren*.
   - GSearch uses the plugin's public default token unless you enter your own.
2. Type as you would in the plugin. Requests are debounced 500 ms, like in the plugin.
3. Pick result types, or use the plugin's prefix syntax: `adr:`, `ste:`, `pos:`, `mat:`, `kom:`,
   `ops:`, `pol:` and `reg:`. These prefixes are also available here:

   | Prefix | Type |
   |---|---|
   | `enh:` | adresse |
   | `vej:` | navngivenvej |
   | `sog:` | sogn |
   | `ret:` | retskreds |
   | `udg:` | matrikel_udgaaet |

4. Click a result to show it on the map.
   - Red is GSearch and blue is Bifrost.
   - Bifrost geometry is fetched on click: via `/project` for most kinds, or by re-searching with `geometry: true` for stednavne.
5. Share a search by copying the URL (`?q=…&t=…`). Keys are never put in the URL.

## What is shown

- **GSearch:** `visningstekst`, which is exactly what plugin users see today.
  - One request per type with `limit = 40 / number of types`, concatenated in type order.
- **Bifrost:** `result` in bold.
  - Below it, in italics, is a label the plugin *could* build from `components`, followed by `ref.kind`, confidence and score.

How each type is queried in Bifrost:

| Plugin type | GSearch resource | Bifrost |
|---|---|---|
| Husnumre (`adr`) | husnummer | `/resolve` (max 20, all kinds) |
| Adresser (`enh`) | adresse | `/resolve` (shared with `adr`) |
| Stednavne (`ste`) | stednavn | `/search` target `stednavn` |
| Postdistrikter (`pos`) | postnummer | `/search` target `postcode` |
| Matrikelnumre (`mat`) | matrikel | `/search` target `ejendom` |
| Kommuner (`kom`) | kommune | `/search` target `kommune` |
| Opstillingskredse (`ops`) | opstillingskreds | `/search` target `opstillingskreds` |
| Politikredse (`pol`) | politikreds | `/search` target `politikreds` |
| Regioner (`reg`) | region | `/search` target `region` |
| Navngivne veje (`vej`) | navngivenvej | `/search` target `street` |
| Sogne (`sog`) | sogn | `/search` target `sogn` |
| Retskredse (`ret`) | retskreds | `/search` target `retskreds` |
| Udgåede matrikler (`udg`) | matrikel_udgaaet | `/search` target `ejendom`, `lifecycle: ["retired"]` |

All `/search` targets are sent in a single batch request.

## Development

The page is plain HTML, CSS and JavaScript with no build step. It uses Leaflet and proj4 from a CDN.

```sh
python3 -m http.server 8000
```

GitHub Pages publishes the `main` branch root.
