# Fix Scrutinio 13.6.2

Correzioni applicate alla versione 13.6.1 di produzione:

- validazione client dello scrutinio allineata al backend: il totale schede deve coincidere con i votanti;
- storico scrutinio: lettura corretta delle intestazioni `Comune - ...` e `Municipio - ...`, mantenendo compatibilità con i nomi legacy;
- coda invii: l'app mostra il motivo reale restituito dal backend al posto del solo messaggio generico;
- salvataggio scrutinio: ricerca duplicati e pulizia dettagli per `ID Invio` ottimizzate con `TextFinder`, evitando la lettura completa dei fogli;
- versioni aggiornate a PWA 13.6.2 / backend 13.6.2-production.
