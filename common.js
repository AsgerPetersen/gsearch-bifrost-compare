"use strict";
// Shared by index.html (plugin perspective) and direct.html (direct comparison).

const DEFAULTS = {
  bfUrl: "https://bifrost.test42.dataforsyningen.dk",
  // Public default token bundled with the Geosearch DK QGIS plugin.
  gsToken: "0350b5341749c0970454474881173412",
};
const GS_URL = "https://api.dataforsyningen.dk/rest/gsearch/v2.0/";

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { return localStorage.getItem("gbc." + k); },
  set(k, v) { localStorage.setItem("gbc." + k, v); },
  del(k) { localStorage.removeItem("gbc." + k); },
};

function initSettings(onChange) {
  const remember = store.get("remember") === "1";
  $("remember").checked = remember;
  $("bfKey").value = (remember && store.get("bfKey")) || "";
  $("bfUrl").value = store.get("bfUrl") || DEFAULTS.bfUrl;
  $("gsToken").value = store.get("gsToken") || DEFAULTS.gsToken;
  if (!$("bfKey").value) $("settings").open = true;

  const persist = () => {
    const r = $("remember").checked;
    store.set("remember", r ? "1" : "0");
    if (r) store.set("bfKey", $("bfKey").value.trim());
    else store.del("bfKey");
    store.set("bfUrl", $("bfUrl").value.trim());
    store.set("gsToken", $("gsToken").value.trim());
    kommuneRefCache.clear();
    memberCache.clear();
    onChange();
  };
  ["bfKey", "bfUrl", "gsToken"].forEach((id) => $(id).addEventListener("change", persist));
  $("remember").addEventListener("change", persist);
}

const cfg = () => ({
  bfKey: $("bfKey").value.trim(),
  bfUrl: ($("bfUrl").value.trim() || DEFAULTS.bfUrl).replace(/\/+$/, ""),
  gsToken: $("gsToken").value.trim() || DEFAULTS.gsToken,
});

async function timed(promise) {
  const t0 = performance.now();
  const v = await promise;
  return [v, Math.round(performance.now() - t0)];
}

async function gsearch(resource, term, limit, codes = []) {
  const p = new URLSearchParams({ token: cfg().gsToken, q: term, limit });
  if (codes.length) p.set("filter", gsKommuneFilter(codes));
  const r = await fetch(GS_URL + resource + "?" + p);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function bifrost(ep, body) {
  const { bfKey, bfUrl } = cfg();
  const r = await fetch(`${bfUrl}/${ep}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + bfKey },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const NO_KEY = "Indtast en Bifrost API-nøgle under “Indstillinger og nøgler”.";

// ---------- kommune filter ----------
// GSearch filters server-side. Bifrost /search has no filter, so we over-fetch and filter in the browser.
const BF_OVERFETCH = 100;
// Kinds whose components lack `kommuner`; filtered against /project kommune → target instead.
const BF_PROJECT_TARGETS = new Set(["city", "ejerlav", "region", "retskreds", "politikreds", "opstillingskreds"]);

const KOMMUNE_INFO = `
  <p><b>GSearch</b> filtrerer på serveren med parameteren <code>filter</code> (CQL), præcis som pluginets
  indstilling “Søg kun i listede kommuner”: <code>kommunekode like '%0230%'</code>, flere koder forbundet med
  <code>or</code>. Det virker for alle 13 ressourcer og sker før <code>limit</code>. For postnummer, sogn, region,
  retskreds, politikreds og opstillingskreds er <code>kommunekode</code> en kommasepareret liste over de kommuner,
  området dækker.</p>
  <p><b>Bifrost</b> har intet filter på <code>/search</code>. Siden henter derfor ${BF_OVERFETCH} hits pr. type og
  filtrerer i browseren. Relevante hits uden for de ${BF_OVERFETCH} bedste går tabt.</p>
  <ul>
    <li>Vej, postnummer, matrikel, stednavn, kommune og sogn: <code>components.kommuner</code>.
      For stednavne er det kun kommunen ved stednavnets punkt.</li>
    <li>By, ejerlav, region, retskreds, politikreds og opstillingskreds har ikke <code>kommuner</code> i
      <code>components</code>. De filtreres mod de refs, <code>/project</code> giver fra kommunen til typen.</li>
    <li>Adresse og husnummer (<code>/resolve</code>): kommunen pinnes som <code>components.kommune</code>,
      én forespørgsel pr. kode i en batch. Ifølge dokumentationen påvirker pinning kun rangeringen,
      så resultaterne tjekkes også mod <code>components.kommuner</code>.</li>
  </ul>`;

let kommuneInput;

// Builds the "Kommunekoder" input with an (i) explanation inside `container`.
function initKommuneFilter(container, initial, onChange) {
  const wrap = document.createElement("span");
  wrap.className = "kfilter";
  wrap.innerHTML = `
    <label for="kommuner">Kommunekoder</label>
    <input id="kommuner" type="text" placeholder="fx 230,101" autocomplete="off" spellcheck="false">
    <details class="info"><summary title="Sådan virker kommunefilteret" aria-label="Sådan virker kommunefilteret">i</summary>
      <div class="infobox">${KOMMUNE_INFO}</div></details>`;
  container.appendChild(wrap);
  const info = wrap.querySelector("details.info");
  document.addEventListener("click", (e) => info.open && !info.contains(e.target) && (info.open = false));
  kommuneInput = wrap.querySelector("input");
  kommuneInput.value = initial || "";
  validateKommuner();
  kommuneInput.addEventListener("input", () => {
    validateKommuner();
    onChange();
  });
}

const validateKommuner = () => kommuneInput.classList.toggle("invalid", !kommuneValid(kommuneInput.value));

function setKommuner(v) {
  kommuneInput.value = v || "";
  validateKommuner();
}

const kommuneValid = (raw) => /^\s*(\d{3,4}(\s*[,; ]\s*\d{3,4})*)?\s*$/.test(raw);

// Like the plugin: 3-digit codes are accepted; padded to 4 digits as both services use.
function kommuneCodes() {
  if (!kommuneInput) return [];
  const codes = (kommuneInput.value.match(/\d+/g) || []).filter((c) => c.length >= 3 && c.length <= 4);
  return [...new Set(codes.map((c) => c.padStart(4, "0")))];
}

const gsKommuneFilter = (codes) => codes.map((c) => `kommunekode like '%${c}%'`).join(" or ");

const kommuneRefCache = new Map();
const memberCache = new Map();

function cached(cache, key, fn) {
  if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; }));
  return cache.get(key);
}

function kommuneRef(code) {
  return cached(kommuneRefCache, code, async () => {
    const d = await bifrost("search", { input: code, target: "kommune", limit: 1 });
    const m = d.matches[0];
    const ok = m && (m.components.kommuner || []).some((k) => k.kommunekode === code);
    if (!ok) throw new Error(`Ukendt kommunekode ${code}`);
    return m.ref;
  });
}

// All ref ids of `target` inside kommune `code`, via /project (paginated).
function kommuneMembers(code, target) {
  return cached(memberCache, code + ":" + target, async () => {
    const input = await kommuneRef(code);
    const ids = new Set();
    let cursor = null;
    for (let page = 0; page < 10; page++) {
      const body = { input, target, limit: 500 };
      if (cursor) body.cursor = cursor;
      const d = await bifrost("project", body);
      d.matches.forEach((m) => ids.add(m.ref.id));
      if (!d.next) break;
      cursor = d.next;
    }
    return ids;
  });
}

// Returns a predicate telling whether a Bifrost match lies in one of `codes`.
async function bfKommunePredicate(target, codes) {
  await Promise.all(codes.map(kommuneRef)); // fails on unknown codes
  if (BF_PROJECT_TARGETS.has(target)) {
    const sets = await Promise.all(codes.map((c) => kommuneMembers(c, target)));
    return (m) => sets.some((s) => s.has(m.ref.id));
  }
  return (m) => ((m.components && m.components.kommuner) || []).some((k) => codes.includes(k.kommunekode));
}

// /resolve, with the kommune pinned per code (as a batch) when filtering.
async function bfResolve(term, limit, codes) {
  if (!codes.length) return (await bifrost("resolve", { input: term, limit })).matches;
  const res = await bifrost("resolve", codes.map((kommune) => ({ input: term, components: { kommune }, limit })));
  res.forEach((r) => { if (r.error) throw new Error(JSON.stringify(r.error).slice(0, 300)); });
  const seen = new Set();
  const pred = await bfKommunePredicate("unit", codes);
  return res
    .flatMap((r) => r.matches)
    .filter((m) => pred(m) && !seen.has(m.ref.kind + m.ref.id) && seen.add(m.ref.kind + m.ref.id))
    .sort((a, b) => b.meta.score - a.meta.score)
    .slice(0, limit);
}

// ---------- search-as-you-type ----------
function debouncer(fn, ms) {
  let timer = null;
  return (delay = ms) => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}

// A case is either a search string or a preset { q, hint?, title?, ... } passed on to onPick.
function initCases(cases, onPick) {
  const box = $("cases");
  cases.forEach((c) => {
    const ex = typeof c === "string" ? { q: c } : c;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = ex.q;
    if (ex.hint) {
      const h = document.createElement("small");
      h.textContent = ex.hint;
      b.appendChild(h);
    }
    if (ex.title) b.title = ex.title;
    b.addEventListener("click", () => {
      $("q").value = ex.q;
      onPick(ex);
    });
    box.appendChild(b);
  });
}

// ---------- result rows ----------
function addTags(parent, tags) {
  tags.filter(Boolean).forEach((t) => {
    const s = document.createElement("span");
    s.className = "tag";
    s.textContent = t;
    parent.appendChild(s);
  });
}

function makeItem(src, r, tags, label) {
  const li = document.createElement("li");
  li.classList.add(src);
  const main = document.createElement("div");
  main.className = "text";
  main.textContent = r.text;
  li.appendChild(main);
  const sub = document.createElement("div");
  sub.className = "sub";
  if (label && label !== r.text) {
    const lab = document.createElement("span");
    lab.className = "label";
    lab.textContent = label;
    sub.appendChild(lab);
  }
  addTags(sub, tags);
  li.appendChild(sub);
  li.tabIndex = 0;
  const pick = () => select(src, r, li);
  li.addEventListener("click", pick);
  li.addEventListener("keydown", (e) => e.key === "Enter" && pick());
  return li;
}

function makeNote(text, cls) {
  const li = document.createElement("li");
  li.className = cls;
  li.textContent = text;
  return li;
}

const gsTags = (row) => [row.stednavn_subtype && `${row.stednavn_type}/${row.stednavn_subtype}`];

const bfTags = (m) => [
  m.components && m.components.type,
  m.lifecycle && m.lifecycle !== "current" && m.lifecycle,
  `conf ${m.meta.confidence}`,
  `score ${(+m.meta.score).toFixed(2)}`,
];

// ---------- map ----------
proj4.defs("EPSG:25832", "+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs");
const toWgs = proj4("EPSG:25832", "EPSG:4326");
let map, layers;

function initMap() {
  map = L.map("map").setView([56.0, 10.5], 6);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  layers = { gs: L.featureGroup().addTo(map), bf: L.featureGroup().addTo(map) };
}

function reproject(coords) {
  return typeof coords[0] === "number" ? toWgs.forward(coords.slice(0, 2)) : coords.map(reproject);
}

function show(src, geojson) {
  const color = src === "gs" ? "#d62728" : "#1f77b4";
  layers[src].clearLayers();
  if (!geojson) return;
  const g = { ...geojson, coordinates: reproject(geojson.coordinates) };
  L.geoJSON(g, {
    style: { color, weight: 3, fillOpacity: 0.12 },
    pointToLayer: (_f, ll) => L.circleMarker(ll, { radius: 7, color, weight: 3, fillOpacity: 0.5 }),
  }).addTo(layers[src]);
  // Zoom to the geometry buffered by 200 m, like the plugin.
  const b = layers[src].getBounds();
  const pad = 200 / 111320;
  map.fitBounds(L.latLngBounds([b.getSouth() - pad, b.getWest() - pad * 1.8], [b.getNorth() + pad, b.getEast() + pad * 1.8]));
}

const geomCache = new Map();

async function bifrostGeometry(m) {
  const id = m.ref.kind + ":" + m.ref.id;
  if (geomCache.has(id)) return geomCache.get(id);
  let g;
  if (m.ref.kind === "stednavn") {
    // /project does not support stednavn; re-search with geometry and pick the same ref.
    const d = await bifrost("search", { input: m.result, target: "stednavn", limit: 100, geometry: true });
    const hit = d.matches.find((x) => x.ref.id === m.ref.id);
    g = hit && hit.geometry;
  } else {
    const body = { input: m.ref, target: m.ref.kind, geometry: true, limit: 1 };
    if (m.lifecycle) body.lifecycle = [m.lifecycle];
    const d = await bifrost("project", body);
    g = d.matches[0] && d.matches[0].geometry;
  }
  const gj = g ? g.geojson : null;
  geomCache.set(id, gj);
  return gj;
}

function stripCoords(obj) {
  return JSON.stringify(
    obj,
    (k, v) => (k === "coordinates" && Array.isArray(v) && Array.isArray(v[0]) ? "[…]" : v),
    2
  );
}

// r: { text, row, resource } for GSearch; { text, row, ep } for Bifrost.
async function select(src, r, li) {
  document.querySelectorAll(`li.selected.${src}`).forEach((e) => e.classList.remove("selected"));
  li.classList.add("selected");
  const detail = $("detail");
  if (src === "gs") {
    show("gs", r.row.geometri);
    detail.textContent = "GSearch " + r.resource + "\n" + stripCoords(r.row);
    return;
  }
  const m = r.row;
  show("bf", m.point);
  detail.textContent = "Bifrost " + r.ep + "\n" + stripCoords(m);
  try {
    const t0 = performance.now();
    const gj = await bifrostGeometry(m);
    if (!li.classList.contains("selected")) return;
    if (gj) show("bf", gj);
    detail.textContent =
      `Bifrost ${r.ep} · geometri ${gj ? gj.type : "ingen"} hentet på ${Math.round(performance.now() - t0)} ms\n` +
      stripCoords(m);
  } catch (e) {
    detail.textContent = `Bifrost geometri fejlede: ${e.message}\n` + stripCoords(m);
  }
}
