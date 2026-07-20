# Pubblicazione SeggioLink Roma v11

## Regola fondamentale

Il frontend v11 e il backend `apps-script/Code.gs` v11 devono essere pubblicati insieme. Il vecchio backend non restituisce le sessioni richieste dal nuovo frontend.

## Procedura sicura

1. Crea una copia del Google Sheet corrente per il collaudo.
2. Sostituisci il contenuto dello script della copia con `apps-script/Code.gs`.
3. Esegui `inizializza` sulla copia.
4. Distribuisci lo script come nuova Web App e copia l’URL `/exec`.
5. Inserisci l’URL nella costante `BACKEND_URL` di `app.js`.
6. Pubblica questo pacchetto in un repository/branch di staging.
7. Verifica login, sezione assegnata, affluenza, scrutinio, correzione, offline e sincronizzazione.
8. Solo dopo il collaudo, ripeti l’aggiornamento sul foglio e repository di produzione.

## Municipio IX e Roma

Tutti i 15 dataset sono inclusi e validati. Il foglio `Municipi` decide quali territori sono visibili. Per un avvio prudente puoi lasciare attivo solo `09`; l’architettura e i dati restano già pronti per gli altri municipi.

## Limite attuale

Google Apps Script e Google Sheets restano il backend. Questa versione è più sicura e coerente della precedente, ma per un utilizzo simultaneo molto esteso su tutta Roma occorre un collaudo di carico reale e mantenere una procedura di emergenza offline/WhatsApp.
