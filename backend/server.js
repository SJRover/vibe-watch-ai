import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

// ESM dirname/filename
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load backend/.env locally, Render uses Dashboard env vars
dotenv.config({ path: path.join(__dirname, ".env") });

// Fail fast locally, but do not crash Render if you are still setting env vars
if (!process.env.OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY missing");
if (!process.env.TMDB_API_KEY) console.warn("⚠️ TMDB_API_KEY missing");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS for GitHub Pages + anywhere else
app.use(cors({ origin: true }));
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/* ================================
   Tiny TTL cache (speeds up TMDB)
   ================================ */
class TTLCache {
  constructor(ms) {
    this.ms = ms;
    this.map = new Map();
  }
  get(k) {
    const v = this.map.get(k);
    if (!v) return null;
    if (Date.now() > v.exp) {
      this.map.delete(k);
      return null;
    }
    return v.val;
  }
  set(k, val) {
    this.map.set(k, { val, exp: Date.now() + this.ms });
  }
}
const cache2h = new TTLCache(2 * 60 * 60 * 1000);
const cache10m = new TTLCache(10 * 60 * 1000);

/* ================================
   Helpers
   ================================ */
function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function hashToInt(str = "") {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 100000;
}

async function tmdbJson(url, { cache = null, cacheKey = null } = {}) {
  if (cache && cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit) return hit;
  }

  const r = await fetch(url);

  if (!r.ok) {
    const status = r.status;
    if (status >= 500) {
      console.warn(`TMDB soft-fail ${status}: ${url}`);
      return { results: [] };
    }
    // 401, 403, 404, etc should be visible
    const txt = await r.text().catch(() => "");
    throw new Error(`TMDB error ${status}: ${url} ${txt}`);
  }

  const data = await r.json();
  if (cache && cacheKey) cache.set(cacheKey, data);
  return data;
}

function uniqByKey(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

function scoreCandidate(c) {
  const votes = c.vote_count || 0;
  const rating = c.vote_average || 0;
  const pop = c.popularity || 0;
  return rating * 2.2 + Math.log10(votes + 1) + pop / 140;
}

/* ================================
   Fallback pools so you NEVER return 0
   ================================ */
async function trendingFallback(tmdbKey, mediaType = "any", page = 1) {
  const url = `https://api.themoviedb.org/3/trending/all/day?api_key=${tmdbKey}&page=${page}`;
  const data = await tmdbJson(url, { cache: cache10m, cacheKey: `trend:${page}` });

  let items = (data.results || [])
    .filter((x) => !x.adult)
    .filter((x) => x.media_type === "movie" || x.media_type === "tv");

  if (mediaType === "movie") items = items.filter((x) => x.media_type === "movie");
  if (mediaType === "tv") items = items.filter((x) => x.media_type === "tv");

  return items;
}

async function popularFallback(tmdbKey, mediaType = "any", page = 1) {
  const out = [];

  if (mediaType !== "tv") {
    const m = await tmdbJson(
      `https://api.themoviedb.org/3/movie/popular?api_key=${tmdbKey}&page=${page}&include_adult=false`,
      { cache: cache10m, cacheKey: `pop:movie:${page}` }
    );
    out.push(...(m.results || []).map((r) => ({ ...r, media_type: "movie" })));
  }

  if (mediaType !== "movie") {
    const t = await tmdbJson(
      `https://api.themoviedb.org/3/tv/popular?api_key=${tmdbKey}&page=${page}&include_adult=false`,
      { cache: cache10m, cacheKey: `pop:tv:${page}` }
    );
    out.push(...(t.results || []).map((r) => ({ ...r, media_type: "tv" })));
  }

  return out.filter((x) => !x.adult);
}

/* ================================
   Genre IDs (TMDB)
   ================================ */
const GENRE = {
  ANIMATION: 16,
  FAMILY: 10751,
  COMEDY: 35,
  DRAMA: 18,
  ACTION: 28,
  ADVENTURE: 12,
  THRILLER: 53,
  CRIME: 80,
  MYSTERY: 9648,
  HORROR: 27,
  ROMANCE: 10749,
  FANTASY: 14,
  SCIFI: 878,
  WAR: 10752,
  HISTORY: 36,
  MUSIC: 10402,
  DOCUMENTARY: 99
};

/* ================================
   Kids helpers (GB)
   ================================ */
function gbMaxCertFromAge(maxAge) {
  if (!maxAge || Number.isNaN(Number(maxAge))) return null;
  const a = Number(maxAge);
  if (a <= 7) return "U";
  if (a <= 11) return "PG";
  if (a <= 13) return "12A";
  if (a <= 14) return "12";
  if (a <= 16) return "15";
  return "18";
}

const GB_CERT_ORDER = ["U", "PG", "12A", "12", "15", "18"];
function gbCertAllowed(cert, maxCert) {
  if (!maxCert) return true;
  if (!cert) return true;
  const a = GB_CERT_ORDER.indexOf(cert);
  const b = GB_CERT_ORDER.indexOf(maxCert);
  if (a === -1 || b === -1) return true;
  return a <= b;
}

function tvAllowedForKids(rating) {
  if (!rating) return true;
  const r = String(rating).toUpperCase();
  const bad = ["TV-MA", "NC-17", "R", "18", "MA15+", "M"];
  return !bad.some((x) => r.includes(x));
}

const KIDS_WITH_GENRES = "16,10751";
const KIDS_WITHOUT_GENRES = "27,53,80,9648,10752";

async function getMovieCertification(tmdbKey, id, region = "GB") {
  const ck = `cert:movie:${region}:${id}`;
  const cached = cache2h.get(ck);
  if (cached !== null) return cached;

  const url = `https://api.themoviedb.org/3/movie/${id}/release_dates?api_key=${tmdbKey}`;
  const data = await tmdbJson(url, { cache: cache2h, cacheKey: ck });
  const entry = (data.results || []).find((x) => x.iso_3166_1 === region);
  if (!entry) return null;
  const certs = (entry.release_dates || [])
    .map((r) => (r.certification || "").trim())
    .filter(Boolean);
  return certs[0] || null;
}

async function getTvContentRating(tmdbKey, id, region = "GB") {
  const ck = `cert:tv:${region}:${id}`;
  const cached = cache2h.get(ck);
  if (cached !== null) return cached;

  const url = `https://api.themoviedb.org/3/tv/${id}/content_ratings?api_key=${tmdbKey}`;
  const data = await tmdbJson(url, { cache: cache2h, cacheKey: ck });
  const entry = (data.results || []).find((x) => x.iso_3166_1 === region);
  return entry?.rating ? String(entry.rating).trim() : null;
}

/* ================================
   Providers (cached)
   ================================ */
async function getWatchProviders(tmdbKey, mediaType, id, region = "GB") {
  const ck = `prov:${mediaType}:${region}:${id}`;
  const hit = cache2h.get(ck);
  if (hit) return hit;

  const url = `https://api.themoviedb.org/3/${mediaType}/${id}/watch/providers?api_key=${tmdbKey}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const regionData = data?.results?.[region];
  const providers = regionData?.flatrate ? regionData.flatrate.map((p) => p.provider_name) : [];
  cache2h.set(ck, providers);
  return providers;
}

/* ================================
   Person + keyword resolution
   ================================ */
async function resolvePersonId(tmdbKey, name) {
  if (!name) return null;
  const safe = encodeURIComponent(name);
  const url = `https://api.themoviedb.org/3/search/person?api_key=${tmdbKey}&query=${safe}&page=1&include_adult=false`;
  const data = await tmdbJson(url, { cache: cache2h, cacheKey: `person:${name.toLowerCase()}` });
  const best = (data.results || [])[0];
  return best?.id || null;
}

async function resolveKeywordId(tmdbKey, keyword) {
  if (!keyword) return null;
  const safe = encodeURIComponent(keyword);
  const url = `https://api.themoviedb.org/3/search/keyword?api_key=${tmdbKey}&query=${safe}&page=1`;
  const data = await tmdbJson(url, { cache: cache2h, cacheKey: `kw:${keyword.toLowerCase()}` });
  const best = (data.results || [])[0];
  return best?.id || null;
}

/* ================================
   Expand dislikes -> similar titles
   ================================ */
async function expandSimilarExcludes(tmdbKey, disliked) {
  const out = new Set();
  for (const d of (disliked || []).slice(0, 25)) {
    const id = d?.id;
    const mt = d?.media_type;
    if (!id || (mt !== "movie" && mt !== "tv")) continue;
    try {
      const url = `https://api.themoviedb.org/3/${mt}/${id}/similar?api_key=${tmdbKey}&page=1`;
      const data = await tmdbJson(url, { cache: cache2h, cacheKey: `sim:${mt}:${id}` });
      for (const r of (data.results || []).slice(0, 12)) out.add(String(r.id));
    } catch {}
  }
  return out;
}

/* ================================
   Search engines
   ================================ */
async function searchMulti(tmdbKey, query, page) {
  const safe = encodeURIComponent(query);
  const url = `https://api.themoviedb.org/3/search/multi?api_key=${tmdbKey}&query=${safe}&include_adult=false&page=${page}`;
  const data = await tmdbJson(url);
  return data.results || [];
}

async function searchMovie(tmdbKey, query, page, year) {
  const safe = encodeURIComponent(query);
  const yearPart = year ? `&year=${encodeURIComponent(year)}` : "";
  const url = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${safe}&include_adult=false&page=${page}${yearPart}`;
  const data = await tmdbJson(url);
  return (data.results || []).map((r) => ({ ...r, media_type: "movie" }));
}

async function searchTv(tmdbKey, query, page) {
  const safe = encodeURIComponent(query);
  const url = `https://api.themoviedb.org/3/search/tv?api_key=${tmdbKey}&query=${safe}&include_adult=false&page=${page}`;
  const data = await tmdbJson(url);
  return (data.results || []).map((r) => ({ ...r, media_type: "tv" }));
}

/* ================================
   Discover
   ================================ */
async function discoverMovie(tmdbKey, opts) {
  const {
    page,
    region,
    kids,
    maxCert,
    yearMin,
    yearMax,
    niche,
    withGenres,
    withoutGenres,
    withCastId,
    withKeywords
  } = opts;

  const certPart =
    kids && maxCert
      ? `&certification_country=${region}&certification.lte=${encodeURIComponent(maxCert)}`
      : "";

  const kidsGenres = kids
    ? `&with_genres=${KIDS_WITH_GENRES}&without_genres=${KIDS_WITHOUT_GENRES}`
    : "";

  const yearPart =
    yearMin || yearMax
      ? `&primary_release_date.gte=${encodeURIComponent(yearMin || "1900-01-01")}&primary_release_date.lte=${encodeURIComponent(yearMax || "2100-12-31")}`
      : "";

  const sortBy = niche ? "popularity.asc" : "popularity.desc";

  const gPart = withGenres?.length ? `&with_genres=${encodeURIComponent(withGenres.join(","))}` : "";
  const ngPart = withoutGenres?.length ? `&without_genres=${encodeURIComponent(withoutGenres.join(","))}` : "";
  const castPart = withCastId ? `&with_cast=${encodeURIComponent(String(withCastId))}` : "";
  const kwPart = withKeywords?.length ? `&with_keywords=${encodeURIComponent(withKeywords.join(","))}` : "";

  const url =
    `https://api.themoviedb.org/3/discover/movie?api_key=${tmdbKey}` +
    `&include_adult=false&page=${page}` +
    `&sort_by=${sortBy}` +
    `&vote_count.gte=${niche ? 15 : 60}` +
    yearPart +
    certPart +
    kidsGenres +
    gPart +
    ngPart +
    castPart +
    kwPart;

  const data = await tmdbJson(url);
  return (data.results || []).map((r) => ({ ...r, media_type: "movie" }));
}

async function discoverTv(tmdbKey, opts) {
  const { page, kids, yearMin, yearMax, niche, withGenres, withoutGenres, withPersonId, withKeywords } = opts;

  const kidsGenres = kids
    ? `&with_genres=${KIDS_WITH_GENRES}&without_genres=${KIDS_WITHOUT_GENRES}`
    : "";

  const yearPart =
    yearMin || yearMax
      ? `&first_air_date.gte=${encodeURIComponent(yearMin || "1900-01-01")}&first_air_date.lte=${encodeURIComponent(yearMax || "2100-12-31")}`
      : "";

  const sortBy = niche ? "popularity.asc" : "popularity.desc";

  const gPart = withGenres?.length ? `&with_genres=${encodeURIComponent(withGenres.join(","))}` : "";
  const ngPart = withoutGenres?.length ? `&without_genres=${encodeURIComponent(withoutGenres.join(","))}` : "";
  const personPart = withPersonId ? `&with_people=${encodeURIComponent(String(withPersonId))}` : "";
  const kwPart = withKeywords?.length ? `&with_keywords=${encodeURIComponent(withKeywords.join(","))}` : "";

  const url =
    `https://api.themoviedb.org/3/discover/tv?api_key=${tmdbKey}` +
    `&include_adult=false&page=${page}` +
    `&sort_by=${sortBy}` +
    `&vote_count.gte=${niche ? 10 : 40}` +
    yearPart +
    kidsGenres +
    gPart +
    ngPart +
    personPart +
    kwPart;

  const data = await tmdbJson(url);
  return (data.results || []).map((r) => ({ ...r, media_type: "tv" }));
}

/* ================================
   Validators
   ================================ */
function yearOf(item) {
  const d = item.release_date || item.first_air_date || "";
  return d && d.length >= 4 ? Number(d.slice(0, 4)) : null;
}
function hasGenre(item, genreId) {
  const ids = item.genre_ids || [];
  return ids.includes(genreId);
}

function moodToHints(mood) {
  const m = clamp(Number(mood || 3), 1, 5);
  if (m <= 2) return { prefer: ["warm", "comfort", "gentle pacing"], avoid: ["relentless", "stressful"] };
  if (m === 3) return { prefer: ["balanced pacing"], avoid: [] };
  if (m === 4) return { prefer: ["energy", "plot momentum"], avoid: ["slow burn"] };
  return { prefer: ["intense", "high stakes", "fast pacing"], avoid: ["sleepy"] };
}

/* ================================
   Candidate gathering
   ================================ */
async function buildCandidates(tmdbKey, intent, region, refreshToken, mood, liked = [], disliked = [], watched = []) {
  const seed = hashToInt(`${(intent.searchQueries || []).join("|")}|${refreshToken}|${mood}`);
  const pageStart = (seed % 10) + 1;

  const mediaType = intent.mediaType || "any";
  const kids = Boolean(intent.kidsMode);
  const gbMaxCert = kids ? gbMaxCertFromAge(intent.kidsMaxAge) : null;
  const niche = Boolean(intent.nicheMode);

  const yearMin = intent.yearMin ? `${intent.yearMin}-01-01` : null;
  const yearMax = intent.yearMax ? `${intent.yearMax}-12-31` : null;

  const actorName = intent.actorName || null;
  const actorId = actorName ? await resolvePersonId(tmdbKey, actorName) : null;

  const keywordIds = [];
  for (const kw of (intent.themeKeywords || []).slice(0, 3)) {
    const kid = await resolveKeywordId(tmdbKey, kw);
    if (kid) keywordIds.push(kid);
  }

  const withGenres = Array.isArray(intent.withGenres) ? intent.withGenres.slice(0, 5) : [];
  const withoutGenres = Array.isArray(intent.withoutGenres) ? intent.withoutGenres.slice(0, 7) : [];

  const p = String(intent.rawPrompt || "").toLowerCase();
  if (p.includes("cartoon") || p.includes("animation") || p.includes("animated")) {
    if (!withGenres.includes(GENRE.ANIMATION)) withGenres.push(GENRE.ANIMATION);
  }

  const dislikedGenres = {};
  for (const d of disliked.slice(0, 60)) {
    for (const gid of (d.genre_ids || [])) dislikedGenres[gid] = (dislikedGenres[gid] || 0) + 1;
  }
  const hardAvoid = Object.entries(dislikedGenres)
    .filter(([, c]) => c >= 6)
    .map(([gid]) => Number(gid))
    .filter((gid) => !withGenres.includes(gid));

  const avoidGenresMerged = uniqByKey([...withoutGenres, ...hardAvoid], (x) => String(x)).slice(0, 10);

  const queries =
    Array.isArray(intent.searchQueries) && intent.searchQueries.length
      ? intent.searchQueries.slice(0, 5)
      : [intent.searchHint || intent.rawPrompt || ""];

  let pool = [];

  for (const q of queries) {
    if (!q || !String(q).trim()) continue;

    for (let i = 0; i < 3; i++) {
      const page = clamp(pageStart + i, 1, 20);
      if (mediaType === "movie") pool.push(...(await searchMovie(tmdbKey, q, page, intent.yearExact || null)));
      else if (mediaType === "tv") pool.push(...(await searchTv(tmdbKey, q, page)));
      else pool.push(...(await searchMulti(tmdbKey, q, page)));
    }
  }

  for (let i = 0; i < 5; i++) {
    const page = clamp(((seed + i * 7) % 20) + 1, 1, 20);

    if (mediaType !== "tv") {
      pool.push(
        ...(await discoverMovie(tmdbKey, {
          page,
          region,
          kids,
          maxCert: gbMaxCert,
          yearMin,
          yearMax,
          niche,
          withGenres,
          withoutGenres: avoidGenresMerged,
          withCastId: actorId || null,
          withKeywords: keywordIds
        }))
      );
    }
    if (mediaType !== "movie") {
      pool.push(
        ...(await discoverTv(tmdbKey, {
          page,
          kids,
          yearMin,
          yearMax,
          niche,
          withGenres,
          withoutGenres: avoidGenresMerged,
          withPersonId: actorId || null,
          withKeywords: keywordIds
        }))
      );
    }
  }

  pool = pool
    .map((c) => {
      const mt = c.media_type || (c.title ? "movie" : c.name ? "tv" : null);
      return mt ? { ...c, media_type: mt } : null;
    })
    .filter(Boolean)
    .filter((c) => c.media_type === "movie" || c.media_type === "tv");

  pool = uniqByKey(pool, (c) => `${c.media_type}:${c.id}`);

  pool = pool.filter((c) => {
    if (intent.yearExact) {
      const y = yearOf(c);
      if (y && y !== Number(intent.yearExact)) return false;
    }
    if (withGenres.includes(GENRE.ANIMATION)) {
      if (!hasGenre(c, GENRE.ANIMATION)) return false;
    }
    return true;
  });

  pool.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
  return pool.slice(0, 750);
}

/* ================================
   ROUTES
   ================================ */
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.post("/api/recommend", async (req, res) => {
  const {
    prompt,
    mood = 3,
    localHour = null,
    liked = [],
    disliked = [],
    watched = [],
    excludeIds = [],
    region = "GB",
    refreshToken = "",
    providerInclude = [],
    providerExclude = []
  } = req.body;

  if (!prompt || !prompt.trim()) return res.status(400).json({ error: "Missing prompt" });

  const tmdbKey = process.env.TMDB_API_KEY;
  if (!tmdbKey) return res.status(500).json({ error: "TMDB_API_KEY missing on server" });

  try {
    // 1) Intent extraction
    let intent = {
      mediaType: "any",
      searchHint: prompt,
      searchQueries: [prompt],
      kidsMode: false,
      kidsMaxAge: null,
      nicheMode: false,
      yearMin: null,
      yearMax: null,
      yearExact: null,
      actorName: null,
      withGenres: [],
      withoutGenres: [],
      themeKeywords: [],
      providerInclude: [],
      providerExclude: []
    };

    if (process.env.OPENAI_API_KEY) {
      const intentResp = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content:
              "Return ONLY JSON with keys:\n" +
              "mediaType ('movie'|'tv'|'any'),\n" +
              "searchHint (string),\n" +
              "searchQueries (array of 3-6 short queries),\n" +
              "kidsMode (boolean), kidsMaxAge (number|null),\n" +
              "nicheMode (boolean),\n" +
              "yearMin (number|null), yearMax (number|null), yearExact (number|null),\n" +
              "actorName (string|null),\n" +
              "withGenres (array of TMDB genre ids),\n" +
              "withoutGenres (array of TMDB genre ids),\n" +
              "themeKeywords (array of 1-3 keywords),\n" +
              "providerInclude (array of provider names), providerExclude (array of provider names).\n\n" +
              "Rules:\n" +
              "- If user asks for cartoons or animated include genre 16 in withGenres.\n" +
              "- searchQueries must be specific."
          },
          { role: "user", content: JSON.stringify({ prompt, mood, localHour }) }
        ]
      });

      try {
        intent = JSON.parse(intentResp.output[0].content[0].text);
      } catch {}
    }

    intent.rawPrompt = prompt;

    if (!["movie", "tv", "any"].includes(intent.mediaType)) intent.mediaType = "any";
    if (!intent.searchHint || !String(intent.searchHint).trim()) intent.searchHint = prompt;
    if (!Array.isArray(intent.searchQueries) || intent.searchQueries.length < 1) intent.searchQueries = [intent.searchHint];
    if (!Array.isArray(intent.withGenres)) intent.withGenres = [];
    if (!Array.isArray(intent.withoutGenres)) intent.withoutGenres = [];
    if (!Array.isArray(intent.themeKeywords)) intent.themeKeywords = [];

    // kids safety net
    const pLower = prompt.toLowerCase();
    if ((pLower.includes("kid") || pLower.includes("child") || pLower.includes("children")) && !intent.kidsMode) {
      intent.kidsMode = true;
      if (!intent.kidsMaxAge) intent.kidsMaxAge = 11;
    }

    // Merge provider filters from UI + intent
    const mergedInclude = Array.from(new Set([...(providerInclude || []), ...(intent.providerInclude || [])]));
    const mergedExclude = Array.from(new Set([...(providerExclude || []), ...(intent.providerExclude || [])]));

    // 2) Exclusions
    const dislikedSet = new Set((disliked || []).map((d) => String(d.id)));
    const excludeSet = new Set((excludeIds || []).map((id) => String(id)));
    const similarExclude = await expandSimilarExcludes(tmdbKey, disliked);
    for (const id of similarExclude) excludeSet.add(String(id));

    // 3) Candidates
    let candidates = await buildCandidates(tmdbKey, intent, region, refreshToken, mood, liked, disliked, watched);
    candidates = candidates.filter((c) => !dislikedSet.has(String(c.id)) && !excludeSet.has(String(c.id)));

    // 3b) HARD fallback so candidates is never empty
    if (!candidates.length) {
      const trend = await trendingFallback(tmdbKey, intent.mediaType || "any", 1);
      const pop = await popularFallback(tmdbKey, intent.mediaType || "any", 1);
      candidates = uniqByKey([...trend, ...pop], (c) => `${c.media_type}:${c.id}`);
    }

    // still empty, return ultra fallback
    if (!candidates.length) {
      return res.json({
        results: [
          {
            id: "fallback-1",
            title: "Try a different vibe",
            overview: "The server could not reach TMDB right now. Try again in a moment.",
            media_type: "movie",
            vote_average: null,
            release_date: "",
            poster_path: null,
            providers: [],
            reason: "Temporary fallback."
          }
        ],
        intent,
        providerInclude: mergedInclude,
        providerExclude: mergedExclude
      });
    }

    // 4) Pick IDs + reasons via AI, but only if OpenAI is available
    let picks = [];
    const moodHints = moodToHints(mood);

    if (process.env.OPENAI_API_KEY) {
      const pickResp = await openai.responses.create({
        model: "gpt-4.1-mini",
        input: [
          {
            role: "system",
            content:
              "Return ONLY JSON: { picks: [ { id: <tmdb id>, reason: <short reason> } ... ] }\n" +
              "Rules:\n" +
              "- picks must be unique\n" +
              "- 1st pick best match\n" +
              `- Prefer: ${moodHints.prefer.join(", ")}.\n` +
              (moodHints.avoid.length ? `- Avoid: ${moodHints.avoid.join(", ")}.\n` : "")
          },
          {
            role: "user",
            content: JSON.stringify({
              vibe: prompt,
              mood,
              localHour,
              region,
              intent,
              liked: (liked || []).slice(0, 40),
              disliked: (disliked || []).slice(0, 60),
              watched: (watched || []).slice(0, 60),
              candidates: candidates.slice(0, 220).map((c) => ({
                id: c.id,
                media_type: c.media_type,
                title: c.title || c.name,
                overview: c.overview,
                genre_ids: c.genre_ids || [],
                vote_average: c.vote_average,
                vote_count: c.vote_count,
                release_date: c.release_date || c.first_air_date
              }))
            })
          }
        ]
      });

      try {
        const parsed = JSON.parse(pickResp.output[0].content[0].text);
        picks = Array.isArray(parsed?.picks) ? parsed.picks : [];
      } catch {
        picks = [];
      }
    }

    if (!picks.length) {
      picks = candidates.slice(0, 12).map((c) => ({ id: c.id, reason: "Good match for your vibe." }));
    }

    const seen = new Set();
    picks = picks.filter((p) => {
      const k = String(p.id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    // 5) Build results with providers and kid checks
    const kids = Boolean(intent.kidsMode);
    const gbMaxCert = kids ? gbMaxCertFromAge(intent.kidsMaxAge) : null;

    const needsAnimation = (intent.withGenres || []).includes(GENRE.ANIMATION);
    const yearExact = intent.yearExact ? Number(intent.yearExact) : null;

    async function buildResults({ enforceProviders }) {
      const out = [];
      const maxToTry = 25;

      for (let i = 0; i < picks.length && out.length < 6 && i < maxToTry; i++) {
        const pid = String(picks[i].id);
        const cand = candidates.find((c) => String(c.id) === pid);
        if (!cand) continue;

        if (yearExact) {
          const y = yearOf(cand);
          if (y && y !== yearExact) continue;
        }
        if (needsAnimation && !hasGenre(cand, GENRE.ANIMATION)) continue;

        if (kids) {
          if (cand.media_type === "movie") {
            const cert = await getMovieCertification(tmdbKey, cand.id, region);
            if (gbMaxCert && cert && !gbCertAllowed(cert, gbMaxCert)) continue;
          } else {
            const rating = await getTvContentRating(tmdbKey, cand.id, region);
            if (!tvAllowedForKids(rating)) continue;
          }
        }

        const providers = await getWatchProviders(tmdbKey, cand.media_type, cand.id, region);

        if (enforceProviders) {
          if (mergedInclude.length) {
            const ok = providers.some((p) =>
              mergedInclude.some((x) => String(x).toLowerCase() === String(p).toLowerCase())
            );
            if (!ok) continue;
          }
          if (mergedExclude.length) {
            const bad = providers.some((p) =>
              mergedExclude.some((x) => String(x).toLowerCase() === String(p).toLowerCase())
            );
            if (bad) continue;
          }
        }

        out.push({
          id: cand.id,
          title: cand.title || cand.name,
          overview: cand.overview,
          media_type: cand.media_type,
          vote_average: cand.vote_average,
          release_date: cand.release_date || cand.first_air_date,
          poster_path: cand.poster_path ? `https://image.tmdb.org/t/p/w500${cand.poster_path}` : null,
          providers,
          reason: picks[i].reason || "Matches your vibe."
        });
      }

      return out;
    }

    // First pass, enforce provider filters
    let results = await buildResults({ enforceProviders: true });

    // If provider filters cause empties, relax them so user still gets suggestions
    if (results.length < 3) {
      const relaxed = await buildResults({ enforceProviders: false });
      results = uniqByKey(
        [
          ...results,
          ...relaxed.map((r) => ({
            ...r,
            reason: r.reason.includes("Provider filter relaxed")
              ? r.reason
              : `${r.reason} (Provider filter relaxed)`
          }))
        ],
        (x) => `${x.media_type}:${x.id}`
      ).slice(0, 6);
    }

    // Final hard fallback if still somehow empty
    if (!results.length) {
      const backup = candidates.slice(0, 6).map((c) => ({
        id: c.id,
        title: c.title || c.name,
        overview: c.overview,
        media_type: c.media_type,
        vote_average: c.vote_average,
        release_date: c.release_date || c.first_air_date,
        poster_path: c.poster_path ? `https://image.tmdb.org/t/p/w500${c.poster_path}` : null,
        providers: [],
        reason: "Closest match available."
      }));
      results = backup;
    }

    res.json({ results, intent, providerInclude: mergedInclude, providerExclude: mergedExclude });
  } catch (err) {
    console.error("Error in /api/recommend:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================================
   Optional: serve frontend on Render root
   Works with /docs or /frontend
   ================================ */
function pickExistingDir(...dirs) {
  for (const d of dirs) {
    try {
      // eslint-disable-next-line no-unused-vars
      const fs = require("fs");
      if (fs.existsSync(d)) return d;
    } catch {}
  }
  return null;
}

// In ESM, require is not available, so just try both and serve whichever exists by sending file directly
const docsPath = path.join(__dirname, "..", "docs");
const frontendPath = path.join(__dirname, "..", "frontend");

app.get("/", (req, res) => {
  // Try docs first
  res.sendFile(path.join(docsPath, "index.html"), (err) => {
    if (err) {
      // Try old frontend folder
      res.sendFile(path.join(frontendPath, "index.html"), (err2) => {
        if (err2) res.send("Backend is live. Use GitHub Pages for the frontend.");
      });
    }
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
