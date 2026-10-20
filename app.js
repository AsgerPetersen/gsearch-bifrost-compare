"use strict";

const DEFAULTS = {
  bfUrl: "https://bifrost.test42.dataforsyningen.dk",
  // Public default token bundled with the Geosearch DK QGIS plugin.
  gsToken: "0350b5341749c0970454474881173412",
};
const GS_URL = "https://api.dataforsyningen.dk/rest/gsearch/v2.0/";
const PLUGIN_MAX_TOTAL = 40;
const PLUGIN_VISIBLE_ROWS = 15;
const DEBOUNCE_MS = 500;

// Order matches the plugin's display order; `plugin: true` are the types the plugin offers today.
const TYPES = [
  { key: "adr", gs: "husnummer", title: "Husnumre", plugin: true, bf: { ep: "resolve" } },
  { key: "ste", gs: "stednavn", title: "Stednavne", plugin: true, bf: { ep: "search", target: "stednavn" } },
  { key: "pos", gs: "postnummer", title: "Postdistrikter", plugin: true, bf: { ep: "search", target: "postcode" } },
  { key: "mat", gs: "matrikel", title: "Matrikelnumre", plugin: true, bf: { ep: "search", target: "ejendom" } },
  { key: "kom", gs: "kommune", title: "Kommuner", plugin: true, bf: { ep: "search", target: "kommune" } },
  { key: "ops", gs: "opstillingskreds", title: "Opstillingskredse", plugin: true, bf: { ep: "search", target: "opstillingskreds" } },
  { key: "pol", gs: "politikreds", title: "Politikredse", plugin: true, bf: { ep: "search", target: "politikreds" } },
  { key: "reg", gs: "region", title: "Regioner", plugin: true, bf: { ep: "search", target: "region" } },
  { key: "enh", gs: "adresse", title: "Adresser (enhed)", bf: { ep: "resolve" } },
  { key: "vej", gs: "navngivenvej", title: "Navngivne veje", bf: { ep: "search", target: "street" } },
  { key: "sog", gs: "sogn", title: "Sogne", bf: { ep: "search", target: "sogn" } },
  { key: "ret", gs: "retskreds", title: "Retskredse", bf: { ep: "search", target: "retskreds" } },
  { key: "udg", gs: "matrikel_udgaaet", title: "Udgåede matrikler", bf: { ep: "search", target: "ejendom", lifecycle: ["retired"] } },
];
const TYPE_BY_KEY = Object.fromEntries(TYPES.map((t) => [t.key, t]));

const CASES = [
  "skodsb",
  "skodsborgvej 41",
  "skodsborgvej 414",
  "nøddebogade 1 st th",
  "nørrebrog 1",
  "rådhuspl",
  "ste: rådhuspladsen",
  "ste: vendsyssel",
  "ste: skodsborg",
  "mat: 3kg søll",
  "mat: 3kg",
  "pos: 80",
  "pos: aar",
  "kom: køb",
  "ops: aar",
  "udg: 1an gentofte",
];

// ---------- settings ----------
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { return localStorage.getItem("gbc." + k); },
  set(k, v) { localStorage.setItem("gbc." + k, v); },
  del(k) { localStorage.removeItem("gbc." + k); },
};

function initSettings() {
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
    scheduleSearch(0);
  };
  ["bfKey", "bfUrl", "gsToken"].forEach((id) => $(id).addEventListener("change", persist));
  $("remember").addEventListener("change", persist);
}

const cfg = () => ({
  bfKey: $("bfKey").value.trim(),
  bfUrl: ($("bfUrl").value.trim() || DEFAULTS.bfUrl).replace(/\/+$/, ""),
  gsToken: $("gsToken").value.trim() || DEFAULTS.gsToken,
});

// ---------- type selection & URL state ----------
function initTypes(selected) {
  const box = $("types");
  const group = (label, list) => {
    const g = document.createElement("fieldset");
    g.innerHTML = `<legend>${label}</legend>`;
    list.forEach((t) => {
      const l = document.createElement("label");
      l.title = `GSearch: ${t.gs} · Bifrost: ${t.bf.ep}${t.bf.target ? " → " + t.bf.target : ""} · præfiks ${t.key}:`;
      l.innerHTML = `<input type="checkbox" value="${t.key}"> ${t.title}`;
      l.querySelector("input").checked = selected.includes(t.key);
      l.querySelector("input").addEventListener("change", () => scheduleSearch(0));
      g.appendChild(l);
    });
    box.appendChild(g);
  };
  group("Typer i pluginet", TYPES.filter((t) => t.plugin));
  group("Øvrige GSearch-typer", TYPES.filter((t) => !t.plugin));
}

const selectedKeys = () =>
  [...document.querySelectorAll("#types input:checked")].map((i) => i.value);

function writeUrl(q) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  p.set("t", selectedKeys().join(","));
  history.replaceState(null, "", "?" + p.toString());
}

// Mirrors GSearchFetcher.geturls(): "xxx: term" restricts to one type.
function parseInput(raw) {
  let keys = selectedKeys();
  let term = raw;
  const split = raw.split(":");
  if (split.length > 1) {
    const k = split[0].slice(0, 3).toLowerCase();
    if (TYPE_BY_KEY[k]) {
      keys = [k];
      term = split[1].replace(/^\s+/, "");
    }
  }
  keys = TYPES.map((t) => t.key).filter((k) => keys.includes(k));
  return { keys, term };
}

// ---------- search ----------
let seq = 0;
let timer = null;

function scheduleSearch(delay = DEBOUNCE_MS) {
  clearTimeout(timer);
  timer = setTimeout(runSearch, delay);
}

async function runSearch() {
  const raw = $("q").value;
  writeUrl(raw);
  const { keys, term } = parseInput(raw);
  const my = ++seq;
  if (!term.trim() || keys.length === 0) {
    renderList("gs", [], "");
    renderList("bf", [], "");
    return;
  }
  const limit = Math.floor(PLUGIN_MAX_TOTAL / keys.length);
  $("gsMeta").textContent = "søger…";
  $("bfMeta").textContent = "søger…";
  searchGSearch(keys, term, limit).then((r) => my === seq && renderList("gs", r.rows, r.meta));
  searchBifrost(keys, term, limit).then((r) => my === seq && renderList("bf", r.rows, r.meta));
}

async function timed(promise) {
  const t0 = performance.now();
  const v = await promise;
  return [v, Math.round(performance.now() - t0)];
}

async function searchGSearch(keys, term, limit) {
  const { gsToken } = cfg();
  const [parts, ms] = await timed(
    Promise.all(
      keys.map(async (k) => {
        const t = TYPE_BY_KEY[k];
        const url = GS_URL + t.gs + "?" + new URLSearchParams({ token: gsToken, q: term, limit });
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
          const data = await r.json();
          return data.map((row) => ({ src: "gs", type: t, row, text: row.visningstekst }));
        } catch (e) {
          return [{ src: "gs", type: t, error: `${t.title} - Der skete en fejl (${e.message})` }];
        }
      })
    )
  );
  const rows = parts.flat();
  return { rows, meta: `${rows.filter((r) => !r.error).length} resultater · ${ms} ms · limit ${limit}/type` };
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

async function searchBifrost(keys, term, limit) {
  if (!cfg().bfKey) {
    return { rows: [{ src: "bf", error: "Indtast en Bifrost API-nøgle under “Indstillinger og nøgler”." }], meta: "" };
  }
  const types = keys.map((k) => TYPE_BY_KEY[k]);
  const addrTypes = types.filter((t) => t.bf.ep === "resolve");
  const searchTypes = types.filter((t) => t.bf.ep === "search");
  const resolveLimit = Math.min(20, limit * addrTypes.length);
  const notes = [];
  if (addrTypes.length && limit * addrTypes.length > 20) notes.push("resolve maks. 20");

  const jobs = [];
  if (addrTypes.length) {
    jobs.push(
      bifrost("resolve", { input: term, limit: resolveLimit })
        .then((d) => ({ resolve: d.matches }))
        .catch((e) => ({ resolveError: e.message }))
    );
  }
  if (searchTypes.length) {
    const batch = searchTypes.map((t) => {
      const b = { input: term, target: t.bf.target, limit };
      if (t.bf.lifecycle) b.lifecycle = t.bf.lifecycle;
      return b;
    });
    jobs.push(
      bifrost("search", batch)
        .then((d) => ({ search: d.map((x) => x.matches) }))
        .catch((e) => ({ searchError: e.message }))
    );
  }
  const [results, ms] = await timed(Promise.all(jobs));
  const res = Object.assign({}, ...results);

  const rows = [];
  let resolveDone = false;
  types.forEach((t) => {
    if (t.bf.ep === "resolve") {
      if (resolveDone) return;
      resolveDone = true;
      if (res.resolveError) rows.push({ src: "bf", type: t, error: `Adresser - Der skete en fejl (${res.resolveError})` });
      else res.resolve.forEach((m) => rows.push(bfRow(t, m, "resolve")));
    } else {
      const i = searchTypes.indexOf(t);
      if (res.searchError) {
        if (i === 0) rows.push({ src: "bf", type: t, error: `Søgning - Der skete en fejl (${res.searchError})` });
      } else {
        res.search[i].forEach((m) => rows.push(bfRow(t, m, "search")));
      }
    }
  });
  const ok = rows.filter((r) => !r.error).length;
  return { rows, meta: `${ok} resultater · ${ms} ms · limit ${limit}/type${notes.length ? " · " + notes.join(", ") : ""}` };
}

function bfRow(type, m, ep) {
  return { src: "bf", type, ep, row: m, text: m.result, label: bfLabel(m) };
}

// ---------- Bifrost labels the plugin could construct ----------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const kommuneTxt = (c) =>
  (c.kommuner || []).map((k) => k.kommune + " Kommune").join(", ");
const postTxt = (c) => (c.postcodes || []).map((p) => `${p.postcode} ${p.city}`).join(", ");

function bfLabel(m) {
  const c = m.components || {};
  switch (m.ref.kind) {
    case "stednavn": {
      const where = kommuneTxt(c);
      return `${m.result} (${cap(c.type || "?")}${where ? " i " + where : ""})`;
    }
    case "postcode":
      return postTxt(c) || m.result;
    case "city":
      return `${m.result} (by, ${postTxt(c)})`;
    case "street":
      return `${m.result} (${postTxt(c)})`;
    case "kommune":
      return `${m.result} Kommune`;
    case "sogn":
      return `${m.result} sogn`;
    case "politikreds":
      return m.result.replace(/ Politi$/, " Politikreds");
    case "opstillingskreds":
      return `${m.result}kredsen`;
    default:
      return m.result;
  }
}

// ---------- rendering ----------
function renderList(src, rows, meta) {
  $(src + "Meta").textContent = meta;
  const ol = $(src + "List");
  ol.innerHTML = "";
  rows.forEach((r, i) => {
    const li = document.createElement("li");
    if (i === PLUGIN_VISIBLE_ROWS) li.classList.add("fold");
    if (r.error) {
      li.className += " error";
      li.textContent = r.error;
      ol.appendChild(li);
      return;
    }
    const main = document.createElement("div");
    main.className = "text";
    main.textContent = r.text;
    li.appendChild(main);

    const sub = document.createElement("div");
    sub.className = "sub";
    const tags = [];
    if (src === "gs") {
      tags.push(r.type.gs);
      if (r.row.stednavn_subtype) tags.push(`${r.row.stednavn_type}/${r.row.stednavn_subtype}`);
    } else {
      if (r.label && r.label !== r.text) {
        const lab = document.createElement("span");
        lab.className = "label";
        lab.textContent = r.label;
        sub.appendChild(lab);
      }
      tags.push(r.ep === "resolve" ? `resolve → ${r.row.ref.kind}` : r.row.ref.kind);
      if (r.row.components && r.row.components.type) tags.push(r.row.components.type);
      if (r.row.lifecycle && r.row.lifecycle !== "current") tags.push(r.row.lifecycle);
      tags.push(`conf ${r.row.meta.confidence}`, `score ${(+r.row.meta.score).toFixed(2)}`);
    }
    tags.forEach((t) => {
      const s = document.createElement("span");
      s.className = "tag";
      s.textContent = t;
      sub.appendChild(s);
    });
    li.appendChild(sub);
    li.tabIndex = 0;
    const pick = () => select(src, r, li);
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => e.key === "Enter" && pick());
    ol.appendChild(li);
  });
}

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
  // The plugin zooms to the geometry buffered by 200 m.
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

async function select(src, r, li) {
  document.querySelectorAll(`#${src}List li.selected`).forEach((e) => e.classList.remove("selected"));
  li.classList.add("selected");
  const detail = $("detail");
  if (src === "gs") {
    show("gs", r.row.geometri);
    detail.textContent = "GSearch " + r.type.gs + "\n" + stripCoords(r.row);
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

// ---------- boot ----------
function init() {
  const params = new URLSearchParams(location.search);
  const t = params.get("t");
  const selected = t !== null ? t.split(",").filter((k) => TYPE_BY_KEY[k]) : TYPES.filter((x) => x.plugin).map((x) => x.key);
  initSettings();
  initTypes(selected);
  initMap();

  const casesBox = $("cases");
  CASES.forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = c;
    b.addEventListener("click", () => {
      $("q").value = c;
      scheduleSearch(0);
    });
    casesBox.appendChild(b);
  });

  const q = $("q");
  q.value = params.get("q") || "";
  q.addEventListener("input", () => scheduleSearch());
  q.addEventListener("keydown", (e) => e.key === "Enter" && scheduleSearch(0));
  if (q.value) scheduleSearch(0);
}

init();
