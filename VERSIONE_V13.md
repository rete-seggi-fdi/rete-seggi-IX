# SeggioLink Roma v13

Questa build rende la versione immediatamente riconoscibile e introduce il controllo aggiornamenti.

## Configurazione
Modificare `config.js`:
- `environment: 'test'` mostra una barra evidente e installa la PWA come ambiente di prova.
- `environment: 'production'` identifica la pubblicazione ufficiale.
- `appVersion` e `buildDate` devono essere aggiornati a ogni rilascio.

## Aggiornamento obbligatorio
`build-info.json` dichiara:
- `latestVersion`: versione più recente;
- `minimumVersion`: versione minima accettata.

Quando la versione aperta è inferiore a `minimumVersion`, l'app blocca l'uso e richiede l'aggiornamento. Anche il backend può imporre `versioneMinima` e `aggiornamentoObbligatorio`.

## Verifica visiva
La versione compare:
- nella pagina di login;
- nel fondo della dashboard;
- nella finestra Informazioni;
- nella diagnostica di assistenza.
