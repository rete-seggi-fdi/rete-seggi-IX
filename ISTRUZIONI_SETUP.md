# Rete Seggi FdI — Guida alla messa online

Questa guida è per **chi cura il coordinamento centrale**, non per i rappresentanti di lista (per loro c'è un messaggio pronto in fondo, da copiare e incollare). Non servono competenze di programmazione: sono tutti passaggi di "copia, incolla, clicca" su siti Google e GitHub che già conosci o sono semplicissimi da capire.

Tempo richiesto: **circa 20-30 minuti**, una sola volta. Da rifare solo se cambi del tutto il backend.

---

## Cosa fa Claude per te, cosa resta a te

Tutto il codice, i dati elettorali, le icone e i testi sono già pronti in questo pacchetto: non devi scrivere né capire nulla di tecnico. L'unica parte che **deve** avvenire dentro il tuo account Google (per motivi di sicurezza, nessuno strumento esterno può farlo al posto tuo) sono i 5 passaggi qui sotto. Una volta ottenuto il link al Passo 4, mandalo in chat: il collegamento dell'app e la preparazione del pacchetto finale li faccio io.

## Cosa contiene il pacchetto

```
index.html, app.js, styles.css, manifest.json, service-worker.js   → l'app vera e propria
icons/                                                              → icone dell'app
data/municipio-01.json ... municipio-15.json                       → indirizzi seggi e vie, tutti i municipi
apps-script/Code.gs                                                 → il "backend": va incollato in Google
ISTRUZIONI_SETUP.md                                                 → questo file
```

---

## Passo 1 — Crea il foglio Google che farà da database

1. Vai su **sheets.google.com** e crea un nuovo foglio vuoto.
2. Rinominalo, ad esempio **"Rete Seggi FdI – Coordinamento"**.
3. Dal menu in alto: **Estensioni → Apps Script**. Si apre un editor di codice in un'altra schermata.
4. Nell'editor trovi un file `Code.gs` con scritto qualcosa come `function myFunction() {}`. **Seleziona tutto il contenuto e cancellalo.**
5. Apri il file `apps-script/Code.gs` del pacchetto che hai scaricato, copia **tutto** il contenuto, e incollalo nell'editor Apps Script al posto del codice cancellato.
6. In alto, clicca sul nome del progetto ("Progetto senza titolo") e rinominalo, ad esempio **"Backend Rete Seggi"**. Poi salva (icona del dischetto, o Ctrl+S / Cmd+S).

### Esegui l'inizializzazione (una sola volta)

7. In alto, vicino al pulsante "Esegui" (▶), c'è un menu a tendina con i nomi delle funzioni. Selezionaci **`inizializza`**.
8. Clicca **Esegui**.
9. La **prima volta** Google ti chiederà l'autorizzazione: comparirà una finestra "Autorizzazione richiesta". Clicca **Continua**, scegli il tuo account Google, poi se vedi una schermata che dice "Google non ha verificato questa app" clicca su **Avanzate** e poi **Vai al progetto "Backend Rete Seggi" (non sicuro)** — è normale, succede sempre con gli script personali che non sono pubblicati sul Marketplace, non significa che ci sia un problema reale. Infine clicca **Consenti**.
10. Torna sul Google Sheet: dovresti vedere apparsi i fogli **Municipi, Liste, Candidati FdI, Orari Affluenza** (già con qualche dato di esempio) e i fogli vuoti dove arriveranno gli invii.

---

## Passo 2 — Pubblica il backend come "Web App"

1. Sempre nell'editor Apps Script, in alto a destra clicca **Distribuisci → Nuova implementazione**.
2. Clicca sull'icona a forma di ingranaggio vicino a "Seleziona tipo" e scegli **App web**.
3. Compila così (importante):
   - **Esegui come**: Me (il tuo account)
   - **Chi ha accesso**: **Chiunque** ⚠️ *(non "Chiunque con un account Google": deve essere proprio "Chiunque", altrimenti i rappresentanti non riusciranno a inviare i dati)*
4. Clicca **Esegui implementazione**. Ti verrà chiesto di nuovo di autorizzare: ripeti i passaggi del punto 9 sopra se richiesto.
5. Compare un **URL dell'app web**, una riga lunga che finisce con `/exec`. **Copialo, ti serve subito dopo.** Puoi sempre ritrovarlo da Distribuisci → Gestisci implementazioni.

---

## Passo 3 — Collega l'app al backend

1. Apri il file `app.js` (quello scaricato sul tuo computer) con un editor di testo semplice: su Windows va benissimo il **Blocco Note**, su Mac **TextEdit** (assicurati sia in modalità "Testo semplice" dal menu Formato). Niente Word.
2. Vicino all'inizio del file trovi questa riga:
   ```
   const BACKEND_URL = 'INSERISCI_QUI_URL_GOOGLE_APPS_SCRIPT';
   ```
3. Sostituisci il testo tra apici con l'URL copiato al passo 2, mantenendo gli apici:
   ```
   const BACKEND_URL = 'https://script.google.com/macros/s/AKfycb.../exec';
   ```
4. Salva il file (sovrascrivendo l'originale, stesso nome `app.js`, stesso posto).

---

## Passo 4 — Metti l'app online (GitHub Pages, gratis)

GitHub Pages è il modo più semplice e gratuito per avere un link `https://...` che i rappresentanti possono aprire da telefono e "installare" come un'app.

1. Vai su **github.com** e crea un account gratuito, se non ne hai già uno.
2. Clicca il **+** in alto a destra → **New repository**. Dagli un nome semplice, ad esempio `rete-seggi-fdi`. Lascialo **Public**. Crea il repository (non serve aggiungere nessun file extra).
3. Nella pagina del repository, clicca **Add file → Upload files**.
4. Trascina dentro **tutta la cartella** del progetto (o tutti i file e le sottocartelle `data/` e `icons/` insieme): la maggior parte dei browser mantiene la struttura delle cartelle automaticamente. Se invece vedi che `data/` e `icons/` non si sono caricate come cartelle, ripeti l'upload trascinando quelle due cartelle singolarmente.
5. In basso, scrivi un messaggio come "Prima versione" e clicca **Commit changes**.
6. Vai su **Settings** (impostazioni del repository) → nel menu a sinistra **Pages**.
7. Sotto "Build and deployment", **Source: Deploy from a branch**. Scegli branch **main**, cartella **/ (root)**. Clicca **Save**.
8. Aspetta 1-2 minuti e ricarica la pagina: apparirà un link tipo:
   ```
   https://tuonomeutente.github.io/rete-seggi-fdi/
   ```
   **Questo è il link da mandare a tutti i rappresentanti di lista.**

---

## Passo 5 — Personalizza i dati elettorali

Tutto si gestisce **direttamente nel Google Sheet**, modificando le celle: non serve toccare altro codice.

- **Foglio "Municipi"**: metti `TRUE` nella colonna Attivo per ogni municipio che ti interessa (il Municipio IX è già attivo di default).
- **Foglio "Liste"**: una riga per ogni lista in competizione. Colonna "Livello" = `Capitolina` (lascia vuota la colonna Municipio) oppure `Municipio` (e indica il numero, es. `09`).
- **Foglio "Candidati FdI"**: una riga per ogni candidato FdI di cui vuoi raccogliere le preferenze, stesso schema Livello/Municipio.
- **Foglio "Orari Affluenza"**: gli orari di rilevazione che appariranno come pulsanti nell'app. Sono già precompilati con lo schema standard delle comunali (12:00, 19:00, 23:00 la domenica, 12:00 il lunedì): verificali e correggili quando sarà fissata la data ufficiale del voto di Roma Capitale.

Le modifiche sono visibili nell'app non appena un rappresentante la apre con connessione internet (l'app controlla la configurazione a ogni apertura).

---

## Passo 6 — Testala prima di distribuirla

1. Apri il link del Passo 4 dal tuo telefono.
2. Segui la procedura come farebbe un rappresentante: inserisci dati di prova, scegli il Municipio IX, una sezione qualsiasi, invia una rilevazione di affluenza di prova.
3. Torna sul Google Sheet, foglio "Invii Affluenza": dovresti vedere la riga appena arrivata.
4. Una volta verificato che funziona, cancella la riga di prova.

---

## Messaggio pronto da inviare ai rappresentanti di lista

Puoi copiare e adattare questo messaggio:

> Ciao! Per raccogliere affluenza e scrutinio della tua sezione, usa questa app (niente da scaricare dagli store):
> 👉 [INSERISCI QUI IL LINK GITHUB PAGES]
>
> Apri il link, inserisci nome, telefono, municipio e numero di sezione (se non lo sai, c'è una ricerca per via). Da quel momento la trovi pronta: per l'affluenza tocca l'orario e inserisci i numeri; a fine scrutinio vai su "Scrutinio" e inserisci tutti i dati.
>
> Consiglio: la prima volta che apri il link, aggiungilo alla schermata Home del telefono (su iPhone: icona Condividi → "Aggiungi alla schermata Home"; su Android: tocca "Installa app" quando te lo propone). Da lì in poi si apre come un'app vera, anche senza connessione: i dati restano salvati sul telefono e si inviano da soli appena torna la rete. C'è comunque sempre il tasto "Condividi riepilogo" per mandarmi un messaggio di backup su WhatsApp.

---

## Domande frequenti

**"L'app dice Offline"** — È normale dentro un seggio, in cantina o con poco campo: i dati restano salvati sul telefono e si inviano automaticamente non appena torna la connessione. Nessun dato viene perso.

**Un rappresentante ha sbagliato un numero, come si corregge?** — Per ora la correzione si fa direttamente sul Google Sheet: trova la riga (per sezione e orario, o per ID Invio) e modifica il valore nella cella. È buona norma scrivere una nota nella colonna "Note" per tracciare la correzione.

**Devo installarla dall'App Store o da Google Play?** — No. È una pagina web che si comporta come un'app: si apre da un link e si "aggiunge alla schermata Home", senza passare da nessuno store.

**Quanti rappresentanti può gestire?** — Le quote gratuite di Google Apps Script (richieste e tempo di esecuzione giornalieri) sono ampiamente sufficienti per centinaia di rappresentanti che inviano più rilevazioni in un giorno, senza alcun costo.

---

## Da sapere: limiti e attenzioni

- **Nessun login**: chiunque abbia il link può aprire l'app e inviare dati. Per un gruppo di rappresentanti di fiducia va bene, ma non condividere il link pubblicamente fuori da quel gruppo.
- **Il Google Sheet è il database reale**: chiunque abbia accesso al foglio vede tutti i dati raccolti. Condividilo solo con le persone del coordinamento centrale (Condividi → inserisci solo le email delle persone autorizzate), non con i rappresentanti di lista.
- **Niente dati sensibili nei nomi/numeri di telefono oltre il necessario**: servono solo per poter ricontattare chi ha inviato un dato in caso di dubbi.
