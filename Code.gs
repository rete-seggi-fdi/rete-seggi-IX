/**
 * RETE SEGGI FdI — Backend (Google Apps Script)
 * ------------------------------------------------------------------
 * Questo script trasforma un Google Sheet in un piccolo "server":
 *  - i rappresentanti di lista inviano affluenza e scrutinio dall'app
 *  - lo script salva tutto in fogli separati, leggibili da chiunque
 *    abbia accesso al foglio (il coordinamento centrale)
 *  - la configurazione (municipi attivi, liste, candidati, orari e contatti)
 *    si modifica semplicemente editando le celle dei fogli di configurazione:
 *    NON serve toccare questo codice per cambiarla.
 *
 * PRIMO UTILIZZO: apri questo progetto, scegli la funzione
 * "inizializza" dal menu a tendina in alto e premi "Esegui".
 * Crea automaticamente tutti i fogli necessari con le intestazioni.
 * I dati elettorali e le anagrafiche reali vanno poi compilati dal coordinamento.
 * ------------------------------------------------------------------
 */

const CODICE_BACKEND_VERSIONE = '14.0.0-security-production';
const APP_ENVIRONMENT = 'production';
const TIMEOUT_LOCK_INVII_MS = 90000;
const MAX_POST_BODY_BYTES = 220 * 1024;
const MAX_ID_INVIO_LENGTH = 96;
const MAX_CONTEGGIO_SEZIONE = 1000000;
const CONFIG_CACHE_SECONDS = 120;
const ACCESS_CODE_DELIVERY_SHEET = 'Codici Accesso - CONSEGNA';
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
  IMPOSTAZIONI: 'Impostazioni App',
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

function testoSicuroFoglio_(valore, massimo) {
  let testo = String(valore === undefined || valore === null ? '' : valore)
    .replace(/\u0000/g, '');
  if (Number(massimo) > 0 && testo.length > Number(massimo)) {
    testo = testo.slice(0, Number(massimo));
  }
  // Google Sheets interpreta come formule i valori che iniziano con =, +, - o @.
  // U+200B rende il contenuto testo senza alterarne visivamente il significato.
  if (/^[\u0001-\u0020]*[=+\-@]/.test(testo)) testo = '\u200B' + testo;
  return testo;
}

function idInvioValido_(valore) {
  const id = String(valore || '').trim();
  if (!id || id.length > MAX_ID_INVIO_LENGTH) return false;
  // Il simulatore è isolato su un altro Spreadsheet: nessun endpoint pubblico
  // deve poter creare o correggere record con namespace SIM-.
  if (/^SIM-/i.test(id)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{7,95}$/.test(id);
}

function errorePubblicoInterno_(contesto, err) {
  const requestId = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  logError(contesto + ' [' + requestId + ']', err);
  return {
    ok: false,
    code: 'INTERNAL_ERROR',
    error: 'Errore interno temporaneo. Riprova tra poco.',
    requestId: requestId
  };
}

function contaRateLimitCache_(chiave) {
  const cache = CacheService.getScriptCache();
  return Number(cache.get(String(chiave)) || '0');
}

function incrementaRateLimitCache_(chiave, ttlSecondi) {
  const cache = CacheService.getScriptCache();
  const key = String(chiave);
  const prossimo = contaRateLimitCache_(key) + 1;
  cache.put(key, String(prossimo), Number(ttlSecondi) || 600);
  return prossimo;
}

function controlloRateLimitLogin_(chiaveCredenziale) {
  const perCredenziale = contaRateLimitCache_('login_cred_' + chiaveCredenziale);
  const globale = contaRateLimitCache_('login_global_fail_v1400');
  if (perCredenziale >= 8 || globale >= 200) {
    return {
      ok: false,
      code: 'RATE_LIMITED',
      error: 'Troppi tentativi di accesso. Attendi alcuni minuti e riprova.'
    };
  }
  return { ok: true, perCredenziale: perCredenziale, globale: globale };
}

function registraLoginFallito_(chiaveCredenziale) {
  const n = incrementaRateLimitCache_('login_cred_' + chiaveCredenziale, 600);
  incrementaRateLimitCache_('login_global_fail_v1400', 600);
  Utilities.sleep(Math.min(1000, 250 + n * 100));
}

function resetLoginCredenziale_(chiaveCredenziale) {
  CacheService.getScriptCache().remove('login_cred_' + chiaveCredenziale);
}

function codiceAccessoCasualeSicuro_() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const materiale = [
    Utilities.getUuid(), Utilities.getUuid(), Utilities.getUuid(),
    String(Date.now()), String(Math.random())
  ].join('|');
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    materiale,
    Utilities.Charset.UTF_8
  );
  let out = 'SL';
  for (let i = 0; i < 18; i++) {
    const b = bytes[i] < 0 ? bytes[i] + 256 : bytes[i];
    out += alphabet.charAt(b % alphabet.length);
  }
  return out;
}

function codiceAccessoFormatoSicuro_(codice) {
  return /^SL[A-HJ-NP-Z2-9]{18}$/.test(String(codice || '').trim().toUpperCase());
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
    const action = String(parametri.action || parametri.azione || '').trim().toLowerCase();

    if (action === 'config') return jsonOutput(buildConfig());
    if (action === 'ping') {
      return jsonOutput({
        ok: true,
        time: new Date().toISOString(),
        versioneBackend: CODICE_BACKEND_VERSIONE,
        ambiente: APP_ENVIRONMENT,
        municipioPilota: MUNICIPIO_ABILITATO
      });
    }
    if (action === 'health') {
      return jsonOutput({
        ok: true,
        time: new Date().toISOString(),
        versioneBackend: CODICE_BACKEND_VERSIONE,
        versioneMinima: PropertiesService.getScriptProperties().getProperty('VERSIONE_MINIMA') || '14.0.0'
      });
    }
    return jsonOutput({ ok: false, code: 'UNKNOWN_ACTION', error: 'Azione non riconosciuta.' });
  } catch (err) {
    return jsonOutput(errorePubblicoInterno_('doGet', err));
  }
}

function doPost(e) {
  const contenuto = e && e.postData ? String(e.postData.contents || '') : '';
  if (!contenuto) {
    return jsonOutput({ ok: false, code: 'EMPTY_REQUEST', error: 'Richiesta vuota.' });
  }

  const byteLength = Utilities.newBlob(contenuto).getBytes().length;
  if (byteLength > MAX_POST_BODY_BYTES) {
    return jsonOutput({ ok: false, code: 'PAYLOAD_TOO_LARGE', error: 'Richiesta troppo grande.' });
  }

  let body;
  try {
    body = JSON.parse(contenuto);
  } catch (parseErr) {
    // Gli errori di JSON provenienti dalla rete sono attesi e non vanno
    // registrati nel foglio Log Errori, evitando log flooding.
    return jsonOutput({ ok: false, code: 'INVALID_JSON', error: 'Formato richiesta non valido.' });
  }

  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonOutput({ ok: false, code: 'INVALID_REQUEST', error: 'Formato richiesta non valido.' });
    }
    if ((body.payload || body.data) && !body.tipo) {
      const nested = provaJson(body.payload || body.data);
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) body = nested;
    }
    return jsonOutput(gestisciInvio(body));
  } catch (err) {
    return jsonOutput(errorePubblicoInterno_('doPost', err));
  }
}

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
function getTokenSecret_() {
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
  const firma = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getTokenSecret_()));
  return { token: payloadB64 + '.' + firma, scadenza: new Date(scadenza).toISOString() };
}

function validaToken(token) {
  if (!token || String(token).indexOf('.') === -1) return { ok: false, error: 'Sessione mancante: effettua nuovamente l\'accesso.' };
  const parti = String(token).split('.');
  if (parti.length !== 2) return { ok: false, error: 'Sessione non valida: effettua nuovamente l\'accesso.' };
  const payloadB64 = parti[0], firma = parti[1];
  const firmaAttesa = Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(payloadB64, getTokenSecret_()));
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
function identitaSessioneAttiva_(codiceIdentita) {
  const codice = String(codiceIdentita || '').trim();
  if (!codice) return false;

  const sh = getDatabaseSpreadsheet_().getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!sh || sh.getLastRow() < 2) return false;

  const valori = sh.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);

  // Una stessa identità può essere associata a più sezioni. La sessione resta
  // valida finché esiste almeno una assegnazione attiva per quell'identità.
  for (let i = 1; i < valori.length; i++) {
    const r = valori[i];
    if (identitaCodiceRiga_(r, idx) !== codice) continue;
    const attivo = valoreColonna(r, idx, ['Attivo']);
    const attivoNorm = String(attivo).trim().toUpperCase();
    if (attivo === true ||
        attivoNorm === 'TRUE' ||
        attivoNorm === 'VERO' ||
        attivoNorm === '1') {
      return true;
    }
  }
  return false;
}

/** Da usare in cima a ogni azione che richiede un accesso già effettuato. */
function verificaCoerenzaStatoRappresentanti1375() {
  const sh = getDatabaseSpreadsheet_().getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!sh || sh.getLastRow() < 2) {
    return { ok: false, error: 'Foglio Rappresentanti vuoto o mancante.' };
  }

  const valori = sh.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);
  const conteggi = { trueBoolean: 0, trueTesto: 0, veroTesto: 0, uno: 0, altri: 0 };

  for (let i = 1; i < valori.length; i++) {
    const v = valoreColonna(valori[i], idx, ['Attivo']);
    const n = String(v).trim().toUpperCase();
    if (v === true) conteggi.trueBoolean++;
    else if (n === 'TRUE') conteggi.trueTesto++;
    else if (n === 'VERO') conteggi.veroTesto++;
    else if (n === '1') conteggi.uno++;
    else if (n) conteggi.altri++;
  }

  return {
    ok: true,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    formatiAttivo: conteggi
  };
}

function richiedeSessione(sessionToken) {
  const esito = validaToken(sessionToken);
  if (!esito.ok) return { ok: false, error: esito.error, code: 'SESSION_INVALID' };

  // Revoca immediata: un rappresentante disattivato, eliminato o ruotato
  // non può continuare a usare un token emesso in precedenza, nemmeno per
  // storico e messaggi.
  if (!identitaSessioneAttiva_(esito.codice)) {
    return {
      ok: false,
      code: 'SESSION_REVOKED',
      error: 'Sessione non più autorizzata. Effettua nuovamente l’accesso.'
    };
  }
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

  // Rate limit combinato: per credenziale + globale. In Apps Script non è
  // disponibile in modo affidabile l'IP del client, quindi il limite globale
  // impedisce di aggirare il controllo cambiando codice ad ogni richiesta.
  const chiaveCredenziale = hashCodiceAccesso_(codice).slice(0, 24);
  const limiteAccesso = controlloRateLimitLogin_(chiaveCredenziale);
  if (!limiteAccesso.ok) return limiteAccesso;

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
    registraLoginFallito_(chiaveCredenziale);
    return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Codice o telefono non validi.' };
  }

  if (!nome && !sezioni.length) {
    registraLoginFallito_(chiaveCredenziale);
    // Risposta uniforme: non rivela se il codice esiste, è disattivato o ha
    // un telefono differente.
    return { ok: false, code: 'INVALID_CREDENTIALS', error: 'Codice o telefono non validi.' };
  }

  resetLoginCredenziale_(chiaveCredenziale);
  const sessione = creaToken(codiceHash);
  const dataRevision = PropertiesService.getScriptProperties().getProperty('DATA_REVISION') || '';
  return { ok: true, nome: nome, telefono: telefonoRegistrato || telefonoNormalizzato, sezioni: sezioni, sessionToken: sessione.token, sessionExpiresAt: sessione.scadenza, dataRevision: dataRevision };
}

function buildConfig() {
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const revision = props.getProperty('CONFIG_REVISION') || props.getProperty('DATA_REVISION') || '0';
  const cacheKey = 'config_v1400_' + String(revision).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const config = buildConfigFresh_();
  try { cache.put(cacheKey, JSON.stringify(config), CONFIG_CACHE_SECONDS); } catch (e) {}
  return config;
}

/**
 * Lettura effettiva della configurazione. Il wrapper buildConfig() mantiene una
 * cache breve per ridurre le letture Google Sheets nelle ore di punta.
 * CONFIG_REVISION può essere incrementata dal coordinamento per invalidarla subito.
 */
/**
 * Impostazioni che possono essere esposte pubblicamente alla PWA.
 * NON aggiungere qui password, token, chiavi API o altri segreti.
 */
const CHIAVI_IMPOSTAZIONI_PUBBLICHE = [
  'DATA_DOMENICA', 'DATA_LUNEDI', 'SOGLIA_RITARDO_MINUTI', 'ORARIO_SCRUTINIO',
  'TELEFONO_ASSISTENZA', 'WHATSAPP_ASSISTENZA', 'EMAIL_ASSISTENZA',
  'MESSAGGIO_ASSISTENZA', 'INTERVALLO_MESSAGGI_SECONDI',
  'MODALITA_DEMO', 'DEMO_BANNER'
];

function leggiImpostazioniPubbliche_(ss) {
  const risultato = {};
  const ammesse = {};
  CHIAVI_IMPOSTAZIONI_PUBBLICHE.forEach(function(chiave) {
    risultato[chiave] = '';
    ammesse[chiave] = true;
  });
  const sh = ss.getSheetByName(FOGLI.IMPOSTAZIONI);
  if (!sh || sh.getLastRow() < 2) return risultato;
  const valori = sh.getDataRange().getDisplayValues();
  for (let i = 1; i < valori.length; i++) {
    const chiave = String(valori[i][0] || '').trim().toUpperCase();
    if (!chiave || !ammesse[chiave]) continue;
    risultato[chiave] = String(valori[i][1] || '').trim();
  }
  return risultato;
}

function buildConfigFresh_() {
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

  const impostazioni = leggiImpostazioniPubbliche_(ss);
  const props = PropertiesService.getScriptProperties();
  const app = {
    versioneMinima: props.getProperty('VERSIONE_MINIMA') || '14.0.0',
    aggiornamentoObbligatorio: props.getProperty('AGGIORNAMENTO_OBBLIGATORIO') === 'true',
    backendVersion: CODICE_BACKEND_VERSIONE,
    modalitaDemo: String(impostazioni.MODALITA_DEMO || '').trim().toLowerCase() === 'true',
    demoBanner: String(impostazioni.DEMO_BANNER || '').trim(),
  };
  const dataRevision = props.getProperty('DATA_REVISION') || '';

  return { ok: true, municipi, liste, candidati, sindaci, presidenti, orari, impostazioni, app, dataRevision, generatoIl: new Date().toISOString() };
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
          valide: numOrVuoto(valoreColonna(r, idx, ['Comune - Valide', 'Comune valide'])),
          bianche: numOrVuoto(valoreColonna(r, idx, ['Comune - Bianche', 'Comune bianche'])),
          nulle: numOrVuoto(valoreColonna(r, idx, ['Comune - Nulle', 'Comune nulle'])),
          contestate: numOrVuoto(valoreColonna(r, idx, ['Comune - Contestate', 'Comune contestate']))
        } : {},
        schedaMunicipio: tipo === 'scrutinio' ? {
          valide: numOrVuoto(valoreColonna(r, idx, ['Municipio - Valide', 'Municipio valide'])),
          bianche: numOrVuoto(valoreColonna(r, idx, ['Municipio - Bianche', 'Municipio bianche'])),
          nulle: numOrVuoto(valoreColonna(r, idx, ['Municipio - Nulle', 'Municipio nulle'])),
          contestate: numOrVuoto(valoreColonna(r, idx, ['Municipio - Contestate', 'Municipio contestate']))
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
  const cacheKey = 'storico_invii_1400_scrutinio_completo_' + codice + '_' + limite;
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
  // Giorno/orario sono dati provenienti dal client. Li neutralizziamo già in
  // normalizzazione, così la stessa rappresentazione sicura viene usata sia
  // nei confronti anti-duplicato sia nella scrittura su Google Sheets.
  dati.giorno = testoSicuroFoglio_(
    String(primoValorePresente_(body, ['giorno', 'day']) || '').trim(),
    40
  );
  dati.orario = testoSicuroFoglio_(
    String(primoValorePresente_(body, ['orario', 'ora', 'fasciaOraria', 'time']) || '').trim(),
    20
  );

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
  // In produzione municipio e sezione devono sempre essere espliciti: un'identità
  // può presidiare più sezioni e non deve mai essere attribuita alla prima riga per errore.
  if (!municipioTarget || !sezioneTarget) return risultato;

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

  if (body.idInvio && !idInvioValido_(body.idInvio)) {
    return { ok: false, code: 'INVALID_ID', error: 'ID invio non valido.' };
  }
  if (body.correzioneDi && !idInvioValido_(body.correzioneDi)) {
    return { ok: false, code: 'INVALID_ID', error: 'ID correzione non valido.' };
  }

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
    lock.waitLock(TIMEOUT_LOCK_INVII_MS);
  } catch (e) {
    return { ok: false, error: 'Il coordinamento sta ricevendo molti invii in questo momento. Riprova tra pochi secondi.', code: 'BUSY' };
  }

  try {
    SpreadsheetApp.flush();
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
    const totaleValidato = interoNonNegativo_(body.totale, true);
    if (totaleValidato === null || (elettori !== '' && totaleValidato > Number(elettori))) {
      return { ok: false, code: 'INVALID_DATA', error: 'I votanti non possono superare gli elettori aventi diritto.' };
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
      body.municipio || '', body.sezione || '', body.telefono || '',
      testoSicuroFoglio_(body.giorno, 40), testoSicuroFoglio_(body.orario, 20),
      elettori, maschi, femmine, totale, percDecimale, testoSicuroFoglio_(body.note, 500),
      body.correzioneDi || '', testoSicuroFoglio_(body.motivoCorrezione, 300), testoSicuroFoglio_(body.versioneApp, 80),
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

  if (body.idInvio && !idInvioValido_(body.idInvio)) {
    return { ok: false, code: 'INVALID_ID', error: 'ID invio non valido.' };
  }
  if (body.correzioneDi && !idInvioValido_(body.correzioneDi)) {
    return { ok: false, code: 'INVALID_ID', error: 'ID correzione non valido.' };
  }

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
    lock.waitLock(TIMEOUT_LOCK_INVII_MS);
  } catch (e) {
    return { ok: false, error: 'Il coordinamento sta ricevendo molti invii in questo momento. Riprova tra pochi secondi.', code: 'BUSY' };
  }

  let idInvio;
  try {
    SpreadsheetApp.flush();
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
      testoSicuroFoglio_(body.note, 1000),
      body.correzioneDi || '', testoSicuroFoglio_(body.motivoCorrezione, 300), testoSicuroFoglio_(body.versioneApp, 80),
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
  if (!sheet || !idInvio || sheet.getLastRow() < 2) return 0;

  // Prima veniva letto tutto il foglio con getDataRange(): sui quattro fogli
  // di dettaglio dello scrutinio questo poteva pesare molto e contribuire ai
  // timeout. Leggiamo solo l'intestazione e cerchiamo l'ID nella sua colonna.
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const idx = mappaIntestazioni(headers);
  const colId = idx['id invio'];
  if (colId === undefined) return 0;

  const ultimaRiga = sheet.getLastRow();
  const matches = sheet.getRange(2, colId + 1, ultimaRiga - 1, 1)
    .createTextFinder(String(idInvio))
    .matchEntireCell(true)
    .findAll();

  const righe = matches.map(function(range) { return range.getRow(); })
    .sort(function(a, b) { return b - a; });
  righe.forEach(function(riga) { sheet.deleteRow(riga); });
  return righe.length;
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
        testoSicuroFoglio_(l.nome, 160),
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
        testoSicuroFoglio_(p.candidato, 160),
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
        testoSicuroFoglio_(s.nome, 160),
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
        testoSicuroFoglio_(p.nome, 160),
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
  if (valore === '' || valore === null || valore === undefined || (typeof valore === 'string' && !valore.trim())) return obbligatorio ? null : '';
  const n = Number(valore);
  return Number.isSafeInteger(n) && n >= 0 && n <= MAX_CONTEGGIO_SEZIONE ? n : null;
}

function testoLimitato_(valore, massimo) {
  return String(valore || '').trim().length <= massimo;
}

function validaVociNumeriche_(voci, campoNome, campoVoti, etichetta) {
  if (!Array.isArray(voci)) return etichetta + ': formato non valido.';
  if (voci.length > 200) return etichetta + ': troppe voci nella richiesta.';
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
  if ((maschi === '') !== (femmine === '')) {
    return 'Se usi il dettaglio per genere devi indicare sia maschi sia femmine.';
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
  if (prefComuneTot > fdiComune * 2) return 'Le preferenze Comune superano il massimo teorico di due per voto FdI.';
  if (prefMunicipioTot > fdiMunicipio * 2) return 'Le preferenze Municipio superano il massimo teorico di due per voto FdI.';
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

/**
 * Riconoscimento FORTE usato esclusivamente per audit/migrazione di vecchi
 * record creati prima dell'isolamento del simulatore. Non influenza mai
 * autorizzazioni, anti-duplicato o invii pubblici.
 */
function rigaSimulatorLegacyForteProduzione_(riga, idx) {
  const idInvio = String(valoreColonna(riga, idx, ['ID Invio', 'ID']) || '').trim();
  const codice = String(valoreColonna(riga, idx, ['Codice']) || '').trim();
  const note = String(valoreColonna(riga, idx, ['Note', 'Testo']) || '').trim();
  const versione = String(valoreColonna(riga, idx, ['Versione app']) || '').trim();

  if (!/^SIM-/i.test(idInvio)) return false;
  return /^SIM-REP-/i.test(codice) ||
    /^\[?ELECTION[_-]SIMULATOR/i.test(note) ||
    /^ELECTION[_-]SIMULATOR/i.test(versione);
}

function contaInviiAttivi_(sheet, body, tipo) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  const valori = sheet.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);
  let n = 0;

  // Il simulatore 3.4+ usa uno Spreadsheet isolato. Nel database ufficiale
  // OGNI riga attiva conta: nessun campo controllato dal client può escludere
  // una riga dal controllo anti-duplicato.
  for (let i = 1; i < valori.length; i++) {
    const r = valori[i];
    const stato = String(valoreColonna(r, idx, ['Stato']) || 'ATTIVO').toUpperCase();
    const sostituitoDa = String(valoreColonna(r, idx, ['Sostituito Da']) || '');
    if (stato === 'SOSTITUITO' || sostituitoDa) continue;
    if (normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio'])) !==
        normalizzaMunicipioStorico_(body.municipio)) continue;
    if (normalizzaSezione_(valoreColonna(r, idx, ['Sezione'])) !==
        normalizzaSezione_(body.sezione)) continue;

    if (tipo === 'affluenza') {
      if (String(valoreColonna(r, idx, ['Giorno']) || '').trim() !==
          String(body.giorno || '').trim()) continue;
      if (String(valoreColonna(r, idx, ['Orario']) || '').trim() !==
          String(body.orario || '').trim()) continue;
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
  const testo = testoSicuroFoglio_(rTesto.getResponseText().trim(), 1000);

  const sh = getOrCreateSheet(FOGLI.MESSAGGI, ['ID', 'Municipio', 'Sezione', 'Testo', 'Stato', 'Timestamp', 'Aggiornato Il']);
  sh.appendRow([Utilities.getUuid(), municipio, sezione, testo, 'NUOVO', new Date(), '']);

  ui.alert('✅ Messaggio salvato.\n\nComparirà nell\'app dei rappresentanti coinvolti entro pochi minuti (l\'app controlla i nuovi messaggi periodicamente).');
}

function gia_inviato(sheet, idInvio) {
  if (!sheet || !idInvio) return false;
  const ultimaRiga = sheet.getLastRow();
  if (ultimaRiga < 2) return false;
  // Cerca l'ID direttamente nella colonna B lato Sheets senza trasferire
  // l'intera colonna allo script: riduce latenza e memoria sui fogli grandi.
  const match = sheet.getRange(2, 2, ultimaRiga - 1, 1)
    .createTextFinder(String(idInvio))
    .matchEntireCell(true)
    .findNext();
  return !!match;
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
 * Rotazione definitiva dei codici di accesso.
 * Genera un nuovo codice casuale per ogni identità attuale, conserva soltanto
 * l'HMAC nel foglio Rappresentanti e crea un foglio temporaneo di consegna.
 * Dopo avere distribuito i codici eseguire eliminaFoglioConsegnaCodici().
 */
function rigeneraTuttiCodiciAccessoSicuri() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const ss = getDatabaseSpreadsheet_();
    const esistente = ss.getSheetByName(ACCESS_CODE_DELIVERY_SHEET);
    if (esistente && esistente.getLastRow() > 1) {
      throw new Error(
        'Esiste già il foglio "' + ACCESS_CODE_DELIVERY_SHEET +
        '". Distribuisci/elimina quello prima di effettuare una nuova rotazione.'
      );
    }

    const sh = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
    if (!sh || sh.getLastRow() < 2) throw new Error('Foglio Rappresentanti vuoto o mancante.');

    let headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    let colHash = headers.indexOf('Codice Hash');
    if (colHash === -1) {
      sh.getRange(1, sh.getLastColumn() + 1).setValue('Codice Hash');
      headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
      colHash = headers.indexOf('Codice Hash');
    }
    const colCodice = headers.indexOf('Codice');
    if (colCodice === -1) throw new Error('Colonna Codice mancante.');

    const idx = mappaIntestazioni(headers);
    const righe = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
    const gruppi = {};

    righe.forEach(function(r, i) {
      const identita = identitaCodiceRiga_(r, idx);
      if (!identita) return;
      if (!gruppi[identita]) {
        gruppi[identita] = {
          codice: codiceAccessoCasualeSicuro_(),
          righe: [],
          nome: String(valoreColonna(r, idx, ['Nome e Cognome', 'Nome', 'Rappresentante']) || '').trim(),
          telefono: normalizzaTelefono(valoreColonna(r, idx, ['Telefono', 'Cellulare'])),
          sezioni: []
        };
      }
      gruppi[identita].righe.push(i + 2);
      const mu = normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio']));
      const se = String(valoreColonna(r, idx, ['Sezione']) || '').trim();
      if (mu && se) gruppi[identita].sezioni.push(mu + '/' + se);
    });

    const consegna = [];
    Object.keys(gruppi).forEach(function(identita) {
      const g = gruppi[identita];
      const nuovoHash = hashCodiceAccesso_(g.codice);
      g.righe.forEach(function(numeroRiga) {
        sh.getRange(numeroRiga, colHash + 1).setValue(nuovoHash);
        sh.getRange(numeroRiga, colCodice + 1).clearContent();
      });
      consegna.push([
        g.nome,
        g.telefono,
        Array.from(new Set(g.sezioni)).join(', '),
        g.codice,
        new Date()
      ]);
    });

    let delivery = esistente;
    if (!delivery) delivery = ss.insertSheet(ACCESS_CODE_DELIVERY_SHEET);
    delivery.clear();
    delivery.getRange(1, 1, 1, 5).setValues([[
      'Nome e Cognome', 'Telefono', 'Sezioni', 'NUOVO CODICE', 'Generato il'
    ]]).setFontWeight('bold');
    if (consegna.length) delivery.getRange(2, 1, consegna.length, 5).setValues(consegna);
    delivery.setFrozenRows(1);
    delivery.autoResizeColumns(1, 5);
    try {
      const protezione = delivery.protect();
      protezione.setDescription('Codici temporanei da distribuire e poi eliminare');
      protezione.setWarningOnly(true);
    } catch (e) {}

    const props = PropertiesService.getScriptProperties();
    props.setProperty('ACCESS_CODE_ROTATED_AT', new Date().toISOString());
    props.setProperty('ACCESS_CODE_ROTATION_VERSION', CODICE_BACKEND_VERSIONE);
    SpreadsheetApp.flush();

    return {
      ok: true,
      identitaRuotate: consegna.length,
      righeAggiornate: righe.length,
      foglioConsegna: ACCESS_CODE_DELIVERY_SHEET,
      nota: 'Distribuisci i nuovi codici e poi esegui eliminaFoglioConsegnaCodici(). Le sessioni precedenti non saranno più autorizzate.'
    };
  } finally {
    lock.releaseLock();
  }
}

function eliminaFoglioConsegnaCodici() {
  const ss = getDatabaseSpreadsheet_();
  const sh = ss.getSheetByName(ACCESS_CODE_DELIVERY_SHEET);
  if (!sh) return { ok: true, eliminato: false };
  ss.deleteSheet(sh);
  return { ok: true, eliminato: true };
}

function verificaSicurezzaCodiciAccesso() {
  const sh = getDatabaseSpreadsheet_().getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!sh || sh.getLastRow() < 2) {
    return { ok: false, error: 'Foglio Rappresentanti vuoto o mancante.' };
  }
  const valori = sh.getDataRange().getValues();
  const idx = mappaIntestazioni(valori[0]);
  let plaintext = 0;
  let senzaHash = 0;
  let attive = 0;

  for (let i = 1; i < valori.length; i++) {
    const r = valori[i];
    const attivoRaw = valoreColonna(r, idx, ['Attivo']);
    const attivo = attivoRaw === true ||
      ['TRUE', 'VERO', '1'].indexOf(String(attivoRaw).trim().toUpperCase()) !== -1;
    if (!attivo) continue;
    attive++;
    if (String(valoreColonna(r, idx, ['Codice']) || '').trim()) plaintext++;
    if (!String(valoreColonna(r, idx, ['Codice Hash']) || '').trim()) senzaHash++;
  }

  const props = PropertiesService.getScriptProperties();
  const ruotatiIl = props.getProperty('ACCESS_CODE_ROTATED_AT') || '';
  return {
    ok: plaintext === 0 && senzaHash === 0 && !!ruotatiIl,
    rappresentantiAttivi: attive,
    codiciInChiaro: plaintext,
    righeAttiveSenzaHash: senzaHash,
    rotazioneSicuraRegistrata: !!ruotatiIl,
    ruotatiIl: ruotatiIl,
    versioneRotazione: props.getProperty('ACCESS_CODE_ROTATION_VERSION') || ''
  };
}

/**
 * Compatibilità: non permette più di "mettere in sicurezza" codici deboli
 * limitandosi a farne l'hash. La sicurezza richiede una vera rotazione casuale.
 */
function migraCodiciAccesso() {
  throw new Error(
    'migraCodiciAccesso() è obsoleta per motivi di sicurezza. ' +
    'Usa rigeneraTuttiCodiciAccessoSicuri().'
  );
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
    sh.appendRow([new Date(), testoSicuroFoglio_(funzione, 120), testoSicuroFoglio_(String(err), 1000)]);
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
      testoSicuroFoglio_(codice, 120), testoSicuroFoglio_(municipio, 20), testoSicuroFoglio_(sezione, 30),
      testoSicuroFoglio_(dettaglio, 500), testoSicuroFoglio_(versioneApp, 80),
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


function applicaHardeningProduzione1371() {
  if (APP_ENVIRONMENT !== 'production') {
    throw new Error('Questa funzione è riservata alla build di produzione.');
  }
  const props = PropertiesService.getScriptProperties();

  // In produzione il simulatore può esistere SOLO in modalità isolata.
  // Il flag operativo viene disattivato; l'eventuale archivio simulazione
  // separato viene conservato.
  props.deleteProperty('ELECTION_SIMULATOR_ENABLED');
  props.deleteProperty('ELECTION_SIMULATOR_ACTIVE');
  props.deleteProperty('ELECTION_SIMULATOR_PROFILE');

  getTokenSecret_();
  getAccessCodePepper_();
  getDashboardPasswordPepper_();
  getDashboardTokenSecret_();

  return {
    ok: true,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    ambiente: APP_ENVIRONMENT,
    simulatoreProduzione: 'CONSENTITO SOLO SU ARCHIVIO ISOLATO'
  };
}

function applicaHardeningProduzione1374() {
  return applicaHardeningProduzione1371();
}

function applicaHardeningProduzione1400() {
  return applicaHardeningProduzione1371();
}

// Alias temporanei per compatibilità con le release precedenti.
function applicaHardeningProduzione1370() {
  return applicaHardeningProduzione1374();
}

function verificaSecurityRelease1374() {
  const codici = verificaSicurezzaCodiciAccesso();
  const props = PropertiesService.getScriptProperties();
  const simulatorEnabled = props.getProperty('ELECTION_SIMULATOR_ENABLED') === 'true';
  const simDbId = String(props.getProperty('ELECTION_SIMULATOR_DATABASE_ID') || '');
  const simIsolato = !simDbId || simDbId !== String(DATABASE_SPREADSHEET_ID);
  const integrita = analizzaIntegritaScrutiniProduzione();

  const risultato = {
    ok: APP_ENVIRONMENT === 'production' && simIsolato && codici.ok && integrita.ok,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    ambiente: APP_ENVIRONMENT,
    timeoutLockInviiMs: TIMEOUT_LOCK_INVII_MS,
    maxPostBodyBytes: MAX_POST_BODY_BYTES,
    securityFixes: {
      R1_giornoOrarioFormulaInjection: 'CHIUSA',
      R5_revocaSessioneImmediata: 'CHIUSA',
      R8_simulatorMarkerBypass: 'CHIUSA'
    },
    codiciAccesso: codici,
    electionSimulator: {
      abilitato: simulatorEnabled,
      archivioSeparatoDallaProduzione: simIsolato,
      archivioSimulazioneConfigurato: !!simDbId
    },
    integritaScrutini: integrita,
    verificatoIl: new Date().toISOString()
  };
  Logger.log(JSON.stringify(risultato, null, 2));
  return risultato;
}

// Alias di compatibilità.
function verificaSecurityRelease1371() {
  return verificaSecurityRelease1374();
}
function verificaSecurityRelease1370() {
  return verificaSecurityRelease1374();
}

/**
 * Verifica non distruttiva della configurazione minima richiesta per il go-live.
 * Non sostituisce test applicativi, carico o penetration test: individua errori
 * di configurazione, placeholder, credenziali dashboard mancanti e archivi vuoti.
 */
function verificaProduzionePronta() {
  const ss = getDatabaseSpreadsheet_();
  const props = PropertiesService.getScriptProperties();
  const errori = [];
  const avvisi = [];

  if (APP_ENVIRONMENT !== 'production') errori.push('APP_ENVIRONMENT non è production.');
  if (MUNICIPIO_ABILITATO !== '09') errori.push('MUNICIPIO_ABILITATO non è 09.');

  const cfg = buildConfigFresh_();
  const municipiAttivi = (cfg.municipi || []).filter(function(m) { return m.attivo; }).map(function(m) { return m.m; });
  if (municipiAttivi.length !== 1 || municipiAttivi[0] !== '09') {
    errori.push('Deve risultare attivo esclusivamente il Municipio IX nel foglio Municipi.');
  }
  if (!(cfg.liste.capitolina || []).length) errori.push('Liste capitoline non configurate.');
  if (!((cfg.liste.municipio || {})['09'] || []).length) errori.push('Liste Municipio IX non configurate.');
  if (!(cfg.candidati.capitolina || []).length) avvisi.push('Candidati FdI capitolini non configurati.');
  if (!((cfg.candidati.municipio || {})['09'] || []).length) avvisi.push('Candidati FdI Municipio IX non configurati.');
  if (!(cfg.sindaci || []).length) errori.push('Candidati Sindaco non configurati.');
  if (!((cfg.presidenti || {})['09'] || []).length) errori.push('Candidati Presidente Municipio IX non configurati.');
  if (!(cfg.orari || []).length) errori.push('Orari affluenza non configurati.');

  const imp = cfg.impostazioni || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(imp.DATA_DOMENICA || ''))) errori.push('DATA_DOMENICA mancante o non in formato YYYY-MM-DD.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(imp.DATA_LUNEDI || ''))) errori.push('DATA_LUNEDI mancante o non in formato YYYY-MM-DD.');
  if (!/^\d{1,2}:\d{2}$/.test(String(imp.ORARIO_SCRUTINIO || ''))) errori.push('ORARIO_SCRUTINIO mancante o non valido.');
  if (!String(imp.TELEFONO_ASSISTENZA || '').trim() && !String(imp.EMAIL_ASSISTENZA || '').trim()) {
    avvisi.push('Nessun contatto assistenza configurato.');
  }
  if (String(imp.MODALITA_DEMO || '').trim().toLowerCase() === 'true') errori.push('MODALITA_DEMO è attiva.');

  if (!props.getProperty('DASHBOARD_PASSWORD_HASH')) errori.push('Password Control Center non configurata.');
  if (!props.getProperty('DASHBOARD_TOKEN_SECRET')) errori.push('Segreto token Control Center non inizializzato.');
  if (props.getProperty('DASHBOARD_PASSWORD_TEMP')) errori.push('DASHBOARD_PASSWORD_TEMP è ancora presente nelle proprietà script.');

  const sicurezzaCodici = verificaSicurezzaCodiciAccesso();
  if (!sicurezzaCodici.ok) {
    if (sicurezzaCodici.error) errori.push(String(sicurezzaCodici.error));
    if (Number(sicurezzaCodici.codiciInChiaro || 0) > 0) errori.push('Sono presenti codici di accesso attivi in chiaro: ' + sicurezzaCodici.codiciInChiaro + '.');
    if (Number(sicurezzaCodici.righeAttiveSenzaHash || 0) > 0) errori.push('Sono presenti righe attive senza Codice Hash: ' + sicurezzaCodici.righeAttiveSenzaHash + '.');
    if (!sicurezzaCodici.rotazioneSicuraRegistrata) errori.push('La rotazione sicura dei codici non risulta registrata.');
    if (!sicurezzaCodici.error && !Number(sicurezzaCodici.codiciInChiaro || 0) && !Number(sicurezzaCodici.righeAttiveSenzaHash || 0) && sicurezzaCodici.rotazioneSicuraRegistrata === undefined) errori.push('Codici accesso non conformi.');
  }

  const shRapp = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  let rappresentantiAttivi = 0;
  if (!shRapp || shRapp.getLastRow() < 2) {
    errori.push('Nessun rappresentante configurato.');
  } else {
    const righe = shRapp.getDataRange().getDisplayValues();
    const idx = mappaIntestazioni(righe[0]);
    for (let i = 1; i < righe.length; i++) {
      const attivo = String(valoreColonna(righe[i], idx, ['Attivo']) || '').trim().toUpperCase();
      if (['TRUE', 'VERO', '1'].indexOf(attivo) === -1) continue;
      rappresentantiAttivi++;
      const mu = normalizzaMunicipioStorico_(valoreColonna(righe[i], idx, ['Municipio']));
      const sez = normalizzaSezione_(valoreColonna(righe[i], idx, ['Sezione']));
      if (mu !== '09') errori.push('Rappresentante attivo fuori dal Municipio IX alla riga ' + (i + 1) + '.');
      if (!sez) errori.push('Rappresentante attivo senza sezione alla riga ' + (i + 1) + '.');
    }
  }
  if (!rappresentantiAttivi) errori.push('Nessun rappresentante attivo configurato.');

  const testiPlaceholder = ['aggiungi qui', 'inserisci qui', 'mario rossi', '3280000000'];
  [FOGLI.LISTE, FOGLI.CANDIDATI, FOGLI.SINDACI, FOGLI.PRESIDENTI, FOGLI.RAPPRESENTANTI].forEach(function(nome) {
    const sh = ss.getSheetByName(nome);
    if (!sh || sh.getLastRow() < 2) return;
    const testo = sh.getDataRange().getDisplayValues().slice(1).map(function(r) { return r.join(' '); }).join('\n').toLowerCase();
    testiPlaceholder.forEach(function(marker) {
      if (testo.indexOf(marker) !== -1) errori.push('Valore dimostrativo rilevato nel foglio ' + nome + ': ' + marker + '.');
    });
  });

  const esito = {
    ok: errori.length === 0,
    versioneBackend: CODICE_BACKEND_VERSIONE,
    ambiente: APP_ENVIRONMENT,
    municipio: MUNICIPIO_ABILITATO,
    rappresentantiAttivi: rappresentantiAttivi,
    errori: errori,
    avvisi: avvisi,
    verificatoIl: new Date().toISOString()
  };
  Logger.log(JSON.stringify(esito, null, 2));
  return esito;
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

  // Fogli elettorali: solo intestazioni. In produzione non vengono mai inseriti
  // valori dimostrativi che potrebbero comparire per errore nell'app.
  const shListe = getOrCreateSheet(FOGLI.LISTE, ['Livello', 'Municipio', 'Nome Lista']);
  const shCand = getOrCreateSheet(FOGLI.CANDIDATI, ['Livello', 'Municipio', 'Nome e Cognome']);
  if (shListe.getLastRow() < 2) shListe.getRange('A1').setNote('Compilare tutte le liste reali prima della pubblicazione.');
  if (shCand.getLastRow() < 2) shCand.getRange('A1').setNote('Compilare i candidati FdI reali prima della pubblicazione.');

  // Foglio Orari affluenza: schema standard comunali (da verificare/aggiornare
  // quando sarà fissata la data ufficiale del voto di Roma Capitale)
  const shOrari = getOrCreateSheet(FOGLI.ORARI, ['Giorno', 'Orario']);
  if (shOrari.getLastRow() < 2) {
    [['Domenica', '12:00'], ['Domenica', '19:00'], ['Domenica', '23:00'], ['Lunedì', '12:00']]
      .forEach(function (r) { shOrari.appendRow(r); });
  }

  // Impostazioni pubbliche consumate dalla PWA. Date e contatti restano vuoti
  // finché il coordinamento non inserisce i valori ufficiali.
  const shImp = getOrCreateSheet(FOGLI.IMPOSTAZIONI, ['Chiave', 'Valore', 'Descrizione']);
  if (shImp.getLastRow() < 2) {
    [
      ['DATA_DOMENICA', '', 'Data domenica elettorale in formato YYYY-MM-DD'],
      ['DATA_LUNEDI', '', 'Data lunedì elettorale in formato YYYY-MM-DD'],
      ['SOGLIA_RITARDO_MINUTI', '30', 'Minuti oltre l’orario prima di segnalare un ritardo'],
      ['ORARIO_SCRUTINIO', '23:30', 'Orario indicativo di avvio scrutinio'],
      ['TELEFONO_ASSISTENZA', '', 'Numero assistenza coordinamento'],
      ['WHATSAPP_ASSISTENZA', '', 'Numero WhatsApp assistenza; vuoto = usa telefono'],
      ['EMAIL_ASSISTENZA', '', 'Email assistenza'],
      ['MESSAGGIO_ASSISTENZA', 'Assistenza SeggioLink', 'Testo iniziale per WhatsApp'],
      ['INTERVALLO_MESSAGGI_SECONDI', '120', 'Intervallo minimo aggiornamento messaggi'],
      ['MODALITA_DEMO', 'false', 'true solo per ambienti dimostrativi'],
      ['DEMO_BANNER', 'Modalità dimostrativa', 'Testo banner demo']
    ].forEach(function(r) { shImp.appendRow(r); });
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
  // Candidati e rappresentanti: solo intestazioni, senza anagrafiche fittizie.
  const shSind = getOrCreateSheet(FOGLI.SINDACI, ['Nome e Cognome']);
  const shPres = getOrCreateSheet(FOGLI.PRESIDENTI, ['Municipio', 'Nome e Cognome']);
  const shRapp = getOrCreateSheet(FOGLI.RAPPRESENTANTI, ['Codice', 'Nome e Cognome', 'Municipio', 'Sezione', 'Attivo', 'Telefono', 'Codice Hash']);
  if (shSind.getLastRow() < 2) shSind.getRange('A1').setNote('Compilare i candidati Sindaco reali prima della pubblicazione.');
  if (shPres.getLastRow() < 2) shPres.getRange('A1').setNote('Compilare i candidati Presidente reali prima della pubblicazione.');
  if (shRapp.getLastRow() < 2) shRapp.getRange('A1').setNote('Caricare i rappresentanti reali e generare i codici sicuri prima del go-live.');

  getOrCreateSheet(FOGLI.VOTI_SINDACI, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Sindaco', 'Voti']);
  getOrCreateSheet(FOGLI.VOTI_PRESIDENTI, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Presidente', 'Voti']);
  aggiornaDashboardAffluenzaInterno();

  // Riordino i fogli: configurazione prima, dati raccolti dopo
  const ordine = [FOGLI.RAPPRESENTANTI, FOGLI.MUNICIPI, FOGLI.LISTE, FOGLI.CANDIDATI, FOGLI.SINDACI, FOGLI.PRESIDENTI, FOGLI.ORARI, FOGLI.IMPOSTAZIONI,
    FOGLI.SCRUTINIO, FOGLI.VOTI_LISTE, FOGLI.VOTI_SINDACI, FOGLI.VOTI_PRESIDENTI, FOGLI.PREFERENZE, FOGLI.AFFLUENZA, FOGLI.DASHBOARD_AFFLUENZA, FOGLI.MESSAGGI, FOGLI.LOG];
  ordine.forEach(function (nome, idx) {
    const sh = ss.getSheetByName(nome);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(idx + 1); }
  });

  getDatabaseSpreadsheet_().toast(
    'Inizializzazione completata. Compila tutti i fogli di configurazione e "Impostazioni App", poi esegui verificaProduzionePronta().',
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
  const ui = SpreadsheetApp.getUi();
  let menu = ui
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
    .addItem('🔄 Riesegui inizializzazione', 'inizializza');

  // Aggiunge il sottomenu Election Simulator se il modulo è presente.
  // In produzione il simulatore utilizza esclusivamente l'archivio isolato.
  if (typeof electionSimulatorMenu_ === 'function') {
    menu = electionSimulatorMenu_(menu);
  }

  menu.addToUi();
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


function scrutinioAttivoUnicoPerSezione_(sheet) {
  const attivi = righeAttiveFoglio_(sheet);
  if (!attivi.headers.length) return { headers: [], rows: [], duplicati: [] };

  const idx = mappaIntestazioni(attivi.headers);
  const perChiave = {};
  const conteggi = {};

  attivi.rows.forEach(function(r) {
    const mu = normalizzaMunicipioStorico_(valoreColonna(r, idx, ['Municipio']));
    const se = normalizzaSezione_(valoreColonna(r, idx, ['Sezione']));
    if (!mu || !se) return;
    const key = mu + '-' + se;
    conteggi[key] = (conteggi[key] || 0) + 1;
    // Le righe sono lette in ordine foglio: in caso di anomalia conserviamo
    // l'ultima, ma la segnaliamo esplicitamente.
    perChiave[key] = r;
  });

  return {
    headers: attivi.headers,
    rows: Object.keys(perChiave).map(function(k) { return perChiave[k]; }),
    duplicati: Object.keys(conteggi)
      .filter(function(k) { return conteggi[k] > 1; })
      .map(function(k) { return { sezione: k, attivi: conteggi[k] }; })
  };
}

function analizzaIntegritaScrutiniProduzione() {
  const ss = getDatabaseSpreadsheet_();
  const sh = ss.getSheetByName(FOGLI.SCRUTINIO);
  const unici = scrutinioAttivoUnicoPerSezione_(sh);
  const legacy = [];

  if (sh && sh.getLastRow() > 1) {
    const valori = sh.getDataRange().getValues();
    const idx = mappaIntestazioni(valori[0]);
    for (let i = 1; i < valori.length; i++) {
      if (!rigaSimulatorLegacyForteProduzione_(valori[i], idx)) continue;
      legacy.push({
        riga: i + 1,
        idInvio: String(valoreColonna(valori[i], idx, ['ID Invio']) || ''),
        municipio: normalizzaMunicipioStorico_(valoreColonna(valori[i], idx, ['Municipio'])),
        sezione: normalizzaSezione_(valoreColonna(valori[i], idx, ['Sezione'])),
        stato: String(valoreColonna(valori[i], idx, ['Stato']) || 'ATTIVO')
      });
    }
  }

  return {
    ok: unici.duplicati.length === 0 && legacy.length === 0,
    duplicatiAttivi: unici.duplicati,
    righeSimulatorLegacy: legacy,
    verificatoIl: new Date().toISOString()
  };
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
  let anomalieScrutinio = [];
  if (shScr && shScr.getLastRow() > 1) {
    const attiviScr = scrutinioAttivoUnicoPerSezione_(shScr);
    const headers = attiviScr.headers;
    const colMun = headers.indexOf('Municipio');
    const colSez = headers.indexOf('Sezione');
    const colEl = headers.indexOf('Elettori');
    const colVot = headers.indexOf('Votanti');
    anomalieScrutinio = attiviScr.duplicati || [];
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

  if (anomalieScrutinio.length) {
    msg += '\n⚠️ INTEGRITÀ: ' + anomalieScrutinio.length +
      ' sezioni hanno più righe di scrutinio ATTIVO. I totali sopra usano una sola riga per sezione.\n';
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
  // Cambiare la password invalida immediatamente tutte le sessioni dashboard esistenti.
  props.setProperty('DASHBOARD_TOKEN_SECRET', Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + Utilities.getUuid());
  Logger.log('Password dashboard configurata. La proprietà temporanea è stata eliminata.');
  return { ok: true, configurata: true };
}

function revocaSessioniDashboard() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty('DASHBOARD_TOKEN_SECRET', Utilities.getUuid() + '-' + Utilities.getUuid() + '-' + Utilities.getUuid());
  Logger.log('Sessioni dashboard revocate.');
  return { ok: true, revocate: true, versioneBackend: CODICE_BACKEND_VERSIONE };
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
  const candidato = hashPasswordDashboard_(password).slice(0, 18);
  const tentativiCandidato = Number(cache.get('dashboard_candidate_' + candidato) || '0');
  const tentativiGlobali = Number(cache.get('dashboard_login_global_v1400') || '0');
  if (tentativiCandidato >= 6 || tentativiGlobali >= 60) {
    return {
      ok: false,
      code: 'DASHBOARD_RATE_LIMITED',
      error: 'Troppi tentativi. Attendi alcuni minuti prima di riprovare.'
    };
  }

  const hashRicevuto = hashPasswordDashboard_(password);
  if (!password || !confrontoCostanteDashboard_(hashRicevuto, hashAtteso)) {
    cache.put('dashboard_candidate_' + candidato, String(tentativiCandidato + 1), 600);
    cache.put('dashboard_login_global_v1400', String(tentativiGlobali + 1), 600);
    Utilities.sleep(Math.min(1200, 300 + tentativiCandidato * 120));
    return {
      ok: false,
      code: 'DASHBOARD_UNAUTHORIZED',
      error: 'Password dashboard non valida.'
    };
  }

  cache.remove('dashboard_candidate_' + candidato);
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
  const cacheKey = 'dashboard_web_affluenza_1400_fdi';
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
        biancheComune: Number(valoreColonna(r, idxScr, ['Comune - Bianche']) || 0),
        nulleComune: Number(valoreColonna(r, idxScr, ['Comune - Nulle']) || 0),
        contestateComune: Number(valoreColonna(r, idxScr, ['Comune - Contestate']) || 0),
        valideMunicipio: Number(valoreColonna(r, idxScr, ['Municipio - Valide']) || 0),
        biancheMunicipio: Number(valoreColonna(r, idxScr, ['Municipio - Bianche']) || 0),
        nulleMunicipio: Number(valoreColonna(r, idxScr, ['Municipio - Nulle']) || 0),
        contestateMunicipio: Number(valoreColonna(r, idxScr, ['Municipio - Contestate']) || 0)
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

  // Dettaglio limitato per la dashboard web. Nella 13.6.5 la variabile era
  // restituita senza essere definita, causando ReferenceError a runtime.
  const scrutiniDettaglio = scrutini.slice(0, 100);

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
    scrutiniDettaglio: scrutiniDettaglio,
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