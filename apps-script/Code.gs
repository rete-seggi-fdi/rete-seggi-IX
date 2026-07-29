/**
 * RETE SEGGI FdI — Backend (Google Apps Script)
 * ------------------------------------------------------------------
 * Questo script trasforma un Google Sheet in un piccolo "server":
 *  - i rappresentanti di lista inviano affluenza e scrutinio dall'app
 *  - lo script salva tutto in fogli separati, leggibili da chiunque
 *    abbia accesso al foglio (il coordinamento centrale)
 *  - la configurazione (municipi attivi, liste, candidati, orari)
 *    si modifica semplicemente editando le celle dei fogli "Municipi",
 *    "Liste", "Candidati FdI", "Orari Affluenza": NON serve toccare
 *    questo codice per cambiarla.
 *
 * PRIMO UTILIZZO: apri questo progetto, scegli la funzione
 * "inizializza" dal menu a tendina in alto e premi "Esegui".
 * Crea automaticamente tutti i fogli necessari con le intestazioni
 * e qualche valore di esempio già pronto da modificare.
 * ------------------------------------------------------------------
 */

const CODICE_BACKEND_VERSIONE = '13.5.0-production';
const MUNICIPIO_ABILITATO = '09';

// Archivio dati ufficiale: il backend legge e scrive sempre in questo file.
const DATABASE_SPREADSHEET_ID = '12CYuUXWWMUCsClHyI3A2B21A1cvLEOBdBiN5bVDJjOU';

const FOGLI = {
  MUNICIPI: 'Municipi',
  LISTE: 'Liste',
  CANDIDATI: 'Candidati FdI',
  SINDACI: 'Candidati Sindaco',
  PRESIDENTI: 'Candidati Presidente',
  ORARI: 'Orari Affluenza',
  RAPPRESENTANTI: 'Rappresentanti',
  AFFLUENZA: 'Invii Affluenza',
  SCRUTINIO: 'Invii Scrutinio',
  VOTI_LISTE: 'Invii Voti Liste',
  PREFERENZE: 'Invii Preferenze',
  VOTI_SINDACI: 'Invii Voti Sindaci',
  VOTI_PRESIDENTI: 'Invii Voti Presidenti',
  MESSAGGI: 'Messaggi',
  LOG: 'Log Errori',
  LOG_TECNICO: 'Log Tecnico',
  DASHBOARD_AFFLUENZA: 'Dashboard Affluenza',
};

// Colonne extra aggiunte agli invii di Affluenza e Scrutinio per gestire
// le correzioni in modo sicuro (vedi APPLICA_CORREZIONE più sotto).
const COLONNE_STATO = [
  'Correzione di', 'Motivo correzione', 'Versione app',
  'Stato', 'Sostituito Da'
];

const NOMI_MUNICIPI = {
  '01': 'Municipio I', '02': 'Municipio II', '03': 'Municipio III',
  '04': 'Municipio IV', '05': 'Municipio V', '06': 'Municipio VI',
  '07': 'Municipio VII', '08': 'Municipio VIII', '09': 'Municipio IX',
  '10': 'Municipio X', '11': 'Municipio XI', '12': 'Municipio XII',
  '13': 'Municipio XIII', '14': 'Municipio XIV', '15': 'Municipio XV',
};


function verificaVersioneCodice() {
  Logger.log('Versione Code.gs: ' + CODICE_BACKEND_VERSIONE);
  console.log('Versione Code.gs: ' + CODICE_BACKEND_VERSIONE);
  return CODICE_BACKEND_VERSIONE;
}

function mostraVersioneCodice() {
  SpreadsheetApp.getUi().alert(
    'Versione Code.gs',
    CODICE_BACKEND_VERSIONE,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

// ===================== ENDPOINT WEB ========================================

function normalizzaAzioneInvio(valore) {
  return String(valore || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function tipoDaAzione(valore) {
  const azione = normalizzaAzioneInvio(valore);
  if (['affluenza', 'salva_affluenza', 'invia_affluenza', 'invio_affluenza'].indexOf(azione) !== -1) return 'affluenza';
  if (['scrutinio', 'salva_scrutinio', 'invia_scrutinio', 'invio_scrutinio'].indexOf(azione) !== -1) return 'scrutinio';
  return '';
}

function provaJson(valore) {
  if (typeof valore !== 'string') return valore;
  const testo = valore.trim();
  if (!testo || (testo[0] !== '{' && testo[0] !== '[')) return valore;
  try { return JSON.parse(testo); } catch (e) { return valore; }
}

function payloadDaParametri(parametri) {
  const p = parametri || {};
  const contenitore = p.invio || p.payload || p.data || p.body;
  if (contenitore) {
    const parsed = provaJson(contenitore);
    if (parsed && typeof parsed === 'object') return parsed;
  }

  const body = {};
  Object.keys(p).forEach(function (chiave) {
    if (chiave === 'action' || chiave === 'azione') return;
    body[chiave] = provaJson(p[chiave]);
  });
  return body;
}

function gestisciInvio(body, tipoSuggerito) {
  body = body || {};
  const tipo = normalizzaAzioneInvio(body.tipo || tipoSuggerito || body.action || body.azione);
  if (tipo === 'login') return verificaCodice(body.codice || '', body.telefono || '', true);
  if (tipo === 'affluenza') return salvaAffluenza(body);
  if (tipo === 'scrutinio') return salvaScrutinio(body);
  if (tipo === 'storico_invii' || tipo === 'storico') return leggiStoricoInvii(body);
  if (tipo === 'dashboard_login') return loginDashboard_(body.password || '');
  if (tipo === 'dashboard_affluenza') return leggiDashboardAffluenzaWeb_(body.dashboardToken || body.token || '');
  if (tipo === 'messaggi') {
    const sessione = richiedeSessione(body.sessionToken);
    if (!sessione.ok) return sessione;
    const autorizzazione = autorizzaSezioneSessione_(sessione.codice, body.municipio, body.sezione);
    if (!autorizzazione.ok) return autorizzazione;
    return leggiMessaggi(autorizzazione.municipio, autorizzazione.sezione);
  }
  if (tipo === 'messaggio_ack') {
    const sessione = richiedeSessione(body.sessionToken);
    if (!sessione.ok) return sessione;
    return aggiornaStatoMessaggioAutorizzato_(sessione.codice, body.id || '', body.stato || '');
  }
  return { ok: false, code: 'UNKNOWN_TYPE', error: 'Tipo richiesta non riconosciuto: ' + tipo };
}

function doGet(e) {
  try {
    const parametri = (e && e.parameter) || {};
    const action = parametri.action || parametri.azione || '';

    if (action === 'config') return jsonOutput(buildConfig());
    if (action === 'ping') { const db = getDatabaseSpreadsheet_(); return jsonOutput({ ok: true, time: new Date().toISOString(), versioneBackend: CODICE_BACKEND_VERSIONE, spreadsheetId: db.getId(), spreadsheetName: db.getName(), ambiente: 'produzione', municipioPilota: '09' }); }
    if (action === 'health') return jsonOutput({ ok: true, time: new Date().toISOString(), versioneBackend: CODICE_BACKEND_VERSIONE, versioneMinima: PropertiesService.getScriptProperties().getProperty('VERSIONE_MINIMA') || '13.4.3' });
    return jsonOutput({ ok: false, error: 'Azione non riconosciuta: ' + action });
  } catch (err) {
    logError('doGet', err);
    return jsonOutput({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOutput({ ok: false, error: 'Richiesta vuota' });
    }
    let body = JSON.parse(e.postData.contents);
    if (body && typeof body === 'object' && (body.payload || body.data) && !body.tipo) {
      const nested = provaJson(body.payload || body.data);
      if (nested && typeof nested === 'object') body = nested;
    }
    return jsonOutput(gestisciInvio(body));
  } catch (err) {
    logError('doPost', err);
    return jsonOutput({ ok: false, error: String(err) });
  }
}

// Risposta a richieste OPTIONS (di norma non necessaria: il client invia
// le POST come "richieste semplici" text/plain per evitare il preflight).
function doOptions(e) {
  return ContentService.createTextOutput('');
}

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.TEXT);
}

// ===================== SESSIONE (token firmato, senza storage lato server) =

/**
 * Il "segreto" con cui firmiamo i token viene generato la prima volta e
 * salvato nelle Proprietà dello script (non nel foglio, non nel codice):
 * così ogni installazione ha una chiave diversa e nessuno può fabbricare
 * token validi senza avervi accesso.
 */
function getTokenSecret() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('TOKEN_SECRET', secret);
  }
  return secret;
}

function getAccessCodePepper_() {
  const props = PropertiesService.getScriptProperties();
  let pepper = props.getProperty('ACCESS_CODE_PEPPER');
  if (!pepper) {
    pepper = Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('ACCESS_CODE_PEPPER', pepper);
  }
  return pepper;
}

function hashCodiceAccesso_(codice) {
  const normalizzato = String(codice || '').trim().toUpperCase();
  if (!normalizzato) return '';
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(normalizzato, getAccessCodePepper_())
  ).replace(/=+$/, '');
}

function identitaCodiceRiga_(riga, idx) {
  const hash = String(valoreColonna(riga, idx, ['Codice Hash']) || '').trim();
  if (hash) return hash;
  return hashCodiceAccesso_(valoreColonna(riga, idx, ['Codice']));
}

// Durata di una sessione: 20 ore, per coprire apertura seggi, affluenza,
// scrutinio e invio finale anche il giorno dopo (es. lunedì mattina).
const DURATA_SESSIONE_MS = 20 * 60 * 60 * 1000;

function creaToken(codice) {
  const scadenza = Date.now() + DURATA_SESSIONE_MS;
  const payload = String(codice).trim() + '|' + scadenza;
  const payloadB64 = Utilities.base64EncodeWebSafe(payload);
  const firma = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getTokenSecret()));
  return { token: payloadB64 + '.' + firma, scadenza: new Date(scadenza).toISOString() };
}

function validaToken(token) {
  if (!token || String(token).indexOf('.') === -1) return { ok: false, error: 'Sessione mancante: effettua nuovamente l\'accesso.' };
  const parti = String(token).split('.');
  if (parti.length !== 2) return { ok: false, error: 'Sessione non valida: effettua nuovamente l\'accesso.' };
  const payloadB64 = parti[0], firma = parti[1];
  const firmaAttesa = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getTokenSecret()));
  if (!confrontoCostanteDashboard_(firma, firmaAttesa)) return { ok: false, error: 'Sessione non valida: effettua nuovamente l\'accesso.' };
  let payload;
  try { payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString(); }
  catch (e) { return { ok: false, error: 'Sessione illeggibile: effettua nuovamente l\'accesso.' }; }
  const parts = payload.split('|');
  const codice = parts[0];
  const scadenza = Number(parts[1]);
  if (!codice || !scadenza || Date.now() > scadenza) return { ok: false, error: 'Sessione scaduta: effettua nuovamente l\'accesso.' };
  return { ok: true, codice: codice };
}

/** Da usare in cima a ogni azione che richiede un accesso già effettuato. */
function richiedeSessione(sessionToken) {
  const esito = validaToken(sessionToken);
  if (!esito.ok) return { ok: false, error: esito.error, code: 'SESSION_INVALID' };
  return esito;
}

// ===================== CONFIGURAZIONE (lettura fogli) ======================

function normalizzaTelefono(v) {
  let numero = String(v === undefined || v === null ? '' : v).replace(/\D/g, '');

  // Normalizza i numeri italiani ricevuti con prefisso internazionale.
  // Esempi equivalenti: 3282511762, +39 3282511762, 0039 3282511762.
  if (numero.indexOf('0039') === 0 && numero.length > 10) numero = numero.substring(4);
  else if (numero.indexOf('39') === 0 && numero.length > 10) numero = numero.substring(2);

  // Alcuni browser/moduli possono aggiungere zeri iniziali non significativi.
  numero = numero.replace(/^0+(?=3)/, '');
  return numero;
}

function telefoniCorrispondono(a, b) {
  const na = normalizzaTelefono(a);
  const nb = normalizzaTelefono(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  // Compatibilità prudente con eventuali prefissi residui: confronta le
  // ultime 10 cifre soltanto quando entrambi i valori ne contengono almeno 10.
  return na.length >= 10 && nb.length >= 10 && na.slice(-10) === nb.slice(-10);
}

function normalizzaSezione_(valore) {
  const testo = String(valore === undefined || valore === null ? '' : valore).trim();
  if (!testo) return '';
  if (/^\d+$/.test(testo)) return String(Number(testo));
  return testo.toUpperCase();
}

function verificaCodice(codice, telefono, richiediTelefono) {
  if (!codice) return { ok: false, error: 'Codice non fornito' };

  // Limite tentativi: rallenta chi prova a indovinare codici a raffica.
  const cache = CacheService.getScriptCache();
  const chiaveTentativi = 'verify_attempts_' + hashCodiceAccesso_(codice).slice(0, 20);
  const tentativi = Number(cache.get(chiaveTentativi) || '0');
  if (tentativi >= 8) {
    return { ok: false, error: 'Troppi tentativi con questo codice. Riprova tra qualche minuto o contatta il coordinamento.', code: 'RATE_LIMITED' };
  }

  const ss = getDatabaseSpreadsheet_();
  const sh = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!sh) return { ok: false, error: 'Foglio rappresentanti non trovato' };
  const rows = sh.getDataRange().getValues();
  const idx = mappaIntestazioni(rows[0]);
  const sezioni = [];
  let nome = '';
  let telefonoRegistrato = '';
  let disattivato = false;
  let codiceTrovato = false;
  let telefonoErrato = false;
  let telefonoCorrispondente = false;
  const telefonoNormalizzato = normalizzaTelefono(telefono);
  const codiceHash = hashCodiceAccesso_(codice);
  if (richiediTelefono && telefonoNormalizzato.length < 8) {
    return { ok: false, code: 'PHONE_REQUIRED', error: 'Numero di telefono non valido.' };
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const cod = valoreColonna(r, idx, ['Codice']);
    const nomeCella = valoreColonna(r, idx, ['Nome e Cognome', 'Nome', 'Rappresentante']);
    const telefonoCella = valoreColonna(r, idx, ['Telefono', 'Cellulare']);
    const municipio = valoreColonna(r, idx, ['Municipio']);
    const sezione = valoreColonna(r, idx, ['Sezione']);
    const attivo = valoreColonna(r, idx, ['Attivo']);
    if (!cod && !valoreColonna(r, idx, ['Codice Hash'])) continue;
    if (identitaCodiceRiga_(r, idx) !== codiceHash) continue;
    codiceTrovato = true;

    const isAttivo = attivo === true || String(attivo).toUpperCase() === 'TRUE' || String(attivo).toUpperCase() === 'VERO';
    if (!isAttivo) { disattivato = true; continue; }

    const telefonoRiga = normalizzaTelefono(telefonoCella);

    // Il codice personale attivo resta la credenziale principale. Il numero
    // inserito dall'utente serve come controllo aggiuntivo, ma differenze di
    // formato, compilazione automatica o cache del browser non devono impedire
    // l'accesso. Quando il foglio contiene un telefono, viene sempre usato il
    // valore registrato dal coordinamento.
    if (richiediTelefono && telefonoRiga && telefonoNormalizzato &&
        !telefoniCorrispondono(telefonoRiga, telefonoNormalizzato)) {
      telefonoErrato = true;
      continue;
    }
    if (!richiediTelefono || !telefonoRiga || telefoniCorrispondono(telefonoRiga, telefonoNormalizzato)) {
      telefonoCorrispondente = true;
    }

    if (!nome) nome = String(nomeCella).trim();
    if (!telefonoRegistrato) telefonoRegistrato = telefonoRiga;
    if (municipio && sezione) {
      sezioni.push({
        municipio: String(Math.round(Number(municipio))).padStart(2, '0'),
        sezione: String(sezione).trim(),
      });
    }
  }

  if (richiediTelefono && codiceTrovato && !telefonoCorrispondente) {
    cache.put(chiaveTentativi, String(tentativi + 1), 600);
    return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Codice o telefono non validi.' };
  }

  if (!nome && !sezioni.length) {
    cache.put(chiaveTentativi, String(tentativi + 1), 600); // 10 minuti
    if (disattivato && !telefonoErrato) return { ok: false, error: 'Codice disattivato. Contatta il coordinamento.' };
    if (codiceTrovato && telefonoErrato) return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Codice o telefono non validi.' };
    return { ok: false, error: 'Codice non riconosciuto. Controlla di averlo scritto correttamente.' };
  }

  cache.remove(chiaveTentativi);
  const sessione = creaToken(codiceHash);
  const dataRevision = PropertiesService.getScriptProperties().getProperty('DATA_REVISION') || '';
  return { ok: true, nome: nome, telefono: telefonoRegistrato || telefonoNormalizzato, sezioni: sezioni, sessionToken: sessione.token, sessionExpiresAt: sessione.scadenza, dataRevision: dataRevision };
}

function buildConfig() {
  const ss = getDatabaseSpreadsheet_();

  // --- Municipi ---
  const municipi = [];
  const fMun = ss.getSheetByName(FOGLI.MUNICIPI);
  if (fMun) {
    const rows = fMun.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [municipio, nome, attivo] = rows[i];
      if (!municipio) continue;
      municipi.push({
        m: String(municipio).trim().padStart(2, '0'),
        nome: nome || '',
        attivo: attivo === true || String(attivo).toUpperCase() === 'TRUE' || String(attivo).toUpperCase() === 'VERO',
      });
    }
  }

  // --- Liste in competizione ---
  const liste = { capitolina: [], municipio: {} };
  const fListe = ss.getSheetByName(FOGLI.LISTE);
  if (fListe) {
    const rows = fListe.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [livello, municipio, nomeLista] = rows[i];
      if (!nomeLista) continue;
      if (String(livello).toLowerCase().indexOf('capitolina') !== -1) {
        liste.capitolina.push(String(nomeLista).trim());
      } else {
        const mu = String(municipio).trim().padStart(2, '0');
        liste.municipio[mu] = liste.municipio[mu] || [];
        liste.municipio[mu].push(String(nomeLista).trim());
      }
    }
  }

  // --- Candidati FdI (per le preferenze) ---
  const candidati = { capitolina: [], municipio: {} };
  const fCand = ss.getSheetByName(FOGLI.CANDIDATI);
  if (fCand) {
    const rows = fCand.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [livello, municipio, nomeCognome] = rows[i];
      if (!nomeCognome) continue;
      if (String(livello).toLowerCase().indexOf('capitolina') !== -1) {
        candidati.capitolina.push(String(nomeCognome).trim());
      } else {
        const mu = String(municipio).trim().padStart(2, '0');
        candidati.municipio[mu] = candidati.municipio[mu] || [];
        candidati.municipio[mu].push(String(nomeCognome).trim());
      }
    }
  }

  // --- Orari affluenza ---
  const orari = [];
  const fOrari = ss.getSheetByName(FOGLI.ORARI);
  if (fOrari) {
    const rows = fOrari.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [giorno, orario] = rows[i];
      if (!orario) continue;
      orari.push({ giorno: giorno || '', orario: String(orario).trim() });
    }
  }

  // --- Candidati Sindaco ---
  const sindaci = [];
  const fSind = ss.getSheetByName(FOGLI.SINDACI);
  if (fSind) {
    const rows = fSind.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [nome] = rows[i];
      if (nome) sindaci.push(String(nome).trim());
    }
  }

  // --- Candidati Presidente di Municipio ---
  const presidenti = {};
  const fPres = ss.getSheetByName(FOGLI.PRESIDENTI);
  if (fPres) {
    const rows = fPres.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [municipio, nome] = rows[i];
      if (!nome) continue;
      const mu = String(municipio).trim().padStart(2, '0');
      presidenti[mu] = presidenti[mu] || [];
      presidenti[mu].push(String(nome).trim());
    }
  }

  const props = PropertiesService.getScriptProperties();
  const app = {
    versioneMinima: props.getProperty('VERSIONE_MINIMA') || '13.4.3',
    aggiornamentoObbligatorio: props.getProperty('AGGIORNAMENTO_OBBLIGATORIO') === 'true',
  };
  const dataRevision = props.getProperty('DATA_REVISION') || '';

  return { ok: true, municipi, liste, candidati, sindaci, presidenti, orari, app, dataRevision, generatoIl: new Date().toISOString() };
}


// ===================== STORICO INVII =========================================

function dataIsoStorico_(valore) {
  if (valore instanceof Date && !isNaN(valore.getTime())) return valore.toISOString();
  const d = new Date(valore);
  return isNaN(d.getTime()) ? String(valore || '') : d.toISOString();
}

function normalizzaMunicipioStorico_(valore) {
  const testo = String(valore === undefined || valore === null ? '' : valore).trim();
  if (!testo) return '';
  const numero = Number(testo.replace(/\D/g, ''));
  return Number.isFinite(numero) && numero > 0 ? String(Math.round(numero)).padStart(2, '0') : testo.padStart(2, '0');
}

function chiaveSezioneStorico_(municipio, sezione) {
  return normalizzaMunicipioStorico_(municipio) + '|' + normalizzaSezione_(sezione);
}

/**
 * Restituisce la percentuale di affluenza come numero visuale:
 * 0,526 nel foglio diventa 52,6; 52,6 resta 52,6.
 * Se la cella è vuota, la calcola da totale ed elettori.
 */
function percentualeStoricoAffluenza_(valorePercentuale, totale, elettori) {
  let percentuale = numOrVuoto(valorePercentuale);

  if (percentuale !== '') {
    percentuale = Number(percentuale);
    if (!isFinite(percentuale)) percentuale = '';
    else if (Math.abs(percentuale) <= 1) percentuale = percentuale * 100;
  }

  if (percentuale === '') {
    const totaleNumero = numOrVuoto(totale);
    const elettoriNumero = numOrVuoto(elettori);
    if (totaleNumero !== '' && elettoriNumero !== '' && Number(elettoriNumero) > 0) {
      percentuale = Number(totaleNumero) / Number(elettoriNumero) * 100;
    }
  }

  return percentuale === ''
    ? ''
    : Math.round(Number(percentuale) * 10) / 10;
}

/** Tutte le sezioni che il codice firmato può consultare. */
function sezioniAutorizzateDaCodice_(codice) {
  const risultato = [];
  const viste = {};
  const codiceCercato = String(codice || '').trim();
  if (!codiceCercato) return risultato;

  const sh = getDatabaseSpreadsheet_().getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!sh || sh.getLastRow() < 2) return risultato;
  const righe = sh.getDataRange().getValues();
  const idx = mappaIntestazioni(righe[0]);

  for (let i = 1; i < righe.length; i++) {
    const r = righe[i];
    if (identitaCodiceRiga_(r, idx) !== codiceCercato) continue;
    const attivo = valoreColonna(r, idx, ['Attivo']);
    const isAttivo = attivo === true || ['TRUE', 'VERO', '1'].indexOf(String(attivo).trim().toUpperCase()) !== -1;
    if (!isAttivo) continue;
    const municipio = normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio']));
    const sezione = String(valoreColonna(r, idx, ['Sezione']) || '').trim();
    const key = chiaveSezioneStorico_(municipio, sezione);
    if (municipio && sezione && !viste[key]) {
      viste[key] = true;
      risultato.push({ municipio: municipio, sezione: sezione, key: key });
    }
  }
  return risultato;
}

function leggiStoricoFoglio_(sheet, tipo, codice, sezioniAutorizzate, limite) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  const lastColumn = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0];
  const idx = mappaIntestazioni(headers);
  const risultati = [];
  const blocco = 400;
  const sezioniSet = {};
  (sezioniAutorizzate || []).forEach(function(s) { sezioniSet[s.key] = true; });
  let fine = sheet.getLastRow();

  while (fine >= 2 && risultati.length < limite) {
    const inizio = Math.max(2, fine - blocco + 1);
    const righe = sheet.getRange(inizio, 1, fine - inizio + 1, lastColumn).getValues();
    for (let i = righe.length - 1; i >= 0 && risultati.length < limite; i--) {
      const r = righe[i];
      const codiceRiga = String(valoreColonna(r, idx, ['Codice']) || '').trim();
      const municipio = normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio']));
      const sezione = String(valoreColonna(r, idx, ['Sezione']) || '').trim();
      const appartienePerCodice = !!codiceRiga && codiceRiga === codice;
      const appartienePerSezione = !!sezioniSet[chiaveSezioneStorico_(municipio, sezione)];
      // Compatibilità: gli invii storici possono non avere la colonna Codice,
      // ma devono appartenere a una sezione autorizzata dal token.
      if (!appartienePerCodice && !appartienePerSezione) continue;

      risultati.push({
        idInvio: String(valoreColonna(r, idx, ['ID Invio']) || ''),
        tipo: tipo,
        creato: dataIsoStorico_(valoreColonna(r, idx, ['Timestamp'])),
        municipio: municipio,
        sezione: sezione,
        giorno: tipo === 'affluenza' ? String(valoreColonna(r, idx, ['Giorno']) || '') : '',
        orario: tipo === 'affluenza' ? String(valoreColonna(r, idx, ['Orario']) || '') : '',
        elettori: numOrVuoto(valoreColonna(r, idx, ['Elettori'])),
        maschi: tipo === 'affluenza'
          ? numOrVuoto(valoreColonna(r, idx, ['Maschi']))
          : '',
        femmine: tipo === 'affluenza'
          ? numOrVuoto(valoreColonna(r, idx, ['Femmine']))
          : '',
        totale: tipo === 'affluenza'
          ? numOrVuoto(valoreColonna(r, idx, ['Totale']))
          : '',
        percentuale: tipo === 'affluenza'
          ? percentualeStoricoAffluenza_(
              valoreColonna(r, idx, ['% Affluenza', 'Percentuale', 'Affluenza']),
              valoreColonna(r, idx, ['Totale']),
              valoreColonna(r, idx, ['Elettori'])
            )
          : '',
        votanti: tipo === 'scrutinio'
          ? numOrVuoto(valoreColonna(r, idx, ['Votanti']))
          : '',
        schedaComune: tipo === 'scrutinio' ? {
          valide: numOrVuoto(valoreColonna(r, idx, ['Comune valide'])),
          bianche: numOrVuoto(valoreColonna(r, idx, ['Comune bianche'])),
          nulle: numOrVuoto(valoreColonna(r, idx, ['Comune nulle'])),
          contestate: numOrVuoto(valoreColonna(r, idx, ['Comune contestate']))
        } : {},
        schedaMunicipio: tipo === 'scrutinio' ? {
          valide: numOrVuoto(valoreColonna(r, idx, ['Municipio valide'])),
          bianche: numOrVuoto(valoreColonna(r, idx, ['Municipio bianche'])),
          nulle: numOrVuoto(valoreColonna(r, idx, ['Municipio nulle'])),
          contestate: numOrVuoto(valoreColonna(r, idx, ['Municipio contestate']))
        } : {},
        note: String(valoreColonna(r, idx, ['Note']) || ''),
        correzioneDi: String(valoreColonna(r, idx, ['Correzione di']) || ''),
        motivoCorrezione: String(valoreColonna(r, idx, ['Motivo correzione']) || ''),
        versioneApp: String(valoreColonna(r, idx, ['Versione app']) || ''),
        statoPersistito: String(valoreColonna(r, idx, ['Stato']) || ''),
        sostituitoDaPersistito: String(valoreColonna(r, idx, ['Sostituito Da']) || ''),
        recuperatoPer: appartienePerCodice ? 'codice' : 'sezione'
      });
    }
    fine = inizio - 1;
  }
  return risultati;
}


function arricchisciStoricoScrutini_(ss, scrutini) {
  const perId = {};
  (scrutini || []).forEach(function(item) {
    const id = String(item && item.idInvio || '');
    if (!id) return;
    item.liste = [];
    item.preferenze = [];
    item.sindaci = [];
    item.presidenti = [];
    perId[id] = item;
  });

  function leggiDettagli(nomeFoglio, callback) {
    const sh = ss.getSheetByName(nomeFoglio);
    if (!sh || sh.getLastRow() < 2) return;
    const valori = sh.getDataRange().getValues();
    const idx = mappaIntestazioni(valori[0]);

    for (let i = 1; i < valori.length; i++) {
      const r = valori[i];
      const id = String(valoreColonna(r, idx, ['ID Invio']) || '');
      const item = perId[id];
      if (!item) continue;

      const municipio = normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio']));
      const sezione = String(valoreColonna(r, idx, ['Sezione']) || '').trim();
      if (municipio !== item.municipio || sezione !== item.sezione) continue;

      callback(item, r, idx);
    }
  }

  leggiDettagli(FOGLI.VOTI_LISTE, function(item, r, idx) {
    const nome = String(valoreColonna(r, idx, ['Lista']) || '');
    if (!nome) return;
    item.liste.push({
      livello: String(valoreColonna(r, idx, ['Livello']) || ''),
      nome: nome,
      voti: numOrVuoto(valoreColonna(r, idx, ['Voti']))
    });
  });

  leggiDettagli(FOGLI.PREFERENZE, function(item, r, idx) {
    const candidato = String(valoreColonna(r, idx, ['Candidato']) || '');
    if (!candidato) return;
    item.preferenze.push({
      livello: String(valoreColonna(r, idx, ['Livello']) || ''),
      candidato: candidato,
      voti: numOrVuoto(valoreColonna(r, idx, ['Preferenze', 'Voti']))
    });
  });

  leggiDettagli(FOGLI.VOTI_SINDACI, function(item, r, idx) {
    const nome = String(valoreColonna(r, idx, ['Candidato Sindaco', 'Candidato']) || '');
    if (!nome) return;
    item.sindaci.push({
      nome: nome,
      voti: numOrVuoto(valoreColonna(r, idx, ['Voti']))
    });
  });

  leggiDettagli(FOGLI.VOTI_PRESIDENTI, function(item, r, idx) {
    const nome = String(valoreColonna(r, idx, ['Candidato Presidente', 'Candidato']) || '');
    if (!nome) return;
    item.presidenti.push({
      nome: nome,
      voti: numOrVuoto(valoreColonna(r, idx, ['Voti']))
    });
  });

  return scrutini;
}

function leggiStoricoInvii(body) {
  body = body || {};
  const sessione = richiedeSessione(body.sessionToken);
  if (!sessione.ok) return sessione;

  const limiteRichiesto = Number(body.limit || 100);
  const limite = Math.max(10, Math.min(200, isNaN(limiteRichiesto) ? 100 : limiteRichiesto));
  const codice = String(sessione.codice || '').trim();
  const sezioniAutorizzate = sezioniAutorizzateDaCodice_(codice);
  if (!sezioniAutorizzate.length) {
    return { ok: false, code: 'NO_AUTHORIZED_SECTIONS', error: 'Nessuna sezione attiva associata alla sessione.' };
  }

  const cache = CacheService.getScriptCache();
  const cacheKey = 'storico_invii_1341_scrutinio_completo_' + codice + '_' + limite;
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const ss = getDatabaseSpreadsheet_();
  const aff = leggiStoricoFoglio_(ss.getSheetByName(FOGLI.AFFLUENZA), 'affluenza', codice, sezioniAutorizzate, limite);
  const scr = leggiStoricoFoglio_(ss.getSheetByName(FOGLI.SCRUTINIO), 'scrutinio', codice, sezioniAutorizzate, limite);
  arricchisciStoricoScrutini_(ss, scr);
  const items = aff.concat(scr)
    .filter(function(it) { return !!it.idInvio; })
    .sort(function(a, b) { return String(a.creato) < String(b.creato) ? 1 : -1; })
    .slice(0, limite);

  const sostituiti = {};
  items.forEach(function(it) {
    if (it.correzioneDi) sostituiti[String(it.correzioneDi)] = String(it.idInvio || '');
  });
  items.forEach(function(it) {
    it.sostituito = String(it.statoPersistito || '').toUpperCase() === 'SOSTITUITO' ||
      !!it.sostituitoDaPersistito || !!sostituiti[String(it.idInvio || '')];
    it.sostituitoDa = it.sostituitoDaPersistito || sostituiti[String(it.idInvio || '')] || '';
    it.stato = it.sostituito ? 'SOSTITUITO' : 'ATTIVO';
    delete it.statoPersistito;
    delete it.sostituitoDaPersistito;
  });

  const risposta = {
    ok: true,
    items: items,
    authorizedSections: sezioniAutorizzate.map(function(s) { return { municipio: s.municipio, sezione: s.sezione }; }),
    count: items.length,
    serverTime: new Date().toISOString(),
    versioneBackend: CODICE_BACKEND_VERSIONE
  };
  try { cache.put(cacheKey, JSON.stringify(risposta), 20); } catch (e) {}
  return risposta;
}

// ===================== SALVATAGGIO INVII =====================================

function primoValorePresente_(oggetto, chiavi) {
  oggetto = oggetto || {};
  for (let i = 0; i < chiavi.length; i++) {
    const valore = oggetto[chiavi[i]];
    if (valore !== undefined && valore !== null && String(valore).trim() !== '') return valore;
  }
  return '';
}

/**
 * Accetta sia i nomi storici del backend sia i nomi usati dalle diverse
 * versioni della PWA. In questo modo un aggiornamento del frontend non sposta
 * o perde i valori nel foglio.
 */
function normalizzaPayloadAffluenza_(body) {
  body = body || {};
  const dati = Object.assign({}, body);

  dati.idInvio = primoValorePresente_(body, ['idInvio', 'id', 'uuid', 'submissionId']);
  dati.codice = primoValorePresente_(body, ['codice', 'codiceRappresentante', 'representativeCode']);
  dati.rappresentante = primoValorePresente_(body, ['rappresentante', 'nome', 'nomeCognome', 'nomeECognome']);
  dati.telefono = primoValorePresente_(body, ['telefono', 'cellulare', 'phone']);
  dati.municipio = primoValorePresente_(body, ['municipio', 'municipality']);
  dati.sezione = primoValorePresente_(body, ['sezione', 'numeroSezione', 'section']);
  dati.giorno = primoValorePresente_(body, ['giorno', 'day']);
  dati.orario = primoValorePresente_(body, ['orario', 'ora', 'fasciaOraria', 'time']);

  dati.elettori = primoValorePresente_(body, [
    'elettori', 'aventiDiritto', 'aventiDirittoTotali', 'elettoriTotali',
    'totaleElettori', 'totElettori', 'elettoriSezione', 'numeroElettori',
    'registeredVoters'
  ]);

  // Alcune versioni della PWA racchiudono i valori dentro `dati`, `payload`
  // oppure `affluenza`. Recupera l'elettorato anche da questi contenitori.
  if (dati.elettori === '') {
    const contenitori = [body.dati, body.payload, body.affluenza, body.data];
    for (let i = 0; i < contenitori.length && dati.elettori === ''; i++) {
      dati.elettori = primoValorePresente_(contenitori[i], [
        'elettori', 'aventiDiritto', 'aventiDirittoTotali', 'elettoriTotali',
        'totaleElettori', 'totElettori', 'elettoriSezione', 'numeroElettori',
        'registeredVoters'
      ]);
    }
  }
  dati.maschi = primoValorePresente_(body, [
    'maschi', 'votantiMaschi', 'maschiVotanti', 'uomini', 'male', 'm'
  ]);
  dati.femmine = primoValorePresente_(body, [
    'femmine', 'votantiFemmine', 'femmineVotanti', 'donne', 'female', 'f'
  ]);
  dati.totale = primoValorePresente_(body, [
    'totale', 'votanti', 'totaleVotanti', 'votantiTotali', 'total'
  ]);

  dati.note = primoValorePresente_(body, ['note', 'annotazioni']);
  dati.correzioneDi = primoValorePresente_(body, ['correzioneDi', 'correctionOf']);
  dati.motivoCorrezione = primoValorePresente_(body, ['motivoCorrezione', 'correctionReason']);
  dati.versioneApp = primoValorePresente_(body, ['versioneApp', 'appVersion', 'versione']);
  return dati;
}

/** Recupera l'assegnazione esatta richiesta dal codice autenticato. */
function datiRappresentanteDaCodice_(codice, municipioRichiesto, sezioneRichiesta) {
  const risultato = {
    codice: String(codice || '').trim(),
    nome: '',
    telefono: '',
    municipio: '',
    sezione: '',
    attivo: false,
    trovato: false
  };
  if (!risultato.codice) return risultato;
  const municipioTarget = normalizzaMunicipioStorico_(municipioRichiesto);
  const sezioneTarget = normalizzaSezione_(sezioneRichiesta);

  const sh = getDatabaseSpreadsheet_().getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!sh || sh.getLastRow() < 2) return risultato;
  const righe = sh.getDataRange().getValues();
  const idx = mappaIntestazioni(righe[0]);

  for (let i = 1; i < righe.length; i++) {
    const r = righe[i];
    if (identitaCodiceRiga_(r, idx) !== risultato.codice) continue;
    const municipioRiga = normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio']));
    const sezioneRiga = normalizzaSezione_(valoreColonna(r, idx, ['Sezione']));
    if (municipioTarget && municipioRiga !== municipioTarget) continue;
    if (sezioneTarget && sezioneRiga !== sezioneTarget) continue;
    risultato.nome = String(valoreColonna(r, idx, ['Nome e Cognome', 'Nome', 'Rappresentante']) || '').trim();
    risultato.telefono = normalizzaTelefono(valoreColonna(r, idx, ['Telefono', 'Cellulare']));
    risultato.municipio = municipioRiga;
    risultato.sezione = String(valoreColonna(r, idx, ['Sezione']) || '').trim();
    const attivo = valoreColonna(r, idx, ['Attivo']);
    risultato.attivo = attivo === true || String(attivo).trim().toUpperCase() === 'TRUE' || String(attivo).trim() === '1';
    risultato.trovato = true;
    break;
  }
  return risultato;
}


/**
 * Recupera il numero degli elettori quando la PWA non lo reinvia nel payload.
 * Cerca prima nello scrutinio più recente della stessa sezione e poi negli
 * invii di affluenza precedenti. Restituisce stringa vuota se non disponibile.
 */
function recuperaElettoriSezione_(municipio, sezione) {
  const ss = getDatabaseSpreadsheet_();
  const nomiFogli = [FOGLI.SCRUTINIO, FOGLI.AFFLUENZA];
  const munCercato = String(municipio || '').trim().replace(/^0+/, '');
  const sezCercata = String(sezione || '').trim();

  for (let f = 0; f < nomiFogli.length; f++) {
    const sh = ss.getSheetByName(nomiFogli[f]);
    if (!sh || sh.getLastRow() < 2) continue;

    const valori = sh.getDataRange().getValues();
    const idx = mappaIntestazioni(valori[0]);
    for (let i = valori.length - 1; i >= 1; i--) {
      const r = valori[i];
      const mun = String(valoreColonna(r, idx, ['Municipio']) || '').trim().replace(/^0+/, '');
      const sez = String(valoreColonna(r, idx, ['Sezione']) || '').trim();
      if (mun !== munCercato || sez !== sezCercata) continue;

      const elettori = numOrVuoto(valoreColonna(r, idx, ['Elettori']));
      if (elettori !== '' && Number(elettori) > 0) return elettori;
    }
  }
  return '';
}

function salvaAffluenza(body) {
  const sessione = richiedeSessione(body && body.sessionToken);
  if (!sessione.ok) return sessione;

  body = normalizzaPayloadAffluenza_(body);

  // Il codice contenuto nel token firmato è la fonte autorevole. Anche quando
  // la PWA non reinvia nome/codice a ogni salvataggio, le colonne vengono
  // compilate automaticamente dal foglio Rappresentanti.
  const anagrafica = datiRappresentanteDaCodice_(sessione.codice, body.municipio, body.sezione);
  if (!anagrafica.trovato || !anagrafica.attivo) {
    logTecnico_('affluenza', 'RIFIUTATO', body && body.idInvio, sessione.codice, '', '', 'Rappresentante assente o non attivo', body && body.versioneApp);
    return { ok: false, error: 'Rappresentante non abilitato. Effettua nuovamente l\'accesso.', code: 'REPRESENTATIVE_DISABLED' };
  }
  body.codice = anagrafica.codice;
  body.rappresentante = anagrafica.nome;
  body.telefono = anagrafica.telefono;
  // Municipio e sezione provengono dall'archivio ufficiale, non dal browser.
  body.municipio = anagrafica.municipio || body.municipio || '';
  body.sezione = anagrafica.sezione || body.sezione || '';
  if (normalizzaMunicipioStorico_(body.municipio) !== MUNICIPIO_ABILITATO) {
    return { ok: false, code: 'MUNICIPALITY_NOT_ENABLED', error: 'Questa installazione è riservata al Municipio IX.' };
  }

  const erroreValidazione = validaDatiAffluenza(body);
  if (erroreValidazione) return { ok: false, error: erroreValidazione, code: 'INVALID_DATA' };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { ok: false, error: 'Il coordinamento sta ricevendo molti invii in questo momento. Riprova tra pochi secondi.', code: 'BUSY' };
  }

  try {
    const idInvio = body.idInvio || Utilities.getUuid();
    const intestazioni = [
      'Timestamp', 'ID Invio', 'Codice', 'Nome e Cognome', 'Municipio', 'Sezione', 'Telefono',
      'Giorno', 'Orario', 'Elettori', 'Maschi', 'Femmine', 'Totale', '% Affluenza', 'Note',
    ].concat(COLONNE_STATO);
    const sh = getOrCreateSheet(FOGLI.AFFLUENZA, intestazioni);

    // Completa eventuali intestazioni mancanti in fogli creati con versioni precedenti.
    if (sh.getLastColumn() < intestazioni.length) {
      sh.getRange(1, 1, 1, intestazioni.length).setValues([intestazioni]);
    }
    assicuraStatiCorrezioni_(sh);

    if (gia_inviato(sh, idInvio)) {
      logTecnico_('affluenza', 'DUPLICATO', idInvio, body.codice, body.municipio, body.sezione, '', body.versioneApp);
      return { ok: true, duplicato: true, idInvio: idInvio, versioneBackend: CODICE_BACKEND_VERSIONE };
    }

    if (body.correzioneDi) {
      if (!String(body.motivoCorrezione || '').trim()) {
        return { ok: false, error: 'Indica il motivo della correzione.', code: 'INVALID_DATA' };
      }
      const verificaCorrezione = validaTargetCorrezione_(sh, body.correzioneDi, body, 'affluenza');
      if (!verificaCorrezione.ok) {
        return { ok: false, error: testoErroreCorrezione(verificaCorrezione.code), code: verificaCorrezione.code };
      }
    } else if (contaInviiAttivi_(sh, body, 'affluenza') > 0) {
      return { ok: false, error: 'Esiste già una rilevazione attiva per questo orario. Usa la correzione.', code: 'ACTIVE_TURNOUT_EXISTS' };
    }

    let elettori = numOrVuoto(body.elettori);
    if (elettori === '') {
      elettori = recuperaElettoriSezione_(body.municipio, body.sezione);
    }
    const maschi = numOrVuoto(body.maschi);
    const femmine = numOrVuoto(body.femmine);
    let totale = numOrVuoto(body.totale);
    if (totale === '' && maschi !== '' && femmine !== '') totale = maschi + femmine;
    // Nel foglio la percentuale viene salvata come frazione (es. 0,526) e
    // formattata come percentuale. È il formato nativo di Google Sheets e
    // impedisce che la cella resti vuota o venga visualizzata come 5.260%.
    const percDecimale = (elettori !== '' && Number(elettori) > 0 && totale !== '')
      ? Number(totale) / Number(elettori)
      : '';
    const percVisuale = percDecimale === ''
      ? ''
      : Math.round(percDecimale * 1000) / 10;

    sh.appendRow([
      new Date(), idInvio, body.codice || '', body.rappresentante || '',
      body.municipio || '', body.sezione || '', body.telefono || '', body.giorno || '', body.orario || '',
      elettori, maschi, femmine, totale, percDecimale, body.note || '',
      body.correzioneDi || '', body.motivoCorrezione || '', body.versioneApp || '',
      'ATTIVO', '',
    ]);

    if (body.correzioneDi) {
      const applicata = applicaCorrezione(sh, body.correzioneDi, idInvio);
      if (!applicata.ok) {
        sh.deleteRow(sh.getLastRow());
        return { ok: false, error: testoErroreCorrezione(applicata.code), code: applicata.code };
      }
    }

    // Individua la colonna dalla sua intestazione, senza dipendere dalla
    // posizione fisica del foglio, e forza valore e formato sulla riga appena
    // inserita.
    const intestazioniReali = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    const colPercentuale = intestazioniReali.indexOf('% Affluenza') + 1;
    if (colPercentuale > 0) {
      const cellaPercentuale = sh.getRange(sh.getLastRow(), colPercentuale);
      if (percDecimale === '') {
        cellaPercentuale.clearContent();
      } else {
        cellaPercentuale.setValue(percDecimale).setNumberFormat('0.0%');
      }
    }
    SpreadsheetApp.flush();

    // La richiesta dell'app termina senza attendere la ricostruzione della
    // dashboard. Il trigger periodico elaborerà la revisione più recente.
    marcaDashboardAffluenzaDaAggiornare_();

    const rigaSalvata = sh.getLastRow();
    logTecnico_('affluenza', 'OK', idInvio, body.codice, body.municipio, body.sezione, '', body.versioneApp);
    return {
      ok: true,
      idInvio: idInvio,
      riga: rigaSalvata,
      duplicato: false,
      correzione: !!body.correzioneDi,
      versioneBackend: CODICE_BACKEND_VERSIONE,
      salvato: { elettori: elettori, maschi: maschi, femmine: femmine, totale: totale, percentuale: percVisuale }
    };
  } finally {
    lock.releaseLock();
  }
}

function salvaScrutinio(body) {
  body = body || {};
  const sessione = richiedeSessione(body.sessionToken);
  if (!sessione.ok) return sessione;

  // Come per l'affluenza, codice, nominativo e telefono vengono recuperati
  // dalla sessione firmata e dal foglio Rappresentanti.
  const anagrafica = datiRappresentanteDaCodice_(sessione.codice, body.municipio, body.sezione);
  if (!anagrafica.trovato || !anagrafica.attivo) {
    logTecnico_('scrutinio', 'RIFIUTATO', body && body.idInvio, sessione.codice, '', '', 'Rappresentante assente o non attivo', body && body.versioneApp);
    return { ok: false, error: 'Rappresentante non abilitato. Effettua nuovamente l\'accesso.', code: 'REPRESENTATIVE_DISABLED' };
  }
  body.codice = anagrafica.codice;
  body.rappresentante = anagrafica.nome;
  body.telefono = anagrafica.telefono;
  body.municipio = anagrafica.municipio || body.municipio || '';
  body.sezione = anagrafica.sezione || body.sezione || '';
  if (normalizzaMunicipioStorico_(body.municipio) !== MUNICIPIO_ABILITATO) {
    return { ok: false, code: 'MUNICIPALITY_NOT_ENABLED', error: 'Questa installazione è riservata al Municipio IX.' };
  }

  const erroreValidazione = validaDatiScrutinio(body);
  if (erroreValidazione) return { ok: false, error: erroreValidazione, code: 'INVALID_DATA' };

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (e) {
    return { ok: false, error: 'Il coordinamento sta ricevendo molti invii in questo momento. Riprova tra pochi secondi.', code: 'BUSY' };
  }

  let idInvio;
  try {
    idInvio = body.idInvio || Utilities.getUuid();

    const intestazioniScrutinio = [
      'Timestamp', 'ID Invio', 'Codice', 'Municipio', 'Sezione', 'Rappresentante', 'Telefono',
      'Elettori', 'Votanti',
      'Comune - Valide', 'Comune - Bianche', 'Comune - Nulle', 'Comune - Contestate',
      'Municipio - Valide', 'Municipio - Bianche', 'Municipio - Nulle', 'Municipio - Contestate',
      'Note',
    ].concat(COLONNE_STATO);
    const shRiepilogo = getOrCreateSheet(FOGLI.SCRUTINIO, intestazioniScrutinio);

    // Le versioni precedenti del foglio non avevano la colonna Codice.
    // Riscrivendo la riga delle intestazioni nella posizione canonica, anche
    // le righe già salvate tornano immediatamente allineate ai valori.
    const intestazioniAttuali = shRiepilogo.getRange(1, 1, 1, intestazioniScrutinio.length).getDisplayValues()[0];
    const intestazioniNonAllineate = intestazioniScrutinio.some(function(nome, indice) {
      return String(intestazioniAttuali[indice] || '').trim() !== nome;
    });
    if (intestazioniNonAllineate || shRiepilogo.getLastColumn() < intestazioniScrutinio.length) {
      shRiepilogo.getRange(1, 1, 1, intestazioniScrutinio.length).setValues([intestazioniScrutinio]);
      shRiepilogo.getRange(1, 1, 1, intestazioniScrutinio.length).setFontWeight('bold');
      shRiepilogo.setFrozenRows(1);
    }
    assicuraStatiCorrezioni_(shRiepilogo);

    if (gia_inviato(shRiepilogo, idInvio)) {
      logTecnico_('scrutinio', 'DUPLICATO', idInvio, body.codice, body.municipio, body.sezione, '', body.versioneApp);
      return { ok: true, duplicato: true, idInvio: idInvio, versioneBackend: CODICE_BACKEND_VERSIONE };
    }

    if (body.correzioneDi) {
      if (!String(body.motivoCorrezione || '').trim()) {
        return { ok: false, error: 'Indica il motivo della correzione.', code: 'INVALID_DATA' };
      }
      const verificaCorrezione = validaTargetCorrezione_(shRiepilogo, body.correzioneDi, body, 'scrutinio');
      if (!verificaCorrezione.ok) {
        return { ok: false, error: testoErroreCorrezione(verificaCorrezione.code), code: verificaCorrezione.code };
      }
    } else {
      const attivi = contaInviiAttivi_(shRiepilogo, body, 'scrutinio');
      if (attivi > 1) return { ok: false, error: 'Sono presenti più scrutini attivi: serve un intervento del coordinamento.', code: 'MULTIPLE_ACTIVE_SCRUTINIES' };
      if (attivi === 1) return { ok: false, error: 'Esiste già uno scrutinio attivo. Usa la correzione.', code: 'ACTIVE_SCRUTINY_EXISTS' };
    }

    const sc = body.schedaComune || {};
    const sm = body.schedaMunicipio || {};

    // I dettagli vengono rigenerati in modo idempotente prima del record di
    // riepilogo. Se una scrittura si interrompe, il retry elimina le righe
    // parziali con lo stesso ID e le ricrea; il riepilogo resta il commit finale.
    eliminaDettagliScrutinio_(idInvio);
    salvaDettagliScrutinio(idInvio, body);

    shRiepilogo.appendRow([
      new Date(), idInvio, body.codice || '', body.municipio || '', body.sezione || '',
      body.rappresentante || '', body.telefono || '',
      numOrVuoto(body.elettori), numOrVuoto(body.votanti),
      numOrVuoto(sc.valide), numOrVuoto(sc.bianche), numOrVuoto(sc.nulle), numOrVuoto(sc.contestate),
      numOrVuoto(sm.valide), numOrVuoto(sm.bianche), numOrVuoto(sm.nulle), numOrVuoto(sm.contestate),
      body.note || '',
      body.correzioneDi || '', body.motivoCorrezione || '', body.versioneApp || '',
      'ATTIVO', '',
    ]);

    if (body.correzioneDi) {
      const applicata = applicaCorrezione(shRiepilogo, body.correzioneDi, idInvio);
      if (!applicata.ok) {
        shRiepilogo.deleteRow(shRiepilogo.getLastRow());
        eliminaDettagliScrutinio_(idInvio);
        return { ok: false, error: testoErroreCorrezione(applicata.code), code: applicata.code };
      }
    }
    SpreadsheetApp.flush();
    const rigaSalvata = shRiepilogo.getLastRow();
    logTecnico_('scrutinio', 'OK', idInvio, body.codice, body.municipio, body.sezione, '', body.versioneApp);
    return {
      ok: true,
      idInvio: idInvio,
      riga: rigaSalvata,
      duplicato: false,
      correzione: !!body.correzioneDi,
      versioneBackend: CODICE_BACKEND_VERSIONE
    };
  } finally {
    lock.releaseLock();
  }
}

function eliminaRighePerId_(sheet, idInvio) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const valori = sheet.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);
  const colId = idx['id invio'];
  if (colId === undefined) return 0;
  let eliminate = 0;
  for (let i = valori.length - 1; i >= 1; i--) {
    if (String(valori[i][colId] || '') === String(idInvio || '')) {
      sheet.deleteRow(i + 1);
      eliminate++;
    }
  }
  return eliminate;
}

function eliminaDettagliScrutinio_(idInvio) {
  const ss = getDatabaseSpreadsheet_();
  [FOGLI.VOTI_LISTE, FOGLI.PREFERENZE, FOGLI.VOTI_SINDACI, FOGLI.VOTI_PRESIDENTI]
    .forEach(function(nome) { eliminaRighePerId_(ss.getSheetByName(nome), idInvio); });
}

/**
 * Inserisce più righe con una sola chiamata a Google Sheets.
 * Riduce drasticamente il numero di operazioni remote rispetto ad appendRow().
 */
function accodaRighe_(sheet, righe) {
  if (!sheet || !righe || !righe.length) return 0;
  const primaRiga = sheet.getLastRow() + 1;
  sheet.getRange(primaRiga, 1, righe.length, righe[0].length).setValues(righe);
  return righe.length;
}

function salvaDettagliScrutinio(idInvio, body) {
  body = body || {};

  const timestamp = new Date();
  const municipio = body.municipio || '';
  const sezione = body.sezione || '';

  const shListe = getOrCreateSheet(FOGLI.VOTI_LISTE, [
    'Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Livello', 'Lista', 'Voti',
  ]);
  const righeListe = (body.liste || [])
    .filter(function (l) { return l && l.nome; })
    .map(function (l) {
      return [
        timestamp,
        idInvio,
        municipio,
        sezione,
        l.livello || '',
        l.nome,
        numOrVuoto(l.voti)
      ];
    });
  accodaRighe_(shListe, righeListe);

  const shPref = getOrCreateSheet(FOGLI.PREFERENZE, [
    'Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Livello', 'Candidato', 'Preferenze',
  ]);
  const righePreferenze = (body.preferenze || [])
    .filter(function (p) { return p && p.candidato; })
    .map(function (p) {
      return [
        timestamp,
        idInvio,
        municipio,
        sezione,
        p.livello || '',
        p.candidato,
        numOrVuoto(p.voti)
      ];
    });
  accodaRighe_(shPref, righePreferenze);

  const shSindaci = getOrCreateSheet(FOGLI.VOTI_SINDACI, [
    'Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Sindaco', 'Voti',
  ]);
  const righeSindaci = (body.sindaci || [])
    .filter(function (s) { return s && s.nome; })
    .map(function (s) {
      return [
        timestamp,
        idInvio,
        municipio,
        sezione,
        s.nome,
        numOrVuoto(s.voti)
      ];
    });
  accodaRighe_(shSindaci, righeSindaci);

  const shPresidenti = getOrCreateSheet(FOGLI.VOTI_PRESIDENTI, [
    'Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Presidente', 'Voti',
  ]);
  const righePresidenti = (body.presidenti || [])
    .filter(function (p) { return p && p.nome; })
    .map(function (p) {
      return [
        timestamp,
        idInvio,
        municipio,
        sezione,
        p.nome,
        numOrVuoto(p.voti)
      ];
    });
  accodaRighe_(shPresidenti, righePresidenti);

  return {
    ok: true,
    idInvio: idInvio,
    righeSalvate: {
      liste: righeListe.length,
      preferenze: righePreferenze.length,
      sindaci: righeSindaci.length,
      presidenti: righePresidenti.length
    }
  };
}

// ===================== VALIDAZIONE DATI =====================================

function interoNonNegativo_(valore, obbligatorio) {
  if (valore === '' || valore === null || valore === undefined) return obbligatorio ? null : '';
  const n = Number(valore);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function testoLimitato_(valore, massimo) {
  return String(valore || '').trim().length <= massimo;
}

function validaVociNumeriche_(voci, campoNome, campoVoti, etichetta) {
  if (!Array.isArray(voci)) return etichetta + ': formato non valido.';
  const viste = {};
  for (let i = 0; i < voci.length; i++) {
    const voce = voci[i] || {};
    const nome = String(voce[campoNome] || '').trim();
    if (!nome || nome.length > 160) return etichetta + ': nome mancante o troppo lungo.';
    const livello = String(voce.livello || '').trim().toLowerCase();
    const chiave = livello + '|' + nome.toLowerCase();
    if (viste[chiave]) return etichetta + ': voce duplicata (' + nome + ').';
    viste[chiave] = true;
    if (interoNonNegativo_(voce[campoVoti], true) === null) {
      return etichetta + ': i voti devono essere interi non negativi.';
    }
  }
  return '';
}

function validaDatiAffluenza(body) {
  const elettori = interoNonNegativo_(body.elettori, false);
  const totale = interoNonNegativo_(body.totale, true);
  const maschi = interoNonNegativo_(body.maschi, false);
  const femmine = interoNonNegativo_(body.femmine, false);
  if (totale === null || elettori === null || maschi === null || femmine === null) {
    return 'I conteggi devono essere numeri interi non negativi.';
  }
  if (elettori !== '' && totale !== '' && totale > elettori) {
    return 'I votanti (' + totale + ') non possono superare gli elettori aventi diritto (' + elettori + ').';
  }
  if (maschi !== '' && femmine !== '' && totale !== '' && (maschi + femmine) !== totale) {
    return 'La somma di maschi e femmine (' + (maschi + femmine) + ') non corrisponde al totale votanti (' + totale + ').';
  }
  if (!String(body.giorno || '').trim() || !String(body.orario || '').trim()) {
    return 'Giorno e orario della rilevazione sono obbligatori.';
  }
  if (!testoLimitato_(body.giorno, 40) || !testoLimitato_(body.orario, 20) ||
      !testoLimitato_(body.note, 500) || !testoLimitato_(body.motivoCorrezione, 300)) {
    return 'Uno o più campi testuali superano la lunghezza consentita.';
  }
  return '';
}


function setNormalizzato_(valori) {
  const out = {};
  (valori || []).forEach(function(v) { const k = normalizzaNomeListaDashboard_(v); if (k) out[k] = true; });
  return out;
}

function validaVociControConfigurazione_(body) {
  const cfg = buildConfig();
  const mu = normalizzaMunicipioStorico_(body.municipio);
  const listeComune = setNormalizzato_(cfg.liste.capitolina || []);
  const listeMunicipio = setNormalizzato_((cfg.liste.municipio && cfg.liste.municipio[mu]) || []);
  const prefComune = setNormalizzato_(cfg.candidati.capitolina || []);
  const prefMunicipio = setNormalizzato_((cfg.candidati.municipio && cfg.candidati.municipio[mu]) || []);
  const sindaci = setNormalizzato_(cfg.sindaci || []);
  const presidenti = setNormalizzato_((cfg.presidenti && cfg.presidenti[mu]) || []);

  function verifica(voci, campo, perLivello, etichetta) {
    for (let i = 0; i < (voci || []).length; i++) {
      const voce = voci[i] || {};
      const nome = normalizzaNomeListaDashboard_(voce[campo]);
      const livello = normalizzaLivelloDashboard_(voce.livello);
      const ammessi = typeof perLivello === 'function' ? perLivello(livello) : perLivello;
      if (!nome || !ammessi[nome]) return etichetta + ': voce non presente nella configurazione (' + String(voce[campo] || '') + ').';
    }
    return '';
  }
  let err = verifica(body.liste, 'nome', function(l) { return l === 'Comune' ? listeComune : l === 'Municipio' ? listeMunicipio : {}; }, 'Liste');
  if (err) return err;
  err = verifica(body.preferenze, 'candidato', function(l) { return l === 'Comune' ? prefComune : l === 'Municipio' ? prefMunicipio : {}; }, 'Preferenze');
  if (err) return err;
  err = verifica(body.sindaci, 'nome', sindaci, 'Candidati sindaco');
  if (err) return err;
  err = verifica(body.presidenti, 'nome', presidenti, 'Candidati presidente');
  return err;
}

function validaDatiScrutinio(body) {
  const elettori = interoNonNegativo_(body.elettori, true);
  const votanti = interoNonNegativo_(body.votanti, true);
  if (elettori === null || votanti === null) return 'Elettori e votanti devono essere numeri interi non negativi.';
  if (elettori !== '' && votanti !== '' && votanti > elettori) {
    return 'I votanti (' + votanti + ') non possono superare gli elettori aventi diritto (' + elettori + ').';
  }
  const sc = body.schedaComune || {};
  const sm = body.schedaMunicipio || {};
  const campi = [sc.valide, sc.bianche, sc.nulle, sc.contestate, sm.valide, sm.bianche, sm.nulle, sm.contestate]
    .map(function(v) { return interoNonNegativo_(v, true); });
  if (campi.some(function(n) { return n === null; })) return 'I conteggi delle schede devono essere interi non negativi.';
  const totaleComune = campi[0] + campi[1] + campi[2] + campi[3];
  const totaleMunicipio = campi[4] + campi[5] + campi[6] + campi[7];
  if (totaleComune !== votanti || totaleMunicipio !== votanti) {
    return 'Il totale delle schede Comune e Municipio deve coincidere con i votanti.';
  }
  const gruppi = [
    [body.liste || [], 'nome', 'voti', 'Liste'],
    [body.preferenze || [], 'candidato', 'voti', 'Preferenze'],
    [body.sindaci || [], 'nome', 'voti', 'Candidati sindaco'],
    [body.presidenti || [], 'nome', 'voti', 'Candidati presidente']
  ];
  for (let i = 0; i < gruppi.length; i++) {
    const errore = validaVociNumeriche_.apply(null, gruppi[i]);
    if (errore) return errore;
  }
  const erroreConfigurazione = validaVociControConfigurazione_(body);
  if (erroreConfigurazione) return erroreConfigurazione;
  const sommaSindaci = (body.sindaci || []).reduce(function(t, v) { return t + Number(v.voti || 0); }, 0);
  const sommaPresidenti = (body.presidenti || []).reduce(function(t, v) { return t + Number(v.voti || 0); }, 0);
  if (sommaSindaci > campi[0]) return 'La somma dei voti ai candidati sindaco non può superare le schede valide del Comune.';
  if (sommaPresidenti > campi[4]) return 'La somma dei voti ai candidati presidente non può superare le schede valide del Municipio.';
  const sommaListeComune = (body.liste || []).filter(function(v) { return String(v.livello || '').toLowerCase() === 'comune'; })
    .reduce(function(t, v) { return t + Number(v.voti || 0); }, 0);
  const sommaListeMunicipio = (body.liste || []).filter(function(v) { return String(v.livello || '').toLowerCase() === 'municipio'; })
    .reduce(function(t, v) { return t + Number(v.voti || 0); }, 0);
  if (sommaListeComune > campi[0] || sommaListeMunicipio > campi[4]) {
    return 'La somma dei voti di lista non può superare le schede valide.';
  }
  const fdiComune = (body.liste || []).filter(function(v) { return normalizzaLivelloDashboard_(v.livello) === 'Comune' && isListaFdiDashboard_(v.nome); }).reduce(function(t,v){ return t + Number(v.voti || 0); },0);
  const fdiMunicipio = (body.liste || []).filter(function(v) { return normalizzaLivelloDashboard_(v.livello) === 'Municipio' && isListaFdiDashboard_(v.nome); }).reduce(function(t,v){ return t + Number(v.voti || 0); },0);
  const prefComuneTot = (body.preferenze || []).filter(function(v) { return normalizzaLivelloDashboard_(v.livello) === 'Comune'; }).reduce(function(t,v){ return t + Number(v.voti || 0); },0);
  const prefMunicipioTot = (body.preferenze || []).filter(function(v) { return normalizzaLivelloDashboard_(v.livello) === 'Municipio'; }).reduce(function(t,v){ return t + Number(v.voti || 0); },0);
  if (fdiComune > 0 && prefComuneTot > fdiComune * 2) return 'Le preferenze Comune superano il massimo teorico di due per voto FdI.';
  if (fdiMunicipio > 0 && prefMunicipioTot > fdiMunicipio * 2) return 'Le preferenze Municipio superano il massimo teorico di due per voto FdI.';
  if (!testoLimitato_(body.note, 1000) || !testoLimitato_(body.motivoCorrezione, 300)) {
    return 'Note o motivo della correzione superano la lunghezza consentita.';
  }
  return '';
}

// ===================== CORREZIONI (superamento sicuro di un invio) =========

function testoErroreCorrezione(code) {
  const testi = {
    CORRECTION_TARGET_NOT_FOUND: 'Il dato che volevi correggere non è più presente nel foglio del coordinamento.',
    ALREADY_SUPERSEDED: 'Questo dato è già stato corretto da un altro invio più recente.',
  };
  return testi[code] || 'Correzione non consentita.';
}

/**
 * Marca come "SOSTITUITO" la riga con ID Invio = correzioneDiId, in modo che
 * il vecchio valore resti visibile per l'audit ma non venga più contato come
 * dato attivo. Ritorna un errore se la riga non esiste o è già stata
 * sostituita da qualcun altro (per evitare catene di correzioni ambigue).
 */
function applicaCorrezione(sheet, correzioneDiId, nuovoId) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colId = headers.indexOf('ID Invio');
  const colStato = headers.indexOf('Stato');
  const colSostDa = headers.indexOf('Sostituito Da');
  const ultimaRiga = sheet.getLastRow();
  if (ultimaRiga < 2 || colId === -1 || colStato === -1) return { ok: false, code: 'CORRECTION_TARGET_NOT_FOUND' };

  const dati = sheet.getRange(2, 1, ultimaRiga - 1, sheet.getLastColumn()).getValues();
  for (let i = 0; i < dati.length; i++) {
    if (dati[i][colId] === correzioneDiId) {
      if (String(dati[i][colStato]).toUpperCase() === 'SOSTITUITO') {
        return { ok: false, code: 'ALREADY_SUPERSEDED' };
      }
      const riga = i + 2;
      sheet.getRange(riga, colStato + 1).setValue('SOSTITUITO');
      if (colSostDa !== -1) sheet.getRange(riga, colSostDa + 1).setValue(nuovoId);
      return { ok: true };
    }
  }
  return { ok: false, code: 'CORRECTION_TARGET_NOT_FOUND' };
}

function assicuraStatiCorrezioni_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return { aggiornate: 0, anomalie: [] };
  const valori = sheet.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);
  const colId = idx['id invio'];
  const colCorrezione = idx['correzione di'];
  const colStato = idx['stato'];
  const colSostituitoDa = idx['sostituito da'];
  if (colId === undefined || colStato === undefined || colSostituitoDa === undefined) {
    return { aggiornate: 0, anomalie: ['Intestazioni stato mancanti'] };
  }
  const rigaPerId = {};
  const successori = {};
  for (let i = 1; i < valori.length; i++) {
    const id = String(valori[i][colId] || '');
    if (id) rigaPerId[id] = i;
    const precedente = colCorrezione === undefined ? '' : String(valori[i][colCorrezione] || '');
    if (precedente) {
      successori[precedente] = successori[precedente] || [];
      successori[precedente].push(id);
    }
  }
  let aggiornate = 0;
  const anomalie = [];
  for (let i = 1; i < valori.length; i++) {
    const id = String(valori[i][colId] || '');
    const succ = successori[id] || [];
    if (succ.length > 1) anomalie.push('Più correzioni per ID ' + id + ': ' + succ.join(', '));
    const statoAtteso = succ.length ? 'SOSTITUITO' : 'ATTIVO';
    const sostituitoDaAtteso = succ.length ? succ[succ.length - 1] : '';
    if (String(valori[i][colStato] || '').toUpperCase() !== statoAtteso ||
        String(valori[i][colSostituitoDa] || '') !== sostituitoDaAtteso) {
      sheet.getRange(i + 1, colStato + 1).setValue(statoAtteso);
      sheet.getRange(i + 1, colSostituitoDa + 1).setValue(sostituitoDaAtteso);
      aggiornate++;
    }
  }
  return { aggiornate: aggiornate, anomalie: anomalie };
}

function migraStatiCorrezioni() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getDatabaseSpreadsheet_();
    const risultato = {};
    [FOGLI.AFFLUENZA, FOGLI.SCRUTINIO].forEach(function(nome) {
      risultato[nome] = assicuraStatiCorrezioni_(ss.getSheetByName(nome));
    });
    Logger.log(JSON.stringify(risultato, null, 2));
    return risultato;
  } finally {
    lock.releaseLock();
  }
}

function validaTargetCorrezione_(sheet, idTarget, body, tipo) {
  if (!sheet || !idTarget || sheet.getLastRow() < 2) return { ok: false, code: 'CORRECTION_TARGET_NOT_FOUND' };
  const valori = sheet.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);
  for (let i = 1; i < valori.length; i++) {
    const r = valori[i];
    if (String(valoreColonna(r, idx, ['ID Invio']) || '') !== String(idTarget)) continue;
    const stato = String(valoreColonna(r, idx, ['Stato']) || 'ATTIVO').toUpperCase();
    if (stato === 'SOSTITUITO' || String(valoreColonna(r, idx, ['Sostituito Da']) || '')) {
      return { ok: false, code: 'ALREADY_SUPERSEDED' };
    }
    const stessoCodice = String(valoreColonna(r, idx, ['Codice']) || '').trim().toUpperCase() === String(body.codice || '').trim().toUpperCase();
    const stessoMunicipio = normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio'])) === normalizzaMunicipioStorico_(body.municipio);
    const stessaSezione = normalizzaSezione_(valoreColonna(r, idx, ['Sezione'])) === normalizzaSezione_(body.sezione);
    if (!stessoCodice || !stessoMunicipio || !stessaSezione) return { ok: false, code: 'CORRECTION_NOT_ALLOWED' };
    if (tipo === 'affluenza') {
      const stessoGiorno = String(valoreColonna(r, idx, ['Giorno']) || '').trim() === String(body.giorno || '').trim();
      const stessoOrario = String(valoreColonna(r, idx, ['Orario']) || '').trim() === String(body.orario || '').trim();
      if (!stessoGiorno || !stessoOrario) return { ok: false, code: 'CORRECTION_NOT_ALLOWED' };
    }
    return { ok: true, row: i + 1 };
  }
  return { ok: false, code: 'CORRECTION_TARGET_NOT_FOUND' };
}

function contaInviiAttivi_(sheet, body, tipo) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const valori = sheet.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);
  let n = 0;
  for (let i = 1; i < valori.length; i++) {
    const r = valori[i];
    const stato = String(valoreColonna(r, idx, ['Stato']) || 'ATTIVO').toUpperCase();
    const sostituitoDa = String(valoreColonna(r, idx, ['Sostituito Da']) || '');
    if (stato === 'SOSTITUITO' || sostituitoDa) continue;
    if (normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio'])) !== normalizzaMunicipioStorico_(body.municipio)) continue;
    if (normalizzaSezione_(valoreColonna(r, idx, ['Sezione'])) !== normalizzaSezione_(body.sezione)) continue;
    if (tipo === 'affluenza') {
      if (String(valoreColonna(r, idx, ['Giorno']) || '').trim() !== String(body.giorno || '').trim()) continue;
      if (String(valoreColonna(r, idx, ['Orario']) || '').trim() !== String(body.orario || '').trim()) continue;
    }
    n++;
  }
  return n;
}

/** Conta quanti scrutini "ATTIVO" (non sostituiti) esistono già per una sezione. */
function statoScrutinioAttivo(sheet, municipio, sezione) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colMun = headers.indexOf('Municipio');
  const colSez = headers.indexOf('Sezione');
  const colStato = headers.indexOf('Stato');
  const ultimaRiga = sheet.getLastRow();
  if (ultimaRiga < 2 || colMun === -1 || colSez === -1) return 0;

  const muCercato = String(municipio || '').trim().padStart(2, '0');
  const sezCercata = String(sezione || '').trim();
  const dati = sheet.getRange(2, 1, ultimaRiga - 1, sheet.getLastColumn()).getValues();
  let n = 0;
  dati.forEach(function (r) {
    const mu = String(r[colMun]).trim().padStart(2, '0');
    const se = String(r[colSez]).trim();
    const stato = colStato === -1 ? 'ATTIVO' : String(r[colStato]).toUpperCase();
    if (mu === muCercato && se === sezCercata && stato !== 'SOSTITUITO') n++;
  });
  return n;
}


function autorizzaSezioneSessione_(codice, municipio, sezione) {
  const anagrafica = datiRappresentanteDaCodice_(codice, municipio, sezione);
  if (!anagrafica.trovato || !anagrafica.attivo) {
    return { ok: false, code: 'SECTION_NOT_AUTHORIZED', error: 'Sezione non autorizzata.' };
  }
  if (normalizzaMunicipioStorico_(anagrafica.municipio) !== MUNICIPIO_ABILITATO) {
    return { ok: false, code: 'MUNICIPALITY_NOT_ENABLED', error: 'Questa installazione è riservata al Municipio IX.' };
  }
  return { ok: true, municipio: anagrafica.municipio, sezione: anagrafica.sezione };
}

function aggiornaStatoMessaggioAutorizzato_(codice, id, stato) {
  if (!id) return { ok: false, error: 'ID messaggio mancante.' };
  const statiValidi = ['NUOVO', 'LETTO', 'RISOLTO'];
  if (statiValidi.indexOf(stato) === -1) return { ok: false, error: 'Stato non valido.' };
  const sh = getOrCreateSheet(FOGLI.MESSAGGI, ['ID', 'Municipio', 'Sezione', 'Testo', 'Stato', 'Timestamp', 'Aggiornato Il']);
  if (sh.getLastRow() < 2) return { ok: false, error: 'Messaggio non trovato.' };
  const righe = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  for (let i = 0; i < righe.length; i++) {
    if (String(righe[i][0]) !== String(id)) continue;
    const municipio = normalizzaMunicipioStorico_(righe[i][1]);
    const sezioneMessaggio = String(righe[i][2] || '').trim();
    const sezioni = sezioniAutorizzateDaCodice_(codice).filter(function(s) {
      if (s.municipio !== municipio) return false;
      return !sezioneMessaggio || normalizzaSezione_(s.sezione) === normalizzaSezione_(sezioneMessaggio);
    });
    if (!sezioni.length || municipio !== MUNICIPIO_ABILITATO) {
      return { ok: false, code: 'MESSAGE_NOT_AUTHORIZED', error: 'Messaggio non autorizzato.' };
    }
    const riga = i + 2;
    sh.getRange(riga, 5).setValue(stato);
    sh.getRange(riga, 7).setValue(new Date());
    return { ok: true };
  }
  return { ok: false, error: 'Messaggio non trovato.' };
}

// ===================== MESSAGGI (coordinamento <-> rappresentante) =========

function leggiMessaggi(municipio, sezione) {
  const sh = getOrCreateSheet(FOGLI.MESSAGGI, ['ID', 'Municipio', 'Sezione', 'Testo', 'Stato', 'Timestamp', 'Aggiornato Il']);
  const ultimaRiga = sh.getLastRow();
  if (ultimaRiga < 2) return { ok: true, items: [] };

  const muCercato = String(municipio || '').trim().padStart(2, '0');
  const sezCercata = String(sezione || '').trim();
  const dati = sh.getRange(2, 1, ultimaRiga - 1, 7).getValues();
  const items = [];
  dati.forEach(function (r) {
    const mu = String(r[1]).trim().padStart(2, '0');
    const se = String(r[2]).trim();
    // Messaggi con sezione vuota valgono per tutto il municipio (avviso generale).
    if (mu !== muCercato) return;
    if (se && se !== sezCercata) return;
    items.push({ id: r[0], testo: r[3], stato: r[4] || 'NUOVO', timestamp: r[5] instanceof Date ? r[5].toISOString() : String(r[5]) });
  });
  return { ok: true, items: items };
}

function aggiornaStatoMessaggio(id, stato) {
  if (!id) return { ok: false, error: 'ID messaggio mancante.' };
  const statiValidi = ['NUOVO', 'LETTO', 'RISOLTO'];
  if (statiValidi.indexOf(stato) === -1) return { ok: false, error: 'Stato non valido.' };

  const sh = getOrCreateSheet(FOGLI.MESSAGGI, ['ID', 'Municipio', 'Sezione', 'Testo', 'Stato', 'Timestamp', 'Aggiornato Il']);
  const ultimaRiga = sh.getLastRow();
  if (ultimaRiga < 2) return { ok: false, error: 'Messaggio non trovato.' };

  const colonnaId = sh.getRange(2, 1, ultimaRiga - 1, 1).getValues();
  for (let i = 0; i < colonnaId.length; i++) {
    if (String(colonnaId[i][0]) === String(id)) {
      const riga = i + 2;
      sh.getRange(riga, 5).setValue(stato);
      sh.getRange(riga, 7).setValue(new Date());
      return { ok: true };
    }
  }
  return { ok: false, error: 'Messaggio non trovato.' };
}

/**
 * Voce di menu: permette al coordinamento di scrivere un messaggio che
 * comparirà nell'app del rappresentante di una sezione (o di tutte le
 * sezioni di un municipio, se il campo sezione viene lasciato vuoto).
 */
function inviaMessaggioDaMenu() {
  const ui = SpreadsheetApp.getUi();
  const rMun = ui.prompt('💬 Invia messaggio — Passo 1/3', 'Municipio (es. 09). Lascia vuoto per annullare.', ui.ButtonSet.OK_CANCEL);
  if (rMun.getSelectedButton() !== ui.Button.OK || !rMun.getResponseText().trim()) return;
  const municipio = rMun.getResponseText().trim().padStart(2, '0');

  const rSez = ui.prompt('💬 Invia messaggio — Passo 2/3', 'Sezione (lascia vuoto per inviare a tutto il Municipio ' + municipio + '):', ui.ButtonSet.OK_CANCEL);
  if (rSez.getSelectedButton() !== ui.Button.OK) return;
  const sezione = rSez.getResponseText().trim();

  const rTesto = ui.prompt('💬 Invia messaggio — Passo 3/3', 'Testo del messaggio:', ui.ButtonSet.OK_CANCEL);
  if (rTesto.getSelectedButton() !== ui.Button.OK || !rTesto.getResponseText().trim()) return;
  const testo = rTesto.getResponseText().trim();

  const sh = getOrCreateSheet(FOGLI.MESSAGGI, ['ID', 'Municipio', 'Sezione', 'Testo', 'Stato', 'Timestamp', 'Aggiornato Il']);
  sh.appendRow([Utilities.getUuid(), municipio, sezione, testo, 'NUOVO', new Date(), '']);

  ui.alert('✅ Messaggio salvato.\n\nComparirà nell\'app dei rappresentanti coinvolti entro pochi minuti (l\'app controlla i nuovi messaggi periodicamente).');
}

function gia_inviato(sheet, idInvio) {
  if (!idInvio) return false;
  const ultimaRiga = sheet.getLastRow();
  if (ultimaRiga < 2) return false;
  const colonnaId = sheet.getRange(2, 2, ultimaRiga - 1, 1).getValues(); // colonna B = ID Invio
  return colonnaId.some(function (r) { return r[0] === idInvio; });
}

function numOrVuoto(v) {
  if (v === undefined || v === null || v === '') return '';
  const n = Number(v);
  return isNaN(n) ? '' : n;
}

// Legge le colonne in base al nome dell'intestazione, non alla posizione.
// Consente colonne extra (per esempio Telefono) nel foglio Rappresentanti.
function mappaIntestazioni(intestazioni) {
  const mappa = {};
  (intestazioni || []).forEach(function (v, i) {
    const chiave = String(v || '').trim().toLowerCase();
    if (chiave) mappa[chiave] = i;
  });
  return mappa;
}

function valoreColonna(riga, mappa, nomiPossibili) {
  for (let i = 0; i < nomiPossibili.length; i++) {
    const chiave = String(nomiPossibili[i]).trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(mappa, chiave)) {
      return riga[mappa[chiave]];
    }
  }
  return '';
}


// ===================== ACCESSO ARCHIVIO DATI ==================================
// La Web App usa sempre e soltanto il Foglio Google ufficiale indicato dalla
// costante DATABASE_SPREADSHEET_ID. In questo modo il deployment non può
// scrivere per errore nel file a cui è collegato il progetto Apps Script.
function getDatabaseSpreadsheet_() {
  try {
    return SpreadsheetApp.openById(DATABASE_SPREADSHEET_ID);
  } catch (err) {
    throw new Error(
      'Impossibile aprire il foglio dati configurato (' + DATABASE_SPREADSHEET_ID + '). ' +
      'Controlla che l’account che esegue la Web App abbia accesso al documento. Dettaglio: ' + err
    );
  }
}

// Mantiene compatibilità con la procedura precedente, ma non ricava più l’ID
// dal foglio attivo: registra e verifica sempre l’archivio ufficiale.
function configuraArchivioDati() {
  const ss = getDatabaseSpreadsheet_();
  PropertiesService.getScriptProperties().setProperty(
    'DATABASE_SPREADSHEET_ID',
    DATABASE_SPREADSHEET_ID
  );
  const risultato = {
    ok: true,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    spreadsheetId: ss.getId(),
    nome: ss.getName(),
    url: ss.getUrl(),
  };
  Logger.log(JSON.stringify(risultato, null, 2));
  console.log(JSON.stringify(risultato));
  return risultato;
}

/**
 * Migrazione una tantum: salva l'HMAC del codice in "Codice Hash" e rimuove
 * il codice in chiaro. Eseguire soltanto dopo avere pubblicato questa versione.
 */
function migraCodiciAccesso() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = getDatabaseSpreadsheet_().getSheetByName(FOGLI.RAPPRESENTANTI);
    if (!sh || sh.getLastRow() < 2) throw new Error('Foglio Rappresentanti vuoto o mancante.');
    let headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    let colHash = headers.indexOf('Codice Hash');
    if (colHash === -1) {
      colHash = sh.getLastColumn();
      sh.getRange(1, colHash + 1).setValue('Codice Hash');
      headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    }
    const colCodice = headers.indexOf('Codice');
    if (colCodice === -1) throw new Error('Colonna Codice mancante.');
    const righe = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    let migrate = 0;
    righe.forEach(function(r, i) {
      const codice = String(r[colCodice] || '').trim();
      const hashEsistente = String(r[colHash] || '').trim();
      if (!codice && !hashEsistente) return;
      sh.getRange(i + 2, colHash + 1).setValue(hashEsistente || hashCodiceAccesso_(codice));
      if (codice) sh.getRange(i + 2, colCodice + 1).clearContent();
      migrate++;
    });
    return { ok: true, righeMigrate: migrate };
  } finally {
    lock.releaseLock();
  }
}

function diagnosticaArchivio() {
  const ss = getDatabaseSpreadsheet_();
  const sh = ss.getSheetByName(FOGLI.AFFLUENZA);
  const ultimaRiga = sh ? sh.getLastRow() : 0;
  let ultimoInvio = null;
  if (sh && ultimaRiga > 1) {
    ultimoInvio = sh.getRange(
      ultimaRiga,
      1,
      1,
      sh.getLastColumn()
    ).getDisplayValues()[0];
  }
  const risultato = {
    ok: true,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    spreadsheetId: ss.getId(),
    nome: ss.getName(),
    url: ss.getUrl(),
    foglioAffluenza: FOGLI.AFFLUENZA,
    ultimaRiga: ultimaRiga,
    ultimoInvio: ultimoInvio,
  };
  Logger.log(JSON.stringify(risultato, null, 2));
  console.log(JSON.stringify(risultato));
  return risultato;
}

// ===================== UTILITY ===============================================

function getOrCreateSheet(nome, intestazioni) {
  const ss = getDatabaseSpreadsheet_();
  let sh = ss.getSheetByName(nome);
  if (!sh) {
    sh = ss.insertSheet(nome);
    sh.appendRow(intestazioni);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, intestazioni.length).setFontWeight('bold');
  }
  return sh;
}

function logError(funzione, err) {
  try {
    const sh = getOrCreateSheet(FOGLI.LOG, ['Timestamp', 'Funzione', 'Errore']);
    sh.appendRow([new Date(), funzione, String(err)]);
  } catch (e) {
    // se anche il log fallisce, non c'è altro da fare
  }
}


/** Registro operativo senza token, payload completi o altri segreti. */
function logTecnico_(tipo, esito, idInvio, codice, municipio, sezione, dettaglio, versioneApp) {
  try {
    const sh = getOrCreateSheet(FOGLI.LOG_TECNICO, [
      'Timestamp', 'Tipo', 'Esito', 'ID Invio', 'Codice', 'Municipio',
      'Sezione', 'Dettaglio', 'Versione app', 'Versione backend'
    ]);
    sh.appendRow([
      new Date(), String(tipo || ''), String(esito || ''), String(idInvio || ''),
      String(codice || ''), String(municipio || ''), String(sezione || ''),
      String(dettaglio || '').slice(0, 500), String(versioneApp || ''),
      CODICE_BACKEND_VERSIONE
    ]);
  } catch (e) {
    // Il log tecnico non deve mai impedire un invio elettorale.
  }
}

/** Controlla la struttura minima senza modificare i dati esistenti. */
function verificaIntegritaArchivio() {
  const ss = getDatabaseSpreadsheet_();
  const requisiti = {};
  requisiti[FOGLI.RAPPRESENTANTI] = ['Codice', 'Nome e Cognome', 'Telefono', 'Municipio', 'Sezione', 'Attivo'];
  requisiti[FOGLI.AFFLUENZA] = ['Timestamp', 'ID Invio', 'Codice', 'Municipio', 'Sezione', 'Elettori', 'Totale', '% Affluenza'];
  requisiti[FOGLI.SCRUTINIO] = ['Timestamp', 'ID Invio', 'Codice', 'Municipio', 'Sezione', 'Elettori', 'Votanti'];

  const controlli = [];
  let ok = true;
  Object.keys(requisiti).forEach(function(nomeFoglio) {
    const sh = ss.getSheetByName(nomeFoglio);
    if (!sh) {
      ok = false;
      controlli.push({ foglio: nomeFoglio, ok: false, errore: 'Foglio mancante' });
      return;
    }
    const headers = sh.getLastColumn() > 0
      ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(function(v) { return String(v || '').trim(); })
      : [];
    const mancanti = requisiti[nomeFoglio].filter(function(h) { return headers.indexOf(h) === -1; });
    if (mancanti.length) ok = false;
    controlli.push({ foglio: nomeFoglio, ok: mancanti.length === 0, intestazioniMancanti: mancanti });
  });

  const risultato = {
    ok: ok,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    controlli: controlli,
    verificatoIl: new Date().toISOString()
  };
  Logger.log(JSON.stringify(risultato, null, 2));
  console.log(JSON.stringify(risultato));
  return risultato;
}

/** Collaudo non distruttivo della configurazione del Municipio IX. */
function collaudoMunicipioIX() {
  const integrita = verificaIntegritaArchivio();
  const ss = getDatabaseSpreadsheet_();
  const sh = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  let attiviIX = 0;
  let anomalie = [];
  if (sh && sh.getLastRow() >= 2) {
    const righe = sh.getDataRange().getValues();
    const idx = mappaIntestazioni(righe[0]);
    const codici = {};
    for (let i = 1; i < righe.length; i++) {
      const r = righe[i];
      const codice = identitaCodiceRiga_(r, idx);
      const municipio = String(valoreColonna(r, idx, ['Municipio']) || '').trim().replace(/^0+/, '');
      const sezione = String(valoreColonna(r, idx, ['Sezione']) || '').trim();
      const attivoRaw = valoreColonna(r, idx, ['Attivo']);
      const attivo = attivoRaw === true || String(attivoRaw).trim().toUpperCase() === 'TRUE' || String(attivoRaw).trim() === '1';
      if (municipio === '9' && attivo) attiviIX++;
      if (attivo && municipio !== '9') anomalie.push('Rappresentante attivo fuori dal Municipio IX alla riga ' + (i + 1));
      if (codice) {
        const chiaveAssegnazione = codice + '|' + municipio + '|' + normalizzaSezione_(sezione);
        if (codici[chiaveAssegnazione]) anomalie.push('Assegnazione duplicata alla riga ' + (i + 1));
        codici[chiaveAssegnazione] = true;
      }
      if (attivo && (!codice || !municipio || !sezione)) anomalie.push('Riga rappresentante incompleta: ' + (i + 1));
    }
  }
  const risultato = {
    ok: integrita.ok && anomalie.length === 0 && attiviIX > 0,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    integritaArchivio: integrita.ok,
    rappresentantiAttiviMunicipioIX: attiviIX,
    anomalie: anomalie,
    nota: 'Test non distruttivo: non crea invii e non modifica dati elettorali.'
  };
  Logger.log(JSON.stringify(risultato, null, 2));
  console.log(JSON.stringify(risultato));
  return risultato;
}

// ===================== INIZIALIZZAZIONE (eseguire una sola volta) ===========

function inizializza() {
  const ss = getDatabaseSpreadsheet_();

  // Foglio Municipi: tutti i 15, solo il IX attivo di default
  const shMun = getOrCreateSheet(FOGLI.MUNICIPI, ['Municipio', 'Nome', 'Attivo']);
  if (shMun.getLastRow() < 2) {
    Object.keys(NOMI_MUNICIPI).sort().forEach(function (m) {
      shMun.appendRow([m, NOMI_MUNICIPI[m], m === '09']);
    });
  }

  // Foglio Liste: una riga di esempio per la Capitolina e per il Municipio IX
  const shListe = getOrCreateSheet(FOGLI.LISTE, ['Livello', 'Municipio', 'Nome Lista']);
  if (shListe.getLastRow() < 2) {
    shListe.appendRow(['Capitolina', '', "FRATELLI D'ITALIA"]);
    shListe.appendRow(['Capitolina', '', '(aggiungi qui le altre liste in competizione)']);
    shListe.appendRow(['Municipio', '09', "FRATELLI D'ITALIA"]);
    shListe.appendRow(['Municipio', '09', '(aggiungi qui le altre liste del Municipio IX)']);
  }

  // Foglio Candidati FdI: vuoto, pronto da compilare
  const shCand = getOrCreateSheet(FOGLI.CANDIDATI, ['Livello', 'Municipio', 'Nome e Cognome']);
  if (shCand.getLastRow() < 2) {
    shCand.appendRow(['Capitolina', '', '(inserisci qui i candidati FdI all\'Assemblea Capitolina)']);
    shCand.appendRow(['Municipio', '09', '(inserisci qui i candidati FdI al Consiglio del Municipio IX)']);
  }

  // Foglio Orari affluenza: schema standard comunali (da verificare/aggiornare
  // quando sarà fissata la data ufficiale del voto di Roma Capitale)
  const shOrari = getOrCreateSheet(FOGLI.ORARI, ['Giorno', 'Orario']);
  if (shOrari.getLastRow() < 2) {
    [['Domenica', '12:00'], ['Domenica', '19:00'], ['Domenica', '23:00'], ['Lunedì', '12:00']]
      .forEach(function (r) { shOrari.appendRow(r); });
  }

  // Fogli di raccolta dati: creati vuoti, pronti a riempirsi con gli invii.
  // IMPORTANTE: queste intestazioni devono restare identiche, colonna per
  // colonna, a quelle usate in salvaAffluenza()/salvaScrutinio() — se
  // differiscono, i valori inviati finiscono nelle celle sbagliate.
  getOrCreateSheet(FOGLI.AFFLUENZA, [
    'Timestamp', 'ID Invio', 'Codice', 'Nome e Cognome', 'Municipio', 'Sezione', 'Telefono',
    'Giorno', 'Orario', 'Elettori', 'Maschi', 'Femmine', 'Totale', '% Affluenza', 'Note',
  ].concat(COLONNE_STATO));
  getOrCreateSheet(FOGLI.SCRUTINIO, [
    'Timestamp', 'ID Invio', 'Codice', 'Municipio', 'Sezione', 'Rappresentante', 'Telefono',
    'Elettori', 'Votanti',
    'Comune - Valide', 'Comune - Bianche', 'Comune - Nulle', 'Comune - Contestate',
    'Municipio - Valide', 'Municipio - Bianche', 'Municipio - Nulle', 'Municipio - Contestate',
    'Note',
  ].concat(COLONNE_STATO));
  getOrCreateSheet(FOGLI.MESSAGGI, ['ID', 'Municipio', 'Sezione', 'Testo', 'Stato', 'Timestamp', 'Aggiornato Il']);
  getOrCreateSheet(FOGLI.VOTI_LISTE, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Livello', 'Lista', 'Voti']);
  getOrCreateSheet(FOGLI.PREFERENZE, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Livello', 'Candidato', 'Preferenze']);
  // Foglio Candidati Sindaco: uno per riga
  const shSind = getOrCreateSheet(FOGLI.SINDACI, ['Nome e Cognome']);
  if (shSind.getLastRow() < 2) {
    shSind.appendRow(['(inserisci qui i candidati Sindaco in competizione)']);
  }

  // Foglio Candidati Presidente Municipio
  const shPres = getOrCreateSheet(FOGLI.PRESIDENTI, ['Municipio', 'Nome e Cognome']);
  if (shPres.getLastRow() < 2) {
    shPres.appendRow(['09', '(inserisci qui i candidati Presidente del Municipio IX)']);
  }

  // Foglio Rappresentanti: un codice per ogni rappresentante di lista
  const shRapp = getOrCreateSheet(FOGLI.RAPPRESENTANTI, ['Codice', 'Nome e Cognome', 'Municipio', 'Sezione', 'Attivo', 'Telefono', 'Codice Hash']);
  if (shRapp.getLastRow() < 2) {
    shRapp.appendRow(['ESEMPIO2026', 'Mario Rossi', '09', '1667', true, '3280000000', '']);
  }

  getOrCreateSheet(FOGLI.VOTI_SINDACI, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Sindaco', 'Voti']);
  getOrCreateSheet(FOGLI.VOTI_PRESIDENTI, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Presidente', 'Voti']);
  aggiornaDashboardAffluenzaInterno();

  // Riordino i fogli: configurazione prima, dati raccolti dopo
  const ordine = [FOGLI.RAPPRESENTANTI, FOGLI.MUNICIPI, FOGLI.LISTE, FOGLI.CANDIDATI, FOGLI.SINDACI, FOGLI.PRESIDENTI, FOGLI.ORARI,
    FOGLI.SCRUTINIO, FOGLI.VOTI_LISTE, FOGLI.VOTI_SINDACI, FOGLI.VOTI_PRESIDENTI, FOGLI.PREFERENZE, FOGLI.AFFLUENZA, FOGLI.DASHBOARD_AFFLUENZA, FOGLI.MESSAGGI, FOGLI.LOG];
  ordine.forEach(function (nome, idx) {
    const sh = ss.getSheetByName(nome);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(idx + 1); }
  });

  getDatabaseSpreadsheet_().toast(
    'Inizializzazione completata. Vai sul foglio "Municipi", "Liste", "Candidati FdI" e "Orari Affluenza" per personalizzare i dati.',
    'Rete Seggi FdI', 10
  );
}

/**
 * Da eseguire una volta dopo aver creato il deployment come Web App,
 * per verificare che tutto risponda correttamente. Apre il log di
 * esecuzione (Visualizza > Log) per controllare l'esito.
 */
function testConfig() {
  const cfg = buildConfig();
  Logger.log(JSON.stringify(cfg, null, 2));
}

// ===================== PANNELLO COORDINATORE ============================
// Queste funzioni si eseguono direttamente dal Google Sheet tramite il
// menu personalizzato "Rete Seggi" che appare in alto nel foglio.
// Solo chi ha accesso al foglio può usarle — i rappresentanti di lista
// non le vedono né possono eseguirle.

/**
 * Crea il menu personalizzato "Rete Seggi" nella barra del foglio.
 * Viene chiamato automaticamente ogni volta che si apre il foglio.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🗳️ Rete Seggi')
    .addItem('ℹ️ Mostra versione codice', 'mostraVersioneCodice')
    .addSeparator()
    .addItem('📊 Aggiorna Dashboard generale', 'aggiornaDashboard')
    .addItem('📈 Aggiorna Dashboard Affluenza', 'aggiornaDashboardAffluenza')
    .addItem('⏱️ Attiva aggiornamento automatico (5 min)', 'attivaAggiornamentoAutomatico')
    .addItem('⏹️ Disattiva aggiornamento automatico', 'disattivaAggiornamentoAutomatico')
    .addSeparator()
    .addItem('📧 Configura alert email', 'configurazionEmail')
    .addSeparator()
    .addItem('💬 Invia messaggio a una sezione', 'inviaMessaggioDaMenu')
    .addSeparator()
    .addItem('📈 Statistiche aggregate', 'mostraStatistiche')
    .addItem('💾 Esporta dati (Excel)', 'esportaDati')
    .addSeparator()
    .addItem('📋 Riepilogo sezioni (popup)', 'riepilogoSezioni')
    .addItem('🧹 Svuota dati di test (ATTENZIONE)', 'svuotaDatiTest')
    .addSeparator()
    .addItem('🔄 Riesegui inizializzazione', 'inizializza')
    .addToUi();
}

// ===================== AGGIORNAMENTO AUTOMATICO ========================

function attivaAggiornamentoAutomatico() {
  const ui = SpreadsheetApp.getUi();
  // Rimuovo eventuali trigger esistenti per evitare duplicati
  disattivaAggiornamentoAutomatico(true);
  inizializzaRevisioneDashboardAffluenza_();
  // Creo un trigger ogni 5 minuti
  ScriptApp.newTrigger('aggiornaDashboardSilente')
    .timeBased()
    .everyMinutes(5)
    .create();
  ui.alert('✅ Aggiornamento automatico attivato!\n\nLa Dashboard si aggiornerà automaticamente ogni 5 minuti. Per disattivarlo usa il menu "Disattiva aggiornamento automatico".');
}

function disattivaAggiornamentoAutomatico(silente) {
  const triggers = ScriptApp.getProjectTriggers();
  let rimossi = 0;
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'aggiornaDashboardSilente') {
      ScriptApp.deleteTrigger(t);
      rimossi++;
    }
  });
  if (!silente) {
    SpreadsheetApp.getUi().alert(rimossi > 0
      ? '✅ Aggiornamento automatico disattivato.'
      : 'ℹ️ Nessun aggiornamento automatico era attivo.');
  }
}

function aggiornaDashboardSilente() {
  // Ogni attività è isolata: un errore non impedisce le altre operazioni.
  try {
    aggiornaDashboardInterno();
  } catch (e) {
    logError('aggiornaDashboardSilente dashboard generale', e);
  }

  try {
    aggiornaDashboardAffluenzaSeNecessario_();
  } catch (e) {
    logError('aggiornaDashboardSilente dashboard affluenza', e);
  }

  try {
    controllaEInviaAlert();
  } catch (e) {
    logError('aggiornaDashboardSilente alert', e);
  }
}

function marcaDashboardAffluenzaDaAggiornare_() {
  const props = PropertiesService.getScriptProperties();
  const revisione = Number(
    props.getProperty('DASHBOARD_AFFLUENZA_REVISION') || '0'
  );
  props.setProperty(
    'DASHBOARD_AFFLUENZA_REVISION',
    String(Number.isFinite(revisione) ? revisione + 1 : 1)
  );
}

function inizializzaRevisioneDashboardAffluenza_() {
  const props = PropertiesService.getScriptProperties();
  const revisione = Number(
    props.getProperty('DASHBOARD_AFFLUENZA_REVISION') || '0'
  );
  const ultima = Number(
    props.getProperty('DASHBOARD_AFFLUENZA_LAST_BUILT_REVISION') || '0'
  );
  props.setProperty(
    'DASHBOARD_AFFLUENZA_REVISION',
    String(Number.isFinite(revisione) ? revisione : 0)
  );
  props.setProperty(
    'DASHBOARD_AFFLUENZA_LAST_BUILT_REVISION',
    String(Number.isFinite(ultima) ? ultima : 0)
  );
}

function eseguiRebuildDashboardAffluenza_() {
  return aggiornaDashboardAffluenzaInterno();
}

function aggiornaDashboardAffluenzaSeNecessario_() {
  const props = PropertiesService.getScriptProperties();
  let revisione = Number(
    props.getProperty('DASHBOARD_AFFLUENZA_REVISION') || '0'
  );
  let ultima = Number(
    props.getProperty('DASHBOARD_AFFLUENZA_LAST_BUILT_REVISION') || '0'
  );
  if (!Number.isFinite(revisione)) revisione = 0;
  if (!Number.isFinite(ultima)) ultima = 0;
  if (revisione <= ultima) return { aggiornato: false };

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return { aggiornato: false, occupato: true };

  try {
    // Ricontrolla dopo il lock: un'altra esecuzione potrebbe aver già lavorato.
    revisione = Number(
      props.getProperty('DASHBOARD_AFFLUENZA_REVISION') || '0'
    );
    ultima = Number(
      props.getProperty('DASHBOARD_AFFLUENZA_LAST_BUILT_REVISION') || '0'
    );
    if (!Number.isFinite(revisione)) revisione = 0;
    if (!Number.isFinite(ultima)) ultima = 0;
    if (revisione <= ultima) return { aggiornato: false };

    const risultato = eseguiRebuildDashboardAffluenza_();
    // Registra la revisione elaborata soltanto dopo un rebuild riuscito.
    props.setProperty(
      'DASHBOARD_AFFLUENZA_LAST_BUILT_REVISION',
      String(revisione)
    );
    return { aggiornato: true, risultato: risultato };
  } finally {
    lock.releaseLock();
  }
}

// ===================== ALERT EMAIL =====================================

function configurazionEmail() {
  const ui = SpreadsheetApp.getUi();
  const ss = getDatabaseSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  const emailAttuale = props.getProperty('ALERT_EMAIL') || '';
  const soglia = props.getProperty('ALERT_SOGLIA') || '80';

  const risposta = ui.prompt(
    '📧 Configura alert email',
    'Inserisci l\'email dove ricevere gli alert quando le sezioni inviano i dati.\n\n' +
    'Email attuale: ' + (emailAttuale || 'non configurata') + '\n\n' +
    'Email (lascia vuoto per disattivare):',
    ui.ButtonSet.OK_CANCEL
  );
  if (risposta.getSelectedButton() !== ui.Button.OK) return;
  const nuovaEmail = risposta.getResponseText().trim();
  props.setProperty('ALERT_EMAIL', nuovaEmail);

  if (nuovaEmail) {
    const rispostaSoglia = ui.prompt(
      '📧 Soglia alert',
      'Invia un alert email quando la percentuale di sezioni che hanno inviato lo scrutinio supera questa soglia.\n\nSoglia attuale: ' + soglia + '%\nNuova soglia (es. 80):',
      ui.ButtonSet.OK_CANCEL
    );
    if (rispostaSoglia.getSelectedButton() === ui.Button.OK) {
      props.setProperty('ALERT_SOGLIA', rispostaSoglia.getResponseText().trim() || '80');
    }
    ui.alert('✅ Alert email configurato!\n\nEmail: ' + nuovaEmail + '\nSoglia scrutinio: ' + (props.getProperty('ALERT_SOGLIA') || '80') + '%');
  } else {
    ui.alert('✅ Alert email disattivato.');
  }
}

function controllaEInviaAlert() {
  const props = PropertiesService.getScriptProperties();
  const email = props.getProperty('ALERT_EMAIL');
  if (!email) return;

  const soglia = parseInt(props.getProperty('ALERT_SOGLIA') || '80');
  const ss = getDatabaseSpreadsheet_();

  const shRapp = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!shRapp) return;
  const sezioniAttive = [];
  const rappRows = shRapp.getDataRange().getValues();
  const idxRapp = mappaIntestazioni(rappRows[0]);
  for (let i = 1; i < rappRows.length; i++) {
    const r = rappRows[i];
    const municipio = valoreColonna(r, idxRapp, ['Municipio']);
    const sezione = valoreColonna(r, idxRapp, ['Sezione']);
    const attivo = valoreColonna(r, idxRapp, ['Attivo']);
    if (!sezione) continue;
    const isAttivo = attivo === true || String(attivo).toUpperCase() === 'TRUE';
    if (!isAttivo) continue;
    const key = String(Math.round(Number(municipio))).padStart(2,'0') + '-' + String(sezione).trim();
    if (!sezioniAttive.includes(key)) sezioniAttive.push(key);
  }
  if (!sezioniAttive.length) return;

  const shScr = ss.getSheetByName(FOGLI.SCRUTINIO);
  const scrutinioInviato = new Set();
  if (shScr && shScr.getLastRow() > 1) {
    const attiviScr = righeAttiveFoglio_(shScr);
    const headers = attiviScr.headers;
    const colMun = headers.indexOf('Municipio');
    const colSez = headers.indexOf('Sezione');
    const sRows = attiviScr.rows;
    const colStato = headers.indexOf('Stato');
    const colSostituitoDa = headers.indexOf('Sostituito Da');
    sRows.forEach(function(r) {
      if (colStato !== -1 && String(r[colStato] || '').toUpperCase() === 'SOSTITUITO') return;
      if (colSostituitoDa !== -1 && String(r[colSostituitoDa] || '').trim()) return;
      const mu = String(r[colMun]).trim().padStart(2,'0');
      const se = String(r[colSez]).trim();
      scrutinioInviato.add(mu + '-' + se);
    });
  }

  const percScrutinio = Math.round(scrutinioInviato.size / sezioniAttive.length * 100);
  const chiaveAlert = 'ALERT_INVIATO_' + soglia;
  const alertGiaInviato = props.getProperty(chiaveAlert);

  if (percScrutinio >= soglia && !alertGiaInviato) {
    const mancanti = sezioniAttive.filter(k => !scrutinioInviato.has(k));
    const corpo = 'Rete Seggi FdI — Alert automatico\n\n' +
      'Raggiunta la soglia del ' + soglia + '% di sezioni con scrutinio inviato.\n\n' +
      'Scrutinio inviato: ' + scrutinioInviato.size + '/' + sezioniAttive.length + ' sezioni (' + percScrutinio + '%)\n\n' +
      (mancanti.length ? 'Sezioni ancora mancanti:\n' + mancanti.join(', ') : 'Tutte le sezioni hanno inviato!') + '\n\n' +
      'Aggiornato al: ' + new Date().toLocaleString('it-IT');
    MailApp.sendEmail(email, '🗳️ Rete Seggi — ' + percScrutinio + '% scrutini ricevuti', corpo);
    props.setProperty(chiaveAlert, 'true');
  }
}


function righeAttiveFoglio_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return { headers: [], rows: [] };
  const valori = sheet.getDataRange().getValues();
  const headers = valori[0];
  const idx = mappaIntestazioni(headers);
  const rows = valori.slice(1).filter(function(r) {
    const stato = String(valoreColonna(r, idx, ['Stato']) || 'ATTIVO').trim().toUpperCase();
    const sostituitoDa = String(valoreColonna(r, idx, ['Sostituito Da']) || '').trim();
    return stato !== 'SOSTITUITO' && !sostituitoDa;
  });
  return { headers: headers, rows: rows };
}

// ===================== STATISTICHE AGGREGATE ===========================

function mostraStatistiche() {
  const ss = getDatabaseSpreadsheet_();
  const ui = SpreadsheetApp.getUi();

  const shAff = ss.getSheetByName(FOGLI.AFFLUENZA);
  const shScr = ss.getSheetByName(FOGLI.SCRUTINIO);
  const shRapp = ss.getSheetByName(FOGLI.RAPPRESENTANTI);

  // Sezioni attive
  const sezioniAttive = new Set();
  if (shRapp && shRapp.getLastRow() > 1) {
    const rows = shRapp.getDataRange().getValues();
    const idxRapp = mappaIntestazioni(rows[0]);
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      const municipio = valoreColonna(r, idxRapp, ['Municipio']);
      const sezione = valoreColonna(r, idxRapp, ['Sezione']);
      const attivo = valoreColonna(r, idxRapp, ['Attivo']);
      if (!sezione) continue;
      if (attivo === true || String(attivo).toUpperCase() === 'TRUE') {
        sezioniAttive.add(String(Math.round(Number(municipio))).padStart(2,'0') + '-' + String(sezione).trim());
      }
    }
  }

  // Affluenza per orario
  const affluenzaPerOrario = {};
  if (shAff && shAff.getLastRow() > 1) {
    const attiviAff = righeAttiveFoglio_(shAff);
    const headers = attiviAff.headers;
    const colGio = headers.indexOf('Giorno');
    const colOra = headers.indexOf('Orario');
    const colTot = headers.indexOf('Totale');
    const colEl = headers.indexOf('Elettori');
    const rows = attiviAff.rows;
    rows.forEach(function(r) {
      const orario = (r[colGio] ? r[colGio]+' ' : '') + r[colOra];
      if (!affluenzaPerOrario[orario]) affluenzaPerOrario[orario] = { totVotanti: 0, totElettori: 0, sezioni: 0 };
      affluenzaPerOrario[orario].totVotanti += Number(r[colTot]) || 0;
      affluenzaPerOrario[orario].totElettori += Number(r[colEl]) || 0;
      affluenzaPerOrario[orario].sezioni++;
    });
  }

  // Scrutinio
  const sezioniScrutinio = new Set();
  let totVotanti = 0, totElettori = 0;
  if (shScr && shScr.getLastRow() > 1) {
    const attiviScr = righeAttiveFoglio_(shScr);
    const headers = attiviScr.headers;
    const colMun = headers.indexOf('Municipio');
    const colSez = headers.indexOf('Sezione');
    const colEl = headers.indexOf('Elettori');
    const colVot = headers.indexOf('Votanti');
    const rows = attiviScr.rows;
    rows.forEach(function(r) {
      const key = String(r[colMun]).trim().padStart(2,'0') + '-' + String(r[colSez]).trim();
      sezioniScrutinio.add(key);
      totElettori += Number(r[colEl]) || 0;
      totVotanti += Number(r[colVot]) || 0;
    });
  }

  const percScrutinio = sezioniAttive.size ? Math.round(sezioniScrutinio.size / sezioniAttive.size * 100) : 0;
  const percAffluenza = totElettori ? Math.round(totVotanti / totElettori * 100 * 10) / 10 : 0;

  let msg = '📈 STATISTICHE AGGREGATE\n';
  msg += '━━━━━━━━━━━━━━━━━━━━━━\n\n';
  msg += '📋 SEZIONI\n';
  msg += 'Totale sezioni attive: ' + sezioniAttive.size + '\n';
  msg += 'Scrutinio inviato: ' + sezioniScrutinio.size + '/' + sezioniAttive.size + ' (' + percScrutinio + '%)\n\n';

  if (Object.keys(affluenzaPerOrario).length) {
    msg += '🗳️ AFFLUENZA PER ORARIO\n';
    Object.keys(affluenzaPerOrario).sort().forEach(function(orario) {
      const d = affluenzaPerOrario[orario];
      const perc = d.totElettori ? Math.round(d.totVotanti / d.totElettori * 100 * 10) / 10 : '—';
      msg += orario + ': ' + d.totVotanti + ' votanti';
      if (perc !== '—') msg += ' (' + perc + '%)';
      msg += ' — ' + d.sezioni + ' sezioni\n';
    });
    msg += '\n';
  }

  if (sezioniScrutinio.size) {
    msg += '📊 SCRUTINIO FINALE\n';
    msg += 'Elettori totali: ' + totElettori.toLocaleString('it-IT') + '\n';
    msg += 'Votanti totali: ' + totVotanti.toLocaleString('it-IT') + '\n';
    msg += 'Affluenza finale: ' + percAffluenza + '%\n';
  }

  msg += '\n⏰ Aggiornato al: ' + new Date().toLocaleString('it-IT');
  ui.alert('Statistiche aggregate', msg, ui.ButtonSet.OK);
}

// ===================== EXPORT EXCEL ====================================

function esportaDati() {
  const ui = SpreadsheetApp.getUi();

  // Cancella il foglio _Export se esiste da versioni precedenti
  const ss = getDatabaseSpreadsheet_();
  const shExport = ss.getSheetByName('_Export');
  if (shExport) ss.deleteSheet(shExport);

  ui.alert(
    '💾 Come scaricare i dati in Excel',
    'Per scaricare tutti i dati in formato Excel:\n\n' +
    '1. Clicca su "File" nel menu in alto\n' +
    '2. Scegli "Scarica"\n' +
    '3. Clicca su "Microsoft Excel (.xlsx)"\n\n' +
    'Il file scaricato conterrà tutti i fogli:\n' +
    'Affluenza, Scrutinio, Voti Liste, Preferenze, ecc.',
    ui.ButtonSet.OK
  );
}

/**
 * Genera/aggiorna il foglio "Dashboard" con lo stato di tutte le sezioni.
 * Mostra per ogni sezione: affluenza per orario e stato scrutinio.
 * Verde = inviato, Rosso = mancante, Giallo = in attesa.
 */
function aggiornaDashboard() {
  aggiornaDashboardInterno();
  SpreadsheetApp.getUi().alert('✅ Dashboard aggiornata!\n\nVerde = inviato · Rosso = mancante · Grigio = sezione non attiva\n\nRiaggiorna dal menu "🗳️ Rete Seggi → Aggiorna Dashboard ora" ogni volta che vuoi vedere i dati più recenti.');
}

function aggiornaDashboardInterno() {
  const ss = getDatabaseSpreadsheet_();

  // 1) Leggo le sezioni dal foglio Rappresentanti.
  // La lettura usa le intestazioni, ma applica anche un controllo sui valori:
  // evita che un numero di telefono venga interpretato come Municipio quando
  // nel foglio esistono intestazioni vecchie, spostate o non uniformi.
  const shRapp = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!shRapp) {
    throw new Error('Foglio "Rappresentanti" non trovato. Esegui prima "Inizializzazione".');
  }

  const sezioniAssegnate = [];
  const rappRows = shRapp.getDataRange().getValues();
  if (!rappRows.length) {
    throw new Error('Il foglio "Rappresentanti" è vuoto.');
  }

  const idxRapp = mappaIntestazioni(rappRows[0]);

  function numeroInteroDashboard_(valore) {
    if (valore === null || valore === undefined || valore === '') return null;
    const testo = String(valore).trim().replace(/\s+/g, '');
    if (!/^\d+$/.test(testo)) return null;
    const numero = Number(testo);
    return Number.isFinite(numero) ? numero : null;
  }

  function municipioValidoDashboard_(valore) {
    const numero = numeroInteroDashboard_(valore);
    return numero !== null && numero >= 1 && numero <= 15 ? numero : null;
  }

  function sezioneValidaDashboard_(valore) {
    const numero = numeroInteroDashboard_(valore);
    // Le sezioni di Roma sono numeri positivi; valori da 1 a 15 possono
    // coincidere con il Municipio e non vengono usati come fallback.
    return numero !== null && numero > 15 && numero < 10000 ? String(numero) : null;
  }

  function attivoDashboard_(valore) {
    if (valore === true || valore === 1) return true;
    const testo = String(valore || '')
      .trim()
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
    return ['TRUE', 'VERO', 'SI', 'ATTIVO', '1', 'YES'].indexOf(testo) !== -1;
  }

  for (let i = 1; i < rappRows.length; i++) {
    const r = rappRows[i];

    const codice = identitaCodiceRiga_(r, idxRapp);
    const nome = valoreColonna(r, idxRapp, ['Nome e Cognome', 'Nome', 'Rappresentante']);
    const attivo = valoreColonna(r, idxRapp, ['Attivo']);

    let municipioNumero = municipioValidoDashboard_(
      valoreColonna(r, idxRapp, ['Municipio'])
    );
    let sezione = sezioneValidaDashboard_(
      valoreColonna(r, idxRapp, ['Sezione'])
    );

    // Fallback: cerca i valori plausibili nella riga.
    // Esempio riga: Codice, Nome, Telefono, 9, 1667, Attivo.
    if (municipioNumero === null) {
      for (let c = 0; c < r.length; c++) {
        const candidato = municipioValidoDashboard_(r[c]);
        if (candidato !== null) {
          municipioNumero = candidato;
          break;
        }
      }
    }

    if (!sezione) {
      for (let c = 0; c < r.length; c++) {
        const candidato = sezioneValidaDashboard_(r[c]);
        if (candidato) {
          sezione = candidato;
          break;
        }
      }
    }

    if (!codice || municipioNumero === null || !sezione) continue;

    const municipio = String(municipioNumero).padStart(2, '0');
    const key = municipio + '-' + String(sezione).trim();
    const isAttivo = attivoDashboard_(attivo);

    if (!sezioniAssegnate.find(function (s) { return s.key === key; })) {
      sezioniAssegnate.push({
        key: key,
        codice: String(codice).trim(),
        nome: String(nome || '').trim(),
        municipio: municipio,
        sezione: String(sezione).trim(),
        attivo: isAttivo
      });
    }
  }

  // 2) Leggo gli orari configurati
  const shOrari = ss.getSheetByName(FOGLI.ORARI);
  const orari = [];
  if (shOrari && shOrari.getLastRow() > 1) {
    const oRows = shOrari.getRange(2, 1, shOrari.getLastRow()-1, 2).getValues();
    oRows.forEach(function(r) { if (r[1]) orari.push((r[0] ? r[0]+' ' : '') + r[1]); });
  }

  // 3) Leggo gli invii di affluenza
  const affluenzaInviata = {}; // key: sez-key, valore: set di orari inviati
  const shAff = ss.getSheetByName(FOGLI.AFFLUENZA);
  if (shAff && shAff.getLastRow() > 1) {
    const attiviAffDash = righeAttiveFoglio_(shAff);
    const aRows = attiviAffDash.rows;
    const headers = attiviAffDash.headers;
    const colMun = headers.indexOf('Municipio');
    const colSez = headers.indexOf('Sezione');
    const colGio = headers.indexOf('Giorno');
    const colOra = headers.indexOf('Orario');
    aRows.forEach(function(r) {
      const mu = String(r[colMun]).trim().padStart(2,'0');
      const se = String(r[colSez]).trim();
      const orario = (r[colGio] ? r[colGio]+' ' : '') + r[colOra];
      const k = mu + '-' + se;
      if (!affluenzaInviata[k]) affluenzaInviata[k] = new Set();
      affluenzaInviata[k].add(String(orario).trim());
    });
  }

  // 4) Leggo gli invii di scrutinio
  const scrutinioInviato = new Set();
  const shScr = ss.getSheetByName(FOGLI.SCRUTINIO);
  if (shScr && shScr.getLastRow() > 1) {
    const attiviScrDash = righeAttiveFoglio_(shScr);
    const sRows = attiviScrDash.rows;
    const headers = attiviScrDash.headers;
    const colMun = headers.indexOf('Municipio');
    const colSez = headers.indexOf('Sezione');
    sRows.forEach(function(r) {
      const mu = String(r[colMun]).trim().padStart(2,'0');
      const se = String(r[colSez]).trim();
      scrutinioInviato.add(mu + '-' + se);
    });
  }

  // 5) Creo/aggiorno il foglio Dashboard
  let shDash = ss.getSheetByName('Dashboard');
  if (shDash) ss.deleteSheet(shDash);
  shDash = ss.insertSheet('Dashboard', 0);

  // Intestazioni
  const intestazioni = ['Codice', 'Rappresentante', 'Municipio', 'Sezione', 'Attivo'].concat(orari).concat(['SCRUTINIO']);
  shDash.appendRow(intestazioni);

  // Stile intestazioni
  const headerRange = shDash.getRange(1, 1, 1, intestazioni.length);
  headerRange.setBackground('#152a57').setFontColor('#ffffff').setFontWeight('bold').setFontSize(11);
  shDash.setFrozenRows(1);

  // Dati
  const VERDE = '#c6efce'; const VERDE_SCURO = '#375623';
  const ROSSO = '#ffc7ce'; const ROSSO_SCURO = '#9c0006';
  const GRIGIO = '#f2f2f2';

  sezioniAssegnate.forEach(function(sez, idx) {
    const riga = [sez.codice, sez.nome, 'Municipio ' + sez.municipio, sez.sezione, sez.attivo ? 'Sì' : 'No'];
    const colori = ['#ffffff', '#ffffff', '#ffffff', '#ffffff', sez.attivo ? '#ffffff' : GRIGIO];

    orari.forEach(function(orario) {
      const haInviato = affluenzaInviata[sez.key] && affluenzaInviata[sez.key].has(orario);
      riga.push(haInviato ? '✅' : '❌');
      colori.push(haInviato ? VERDE : (sez.attivo ? ROSSO : GRIGIO));
    });

    const haScrutinio = scrutinioInviato.has(sez.key);
    riga.push(haScrutinio ? '✅ Inviato' : '❌ Mancante');
    colori.push(haScrutinio ? VERDE : (sez.attivo ? ROSSO : GRIGIO));

    const rowNum = idx + 2;
    shDash.appendRow(riga);
    const dataRange = shDash.getRange(rowNum, 1, 1, intestazioni.length);
    dataRange.setBackgrounds([colori]);
    if (!sez.attivo) dataRange.setFontColor('#999999');
  });

  // Riga totali
  const totRow = ['', 'TOTALE SEZIONI: ' + sezioniAssegnate.filter(s=>s.attivo).length, '', '', ''];
  orari.forEach(function(orario) {
    const inviati = sezioniAssegnate.filter(s => s.attivo && affluenzaInviata[s.key] && affluenzaInviata[s.key].has(orario)).length;
    const totali = sezioniAssegnate.filter(s => s.attivo).length;
    totRow.push(inviati + '/' + totali);
  });
  const scrInviati = sezioniAssegnate.filter(s => s.attivo && scrutinioInviato.has(s.key)).length;
  const scrTotali = sezioniAssegnate.filter(s => s.attivo).length;
  totRow.push(scrInviati + '/' + scrTotali);
  shDash.appendRow(totRow);
  const totRange = shDash.getRange(sezioniAssegnate.length + 2, 1, 1, intestazioni.length);
  totRange.setBackground('#152a57').setFontColor('#ffffff').setFontWeight('bold');

  // Formattazione colonne
  shDash.setColumnWidth(1, 120);
  shDash.setColumnWidth(2, 180);
  shDash.setColumnWidth(3, 130);
  shDash.setColumnWidth(4, 80);
  shDash.setColumnWidth(5, 60);
  for (let c = 6; c <= intestazioni.length; c++) shDash.setColumnWidth(c, 110);
  shDash.getRange(2, 6, sezioniAssegnate.length + 1, orari.length + 1).setHorizontalAlignment('center').setFontSize(13);

  // Nota aggiornamento
  shDash.getRange(sezioniAssegnate.length + 4, 1).setValue('Ultimo aggiornamento: ' + new Date().toLocaleString('it-IT'));
  shDash.getRange(sezioniAssegnate.length + 4, 1).setFontColor('#999999').setFontStyle('italic');

  ss.setActiveSheet(shDash);
}

/**
 * Mostra una finestra di dialogo con il riepilogo delle sezioni:
 * quante hanno inviato dati e quante mancano.
 */
function riepilogoSezioni() {
  const ss = getDatabaseSpreadsheet_();
  const ui = SpreadsheetApp.getUi();

  // Conta sezioni univoche per affluenza (cerca la colonna "Sezione" per nome,
  // così non si rompe se in futuro si aggiungono altre colonne prima di essa)
  const shAff = ss.getSheetByName(FOGLI.AFFLUENZA);
  const sezioniAff = new Set();
  if (shAff && shAff.getLastRow() > 1) {
    const headers = shAff.getRange(1, 1, 1, shAff.getLastColumn()).getValues()[0];
    const colSez = headers.indexOf('Sezione');
    if (colSez !== -1) {
      const dati = shAff.getRange(2, colSez + 1, shAff.getLastRow() - 1, 1).getValues();
      dati.forEach(function(r) { if (r[0]) sezioniAff.add(String(r[0])); });
    }
  }

  // Conta sezioni univoche per scrutinio
  const shScr = ss.getSheetByName(FOGLI.SCRUTINIO);
  const sezioniScr = new Set();
  if (shScr && shScr.getLastRow() > 1) {
    const headers = shScr.getRange(1, 1, 1, shScr.getLastColumn()).getValues()[0];
    const colSez = headers.indexOf('Sezione');
    if (colSez !== -1) {
      const dati = shScr.getRange(2, colSez + 1, shScr.getLastRow() - 1, 1).getValues();
      dati.forEach(function(r) { if (r[0]) sezioniScr.add(String(r[0])); });
    }
  }

  // Conta totale sezioni attive dai municip
  const shMun = ss.getSheetByName(FOGLI.MUNICIPI);
  let sezioniTotali = 0;
  const municipiAttivi = [];
  if (shMun && shMun.getLastRow() > 1) {
    const dati = shMun.getRange(2, 1, shMun.getLastRow() - 1, 3).getValues();
    dati.forEach(function(r) {
      if (r[2] === true || String(r[2]).toUpperCase() === 'TRUE' || String(r[2]).toUpperCase() === 'VERO') {
        municipiAttivi.push(String(r[0]).padStart(2,'0'));
      }
    });
  }

  const msg = [
    '📊 RIEPILOGO SEZIONI',
    '',
    'Municipi attivi: ' + (municipiAttivi.length ? municipiAttivi.map(function(m){ return 'Municipio ' + m; }).join(', ') : 'nessuno'),
    '',
    'Affluenza:',
    '  Sezioni che hanno inviato: ' + sezioniAff.size,
    '',
    'Scrutinio:',
    '  Sezioni che hanno inviato: ' + sezioniScr.size,
    '',
    'Aggiornato al: ' + new Date().toLocaleString('it-IT'),
  ].join('\n');

  ui.alert('Riepilogo Sezioni', msg, ui.ButtonSet.OK);
}

/**
 * Svuota tutti i fogli dati (mantiene solo le intestazioni).
 * Chiede doppia conferma prima di procedere — azione irreversibile.
 */
function svuotaDatiTest() {
  const ui = SpreadsheetApp.getUi();

  const prima = ui.alert(
    '⚠️ ATTENZIONE — Svuota dati di test',
    'Questa operazione elimina TUTTI i dati inseriti finora dai fogli:\n' +
    '• Invii Affluenza\n• Invii Scrutinio\n• Invii Voti Liste\n• Invii Voti Sindaci\n• Invii Voti Presidenti\n• Invii Preferenze\n\n' +
    'Le impostazioni (Municipi, Liste, Candidati, Orari) NON vengono toccate.\n\n' +
    'Sei sicuro di voler procedere?',
    ui.ButtonSet.YES_NO
  );

  if (prima !== ui.Button.YES) return;

  const seconda = ui.alert(
    '⚠️ ULTIMA CONFERMA',
    'Stai per cancellare TUTTI i dati raccolti. Questa operazione è IRREVERSIBILE.\n\nConfermi?',
    ui.ButtonSet.YES_NO
  );

  if (seconda !== ui.Button.YES) return;

  const ss = getDatabaseSpreadsheet_();
  const fogli_dati = [
    FOGLI.AFFLUENZA, FOGLI.SCRUTINIO, FOGLI.VOTI_LISTE,
    FOGLI.VOTI_SINDACI, FOGLI.VOTI_PRESIDENTI, FOGLI.PREFERENZE, FOGLI.MESSAGGI, FOGLI.LOG,
  ];

  let cancellate = 0;
  fogli_dati.forEach(function(nome) {
    const sh = ss.getSheetByName(nome);
    if (sh && sh.getLastRow() > 1) {
      sh.deleteRows(2, sh.getLastRow() - 1);
      cancellate++;
    }
  });

  // Cancella anche il foglio Dashboard (verrà rigenerato al prossimo aggiornamento)
  const shDash = ss.getSheetByName('Dashboard');
  if (shDash) {
    ss.deleteSheet(shDash);
    cancellate++;
  }

  ui.alert(
    '✅ Completato',
    'Dati cancellati da ' + cancellate + ' fogli.\nLe impostazioni e la configurazione sono intatte.\n\nRicorda di aggiornare la Dashboard dal menu quando vuoi vederla aggiornata.',
    ui.ButtonSet.OK
  );
}

// ===================== DASHBOARD AFFLUENZA VALIDA =========================

function normalizzaIntestazione_(valore) {
  return String(valore === null || valore === undefined ? '' : valore)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function trovaColonna_(intestazioniNormalizzate, nomiPossibili) {
  for (let i = 0; i < nomiPossibili.length; i++) {
    const posizione = intestazioniNormalizzate.indexOf(
      normalizzaIntestazione_(nomiPossibili[i])
    );
    if (posizione !== -1) return posizione;
  }
  return -1;
}

function filtraInviiValidi_(righe, intestazioniNormalizzate) {
  const colId = trovaColonna_(intestazioniNormalizzate, ['ID Invio']);
  const colCorrezione = trovaColonna_(
    intestazioniNormalizzate,
    ['Correzione di', 'Correzione Di']
  );

  if (colId === -1) return [];
  if (colCorrezione === -1) {
    return righe.filter(function(riga) {
      return String(riga[colId] || '').trim() !== '';
    });
  }

  const sostituiti = new Set();
  righe.forEach(function(riga) {
    const precedente = String(riga[colCorrezione] || '').trim();
    if (precedente) sostituiti.add(precedente);
  });

  return righe.filter(function(riga) {
    const id = String(riga[colId] || '').trim();
    return id && !sostituiti.has(id);
  });
}

function aggiornaDashboardAffluenza() {
  const ui = SpreadsheetApp.getUi();
  const lock = LockService.getScriptLock();

  if (!lock.tryLock(5000)) {
    ui.alert(
      'Aggiornamento in corso',
      'La dashboard è già in aggiornamento. Riprova tra pochi secondi.',
      ui.ButtonSet.OK
    );
    return;
  }

  try {
    const risultato = eseguiRebuildDashboardAffluenza_();
    const props = PropertiesService.getScriptProperties();
    const revisione = Number(
      props.getProperty('DASHBOARD_AFFLUENZA_REVISION') || '0'
    );
    props.setProperty(
      'DASHBOARD_AFFLUENZA_LAST_BUILT_REVISION',
      String(Number.isFinite(revisione) ? revisione : 0)
    );

    ui.alert(
      '✅ Dashboard Affluenza aggiornata',
      'Invii validi visualizzati: ' + risultato.righeValide +
        '\nInvii storici letti: ' + risultato.righeStoriche +
        '\nInvii sostituiti esclusi: ' +
        (risultato.righeStoriche - risultato.righeValide),
      ui.ButtonSet.OK
    );
  } catch (e) {
    logError('aggiornaDashboardAffluenza manuale', e);
    ui.alert(
      'Errore aggiornamento',
      (e && e.message ? e.message : String(e)),
      ui.ButtonSet.OK
    );
  } finally {
    lock.releaseLock();
  }
}

function aggiornaDashboardAffluenzaInterno() {
  const ss = getDatabaseSpreadsheet_();
  const origine = ss.getSheetByName(FOGLI.AFFLUENZA);

  const intestazioniDashboard = [
    'Timestamp', 'Codice', 'Municipio', 'Sezione', 'Rappresentante',
    'Telefono', 'Giorno', 'Orario', 'Elettori', 'Maschi', 'Femmine',
    'Totale', '% Affluenza', 'Stato', 'ID Invio', 'Correzione di',
    'Motivo correzione', 'Note', 'Versione app'
  ];

  let dashboard = ss.getSheetByName(FOGLI.DASHBOARD_AFFLUENZA);
  if (!dashboard) dashboard = ss.insertSheet(FOGLI.DASHBOARD_AFFLUENZA);

  if (!origine || origine.getLastRow() < 2) {
    preparaDashboardAffluenza_(
      dashboard,
      intestazioniDashboard,
      []
    );
    return { righeValide: 0, righeStoriche: 0 };
  }

  const valori = origine.getDataRange().getValues();
  const intestazioniOriginali = valori[0].map(function(v) {
    return String(v || '').replace(/\s+/g, ' ').trim();
  });
  const intestazioniNormalizzate =
    intestazioniOriginali.map(normalizzaIntestazione_);

  const colonne = {
    timestamp: trovaColonna_(intestazioniNormalizzate, ['Timestamp']),
    id: trovaColonna_(intestazioniNormalizzate, ['ID Invio']),
    codice: trovaColonna_(intestazioniNormalizzate, ['Codice']),
    municipio: trovaColonna_(intestazioniNormalizzate, ['Municipio']),
    sezione: trovaColonna_(intestazioniNormalizzate, ['Sezione']),
    rappresentante: trovaColonna_(intestazioniNormalizzate, ['Rappresentante', 'Nome e Cognome']),
    telefono: trovaColonna_(intestazioniNormalizzate, ['Telefono']),
    giorno: trovaColonna_(intestazioniNormalizzate, ['Giorno']),
    orario: trovaColonna_(intestazioniNormalizzate, ['Orario']),
    elettori: trovaColonna_(intestazioniNormalizzate, ['Elettori']),
    maschi: trovaColonna_(intestazioniNormalizzate, ['Maschi']),
    femmine: trovaColonna_(intestazioniNormalizzate, ['Femmine']),
    totale: trovaColonna_(intestazioniNormalizzate, ['Totale']),
    note: trovaColonna_(intestazioniNormalizzate, ['Note']),
    correzione: trovaColonna_(
      intestazioniNormalizzate,
      ['Correzione di', 'Correzione Di']
    ),
    motivo: trovaColonna_(
      intestazioniNormalizzate,
      ['Motivo correzione']
    ),
    versione: trovaColonna_(
      intestazioniNormalizzate,
      ['Versione app']
    )
  };

  // Solo queste colonne sono indispensabili per costruire la dashboard.
  const obbligatorie = {
    Timestamp: colonne.timestamp,
    'ID Invio': colonne.id,
    Municipio: colonne.municipio,
    Sezione: colonne.sezione,
    Giorno: colonne.giorno,
    Orario: colonne.orario,
    Totale: colonne.totale
  };

  const mancanti = Object.keys(obbligatorie).filter(function(nome) {
    return obbligatorie[nome] === -1;
  });

  if (mancanti.length) {
    throw new Error(
      'Nel foglio "' + FOGLI.AFFLUENZA +
      '" mancano soltanto queste intestazioni indispensabili: ' +
      mancanti.join(', ')
    );
  }

  const righeStoriche = valori.slice(1).filter(function(riga) {
    return String(riga[colonne.id] || '').trim() !== '';
  });

  const righeValide = filtraInviiValidi_(
    righeStoriche,
    intestazioniNormalizzate
  );

  // Se per la stessa sezione, giorno e orario restano più invii validi,
  // conserva quello con timestamp più recente.
  const ultimoPerRilevazione = new Map();
  righeValide.forEach(function(riga) {
    const chiave = [
      normalizzaMunicipioDashboard_(riga[colonne.municipio]),
      String(riga[colonne.sezione] || '').trim(),
      String(riga[colonne.giorno] || '').trim().toLowerCase(),
      String(riga[colonne.orario] || '').trim()
    ].join('|');

    const precedente = ultimoPerRilevazione.get(chiave);
    if (
      !precedente ||
      dataDaCellaDashboard_(riga[colonne.timestamp]).getTime() >=
        dataDaCellaDashboard_(precedente[colonne.timestamp]).getTime()
    ) {
      ultimoPerRilevazione.set(chiave, riga);
    }
  });

  const definitive = Array.from(ultimoPerRilevazione.values());
  definitive.sort(function(a, b) {
    const municipioA = Number(a[colonne.municipio]) || 0;
    const municipioB = Number(b[colonne.municipio]) || 0;
    if (municipioA !== municipioB) return municipioA - municipioB;

    const sezioneA = Number(a[colonne.sezione]) || 0;
    const sezioneB = Number(b[colonne.sezione]) || 0;
    if (sezioneA !== sezioneB) return sezioneA - sezioneB;

    return String(a[colonne.orario] || '').localeCompare(
      String(b[colonne.orario] || '')
    );
  });

  function valoreFacoltativo_(riga, posizione) {
    return posizione === -1 ? '' : riga[posizione];
  }

  const output = definitive.map(function(riga) {
    const elettori = numeroDashboard_(
      valoreFacoltativo_(riga, colonne.elettori)
    );
    const totale = numeroDashboard_(riga[colonne.totale]);
    const correzioneDi = String(
      valoreFacoltativo_(riga, colonne.correzione) || ''
    ).trim();
    const percentuale = elettori > 0
      ? Math.round((totale / elettori) * 1000) / 10
      : '';

    return [
      riga[colonne.timestamp],
      valoreFacoltativo_(riga, colonne.codice),
      normalizzaMunicipioDashboard_(riga[colonne.municipio]),
      riga[colonne.sezione],
      valoreFacoltativo_(riga, colonne.rappresentante),
      valoreFacoltativo_(riga, colonne.telefono),
      riga[colonne.giorno],
      riga[colonne.orario],
      elettori || '',
      valoreFacoltativo_(riga, colonne.maschi),
      valoreFacoltativo_(riga, colonne.femmine),
      totale,
      percentuale,
      correzioneDi ? 'Corretto' : 'Originale',
      riga[colonne.id],
      correzioneDi,
      valoreFacoltativo_(riga, colonne.motivo),
      valoreFacoltativo_(riga, colonne.note),
      valoreFacoltativo_(riga, colonne.versione)
    ];
  });

  preparaDashboardAffluenza_(
    dashboard,
    intestazioniDashboard,
    output
  );

  return {
    righeValide: output.length,
    righeStoriche: righeStoriche.length
  };
}

function preparaDashboardAffluenza_(dashboard, intestazioni, output) {
  const filtro = dashboard.getFilter();
  if (filtro) filtro.remove();

  dashboard.clearContents();
  dashboard.clearFormats();

  dashboard.getRange(1, 1, 1, intestazioni.length)
    .setValues([intestazioni])
    .setBackground('#152a57')
    .setFontColor('#ffffff')
    .setFontWeight('bold')
    .setWrap(true);

  if (output.length) {
    dashboard.getRange(2, 1, output.length, intestazioni.length)
      .setValues(output)
      .setVerticalAlignment('middle');

    dashboard.getRange(2, 1, output.length, 1)
      .setNumberFormat('dd/MM/yyyy HH:mm:ss');

    dashboard.getRange(2, 13, output.length, 1)
      .setNumberFormat('0.0"%"');

    const sfondiStato = output.map(function(riga) {
      return [riga[13] === 'Corretto' ? '#fff2cc' : '#d9ead3'];
    });
    dashboard.getRange(2, 14, output.length, 1)
      .setBackgrounds(sfondiStato);

    dashboard.getRange(
      1,
      1,
      output.length + 1,
      intestazioni.length
    ).createFilter();
  }

  dashboard.setFrozenRows(1);
  dashboard.autoResizeColumns(1, intestazioni.length);
  dashboard.setColumnWidth(5, 190);
  dashboard.setColumnWidth(15, 260);
  dashboard.setColumnWidth(16, 260);
  dashboard.setColumnWidth(17, 180);
  dashboard.setColumnWidth(18, 220);
}

function numeroDashboard_(valore) {
  if (valore === '' || valore === null || valore === undefined) return 0;
  const numero = Number(valore);
  return Number.isFinite(numero) ? numero : 0;
}

function normalizzaMunicipioDashboard_(valore) {
  const testo = String(
    valore === null || valore === undefined ? '' : valore
  ).trim();
  const numero = Number(testo);
  return Number.isFinite(numero)
    ? String(Math.round(numero)).padStart(2, '0')
    : testo.padStart(2, '0');
}

function dataDaCellaDashboard_(valore) {
  if (valore instanceof Date && !isNaN(valore.getTime())) return valore;

  const testo = String(valore || '').trim();
  const match = testo.match(
    /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ ,]+(\d{1,2})[.:](\d{2})[.:](\d{2})$/
  );

  if (match) {
    return new Date(
      Number(match[3]),
      Number(match[2]) - 1,
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6])
    );
  }

  const data = new Date(valore);
  return isNaN(data.getTime()) ? new Date(0) : data;
}

// ===================== DASHBOARD WEB COORDINAMENTO ==========================

/*
 * Configurazione iniziale sicura:
 * 1. nelle Proprietà script creare DASHBOARD_PASSWORD_TEMP con la password;
 * 2. eseguire una sola volta configuraPasswordDashboardDaProprieta();
 * 3. la funzione salva soltanto DASHBOARD_PASSWORD_HASH e cancella la password.
 *
 * La dashboard usa POST text/plain sia per l'accesso sia per i dati.
 * La password non viene salvata dal browser e non compare nella query URL.
 */

const DURATA_TOKEN_DASHBOARD_MS = 8 * 60 * 60 * 1000;

function hashPasswordDashboard_(password) {
  const testo = String(password || '');
  const digest = Utilities.computeHmacSha256Signature(testo, getDashboardPasswordPepper_());
  return Utilities.base64EncodeWebSafe(digest).replace(/=+$/, '');
}

function getDashboardPasswordPepper_() {
  const props = PropertiesService.getScriptProperties();
  let pepper = props.getProperty('DASHBOARD_PASSWORD_PEPPER');
  if (!pepper) {
    pepper = Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('DASHBOARD_PASSWORD_PEPPER', pepper);
  }
  return pepper;
}

function confrontoCostanteDashboard_(a, b) {
  const x = String(a || '');
  const y = String(b || '');
  let differenza = x.length ^ y.length;
  const lunghezza = Math.max(x.length, y.length);
  for (let i = 0; i < lunghezza; i++) {
    differenza |= (x.charCodeAt(i % Math.max(1, x.length)) || 0) ^
                  (y.charCodeAt(i % Math.max(1, y.length)) || 0);
  }
  return differenza === 0;
}

function configuraPasswordDashboardDaProprieta() {
  const props = PropertiesService.getScriptProperties();
  const password = String(props.getProperty('DASHBOARD_PASSWORD_TEMP') || '');
  if (password.length < 16) {
    throw new Error('DASHBOARD_PASSWORD_TEMP deve contenere almeno 16 caratteri.');
  }
  props.setProperty('DASHBOARD_PASSWORD_HASH', hashPasswordDashboard_(password));
  props.deleteProperty('DASHBOARD_PASSWORD_TEMP');
  getDashboardTokenSecret_();
  Logger.log('Password dashboard configurata. La proprietà temporanea è stata eliminata.');
  return { ok: true, configurata: true };
}

function getDashboardTokenSecret_() {
  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('DASHBOARD_TOKEN_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + Utilities.getUuid();
    props.setProperty('DASHBOARD_TOKEN_SECRET', secret);
  }
  return secret;
}

function creaTokenDashboard_() {
  const scadenza = Date.now() + DURATA_TOKEN_DASHBOARD_MS;
  const payload = JSON.stringify({
    scope: 'dashboard_affluenza',
    exp: scadenza,
    nonce: Utilities.getUuid()
  });
  const payloadB64 = Utilities.base64EncodeWebSafe(payload).replace(/=+$/, '');
  const firma = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payloadB64, getDashboardTokenSecret_())
  ).replace(/=+$/, '');
  return {
    token: payloadB64 + '.' + firma,
    scadenza: new Date(scadenza).toISOString()
  };
}

function validaTokenDashboard_(token) {
  const parti = String(token || '').split('.');
  if (parti.length !== 2) {
    return { ok: false, code: 'DASHBOARD_SESSION_INVALID', error: 'Sessione dashboard non valida.' };
  }

  const payloadB64 = parti[0];
  const firmaRicevuta = parti[1];
  const firmaAttesa = Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(payloadB64, getDashboardTokenSecret_())
  ).replace(/=+$/, '');

  if (!confrontoCostanteDashboard_(firmaRicevuta, firmaAttesa)) {
    return { ok: false, code: 'DASHBOARD_SESSION_INVALID', error: 'Sessione dashboard non valida.' };
  }

  try {
    const payload = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(payloadB64)).getDataAsString()
    );
    if (payload.scope !== 'dashboard_affluenza' || !payload.exp || Date.now() > Number(payload.exp)) {
      return { ok: false, code: 'DASHBOARD_SESSION_EXPIRED', error: 'Sessione dashboard scaduta.' };
    }
    return { ok: true, exp: Number(payload.exp) };
  } catch (e) {
    return { ok: false, code: 'DASHBOARD_SESSION_INVALID', error: 'Sessione dashboard illeggibile.' };
  }
}

function loginDashboard_(password) {
  const props = PropertiesService.getScriptProperties();
  const hashAtteso = String(props.getProperty('DASHBOARD_PASSWORD_HASH') || '');
  if (!hashAtteso) {
    return {
      ok: false,
      code: 'DASHBOARD_NOT_CONFIGURED',
      error: 'Dashboard non configurata. Imposta la password nelle Proprietà script.'
    };
  }

  const cache = CacheService.getScriptCache();
  const chiaveTentativi = 'dashboard_login_attempts_' + hashPasswordDashboard_(password).slice(0, 16);
  const tentativi = Number(cache.get(chiaveTentativi) || '0');
  if (tentativi >= 10) {
    return {
      ok: false,
      code: 'DASHBOARD_RATE_LIMITED',
      error: 'Troppi tentativi. Attendi alcuni minuti prima di riprovare.'
    };
  }

  const hashRicevuto = hashPasswordDashboard_(password);
  if (!password || !confrontoCostanteDashboard_(hashRicevuto, hashAtteso)) {
    cache.put(chiaveTentativi, String(tentativi + 1), 600);
    return {
      ok: false,
      code: 'DASHBOARD_UNAUTHORIZED',
      error: 'Password dashboard non valida.'
    };
  }

  cache.remove(chiaveTentativi);
  const sessione = creaTokenDashboard_();
  return {
    ok: true,
    dashboardToken: sessione.token,
    expiresAt: sessione.scadenza,
    versioneBackend: CODICE_BACKEND_VERSIONE
  };
}

function dataIsoDashboard_(valore) {
  if (!valore) return '';
  const d = valore instanceof Date ? valore : new Date(valore);
  return isNaN(d.getTime()) ? String(valore) : d.toISOString();
}

function normalizzaNomeListaDashboard_(valore) {
  return String(valore || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isListaFdiDashboard_(nomeLista) {
  const normalizzato = normalizzaNomeListaDashboard_(nomeLista);
  if (!normalizzato) return false;

  const configurate = String(
    PropertiesService.getScriptProperties().getProperty('DASHBOARD_FDI_LIST_NAMES') || ''
  )
    .split(',')
    .map(normalizzaNomeListaDashboard_)
    .filter(Boolean);

  const nomiAmmessi = configurate.length ? configurate : [
    'fratelli d italia',
    'fratelli d italia con giorgia meloni',
    'fdi'
  ];

  return nomiAmmessi.some(function (nome) {
    return normalizzato === nome ||
      normalizzato.indexOf(nome + ' ') === 0 ||
      normalizzato.indexOf(' ' + nome + ' ') !== -1 ||
      normalizzato.slice(-nome.length - 1) === ' ' + nome;
  });
}

function normalizzaLivelloDashboard_(livello) {
  const valore = normalizzaNomeListaDashboard_(livello);
  if (valore.indexOf('municip') !== -1) return 'Municipio';
  if (valore.indexOf('comun') !== -1 || valore.indexOf('capitol') !== -1) return 'Comune';
  return String(livello || '').trim() || 'Altro';
}

function percentualeDashboard_(parte, totale) {
  const p = Number(parte || 0);
  const t = Number(totale || 0);
  return t > 0 ? Math.round(p / t * 1000) / 10 : '';
}

function leggiDashboardAffluenzaWeb_(dashboardToken) {
  const accesso = validaTokenDashboard_(dashboardToken);
  if (!accesso.ok) return accesso;

  const cache = CacheService.getScriptCache();
  const cacheKey = 'dashboard_web_affluenza_1342_fdi';
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const ss = getDatabaseSpreadsheet_();
  const shAff = ss.getSheetByName(FOGLI.AFFLUENZA);
  const shRap = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  const shScr = ss.getSheetByName(FOGLI.SCRUTINIO);
  const shListe = ss.getSheetByName(FOGLI.VOTI_LISTE);
  const sezioniAttese = {};

  if (shRap && shRap.getLastRow() >= 2) {
    const righeRap = shRap.getDataRange().getValues();
    const idxRap = mappaIntestazioni(righeRap[0]);
    for (let i = 1; i < righeRap.length; i++) {
      const r = righeRap[i];
      const attivo = valoreColonna(r, idxRap, ['Attivo']);
      const isAttivo = attivo === true ||
        ['TRUE', 'VERO', '1'].indexOf(String(attivo).trim().toUpperCase()) !== -1;
      if (!isAttivo) continue;

      const municipio = normalizzaMunicipioStorico_(
        valoreColonna(r, idxRap, ['Municipio'])
      );
      const sezione = String(
        valoreColonna(r, idxRap, ['Sezione']) || ''
      ).trim();
      if (!municipio || !sezione) continue;

      const key = chiaveSezioneStorico_(municipio, sezione);
      sezioniAttese[key] = {
        municipio: municipio,
        municipioNome: NOMI_MUNICIPI[municipio] || ('Municipio ' + municipio),
        sezione: sezione
      };
    }
  }

  // ------------------------- AFFLUENZA -------------------------------------
  const records = [];
  if (shAff && shAff.getLastRow() >= 2) {
    const valori = shAff.getDataRange().getValues();
    const idx = mappaIntestazioni(valori[0]);
    const sostituiti = {};

    for (let i = 1; i < valori.length; i++) {
      const correzioneDi = String(
        valoreColonna(valori[i], idx, ['Correzione di']) || ''
      ).trim();
      if (correzioneDi) sostituiti[correzioneDi] = true;
    }

    for (let i = 1; i < valori.length; i++) {
      const r = valori[i];
      const idInvio = String(
        valoreColonna(r, idx, ['ID Invio']) || ''
      ).trim();
      if (!idInvio || sostituiti[idInvio]) continue;

      const municipio = normalizzaMunicipioStorico_(
        valoreColonna(r, idx, ['Municipio'])
      );
      const sezione = String(
        valoreColonna(r, idx, ['Sezione']) || ''
      ).trim();
      const elettori = numOrVuoto(valoreColonna(r, idx, ['Elettori']));
      const maschi = numOrVuoto(valoreColonna(r, idx, ['Maschi']));
      const femmine = numOrVuoto(valoreColonna(r, idx, ['Femmine']));
      const totale = numOrVuoto(valoreColonna(r, idx, ['Totale']));

      records.push({
        idInvio: idInvio,
        timestamp: dataIsoDashboard_(
          valoreColonna(r, idx, ['Timestamp'])
        ),
        municipio: municipio,
        municipioNome: NOMI_MUNICIPI[municipio] || ('Municipio ' + municipio),
        sezione: sezione,
        giorno: String(valoreColonna(r, idx, ['Giorno']) || ''),
        orario: String(valoreColonna(r, idx, ['Orario']) || ''),
        elettori: elettori,
        maschi: maschi,
        femmine: femmine,
        totale: totale,
        percentuale: percentualeStoricoAffluenza_(
          valoreColonna(r, idx, ['% Affluenza']),
          totale,
          elettori
        ),
        rappresentante: String(
          valoreColonna(r, idx, ['Nome e Cognome']) || ''
        ),
        correzione: !!String(
          valoreColonna(r, idx, ['Correzione di']) || ''
        ).trim()
      });
    }
  }

  records.sort(function (a, b) {
    return String(a.timestamp) < String(b.timestamp) ? 1 : -1;
  });

  const latestBySection = {};
  records.forEach(function (r) {
    const key = chiaveSezioneStorico_(r.municipio, r.sezione);
    if (!latestBySection[key]) latestBySection[key] = r;
  });

  const sezioni = Object.keys(latestBySection).map(function (key) {
    return latestBySection[key];
  });
  const mancanti = Object.keys(sezioniAttese)
    .filter(function (key) { return !latestBySection[key]; })
    .map(function (key) { return sezioniAttese[key]; });

  const perMunicipioMap = {};
  sezioni.forEach(function (r) {
    const m = perMunicipioMap[r.municipio] || {
      municipio: r.municipio,
      municipioNome: r.municipioNome,
      sezioniRicevute: 0,
      elettori: 0,
      maschi: 0,
      femmine: 0,
      totale: 0
    };
    m.sezioniRicevute++;
    m.elettori += Number(r.elettori || 0);
    m.maschi += Number(r.maschi || 0);
    m.femmine += Number(r.femmine || 0);
    m.totale += Number(r.totale || 0);
    perMunicipioMap[r.municipio] = m;
  });

  Object.keys(sezioniAttese).forEach(function (key) {
    const s = sezioniAttese[key];
    const m = perMunicipioMap[s.municipio] || {
      municipio: s.municipio,
      municipioNome: s.municipioNome,
      sezioniRicevute: 0,
      elettori: 0,
      maschi: 0,
      femmine: 0,
      totale: 0
    };
    m.sezioniAttese = (m.sezioniAttese || 0) + 1;
    perMunicipioMap[s.municipio] = m;
  });

  const perMunicipio = Object.keys(perMunicipioMap).sort().map(function (key) {
    const m = perMunicipioMap[key];
    m.sezioniAttese = m.sezioniAttese || 0;
    m.sezioniMancanti = Math.max(0, m.sezioniAttese - m.sezioniRicevute);
    m.percentuale = percentualeDashboard_(m.totale, m.elettori);
    return m;
  });

  const totali = sezioni.reduce(function (a, r) {
    a.elettori += Number(r.elettori || 0);
    a.maschi += Number(r.maschi || 0);
    a.femmine += Number(r.femmine || 0);
    a.totale += Number(r.totale || 0);
    return a;
  }, { elettori: 0, maschi: 0, femmine: 0, totale: 0 });
  totali.percentuale = percentualeDashboard_(totali.totale, totali.elettori);

  // ------------------------- SCRUTINIO E LISTE -----------------------------
  const scrutini = [];
  const scrutinioPerId = {};
  const ultimoScrutinioPerSezione = {};

  if (shScr && shScr.getLastRow() >= 2) {
    const valoriScr = shScr.getDataRange().getValues();
    const idxScr = mappaIntestazioni(valoriScr[0]);
    const sostituitiScr = {};

    for (let i = 1; i < valoriScr.length; i++) {
      const correzioneDi = String(
        valoreColonna(valoriScr[i], idxScr, ['Correzione di']) || ''
      ).trim();
      if (correzioneDi) sostituitiScr[correzioneDi] = true;
    }

    for (let i = 1; i < valoriScr.length; i++) {
      const r = valoriScr[i];
      const idInvio = String(valoreColonna(r, idxScr, ['ID Invio']) || '').trim();
      if (!idInvio || sostituitiScr[idInvio]) continue;

      const municipio = normalizzaMunicipioStorico_(
        valoreColonna(r, idxScr, ['Municipio'])
      );
      const sezione = String(valoreColonna(r, idxScr, ['Sezione']) || '').trim();
      if (!municipio || !sezione) continue;

      const record = {
        idInvio: idInvio,
        timestamp: dataIsoDashboard_(valoreColonna(r, idxScr, ['Timestamp'])),
        municipio: municipio,
        municipioNome: NOMI_MUNICIPI[municipio] || ('Municipio ' + municipio),
        sezione: sezione,
        elettori: Number(valoreColonna(r, idxScr, ['Elettori']) || 0),
        votanti: Number(valoreColonna(r, idxScr, ['Votanti']) || 0),
        valideComune: Number(valoreColonna(r, idxScr, ['Comune - Valide']) || 0),
        valideMunicipio: Number(valoreColonna(r, idxScr, ['Municipio - Valide']) || 0)
      };
      scrutini.push(record);
      scrutinioPerId[idInvio] = record;
    }

    scrutini.sort(function (a, b) {
      return String(a.timestamp) < String(b.timestamp) ? 1 : -1;
    });
    scrutini.forEach(function (r) {
      const key = chiaveSezioneStorico_(r.municipio, r.sezione);
      if (!ultimoScrutinioPerSezione[key]) ultimoScrutinioPerSezione[key] = r;
    });
  }

  const listePerInvioLivello = {};
  if (shListe && shListe.getLastRow() >= 2) {
    const valoriListe = shListe.getDataRange().getValues();
    const idxListe = mappaIntestazioni(valoriListe[0]);

    for (let i = 1; i < valoriListe.length; i++) {
      const r = valoriListe[i];
      const idInvio = String(valoreColonna(r, idxListe, ['ID Invio']) || '').trim();
      if (!idInvio || !scrutinioPerId[idInvio]) continue;

      const livello = normalizzaLivelloDashboard_(
        valoreColonna(r, idxListe, ['Livello'])
      );
      const nome = String(valoreColonna(r, idxListe, ['Lista']) || '').trim();
      const voti = Number(valoreColonna(r, idxListe, ['Voti']) || 0);
      if (!nome) continue;

      const key = idInvio + '|' + livello;
      if (!listePerInvioLivello[key]) listePerInvioLivello[key] = [];
      listePerInvioLivello[key].push({
        nome: nome,
        voti: voti,
        isFdi: isListaFdiDashboard_(nome)
      });
    }
  }

  const risultatiListe = [];
  Object.keys(ultimoScrutinioPerSezione).forEach(function (sectionKey) {
    const scr = ultimoScrutinioPerSezione[sectionKey];

    ['Comune', 'Municipio'].forEach(function (livello) {
      const liste = (listePerInvioLivello[scr.idInvio + '|' + livello] || [])
        .slice()
        .sort(function (a, b) { return b.voti - a.voti; });

      if (!liste.length) return;

      const fdiVoti = liste.reduce(function (somma, lista) {
        return somma + (lista.isFdi ? Number(lista.voti || 0) : 0);
      }, 0);
      const totaleListe = liste.reduce(function (somma, lista) {
        return somma + Number(lista.voti || 0);
      }, 0);
      const validiDichiarati = livello === 'Comune'
        ? Number(scr.valideComune || 0)
        : Number(scr.valideMunicipio || 0);
      const votiValidi = validiDichiarati > 0 ? validiDichiarati : totaleListe;
      const altriVoti = Math.max(0, totaleListe - fdiVoti);
      const posizioneFdi = fdiVoti > 0
        ? 1 + liste.filter(function (l) { return !l.isFdi && l.voti > fdiVoti; }).length
        : '';
      const primoAltro = liste.filter(function (l) { return !l.isFdi; })[0] || null;

      risultatiListe.push({
        idInvio: scr.idInvio,
        timestamp: scr.timestamp,
        municipio: scr.municipio,
        municipioNome: scr.municipioNome,
        sezione: scr.sezione,
        livello: livello,
        elettori: scr.elettori,
        votanti: scr.votanti,
        votiValidi: votiValidi,
        totaleVotiListe: totaleListe,
        fdiVoti: fdiVoti,
        altriVoti: altriVoti,
        fdiSuValidi: percentualeDashboard_(fdiVoti, votiValidi),
        fdiSuVotanti: percentualeDashboard_(fdiVoti, scr.votanti),
        fdiSuIscritti: percentualeDashboard_(fdiVoti, scr.elettori),
        posizioneFdi: posizioneFdi,
        primoPartito: liste[0] ? liste[0].nome : '',
        primoPartitoVoti: liste[0] ? liste[0].voti : 0,
        primoAltroPartito: primoAltro ? primoAltro.nome : '',
        primoAltroVoti: primoAltro ? primoAltro.voti : 0,
        distaccoPrimoAltro: primoAltro ? fdiVoti - primoAltro.voti : fdiVoti,
        liste: liste.map(function (l) {
          return {
            nome: l.nome,
            voti: l.voti,
            percentuale: percentualeDashboard_(l.voti, votiValidi),
            isFdi: l.isFdi
          };
        })
      });
    });
  });

  risultatiListe.sort(function (a, b) {
    if (a.municipio !== b.municipio) return String(a.municipio).localeCompare(String(b.municipio));
    const sezA = Number(a.sezione);
    const sezB = Number(b.sezione);
    if (!isNaN(sezA) && !isNaN(sezB) && sezA !== sezB) return sezA - sezB;
    if (a.sezione !== b.sezione) return String(a.sezione).localeCompare(String(b.sezione));
    return a.livello.localeCompare(b.livello);
  });

  const riepilogoFdi = {};
  risultatiListe.forEach(function (r) {
    const key = r.livello;
    const agg = riepilogoFdi[key] || {
      livello: r.livello,
      sezioniScrutinate: 0,
      elettori: 0,
      votanti: 0,
      votiValidi: 0,
      fdiVoti: 0,
      altriVoti: 0,
      sezioniPrimoPartito: 0
    };
    agg.sezioniScrutinate++;
    agg.elettori += Number(r.elettori || 0);
    agg.votanti += Number(r.votanti || 0);
    agg.votiValidi += Number(r.votiValidi || 0);
    agg.fdiVoti += Number(r.fdiVoti || 0);
    agg.altriVoti += Number(r.altriVoti || 0);
    if (r.posizioneFdi === 1) agg.sezioniPrimoPartito++;
    riepilogoFdi[key] = agg;
  });

  Object.keys(riepilogoFdi).forEach(function (key) {
    const agg = riepilogoFdi[key];
    agg.fdiSuValidi = percentualeDashboard_(agg.fdiVoti, agg.votiValidi);
    agg.fdiSuVotanti = percentualeDashboard_(agg.fdiVoti, agg.votanti);
    agg.fdiSuIscritti = percentualeDashboard_(agg.fdiVoti, agg.elettori);
  });

  const risposta = {
    ok: true,
    serverTime: new Date().toISOString(),
    versioneBackend: CODICE_BACKEND_VERSIONE,
    sessionExpiresAt: new Date(accesso.exp).toISOString(),
    totali: totali,
    sezioniAttese: Object.keys(sezioniAttese).length,
    sezioniRicevute: sezioni.length,
    sezioniMancanti: mancanti.length,
    perMunicipio: perMunicipio,
    sezioni: sezioni,
    mancanti: mancanti,
    ultimiInvii: records.slice(0, 100),
    risultatiListe: risultatiListe,
    riepilogoFdi: riepilogoFdi,
    configurazioneFdi: {
      proprietaPersonalizzazione: 'DASHBOARD_FDI_LIST_NAMES',
      livelli: ['Comune', 'Municipio']
    }
  };

  try {
    cache.put(cacheKey, JSON.stringify(risposta), 15);
  } catch (e) {}

  return risposta;
}

