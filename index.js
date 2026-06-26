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
const CLEAR_CACHE_TOKEN = 'samuele-clear-2024';
const CACHE_TTL = 60 * 1000; // 1 minuto
const META_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 ore
const META_CACHE_VERSION = 4; // incrementa quando cambia il formato del meta

const manifest = {
  id: 'it.samuele.trakt.watchlist',
  version: '1.4.0',
  name: 'Trakt Hub',
  description: 'La tua watchlist Trakt: Da vedere, Scegli per me, aggiungi e segna come visto direttamente da Stremio.',
  resources: ['catalog', 'stream'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie',  id: 'trakt-movies',          name: 'Da vedere',     extra: [{ name: 'skip' }, { name: 'genre', options: ['Azione','Avventura','Animazione','Commedia','Crime','Documentario','Dramma','Fantasy','Horror','Mistero','Romantico','Fantascienza','Thriller','Guerra','Western'] }] },
    { type: 'series', id: 'trakt-series',          name: 'Da vedere',     extra: [{ name: 'skip' }, { name: 'genre', options: ['Azione & Avventura','Animazione','Commedia','Crime','Documentario','Dramma','Fantascienza & Fantasy','Horror','Mistero','Reality','Thriller','Western'] }] },
    { type: 'movie',  id: 'trakt-movies-random',   name: 'Scegli per me', extra: [{ name: 'skip' }, { name: 'genre', options: ['Azione','Avventura','Animazione','Commedia','Crime','Documentario','Dramma','Fantasy','Horror','Mistero','Romantico','Fantascienza','Thriller','Guerra','Western'] }] },
    { type: 'series', id: 'trakt-series-random',   name: 'Scegli per me', extra: [{ name: 'skip' }, { name: 'genre', options: ['Azione & Avventura','Animazione','Commedia','Crime','Documentario','Dramma','Fantascienza & Fantasy','Horror','Mistero','Reality','Thriller','Western'] }] },
    { type: 'movie',  id: 'trakt-movies-upcoming', name: 'In arrivo',     extra: [{ name: 'skip' }] },
    { type: 'series', id: 'trakt-series-upcoming', name: 'In arrivo',     extra: [{ name: 'skip' }] }
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

// Auto-cleanup: rimuove dalla history Trakt i titoli in watchlist
const watchedCache = {};
const lastCleanupTs = {};
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 ora

function clearCache() {
  Object.keys(cache).forEach(k => delete cache[k]);
  Object.keys(metaCache).forEach(k => delete metaCache[k]);
  Object.keys(etags).forEach(k => delete etags[k]);
}

// ─── Persistent cache su disco ───────────────────────────────────────────────

function saveCacheToDisk() {
  const data = JSON.stringify({ catalog: cache, meta: metaCache });
  fs.writeFile(CACHE_FILE, data, e => {
    if (e) console.warn('[cache-disk] Errore salvataggio:', e.message);
  });
}

function loadCacheFromDisk() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data.catalog || {})) {
      cache[k] = v; // TTL verificato al momento dell'uso
    }
    for (const [k, v] of Object.entries(data.meta || {})) {
      if (Date.now() - v.ts < META_CACHE_TTL && v.v === META_CACHE_VERSION) metaCache[k] = v;
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
  // File prima: ha il token più recente dopo ogni refresh
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (data.access_token) {
        accessToken = data.access_token;
        refreshToken = data.refresh_token || null;
        console.log('Token Trakt caricato da file');
        return true;
      }
    }
  } catch (e) {}
  // Fallback: env var (primo avvio su Render, prima ancora del primo refresh)
  if (process.env.TRAKT_ACCESS_TOKEN) {
    accessToken = process.env.TRAKT_ACCESS_TOKEN;
    refreshToken = process.env.TRAKT_REFRESH_TOKEN || null;
    console.log('Token Trakt caricato da variabile d\'ambiente');
    return true;
  }
  return false;
}

function saveToken(tokenData) {
  // Salva sempre su file così il token refreshato sopravvive ai riavvii
  try { fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2)); } catch (e) {}
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
  const firstUrl = 'https://api.trakt.tv/users/' + TRAKT_USER + '/watchlist/' + type + '?limit=500&page=1&sort_by=listed_at&sort_how=desc';
  const first = await traktGet(firstUrl, 'watchlist-' + type);
  if (first.notModified) return null;
  const items = first.data || [];
  if (items.length < 500) return items;
  // Pagina 2+ senza ETag (già sappiamo che c'è un aggiornamento)
  let page = 2;
  while (true) {
    const url = 'https://api.trakt.tv/users/' + TRAKT_USER + '/watchlist/' + type + '?limit=500&page=' + page + '&sort_by=listed_at&sort_how=desc';
    const res = await traktGet(url, null);
    if (!res.data || !res.data.length) break;
    items.push(...res.data);
    if (res.data.length < 500) break;
    page++;
  }
  return items;
}

async function getTraktWatched(type) {
  try {
    const url = 'https://api.trakt.tv/users/' + TRAKT_USER + '/watched/' + type;
    const result = await traktGet(url, 'watched-' + type);
    if (result.notModified) return watchedCache[type] || [];
    watchedCache[type] = result.data || [];
    return watchedCache[type];
  } catch (e) { return watchedCache[type] || []; }
}

// Rimosse le raccomandazioni Trakt (richiedono premium) → sostituite con TMDB

// ─── TMDB ─────────────────────────────────────────────────────────────────────

const POSTER_SIZE   = 'original';
const BACKDROP_SIZE = 'original';

function posterUrl(path)   {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return 'https://image.tmdb.org/t/p/' + POSTER_SIZE + path;
}
function backdropUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return 'https://image.tmdb.org/t/p/' + BACKDROP_SIZE + path;
}

async function getTraktImages(imdbId, traktType) {
  try {
    const endpoint = traktType === 'movies' ? 'movies' : 'shows';
    const res = await fetch('https://api.trakt.tv/' + endpoint + '/' + imdbId + '?extended=images', {
      headers: {
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const imgs = data.images || {};
    // Trakt restituisce array di URL senza https://, in qualità medium → convertiamo a full
    const toUrl = arr => {
      const raw = Array.isArray(arr) ? arr[0] : arr?.full;
      if (!raw) return null;
      return 'https://' + raw.replace('/medium/', '/full/');
    };
    return { poster: toUrl(imgs.poster), fanart: toUrl(imgs.fanart) };
  } catch (e) { return null; }
}

// Restituisce il titolo localizzato: se TMDB non ha tradotto (IT = originale)
// E il film non è originariamente italiano, usa EN come fallback
function localizedTitle(it, en) {
  const itTitle = it?.title || it?.name || '';
  const enTitle = en?.title || en?.name || '';
  const original = (it || en)?.original_title || (it || en)?.original_name || '';
  const originalLang = (it || en)?.original_language || '';
  // Se il titolo IT è diverso dall'originale → è tradotto, usalo
  // Se il film è originariamente italiano → tieni il titolo italiano
  // Altrimenti (IT = originale di un film non italiano) → usa EN
  if (itTitle && (itTitle !== original || originalLang === 'it')) return itTitle;
  return enTitle || itTitle;
}

// Sceglie il poster migliore: italiano > inglese > neutro (senza testo)
function bestPosterPath(images, fallback) {
  const posters = images?.posters || [];
  if (!posters.length) return fallback;
  const prio = p => p.iso_639_1 === 'it' ? 0 : p.iso_639_1 === 'en' ? 1 : p.iso_639_1 === null ? 2 : 3;
  return [...posters].sort((a, b) => prio(a) - prio(b) || (b.vote_average || 0) - (a.vote_average || 0))[0]?.file_path || fallback;
}

// Sceglie il backdrop migliore: neutro > inglese > italiano (i backdrop neutri sono i migliori)
function bestBackdropPath(images, fallback) {
  const backdrops = images?.backdrops || [];
  if (!backdrops.length) return fallback;
  const prio = p => p.iso_639_1 === null ? 0 : p.iso_639_1 === 'en' ? 1 : p.iso_639_1 === 'it' ? 2 : 3;
  return [...backdrops].sort((a, b) => prio(a) - prio(b) || (b.vote_average || 0) - (a.vote_average || 0))[0]?.file_path || fallback;
}

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
      fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + id + '?language=it-IT&append_to_response=images&include_image_language=it,en,null&api_key=' + TMDB_KEY),
      fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + id + '?language=en-US&api_key=' + TMDB_KEY)
    ]);
    const it = itRes.ok ? await itRes.json() : null;
    const en = enRes.ok ? await enRes.json() : null;
    if (!it && !en) return null;
    let poster_path   = bestPosterPath(it?.images, it?.poster_path || en?.poster_path);
    let backdrop_path = bestBackdropPath(it?.images, it?.backdrop_path || en?.backdrop_path);
    // Fallback Trakt extended=images se TMDB non ha grafiche
    if ((!poster_path || !backdrop_path) && imdbId) {
      const ti = await getTraktImages(imdbId, traktType);
      if (!poster_path   && ti?.poster)  poster_path   = ti.poster;
      if (!backdrop_path && ti?.fanart)  backdrop_path = ti.fanart;
    }
    return {
      title: localizedTitle(it, en),
      overview: it?.overview?.trim() || en?.overview?.trim() || '',
      poster_path, backdrop_path,
      genres:       (it?.genres || en?.genres || []).map(g => g.name),
      vote_average: (it || en)?.vote_average,
      release_date: (it || en)?.release_date || (it || en)?.first_air_date || null
    };
  } catch (e) { return null; }
}

function tmdbFetch(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { signal: ctrl.signal })
    .then(r => { clearTimeout(t); return r; })
    .catch(e => { clearTimeout(t); return null; });
}

async function buildMeta(type, stremioId) {
  const tmdbType = type === 'movie' ? 'movie' : 'tv';
  let tmdbId;
  if (stremioId.startsWith('tmdb:')) {
    tmdbId = stremioId.replace('tmdb:', '');
  } else {
    const res = await tmdbFetch('https://api.themoviedb.org/3/find/' + stremioId + '?external_source=imdb_id&api_key=' + TMDB_KEY);
    if (!res?.ok) return null;
    const data = await res.json();
    const results = tmdbType === 'movie' ? data.movie_results : data.tv_results;
    if (!results || !results[0]) return null;
    tmdbId = results[0].id;
  }
  const [itRes, enRes] = await Promise.all([
    tmdbFetch('https://api.themoviedb.org/3/' + tmdbType + '/' + tmdbId + '?language=it-IT&append_to_response=credits,images,videos&include_image_language=it,en,null&api_key=' + TMDB_KEY),
    tmdbFetch('https://api.themoviedb.org/3/' + tmdbType + '/' + tmdbId + '?language=en-US&append_to_response=credits,videos&api_key=' + TMDB_KEY)
  ]);
  const it = (itRes?.ok) ? await itRes.json() : null;
  const en = (enRes?.ok) ? await enRes.json() : null;
  if (!it && !en) return null;
  const base = it || en;
  const itOverview = it?.overview?.trim() || '';
  const enOverview = en?.overview?.trim() || '';
  let overview = itOverview;
  if (!overview && enOverview) overview = await translateToItalian(enOverview);
  const cast = (base.credits?.cast || []).slice(0, 8).map(a => a.name);
  let director = [];
  let writer = [];
  if (type === 'movie') {
    director = (base.credits?.crew || []).filter(c => c.job === 'Director').map(c => c.name);
    writer = (base.credits?.crew || []).filter(c => c.department === 'Writing').slice(0, 2).map(c => c.name);
  } else {
    director = (base.created_by || []).map(c => c.name);
  }
  let runtime;
  if (type === 'movie' && base.runtime) runtime = base.runtime + ' min';
  else if (type === 'series' && base.episode_run_time?.[0]) runtime = base.episode_run_time[0] + ' min';
  const dateStr = base.release_date || base.first_air_date || '';
  const year = dateStr ? parseInt(dateStr) : undefined;

  // Badge data uscita per titoli non ancora usciti
  if (dateStr) {
    const releaseDate = new Date(dateStr);
    if (releaseDate > new Date()) {
      const formatted = releaseDate.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
      const label = type === 'movie' ? 'Uscita prevista' : 'Prima stagione dal';
      overview = (overview ? overview + '\n\n' : '') + '📅 ' + label + ': ' + formatted;
    }
  }

  // Fallback Trakt extended=images se TMDB non ha grafiche
  const imdbIdForTrakt = stremioId.startsWith('tt') ? stremioId : null;
  let posterFallback   = bestPosterPath(it?.images, base.poster_path);
  let backdropFallback = bestBackdropPath(it?.images, base.backdrop_path);
  if ((!posterFallback || !backdropFallback) && imdbIdForTrakt) {
    const traktType2 = type === 'movie' ? 'movies' : 'shows';
    const ti = await getTraktImages(imdbIdForTrakt, traktType2);
    if (!posterFallback   && ti?.poster)  posterFallback   = ti.poster;
    if (!backdropFallback && ti?.fanart)  backdropFallback = ti.fanart;
  }

  // Trailer: preferisce italiano, poi inglese — solo YouTube, tipo Trailer ufficiale
  const pickTrailer = videos => (videos?.results || [])
    .filter(v => v.site === 'YouTube' && v.type === 'Trailer' && v.official)
    .sort((a, b) => new Date(b.published_at) - new Date(a.published_at))[0]?.key;
  const trailerKey = pickTrailer(it?.videos) || pickTrailer(en?.videos);
  const trailers = trailerKey ? [{ source: trailerKey, type: 'Trailer' }] : [];

  // Episodi + poster stagione corrente per le serie
  // Episodi: risposta immediata da episode_count, titoli reali in background
  let videos = [];
  let seasonPosterPath = null;
  if (type === 'series') {
    const seasonList = (base.seasons || []).filter(s => s.season_number > 0);
    // Genera subito episodi base (veloci, nessuna chiamata extra)
    for (const s of seasonList) {
      if (s.poster_path) seasonPosterPath = s.poster_path;
      for (let ep = 1; ep <= (s.episode_count || 0); ep++) {
        videos.push({ id: stremioId + ':' + s.season_number + ':' + ep,
          title: 'Episodio ' + ep, season: s.season_number, episode: ep });
      }
    }
    // Arricchisce con titoli/thumbnail reali in background, aggiorna cache
    ;(async () => {
      try {
        const enriched = [];
        for (let i = 0; i < seasonList.length; i += 5) {
          const batch = seasonList.slice(i, i + 5);
          const results = await Promise.all(batch.map(s =>
            tmdbFetch('https://api.themoviedb.org/3/tv/' + tmdbId + '/season/' + s.season_number + '?language=it-IT&api_key=' + TMDB_KEY)
              .then(r => r?.ok ? r.json() : null).catch(() => null)
          ));
          for (let j = 0; j < results.length; j++) {
            const season = results[j];
            const fb = batch[j];
            if (season?.poster_path) seasonPosterPath = season.poster_path;
            const sNum = season?.season_number || fb.season_number;
            if (season?.episodes?.length) {
              for (const ep of season.episodes) {
                enriched.push({
                  id: stremioId + ':' + sNum + ':' + ep.episode_number,
                  title: ep.name || ('Episodio ' + ep.episode_number),
                  season: sNum, episode: ep.episode_number,
                  released: ep.air_date ? new Date(ep.air_date).toISOString() : undefined,
                  thumbnail: ep.still_path ? 'https://image.tmdb.org/t/p/original' + ep.still_path : undefined,
                  overview: ep.overview || undefined
                });
              }
            } else {
              for (let ep = 1; ep <= (fb.episode_count || 0); ep++)
                enriched.push({ id: stremioId + ':' + fb.season_number + ':' + ep,
                  title: 'Episodio ' + ep, season: fb.season_number, episode: ep });
            }
          }
        }
        if (enriched.length) {
          const key = type + ':' + stremioId;
          if (metaCache[key]) {
            metaCache[key].meta.videos = enriched;
            if (seasonPosterPath) metaCache[key].meta.poster = posterUrl(seasonPosterPath);
            setImmediate(saveCacheToDisk);
          }
        }
      } catch (e) {}
    })();
  }

  const seriesPoster = type === 'series' && seasonPosterPath
    ? posterUrl(seasonPosterPath)
    : posterUrl(posterFallback);

  // Link azioni Trakt
  const traktActionType = type === 'movie' ? 'movies' : 'shows';
  const inWatchlist = (() => {
    const catalogId = type === 'movie' ? 'trakt-movies' : 'trakt-series';
    return !!(cache[catalogId]?.metas?.find(m => m.id === stremioId));
  })();
  const links = [
    inWatchlist
      ? { name: 'Rimuovi dalla Watchlist', category: 'Trakt', url: ADDON_URL + '/trakt/remove/' + traktActionType + '/' + stremioId }
      : { name: 'Aggiungi alla Watchlist', category: 'Trakt', url: ADDON_URL + '/trakt/add/' + traktActionType + '/' + stremioId },
    { name: 'Segna come visto', category: 'Trakt', url: ADDON_URL + '/trakt/watched/' + traktActionType + '/' + stremioId }
  ];

  return {
    id: stremioId, type,
    name:        localizedTitle(it, en),
    poster:      seriesPoster,
    background:  backdropUrl(backdropFallback),
    description: overview,
    genres:      (it?.genres || en?.genres || []).map(g => g.name),
    imdbRating:  base.vote_average ? String(base.vote_average.toFixed(1)) : undefined,
    year, cast, director, writer, runtime, trailers, links,
    ...(videos.length ? { videos } : {})
  };
}

// ─── Catalog builder ──────────────────────────────────────────────────────────

function metaFromTmdb(tmdb, obj, type) {
  const stremioId = obj.ids.imdb || ('tmdb:' + obj.ids.tmdb);
  const cachedName = metaCache[type + ':' + stremioId]?.meta?.name;
  const releaseDate = tmdb?.release_date || null;
  const upcoming = releaseDate ? new Date(releaseDate) > new Date() : false;
  return {
    id: stremioId, type,
    tmdbId:      String(obj.ids.tmdb || ''),
    name:        (tmdb && tmdb.title) || cachedName || obj.title,
    poster:      posterUrl(tmdb?.poster_path),
    background:  backdropUrl(tmdb?.backdrop_path),
    description: tmdb?.overview || '',
    genres:      tmdb?.genres || [],
    imdbRating:  tmdb?.vote_average ? String(tmdb.vote_average.toFixed(1)) : undefined,
    year:        obj.year,
    ...(upcoming ? { upcoming: true, releaseDate } : {})
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

async function autoCleanupWatched(type, watchlistItems, watchedImdb, watchedTmdb) {
  const now = Date.now();
  if (lastCleanupTs[type] && (now - lastCleanupTs[type]) < CLEANUP_INTERVAL) return;
  lastCleanupTs[type] = now;

  const toRemove = watchlistItems
    .map(item => item.movie || item.show)
    .filter(obj => obj && (
      (obj.ids.imdb && watchedImdb.has(obj.ids.imdb)) ||
      (obj.ids.tmdb && watchedTmdb.has(String(obj.ids.tmdb)))
    ));

  if (!toRemove.length) return;
  console.log('[auto-cleanup] rimuovo ' + toRemove.length + ' titoli dalla history (' + type + ')');

  const payload = type === 'movie'
    ? { movies: toRemove.map(o => ({ ids: o.ids })) }
    : { shows:  toRemove.map(o => ({ ids: o.ids })) };

  try {
    const res = await fetch('https://api.trakt.tv/sync/history/remove', {
      method: 'POST',
      headers: { ...traktHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    const d = result.deleted || {};
    console.log('[auto-cleanup] rimossi: ' + (d.movies || 0) + ' film, ' + (d.episodes || 0) + ' episodi');
    // Svuota watchedCache così al prossimo giro il filtro è aggiornato
    delete watchedCache[type === 'movie' ? 'movies' : 'shows'];
  } catch (e) {
    console.warn('[auto-cleanup] errore:', e.message);
  }
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
      const seasonsWatched = (w.seasons || []).filter(s => s.number > 0);
      const isComplete = (aired > 0 && seen >= aired) || (aired === 0 && seasonsWatched.length > 0 && seen >= 6);
      if (isComplete) {
        if (obj.ids.imdb) watchedImdb.add(obj.ids.imdb);
        if (obj.ids.tmdb) watchedTmdb.add(obj.ids.tmdb);
      }
    }
  }

  // Auto-cleanup in background (max 1 volta/ora)
  autoCleanupWatched(type, items, watchedImdb, watchedTmdb);

  items.sort((a, b) => new Date(b.listed_at) - new Date(a.listed_at));

  const validObjs = items
    .filter(item => {
      const obj = item.movie || item.show;
      if (!obj || !obj.ids || !(obj.ids.imdb || obj.ids.tmdb)) return false;
      if (obj.ids.imdb && watchedImdb.has(obj.ids.imdb)) return false;
      if (obj.ids.tmdb && watchedTmdb.has(obj.ids.tmdb)) return false;
      return true;
    })
    .map(item => item.movie || item.show);

  const allMetas = await enrichBatch(validObjs, traktType, type);

  const released = allMetas.filter(m => !m.upcoming);
  const upcoming = allMetas
    .filter(m => m.upcoming)
    .sort((a, b) => new Date(a.releaseDate || 0) - new Date(b.releaseDate || 0));

  const upcomingId = type === 'movie' ? 'trakt-movies-upcoming' : 'trakt-series-upcoming';
  cache[upcomingId] = { metas: upcoming, ts: Date.now() };

  return released;
}

async function buildRecommendations(type) {
  const traktType = type === 'movie' ? 'movies' : 'shows';
  const tmdbType = type === 'movie' ? 'movie' : 'tv';
  const catalogId = type === 'movie' ? 'trakt-movies' : 'trakt-series';

  // Prendi TMDB IDs da TUTTI i titoli in watchlist (non solo quelli tmdb:)
  const tmdbIds = [];
  const seenTmdb = new Set();
  const cachedCatalog = cache[catalogId];
  if (cachedCatalog?.metas?.length) {
    for (const m of cachedCatalog.metas.slice(0, 20)) {
      let tid = null;
      if (m.tmdbId) tid = m.tmdbId;
      else if (m.id.startsWith('tmdb:')) tid = m.id.replace('tmdb:', '');
      if (tid && !seenTmdb.has(tid)) { seenTmdb.add(tid); tmdbIds.push(tid); }
    }
  }
  // Fallback: fetch watchlist se cache non disponibile
  if (!tmdbIds.length) {
    const result = await traktGet('https://api.trakt.tv/users/' + TRAKT_USER + '/watchlist/' + traktType + '?limit=20', null);
    for (const item of (result.data || []).slice(0, 20)) {
      const obj = item.movie || item.show;
      if (obj?.ids?.tmdb) tmdbIds.push(String(obj.ids.tmdb));
    }
  }
  if (!tmdbIds.length) return [];

  const watchlistIds = new Set((cachedCatalog?.metas || []).map(m => m.id));

  // Scarica la history da Trakt per filtrare i già visti
  const watchedResult = await traktGet('https://api.trakt.tv/users/' + TRAKT_USER + '/watched/' + traktType, 'watched-' + traktType + '-rec');
  const watchedTmdb = new Set();
  for (const w of (watchedResult.data || [])) {
    const obj = w.movie || w.show;
    if (obj?.ids?.tmdb) watchedTmdb.add(String(obj.ids.tmdb));
  }

  const seen = new Set();
  const recs = [];

  await Promise.all(tmdbIds.map(async tmdbId => {
    try {
      const [itRes, enRes] = await Promise.all([
        fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + tmdbId + '/recommendations?language=it-IT&api_key=' + TMDB_KEY),
        fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + tmdbId + '/recommendations?language=en-US&api_key=' + TMDB_KEY)
      ]);
      const itItems = itRes.ok ? (await itRes.json()).results || [] : [];
      const enItems = enRes.ok ? (await enRes.json()).results || [] : [];
      for (let i = 0; i < Math.max(itItems.length, enItems.length); i++) {
        const it = itItems[i] || {};
        const en = enItems[i] || {};
        const id = it.id || en.id;
        if (!id) continue;
        const stremioId = 'tmdb:' + id;
        if (seen.has(stremioId) || watchlistIds.has(stremioId) || watchedTmdb.has(String(id))) continue;
        seen.add(stremioId);
        recs.push({
          id: stremioId, type,
          name:        it.title || it.name || en.title || en.name,
          poster:      posterUrl(it.poster_path || en.poster_path),
          background:  backdropUrl(it.backdrop_path || en.backdrop_path),
          description: it.overview?.trim() || en.overview?.trim() || '',
          genres:      [],
          imdbRating:  (it.vote_average || en.vote_average) ? String((it.vote_average || en.vote_average).toFixed(1)) : undefined,
          year:        parseInt(((it.release_date || it.first_air_date || en.release_date || en.first_air_date) || '').slice(0, 4)) || undefined
        });
      }
    } catch (e) {}
  }));

  return recs.slice(0, 25);
}

// ─── Cache manager ────────────────────────────────────────────────────────────

function prefetchMeta(metas, stremioType) {
  const toFetch = metas.filter(meta => {
    const key = stremioType + ':' + meta.id;
    const entry = metaCache[key];
    return !entry || entry.v !== META_CACHE_VERSION || (Date.now() - entry.ts) >= META_CACHE_TTL;
  });
  (async () => {
    // Batch più piccolo per le serie (ogni serie fa più chiamate TMDB)
    const BATCH = stremioType === 'series' ? 3 : 10;
    const PAUSE = stremioType === 'series' ? 1000 : 200;
    for (let i = 0; i < toFetch.length; i += BATCH) {
      await Promise.all(toFetch.slice(i, i + BATCH).map(async meta => {
        const key = stremioType + ':' + meta.id;
        try {
          const m = await buildMeta(stremioType, meta.id);
          if (m) metaCache[key] = { meta: m, ts: Date.now(), v: META_CACHE_VERSION };
        } catch (e) {}
      }));
      if (i + BATCH < toFetch.length) await new Promise(r => setTimeout(r, PAUSE));
    }
    saveCacheToDisk();
    console.log('[meta-prefetch] ' + stremioType + ': ' + toFetch.length + ' titoli pre-caricati');
  })();
}

async function buildRandom(type, genre, forHome = false) {
  const sourceCatalogId = type === 'movie' ? 'trakt-movies' : 'trakt-series';
  if (!cache[sourceCatalogId]) await getCatalogCached(sourceCatalogId, type);
  let source = cache[sourceCatalogId]?.metas || [];
  if (genre) source = source.filter(m => m.genres && m.genres.includes(genre));
  if (!source.length) return [];

  if (forHome) {
    // Un film casuale per genere — home view
    const byGenre = {};
    for (const m of source) {
      for (const g of (m.genres || [])) {
        if (!byGenre[g]) byGenre[g] = [];
        byGenre[g].push(m);
      }
    }
    const seen = new Set();
    const picks = [];
    for (const g of Object.keys(byGenre).sort(() => Math.random() - 0.5)) {
      const candidates = byGenre[g].filter(m => !seen.has(m.id));
      if (!candidates.length) continue;
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      picks.push(pick);
      seen.add(pick.id);
    }
    return picks;
  }

  return [...source].sort(() => Math.random() - 0.5).slice(0, 100);
}

async function getCatalogCached(catalogId, type, genre) {
  const isRecommended = catalogId.includes('recommended');
  const isRandom      = catalogId.includes('random');
  const isUpcoming    = catalogId.includes('upcoming');

  if (isRandom) return buildRandom(type, genre, false);

  // Upcoming: dipende dalla build del catalog principale
  if (isUpcoming) {
    if (cache[catalogId]) return cache[catalogId].metas;
    await getCatalogCached(catalogId.replace('-upcoming', ''), type);
    return cache[catalogId]?.metas || [];
  }

  const entry = cache[catalogId];
  const stale = !entry || (Date.now() - entry.ts) >= CACHE_TTL;

  if (!stale) return entry.metas;

  // Stale-while-revalidate: risponde subito con la cache esistente, aggiorna in background
  if (entry) {
    entry.ts = Date.now(); // previene richieste concorrenti durante il rebuild
    ;(async () => {
      try {
        const metas = isRecommended ? await buildRecommendations(type) : await buildCatalog(type);
        if (metas !== null) {
          cache[catalogId] = { metas, ts: Date.now() };
          prefetchMeta(metas, type === 'movie' ? 'movie' : 'series');
          saveCacheToDisk();
          console.log('[bg-refresh] ' + catalogId + ': ' + metas.length + ' elementi');
        } else {
          // ETag 304: watchlist invariata — controlla se qualche upcoming è diventato released
          const upcomingId = type === 'movie' ? 'trakt-movies-upcoming' : 'trakt-series-upcoming';
          const upcomingMetas = cache[upcomingId]?.metas || [];
          const now = new Date();
          const newReleased = upcomingMetas.filter(m => m.releaseDate && new Date(m.releaseDate) <= now);
          if (newReleased.length) {
            cache[upcomingId] = { metas: upcomingMetas.filter(m => !newReleased.includes(m)), ts: Date.now() };
            const cleaned = newReleased.map(({ upcoming, releaseDate, ...rest }) => rest);
            cache[catalogId] = { metas: (cache[catalogId]?.metas || []).concat(cleaned), ts: Date.now() };
            saveCacheToDisk();
            console.log('[upcoming→released] ' + newReleased.length + ' titoli spostati automaticamente');
          }
        }
      } catch (e) { console.warn('[bg-refresh] ' + catalogId + ':', e.message); }
    })();
    return entry.metas;
  }

  // Prima build (nessuna cache disponibile)
  console.log('[cache miss] ' + catalogId + ' — aggiorno...');
  const metas = isRecommended ? await buildRecommendations(type) : await buildCatalog(type);
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

  // Warm-up: carica cataloghi e pre-fetcha tutti i meta in background
  setTimeout(async () => {
    try {
      console.log('[warm-up] pre-carico cataloghi e meta...');
      for (const [catalogId, type, stremioType] of [
        ['trakt-movies', 'movie', 'movie'],
        ['trakt-series', 'series', 'series']
      ]) {
        const metas = await getCatalogCached(catalogId, type);
        prefetchMeta(metas, stremioType);
      }
    } catch (e) { console.warn('[warm-up] errore:', e.message); }
  }, 5000);

  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    try {
      const skip = parseInt(extra?.skip || 0);
      const genre = extra?.genre || null;
      const forHome = id.includes('random') && skip === 0 && !genre;
      let allMetas = forHome
        ? await buildRandom(type, genre, true)
        : await getCatalogCached(id, type, genre);
      if (genre && !id.includes('random')) allMetas = allMetas.filter(m => m.genres && m.genres.includes(genre));
      const metas = forHome ? allMetas : allMetas.slice(skip, skip + 100);
      return { metas };
    } catch (e) {
      console.error('Errore catalogo:', e.message);
      return { metas: [] };
    }
  });

  builder.defineStreamHandler(({ type, id }) => {
    const traktType = type === 'movie' ? 'movies' : 'shows';
    const catalogId = type === 'movie' ? 'trakt-movies' : 'trakt-series';
    const inWatchlist = !!(cache[catalogId]?.metas?.find(m => m.id === id));
    const streams = [
      {
        name: 'Trakt',
        description: inWatchlist ? '🗑️ Rimuovi dalla Watchlist' : '➕ Aggiungi alla Watchlist',
        externalUrl: ADDON_URL + '/trakt/' + (inWatchlist ? 'remove' : 'add') + '/' + traktType + '/' + id
      },
      {
        name: 'Trakt',
        description: '✅ Segna come visto',
        externalUrl: ADDON_URL + '/trakt/watched/' + traktType + '/' + id
      }
    ];
    return { streams };
  });

  const app = express();
  app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

  const traktAction = async (action, traktType, stremioId) => {
    const imdbId = stremioId.startsWith('tt') ? stremioId : null;
    const tmdbId = stremioId.startsWith('tmdb:') ? stremioId.replace('tmdb:', '') : null;
    const ids = imdbId ? { imdb: imdbId } : { tmdb: parseInt(tmdbId) };
    const body = traktType === 'movies' ? { movies: [{ ids }] } : { shows: [{ ids }] };
    const endpoint = 'https://api.trakt.tv/sync/watchlist' + (action === 'remove' ? '/remove' : '');
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'trakt-api-version': '2',
        'trakt-api-key': TRAKT_CLIENT_ID,
        'Authorization': 'Bearer ' + accessToken,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[traktAction] ' + action + ' failed:', res.status, text.slice(0, 200));
    }
    return { ok: res.ok, status: res.status };
  };

  const htmlPage = (title, message, color) => `<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#1a1a2e;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;padding:2rem;background:#16213e;border-radius:1rem;border:2px solid ${color};max-width:400px}
h1{color:${color};margin-bottom:.5rem}p{color:#aaa;margin-top:.5rem}
a{color:${color};text-decoration:none;font-size:.9rem}</style></head>
<body><div class="box"><h1>${title}</h1><p>${message}</p></div></body></html>`;

  app.get('/trakt/add/:type/:id', async (req, res) => {
    try {
      const { ok, status } = await traktAction('add', req.params.type, req.params.id);
      if (ok) {
        const cId = 'trakt-' + (req.params.type === 'movies' ? 'movies' : 'series');
        const mType = req.params.type === 'movies' ? 'movie' : 'series';
        delete cache[cId];
        setImmediate(() => getCatalogCached(cId, mType).catch(() => {}));
        console.log('[watchlist] Aggiunto:', req.params.id);
        res.send(htmlPage('✅ Aggiunto!', 'Il titolo è stato aggiunto alla tua Watchlist Trakt.<br>Chiudi questa pagina e aggiorna Stremio.', '#4ade80'));
      } else {
        res.status(500).send(htmlPage('❌ Errore', 'Trakt ha risposto ' + status + '. Riprova.', '#f87171'));
      }
    } catch (e) {
      res.status(500).send(htmlPage('❌ Errore', e.message, '#f87171'));
    }
  });

  app.get('/trakt/remove/:type/:id', async (req, res) => {
    try {
      const { ok, status } = await traktAction('remove', req.params.type, req.params.id);
      if (ok) {
        const cId = 'trakt-' + (req.params.type === 'movies' ? 'movies' : 'series');
        const metaType = req.params.type === 'movies' ? 'movie' : 'series';
        delete cache[cId];
        delete metaCache[metaType + ':' + req.params.id];
        setImmediate(() => getCatalogCached(cId, metaType).catch(() => {}));
        console.log('[watchlist] Rimosso:', req.params.id);
        res.send(htmlPage('🗑️ Rimosso!', 'Il titolo è stato rimosso dalla tua Watchlist Trakt.<br>Chiudi questa pagina e aggiorna Stremio.', '#fb923c'));
      } else {
        res.status(500).send(htmlPage('❌ Errore', 'Trakt ha risposto ' + status + '. Riprova.', '#f87171'));
      }
    } catch (e) {
      res.status(500).send(htmlPage('❌ Errore', e.message, '#f87171'));
    }
  });

  app.get('/trakt/watched/:type/:id', async (req, res) => {
    try {
      const { type, id } = req.params;
      const imdbId = id.startsWith('tt') ? id : null;
      const tmdbId = id.startsWith('tmdb:') ? id.replace('tmdb:', '') : null;
      const ids = imdbId ? { imdb: imdbId } : { tmdb: parseInt(tmdbId) };
      const body = type === 'movies'
        ? { movies: [{ ids, watched_at: new Date().toISOString() }] }
        : { shows: [{ ids, watched_at: new Date().toISOString() }] };
      const r = await fetch('https://api.trakt.tv/sync/history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'trakt-api-version': '2',
          'trakt-api-key': TRAKT_CLIENT_ID,
          'Authorization': 'Bearer ' + accessToken,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        body: JSON.stringify(body)
      });
      if (r.ok) {
        // Invalida catalogo e meta così sparisce dal Da vedere
        const catalogId = 'trakt-' + (type === 'movies' ? 'movies' : 'series');
        const metaType = type === 'movies' ? 'movie' : 'series';
        delete cache[catalogId];
        delete metaCache[metaType + ':' + id];
        setImmediate(() => getCatalogCached(catalogId, metaType).catch(() => {}));
        console.log('[watched] Segnato come visto:', id);
        res.send(htmlPage('✅ Segnato come visto!', 'Trakt è stato aggiornato.<br>Chiudi questa pagina e aggiorna Stremio per vederlo scomparire dal catalogo.', '#4ade80'));
      } else {
        res.status(500).send(htmlPage('❌ Errore', 'Non è stato possibile aggiornare Trakt. Riprova.', '#f87171'));
      }
    } catch (e) {
      res.status(500).send(htmlPage('❌ Errore', e.message, '#f87171'));
    }
  });

  app.get('/clear-cache/:token', (req, res) => {
    if (req.params.token !== CLEAR_CACHE_TOKEN) return res.status(403).json({ error: 'Non autorizzato' });
    const catalogCount = Object.keys(cache).length;
    const metaCount = Object.keys(metaCache).length;
    for (const k of Object.keys(cache)) delete cache[k];
    for (const k of Object.keys(metaCache)) delete metaCache[k];
    try { fs.unlinkSync(CACHE_FILE); } catch (e) {}
    console.log('[clear-cache] Cache svuotata manualmente');
    res.json({ ok: true, rimossi: { catalog: catalogCount, meta: metaCount } });
  });

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
