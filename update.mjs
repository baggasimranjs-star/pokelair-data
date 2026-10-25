// Daily PokéLair data job: pulls new Reg M-C tournaments from the Limitless public API (staying under its limit of
// 50 requests per 5 minutes), keeps every standing in data/, and rebuilds out/limitless.json:
//  - adj: each Pokémon's own share of team wins (one model over every team, so partners don't get credit)
//  - results: Pokémon win rates, proven pairs and cores, and the exact winning team lists ("proven teams")
// PokéLair's daily refresh copies that file into the page's data. Run: node update.mjs
import fs from 'node:fs';
const API = 'https://play.limitlesstcg.com/api', FORMAT = 'M-C', MAX_FETCH = +(process.env.MAX_FETCH || 40), GAP_MS = +(process.env.GAP||6500);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
fs.mkdirSync('data/t', {recursive: true}); fs.mkdirSync('out', {recursive: true});
const index = readJSON('data/index.json', {tournaments: {}});
let calls = 0;
async function get(path) {
  for (let k = 0; k < 6; k++) {
    if (calls++) await sleep(GAP_MS);
    const r = await fetch(API + path, {headers: {'User-Agent': 'pokelair-data (personal team-builder stats)'}});
    if (r.status === 429) { await sleep(((+r.headers.get('retry-after')) || 60) * 1000 + 2000); continue; }
    if (!r.ok) throw new Error(path + ' ' + r.status);
    return r.json();
  }
  throw new Error(path + ' kept hitting the rate limit');
}
// mega form from the held item: "Raichunite X" -> "Raichu|MX"
const key = m => { const it = m.item || ''; const z = it.match(/^(.*)ite( [XYZ])?$/); return z && it !== 'Eviolite' ? m.name + '|M' + (z[2] ? z[2].trim() : '') : m.name; };

// 1) tournament list, then standings for new ones and for anything from the last 3 days (results can still change)
const list = [];
for (let page = 1; page < 30; page++) { const r = await get(`/tournaments?game=VGC&format=${FORMAT}&limit=100&page=${page}`); if (!r.length) break; list.push(...r); }
const now = Date.now(), todo = list.filter(t => !index.tournaments[t.id] || (now - new Date(t.date)) < 3 * 864e5)
  .sort((a, b) => (index.tournaments[a.id] ? 1 : 0) - (index.tournaments[b.id] ? 1 : 0) || new Date(b.date) - new Date(a.date)).slice(0, MAX_FETCH);
let fetched = 0;
for (const t of todo) {
  try { const s = await get(`/tournaments/${t.id}/standings`);
    const e = s.map(x => [String(x.player || x.name || ''), x.record ? x.record.wins : 0, x.record ? x.record.losses : 0, (x.decklist || []).map(key)]);
    fs.writeFileSync(`data/t/${t.id}.json`, JSON.stringify({d: t.date, p: t.players, e}));
    index.tournaments[t.id] = {d: t.date, p: t.players, name: t.name}; fetched++;
  } catch (err) { console.log('skip', t.id, err.message); }
}
fs.writeFileSync('data/index.json', JSON.stringify(index));
console.log(`list ${list.length} tournaments, fetched ${fetched}, cached ${Object.keys(index.tournaments).length}`);

// 2) all teams with a full six and 3+ games
const E = []; let first = null, last = null;
for (const id of Object.keys(index.tournaments)) { const T = readJSON(`data/t/${id}.json`, null); if (!T) continue;
  first = !first || T.d < first ? T.d : first; last = !last || T.d > last ? T.d : last;
  for (const [pl, w, l, ks] of T.e) { const m = [...new Set(ks)]; if (m.length === 6 && w + l >= 3) E.push({m, w, l}); } }
const keys = [...new Set(E.flatMap(e => e.m))], ki = new Map(keys.map((k, i) => [k, i])); E.forEach(e => e.ix = e.m.map(k => ki.get(k)));
let W = 0, G = 0; for (const e of E) { W += e.w; G += e.w + e.l; } const base = W / G;

// 3) teammate-adjusted share of the win: logistic model over every team, ridge-shrunk (fit with Adam)
function fit(lb, iters) { const n = keys.length, b = new Float64Array(n), mb = new Float64Array(n), vb = new Float64Array(n); let a = 0, ma = 0, va = 0;
  for (let t = 1; t <= iters; t++) { const gb = new Float64Array(n); let ga = 0;
    for (const e of E) { let eta = a; for (const j of e.ix) eta += b[j]; const d = (e.w + e.l) / (1 + Math.exp(-eta)) - e.w; ga += d; for (const j of e.ix) gb[j] += d; }
    for (let j = 0; j < n; j++) gb[j] += 2 * lb * b[j];
    const c1 = 1 - .9 ** t, c2 = 1 - .999 ** t; ma = .9 * ma + .1 * ga; va = .999 * va + .001 * ga * ga; a -= .05 * (ma / c1) / (Math.sqrt(va / c2) + 1e-8);
    for (let j = 0; j < n; j++) { mb[j] = .9 * mb[j] + .1 * gb[j]; vb[j] = .999 * vb[j] + .001 * gb[j] ** 2; b[j] -= .05 * (mb[j] / c1) / (Math.sqrt(vb[j] / c2) + 1e-8); } }
  return b; }
const B = fit(30, 500);

// 4) Limitless names -> PokéLair names
const ROSTER = readJSON('roster.json', []), names = new Set(ROSTER), REG = {Hisuian: 'Hisui', Alolan: 'Alola', Galarian: 'Galar', Paldean: 'Paldea'};
function lmap(k) { let [n, mega] = k.split('|'); if (/^Eternal Flower Floette$/.test(n) && mega == null) return 'Floette-Eternal'; n = n.replace(/^Eternal Flower /, '');
  { const r = n.match(/^(Wash|Heat|Frost|Fan|Mow) Rotom$/); if (r) n = 'Rotom-' + r[1]; }
  n = n.replace(/'/g, '’').replace(/^Lycanroc (Dusk|Midnight)$/, 'Lycanroc-$1').replace(/^Low Key Toxtricity$/, 'Toxtricity-Low-Key').replace(/^Paldean Tauros (Aqua|Blaze|Combat) Breed$/, 'Tauros-Paldea-$1');
  let m = n.match(/^(Hisuian|Alolan|Galarian|Paldean) (.*)$/); if (m) n = m[2] + '-' + REG[m[1]];
  n = n.replace(/ ♀$/, '-F').replace(/ ♂$/, '');
  m = n.match(/^(.*?) \((.*)\)$/); if (m) n = m[1] + ({'Dusk Form': '-Dusk', 'Midnight Form': '-Midnight', 'Low Key Form': '-Low-Key'}[m[2]] || '');
  if (mega != null) { const s = mega.slice(1); for (const c of [n + '-Mega' + (s ? '-' + s : ''), n.replace(/-F$/, '') + '-F-Mega', n + '-Mega']) if (names.has(c)) return c; return null; }
  if (names.has(n)) return n; const b = n.split('-')[0]; return names.has(b) ? b : null; }
const nm = keys.map(lmap);

// 5) per-Pokémon numbers, pairs (25+ teams), cores (40+ teams), proven team lists
const shrink = (w, g, K) => Math.round(1000 * (w + K * base) / (g + K)) / 1000;
const mon = new Map();
keys.forEach((k, j) => { const n = nm[j]; if (!n) return; let w = 0, g = 0, t = 0; for (const e of E) if (e.ix.includes(j)) { w += e.w; g += e.w + e.l; t++; }
  const o = mon.get(n) || {w: 0, g: 0, t: 0, bs: 0}; o.w += w; o.g += g; o.t += t; o.bs += B[j] * g; mon.set(n, o); });
const P = new Map(), C3 = new Map(), comp = new Map();
for (const e of E) { const m = [...new Set(e.ix.map(j => nm[j]).filter(Boolean))].sort(); if (m.length < 6) continue; const g = e.w + e.l;
  const ck = m.join('|'), co = comp.get(ck) || {n: 0, w: 0, g: 0}; co.n++; co.w += e.w; co.g += g; comp.set(ck, co);
  for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) { const k = m[i] + '|' + m[j], o = P.get(k) || {n: 0, w: 0, g: 0}; o.n++; o.w += e.w; o.g += g; P.set(k, o);
    for (let l = j + 1; l < 6; l++) { const k3 = k + '|' + m[l], q = C3.get(k3) || {n: 0, w: 0, g: 0}; q.n++; q.w += e.w; q.g += g; C3.set(k3, q); } } }
const day = d => new Date(d).toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
const src = `${E.length.toLocaleString('en-US')} Reg M-C tournament teams, ${G.toLocaleString('en-US')} games (Limitless, ${Object.keys(index.tournaments).length} events, ${day(first)} – ${day(last)})`;
const out = {updated: new Date().toISOString(), tournaments: Object.keys(index.tournaments).length, teams: E.length, games: G, base: Math.round(base * 1e4) / 1e4,
  adj: {label: `Limitless · ${Object.keys(index.tournaments).length} Reg M-C tournaments (${day(first)} – ${day(last)}), ${E.length.toLocaleString('en-US')} teams, ${G.toLocaleString('en-US')} games · each Pokémon's own share of the win (teammates accounted for)`,
    rows: [...mon].map(([n, o]) => [n, Math.round(1000 * o.bs / (o.g || 1)) / 1000, o.g, o.t, Math.round(1000 * o.w / (o.g || 1)) / 10])},
  results: {source: src, teams: E.length, base: Math.round(base * 1e4) / 1e4, minCore: 40,
    mons: Object.fromEntries([...mon].map(([n, o]) => [n, [o.t, shrink(o.w, o.g, 40)]])),
    pairs: Object.fromEntries([...P].filter(([, o]) => o.n >= 25).map(([k, o]) => [k, [o.n, shrink(o.w, o.g, 40)]])),
    cores: [...C3].filter(([, o]) => o.n >= 40).map(([k, o]) => [...k.split('|'), o.n, shrink(o.w, o.g, 40)]).sort((a, b) => b[4] - a[4]),
    proven: [...comp].map(([k, o]) => [k.split('|'), o.n, shrink(o.w, o.g, 20), o.g]).filter(x => x[2] >= base + .01 && (x[1] >= 2 || x[3] >= 8)).map(x => x.slice(0, 3)).sort((a, b) => b[2] - a[2] || b[1] - a[1])}};
fs.writeFileSync('out/limitless.json', JSON.stringify(out));
console.log(`teams ${E.length}, games ${G}, pokemon ${mon.size}, pairs ${Object.keys(out.results.pairs).length}, cores ${out.results.cores.length}, proven ${out.results.proven.length}`);
