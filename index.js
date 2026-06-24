const { addonBuilder, getRouter } = require('stremio-addon-sdk');
const express = require('express');
const fs = require('fs');
const path = require('path');

const TRAKT_CLIENT_ID = '2c69e58d7f6752cf77f936d4c6ae08b71267a6d8f0ef2b8a146bfb73794a81a4';
const TRAKT_CLIENT_SECRET = process.env.TRAKT_CLIENT_SECRET || 'd7e484d8d9c5ed0513f80ed43446aa348e7523831c282bbf42ee65692b403f86';
const TRAKT_USER = 'SamueleNigro';
const TMDB_KEY = 'edf2b5b43d56fa6eea398145d50a1e98';
const TOKEN_FILE = path.join(__dirname, 'trakt_token.json');
const PORT = parseInt(process.env.PORT || '7779');
const ADDON_URL = (process.env.ADDON_URL || 'http://192.168.178.188:7779').replace(/\/$/, '');
const CACHE_TTL = 60 * 1000; // 1 minuto

const manifest = {
  id: 'it.samuele.trakt.watchlist',
  version: '1.0.9',
  name: 'Trakt Watchlist',
  description: 'Film e serie dalla tua watchlist Trakt',
  resources: ['catalog'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'trakt-movies', name: 'Da vedere' },
    { type: 'series', id: 'trakt-series', name: 'Da vedere' }
  ],
  idPrefixes: ['tt', 'tmdb:'],
  logo: ADDON_URL + '/logo.png',
  background: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=1280'
};

let accessToken = null;
let refreshToken = null;

// cache[type] = { metas: [...], ts: Date.now() }
const cache = {};

function clearCache() {
  Object.keys(cache).forEach(k => delete cache[k]);
}

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

// Rinnova automaticamente il token Trakt prima che scada
async function refreshTraktToken() {
  if (!refreshToken) {
    console.warn('Nessun refresh token disponibile, impossibile rinnovare.');
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
    if (!res.ok) {
      console.error('Refresh token fallito:', res.status);
      return false;
    }
    saveToken(await res.json());
    console.log('Token Trakt rinnovato con successo.');
    return true;
  } catch (e) {
    console.error('Errore refresh token:', e.message);
    return false;
  }
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
    if (tokenRes.status === 200) {
      saveToken(await tokenRes.json());
      console.log('Autenticazione completata! Token salvato in ' + TOKEN_FILE);
      return;
    }
    if (tokenRes.status === 410) throw new Error('Codice scaduto. Riavvia il server.');
    if (tokenRes.status === 418) throw new Error('Autenticazione rifiutata.');
    if (tokenRes.status === 429) await new Promise(r => setTimeout(r, 2000));
    // 400 = in attesa, continua il polling
  }
  throw new Error('Timeout autenticazione. Riavvia il server.');
}

async function getTraktWatchlist(type) {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID,
    'User-Agent': 'Mozilla/5.0 (compatible; stremio-trakt-addon/1.0)'
  };
  if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;

  const res = await fetch(
    'https://api.trakt.tv/users/' + TRAKT_USER + '/watchlist/' + type + '?limit=500',
    { headers }
  );

  if (res.status === 401) {
    clearCache();
    console.warn('Trakt 401: provo a rinnovare il token...');
    const renewed = await refreshTraktToken();
    if (renewed) {
      // Riprova con il nuovo token
      headers['Authorization'] = 'Bearer ' + accessToken;
      const retry = await fetch(
        'https://api.trakt.tv/users/' + TRAKT_USER + '/watchlist/' + type + '?limit=500',
        { headers }
      );
      if (!retry.ok) throw new Error('Trakt error dopo refresh: ' + retry.status);
      return retry.json();
    }
    throw new Error('Trakt 401: token non valido e refresh fallito.');
  }
  if (!res.ok) throw new Error('Trakt error: ' + res.status);
  return res.json();
}

async function getTraktWatched(type) {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': TRAKT_CLIENT_ID,
    'User-Agent': 'Mozilla/5.0 (compatible; stremio-trakt-addon/1.0)'
  };
  if (accessToken) headers['Authorization'] = 'Bearer ' + accessToken;
  try {
    const res = await fetch(
      'https://api.trakt.tv/users/' + TRAKT_USER + '/watched/' + type,
      { headers }
    );
    if (!res.ok) return [];
    return res.json();
  } catch (e) { return []; }
}

async function enrichWithTMDB(imdbId, traktType, tmdbId) {
  try {
    const tmdbType = traktType === 'movies' ? 'movie' : 'tv';

    // Risolvi TMDB ID se non disponibile da Trakt
    let id = tmdbId;
    if (!id && imdbId) {
      const res = await fetch(
        'https://api.themoviedb.org/3/find/' + imdbId +
        '?external_source=imdb_id&api_key=' + TMDB_KEY
      );
      if (res.ok) {
        const data = await res.json();
        const results = tmdbType === 'movie' ? data.movie_results : data.tv_results;
        if (results && results[0]) id = results[0].id;
      }
    }
    if (!id) return null;

    // Fetch italiano e inglese in parallelo
    const [itRes, enRes] = await Promise.all([
      fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + id + '?language=it-IT&api_key=' + TMDB_KEY),
      fetch('https://api.themoviedb.org/3/' + tmdbType + '/' + id + '?language=en-US&api_key=' + TMDB_KEY)
    ]);
    const it = itRes.ok ? await itRes.json() : null;
    const en = enRes.ok ? await enRes.json() : null;
    if (!it && !en) return null;

    return {
      title:        it?.title || it?.name || en?.title || en?.name,
      overview:     (it?.overview?.trim()) || en?.overview || '',
      poster_path:  it?.poster_path  || en?.poster_path,
      backdrop_path: it?.backdrop_path || en?.backdrop_path,
      genres:       (it?.genres || en?.genres || []).map(g => g.name),
      vote_average: (it || en)?.vote_average
    };
  } catch (e) { return null; }
}

async function buildCatalog(type) {
  const traktType = type === 'movie' ? 'movies' : 'shows';

  // Watchlist e visti in parallelo
  const [items, watched] = await Promise.all([
    getTraktWatchlist(traktType),
    getTraktWatched(traktType)
  ]);

  // Set degli ID già visti (film: escludi sempre; serie: escludi solo se completate)
  const watchedImdb = new Set();
  const watchedTmdb = new Set();
  for (const w of watched) {
    const obj = w.movie || w.show;
    if (!obj) continue;
    if (type === 'movie') {
      if (obj.ids.imdb) watchedImdb.add(obj.ids.imdb);
      if (obj.ids.tmdb) watchedTmdb.add(obj.ids.tmdb);
    } else {
      // Serie: escludi solo se tutti gli episodi andati in onda sono stati visti
      const aired = (w.show && w.show.aired_episodes) || 0;
      const seen = (w.seasons || []).reduce((tot, s) => tot + s.episodes.length, 0);
      if (aired > 0 && seen >= aired) {
        if (obj.ids.imdb) watchedImdb.add(obj.ids.imdb);
        if (obj.ids.tmdb) watchedTmdb.add(obj.ids.tmdb);
      }
    }
  }

  // Ordina per data di aggiunta (più recente prima)
  items.sort((a, b) => new Date(b.listed_at) - new Date(a.listed_at));

  const valid = items.slice(0, 300).filter(item => {
    const obj = item.movie || item.show;
    if (!obj || !obj.ids || !(obj.ids.imdb || obj.ids.tmdb)) return false;
    if (obj.ids.imdb && watchedImdb.has(obj.ids.imdb)) return false;
    if (obj.ids.tmdb && watchedTmdb.has(obj.ids.tmdb)) return false;
    return true;
  });

  // Arricchimento TMDB in batch da 10 richieste parallele
  const BATCH = 10;
  const metas = [];
  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async item => {
      const obj = item.movie || item.show;
      const tmdb = await enrichWithTMDB(obj.ids.imdb, traktType, obj.ids.tmdb);
      const stremioId = obj.ids.imdb || ('tmdb:' + obj.ids.tmdb);
      return {
        id: stremioId,
        type,
        name:        (tmdb && tmdb.title) || obj.title,
        poster:      tmdb?.poster_path   ? 'https://image.tmdb.org/t/p/w780'  + tmdb.poster_path   : null,
        background:  tmdb?.backdrop_path ? 'https://image.tmdb.org/t/p/w1280' + tmdb.backdrop_path : null,
        description: tmdb?.overview || '',
        genres:      tmdb?.genres || [],
        imdbRating:  tmdb?.vote_average ? String(tmdb.vote_average.toFixed(1)) : undefined,
        year:        obj.year
      };
    }));
    metas.push(...results);
  }
  return metas;
}

async function getCatalogCached(type) {
  const entry = cache[type];
  if (entry && (Date.now() - entry.ts) < CACHE_TTL) {
    return entry.metas;
  }

  console.log('[cache miss] ' + type + ' — aggiorno dalla API...');
  const metas = await buildCatalog(type);
  cache[type] = { metas, ts: Date.now() };
  console.log('[cache] ' + type + ': ' + metas.length + ' elementi salvati');
  return metas;
}

// Ping a sé stesso ogni 14 minuti per evitare il sleep di Render
function startKeepAlive() {
  if (!process.env.RENDER) return;
  const url = process.env.ADDON_URL || ('http://localhost:' + PORT);
  setInterval(async () => {
    try {
      await fetch(url + '/manifest.json');
      console.log('[keep-alive] ping inviato');
    } catch (e) {
      console.warn('[keep-alive] ping fallito:', e.message);
    }
  }, 14 * 60 * 1000);
  console.log('[keep-alive] attivo, ping ogni 14 minuti');
}

async function main() {
  clearCache();
  if (!loadToken()) {
    if (process.env.RENDER) {
      throw new Error('Token mancante: imposta TRAKT_ACCESS_TOKEN nelle env vars di Render.');
    }
    await authenticateDeviceFlow();
  }

  const builder = new addonBuilder(manifest);

  builder.defineCatalogHandler(async ({ type }) => {
    try {
      const metas = await getCatalogCached(type);
      return { metas };
    } catch (e) {
      console.error('Errore catalogo:', e.message);
      return { metas: [] };
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
