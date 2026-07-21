# SeggioLink 13.3.7

## Cosa cambia

- Lo storico degli invii confermati viene recuperato dal backend in background.
- La Home resta immediatamente utilizzabile.
- Lo storico server viene unito agli invii locali senza duplicati.
- La coda locale continua a contenere soltanto i tentativi del dispositivo.

## Pubblicazione

1. Sostituire il contenuto del progetto Apps Script con `Code.gs`.
2. Creare una **nuova distribuzione** della Web App.
3. Se cambia l'URL `/exec`, aggiornare `backendUrl` in `config.js`.
4. Pubblicare tutti i file frontend della cartella.
5. Aprire la PWA e verificare che mostri la versione 13.3.7.

Il recupero storico usa blocchi di 500 righe, un limite massimo di 200 risultati e una cache server di 30 secondi.
