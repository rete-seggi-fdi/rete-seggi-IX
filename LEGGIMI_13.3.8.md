# SeggioLink Roma — release 13.3.8

Correzione dello storico invii:

- recupero tramite codice rappresentante oppure Municipio/sezione autorizzati;
- compatibilità con righe storiche prive della colonna Codice;
- normalizzazione `9` / `09`;
- originali e correzioni restituiti insieme;
- invio originale marcato come `SOSTITUITO`;
- errore di sincronizzazione visibile nella pagina **I miei invii**;
- pulsante **Aggiorna storico**;
- caricamento sempre asincrono, senza bloccare la Home.

## Pubblicazione

1. Sostituire integralmente il Code.gs nel progetto Apps Script.
2. Salvare e creare una nuova versione della distribuzione Web App.
3. Pubblicare tutti i file frontend della cartella.
4. Aprire l'app e usare **I miei invii → Aggiorna storico** per il collaudo.
