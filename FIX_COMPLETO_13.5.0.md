# SeggioLink 13.5.0 — correzioni audit

## Backend
- Autorizzazione stretta per lettura e conferma messaggi.
- Blocco esplicito degli invii fuori dal Municipio IX.
- Dashboard generale compatibile con `Codice Hash` dopo la migrazione dei codici.
- Statistiche, alert e dashboard generale filtrano gli invii sostituiti.
- Validazione di liste, candidati, sindaci e presidenti contro la configurazione ufficiale.
- Controlli aggiuntivi sui totali di sindaci, presidenti e preferenze.
- Rate limit dashboard separato per credenziale tentata, evitando il blocco globale.
- Versione backend: `13.5.0-production`.

## Frontend/PWA
- Code, storico server, messaggi e timestamp di sincronizzazione separati per identità autenticata.
- Bozze scrutinio separate per identità e sezione.
- Migrazione automatica e prudente dei dati locali delle versioni precedenti.
- Compattazione automatica delle code: tutti i pending/error e gli ultimi 100 invii sincronizzati.
- Installazione del service worker resiliente agli asset opzionali mancanti.
- Versione app e cache: `13.5.0`.

## Controlli eseguiti
- Sintassi JavaScript frontend: OK.
- Sintassi Apps Script trattata come JavaScript: OK.
- Sintassi service worker e dashboard: OK.
- JSON manifest/build-info: OK.
- Dataset: 15 municipi, 2.598 sezioni, indice coerente.

## Pubblicazione
1. Sostituire il `Code.gs` del progetto Apps Script con `apps-script/Code.gs`.
2. Salvare e creare una nuova versione del deployment Web App.
3. Verificare `/exec?action=ping`: deve mostrare `13.5.0-production`.
4. Eseguire `verificaIntegritaArchivio()` e `collaudoMunicipioIX()`.
5. Pubblicare il frontend su GitHub Pages.
6. Aprire l'app online e accettare l'aggiornamento; verificare che il service worker riporti 13.5.0.
7. Eseguire test manuali con un rappresentante di prova e con la dashboard.
