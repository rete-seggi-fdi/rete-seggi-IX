# SeggioLink — RELEASE PRODUZIONE 15.3.2

## Componenti
- App rappresentanti: **13.6.1**
- Control Center: **15.3.2**
- Backend Apps Script: **13.7.1-production-final**
- Election Simulator: **3.3.0 — 174 sezioni / 38 plessi** (solo test amministrativo)

## Anagrafica Municipio IX
La produzione usa **174 sezioni / 38 plessi** da `data/sezioni-ix-control.json` e `data/plessi-ix-geocodificati.json`.
La sezione **1294 — Via Salvatore Pincherle 140** resta esclusa: la fonte generale `municipio-09.json` la contiene, ma l'indirizzo appartiene al **Municipio VIII**, quindi non deve entrare nell'anagrafica operativa del Municipio IX.

## Migliorie finali
- login Control Center pulito, senza menu prima dell'accesso;
- sessione unica e dati locali immediati;
- `Dati elettorali` nativi, senza iframe/secondo login;
- snapshot dashboard in CacheService suddiviso in chunk: evita normalmente la lettura del foglio `_DashboardWebCache` a ogni accesso;
- endpoint `ping` non apre più il database;
- backend unico da `config.js`, eliminato fallback obsoleto in `dashboard.js`;
- cache/service worker versionata per la release;
- diagnostica mappa: 38 plessi, 174 sezioni, marker, coordinate e fuori-confine.

## Deploy backend
Il file `apps-script/Code.gs` richiede **nuova versione del deployment Apps Script**. Dopo il deploy eseguire una volta `preparaCacheDashboardWeb()` e verificare `13.7.1-production-final`.

## GO-LIVE
Prima dell'uso reale eliminare tutti i dati SIM- con Election Simulator e disabilitare il simulatore.
