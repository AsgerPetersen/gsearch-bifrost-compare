"use strict";
// Plugin perspective: mimics what Geosearch DK shows in its dropdown.

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
  "skodsb", "skodsborgvej 41", "skodsborgvej 414", "nøddebogade 1 st th", "nørrebrog 1", "rådhuspl",
  "ste: rådhuspladsen", "ste: vendsyssel", "ste: skodsborg", "mat: 3kg søll", "mat: 3kg",
  "pos: 80", "pos: aar", "kom: køb", "ops: aar", "udg: 1an gentofte",
];

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

const selectedKeys = () => [...document.querySelectorAll("#types input:checked")].map((i) => i.value);

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
const scheduleSearch = debouncer(runSearch, DEBOUNCE_MS);

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

async function searchGSearch(keys, term, limit) {
  const [parts, ms] = await timed(
    Promise.all(
      keys.map(async (k) => {
        const t = TYPE_BY_KEY[k];
        try {
          const data = await gsearch(t.gs, term, limit);
          return data.map((row) => ({ type: t, resource: t.gs, row, text: row.visningstekst }));
        } catch (e) {
          return [{ type: t, error: `${t.title} - Der skete en fejl (${e.message})` }];
        }
      })
    )
  );
  const rows = parts.flat();
  return { rows, meta: `${rows.filter((r) => !r.error).length} resultater · ${ms} ms · limit ${limit}/type` };
}

async function searchBifrost(keys, term, limit) {
  if (!cfg().bfKey) return { rows: [{ error: NO_KEY }], meta: "" };
  const types = keys.map((k) => TYPE_BY_KEY[k]);
  const addrTypes = types.filter((t) => t.bf.ep === "resolve");
  const searchTypes = types.filter((t) => t.bf.ep === "search");
  const notes = [];
  if (addrTypes.length && limit * addrTypes.length > 20) notes.push("resolve maks. 20");

  const jobs = [];
  if (addrTypes.length) {
    jobs.push(
      bifrost("resolve", { input: term, limit: Math.min(20, limit * addrTypes.length) })
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
      if (res.resolveError) rows.push({ error: `Adresser - Der skete en fejl (${res.resolveError})` });
      else res.resolve.forEach((m) => rows.push(bfRow(m, "resolve")));
    } else {
      const i = searchTypes.indexOf(t);
      if (res.searchError) {
        if (i === 0) rows.push({ error: `Søgning - Der skete en fejl (${res.searchError})` });
      } else {
        res.search[i].forEach((m) => rows.push(bfRow(m, "search")));
      }
    }
  });
  const ok = rows.filter((r) => !r.error).length;
  return { rows, meta: `${ok} resultater · ${ms} ms · limit ${limit}/type${notes.length ? " · " + notes.join(", ") : ""}` };
}

const bfRow = (m, ep) => ({ ep, row: m, text: m.result, label: bfLabel(m) });

// ---------- Bifrost labels the plugin could construct ----------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const kommuneTxt = (c) => (c.kommuner || []).map((k) => k.kommune + " Kommune").join(", ");
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
    let li;
    if (r.error) {
      li = makeNote(r.error, "error");
    } else if (src === "gs") {
      li = makeItem("gs", r, [r.type.gs, ...gsTags(r.row)]);
    } else {
      const kind = r.ep === "resolve" ? `resolve → ${r.row.ref.kind}` : r.row.ref.kind;
      li = makeItem("bf", r, [kind, ...bfTags(r.row)], r.label);
    }
    if (i === PLUGIN_VISIBLE_ROWS) li.classList.add("fold");
    ol.appendChild(li);
  });
}

// ---------- boot ----------
function init() {
  const params = new URLSearchParams(location.search);
  const t = params.get("t");
  const selected = t !== null ? t.split(",").filter((k) => TYPE_BY_KEY[k]) : TYPES.filter((x) => x.plugin).map((x) => x.key);
  initSettings(() => scheduleSearch(0));
  initTypes(selected);
  initMap();
  initCases(CASES, () => scheduleSearch(0));

  const q = $("q");
  q.value = params.get("q") || "";
  q.addEventListener("input", () => scheduleSearch());
  q.addEventListener("keydown", (e) => e.key === "Enter" && scheduleSearch(0));
  if (q.value) scheduleSearch(0);
}

init();
