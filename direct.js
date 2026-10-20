"use strict";
// Direct comparison: every type either service supports, one section per type.

const DEBOUNCE_MS = 400;
const DEFAULT_LIMIT = 10;
const RESOLVE_MAX = 20;

// gs: GSearch resource (null = not available). bf: Bifrost endpoint/target (null = not available).
// Bifrost /resolve has no type filter, so its matches are split by ref.kind.
const DTYPES = [
  { key: "adresse", title: "Adresse", gs: "adresse", bf: { ep: "resolve", kind: "unit" } },
  { key: "husnummer", title: "Husnummer", gs: "husnummer", bf: { ep: "resolve", kind: "entrance" } },
  { key: "navngivenvej", title: "Navngiven vej", gs: "navngivenvej", bf: { ep: "search", target: "street" } },
  { key: "postnummer", title: "Postnummer", gs: "postnummer", bf: { ep: "search", target: "postcode" } },
  { key: "by", title: "By (postdistriktsnavn)", gs: null, bf: { ep: "search", target: "city" } },
  { key: "matrikel", title: "Matrikel", gs: "matrikel", bf: { ep: "search", target: "ejendom" } },
  { key: "matrikel_udgaaet", title: "Udgået matrikel", gs: "matrikel_udgaaet", bf: { ep: "search", target: "ejendom", lifecycle: ["retired"] } },
  { key: "ejerlav", title: "Ejerlav", gs: null, bf: { ep: "search", target: "ejerlav" } },
  { key: "stednavn", title: "Stednavn", gs: "stednavn", bf: { ep: "search", target: "stednavn" } },
  { key: "kommune", title: "Kommune", gs: "kommune", bf: { ep: "search", target: "kommune" } },
  { key: "sogn", title: "Sogn", gs: "sogn", bf: { ep: "search", target: "sogn" } },
  { key: "region", title: "Region", gs: "region", bf: { ep: "search", target: "region" } },
  { key: "retskreds", title: "Retskreds", gs: "retskreds", bf: { ep: "search", target: "retskreds" } },
  { key: "politikreds", title: "Politikreds", gs: "politikreds", bf: { ep: "search", target: "politikreds" } },
  { key: "opstillingskreds", title: "Opstillingskreds", gs: "opstillingskreds", bf: { ep: "search", target: "opstillingskreds" } },
];
const DTYPE_BY_KEY = Object.fromEntries(DTYPES.map((t) => [t.key, t]));

// Presets: q = search text, t = types (omitted = all), k = kommunekoder, n = max per type (omitted = unchanged).
const CASES = [
  { q: "skodsb" },
  { q: "skodsborgvej 414", t: ["adresse", "husnummer", "navngivenvej"] },
  { q: "nøddebogade 1 st th", t: ["adresse", "husnummer"] },
  { q: "nørrebrog 1", t: ["adresse", "husnummer", "navngivenvej"] },
  { q: "vestergade 1", t: ["adresse", "husnummer"], k: "101" },
  { q: "Vangebovej 71", t: ["husnummer"] },
  { q: "rådhuspl" },
  { q: "rådhuspladsen", t: ["stednavn", "navngivenvej"] },
  { q: "vendsyssel", t: ["stednavn"] },
  { q: "skodsborg", t: ["stednavn", "by", "postnummer"] },
  { q: "vor frue", t: ["stednavn", "sogn"], k: "101,851" },
  { q: "3kg søll", t: ["matrikel"] },
  { q: "3kg", t: ["matrikel"] },
  { q: "1a", t: ["matrikel"], k: "615" },
  { q: "1an gentofte", t: ["matrikel_udgaaet"] },
  { q: "80", t: ["postnummer", "by"] },
  { q: "aar", t: ["postnummer", "by", "kommune", "sogn", "opstillingskreds"] },
  { q: "køb", t: ["kommune", "postnummer", "by"] },
  { q: "lyngby", t: ["by", "postnummer", "sogn", "retskreds", "politikreds", "opstillingskreds"], k: "230,173" },
].map(describeCase);

function describeCase(c) {
  const titles = (c.t || []).map((k) => DTYPE_BY_KEY[k].title);
  const hint = [titles.length === 1 ? titles[0] : titles.length ? `${titles.length} typer` : "", c.k && `kommune ${c.k}`]
    .filter(Boolean)
    .join(" · ");
  const title = [`Typer: ${titles.length ? titles.join(", ") : "alle"}`, c.k && `Kommunekoder: ${c.k}`, c.n && `Maks.: ${c.n}`]
    .filter(Boolean)
    .join("\n");
  return { ...c, hint, title };
}

function applyCase(c) {
  const keys = c.t || DTYPES.map((t) => t.key);
  document.querySelectorAll("#types input").forEach((i) => (i.checked = keys.includes(i.value)));
  setKommuner(c.k);
  if (c.n) $("limit").value = c.n;
  scheduleSearch(0);
}

// ---------- type selection & URL state ----------
function initTypes(selected) {
  const box = $("types");
  const g = document.createElement("fieldset");
  g.innerHTML = "<legend>Typer</legend>";
  DTYPES.forEach((t) => {
    const l = document.createElement("label");
    const bfTxt = t.bf.ep === "resolve" ? `resolve (${t.bf.kind})` : `search → ${t.bf.target}`;
    l.title = `GSearch: ${t.gs || "–"} · Bifrost: ${bfTxt}`;
    l.innerHTML = `<input type="checkbox" value="${t.key}"> ${t.title}`;
    l.querySelector("input").checked = selected.includes(t.key);
    l.querySelector("input").addEventListener("change", () => scheduleSearch(0));
    g.appendChild(l);
  });
  const all = document.createElement("span");
  all.className = "toggles";
  all.innerHTML = '<button type="button" data-v="1">Alle</button> <button type="button" data-v="0">Ingen</button>';
  all.querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => {
      document.querySelectorAll("#types input").forEach((i) => (i.checked = b.dataset.v === "1"));
      scheduleSearch(0);
    })
  );
  g.appendChild(all);
  box.appendChild(g);
}

const selectedTypes = () =>
  DTYPES.filter((t) => document.querySelector(`#types input[value="${t.key}"]`).checked);

function getLimit() {
  const n = parseInt($("limit").value, 10);
  return Math.max(1, Math.min(100, Number.isFinite(n) ? n : DEFAULT_LIMIT));
}

function writeUrl(q) {
  const p = new URLSearchParams();
  if (q) p.set("q", q);
  p.set("t", selectedTypes().map((t) => t.key).join(","));
  p.set("n", getLimit());
  if (kommuneInput.value.trim()) p.set("k", kommuneInput.value.trim());
  history.replaceState(null, "", "?" + p.toString());
}

// ---------- search ----------
let seq = 0;
const scheduleSearch = debouncer(runSearch, DEBOUNCE_MS);

function runSearch() {
  const term = $("q").value;
  writeUrl(term);
  const types = selectedTypes();
  const limit = getLimit();
  const codes = kommuneCodes();
  const kTxt = codes.length ? ` · kommune ${codes.join(", ")}` : "";
  const my = ++seq;
  const box = $("sections");
  box.innerHTML = "";
  $("summary").textContent = "";
  if (!term.trim() || types.length === 0) return;

  const sections = Object.fromEntries(types.map((t) => [t.key, makeSection(t)]));
  types.forEach((t) => box.appendChild(sections[t.key].el));
  const totals = { gs: { n: 0, ms: 0 }, bf: { n: 0, ms: 0 } };
  const updateSummary = () => {
    $("summary").textContent =
      `GSearch: ${totals.gs.n} resultater, langsomste ${totals.gs.ms} ms · ` +
      `Bifrost: ${totals.bf.n} resultater, langsomste ${totals.bf.ms} ms`;
  };
  const tally = (src, n, ms) => {
    if (my !== seq) return;
    totals[src].n += n;
    totals[src].ms = Math.max(totals[src].ms, ms);
    updateSummary();
  };

  // GSearch: one request per type.
  types.forEach((t) => {
    const s = sections[t.key];
    if (!t.gs) return s.fill("gs", [makeNote("Typen findes ikke i GSearch", "na")], "");
    timed(gsearch(t.gs, term, limit, codes).catch((e) => ({ error: e.message }))).then(([d, ms]) => {
      if (my !== seq) return;
      if (d.error) return s.fill("gs", [makeNote(d.error, "error")], `${ms} ms`);
      const items = d.map((row) => makeItem("gs", { resource: t.gs, row, text: row.visningstekst }, gsTags(row)));
      s.fill("gs", items.length ? items : [makeNote("Ingen resultater", "na")], `${d.length} · ${ms} ms${kTxt}`);
      tally("gs", d.length, ms);
    });
  });

  // Bifrost: one /search request per type, plus a single shared /resolve split by kind.
  if (!cfg().bfKey) {
    types.forEach((t) => sections[t.key].fill("bf", [makeNote(NO_KEY, "error")], ""));
    return;
  }
  types.filter((t) => t.bf.ep === "search").forEach((t) => {
    const s = sections[t.key];
    const body = { input: term, target: t.bf.target, limit: codes.length ? BF_OVERFETCH : limit };
    if (t.bf.lifecycle) body.lifecycle = t.bf.lifecycle;
    const job = async () => {
      const [d, pred] = await Promise.all([
        bifrost("search", body),
        codes.length ? bfKommunePredicate(t.bf.target, codes) : null,
      ]);
      if (!pred) return { matches: d.matches, meta: "" };
      const kept = d.matches.filter(pred);
      const dropped = d.matches.filter((m) => !pred(m));
      const where = `kommune${codes.length > 1 ? "rne" : "n"}`;
      return { matches: kept.slice(0, limit), all: d.matches, dropped, fetched: d.matches.length, where, meta: ` · ${kept.length} af ${d.matches.length} i ${where}` };
    };
    timed(job().catch((e) => ({ error: e.message }))).then(([d, ms]) => {
      if (my !== seq) return;
      if (d.error) return s.fill("bf", [makeNote(d.error, "error")], `${ms} ms`);
      const items = d.matches.map((m) => makeItem("bf", { ep: "search", row: m, text: m.result }, bfDirectTags(m)));
      if (!items.length) items.push(makeNote("Ingen resultater", "na"));
      if (d.dropped && d.matches.length < limit && d.dropped.length) items.push(...droppedItems(d));
      s.fill("bf", items, `${d.matches.length} · ${ms} ms${d.meta}`);
      tally("bf", d.matches.length, ms);
    });
  });
  const resolveTypes = types.filter((t) => t.bf.ep === "resolve");
  if (resolveTypes.length) {
    const job = bfResolve(term, RESOLVE_MAX, codes).then((matches) => ({ matches }));
    timed(job.catch((e) => ({ error: e.message }))).then(([d, ms]) => {
      if (my !== seq) return;
      resolveTypes.forEach((t) => {
        const s = sections[t.key];
        if (d.error) return s.fill("bf", [makeNote(d.error, "error")], `${ms} ms`);
        const mine = resolveFor(t, d.matches);
        const used = new Set(mine.map((m) => m.src));
        const shown = mine.slice(0, limit);
        const items = shown.map((m) =>
          makeItem("bf", { ep: "resolve", row: m, text: m.result }, [...(m.viaUnit ? ["unit = entrance"] : []), ...bfDirectTags(m)])
        );
        if (!items.length) items.push(makeNote("Ingen resultater", "na"));
        const others = countBy(d.matches.filter((m) => !used.has(m)), (m) => m.ref.kind);
        if (others) items.push(makeNote(`/resolve gav også: ${others}`, "na"));
        s.fill("bf", items, `${shown.length} · ${ms} ms · /resolve (${d.matches.length} i alt, maks. ${RESOLVE_MAX})${kTxt}`);
        tally("bf", shown.length, ms);
      });
    });
  }
}

const DROPPED_SHOWN = 5;

// Shows what the browser-side kommune filter removed: Bifrost ranks before filtering, GSearch after.
function droppedItems(d) {
  const note = makeNote(
    `Bifrost kan ikke filtrere på serveren. Kun ${d.fetched - d.dropped.length} af de ${d.fetched} bedste hits ligger i ${d.where}; ` +
      `${d.dropped.length} er filtreret fra i browseren, fx:`,
    "na dropnote"
  );
  const shown = d.dropped.slice(0, DROPPED_SHOWN).map((m) => {
    const li = makeItem("bf", { ep: "search", row: m, text: m.result }, ["uden for filteret", ...bfDirectTags(m)]);
    li.classList.add("dropped");
    li.value = d.all.indexOf(m) + 1; // Bifrost's own rank among the fetched hits
    li.title = `Nr. ${li.value} i Bifrosts rangering`;
    return li;
  });
  const more = d.dropped.length > DROPPED_SHOWN ? [makeNote(`… og ${d.dropped.length - DROPPED_SHOWN} mere`, "na")] : [];
  return [note, ...shown, ...more];
}

function countBy(list, fn) {
  const c = {};
  list.forEach((x) => (c[fn(x)] = (c[fn(x)] || 0) + 1));
  return Object.entries(c).map(([k, v]) => `${v} ${k}`).join(", ");
}

// A unit without floor/door is also its entrance (Bifrost then sets refs.entrance and returns
// only the unit), so it counts as a husnummer hit as well.
function resolveFor(t, matches) {
  const seen = new Set();
  return matches
    .map((m) => {
      if (m.ref.kind === t.bf.kind) return { ...m, src: m };
      if (t.bf.kind === "entrance" && m.ref.kind === "unit" && m.refs && m.refs.entrance)
        return { ...m, ref: { kind: "entrance", id: m.refs.entrance }, viaUnit: true, src: m };
    })
    .filter((m) => m && !seen.has(m.ref.id) && seen.add(m.ref.id));
}

function bfDirectTags(m) {
  const c = m.components || {};
  const where = [
    ...(c.postcodes || []).map((p) => `${p.postcode} ${p.city}`),
    ...(c.kommuner || []).map((k) => k.kommune),
  ];
  const whereTxt = where.length > 4 ? where.slice(0, 4).join(", ") + ` +${where.length - 4}` : where.join(", ");
  return [...bfTags(m), whereTxt];
}

function makeSection(t) {
  const el = document.createElement("section");
  el.className = "tsec";
  const bfTxt = t.bf.ep === "resolve" ? `/resolve, kind ${t.bf.kind}` : `/search, target ${t.bf.target}`;
  el.innerHTML = `
    <h3>${t.title}</h3>
    <div class="pair">
      <div><h4 class="gsH">GSearch <code>${t.gs || "–"}</code> <span class="meta">søger…</span></h4><ol class="list"></ol></div>
      <div><h4 class="bfH">Bifrost <code>${bfTxt}</code> <span class="meta">søger…</span></h4><ol class="list"></ol></div>
    </div>`;
  const [gsCol, bfCol] = el.querySelectorAll(".pair > div");
  const cols = { gs: gsCol, bf: bfCol };
  return {
    el,
    fill(src, items, meta) {
      cols[src].querySelector(".meta").textContent = meta;
      const ol = cols[src].querySelector("ol");
      ol.innerHTML = "";
      items.forEach((li) => ol.appendChild(li));
    },
  };
}

// ---------- boot ----------
function init() {
  const params = new URLSearchParams(location.search);
  const t = params.get("t");
  const selected = t !== null ? t.split(",").filter((k) => DTYPE_BY_KEY[k]) : DTYPES.map((x) => x.key);
  $("limit").value = params.get("n") || DEFAULT_LIMIT;
  initSettings(() => scheduleSearch(0));
  initTypes(selected);
  initMap();
  initCases(CASES, applyCase);
  initKommuneFilter($("kfilterBox"), params.get("k"), () => scheduleSearch());

  $("limit").addEventListener("change", () => scheduleSearch(0));
  const q = $("q");
  q.value = params.get("q") || "";
  q.addEventListener("input", () => scheduleSearch());
  q.addEventListener("keydown", (e) => e.key === "Enter" && scheduleSearch(0));
  if (q.value) scheduleSearch(0);
}

init();
