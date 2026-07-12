# Collaudo Rete Seggi 7.0

Controlli eseguiti sulla versione consegnata:

- sintassi JavaScript;
- validità del manifest JSON;
- assenza di ID HTML duplicati;
- corrispondenza tra riferimenti JavaScript ed elementi HTML;
- presenza di un gestore per tutti i 38 pulsanti statici;
- accesso con codice e caricamento della sezione;
- Home, navigazione Affluenza, Scrutinio e Invii;
- modifica degli elettori aventi diritto;
- condivisione del riepilogo;
- inserimento e invio di un’affluenza;
- aggiornamento della timeline della Home;
- salvataggio automatico ed eliminazione della bozza scrutinio;
- conferma interna per rimozione del seggio;
- conferma e annullamento del pulsante Esci;
- salvataggio offline, coda locale e sincronizzazione al ritorno della rete.

Il backend è stato simulato durante il collaudo automatico. Prima dell’uso reale va effettuata anche una prova end-to-end sul Google Sheet di test.
