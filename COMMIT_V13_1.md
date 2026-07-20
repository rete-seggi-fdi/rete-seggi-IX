# SeggioLink Roma v13.1.0 — file pronti da committare

## Modifiche principali

- Login con verifica server-side della coppia **Telefono + Codice**.
- Il telefono viene letto dal foglio `Rappresentanti` e restituito nella sessione.
- Affluenze e scrutini usano il telefono verificato dal server.
- Il foglio `Rappresentanti` deve avere le colonne:
  `Codice | Nome e Cognome | Telefono | Municipio | Sezione | Attivo`.
- La funzione `inizializza()` aggiunge automaticamente la colonna `Telefono` ai fogli esistenti che non la contengono.
- Messaggi distinti per backend non configurato, backend irraggiungibile e credenziali non valide.
- Versione aggiornata a `13.1.0` e cache PWA aggiornata a `seggiolink-v13.1`.

## Prima del commit

Aprire `config.js` e sostituire:

```js
backendUrl: 'https://script.google.com/macros/s/INSERIRE_NUOVO_DEPLOYMENT/exec'
```

con l'URL `/exec` del deployment Apps Script di test.

Non inserire password, token o altre credenziali nel repository.

## Aggiornamento Google Sheet

1. Sostituire il contenuto di Apps Script con `apps-script/Code.gs`.
2. Eseguire manualmente `inizializza()` dall'editor Apps Script.
3. Nel foglio `Rappresentanti`, compilare la nuova colonna `Telefono` per ogni riga.
4. Per un rappresentante assegnato a più sezioni, ripetere lo stesso codice, nome e telefono su tutte le righe.
5. Creare una **nuova distribuzione** della Web App.
6. Copiare il nuovo URL `/exec` in `config.js`.

## Formato consigliato

Il numero può essere scritto con spazi o prefisso italiano. Il backend lo normalizza prima del confronto. Esempi equivalenti:

- `3331234567`
- `333 123 4567`
- `+39 333 123 4567`

## Verifiche eseguite

- Sintassi `app.js`: OK.
- Sintassi `Code.gs`: OK.
- Dataset: 15 municipi, 2.598 sezioni, indice coerente.
