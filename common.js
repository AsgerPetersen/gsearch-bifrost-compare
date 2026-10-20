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

async function gsearch(resource, term, limit) {
  const url = GS_URL + resource + "?" + new URLSearchParams({ token: cfg().gsToken, q: term, limit });
  const r = await fetch(url);
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

// ---------- search-as-you-type ----------
function debouncer(fn, ms) {
  let timer = null;
  return (delay = ms) => {
    clearTimeout(timer);
    timer = setTimeout(fn, delay);
  };
}

function initCases(cases, onPick) {
  const box = $("cases");
  cases.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c;
    b.addEventListener("click", () => {
      $("q").value = c;
      onPick();
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
