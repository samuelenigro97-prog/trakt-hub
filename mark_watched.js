// Marca come "visto" nella libreria Stremio tutti i film E le serie visti su Trakt.
// Legge authKey da ~/.stremio_authkey e il token Trakt da trakt_token.json.
// Uso: node mark_watched.js [--dry]
const fs = require('fs');
const os = require('os');
const path = require('path');

const UA = 'Mozilla/5.0 (compatible; stremio-trakt-addon/1.0)';
const APP_FILE = path.join(__dirname, 'trakt_app.json');   // gitignored: { client_id, client_secret }
const TOKEN_FILE = path.join(__dirname, 'trakt_token.json');
const TRAKT_USER = process.env.TRAKT_USER || 'SamueleNigro';
const DRY = process.argv.includes('--dry');

const APP = JSON.parse(fs.readFileSync(APP_FILE, 'utf8'));
const TRAKT_CID = APP.client_id;
const TRAKT_SECRET = APP.client_secret;

function readAuthKey() {
  const p = path.join(os.homedir(), '.stremio_authkey');
  const k = fs.readFileSync(p, 'utf8').trim();
  if (k.length < 12 || /\s/.test(k)) throw new Error('authKey nel file non valido (len=' + k.length + ')');
  return k;
}

function loadTokenData() { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); }
function saveTokenData(d) { fs.writeFileSync(TOKEN_FILE, JSON.stringify(d, null, 2)); }

async function refreshTraktToken(tok) {
  const res = await fetch('https://api.trakt.tv/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ refresh_token: tok.refresh_token, client_id: TRAKT_CID, client_secret: TRAKT_SECRET, grant_type: 'refresh_token' })
  });
  if (!res.ok) throw new Error('refresh token HTTP ' + res.status);
  const nt = await res.json();
  saveTokenData(nt);
  return nt;
}

// Ritorna un access token valido, rinnovandolo se manca meno di 24h alla scadenza.
async function ensureFreshToken() {
  let tok = loadTokenData();
  const exp = (tok.created_at + tok.expires_in) * 1000;
  if (Date.now() > exp - 24 * 60 * 60 * 1000) {
    console.log('token vicino a scadenza, rinnovo...');
    tok = await refreshTraktToken(tok);
    console.log('token rinnovato');
  }
  return tok.access_token;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// GET Trakt con retry sul 429 (rispetta Retry-After).
async function traktGet(url, token, tries = 5) {
  for (let a = 0; a < tries; a++) {
    const res = await fetch(url, {
      headers: { 'trakt-api-version': '2', 'trakt-api-key': TRAKT_CID, 'Authorization': 'Bearer ' + token, 'User-Agent': UA }
    });
    if (res.status === 429) {
      const wait = (parseInt(res.headers.get('retry-after')) || 2) * 1000 + 500;
      await sleep(wait);
      continue;
    }
    return res;
  }
  throw new Error('Trakt 429 persistente: ' + url);
}

async function traktWatched(token, kind) { // kind: 'movies' | 'shows'
  const res = await traktGet(`https://api.trakt.tv/users/${TRAKT_USER}/watched/${kind}`, token);
  if (!res.ok) throw new Error(`Trakt watched/${kind} HTTP ` + res.status);
  return res.json();
}

// pool con concorrenza limitata
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function traktItTitle(kind, imdb, token) { // kind: 'movies' | 'shows'
  try {
    const r = await traktGet(`https://api.trakt.tv/${kind}/${imdb}/translations/it`, token);
    if (!r.ok) return null;
    const arr = await r.json();
    return (arr && arr[0] && arr[0].title) ? arr[0].title : null;
  } catch (e) { return null; }
}

async function cinemetaMeta(type, imdb) { // type: 'movie' | 'series'
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return {};
    const m = (await r.json()).meta || {};
    return { poster: m.poster || '', background: m.background || '', logo: m.logo || '' };
  } catch (e) { return {}; }
}

// item watched di Trakt (movie o show) → campi comuni
function normalize(w, kind) {
  const o = kind === 'movies' ? w.movie : w.show;
  return { id: o?.ids?.imdb, title: o?.title, year: o?.year, plays: w.plays, watchedAt: w.last_watched_at };
}

async function datastorePut(authKey, changes) {
  const res = await fetch('https://api.strem.io/api/datastorePut', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey, collection: 'libraryItem', changes })
  });
  const j = await res.json().catch(() => ({}));
  if (j && j.error) throw new Error('datastorePut error: ' + JSON.stringify(j.error));
  return j;
}

function buildItem(norm, extra, itTitle, type) { // type: 'movie' | 'series'
  const now = new Date().toISOString();
  return {
    _id: norm.id,
    name: itTitle || norm.title,
    type,
    poster: extra.poster || '',
    posterShape: 'poster',
    background: extra.background || '',
    logo: extra.logo || '',
    year: norm.year || '',
    removed: false,
    temp: false,
    _ctime: now,
    _mtime: now,
    state: {
      lastWatched: norm.watchedAt || now,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: norm.plays || 1,
      flaggedWatched: 1,
      duration: 0,
      video_id: '',
      watched: '',
      noNotif: false,
      season: 0,
      episode: 0
    }
  };
}

// kind = 'movies'|'shows' (Trakt), type = 'movie'|'series' (Stremio)
async function processKind(token, kind, type) {
  const label = type === 'movie' ? 'film' : 'serie';
  const norms = (await traktWatched(token, kind)).map(w => normalize(w, kind));
  const withImdb = norms.filter(n => n.id);
  const skipped = norms.filter(n => !n.id);
  console.log(`${label}: ${norms.length} visti | mappabili ${withImdb.length} | saltati (no IMDb) ${skipped.length}`);
  if (skipped.length) skipped.forEach(n => console.log(`  SKIP (${label}):`, n.title));
  const extras = await mapPool(withImdb, 12, n => cinemetaMeta(type, n.id));
  const itTitles = await mapPool(withImdb, 3, n => traktItTitle(kind, n.id, token));
  return withImdb.map((n, i) => buildItem(n, extras[i] || {}, itTitles[i], type));
}

(async () => {
  const authKey = readAuthKey();
  const token = await ensureFreshToken();
  console.log('recupero visti (film + serie) + poster + titoli IT...');
  const movieItems = await processKind(token, 'movies', 'movie');
  const seriesItems = await processKind(token, 'shows', 'series');
  const items = [...movieItems, ...seriesItems];
  console.log(`totale da scrivere: ${items.length} (film ${movieItems.length}, serie ${seriesItems.length})`);

  if (DRY) {
    console.log('[DRY] esempio film:', JSON.stringify(movieItems[0], null, 2));
    console.log('[DRY] esempio serie:', JSON.stringify(seriesItems[0], null, 2));
    return;
  }

  const CHUNK = 100;
  let ok = 0;
  for (let i = 0; i < items.length; i += CHUNK) {
    const batch = items.slice(i, i + CHUNK);
    await datastorePut(authKey, batch);
    ok += batch.length;
    console.log(`scritti ${ok}/${items.length}`);
  }
  console.log(`✅ FATTO — ${ok} titoli marcati visti (film + serie). Ricarica Stremio.`);
})().catch(e => { console.error('❌ ERRORE:', e.message); process.exit(1); });
