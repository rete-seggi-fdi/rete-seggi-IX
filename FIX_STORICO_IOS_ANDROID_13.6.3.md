# SeggioLink 13.6.3 — Fix storico iOS / Android

## Problema
Android poteva mostrare le affluenze già presenti nella coda/storico locale, mentre un dispositivo iOS senza quei dati locali non riusciva a recuperare lo stesso storico dal backend.

## Causa
Dentro `leggiStoricoInvii()` erano presenti per errore istruzioni del report finale che facevano riferimento a `scrutinioPerId` e `ultimoScrutinioPerSezione`, variabili non definite in quella funzione. In presenza dei fogli dettaglio scrutinio la richiesta `storico_invii` poteva quindi fallire prima di restituire la risposta.

## Correzioni
- rimosso il blocco estraneo da `leggiStoricoInvii()`;
- mantenuto l'arricchimento corretto tramite `arricchisciStoricoScrutini_()`;
- backend aggiornato a `13.6.3-production`;
- app aggiornata a `13.6.3`;
- aggiornati `start_url`, shortcut, script query-string e manifest;
- registrazione service worker versionata con `APP_VERSION` per ridurre il rischio di cache PWA divergente su iOS.

## Test atteso
Con lo stesso rappresentante e la stessa sezione, Android e iOS devono recuperare dal backend lo stesso storico affluenza/scrutinio anche su un dispositivo che non ha mai effettuato quegli invii localmente.
