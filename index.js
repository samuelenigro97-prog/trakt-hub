const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const fs = require('fs');
const path = require('path');

const TRAKT_CLIENT_ID = '2c69e58d7f6752cf77f936d4c6ae08b71267a6d8f0ef2b8a146bfb73794a81a4';
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET || 'd7e484d8d9c5ed0513f80ed43446aa348e7523831c282bbf42ee65692b403f86';
const TRAKT_USER = 'SamueleNigro';
const TMDB_KEY = 'edf2b5b43d56fa6eea398145d50a1e98';
const TOKEN_FILE = path.join(__dirname, 'trakt_token.json');
const CACHE_FILE = path.join(__dirname, 'cache_data.json');
const PORT = parseInt(process.env.PORT || '7779');
const ADDON_URL = (process.env.ADDON_URL || 'http://192.168.178.188:7779').replace(/\/$/, '');
const CACHE_TTL = 60 * 1000; // 1 minuto
const META_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 ore

const manifest = {
  id: 'it.samuele.trakt.watchlist',
  version: '1.0.17',
  name: 'Trakt Watchlist',
  description: 'Film e serie dalla tua watchlist Trakt',
  resources: ['catalog', 'meta'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie',  id: 'trakt-movies',            name: 'Da vedere' },
    { type: 'series', id: 'trakt-series',            name: 'Da vedere' },
    { type: 'movie',  id: 'trakt-movies-recommended', name: 'Consigliati' },
    { type: 'series', id: 'trakt-series-recommended', name: 'Consigliati' }
  ],
  idPrefixes: ['tt', 'tmdb:'],
  logo: ADDON_URL + '/logo.png',
  background: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=1280'
};

let accessToken = null;
let refreshToken = null;

// cache[type] = { metas: [...], ts: Date.now() }
const cache = {};
// metaCache[id] = { meta: {...}, ts: Date.now() }
const metaCache = {};
// ETag per endpoint Trakt
const etags = {};

// Cache traduzioni
const translationCache = new Map();

function clearCache() {
  Object.keys(cache).forEach(k => delete cache[k]);
  Object.keys(metaCache).forEach(k => delete metaCache[k]);
  Object.keys(etags).forEach(k => delete etags[k]);
}

// ─── Persistent cache su disco ───────────────────────────────────────────────

function saveCacheToDisk() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ catalog: cache, meta: metaCache }));
  } catch (e) {
    console.warn('[cache-disk] Errore salvataggio:', e.message);
  }
}

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data.catalog || {})) {
      cache[k] = v; // TTL verificato al momento dell'uso
    }
    for (const [k, v] of Object.entries(data.meta || {})) {
      if (Date.now() - v.ts < META_CACHE_TTL) metaCache[k] = v;
    }
    const nCat = Object.keys(cache).length;
    const nMeta = Object.keys(metaCache).length;
    console.log('[cache-disk] Caricati ' + nCat + ' cataloghi e ' + nMeta + ' meta');
  } catch (e) {
    console.warn('[cache-disk] Errore caricamento:', e.message);
  }
}

// ─── Token ───────────────────────────────────────────────────────────────────

function loadToken() {
  if (process.env.TRAKT_ACCESS_TOKEN) {
    accessToken = process.env.TRAKT_ACCESS_TOKEN;
    refreshToken = process.env.TRAKT_REFRESH_TOKEN || null;
    console.log('Token Trakt caricato da variabile d\'ambiente');
    return true;
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      accessToken = data.access_token;
      refreshToken = data.refresh_token || null;
      console.log('Token Trakt caricato da', TOKEN_FILE);
      return true;
    }
  } catch (e) {
    console.error('Errore lettura token:', e.message);
  }
  return false;
}

function saveToken(tokenData) {
  if (!process.env.TRAKT_ACCESS_TOKEN) {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
  }
  accessToken = tokenData.access_token;
  refreshToken = tokenData.refresh_token || refreshToken;
}

async function refreshTraktToken() {
  if (!refreshToken) {
    console.warn('Nessun refresh token disponibile.');
    return false;
  }
  try {
    const res = await fetch('https://api.trakt.tv/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        refresh_token: refreshToken,
        client_id: TRAKT_CLIENT_ID,
        client_secret: TRAKT_CLIENT_SECRET,
        grant_type: 'refresh_token'
      })
    });
    if (!res.ok) { console.error('Refresh token fallito:', res.status); return false; }
    saveToken(await res.json());
    console.log('Token Trakt rinnovato con successo.');
    return true;
  } catch (e) { console.error('Errore refresh token:', e.message); return false; }
}

async function authenticateDeviceFlow() {
  console.log('Avvio autenticazione Trakt (device flow)...');
  const codeRes = await fetch('https://api.trakt.tv/oauth/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: TRAKT_CLIENT_ID })
  });
  if (!codeRes.ok) throw new Error('Errore richiesta device code: ' + codeRes.status);
  const { device_code, user_code, verification_url, expires_in, interval } = await codeRes.json();
  console.log('\n=== AUTENTICAZIONE TRAKT ===');
  console.log('Vai su:              ' + verification_url);
  console.log('Inserisci il codice: ' + user_code);
  console.log('Hai ' + Math.floor(expires_in / 60) + ' minuti per completare.');
  console.log('============================\n');
  const pollMs = (interval || 5) * 1000;
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    const tokenRes = await fetch('https://api.trakt.tv/oauth/device/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: device_code, client_id: TRAKT_CLIENT_ID, client_secret: TRAKT_CLIENT_SECRET })
    });
    if (tokenRes.status === 200) { saveToken(await tokenRes.json()); console.log('Autenticazione completata!'); return; }
    if (tokenRes.status === 410) throw new Error('Codice scaduto. Riavvia il server.');
    if (tokenRes.status === 418) throw new Error('Autenticazione rifiutata.');
    if (tokenRes.status === 429) await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Timeout autenticazione.');
}

// ─── Trakt API ────────────────────────────────────────────────────────────────

function traktHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID,
    'User-Agent': 'Mozilla/5.0 (compatible; stremio-trakt-addon/1.0)'
  };
  if (accessToken) h['Authorization'] = 'Bearer ' + accessToken;
  return h;
}

async function traktGet(url, etagKey) {
  const headers = traktHeaders();
  if (etagKey && etags[etagKey]) headers['If-None-Match'] = etags[etagKey];

  const res = await fetch(url, { headers });

  if (res.status === 304) {
    console.log('[etag] ' + etagKey + ': nessuna modifica');
    return { notModified: true };
  }
  if (res.status === 401) {
    clearCache();
    console.warn('Trakt 401: provo a rinnovare il token...');
    const renewed = await refreshTraktToken();
    if (renewed) {
      const retry = await fetch(url, { headers: traktHeaders() });
      if (!retry.ok) throw new Error('Trakt error dopo refresh: ' + retry.status);
      const etag = retry.headers.get('ETag');
      if (etagKey && etag) etags[etagKey] = etag;
      return { data: await retry.json() };
    }
    throw new Error('Trakt 401: token non valido e refresh fallito.');
  }
  if (!res.ok) throw new Error('Trakt error: ' + res.status);

  const etag = res.headers.get('ETag');
  if (etagKey && etag) etags[etagKey] = etag;
  return { data: await res.json() };
}

async function getTraktWatchlist(type) {
  const url = 'https://api.trakt.tv/users/' + TRAKT_USER + '/watchlist/' + type + '?limit=500';
  const result = await traktGet(url, 'watchlist-' + type);
  return result.notModified ? null : result.data;
}

async function getTraktWatched(type) {
  try {
    const url = 'https://api.trakt.tv/users/' + TRAKT_USER + '/watched/' + type;
    const result = await traktGet(url, 'watched-' + type);
    return result.notModified ? [] : (result.data || []);
  } catch (e) { return []; }
}

async function getTraktRecommendations(type) {
  try {
    const url = 'https://api.trakt.tv/recommendations/' + type + '?limit=30&ignore_collected=false';
    const result = await traktGet(url, 'recommendations-' + type);
    return result.notModified ? null : (result.data || []);
  } catch (e) { return []; }
}

// ─── TMDB ─────────────────────────────────────────────────────────────────────

async function translateToItalian(text) {
  if (!text || !text.trim()) return '';
  if (translationCache.has(text)) return translationCache.get(text);
  try {
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=it&dt=t&q=' +
      encodeURIComponent(text.slice(0, 1000));
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) return text;
    const data = await res.json();
    const translated = data[0].map(chunk => chunk[0]).join('');
    if (translated && translated !== text) {
      translationCache.set(text, translated);
      return translated;
    }
    return text;
  } catch (e) { return text; }
}

async function enrichWithTMDB(imdbId, traktType, tmdbId) {
  try {
    const tmdbType = traktType === 'movies' ? 'movie' : 'tv';
    let id = tmdbId;
    if (!id && imdbId) {
      const res = await fetch('https://api.themoviedb.org/3/find/' + imdbId + '?external_source=imdb_id&api_key=' + TMDB_KEY);
      if (res.ok) {
        const data = await res.json();
        const results = tmdbType === 'movie' ? data.movie_results : data.tv_results;
        if (results && results[0]) id = results[0].id;
      }
    }
    if (!id) return null;
    const [itRes, enRes] = await Promise.all([
      fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + id + '?language=it-IT&api_key=' + TMDB_KEY),
      fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + id + '?language=en-US&api_key=' + TMDB_KEY)
    ]);
    const it = itRes.ok ? await itRes.json() : null;
    const en = enRes.ok ? await enRes.json() : null;
    if (!it && !en) return null;
    return {
      title:         it?.title || it?.name || en?.title || en?.name,
      overview:      it?.overview?.trim() || en?.overview?.trim() || '',
      poster_path:   it?.poster_path  || en?.poster_path,
      backdrop_path: it?.backdrop_path || en?.backdrop_path,
      genres:        (it?.genres || en?.genres || []).map(g => g.name),
      vote_average:  (it || en)?.vote_average
    };
  } catch (e) { return null; }
}

async function buildMeta(type, stremioId) {
  const tmdbType = type === 'movie' ? 'movie' : 'tv';
  let tmdbId;
  if (stremioId.startsWith('tmdb:')) {
    tmdbId = stremioId.replace('tmdb:', '');
  } else {
    const res = await fetch('https://api.themoviedb.org/3/find/' + stremioId + '?external_source=imdb_id&api_key=' + TMDB_KEY);
    if (!res.ok) return null;
    const data = await res.json();
    const results = tmdbType === 'movie' ? data.movie_results : data.tv_results;
    if (!results || !results[0]) return null;
    tmdbId = results[0].id;
  }
  const [itRes, enRes] = await Promise.all([
    fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + tmdbId + '?language=it-IT&append_to_response=credits&api_key=' + TMDB_KEY),
    fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + tmdbId + '?language=en-US&append_to_response=credits&api_key=' + TMDB_KEY)
  ]);
  const it = itRes.ok ? await itRes.json() : null;
  const en = enRes.ok ? await enRes.json() : null;
  if (!it && !en) return null;
  const base = it || en;
  const itOverview = it?.overview?.trim() || '';
  const enOverview = en?.overview?.trim() || '';
  let overview = itOverview;
  if (!overview && enOverview) overview = await translateToItalian(enOverview);
  const cast = (base.credits?.cast || []).slice(0, 6).map(a => a.name);
  let director = [];
  if (type === 'movie') {
    director = (base.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name);
  } else {
    director = (base.created_by || []).map(c => c.name);
  }
  let runtime;
  if (type === 'movie' && base.runtime) runtime = base.runtime + ' min';
  else if (type === 'series' && base.episode_run_time?.[0]) runtime = base.episode_run_time[0] + ' min';
  const dateStr = base.release_date || base.first_air_date || '';
  const year = dateStr ? parseInt(dateStr) : undefined;
  return {
    id: stremioId, type,
    name:        it?.title || it?.name || en?.title || en?.name,
    poster:      base.poster_path   ? 'https://image.tmdb.org/t/p/w780'  + base.poster_path   : null,
    background:  base.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + base.backdrop_path : null,
    description: overview,
    genres:      (it?.genres || en?.genres || []).map(g => g.name),
    imdbRating:  base.vote_average ? String(base.vote_average.toFixed(1)) : undefined,
    year, cast, director, runtime
  };
}

// ─── Catalog builder ──────────────────────────────────────────────────────────

function metaFromTmdb(tmdb, obj, type) {
  const stremioId = obj.ids.imdb || ('tmdb:' + obj.ids.tmdb);
  return {
    id: stremioId, type,
    name:        (tmdb && tmdb.title) || obj.title,
    poster:      tmdb?.poster_path   ? 'https://image.tmdb.org/t/p/w780'  + tmdb.poster_path   : null,
    background:  tmdb?.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + tmdb.backdrop_path : null,
    description: tmdb?.overview || '',
    genres:      tmdb?.genres || [],
    imdbRating:  tmdb?.vote_average ? String(tmdb.vote_average.toFixed(1)) : undefined,
    year:        obj.year
  };
}

async function enrichBatch(items, traktType, type) {
  const BATCH = 10;
  const metas = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async obj => {
      const tmdb = await enrichWithTMDB(obj.ids.imdb, traktType, obj.ids.tmdb);
      return metaFromTmdb(tmdb, obj, type);
    }));
    metas.push(...results);
  }
  return metas;
}

async function buildCatalog(type) {
  const traktType = type === 'movie' ? 'movies' : 'shows';
  const [items, watched] = await Promise.all([
    getTraktWatchlist(traktType),
    getTraktWatched(traktType)
  ]);

  // null = ETag 304 (nessuna modifica), usa cache esistente
  if (items === null) return null;

  const airedByImdb = new Map();
  const airedByTmdb = new Map();
  for (const item of items) {
    const obj = item.show || item.movie;
    if (!obj) continue;
    const aired = obj.aired_episodes || 0;
    if (obj.ids.imdb) airedByImdb.set(obj.ids.imdb, aired);
    if (obj.ids.tmdb) airedByTmdb.set(obj.ids.tmdb, aired);
  }

  const watchedImdb = new Set();
  const watchedTmdb = new Set();
  for (const w of watched) {
    const obj = w.movie || w.show;
    if (!obj) continue;
    if (type === 'movie') {
      if (obj.ids.imdb) watchedImdb.add(obj.ids.imdb);
      if (obj.ids.tmdb) watchedTmdb.add(obj.ids.tmdb);
    } else {
      const aired = airedByImdb.get(obj.ids.imdb) || airedByTmdb.get(obj.ids.tmdb) || 0;
      const seen = (w.seasons || []).reduce((tot, s) => tot + s.episodes.length, 0);
      if (aired > 0 && seen >= aired) {
        if (obj.ids.imdb) watchedImdb.add(obj.ids.imdb);
        if (obj.ids.tmdb) watchedTmdb.add(obj.ids.tmdb);
      }
    }
  }

  items.sort((a, b) => new Date(b.listed_at) - new Date(a.listed_at));

  const validObjs = items.slice(0, 300)
    .filter(item => {
      const obj = item.movie || item.show;
      if (!obj || !obj.ids || !(obj.ids.imdb || obj.ids.tmdb)) return false;
      if (obj.ids.imdb && watchedImdb.has(obj.ids.imdb)) return false;
      if (obj.ids.tmdb && watchedTmdb.has(obj.ids.tmdb)) return false;
      return true;
    })
    .map(item => item.movie || item.show);

  return enrichBatch(validObjs, traktType, type);
}

async function buildRecommendations(type) {
  const traktType = type === 'movie' ? 'movies' : 'shows';
  const items = await getTraktRecommendations(traktType);
  if (items === null) return null; // ETag 304
  if (!items.length) return [];

  const validObjs = items.filter(obj => obj && obj.ids && (obj.ids.imdb || obj.ids.tmdb));
  return enrichBatch(validObjs, traktType, type);
}

// ─── Cache manager ────────────────────────────────────────────────────────────

function prefetchMeta(metas, stremioType) {
  const toFetch = metas.filter(meta => {
    const key = stremioType + ':' + meta.id;
    return !metaCache[key] || (Date.now() - metaCache[key].ts) >= META_CACHE_TTL;
  });
  (async () => {
    const BATCH = 5;
    for (let i = 0; i < toFetch.length; i += BATCH) {
      await Promise.all(toFetch.slice(i, i + BATCH).map(async meta => {
        const key = stremioType + ':' + meta.id;
        try {
          const m = await buildMeta(stremioType, meta.id);
          if (m) metaCache[key] = { meta: m, ts: Date.now() };
        } catch (e) {}
      }));
      if (i + BATCH < toFetch.length) await new Promise(r => setTimeout(r, 500));
    }
    saveCacheToDisk();
    console.log('[meta-prefetch] ' + stremioType + ': ' + toFetch.length + ' titoli pre-caricati');
  })();
}

async function getCatalogCached(catalogId, type) {
  const entry = cache[catalogId];
  const isRecommended = catalogId.includes('recommended');

  if (entry && (Date.now() - entry.ts) < CACHE_TTL) return entry.metas;

  console.log('[cache miss] ' + catalogId + ' — aggiorno...');
  const metas = isRecommended
    ? await buildRecommendations(type)
    : await buildCatalog(type);

  // null = ETag 304: riusa cache esistente estendendo il TTL
  if (metas === null && entry) {
    entry.ts = Date.now();
    console.log('[etag] ' + catalogId + ': cache estesa senza rebuild');
    return entry.metas;
  }
  if (metas === null) return [];

  cache[catalogId] = { metas, ts: Date.now() };
  console.log('[cache] ' + catalogId + ': ' + metas.length + ' elementi');
  prefetchMeta(metas, type === 'movie' ? 'movie' : 'series');
  return metas;
}

// ─── Keep-alive ───────────────────────────────────────────────────────────────

function startKeepAlive() {
  if (!process.env.RENDER) return;
  const url = process.env.ADDON_URL || ('http://localhost:' + PORT);
  setInterval(async () => {
    try { await fetch(url + '/manifest.json'); console.log('[keep-alive] ping'); }
    catch (e) { console.warn('[keep-alive] ping fallito:', e.message); }
  }, 14 * 60 * 1000);
  console.log('[keep-alive] attivo, ping ogni 14 minuti');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  loadCacheFromDisk();
  if (!loadToken()) {
    if (process.env.RENDER) throw new Error('Token mancante: imposta TRAKT_ACCESS_TOKEN nelle env vars di Render.');
    await authenticateDeviceFlow();
  }

  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id }) => {
    try {
      const metas = await getCatalogCached(id, type);
      return { metas };
    } catch (e) {
      console.error('Errore catalogo:', e.message);
      return { metas: [] };
    }
  });

  builder.defineMetaHandler(async ({ type, id }) => {
    try {
      const key = type + ':' + id;
      const entry = metaCache[key];
      if (entry && (Date.now() - entry.ts) < META_CACHE_TTL) return { meta: entry.meta };
      const meta = await buildMeta(type, id);
      if (!meta) return { meta: null };
      metaCache[key] = { meta, ts: Date.now() };
      saveCacheToDisk();
      return { meta };
    } catch (e) {
      console.error('Errore meta:', e.message);
      return { meta: null };
    }
  });

  const app = express();
  app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));
  app.use(getRouter(builder.getInterface()));

  app.listen(PORT, () => {
    console.log('Trakt addon pronto su ' + ADDON_URL);
    console.log('Manifest: ' + ADDON_URL + '/manifest.json');
    startKeepAlive();
  });
}

main().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
