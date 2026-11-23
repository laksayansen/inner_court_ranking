/* ============================================================
   The Inner Court Rankings — CCT360 Lab 6: Working with an API
   Live data from AniList's public GraphQL API (no key needed,
   so it is safe to publish on GitHub Pages).

   1. fetch() the cast of The Apothecary Diaries
   2. turn the JSON into a ranked list (by fan favourites)
   3. build the board + ledger in the DOM from that data
   4. on click, open one character's case file
   ============================================================ */

window.courtScriptLoaded = true;

const ANILIST = "https://graphql.anilist.co";
const MAL_ID = 54492;
const LEDGER_PREVIEW = 10;      
const MIN_K = 0.3;               
const MAX_K = 4;
const board = document.getElementById("board");
const stage = document.getElementById("stage");
const pins = document.getElementById("pins");
const threads = document.getElementById("threads");
const tip = document.getElementById("tip");
const boardStatus = document.getElementById("boardStatus");
const helpNote = document.getElementById("helpNote");
const helpBtn = document.getElementById("helpBtn");
const rail = document.getElementById("rail");
const railMark = document.getElementById("railMark");
const panelScroll = document.getElementById("panelScroll");
const menuBtn = document.getElementById("menuBtn");
const menu = document.getElementById("menu");
const liveStatus = document.getElementById("liveStatus");
const dossier = document.getElementById("dossier");
const fileBlock = document.getElementById("fileBlock");
const searchInput = document.getElementById("search");
const ledgerBody = document.getElementById("ledgerBody");
const moreBtn = document.getElementById("moreBtn");
const factsBody = document.getElementById("facts");

let court = [];              
let byId = new Map();          
let itemById = new Map();       
let bounds = null;               
let selectedId = null;
let roleFilter = "all";
let query = "";
let showAll = false;
const fileCache = new Map();     
const view = { x: 0, y: 0, k: 1 };

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const fmt = n => Number(n || 0).toLocaleString("en-CA");
const wide = window.matchMedia("(min-width: 821px)");

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function seeded(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

async function getJSON(url, { tries = 3, timeoutMs = 15000, retryOnTimeout = true, init = {} } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (res.ok) return await res.json();
      lastError = new Error(`${new URL(url).hostname} answered with status ${res.status}`);
      if (res.status !== 429 && res.status < 500) throw lastError;    
    } catch (err) {
      if (err === lastError) throw err;
      if (err.name === "AbortError") {
        lastError = new Error(`${new URL(url).hostname} took longer than ${timeoutMs / 1000} seconds to answer`);
        if (!retryOnTimeout) throw lastError;
      } else {
        lastError = new Error(`The request was blocked or the network is offline (${err.message})`);
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < tries) await wait(1200 * attempt);
  }
  throw lastError;
}

const COURT_QUERY = `
query ($idMal: Int, $page: Int) {
  Media(idMal: $idMal, type: ANIME) {
    siteUrl
    averageScore
    popularity
    favourites
    episodes
    startDate { year month day }
    endDate { year month day }
    studios(isMain: true) { nodes { name } }
    characters(page: $page, perPage: 25, sort: [FAVOURITES_DESC]) {
      pageInfo { hasNextPage }
      edges {
        role
        node {
          id
          siteUrl
          favourites
          description
          name { full native alternative }
          image { large }
        }
        voiceActors(language: JAPANESE) { name { full } }
      }
    }
  }
}`;

async function askAniList(page) {
  const json = await getJSON(ANILIST, {
    tries: 3,
    timeoutMs: 15000,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: COURT_QUERY, variables: { idMal: MAL_ID, page } })
    }
  });
  if (json.errors?.length) throw new Error(`AniList: ${json.errors[0].message}`);
  if (!json.data?.Media) throw new Error("AniList could not find the show");
  return json.data.Media;
}

function cleanDescription(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/~!([\s\S]*?)!~/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/__|\*\*|<[^>]+>/g, "")
    .trim();
}

function formatDate(d) {
  if (!d?.year) return "";
  if (!d.month) return String(d.year);
  return new Date(d.year, d.month - 1, d.day || 1)
    .toLocaleDateString("en-CA", { month: "short", day: d.day ? "numeric" : undefined, year: "numeric" });
}

function showFacts(m) {
  const aired = [formatDate(m.startDate), formatDate(m.endDate)].filter(Boolean).join(" to ");
  return [
    ["Score", m.averageScore ? `${(m.averageScore / 10).toFixed(1)} / 10` : "", "average score on AniList"],
    ["Popularity", m.popularity ? fmt(m.popularity) : "", "AniList users following the case"],
    ["Favourited", m.favourites ? fmt(m.favourites) : "", "times on AniList"],
    ["Episodes", m.episodes ? String(m.episodes) : "", ""],
    ["Aired", aired, ""],
    ["Studios", (m.studios?.nodes || []).map(s => s.name).join(", "), ""]
  ].filter(f => f[1]);
}

function shapeCourt(edges) {
  const seen = new Set();
  const people = [];
  for (const e of edges) {
    const n = e.node;
    if (!n || seen.has(n.id)) continue;
    seen.add(n.id);
    const img = n.image?.large || "";
    fileCache.set(n.id, {
      native: n.name?.native || "",
      nicknames: (n.name?.alternative || []).filter(Boolean),
      about: cleanDescription(n.description)
    });
    people.push({
      id: n.id,
      name: n.name?.full || n.name?.native || "Unknown",
      url: n.siteUrl,
      img: img.includes("/default.") ? "" : img,         
      role: e.role === "MAIN" ? "Main" : "Supporting",
      fav: n.favourites ?? 0,
      voice: e.voiceActors?.[0]?.name?.full || ""
    });
  }
  people.sort((a, b) => b.fav - a.fav || (a.role === "Main" ? -1 : 1));
  people.forEach((p, i) => { p.rank = i + 1; });
  return people;
}

async function loadCourt() {
  boardStatus.hidden = false;
  boardStatus.textContent = "Gathering the court…";
  liveStatus.className = "status";
  liveStatus.textContent = "Consulting the archive…";
  fileCache.clear();
  selectedId = null;

  const slowNote = setTimeout(() => {
    boardStatus.innerHTML = `<span>Gathering the court…</span><small class="status-detail">AniList is slow to answer right now. Still trying.</small>`;
  }, 6000);

  try {
    const edges = [];
    let media = null;
    for (let page = 1; page <= 6; page++) {           
      media = await askAniList(page);
      edges.push(...media.characters.edges);
      if (!media.characters.pageInfo.hasNextPage) break;
      await wait(350);                                 
    }

    court = shapeCourt(edges);
    if (!court.length) throw new Error("AniList sent back an empty cast list");
    byId = new Map(court.map(p => [p.id, p]));
    if (media.siteUrl) document.getElementById("sourceLink").href = media.siteUrl;

    const facts = showFacts(media);
    buildBoard(facts);
    renderFacts(facts);
    renderLedger();
    dossier.className = "dossier empty";
    dossier.innerHTML = `<p>Select a portrait on the board, or a name in the ledger below, to open their file.</p>`;

    boardStatus.hidden = true;
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    liveStatus.textContent = `${court.length} members of the court, fetched live from AniList at ${time}`;
    liveStatus.classList.add("live");
  } catch (err) {
    console.error(err);
    boardStatus.hidden = false;
    boardStatus.innerHTML = `<span>The archive could not be reached</span>
      <small class="status-detail">${esc(err.message)}</small>
      <button type="button" id="retry">Try again</button>`;
    document.getElementById("retry").addEventListener("click", loadCourt);
    liveStatus.textContent = "Offline: AniList did not answer. Try again in a moment.";
  } finally {
    clearTimeout(slowNote);
  }
}

// Board
const PAPERS = ["var(--paper-1)", "var(--paper-2)", "var(--paper-3)", "var(--paper-4)", "var(--paper-5)"];

function buildBoard(facts) {
  const rand = seeded(MAL_ID);
  const maxFav = Math.max(1, court[0].fav);
  const items = court.map((p, i) => {
    const r = rand();
    if (p.img) {
      const w = 44 + 76 * Math.sqrt(p.fav / maxFav);           
      return { kind: "photo", p, w, h: (w - 6) * (350 / 225) + 18, r };
    }
    return { kind: "note", p, w: 80, h: 50, r, paper: PAPERS[i % PAPERS.length] };
  });

  const slots = [3, 8, 14, 22, 31, 42];
  facts.forEach((f, i) => {
    items.splice(Math.min(slots[i], items.length), 0,
      { kind: "fact", label: f[0], value: f[1], note: f[2], w: 96, h: 60, r: rand(), paper: PAPERS[(i + 2) % PAPERS.length] });
  });

  layout(items, rand);
  itemById = new Map(items.filter(it => it.p).map(it => [it.p.id, it]));
  const R = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;
  const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
  const marks = [[-2.3, 1.02], [-0.25, 1.1], [1.15, 0.98], [2.7, 1.06]].map(([a, d]) =>
    `<span class="mark" style="left:${(cx + Math.cos(a) * R * d).toFixed(0)}px;top:${(cy + Math.sin(a) * R * d).toFixed(0)}px">×</span>`);

  pins.innerHTML = marks.join("") + items.map(renderItem).join("");
  threads.innerHTML = "";
  fitBoard(false);
}

function renderItem(it) {
  const tilt = ((it.r - 0.5) * 2.4).toFixed(2);
  const pos = `left:${it.x.toFixed(1)}px;top:${it.y.toFixed(1)}px;width:${it.w.toFixed(1)}px;--tilt:${tilt}deg`;

  if (it.kind === "fact") {
    return `<div class="item fact" style="${pos};--paper:${it.paper}">
      <small>${esc(it.label.toUpperCase())}</small><b>${esc(it.value)}</b>${it.note ? `<span>${esc(it.note)}</span>` : ""}
    </div>`;
  }

  const p = it.p;
  const cls = `item ${it.kind}${p.role === "Main" ? " main" : ""}`;
  const label = `${p.name}, number ${p.rank}, ${fmt(p.fav)} favourites`;

  if (it.kind === "photo") {
    return `<button type="button" class="${cls}" data-id="${p.id}" style="${pos}" aria-label="${esc(label)}">
      <img src="${esc(p.img)}" alt="" draggable="false"><span class="cap">${p.rank}. ${esc(p.name)}</span>
    </button>`;
  }
  return `<button type="button" class="${cls}" data-id="${p.id}" style="${pos};--paper:${it.paper}" aria-label="${esc(label)}">
    <small>NO. ${p.rank} · NO PORTRAIT</small><b>${esc(p.name)}</b><span>${p.role} · ♥ ${fmt(p.fav)}</span>
  </button>`;
}

function layout(items, rand) {
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  items.forEach((it, i) => {
    const radius = 74 * Math.sqrt(i + 0.5);
    it.x = Math.cos(i * GOLDEN) * radius + (rand() - 0.5) * 16;
    it.y = Math.sin(i * GOLDEN) * radius + (rand() - 0.5) * 16;
  });

  const GAP = 16;
  for (let pass = 0; pass < 120; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const A = items[i], B = items[j];
        const ox = (A.w + B.w) / 2 + GAP - Math.abs(A.x - B.x);
        const oy = (A.h + B.h) / 2 + GAP - Math.abs(A.y - B.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        if (ox < oy) {
          const s = Math.sign(B.x - A.x) || 1;
          A.x -= s * ox * 0.2; B.x += s * ox * 0.8;
        } else {
          const s = Math.sign(B.y - A.y) || 1;
          A.y -= s * oy * 0.2; B.y += s * oy * 0.8;
        }
      }
    }
    if (!moved) break;
  }

  bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const it of items) {
    bounds.minX = Math.min(bounds.minX, it.x - it.w / 2);
    bounds.maxX = Math.max(bounds.maxX, it.x + it.w / 2);
    bounds.minY = Math.min(bounds.minY, it.y - it.h / 2);
    bounds.maxY = Math.max(bounds.maxY, it.y + it.h / 2);
  }
}

// Zoom
let flyTimer = null;

function applyView(animate = false) {
  clearTimeout(flyTimer);
  stage.classList.toggle("flying", animate);
  if (animate) flyTimer = setTimeout(() => stage.classList.remove("flying"), 900);
  stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;

  const t = (Math.log(view.k) - Math.log(MIN_K)) / (Math.log(MAX_K) - Math.log(MIN_K));
  railMark.style.setProperty("--t", t.toFixed(3));
  rail.setAttribute("aria-valuenow", Math.round(view.k * 100));
}

function fitBoard(animate = true) {
  if (!bounds) return;
  const W = board.clientWidth, H = board.clientHeight, pad = W < 600 ? 20 : 56;
  view.k = clamp(Math.min((W - pad * 2) / (bounds.maxX - bounds.minX),
                          (H - pad * 2) / (bounds.maxY - bounds.minY)), MIN_K, MAX_K);
  view.x = W / 2 - ((bounds.minX + bounds.maxX) / 2) * view.k;
  view.y = H / 2 - ((bounds.minY + bounds.maxY) / 2) * view.k;
  applyView(animate);
}

function zoomAt(factor, mx, my, animate = false) {
  const k = clamp(view.k * factor, MIN_K, MAX_K);
  const f = k / view.k;
  view.x = mx - (mx - view.x) * f;
  view.y = my - (my - view.y) * f;
  view.k = k;
  applyView(animate);
}

const zoomCentre = (factor, animate = true) => zoomAt(factor, board.clientWidth / 2, board.clientHeight / 2, animate);

function flyTo(it) {
  const W = board.clientWidth, H = board.clientHeight;
  view.k = Math.max(view.k, clamp((H * 0.38) / it.h, 1.2, 3.2));
  view.x = W / 2 - it.x * view.k;
  view.y = H / 2 - it.y * view.k;
  applyView(true);
}

board.addEventListener("wheel", e => {
  e.preventDefault();
  const r = board.getBoundingClientRect();
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;          
  zoomAt(Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
}, { passive: false });

let drag = null;
let dragged = false;

board.addEventListener("pointerdown", e => {
  if (e.button !== 0 || e.target.closest(".controls, .help-note, .board-status")) return;
  drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
  dragged = false;
});
window.addEventListener("pointermove", e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!dragged && Math.hypot(dx, dy) < 4) return;
  dragged = true;
  board.classList.add("dragging");
  tip.classList.remove("on");
  view.x = drag.vx + dx;
  view.y = drag.vy + dy;
  applyView();
});
window.addEventListener("pointerup", () => {
  drag = null;
  board.classList.remove("dragging");
});

let lastSize = null;
new ResizeObserver(() => {
  const W = board.clientWidth, H = board.clientHeight;
  if (lastSize && bounds) {
    view.x += (W - lastSize.W) / 2;
    view.y += (H - lastSize.H) / 2;
    applyView();
  }
  lastSize = { W, H };
}).observe(board);

document.getElementById("zoomIn").addEventListener("click", () => zoomCentre(1.4));
document.getElementById("zoomOut").addEventListener("click", () => zoomCentre(1 / 1.4));
document.getElementById("recenter").addEventListener("click", () => fitBoard(true));
document.getElementById("fullscreen").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else board.requestFullscreen?.().catch(() => {});
});
document.addEventListener("fullscreenchange", () => setTimeout(() => fitBoard(true), 120));

rail.addEventListener("click", e => {
  const r = rail.getBoundingClientRect();
  const t = clamp(1 - (e.clientY - r.top - 12) / (r.height - 24), 0, 1);
  const k = Math.exp(Math.log(MIN_K) + t * (Math.log(MAX_K) - Math.log(MIN_K)));
  zoomCentre(k / view.k);
});
rail.addEventListener("keydown", e => {
  if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); zoomCentre(1.2); }
  if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); zoomCentre(1 / 1.2); }
});

function toggleHelp(force) {
  const open = force ?? helpNote.hidden;
  helpNote.hidden = !open;
  helpBtn.setAttribute("aria-expanded", String(open));
}
helpBtn.addEventListener("click", () => toggleHelp());
document.getElementById("howBtn").addEventListener("click", () => {
  toggleHelp(true);
  if (!wide.matches) board.scrollIntoView({ behavior: "smooth" });
});

// hover label
stage.addEventListener("pointerover", e => {
  const el = e.target.closest("[data-id]");
  if (!el || drag) return;
  const p = byId.get(Number(el.dataset.id));
  if (!p) return;
  tip.innerHTML = `No. ${p.rank} · ${esc(p.name)} <small>♥ ${fmt(p.fav)}</small>`;
  tip.classList.add("on");
});
stage.addEventListener("pointerout", e => {
  if (!e.relatedTarget || !e.relatedTarget.closest?.("[data-id]")) tip.classList.remove("on");
});
board.addEventListener("pointermove", e => {
  if (!tip.classList.contains("on")) return;
  const r = board.getBoundingClientRect();
  const x = Math.min(e.clientX - r.left + 16, r.width - tip.offsetWidth - 8);
  tip.style.transform = `translate(${x}px, ${e.clientY - r.top + 18}px)`;
});

stage.addEventListener("click", e => {
  if (dragged && e.detail !== 0) return;     
  const el = e.target.closest("[data-id]");
  if (el) openFile(Number(el.dataset.id));
});

document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea")) return;
  if (e.key === "+" || e.key === "=") zoomCentre(1.4);
  if (e.key === "-" || e.key === "_") zoomCentre(1 / 1.4);
  if (e.key === "0") fitBoard(true);
  if (e.key === "Escape") { toggleHelp(false); closeMenu(); }
});

const handle = document.getElementById("handle");
handle.addEventListener("pointerdown", e => {
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const move = ev => {
    const w = clamp(ev.clientX, 340, window.innerWidth * 0.7);
    document.documentElement.style.setProperty("--panel-w", `${w}px`);
  };
  const stop = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", stop);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", stop);
});

// Cast Description Fetch
function openFile(id, { fly = true } = {}) {
  const p = byId.get(id);
  if (!p) return;
  selectedId = id;
  tip.classList.remove("on");

  pins.querySelectorAll(".selected").forEach(el => el.classList.remove("selected"));
  pins.querySelector(`[data-id="${id}"]`)?.classList.add("selected");
  drawThreads(p);
  renderLedger();
  renderDossier(p, fileCache.get(id));

  if (wide.matches) {
    if (fly) flyTo(itemById.get(id));
    panelScroll.scrollTo({ top: fileBlock.offsetTop - 24, behavior: "smooth" });
  } else {
    fileBlock.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function tidyAbout(text) {
  let t = String(text).replace(/\(Source:[^)]*\)/gi, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > 640) {
    const cut = t.lastIndexOf(". ", 640);
    t = t.slice(0, cut > 300 ? cut + 1 : 640) + " …";
  }
  return t;
}

function renderDossier(p, info) {
  const prev = court[p.rank - 2];
  const next = court[p.rank];
  const about = info?.about ? tidyAbout(info.about) : "";
  const body = about
    ? `<p class="d-about">${esc(about)}</p>`
    : `<p class="d-wait">No notes have been kept on this one.</p>`;

  dossier.className = "dossier";
  dossier.innerHTML = `
    <span class="seal" lang="ja" aria-hidden="true">薬</span>
    <div class="d-photo">${p.img ? `<img src="${esc(p.img)}" alt="Portrait of ${esc(p.name)}">` : `<div class="d-blank">Portrait<br>missing</div>`}</div>
    <div class="d-head">
      <p class="d-no">No. ${p.rank} of ${court.length}</p>
      <h3 class="d-name">${esc(p.name)}</h3>
      <p class="d-kanji" lang="ja">${info?.native ? esc(info.native) : ""}</p>
      <dl class="d-meta">
        <div><dt>Standing</dt><dd>${p.role === "Main" ? "Main character" : "Supporting cast"}</dd></div>
        <div><dt>Favourites</dt><dd>♥ ${fmt(p.fav)}</dd></div>
        ${p.voice ? `<div><dt>Voiced by</dt><dd>${esc(p.voice)}</dd></div>` : ""}
        ${info?.nicknames?.length ? `<div><dt>Also known as</dt><dd>${esc(info.nicknames.join(", "))}</dd></div>` : ""}
      </dl>
    </div>
    <div class="d-body">
      ${body}
      <a class="d-link" href="${esc(p.url)}" target="_blank" rel="noopener">Open on AniList ↗</a>
    </div>
    <nav class="d-nav" aria-label="Neighbouring ranks">
      <button type="button" class="d-step" ${prev ? `data-go="${prev.id}"` : "disabled"}><small>Ranked above</small><span>${prev ? `← No. ${prev.rank} ${esc(prev.name)}` : "Top of the court"}</span></button>
      <button type="button" class="d-step" ${next ? `data-go="${next.id}"` : "disabled"}><small>Ranked below</small><span>${next ? `No. ${next.rank} ${esc(next.name)} →` : "End of the ledger"}</span></button>
    </nav>`;
}

dossier.addEventListener("click", e => {
  const go = e.target.closest("[data-go]");
  if (go) openFile(Number(go.dataset.go));
});

function drawThreads(p) {
  const a = itemById.get(p.id);
  const neighbours = [court[p.rank - 2], court[p.rank]].filter(Boolean).map(q => itemById.get(q.id));
  threads.innerHTML = neighbours.map(b => {
    const ax = a.x, ay = a.y - a.h / 2 + 1;
    const bx = b.x, by = b.y - b.h / 2 + 1;
    const sag = Math.hypot(bx - ax, by - ay) * 0.14;        // string hangs a little
    return `<path d="M${ax.toFixed(1)},${ay.toFixed(1)} Q${((ax + bx) / 2).toFixed(1)},${((ay + by) / 2 + sag).toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}"/>`;
  }).join("");
}

function matches(p) {
  return (roleFilter === "all" || p.role === roleFilter) &&
         (!query || p.name.toLowerCase().includes(query));
}

function renderLedger() {
  const rows = court.filter(matches);
  const shown = showAll || query ? rows : rows.slice(0, LEDGER_PREVIEW);

  ledgerBody.innerHTML = shown.length ? shown.map(p => `
    <tr data-id="${p.id}" class="${p.id === selectedId ? "selected" : ""}">
      <td class="num rank">${p.rank}</td>
      <td><button type="button" class="who">${p.img ? `<img src="${esc(p.img)}" alt="">` : `<span class="who-blank"></span>`}<span>${esc(p.name)}</span></button></td>
      <td class="role">${p.role}</td>
      <td class="num">${fmt(p.fav)}</td>
    </tr>`).join("")
    : `<tr><td colspan="4" class="none">No one in the court goes by that name.</td></tr>`;

  moreBtn.hidden = showAll || !!query || rows.length <= LEDGER_PREVIEW;
  moreBtn.textContent = `Show the whole court (${rows.length})`;
}

ledgerBody.addEventListener("click", e => {
  const row = e.target.closest("tr[data-id]");
  if (row) openFile(Number(row.dataset.id));
});
moreBtn.addEventListener("click", () => { showAll = true; renderLedger(); });

function applyFilters() {
  pins.querySelectorAll("[data-id]").forEach(el => {
    el.classList.toggle("dim", !matches(byId.get(Number(el.dataset.id))));
  });
  renderLedger();
}

searchInput.addEventListener("input", () => {
  query = searchInput.value.trim().toLowerCase();
  applyFilters();
});

function closeMenu() {
  menu.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
}
menuBtn.addEventListener("click", () => {
  menu.hidden = !menu.hidden;
  menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
});
menu.addEventListener("click", e => {
  const btn = e.target.closest("[data-role]");
  if (!btn) return;
  roleFilter = btn.dataset.role;
  menu.querySelectorAll("[data-role]").forEach(b => b.classList.toggle("is-on", b === btn));
  applyFilters();
  closeMenu();
});
document.addEventListener("click", e => {
  if (!e.target.closest(".wordmark")) closeMenu();
});

function renderFacts(facts) {
  factsBody.innerHTML = facts.length
    ? facts.map(([label, value, note]) => `<tr><td>${label}</td><td>${esc(value)}${note ? `<small>${esc(note)}</small>` : ""}</td></tr>`).join("")
    : `<tr><td class="none">The show’s record could not be fetched this time.</td></tr>`;
}

applyView();
loadCourt();
