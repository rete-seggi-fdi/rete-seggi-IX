# Verifica dataset Roma e adeguamento v11

## Dataset territoriali

- 15 municipi presenti.
- 2.598 sezioni complessive.
- Numeri di sezione univoci nell’intero dataset.
- Nessuna sezione duplicata all’interno dei singoli municipi.
- Tutte le sezioni contengono indirizzo e struttura delle vie.
- `indice-sezioni.json` contiene 2.598 corrispondenze.

## Modifiche principali

- Branding generalizzato a Roma Capitale e municipio dinamico.
- Tutti i dataset municipali disponibili offline tramite Service Worker.
- Login spostato su POST.
- Sessioni temporanee generate dal backend.
- Controllo server-side dell’assegnazione della sezione.
- Validazione server-side di affluenza e scrutinio.
- Lock sulle scritture simultanee.
- Idempotenza tramite ID invio.
- Correzioni tracciate con invio originale e motivazione.
- Diagnostica `health` e versionamento frontend/backend.
- Tutti i municipi inizializzati come attivi; possono essere disattivati dal foglio Municipi.

## Prima della produzione

1. Pubblicare il nuovo `Code.gs` come nuova versione della Web App Apps Script.
2. Aggiornare `BACKEND_URL` in `app.js` se cambia l’URL `/exec`.
3. Eseguire `inizializza` su un foglio di collaudo nuovo.
4. Importare rappresentanti, candidati, liste e orari reali.
5. Eseguire il collaudo completo su staging prima di sostituire la versione corrente.
