# Security Review — SeggioLink / Rete Seggi IX — Release 14.0.7

Data revisione statica: 2026-09-01

## Esito sintetico

La review statica della release 14.0.7 non ha individuato osservazioni aperte di gravità Critica, Alta, Media o Bassa nel perimetro analizzato. Le osservazioni storiche R1–R11 sono state riverificate; R6, R9, R10 e R11 risultano corrette nel pacchetto 14.0.7. Sono state inoltre corrette le osservazioni R12–R15 emerse nella review indipendente successiva.

Questa conclusione riguarda il codice del pacchetto, non certifica il deployment reale finché i file non vengono pubblicati e il nuovo Code.gs non viene distribuito come nuova versione della Web App Apps Script.

## Stato osservazioni

| ID | Gravità | Stato 14.0.7 | Verifica / correzione |
|---|---|---|---|
| R1 | Alta | Corretta | Neutralizzazione formula/CSV injection sui campi scritti nei fogli; ID invio limitati a un formato sicuro. |
| R2 | Media | Corretta | Rate limiting per credenziale e globale mantenuto; i contatori di errore non consentono più di bloccare logicamente un login valido. |
| R3 | Media | Corretta | `?action=ping` non restituisce lo Spreadsheet ID. |
| R4 | Bassa | Corretta | Errori interni sostituiti da risposta pubblica generica con requestId. |
| R5 | Bassa | Corretta | Le sessioni dei rappresentanti vengono riverificate contro l'identità attiva nel foglio Rappresentanti. |
| R6 | Info | Corretta nel sorgente | Worker Cloudflare: rimosso `Access-Control-Allow-Origin: *`; origine ammessa configurabile con `APP_ORIGIN`. Worker ancora inattivo per dati reali. |
| R7 | Info | Corretta | Rotazione password dashboard invalida i token già emessi; presente revoca manuale; codici rappresentanti ruotabili in modo sicuro. |
| R8 | Media | Corretta | Namespace SIM rifiutato sugli endpoint pubblici e simulatore isolato. |
| R9 | Bassa | Corretta | `Code.gs` e `apps-script/Code.gs` sono byte-per-byte identici; documentazione aggiornata indicando il `Code.gs` di radice come fonte autorevole. |
| R10 | Bassa | Corretta | `dashboard.js` usa esclusivamente `sessionStorage` per token e scadenza; residui legacy in `localStorage` vengono rimossi. |
| R11 | Info | Corretta | CSP e `referrer=no-referrer` presenti su index, Control Center, Dashboard e Report finale. |
| R12 | Media | Corretta | L'affluenza accetta server-side solo coppie giorno/orario presenti in `Orari Affluenza`; normalizzazione robusta anche per celle Sheets di tipo ora/Data. |
| R13 | Media | Corretta | I limiti globali/per-credenziale vengono applicati solo dopo aver escluso credenziali corrette: un flood di errori non crea più un lockout logico degli utenti validi. |
| R14 | Bassa | Corretta | Stato messaggi per destinatario in `Messaggi Ricevute`; un rappresentante non modifica più lo stato di un broadcast per tutti gli altri. ACK vincolato alla sezione autorizzata. |
| R15 | Bassa | Corretta | Telefono registrato obbligatorio per l'autenticazione dei rappresentanti; `verificaProduzionePronta()` segnala righe attive senza telefono valido e identità incoerenti. |

## Ulteriore hardening introdotto

- Dashboard e Report inviano richieste con `credentials: 'omit'` e `referrerPolicy: 'no-referrer'`.
- Il Report ha timeout di rete tramite AbortController.
- Cache configurazione, storico e dashboard sono versionate 14.0.7 per evitare residui di release precedenti.
- Il Control Center rimuove anche le vecchie cache locali 14.0.0/15.3.2.
- Il Worker aggiunge `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` e `Vary: Origin` quando applicabile.
- Leaflet resta fissato alla versione 1.9.4 e caricato con Subresource Integrity.
- La validazione anti-duplicato dell'affluenza usa una chiave slot normalizzata, evitando differenze fra stringhe `12:00` e celle Sheets interpretate come orario.
- Le ricevute messaggi vengono aggiornate sotto ScriptLock per evitare duplicati concorrenti.

## Controlli eseguiti

- `node --check` superato per `app.js`, `config.js`, `service-worker.js`, `control-center.js`, `dashboard.js`, `report-finale.js`, `api-client.js`, `ui-core.js`, `worker.js` e, come controllo sintattico JavaScript, `Code.gs`.
- Tutti i JSON del pacchetto risultano validi.
- `tools_validate_data.py`: 15 Municipi, 2598 sezioni, indice 2598 — `VALIDAZIONE OK`.
- 4/4 pagine sensibili contengono CSP e referrer policy.
- Nessuna scrittura del token Dashboard in `localStorage`.
- Nessun wildcard CORS nel Worker.
- Le due copie del backend hanno lo stesso SHA-256.
- Ricerca statica negativa per `eval`, `new Function`, `document.write`, chiavi private, pattern tipici di Google API key, GitHub token, AWS key e JWT hardcoded.
- Service worker confermato: non intercetta richieste cross-origin verso Apps Script.
- Storico, affluenza, scrutinio, code offline e browser guard del frontend rappresentanti non sono stati riscritti: in `app.js` la sola modifica della release 14.0.7 è il numero versione fallback.

## Osservazioni informative residue

1. **Review statica**: non sono stati eseguiti DAST, penetration test attivi, brute force o flooding contro l'endpoint reale.
2. **Disponibilità Apps Script**: il rate limiting evita il lockout logico, ma un attacco volumetrico può comunque consumare quota/tempo Apps Script. Una mitigazione forte richiederebbe un livello edge/proxy con rate limiting per origine/IP o un backend differente.
3. **Dati offline sul dispositivo**: per garantire la modalità offline, code e dati operativi restano in `localStorage` in namespace derivato dal codice; token e codice personale non vengono persistiti. Un utente con accesso fisico al profilo browser può comunque leggere i dati locali.
4. **Anti-clickjacking**: GitHub Pages non consente normalmente di impostare liberamente `Content-Security-Policy: frame-ancestors`; resta quindi la protezione JS di `config.js`. La CSP via meta protegge gli altri vettori supportati.
5. **Worker D1**: la restrizione CORS non è autenticazione. Prima di abilitare il Worker per dati elettorali reali devono essere implementate autenticazione, autorizzazione e rate limiting server-side.
6. **Repository pubblico**: il pacchetto sorgente contiene il backend e il relativo Spreadsheet ID. L'ID non è una credenziale, ma per minimizzare la superficie pubblica è preferibile pubblicare su GitHub Pages un artefatto frontend-only e conservare il backend in un repository/archivio separato.

## Esito go-live del codice

**PASS statico con osservazioni informative residue.** Prima del go-live reale devono ancora essere eseguiti:

1. deployment del nuovo `Code.gs` 14.0.7 come nuova versione Apps Script;
2. `verificaProduzionePronta()` con `ok: true`;
3. smoke test reale di login, storico, quattro slot affluenza, scrutinio/correzione, Dashboard, Control Center, Report e modalità offline;
4. test browser Safari/iPhone, Chrome/Android e Brave con Shields attivi/disattivati.
