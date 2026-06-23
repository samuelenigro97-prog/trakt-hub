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
const CACHE_TTL = 30 * 60 * 1000; // 30 minuti

const manifest = {
  id: 'it.samuele.trakt.watchlist',
  version: '1.0.0',
  name: 'Trakt Watchlist',
  description: 'Film e serie dalla tua watchlist Trakt',
  resources: ['catalog'],
  types: ['movie', 'series'],
  catalogs: [
    { type: 'movie', id: 'trakt-movies', name: 'Trakt - Film da vedere' },
    { type: 'series', id: 'trakt-series', name: 'Trakt - Serie da vedere' }
  ],
  idPrefixes: ['tt'],
  logo: ADDON_URL + '/logo.png',
  background: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=1280'
};

let accessToken = null;

// cache[type] = { metas: [...], ts: Date.now() }
const cache = {};

function clearCache() {
  Object.keys(cache).forEach(k => delete cache[k]);
}

function loadToken() {
  if (process.env.TRAKT_ACCESS_TOKEN) {
    accessToken = process.env.TRAKT_ACCESS_TOKEN;
    console.log('Token Trakt caricato da variabile d\'ambiente');
    return true;
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      accessToken = data.access_token;
      console.log('Token Trakt caricato da', TOKEN_FILE);
      return true;
    }
  } catch (e) {
    console.error('Errore lettura token:', e.message);
  }
  return false;
}

function saveToken(tokenData) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenData, null, 2));
  accessToken = tokenData.access_token;
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
    throw new Error('Trakt 401: token non valido. Cache svuotata.');
  }
  if (!res.ok) throw new Error('Trakt error: ' + res.status);
  return res.json();
}

async function enrichWithTMDB(imdbId, traktType) {
  try {
    const tmdbType = traktType === 'movies' ? 'movie' : 'tv';
    const res = await fetch(
      'https://api.themoviedb.org/3/find/' + imdbId +
      '?external_source=imdb_id&language=it-IT&api_key=' + TMDB_KEY
    );
    const data = await res.json();
    const results = tmdbType === 'movie' ? data.movie_results : data.tv_results;
    return results && results[0] ? results[0] : null;
  } catch (e) { return null; }
}

async function buildCatalog(type) {
  const traktType = type === 'movie' ? 'movies' : 'shows';
  const items = await getTraktWatchlist(traktType);

  const valid = items.slice(0, 300).filter(item => {
    const obj = item.movie || item.show;
    return obj && obj.ids && obj.ids.imdb;
  });

  // Arricchimento TMDB in batch da 10 richieste parallele
  const BATCH = 10;
  const metas = [];
  for (let i = 0; i < valid.length; i += BATCH) {
    const batch = valid.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async item => {
      const obj = item.movie || item.show;
      const tmdb = await enrichWithTMDB(obj.ids.imdb, traktType);
      return {
        id: obj.ids.imdb,
        type,
        name: (tmdb && (tmdb.title || tmdb.name)) || obj.title,
        poster: tmdb && tmdb.poster_path ? 'https://image.tmdb.org/t/p/w500' + tmdb.poster_path : null,
        description: (tmdb && tmdb.overview) || '',
        year: obj.year
      };
    }));
    metas.push(...results);
  }
  return metas;
}

async function getCatalogCached(type) {
  const entry = cache[type];
  if (entry && (Date.now() - entry.ts) < CACHE_TTL) {
    console.log('[cache hit] ' + type + ' (' + Math.round((CACHE_TTL - (Date.now() - entry.ts)) / 60000) + ' min rimasti)');
    return entry.metas;
  }

  console.log('[cache miss] ' + type + ' — aggiorno dalla API...');
  const metas = await buildCatalog(type);
  cache[type] = { metas, ts: Date.now() };
  console.log('[cache] ' + type + ': ' + metas.length + ' elementi salvati, prossimo refresh tra 30 min');
  return metas;
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
  app.use(getRouter(builder.getInterface()));
  app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

  app.listen(PORT, () => {
    console.log('Trakt addon pronto su ' + ADDON_URL);
    console.log('Manifest: ' + ADDON_URL + '/manifest.json');
  });
}

main().catch(err => {
  console.error('Errore fatale:', err.message);
  process.exit(1);
});
