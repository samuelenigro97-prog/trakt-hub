# Trakt Hub

Addon Stremio personale collegato a [Trakt](https://trakt.tv): watchlist, "Da vedere", "In arrivo" e "Scegli per me", con possibilità di aggiungere/rimuovere e segnare come visto direttamente da Stremio.

Il nome mostrato dentro Stremio (manifest `name`) è **Trakt Hub**, lo stesso usato nella pagina di installazione (`setup.html`).

## Struttura

- `index.js` — server dell'addon (manifest, cataloghi, azioni Trakt)
- `mark_watched.js` — script per segnare contenuti come visti
- `backfill_series.js` — script di backfill per le serie
- `setup.html` — pagina personale di installazione rapida di tutti gli addon
- `Procfile` — comando di avvio per il deploy (`node index.js`)

## Avvio locale

```bash
npm install
npm start
```

Il manifest dell'addon è disponibile su `/manifest.json` una volta avviato il server.
