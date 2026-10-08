// 2ème cerveau : mise à jour quotidienne de l'actu (lancée chaque matin par GitHub Actions).
// 1. Lit les flux RSS de journaux économiques.  2. Récupère les cours des marchés.
// 3. Si une clé Gemini est fournie (secret GEMINI_API_KEY), écrit 3 résumés FR/EN + une question d'actu.
//    Sinon, garde les titres et les liens.  4. Écrit data/news.json (15 articles maximum).
import { readFile, writeFile } from "node:fs/promises";

const FILE = "data/news.json";
const UA = { "User-Agent": "Mozilla/5.0 (2eme-cerveau; +https://github.com)" };
const FEEDS = [
  ["Le Monde", "https://www.lemonde.fr/economie/rss_full.xml"],
  ["Les Échos", "https://services.lesechos.fr/rss/les-echos-finance-marches.xml"],
  ["Financial Times", "https://www.ft.com/markets?format=rss"],
  ["CNBC", "https://www.cnbc.com/id/20910258/device/rss/rss.html"],
  ["Yahoo Finance", "https://finance.yahoo.com/news/rssindex"],
  ["BBC", "https://feeds.bbci.co.uk/news/business/rss.xml"],
];
const MARKETS = [
  ["CAC 40", "^FCHI", "idx"], ["S&P 500", "^GSPC", "idx"], ["Nasdaq", "^IXIC", "idx"], ["Brent", "BZ=F", "usd1"],
  ["OAT 10 ans", null, "rate"], ["US 10 ans", "^TNX", "rate"], ["EUR/USD", "EURUSD=X", "fx"], ["Or (once)", "GC=F", "usd0"],
];
const today = new Date().toISOString().slice(0, 10);
const nf = (x, d) => Number(x).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ /g, " ");
const spct = x => (x >= 0 ? "+" : "−") + nf(Math.abs(x), 2) + " %";
const clean = s => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, "i")); return m ? clean(m[1]) : ""; };
const slug = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "article";

async function get(url, ms = 15000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { const r = await fetch(url, { headers: UA, signal: c.signal }); if (!r.ok) throw new Error(r.status); return await r.text(); }
  finally { clearTimeout(t); }
}

async function readFeeds() {
  const items = [];
  for (const [src, url] of FEEDS) {
    try {
      const xml = await get(url);
      const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
      for (const b of blocks.slice(0, 8)) {
        const title = tag(b, "title"), link = tag(b, "link") || (b.match(/<guid[^>]*>(https?:[^<]+)<\/guid>/i) || [])[1];
        const date = new Date(tag(b, "pubDate") || tag(b, "dc:date") || Date.now());
        if (title && link && Date.now() - date < 72 * 3600e3) items.push({ src, title, link: link.trim(), desc: tag(b, "description").slice(0, 300), date: date.toISOString().slice(0, 10) });
      }
      console.log("flux OK :", src, blocks.length);
    } catch (e) { console.log("flux indisponible :", src, e.message); }
  }
  return items;
}

async function quote(sym) {
  const j = JSON.parse(await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5d&interval=1d`));
  const r = j.chart.result[0], closes = r.indicators.quote[0].close, ts = r.timestamp;
  const pts = closes.map((c, i) => [c, ts[i]]).filter(p => p[0] != null);
  const [last, t] = pts[pts.length - 1], prev = pts.length > 1 ? pts[pts.length - 2][0] : null;
  return { last, prev, date: new Date(t * 1000).toISOString().slice(0, 10) };
}
async function oat() {
  const csv = await get("https://stooq.com/q/l/?s=10fry.b&f=sd2t2c&h&e=csv");
  const v = parseFloat(csv.trim().split("\n")[1].split(",").pop());
  if (!(v > 0 && v < 20)) throw new Error("valeur OAT invalide");
  return { last: v, prev: null, date: today };
}
async function markets(old) {
  const prevItems = (old && old.items) || [];
  const items = []; let date = (old && old.date) || today;
  for (const [n, sym, kind] of MARKETS) {
    const keep = prevItems.find(x => x.n === n) || { n, v: "—", c: "" };
    try {
      const q = sym ? await quote(sym) : await oat();
      let v = q.last, p = q.prev;
      if (kind === "rate" && v > 20) { v /= 10; if (p) p /= 10; }
      const val = kind === "idx" ? nf(v, 0) : kind === "usd1" ? nf(v, 1) + " $" : kind === "usd0" ? nf(v, 0) + " $" : kind === "fx" ? nf(v, 3) : nf(v, 2) + " %";
      const c = kind === "rate" ? (p ? (v - p >= 0 ? "+" : "−") + nf(Math.abs(v - p), 2) + " pt" : "") : p ? spct((v / p - 1) * 100) : "";
      items.push({ n, v: val, c }); if (sym === "^FCHI") date = q.date;
    } catch (e) { console.log("cours indisponible :", n, e.message); items.push(keep); }
  }
  return { date, items };
}

async function gemini(cands) {
  const key = process.env.GEMINI_API_KEY; if (!key || !cands.length) return null;
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const list = cands.map((c, i) => `[${i}] ${c.src} (${c.date}) : ${c.title}${c.desc ? " — " + c.desc : ""}`).join("\n");
  const prompt = `Tu prépares la rubrique Finance d'une appli pour un lycéen qui apprend le trading. Voici des titres de presse économique des derniers jours :
${list}

Choisis 3 sujets variés et importants (marchés, taux, matières premières, devises, entreprises). Pour chacun, écris avec TES PROPRES MOTS (aucune citation de plus de 10 mots, pas de copie), à partir de ces seules informations, sans inventer de chiffres :
- "ref" : numéro du titre utilisé
- "t" : {"fr","en"} un titre clair
- "s" : {"fr","en"} un résumé de 2 à 3 phrases
- "d" : {"fr","en"} un décryptage pédagogique pour un débutant en trading (2 phrases)
- "v" : 4 paires ["terme français","English term"] de vocabulaire financier
- "q" : {"fr","en"} une question pour réfléchir, "r" : {"fr","en"} sa réponse
Ajoute "actu" : une question à choix multiple sur l'un de ces sujets : {"ref", "q", "choices": [4 réponses courtes], "a": index de la bonne réponse, "expl": explication en 2 phrases}. Varie la place de la bonne réponse.
Réponds uniquement en JSON : {"articles":[...], "actu":{...}}`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, responseMimeType: "application/json" } }),
  });
  if (!r.ok) { console.log("Gemini indisponible :", r.status, (await r.text()).slice(0, 200)); return null; }
  const j = await r.json();
  const text = (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  try { return JSON.parse(text.replace(/^```(json)?|```$/g, "").trim()); } catch { console.log("Réponse Gemini illisible"); return null; }
}
const ok2 = o => o && typeof o.fr === "string" && typeof o.en === "string";

let old = {}; try { old = JSON.parse(await readFile(FILE, "utf8")); } catch {}
const cands = (await readFeeds()).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 24);
const snap = await markets(old.snap);
let fresh = [], actu = old.actu || null;
const ai = await gemini(cands);
if (ai && Array.isArray(ai.articles)) {
  for (const a of ai.articles.slice(0, 3)) {
    const c = cands[a.ref]; if (!c || !ok2(a.t) || !ok2(a.s)) continue;
    fresh.push({ id: c.date + "-" + slug(a.t.fr), src: c.src, date: c.date, url: c.link, t: a.t, s: a.s, d: ok2(a.d) ? a.d : undefined, v: Array.isArray(a.v) ? a.v.filter(p => Array.isArray(p) && p.length === 2).slice(0, 5) : [], q: ok2(a.q) ? a.q : undefined, r: ok2(a.r) ? a.r : undefined });
  }
  const q = ai.actu, c = q && cands[q.ref];
  if (q && c && typeof q.q === "string" && Array.isArray(q.choices) && q.choices.length === 4 && q.a >= 0 && q.a < 4)
    actu = { date: today, q: q.q, choices: q.choices.map(String), a: q.a, expl: String(q.expl || ""), src: c.src, url: c.link };
} else {
  fresh = cands.slice(0, 3).map(c => ({ id: c.date + "-" + slug(c.title), src: c.src, date: c.date, url: c.link, t: { fr: c.title, en: c.title } }));
}
const prevArts = (old.articles || []).filter(a => a && a.id), oldUrls = new Set(prevArts.map(a => a.url)), ids = new Set(), articles = [];
for (const a of [...fresh.filter(a => !oldUrls.has(a.url)), ...prevArts]) { if (ids.has(a.id)) continue; ids.add(a.id); articles.push(a); }
articles.sort((a, b) => b.date.localeCompare(a.date));
const out = { updated: new Date().toISOString(), snap, articles: articles.slice(0, 15), actu };
await writeFile(FILE, JSON.stringify(out, null, 1) + "\n");
console.log(`OK : ${fresh.length} nouveaux articles, ${out.articles.length} au total, IA ${ai ? "oui" : "non"}`);
