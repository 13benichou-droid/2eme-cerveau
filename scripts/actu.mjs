// 2ème cerveau : mise à jour quotidienne de l'actu (lancée chaque matin par GitHub Actions).
// 1. Lit les flux RSS de journaux économiques.  2. Récupère les cours des marchés.
// 3. Fait écrire 3 résumés FR/EN + une question d'actu par la première IA qui répond :
//    Gemini (secret GEMINI_API_KEY, plusieurs modèles), puis ton relais Cloudflare (secret RELAIS_LIEN :
//    Mistral → Cerebras → Groq → OpenRouter), puis les clés directes s'il y en a dans les secrets GitHub
//    (MISTRAL_API_KEY, CEREBRAS_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY).
//    Les articles restés sans résumé (aucune IA disponible ce jour-là) sont rattrapés les jours suivants.
//    Si aucune IA ne répond, garde les titres et les liens.  4. Écrit data/news.json (30 articles maximum).
import { readFile, writeFile } from "node:fs/promises";

const FILE = "data/news.json";
const UA = { "User-Agent": "Mozilla/5.0 (2eme-cerveau; +https://github.com)" };
const FEEDS = [
  // Une source qui ne répond pas est simplement ignorée ce jour-là.
  ["Le Monde", "https://www.lemonde.fr/economie/rss_full.xml"],
  ["Le Figaro", "https://www.lefigaro.fr/rss/figaro_economie.xml"],
  ["franceinfo", "https://www.francetvinfo.fr/economie.rss"],
  ["Financial Times", "https://www.ft.com/markets?format=rss"],
  ["CNBC", "https://www.cnbc.com/id/20910258/device/rss/rss.html"],
  ["Yahoo Finance", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=%5EGSPC,%5EFCHI&region=US&lang=en-US"],
  ["The Guardian", "https://www.theguardian.com/uk/business/rss"],
  ["BBC", "https://feeds.bbci.co.uk/news/business/rss.xml"],
];
const MARKETS = [
  ["CAC 40", "^FCHI", "idx"], ["S&P 500", "^GSPC", "idx"], ["Nasdaq", "^IXIC", "idx"], ["VIX (peur)", "^VIX", "pts"],
  ["Brent", "BZ=F", "usd1"], ["Pétrole WTI", "CL=F", "usd1"], ["Or (once)", "GC=F", "usd0"], ["Bitcoin", "BTC-USD", "usd0"],
  ["US 10 ans", "^TNX", "rate"], ["EUR/USD", "EURUSD=X", "fx"],
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
async function markets(old) {
  const prevItems = (old && old.items) || [];
  const items = []; let date = (old && old.date) || today;
  for (const [n, sym, kind] of MARKETS) {
    const keep = prevItems.find(x => x.n === n) || { n, v: "—", c: "" };
    try {
      const q = await quote(sym);
      let v = q.last, p = q.prev;
      if (kind === "rate" && v > 20) { v /= 10; if (p) p /= 10; }
      const val = kind === "idx" ? nf(v, 0) : kind === "usd1" ? nf(v, 1) + " $" : kind === "usd0" ? nf(v, 0) + " $" : kind === "fx" ? nf(v, 3) : kind === "pts" ? nf(v, 2) : nf(v, 2) + " %";
      const c = kind === "rate" ? (p ? (v - p >= 0 ? "+" : "−") + nf(Math.abs(v - p), 2) + " pt" : "") : p ? spct((v / p - 1) * 100) : "";
      items.push({ n, v: val, c }); if (sym === "^FCHI") date = q.date;
    } catch (e) { console.log("cours indisponible :", n, e.message); items.push(keep); }
  }
  return { date, items };
}

/* ---------- les IA, dans l'ordre : la première qui répond un JSON lisible gagne ---------- */
const env = k => String(process.env[k] || "").trim();
async function post(url, headers, body, ms = 120000) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: c.signal }); }
  finally { clearTimeout(t); }
}
const short = async r => (await r.text()).slice(0, 160).replace(/\s+/g, " ");

async function viaGemini(prompt) {
  const key = env("GEMINI_API_KEY"); if (!key) return [];
  const models = [...new Set([env("GEMINI_MODEL"), "gemini-3.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"].filter(Boolean))];
  return models.map(model => ({ nom: "Gemini · " + model, run: async () => {
    const r = await post(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, { "x-goog-api-key": key },
      { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.4, responseMimeType: "application/json" } });
    if (!r.ok) throw new Error(r.status + " " + await short(r));
    const j = await r.json();
    return (j.candidates?.[0]?.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  } }));
}

/* le relais Cloudflare : le même que celui de l'appli (lien « pour ton autre appareil » : adresse#code) */
function viaRelais(prompt) {
  const lien = env("RELAIS_LIEN"), k = lien.indexOf("#"); if (k < 0) return [];
  const url = lien.slice(0, k), code = lien.slice(k + 1);
  const owner = env("GITHUB_REPOSITORY_OWNER").toLowerCase();
  const origine = env("RELAIS_ORIGINE") || (owner ? `https://${owner}.github.io` : "");
  return [{ nom: "relais", run: async () => {
    const r = await post(url, { "x-relais": code, origin: origine }, { messages: [{ role: "user", content: prompt }], temperature: 0.4, max_tokens: 6000 });
    if (!r.ok) { let m = ""; try { const j = await r.json(); m = (j.erreur || "") + (j.essais ? " · " + j.essais.join(" | ") : ""); } catch { } throw new Error(r.status + " " + m.slice(0, 300)); }
    const ia = (r.headers.get("x-relais-ia") || "relais").replace(" | ", " · ");
    let text = "";
    for (const line of (await r.text()).split("\n")) {
      const l = line.trim(); if (!l.startsWith("data:")) continue;
      const d = l.slice(5).trim(); if (!d || d === "[DONE]") continue;
      try { text += JSON.parse(d).choices?.[0]?.delta?.content || ""; } catch { }
    }
    return { text, ia };
  } }];
}

const DIRECT = [
  { nom: "Mistral", cle: "MISTRAL_API_KEY", url: "https://api.mistral.ai/v1", modele: "mistral-small-latest" },
  { nom: "Cerebras", cle: "CEREBRAS_API_KEY", url: "https://api.cerebras.ai/v1", modele: "gpt-oss-120b" },
  { nom: "Groq", cle: "GROQ_API_KEY", url: "https://api.groq.com/openai/v1", modele: "llama-3.3-70b-versatile" },
  { nom: "OpenRouter", cle: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1", modele: "openrouter/free" },
];
function viaDirect(prompt) {
  return DIRECT.filter(x => env(x.cle)).map(x => ({ nom: x.nom + " · " + x.modele, run: async () => {
    const r = await post(x.url + "/chat/completions", { authorization: "Bearer " + env(x.cle) }, { model: x.modele, messages: [{ role: "user", content: prompt }], temperature: 0.4 });
    if (!r.ok) throw new Error(r.status + " " + await short(r));
    return (await r.json()).choices?.[0]?.message?.content || "";
  } }));
}

function lireJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/g, ""), a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
async function demanderIA(prompt) {
  const essais = [...await viaGemini(prompt), ...viaRelais(prompt), ...viaDirect(prompt)];
  if (!essais.length) { console.log("Aucune IA configurée (secrets GEMINI_API_KEY, RELAIS_LIEN…)."); return null; }
  for (const e of essais) {
    try {
      const out = await e.run(), text = typeof out === "string" ? out : out.text, nom = typeof out === "string" ? e.nom : out.ia;
      const data = lireJSON(text);
      if (data) { console.log("IA utilisée :", nom); return { data, ia: nom.split(" · ")[0] }; }
      console.log(nom, ": réponse illisible");
    } catch (err) { console.log(e.nom, "indisponible :", String(err && err.message || err).slice(0, 300)); }
  }
  return null;
}

function consigne(cands, todo) {
  const champs = `- "t" : {"fr","en"} un titre clair
- "s" : {"fr","en"} un résumé de 2 à 3 phrases
- "d" : {"fr","en"} un décryptage pédagogique pour un débutant en trading (2 phrases)
- "v" : 4 paires ["terme français","English term"] de vocabulaire financier
- "q" : {"fr","en"} une question pour réfléchir, "r" : {"fr","en"} sa réponse`;
  const parts = [`Tu prépares la rubrique Finance d'une appli pour un lycéen qui apprend le trading. Écris avec TES PROPRES MOTS (aucune citation de plus de 10 mots, pas de copie), à partir des seules informations données, sans inventer de chiffres.`];
  if (cands.length) parts.push(`Voici des titres de presse économique des derniers jours :
${cands.map((c, i) => `[${i}] ${c.src} (${c.date}) : ${c.title}${c.desc ? " — " + c.desc : ""}`).join("\n")}

Choisis 3 sujets variés et importants (marchés, taux, matières premières, devises, entreprises). Pour chacun, dans "articles" :
- "ref" : numéro du titre utilisé
${champs}
Ajoute "actu" : une question à choix multiple sur l'un de ces sujets : {"ref", "q", "choices": [4 réponses courtes], "a": index de la bonne réponse, "expl": explication en 2 phrases}. Varie la place de la bonne réponse.`);
  if (todo.length) parts.push(`Ces articles déjà affichés n'ont pas encore de résumé :
${todo.map((a, i) => `[R${i}] ${a.src} (${a.date}) : ${a.t.fr || a.t.en}${a.desc ? " — " + a.desc : ""}`).join("\n")}

Pour CHACUN, dans "complements", écris un objet avec "ref" ("R0", "R1"…) et les mêmes champs :
${champs}
Si seul le titre est connu, le résumé reformule le titre en 1 ou 2 phrases sans ajouter de fait ni de chiffre, et le décryptage explique le contexte général.`);
  parts.push(`Réponds uniquement en JSON : {${cands.length ? '"articles":[...], "actu":{...}' : ""}${cands.length && todo.length ? ", " : ""}${todo.length ? '"complements":[...]' : ""}}`);
  return parts.join("\n\n");
}
const ok2 = o => o && typeof o.fr === "string" && typeof o.en === "string";

let old = {}; try { old = JSON.parse(await readFile(FILE, "utf8")); } catch {}
const prevArts = (old.articles || []).filter(a => a && a.id && a.t), byUrl = new Map(prevArts.map(a => [a.url, a]));
/* les sujets déjà résumés ne sont plus proposés : l'IA choisit des articles nouveaux */
const cands = (await readFeeds()).filter(c => !(byUrl.get(c.link) || {}).s).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 24);
const snap = await markets(old.snap);
/* rattrapage : les articles encore affichés qui n'ont pas de résumé (6 au plus par jour) */
const todo = prevArts.filter(a => !a.s).slice(0, 6);
for (const a of todo) { const c = cands.find(c => c.link === a.url); if (c && c.desc && !a.desc) a.desc = c.desc; }
const champsOK = a => ok2(a.t) && ok2(a.s);
const remplir = (a, ia) => ({ t: a.t, s: a.s, d: ok2(a.d) ? a.d : undefined, v: Array.isArray(a.v) ? a.v.filter(p => Array.isArray(p) && p.length === 2).map(p => p.map(String)).slice(0, 5) : [], q: ok2(a.q) ? a.q : undefined, r: ok2(a.r) ? a.r : undefined, ia });
let fresh = [], actu = old.actu || null, rattrapes = 0;
const ai = cands.length || todo.length ? await demanderIA(consigne(cands, todo)) : null;
const out0 = ai && ai.data;
if (out0 && Array.isArray(out0.articles)) {
  for (const a of out0.articles.slice(0, 3)) {
    const c = cands[a.ref]; if (!c || !champsOK(a)) continue;
    const vieux = byUrl.get(c.link);
    if (vieux) { Object.assign(vieux, remplir(a, ai.ia)); rattrapes++; continue; }
    fresh.push({ id: c.date + "-" + slug(a.t.fr), src: c.src, date: c.date, url: c.link, ...remplir(a, ai.ia) });
  }
  const q = out0.actu, c = q && cands[q.ref];
  if (q && c && typeof q.q === "string" && Array.isArray(q.choices) && q.choices.length === 4 && q.a >= 0 && q.a < 4)
    actu = { date: today, q: q.q, choices: q.choices.map(String), a: q.a, expl: String(q.expl || ""), src: c.src, url: c.link };
}
if (out0 && Array.isArray(out0.complements)) {
  for (const a of out0.complements) {
    const m = String(a && a.ref || "").match(/^R?(\d+)$/), cible = m && todo[+m[1]];
    if (cible && !cible.s && champsOK(a)) { Object.assign(cible, remplir(a, ai.ia)); if (!cible.desc) cible.iat = 1; rattrapes++; }
  }
}
if (!fresh.length && !(out0 && Array.isArray(out0.articles))) {
  /* aucune IA : on garde le titre, le lien et le chapeau du journal, pour un rattrapage demain */
  fresh = cands.slice(0, 3).map(c => ({ id: c.date + "-" + slug(c.title), src: c.src, date: c.date, url: c.link, t: { fr: c.title, en: c.title }, ...(c.desc ? { desc: c.desc } : {}) }));
}
const ids = new Set(), articles = [];
for (const a of [...fresh.filter(a => !byUrl.has(a.url)), ...prevArts]) {
  if (ids.has(a.id)) continue; ids.add(a.id);
  for (const k of Object.keys(a)) if (a[k] === undefined) delete a[k];
  articles.push(a);
}
articles.sort((a, b) => b.date.localeCompare(a.date));
const out = { updated: new Date().toISOString(), snap, articles: articles.slice(0, 30), actu };
await writeFile(FILE, JSON.stringify(out, null, 1) + "\n");
console.log(`OK : ${fresh.length} nouveaux articles, ${rattrapes} rattrapés, ${out.articles.length} au total, IA ${ai ? ai.ia : "aucune"}, sans résumé : ${out.articles.filter(a => !a.s).length}`);
