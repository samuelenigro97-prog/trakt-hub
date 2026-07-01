// Backfill una-tantum: scrive lo state.watched per-episodio per TUTTE le serie
// viste su Trakt, nella libreria Stremio. Riusa nome/poster già in libreria.
const WBF = require('stremio-watched-bitfield');
const fs = require('fs');
const os = require('os');
const path = require('path');
const APP = JSON.parse(fs.readFileSync(path.join(__dirname, 'trakt_app.json'), 'utf8'));
const AT = JSON.parse(fs.readFileSync(path.join(__dirname, 'trakt_token.json'), 'utf8')).access_token;
const AK = fs.readFileSync(path.join(os.homedir(), '.stremio_authkey'), 'utf8').trim();
const UA = 'Mozilla/5.0 (compatible; stremio-trakt-addon/1.0)';
const H = { 'trakt-api-version': '2', 'trakt-api-key': APP.client_id, 'Authorization': 'Bearer ' + AT, 'User-Agent': UA };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url, opts) {
  let last;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(url, opts);
      if (r.ok) return r.json();
      last = 'HTTP ' + r.status;
      if (r.status === 429 || r.status >= 500) { await sleep(2000); continue; }
      throw new Error(last);
    } catch (e) { last = e.message; await sleep(1500); }
  }
  throw new Error('esausto: ' + last);
}
async function mapPool(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  async function w() { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, w));
  return out;
}

(async () => {
  const shows = await getJson('https://api.trakt.tv/users/me/watched/shows', { headers: H });
  console.log('serie viste su Trakt:', shows.length);
  const lib = new Map();
  const libRes = await fetch('https://api.strem.io/api/datastoreGet', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authKey: AK, collection: 'libraryItem', all: true })
  }).then(r => r.json());
  (libRes.result || []).forEach(i => { if (!i.removed) lib.set(i._id, i); });

  const withImdb = shows.filter(s => s.show.ids.imdb);
  console.log('con IMDb:', withImdb.length);

  const metas = await mapPool(withImdb, 12, async s => {
    try { return (await getJson('https://v3-cinemeta.strem.io/meta/series/' + s.show.ids.imdb + '.json')).meta; }
    catch (e) { return null; }
  });

  const now = new Date().toISOString();
  const items = [];
  let noVideos = 0;
  withImdb.forEach((s, idx) => {
    const id = s.show.ids.imdb;
    const m = metas[idx];
    const cur = lib.get(id);
    if (!m || !m.videos || !m.videos.length) { noVideos++; return; }
    const videoIds = m.videos.map(v => v.id);
    const watched = new Set();
    s.seasons.forEach(se => se.episodes.forEach(ep => watched.add(id + ':' + se.number + ':' + ep.number)));
    const wbf = WBF.constructFromArray(videoIds.map(() => false), videoIds);
    let matched = 0;
    watched.forEach(vid => { if (videoIds.includes(vid)) { wbf.setVideo(vid, true); matched++; } });
    const totalEps = m.videos.filter(v => v.season >= 1).length;
    const fully = totalEps > 0 && matched >= totalEps;
    items.push({
      _id: id, name: (cur && cur.name) || m.name, type: 'series',
      poster: (cur && cur.poster) || m.poster || '', posterShape: 'poster',
      background: (cur && cur.background) || m.background || '',
      year: m.year || '', removed: false, temp: false,
      _ctime: (cur && cur._ctime) || now, _mtime: now,
      state: {
        lastWatched: s.last_watched_at || now, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0,
        timesWatched: s.plays || 1, flaggedWatched: fully ? 1 : 0, duration: 0, video_id: '',
        watched: wbf.serialize(), noNotif: false, season: 0, episode: 0
      }
    });
  });
  console.log('da scrivere:', items.length, '| saltate (no video Cinemeta):', noVideos);

  let ok = 0;
  for (let i = 0; i < items.length; i += 50) {
    const batch = items.slice(i, i + 50);
    const res = await fetch('https://api.strem.io/api/datastorePut', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authKey: AK, collection: 'libraryItem', changes: batch })
    }).then(r => r.json());
    if (res.error) throw new Error(JSON.stringify(res.error));
    ok += batch.length; console.log('scritte', ok + '/' + items.length);
  }
  console.log('✅ FATTO —', ok, 'serie col visto per-episodio. Ricarica Stremio.');
})().catch(e => { console.error('❌ ERRORE:', e.message); process.exit(1); });
