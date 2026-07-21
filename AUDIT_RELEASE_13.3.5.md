# Audit release SeggioLink Municipio IX — 13.3.5

## Modifiche applicate

- Allineata la versione frontend a `13.3.5` in `config.js`, `service-worker.js`, `build-info.json` e `index.html`.
- Impostato l'ambiente su `production`.
- Rimossi i riferimenti `TEST` dal manifest PWA.
- Aggiornato `start_url` a `./index.html?v=1335`.
- Limitata la configurazione operativa al Municipio IX (`enabledMunicipalities: ['09']`, `allowAllMunicipalitiesData: false`).
- Conservato l'URL Apps Script presente nel repository.
- `Code.gs` non è stato analizzato né modificato.

## Verifiche eseguite

- Sintassi JavaScript: OK (`app.js`, `config.js`, `service-worker.js`).
- JSON: OK (`manifest.json`, `build-info.json`, tutti i file dati).
- Integrità dati: 15 municipi, 2.598 sezioni, indice coerente; validazione OK.

## Punto da verificare prima della pubblicazione

Il backend collegato dall'URL Apps Script deve essere realmente la distribuzione aggiornata e deve dichiarare la versione `13.3.2-batch-scrutinio` (o successiva) nell'endpoint di configurazione/health.
