# Migrazione progressiva verso Cloudflare D1

Questa versione separa la configurazione runtime dal codice applicativo.

## Stato

- La PWA continua a funzionare con Apps Script impostando `backendProvider: "apps-script"`.
- La struttura D1 e il Worker sono predisposti in `cloudflare/`.
- Il Worker incluso espone soltanto `/health`: non deve ancora essere usato in produzione per affluenze o scrutinio.

## Percorso sicuro

1. Collaudare Municipio IX con Apps Script v11/v12.
2. Creare D1 ed eseguire `0001_initial.sql`.
3. Importare municipi, sezioni, utenti e assegnazioni.
4. Implementare e testare login, config, messaggi e invii nel Worker.
5. Eseguire un periodo di doppia scrittura controllata.
6. Confrontare automaticamente Sheets e D1.
7. Cambiare `backendProvider` e `backendUrl` in `config.js`.
8. Conservare Sheets come esportazione e dashboard, non come fonte primaria.

## Regola

Non attivare `cloudflare-d1` finché i test automatici e la simulazione di carico non risultano superati.
