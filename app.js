'use strict';

(function () {
  const DEFAULT_TIMEOUT_MS = 60000;
  const MAX_BODY_CHARS = 210000;

  const PUBLIC_ERROR_MESSAGES = Object.freeze({
    SESSION_EXPIRED: 'La sessione è scaduta. Accedi nuovamente: gli invii salvati sul telefono non andranno persi.',
    SESSION_INVALID: 'La sessione non è più valida. Accedi nuovamente: gli invii salvati sul telefono non andranno persi.',
    SESSION_REVOKED: 'Il coordinamento ha revocato questa sessione. Accedi nuovamente o contatta l’assistenza.',
    REPRESENTATIVE_DISABLED: 'Questo accesso non è più abilitato. Contatta il coordinamento.',
    RATE_LIMITED: 'Troppi tentativi di accesso. Attendi alcuni minuti prima di riprovare.',
    INVALID_CREDENTIALS: 'Codice o numero di telefono non validi.',
    PHONE_REQUIRED: 'Inserisci il numero di telefono comunicato al coordinamento.',
    BUSY: 'Il coordinamento sta ricevendo molti invii. Il dato resta sul telefono e verrà ritentato.',
    INVALID_DATA: 'Alcuni dati non superano i controlli. Verifica i campi evidenziati.',
    PAYLOAD_TOO_LARGE: 'La comunicazione contiene troppi dati. Riduci le note e riprova.',
    INVALID_SERVER_RESPONSE: 'La risposta del coordinamento non è leggibile. Il dato resta conservato sul telefono.',
    NETWORK_ERROR: 'Connessione non disponibile. Il dato resta conservato sul telefono.',
    NETWORK_TIMEOUT: 'Il coordinamento sta impiegando più del previsto a rispondere. Riprova: gli eventuali dati restano conservati sul telefono.',
    ACTIVE_TURNOUT_EXISTS: 'Esiste già una rilevazione attiva per questo orario. Usa la funzione di correzione.',
    ACTIVE_SCRUTINY_EXISTS: 'Esiste già uno scrutinio attivo per questa sezione. Usa la funzione di correzione.',
    MULTIPLE_ACTIVE_SCRUTINIES: 'Sono presenti più scrutini attivi: serve un controllo del coordinamento.',
    CORRECTION_TARGET_NOT_FOUND: 'Il dato che volevi correggere non è più presente sul server.',
    CORRECTION_NOT_ALLOWED: 'Questa correzione non è consentita. Controlla lo storico o contatta il coordinamento.',
    ALREADY_SUPERSEDED: 'Il dato è già stato sostituito da una correzione successiva.'
  });

  function appError(message, code, cause) {
    const err = new Error(message || 'Operazione non riuscita.');
    err.code = code || '';
    if (cause) err.cause = cause;
    return err;
  }

  function userMessage(errorOrCode, fallback) {
    const code = typeof errorOrCode === 'string' ? errorOrCode : (errorOrCode && errorOrCode.code) || '';
    if (PUBLIC_ERROR_MESSAGES[code]) return PUBLIC_ERROR_MESSAGES[code];
    if (errorOrCode && errorOrCode.message) return errorOrCode.message;
    return fallback || 'Operazione non riuscita. Riprova.';
  }

  function abortPerTimeout(controller) {
    if (!controller || !controller.signal || controller.signal.aborted) return;
    try {
      const reason = typeof DOMException === 'function'
        ? new DOMException('Tempo massimo di risposta superato.', 'TimeoutError')
        : new Error('Tempo massimo di risposta superato.');
      controller.abort(reason);
    } catch (e) {
      try { controller.abort(); } catch (ignored) {}
    }
  }

  function interruzioneDaTimeout(error, controller) {
    return !!(
      (controller && controller.signal && controller.signal.aborted) ||
      (error && (error.name === 'AbortError' || error.name === 'TimeoutError'))
    );
  }

  function erroreApplicativo(error) {
    // DOMException espone storicamente un `code` numerico (es. 20/23):
    // non va confuso con i codici applicativi SeggioLink, che sono stringhe.
    return !!(error && typeof error.code === 'string' && error.code);
  }

  function create(options) {
    const opts = options || {};
    const backendUrl = String(opts.backendUrl || '').trim();
    const timeoutMs = Math.max(5000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);

    function configured() {
      return /^https:\/\//i.test(backendUrl);
    }

    async function get(action) {
      if (!configured()) throw appError('Backend non configurato.', 'BACKEND_NOT_CONFIGURED');
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => abortPerTimeout(controller), timeoutMs) : null;
      try {
        const sep = backendUrl.indexOf('?') === -1 ? '?' : '&';
        const res = await fetch(backendUrl + sep + 'action=' + encodeURIComponent(action), {
          cache: 'no-store',
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          credentials: 'omit',
          signal: controller ? controller.signal : undefined
        });
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch (e) { throw appError('Risposta del coordinamento non valida.', 'INVALID_SERVER_RESPONSE', e); }
        if (!data || typeof data !== 'object') throw appError('Risposta del coordinamento non valida.', 'INVALID_SERVER_RESPONSE');
        return data;
      } catch (e) {
        if (erroreApplicativo(e)) throw e;
        if (interruzioneDaTimeout(e, controller)) throw appError('Il coordinamento non ha risposto entro il tempo massimo.', 'NETWORK_TIMEOUT', e);
        throw appError('Connessione al coordinamento non disponibile.', 'NETWORK_ERROR', e);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    async function post(payload, retryCount) {
      if (!configured()) throw appError('Backend non configurato.', 'BACKEND_NOT_CONFIGURED');
      const body = JSON.stringify(payload || {});
      if (body.length > MAX_BODY_CHARS) throw appError('Richiesta troppo grande.', 'PAYLOAD_TOO_LARGE');
      const attempts = Math.max(1, Number(retryCount) || 2);
      let lastError = null;

      for (let attempt = 0; attempt < attempts; attempt++) {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timer = controller ? setTimeout(() => abortPerTimeout(controller), timeoutMs) : null;
        try {
          const res = await fetch(backendUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body,
            cache: 'no-store',
            redirect: 'follow',
            referrerPolicy: 'no-referrer',
            credentials: 'omit',
            signal: controller ? controller.signal : undefined
          });
          const text = await res.text();
          let data;
          try { data = JSON.parse(text); }
          catch (e) { throw appError('Risposta del coordinamento non valida.', 'INVALID_SERVER_RESPONSE', e); }
          if (!data || typeof data !== 'object') throw appError('Risposta del coordinamento non valida.', 'INVALID_SERVER_RESPONSE');
          return data;
        } catch (e) {
          lastError = erroreApplicativo(e) ? e : (interruzioneDaTimeout(e, controller)
            ? appError('Il coordinamento non ha risposto entro il tempo massimo.', 'NETWORK_TIMEOUT', e)
            : appError('Connessione al coordinamento non disponibile.', 'NETWORK_ERROR', e));
          if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 700 * (attempt + 1)));
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      throw lastError || appError('Nessuna risposta dal coordinamento.', 'NETWORK_ERROR');
    }

    return Object.freeze({ configured, get, post, userMessage });
  }

  window.SeggioAPI = Object.freeze({ create, userMessage, PUBLIC_ERROR_MESSAGES });
}());
'use strict';

(function () {
  const QUEUE_STATUS = Object.freeze({
    LOCAL: 'pending',
    SENDING: 'syncing',
    CONFIRMED: 'synced',
    ACTION_REQUIRED: 'error'
  });

  function queueMeta(status) {
    if (status === QUEUE_STATUS.CONFIRMED) return { key: 'confirmed', label: 'Ricevuto dal coordinamento', pill: 'good' };
    if (status === QUEUE_STATUS.SENDING) return { key: 'sending', label: 'Invio in corso…', pill: 'neutral' };
    if (status === QUEUE_STATUS.ACTION_REQUIRED) return { key: 'attention', label: 'Richiede attenzione', pill: 'bad' };
    return { key: 'local', label: 'Salvato sul telefono', pill: 'warn' };
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function text(tag, value, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    return node;
  }

  window.SeggioUI = Object.freeze({ QUEUE_STATUS, queueMeta, clearNode, text });
}());
'use strict';

/* =====================================================================
   RETE SEGGI FdI — app.js
   Tutta la logica dell'applicazione. Nessuna libreria esterna: scelta
   voluta per restare leggeri e avere il minimo possibile che si possa
   rompere su un telefono datato o con connessione scarsa al seggio.
   ===================================================================== */

// ---------------------------------------------------------------------
// CONFIGURAZIONE DA PERSONALIZZARE AL MOMENTO DEL DEPLOY
// Sostituire con l'URL del tuo Web App di Google Apps Script
// (vedi ISTRUZIONI_SETUP.md, sezione "Pubblicare il backend").
// ---------------------------------------------------------------------
const RUNTIME_CONFIG = window.SEGGI_CONFIG || {};
const BACKEND_URL = String(RUNTIME_CONFIG.backendUrl || '').trim();
const APP_VERSION = String(RUNTIME_CONFIG.appVersion || '14.0.6');
const REQUEST_TIMEOUT_MS = Number(RUNTIME_CONFIG.requestTimeoutMs || 60000);
const LOGIN_TIMEOUT_MS = Math.min(12000, Math.max(6000, REQUEST_TIMEOUT_MS));
const API_CLIENT = window.SeggioAPI ? window.SeggioAPI.create({ backendUrl: BACKEND_URL, timeoutMs: REQUEST_TIMEOUT_MS }) : null;
// Il login usa lo stesso endpoint e gli stessi controlli, ma con timeout più breve:
// non rallenta gli accessi riusciti e restituisce prima un aiuto utile quando il
// browser o la rete bloccano il collegamento.
const LOGIN_API_CLIENT = window.SeggioAPI ? window.SeggioAPI.create({ backendUrl: BACKEND_URL, timeoutMs: LOGIN_TIMEOUT_MS }) : null;
const QUEUE_STATUS = window.SeggioUI ? window.SeggioUI.QUEUE_STATUS : Object.freeze({ LOCAL: 'pending', SENDING: 'syncing', CONFIRMED: 'synced', ACTION_REQUIRED: 'error' });

const NOMI_MUNICIPI = {
  '01':'Municipio I','02':'Municipio II','03':'Municipio III','04':'Municipio IV',
  '05':'Municipio V','06':'Municipio VI','07':'Municipio VII','08':'Municipio VIII',
  '09':'Municipio IX','10':'Municipio X','11':'Municipio XI','12':'Municipio XII',
  '13':'Municipio XIII','14':'Municipio XIV','15':'Municipio XV',
};

const LS = {
  OWNER: 'rs_session_owner',
  STORAGE_VERSION: 'rs_security_storage_version',
  TOKEN: 'rs_session_token',
  TOKEN_EXPIRES: 'rs_session_expires',
  PERSONA: 'rs_persona',
  SEGGI: 'rs_seggi',
  SEGGIO_ATTIVO: 'rs_seggio_attivo',
  CONFIG: 'rs_config_cache',
  DATA_REVISION: 'rs_data_revision',
  MUN_DATA: (mu) => 'rs_mun_data_' + mu,
  QUEUE_AFF: 'rs_queue_affluenza',
  QUEUE_SCR: 'rs_queue_scrutinio',
  SCR_DRAFT: (mu, sez) => 'rs_scrutinio_draft_' + mu + '_' + sez,
  INSTALL_DISMISSED: 'rs_install_dismissed',
  MESSAGGI: 'rs_messaggi_cache',
  DEVICE_CHECK_VERSION: 'rs_device_check_version',
  ACCESSIBILITY: 'rs_accessibility_mode',
  LAST_MESSAGE_CHECK: 'rs_last_message_check',
};

let STATE = {
  profile: null,       // persona + seggio attivo, fusi insieme (compatibilità col resto del codice)
  persona: null,       // { nome, telefono }
  seggi: [],           // [{ id, municipio, sezione, addr, cap, elettori }, ...]
  seggioAttivoId: null,
  municipioData: null,
  config: null,
  modalitaAggiungiSeggio: false, // true quando si torna al setup per aggiungere un seggio in più (persona già nota)
  messaggi: [],
  swRegistration: null,
  swWaiting: null,
};

function idSeggio(municipio, sezione) { return municipio + '-' + sezione; }

function trovaSeggio(id) { return STATE.seggi.find((s) => s.id === id) || null; }

function ricostruisciProfileDaSeggioAttivo() {
  const seg = trovaSeggio(STATE.seggioAttivoId);
  if (!STATE.persona || !seg) { STATE.profile = null; return; }
  STATE.profile = Object.assign({}, STATE.persona, seg);
}

// ---------------------------------------------------------------------
// UTILITY DI BASE
// ---------------------------------------------------------------------
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function ownerStorageId() {
  try {
    const raw = localStorage.getItem(LS.OWNER);
    const value = raw ? JSON.parse(raw) : '';
    return String(value || '').replace(/[^A-Za-z0-9_-]/g, '').substring(0, 64);
  } catch (e) { return ''; }
}

async function ownerIdDaCodice(codice) {
  const normalized = String(codice || '').trim().toUpperCase();
  if (!normalized) return '';

  if (window.crypto && window.crypto.subtle && window.TextEncoder) {
    const bytes = new TextEncoder().encode('SeggioLink-owner-v1|' + normalized);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
    return 'u_' + hex.slice(0, 40);
  }

  // Fallback solo per browser molto vecchi. Il codice non viene mai salvato.
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const text = 'SeggioLink-owner-v1|' + normalized;
  for (let i = 0; i < text.length; i++) {
    h1 = Math.imul(h1 ^ text.charCodeAt(i), 16777619);
    h2 = Math.imul(h2 ^ text.charCodeAt(i), 2246822507);
  }
  return 'u_' + (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0');
}

function chiaveStorageEffettiva(key) {
  const owner = ownerStorageId();
  const scoped = key === LS.PERSONA || key === LS.SEGGI || key === LS.SEGGIO_ATTIVO || key === LS.DATA_REVISION ||
    key === LS.QUEUE_AFF || key === LS.QUEUE_SCR || key === LS.MESSAGGI || String(key).indexOf('rs_scrutinio_draft_') === 0;
  return scoped ? key + '::' + (owner || 'nessun-utente') : key;
}

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(chiaveStorageEffettiva(key)); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(chiaveStorageEffettiva(key), JSON.stringify(val)); return true; }
  catch (e) { return false; }
}
function removeJSON(key) {
  try { localStorage.removeItem(chiaveStorageEffettiva(key)); } catch (e) {}
}
function loadSessionJSON(key, fallback) {
  try { const v = sessionStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function saveSessionJSON(key, val) {
  try { sessionStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
}
function clearSessionCredentials() {
  try { sessionStorage.removeItem(LS.TOKEN); sessionStorage.removeItem(LS.TOKEN_EXPIRES); } catch (e) {}
}

function erroreRichiedeNuovoLogin(code) {
  return ['SESSION_EXPIRED', 'SESSION_INVALID', 'SESSION_REVOKED', 'REPRESENTATIVE_DISABLED']
    .includes(String(code || ''));
}

function rimuoviBozzeScrutinioLocali(ownerSpecifico) {
  const suffisso = ownerSpecifico ? '::' + ownerSpecifico : '';
  const chiavi = [];
  for (let i = 0; i < localStorage.length; i++) chiavi.push(localStorage.key(i));
  chiavi.filter((key) => key && key.indexOf('rs_scrutinio_draft_') === 0 && (!suffisso || key.endsWith(suffisso)))
    .forEach((key) => localStorage.removeItem(key));
}

function pulisciDatiOperativiLocali() {
  removeJSON(LS.QUEUE_AFF);
  removeJSON(LS.QUEUE_SCR);
  rimuoviBozzeScrutinioLocali(ownerStorageId());
}

function migraStorageSicurezza() {
  const attesa = '3';
  const corrente = localStorage.getItem(LS.STORAGE_VERSION);
  if (corrente === attesa) return;
  // Le versioni precedenti memorizzavano credenziali e code non isolate per utente. La migrazione
  // invalida soltanto quel formato legacy; va eseguita prima della raccolta reale.
  ['rs_codice','rs_session_token','rs_session_expires','rs_persona','rs_seggi','rs_seggio_attivo',
   'rs_queue_affluenza','rs_queue_scrutinio','rs_messaggi_cache','rs_profile'].forEach((key) => localStorage.removeItem(key));
  rimuoviBozzeScrutinioLocali();
  clearSessionCredentials();
  localStorage.removeItem(LS.OWNER);
  localStorage.setItem(LS.STORAGE_VERSION, attesa);
}

// Il coordinamento incrementa questa revisione quando usa “Svuota dati di test”.
// Al successivo avvio online il telefono elimina soltanto storico invii e bozze,
// mantenendo accesso, seggi assegnati e numero di telefono.
function gestisciRevisioneDati(revisione) {
  const nuova = String(revisione || '').trim();
  if (!nuova) return false;
  const precedente = loadJSON(LS.DATA_REVISION, null);
  if (!precedente) {
    saveJSON(LS.DATA_REVISION, nuova);
    return false;
  }
  if (String(precedente) === nuova) return false;
  pulisciDatiOperativiLocali();
  saveJSON(LS.DATA_REVISION, nuova);
  setTimeout(() => showToast('Il coordinamento ha azzerato i dati di prova. Lo storico del telefono è stato riallineato.', 6000), 0);
  return true;
}

let toastTimer = null;
function showToast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms || 2800);
}

function normalizza(s) {
  return (s || '').toString().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function numOr0(v) {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function haValore(v) { return v !== undefined && v !== null && String(v).trim() !== ''; }
function interoNonNegativo(v) {
  if (!haValore(v)) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
function sessionToken() {
  const token = loadSessionJSON(LS.TOKEN, '');
  if (!token) return '';
  const expiresAt = loadSessionJSON(LS.TOKEN_EXPIRES, '');
  if (expiresAt) {
    const exp = Date.parse(String(expiresAt));
    if (Number.isFinite(exp) && Date.now() >= exp) {
      clearSessionCredentials();
      return '';
    }
  }
  return token;
}
function impostaNonValido(el, invalido) {
  if (!el) return;
  if (invalido) el.setAttribute('aria-invalid', 'true');
  else el.removeAttribute('aria-invalid');
}
function trovaItem(queueKey, idInvio) {
  return loadJSON(queueKey, []).find((it) => it.idInvio === idInvio) || null;
}
function idsSostituiti(queueKey) {
  const items = loadJSON(queueKey, []);
  const ids = new Set(items.map((it) => it.payload && it.payload.correzioneDi).filter(Boolean));
  items.forEach((it) => {
    if (!it || !it.idInvio) return;
    if (String(it.statoServer || '').toUpperCase() === 'SOSTITUITO' || it.sostituitoDaServer) ids.add(it.idInvio);
  });
  return ids;
}
function aggiornaTokenInviiInCoda(token) {
  // SECURITY: i bearer token non vengono mai persistiti dentro le code offline.
  // La funzione resta solo per compatibilità con vecchie chiamate interne.
  return !!token;
}

// ---------------------------------------------------------------------
// STATO CONNESSIONE
// ---------------------------------------------------------------------
function aggiornaStatoConnessione() {
  const pill = $('#connStatus');
  const home = $('#homeConnStatus');
  const pending = STATE.profile ? [...inviiCorrenti(LS.QUEUE_AFF), ...inviiCorrenti(LS.QUEUE_SCR)].filter((i) => i.status !== QUEUE_STATUS.CONFIRMED).length : contaInCoda();
  if (navigator.onLine) {
    // La GUI espone qui solo lo stato della rete. Lo stato degli invii resta
    // visibile nella scheda Invii e nei relativi badge, senza sovraccaricare
    // l'intestazione con messaggi di sincronizzazione.
    pill.textContent = 'Online';
    pill.className = 'status-pill online';
    if (home) { home.textContent = 'Online'; home.className = 'home-status online'; }
  } else {
    pill.textContent = pending ? ('Offline · ' + pending + (pending === 1 ? ' salvato' : ' salvati')) : 'Offline · puoi continuare';
    pill.className = 'status-pill offline';
    if (home) { home.textContent = pending ? 'Offline · dati al sicuro sul telefono' : 'Offline · puoi continuare a lavorare'; home.className = 'home-status offline'; }
  }
}
window.addEventListener('online', async () => { aggiornaStatoConnessione(); await provaSvuotaCode(); await sincronizzaStoricoDaServer(true); caricaMessaggi(true); });
window.addEventListener('offline', () => { aggiornaStatoConnessione(); renderNotificheHome(); });

// ---------------------------------------------------------------------
// CARICAMENTO DATI SEZIONI/VIE (file statici per municipio)
// ---------------------------------------------------------------------
async function caricaDatiMunicipio(mu) {
  const cacheKey = LS.MUN_DATA(mu);
  try {
    const res = await fetch('data/municipio-' + mu + '.json', { cache: 'force-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    saveJSON(cacheKey, data);
    return data;
  } catch (e) {
    const cached = loadJSON(cacheKey, null);
    if (cached) return cached;
    throw e;
  }
}

function trovaSezione(data, numeroSezione) {
  if (!data || !data.sezioni) return null;
  const target = String(numeroSezione).trim().replace(/^0+/, '');
  return data.sezioni.find((s) => String(s.s).replace(/^0+/, '') === target) || null;
}

function codiceCivicoMatch(codice, da, a, civico) {
  const aEff = (a === null || a === undefined) ? Infinity : a;
  const daEff = (da === null || da === undefined) ? -Infinity : da;
  switch (codice) {
    case 'T': return true;
    case 'CD': return civico % 2 === 1 && civico >= daEff && civico <= aEff;
    case 'CP': return civico % 2 === 0 && civico >= daEff && civico <= aEff;
    case 'CQ': return civico >= daEff && civico <= aEff;
    default: return false; // CS, LX, PX, K: caso speciale, non verificabile su un civico singolo
  }
}

function cercaPerVia(data, via, civicoStr) {
  const viaNorm = normalizza(via);
  if (!viaNorm) return [];
  const civico = civicoStr ? parseInt(civicoStr, 10) : null;
  const trovati = [];
  (data.sezioni || []).forEach((sez) => {
    let match = null;
    let speciale = false;
    (sez.v || []).forEach((riga) => {
      const nomeVia = riga[0], codice = riga[1], da = riga[2], a = riga[3];
      if (normalizza(nomeVia).indexOf(viaNorm) === -1) return;
      if (civico === null) { match = match || riga; return; }
      if (codiceCivicoMatch(codice, da, a, civico)) { match = riga; }
      else if (['CS', 'LX', 'PX', 'K'].includes(codice) && !match) { speciale = riga; }
    });
    if (match) trovati.push({ sezione: sez.s, addr: sez.addr, cap: sez.cap, via: match[0], speciale: false });
    else if (civico !== null && speciale) trovati.push({ sezione: sez.s, addr: sez.addr, cap: sez.cap, via: speciale[0], speciale: true });
  });
  return trovati;
}

// ---------------------------------------------------------------------
// CONFIGURAZIONE DAL BACKEND (Google Sheet via Apps Script)
// ---------------------------------------------------------------------
function backendConfigurato() {
  return API_CLIENT ? API_CLIENT.configured() : /^https:\/\//i.test(BACKEND_URL);
}

function messaggioErroreUtente(err, fallback) {
  if (API_CLIENT) return API_CLIENT.userMessage(err, fallback);
  return (err && err.message) || fallback || 'Operazione non riuscita. Riprova.';
}

// Diagnostica browser/rete sul solo percorso di errore del login.
// Non esegue ping, preflight o altre richieste prima dell'accesso: quando tutto
// funziona non aggiunge alcuna latenza al login.
function erroreLoginDiRete(err) {
  const codice = err && typeof err.code === 'string' ? err.code : '';
  return ['NETWORK_ERROR', 'NETWORK_TIMEOUT', 'INVALID_SERVER_RESPONSE'].includes(codice);
}

function browserCorrente() {
  const ua = String((navigator && navigator.userAgent) || '');
  if (navigator && navigator.brave && typeof navigator.brave.isBrave === 'function') return 'Brave';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Firefox\//i.test(ua) || /FxiOS\//i.test(ua)) return 'Firefox';
  if (/CriOS\//i.test(ua) || (/Chrome\//i.test(ua) && !/Edg\//i.test(ua))) return 'Chrome';
  if (/Safari\//i.test(ua) && !/CriOS\//i.test(ua) && !/FxiOS\//i.test(ua)) return 'Safari';
  return 'Browser';
}

function testoAiutoBrowser(browser) {
  if (browser === 'Brave') {
    return {
      titolo: 'Brave sta probabilmente bloccando il collegamento al coordinamento.',
      istruzioni: 'Tocca l’icona del leone, disattiva Shields solo per SeggioLink e poi premi “Riprova accesso”.'
    };
  }
  if (browser === 'Firefox') {
    return {
      titolo: 'Firefox non riesce a raggiungere il coordinamento.',
      istruzioni: 'Se hai la protezione antitracciamento in modalità restrittiva o un blocco contenuti, consentila per SeggioLink e poi riprova.'
    };
  }
  if (browser === 'Safari') {
    return {
      titolo: 'Safari non riesce a raggiungere il coordinamento.',
      istruzioni: 'Se usi un blocco contenuti o una protezione privacy aggiuntiva, disattivala solo per SeggioLink e poi riprova.'
    };
  }
  if (browser === 'Chrome' || browser === 'Edge') {
    return {
      titolo: browser + ' non riesce a raggiungere il coordinamento.',
      istruzioni: 'Controlla eventuali estensioni ad-block/privacy o filtri aziendali per questo sito, quindi premi “Riprova accesso”.'
    };
  }
  return {
    titolo: 'Il browser non riesce a raggiungere il coordinamento.',
    istruzioni: 'Controlla eventuali blocchi privacy o contenuti per SeggioLink, quindi premi “Riprova accesso”.'
  };
}

function mostraAiutoConnessioneLogin(errBox) {
  const offline = navigator && navigator.onLine === false;
  const browser = browserCorrente();
  const aiuto = offline ? {
    titolo: 'Connessione Internet assente.',
    istruzioni: 'Riattiva Wi‑Fi o rete mobile e poi premi “Riprova accesso”.'
  } : testoAiutoBrowser(browser);

  errBox.textContent = '';
  const wrap = document.createElement('div');
  wrap.className = 'login-network-help';

  const strong = document.createElement('strong');
  strong.textContent = aiuto.titolo;
  wrap.appendChild(strong);

  const p = document.createElement('p');
  p.textContent = aiuto.istruzioni;
  wrap.appendChild(p);

  const detail = document.createElement('p');
  detail.className = 'login-network-detail';
  detail.textContent = 'Non serve disattivare protezioni globalmente: modifica solo questo sito. I dati già salvati sul telefono non vengono cancellati.';
  wrap.appendChild(detail);

  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'btn ghost compact login-network-retry';
  retry.textContent = 'Riprova accesso';
  retry.addEventListener('click', onLogin, { once: true });
  wrap.appendChild(retry);

  errBox.appendChild(wrap);
  errBox.hidden = false;
}

async function caricaConfig() {
  if (!backendConfigurato()) {
    const cached = loadJSON(LS.CONFIG, null);
    STATE.config = cached || configVuota();
    return STATE.config;
  }
  try {
    const data = API_CLIENT ? await API_CLIENT.get('config') : await (async () => {
      const res = await fetch(BACKEND_URL + '?action=config', { cache: 'no-store', redirect: 'follow' });
      return JSON.parse(await res.text());
    })();
    if (!data.ok) throw new Error(data.error || 'Configurazione non valida');
    gestisciRevisioneDati(data.dataRevision);
    saveJSON(LS.CONFIG, data);
    STATE.config = data;
    return data;
  } catch (e) {
    const cached = loadJSON(LS.CONFIG, null);
    STATE.config = cached || configVuota();
    return STATE.config;
  }
}

function configVuota() {
  return { ok: false, municipi: [], liste: { capitolina: [], municipio: {} }, candidati: { capitolina: [], municipio: {} }, orari: [], impostazioni: {}, app: {} };
}

function applicaConfigAggiornataAllaUI() {
  renderModalitaDemo();
  verificaVersioneConfigurata();
  popolaSelectMunicipi();
  if (!STATE.profile) return;
  renderAffluenza();
  renderScrutinioListeECandidati();
  renderHomeDashboard();
  const backendLabel = $('#backendVersionLabel');
  if (backendLabel) backendLabel.textContent = (STATE.config && STATE.config.app && STATE.config.app.backendVersion) || '—';
}

let configRefreshPromise = null;
function aggiornaConfigInBackground() {
  if (configRefreshPromise) return configRefreshPromise;
  configRefreshPromise = caricaConfig()
    .then((data) => { applicaConfigAggiornataAllaUI(); return data; })
    .finally(() => { configRefreshPromise = null; });
  return configRefreshPromise;
}

function renderModalitaDemo() {
  const el = $('#demoBanner');
  if (!el) return;
  const appCfg = STATE.config && STATE.config.app;
  const attiva = !!(appCfg && appCfg.modalitaDemo);
  el.hidden = !attiva;
  if (attiva) {
    const text = $('#demoBannerText');
    if (text) text.textContent = appCfg.demoBanner || 'MODALITÀ DIMOSTRAZIONE · I dati inseriti non sono ufficiali';
  }
}

function listeCapitolina() { return (STATE.config && STATE.config.liste && STATE.config.liste.capitolina) || []; }
function listeMunicipioAttuale() {
  const mu = STATE.profile && STATE.profile.municipio;
  return (STATE.config && STATE.config.liste && STATE.config.liste.municipio && STATE.config.liste.municipio[mu]) || [];
}
function candidatiCapitolina() { return (STATE.config && STATE.config.candidati && STATE.config.candidati.capitolina) || []; }
function candidatiMunicipioAttuale() {
  const mu = STATE.profile && STATE.profile.municipio;
  return (STATE.config && STATE.config.candidati && STATE.config.candidati.municipio && STATE.config.candidati.municipio[mu]) || [];
}
function sindaci() { return (STATE.config && STATE.config.sindaci) || []; }
function presidentiMunicipioAttuale() {
  const mu = STATE.profile && STATE.profile.municipio;
  return (STATE.config && STATE.config.presidenti && STATE.config.presidenti[mu]) || [];
}
function orariAffluenza() { return (STATE.config && STATE.config.orari) || []; }


function impostazione(key, fallback) {
  const cfg = STATE.config && STATE.config.impostazioni;
  const value = cfg && cfg[key];
  return value === undefined || value === null || String(value).trim() === '' ? fallback : String(value).trim();
}

function confrontaVersioni(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function dataScadenza(giorno, orario) {
  const g = normalizza(giorno);
  const data = g.indexOf('DOMENICA') !== -1 ? impostazione('DATA_DOMENICA', '')
    : (g.indexOf('LUNEDI') !== -1 ? impostazione('DATA_LUNEDI', '') : '');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data) || !/^\d{1,2}:\d{2}$/.test(String(orario || ''))) return null;
  const d = new Date(data + 'T' + String(orario).padStart(5, '0') + ':00');
  return isNaN(d.getTime()) ? null : d;
}

function descriviTempo(ms) {
  const abs = Math.abs(ms);
  const minuti = Math.round(abs / 60000);
  if (minuti < 60) return minuti + ' min';
  const ore = Math.floor(minuti / 60);
  const rest = minuti % 60;
  return ore + ' h' + (rest ? ' ' + rest + ' min' : '');
}

function statoScadenza(giorno, orario, completato) {
  if (completato) return null;
  const d = dataScadenza(giorno, orario);
  if (!d) return null;
  const delta = d.getTime() - Date.now();
  const ritardo = Number(impostazione('SOGLIA_RITARDO_MINUTI', '30')) || 30;
  if (delta < -ritardo * 60000) return { classe: 'error', etichetta: 'In ritardo', testo: 'scaduta da ' + descriviTempo(delta) };
  if (delta < 0) return { classe: 'queued', etichetta: 'Da inviare ora', testo: 'orario raggiunto' };
  if (delta < 2 * 60 * 60000) return { classe: 'todo', etichetta: 'Tra ' + descriviTempo(delta), testo: 'prossima scadenza' };
  return { classe: 'todo', etichetta: 'Da inviare', testo: d.toLocaleString('it-IT', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) };
}


async function backendPostSicuro(payload, retryCount) {
  if (!backendConfigurato()) {
    const err = new Error('Backend non configurato.');
    err.code = 'BACKEND_NOT_CONFIGURED';
    throw err;
  }
  const tentativi = retryCount === undefined ? 2 : Math.max(1, Number(retryCount) || 1);
  if (API_CLIENT) return API_CLIENT.post(payload, tentativi);
  throw new Error('Client API non disponibile.');
}

// Costruisce immediatamente i seggi assegnati usando, quando disponibile,
// il dataset territoriale già presente nella cache locale. Il login non resta
// bloccato in attesa del download delle vie/sezioni: gli indirizzi vengono
// arricchiti in background subito dopo l'accesso.
function seggiDaAssegnazioniRapide(assegnazioni) {
  const cacheMunicipi = new Map();
  const risultato = [];
  (assegnazioni || []).forEach((assegnazione) => {
    const mu = String(assegnazione && assegnazione.municipio || '').padStart(2, '0');
    const numero = String(assegnazione && assegnazione.sezione || '').trim();
    if (!mu || !numero) return;
    if (!cacheMunicipi.has(mu)) cacheMunicipi.set(mu, loadJSON(LS.MUN_DATA(mu), null));
    const info = trovaSezione(cacheMunicipi.get(mu), numero) || { s: numero, addr: '', cap: '' };
    const id = idSeggio(mu, info.s);
    if (!risultato.some((seg) => seg.id === id)) {
      risultato.push({ id, municipio: mu, sezione: info.s, addr: info.addr || '', cap: info.cap || '', elettori: null });
    }
  });
  return risultato;
}

async function arricchisciSeggiDopoLogin(assegnazioni, ownerAtteso) {
  try {
    const municipi = [...new Set((assegnazioni || []).map((a) => String(a && a.municipio || '').padStart(2, '0')).filter(Boolean))];
    const dati = new Map();
    await Promise.all(municipi.map(async (mu) => {
      try { dati.set(mu, await caricaDatiMunicipio(mu)); } catch (e) { /* cache/fallback già gestiti */ }
    }));
    if (!STATE.persona || ownerStorageId() !== ownerAtteso) return;

    let cambiato = false;
    STATE.seggi = STATE.seggi.map((seg) => {
      const info = trovaSezione(dati.get(seg.municipio), seg.sezione);
      if (!info) return seg;
      const addr = info.addr || '';
      const cap = info.cap || '';
      if (addr === (seg.addr || '') && cap === (seg.cap || '')) return seg;
      cambiato = true;
      return Object.assign({}, seg, { sezione: info.s || seg.sezione, addr, cap });
    });
    if (!cambiato) return;
    saveJSON(LS.SEGGI, STATE.seggi);
    ricostruisciProfileDaSeggioAttivo();
    popolaSelectSeggioAttivo();
    if (STATE.profile) {
      const indirizzo = [STATE.profile.addr, STATE.profile.cap ? 'CAP ' + STATE.profile.cap : ''].filter(Boolean).join(' · ');
      $('#seggioIndirizzo').textContent = indirizzo || 'Municipio IX Roma';
    }
  } catch (e) {
    // L'arricchimento territoriale non deve mai impedire l'uso dell'app.
  }
}

function sincronizzazioniPostLoginInBackground() {
  // Nessuna richiesta extra viene fatta prima del login. Solo dopo che
  // l'autenticazione è riuscita aggiorniamo anche la configurazione ufficiale.
  aggiornaConfigInBackground().catch(() => {});

  // Login e dashboard non attendono storico/code/messaggi: questi vengono
  // aggiornati subito dopo, in background, mantenendo tutte le funzionalità
  // introdotte nella 14.0.3.
  Promise.resolve()
    // Prima ricostruiamo lo storico ufficiale: gli invii già presenti sul
    // coordinamento compaiono rapidamente anche su un telefono nuovo.
    .then(() => sincronizzaStoricoDaServer(true))
    // Poi tentiamo gli eventuali invii locali rimasti in coda.
    .then(() => provaSvuotaCode())
    .catch(() => {});
}

// =======================================================================
// SCHERMATA 0 — LOGIN CON CODICE ACCESSO
// =======================================================================
async function onLogin() {
  const telefono = $('#loginTelefono').value.trim();
  const codice = $('#inputCodice').value.trim().toUpperCase();
  const errBox = $('#loginErrore');
  errBox.hidden = true;

  const errori = [];
  if (!telefono || telefono.replace(/\D/g, '').length < 8) errori.push('Inserisci un numero di telefono valido.');
  if (!codice) errori.push('Inserisci il tuo codice di accesso.');
  if (errori.length) {
    errBox.innerHTML = '<ul>' + errori.map((e) => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
    errBox.hidden = false;
    return;
  }

  const btn = $('#btnLogin');
  btn.textContent = 'Verifico…';
  btn.disabled = true;

  try {
    const data = LOGIN_API_CLIENT
      ? await LOGIN_API_CLIENT.post({ tipo: 'login', codice, telefono }, 1)
      : await backendPostSicuro({ tipo: 'login', codice, telefono }, 1);
    if (!data.ok || !data.sessionToken) {
      const err = new Error(messaggioErroreUtente(data.code || '', data.error || 'Codice o telefono non validi.'));
      err.code = data.code || '';
      throw err;
    }

    const ownerId = await ownerIdDaCodice(codice);
    if (!ownerId) throw new Error('Impossibile inizializzare la sessione locale.');
    try { localStorage.setItem(LS.OWNER, JSON.stringify(ownerId)); }
    catch (e) { throw new Error('Archiviazione locale non disponibile sul dispositivo.'); }

    gestisciRevisioneDati(data.dataRevision);
    saveSessionJSON(LS.TOKEN, data.sessionToken);
    saveSessionJSON(LS.TOKEN_EXPIRES, data.sessionExpiresAt || null);
    STATE.persona = { nome: data.nome || 'Rappresentante', telefono: data.telefono || telefono };
    saveJSON(LS.PERSONA, STATE.persona);
    STATE.seggi = [];

    if (data.sezioni && data.sezioni.length > 0) {
      STATE.seggi = seggiDaAssegnazioniRapide(data.sezioni);
      if (!STATE.seggi.length) throw new Error('Nessuna sezione valida associata alla sessione.');
      saveJSON(LS.SEGGI, STATE.seggi);
      STATE.seggioAttivoId = STATE.seggi[0].id;
      saveJSON(LS.SEGGIO_ATTIVO, STATE.seggioAttivoId);
      ricostruisciProfileDaSeggioAttivo();

      // La dashboard viene mostrata immediatamente dopo l'autenticazione.
      // Dataset territoriale, code e storico ufficiale continuano in background.
      mostraDashboard();
      showToast('Accesso effettuato come ' + STATE.persona.nome + '.');
      const ownerAtteso = ownerId;
      arricchisciSeggiDopoLogin(data.sezioni, ownerAtteso);
      sincronizzazioniPostLoginInBackground();
    } else {
      vaiAlSetupPrecompilato(data);
      aggiornaConfigInBackground().catch(() => {});
    }
  } catch (e) {
    if (erroreLoginDiRete(e)) {
      mostraAiutoConnessioneLogin(errBox);
    } else {
      errBox.textContent = messaggioErroreUtente(
        e,
        'Impossibile verificare il codice. Controlla la connessione e riprova.'
      );
      errBox.hidden = false;
    }
  } finally {
    btn.textContent = 'Accedi';
    btn.disabled = false;
  }
}

function vaiAlSetupPrecompilato(data) {
  $('#screen-login').classList.remove('active');
  $('#screen-setup').classList.add('active');
  if (data.nome) $('#inputNome').value = data.nome;
  predisponiSchermataSetup(false);
}

function mostraLoginSeNecessario() {
  if (!sessionToken() || !ownerStorageId()) {
    $('#screen-login').classList.add('active');
    return true;
  }
  return false;
}

let focusPrimaLogout = null;

function onLogout() {
  const modal = $('#modalLogout');
  if (!modal) return;
  focusPrimaLogout = document.activeElement;
  modal.hidden = false;
  requestAnimationFrame(() => {
    const btn = $('#btnAnnullaLogout');
    if (btn) btn.focus();
  });
}

function chiudiModalLogout() {
  const modal = $('#modalLogout');
  if (modal) modal.hidden = true;
  if (focusPrimaLogout && typeof focusPrimaLogout.focus === 'function') {
    focusPrimaLogout.focus();
  }
  focusPrimaLogout = null;
}

function confermaLogout() {
  if (STATE.profile && timerBozzaScrutinio) salvaBozzaScrutinio(false, 'bozza');
  clearTimeout(timerBozzaScrutinio);
  timerBozzaScrutinio = null;

  clearSessionCredentials();
  [LS.PERSONA, LS.SEGGI, LS.SEGGIO_ATTIVO].forEach((key) => removeJSON(key));
  localStorage.removeItem(LS.OWNER);
  STATE.persona = null;
  STATE.seggi = [];
  STATE.seggioAttivoId = null;
  STATE.profile = null;
  STATE.municipioData = null;
  STATE.modalitaAggiungiSeggio = false;
  STATE.messaggi = [];

  chiudiModalLogout();
  $('#screen-dashboard').classList.remove('active');
  $('#screen-setup').classList.remove('active');
  $('#screen-login').classList.add('active');
  $('#btnLogout').hidden = true;
  $('#inputCodice').value = '';
  $('#loginTelefono').value = '';
  $('#loginErrore').hidden = true;
  window.scrollTo({ top: 0, behavior: 'auto' });
  requestAnimationFrame(() => $('#loginTelefono').focus());
  showToast('Sessione chiusa. Eventuali dati offline restano isolati e saranno visibili solo allo stesso codice dopo un nuovo accesso.');
}

// =======================================================================
// CONFERMAZIONI INTERNE (affidabili anche in modalità PWA)
// =======================================================================
let azioneConfermataCorrente = null;
let focusPrimaConfermaAzione = null;

function apriConfermaAzione(opzioni) {
  const modal = $('#modalConfermaAzione');
  if (!modal) return;
  focusPrimaConfermaAzione = document.activeElement;
  azioneConfermataCorrente = typeof opzioni.onConfirm === 'function' ? opzioni.onConfirm : null;
  $('#confermaAzioneKicker').textContent = opzioni.kicker || 'Conferma operazione';
  $('#confermaAzioneTitolo').textContent = opzioni.titolo || 'Sei sicuro?';
  $('#confermaAzioneTesto').textContent = opzioni.testo || '';
  const nota = $('#confermaAzioneNota');
  nota.textContent = opzioni.nota || '';
  nota.hidden = !opzioni.nota;
  const btn = $('#btnEseguiConfermaAzione');
  btn.textContent = opzioni.conferma || 'Conferma';
  btn.className = 'btn ' + (opzioni.pericolosa === false ? 'primary' : 'danger');
  modal.hidden = false;
  requestAnimationFrame(() => $('#btnAnnullaConfermaAzione').focus());
}

function chiudiConfermaAzione() {
  const modal = $('#modalConfermaAzione');
  if (modal) modal.hidden = true;
  azioneConfermataCorrente = null;
  if (focusPrimaConfermaAzione && typeof focusPrimaConfermaAzione.focus === 'function') focusPrimaConfermaAzione.focus();
  focusPrimaConfermaAzione = null;
}

function eseguiConfermaAzione() {
  const azione = azioneConfermataCorrente;
  const modal = $('#modalConfermaAzione');
  if (modal) modal.hidden = true;
  azioneConfermataCorrente = null;
  focusPrimaConfermaAzione = null;
  if (azione) azione();
}

// =======================================================================
// SCHERMATA 1 — SETUP PROFILO E SEZIONE
// =======================================================================
function popolaSelectMunicipi() {
  const sel = $('#selectMunicipio');
  sel.innerHTML = '<option value="">Seleziona&hellip;</option>';
  const attivi = new Set((STATE.config && STATE.config.municipi || []).filter(m => m.attivo).map(m => m.m));
  Object.keys(NOMI_MUNICIPI).sort().forEach((mu) => {
    const opt = document.createElement('option');
    opt.value = mu;
    opt.textContent = NOMI_MUNICIPI[mu] + (attivi.size && !attivi.has(mu) ? ' (non attivo)' : '');
    sel.appendChild(opt);
  });
}

async function onCambiaMunicipioSetup() {
  const mu = $('#selectMunicipio').value;
  const inputSezione = $('#inputSezione');
  const preview = $('#seggioPreview');
  if (!mu) {
    inputSezione.disabled = true;
    preview.textContent = 'Seleziona prima il municipio.';
    return;
  }
  inputSezione.disabled = false;
  preview.textContent = 'Carico le sezioni del municipio...';
  try {
    const data = await caricaDatiMunicipio(mu);
    STATE.municipioData = data;
    const dl = $('#sezioniList');
    dl.innerHTML = '';
    data.sezioni.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.s;
      opt.label = s.s + ' — ' + s.addr;
      dl.appendChild(opt);
    });
    preview.textContent = data.sezioni.length + ' sezioni disponibili. Digita il numero della tua sezione.';
  } catch (e) {
    preview.textContent = 'Non riesco a caricare le sezioni di questo municipio (verifica la connessione e riprova).';
  }
}

function onCambiaSezioneSetup() {
  const preview = $('#seggioPreview');
  const numero = $('#inputSezione').value.trim();
  if (!numero || !STATE.municipioData) return;
  const sez = trovaSezione(STATE.municipioData, numero);
  if (!sez) {
    preview.innerHTML = '<strong>Sezione non trovata</strong> in questo municipio. Controlla il numero oppure usa la ricerca per via qui sotto.';
    return;
  }
  preview.innerHTML = '<strong>Sezione ' + sez.s + '</strong><br>' + escapeHtml(sez.addr) + ' · CAP ' + escapeHtml(sez.cap);
}

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

async function onCercaVia() {
  const via = $('#searchVia').value;
  const civico = $('#searchCivico').value;
  const wrap = $('#risultatiVia');
  const mu = $('#selectMunicipio').value;
  if (!via.trim()) { wrap.innerHTML = '<p class="muted-text">Scrivi almeno il nome della via.</p>'; return; }
  if (!mu) { wrap.innerHTML = '<p class="muted-text">Seleziona prima un municipio qui sopra, poi cerca.</p>'; return; }
  wrap.innerHTML = '<p class="muted-text">Cerco&hellip;</p>';
  try {
    const data = STATE.municipioData && STATE.municipioData.m === mu ? STATE.municipioData : await caricaDatiMunicipio(mu);
    STATE.municipioData = data;
    const risultati = cercaPerVia(data, via, civico);
    if (!risultati.length) {
      wrap.innerHTML = '<p class="muted-text">Nessun risultato in questo municipio. Prova un altro municipio o controlla il nome della via.</p>';
      return;
    }
    wrap.innerHTML = '';
    risultati.slice(0, 12).forEach((r) => {
      const div = document.createElement('div');
      div.className = 'result-row';
      div.innerHTML = '<div class="info"><strong>Sezione ' + r.sezione + '</strong>' + escapeHtml(r.addr) +
        (r.speciale ? ' <em>(civico speciale: verifica a voce)</em>' : '') + '</div>';
      const btn = document.createElement('button');
      btn.className = 'btn'; btn.textContent = 'Usa questa';
      btn.onclick = () => { $('#inputSezione').value = r.sezione; onCambiaSezioneSetup(); wrap.innerHTML=''; };
      div.appendChild(btn);
      wrap.appendChild(div);
    });
  } catch (e) {
    wrap.innerHTML = '<p class="muted-text">Errore nella ricerca. Riprova.</p>';
  }
}

async function onConfermaSetup() {
  const errBox = $('#setupErrore');
  errBox.hidden = true;
  const nome = $('#inputNome').value.trim();
  const telefono = $('#inputTelefono').value.trim();
  const mu = $('#selectMunicipio').value;
  const sezioneInput = $('#inputSezione').value.trim();

  const errori = [];
  if (!nome) errori.push('Inserisci il tuo nome e cognome.');
  if (!telefono) errori.push('Inserisci un numero di telefono: serve al coordinamento per ricontattarti in caso di dubbi sui dati.');
  if (!mu) errori.push('Seleziona il municipio.');
  if (!sezioneInput) errori.push('Inserisci il numero della tua sezione.');

  let sez = null;
  if (mu && sezioneInput && STATE.municipioData) {
    sez = trovaSezione(STATE.municipioData, sezioneInput);
    if (!sez) errori.push('La sezione indicata non è stata trovata nel municipio selezionato.');
  }

  if (errori.length) {
    errBox.innerHTML = '<ul>' + errori.map((e) => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
    errBox.hidden = false;
    return;
  }

  STATE.persona = { nome, telefono };
  saveJSON(LS.PERSONA, STATE.persona);

  const id = idSeggio(mu, sez.s);
  const nuovoSeggio = { id, municipio: mu, sezione: sez.s, addr: sez.addr, cap: sez.cap,
    elettori: numOrNull($('#inputElettori').value) };
  const esistente = STATE.seggi.findIndex((s) => s.id === id);
  if (esistente !== -1) STATE.seggi[esistente] = nuovoSeggio;
  else STATE.seggi.push(nuovoSeggio);
  saveJSON(LS.SEGGI, STATE.seggi);

  STATE.seggioAttivoId = id;
  saveJSON(LS.SEGGIO_ATTIVO, id);
  ricostruisciProfileDaSeggioAttivo();

  // pulizia campi del form "aggiungi seggio" per un eventuale prossimo utilizzo
  $('#selectMunicipio').value = '';
  $('#inputSezione').value = '';
  $('#inputSezione').disabled = true;
  $('#inputElettori').value = '';
  $('#seggioPreview').textContent = 'Seleziona prima il municipio.';

  mostraDashboard();
}

// =======================================================================
// GESTIONE ELENCO SEGGI (un rappresentante può seguirne più di uno)
// =======================================================================
function predisponiSchermataSetup(modalitaAggiungi) {
  $('#screen-login').classList.remove('active');
  $('#screen-setup').classList.add('active');
  STATE.modalitaAggiungiSeggio = !!modalitaAggiungi;
  const haPersona = !!(STATE.persona && STATE.persona.nome);
  const haSeggi = STATE.seggi.length > 0;

  $('#cardSeggiEsistenti').hidden = !haSeggi;
  $('#btnAnnullaAggiungiSeggio').hidden = !haSeggi;
  renderElencoSeggi();

  if (haPersona && (modalitaAggiungi || ownerStorageId())) {
    $('#cardDatiPersona').hidden = true;
    $('#titoloNuovoSeggio').textContent = haSeggi ? 'Aggiungi un nuovo seggio' : 'Il tuo seggio';
  } else {
    $('#cardDatiPersona').hidden = false;
    $('#titoloDatiPersona').textContent = '1. I tuoi dati';
    $('#titoloNuovoSeggio').textContent = '2. Il tuo seggio';
    $('#inputNome').value = (STATE.persona && STATE.persona.nome) || '';
    $('#inputTelefono').value = (STATE.persona && STATE.persona.telefono) || '';
  }
}

function renderElencoSeggi() {
  const cont = $('#elencoSeggi');
  cont.innerHTML = '';
  if (!STATE.seggi.length) return;
  STATE.seggi.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'seggio-row' + (s.id === STATE.seggioAttivoId ? ' attivo' : '');
    row.innerHTML = '<div class="info"><strong>Sezione ' + escapeHtml(s.sezione) + ' · ' + escapeHtml(NOMI_MUNICIPI[s.municipio] || s.municipio) + '</strong>' +
      escapeHtml(s.addr) + '</div>' +
      '<div class="azioni"><button class="btn apri" data-id="' + s.id + '">Apri</button><button class="btn ghost rimuovi" data-id="' + s.id + '">Rimuovi</button></div>';
    cont.appendChild(row);
  });
  $$('#elencoSeggi .apri').forEach((b) => b.addEventListener('click', () => apriSeggio(b.dataset.id)));
  $$('#elencoSeggi .rimuovi').forEach((b) => b.addEventListener('click', () => rimuoviSeggio(b.dataset.id)));
}

function apriSeggio(id) {
  if (!trovaSeggio(id)) return;
  if (STATE.profile && timerBozzaScrutinio) salvaBozzaScrutinio(false, 'bozza');
  STATE.seggioAttivoId = id;
  saveJSON(LS.SEGGIO_ATTIVO, id);
  ricostruisciProfileDaSeggioAttivo();
  mostraDashboard();
}

function rimuoviSeggio(id) {
  const seg = trovaSeggio(id);
  if (!seg) return;
  apriConfermaAzione({
    kicker: 'Gestione seggi',
    titolo: 'Rimuovere la Sezione ' + seg.sezione + '?',
    testo: 'La sezione verrà rimossa soltanto da questo telefono.',
    nota: 'I dati già inviati al coordinamento restano salvati nel Google Sheet.',
    conferma: 'Rimuovi sezione',
    onConfirm: () => eseguiRimozioneSeggio(id),
  });
}

function eseguiRimozioneSeggio(id) {
  STATE.seggi = STATE.seggi.filter((s) => s.id !== id);
  saveJSON(LS.SEGGI, STATE.seggi);
  if (STATE.seggioAttivoId === id) {
    STATE.seggioAttivoId = STATE.seggi.length ? STATE.seggi[0].id : null;
    saveJSON(LS.SEGGIO_ATTIVO, STATE.seggioAttivoId);
    ricostruisciProfileDaSeggioAttivo();
  }
  if (STATE.seggi.length) {
    predisponiSchermataSetup(true);
  } else {
    $('#screen-dashboard').classList.remove('active');
    $('#screen-setup').classList.add('active');
    predisponiSchermataSetup(false);
  }
  showToast('Sezione rimossa da questo dispositivo.');
}

function onGestisciSeggi() {
  $('#screen-dashboard').classList.remove('active');
  $('#screen-setup').classList.add('active');
  predisponiSchermataSetup(true);
}

function onAnnullaAggiungiSeggio() {
  if (!STATE.seggioAttivoId && STATE.seggi.length) {
    STATE.seggioAttivoId = STATE.seggi[0].id;
    saveJSON(LS.SEGGIO_ATTIVO, STATE.seggioAttivoId);
    ricostruisciProfileDaSeggioAttivo();
  }
  if (!STATE.profile) return; // nessun seggio disponibile: resta sul setup
  $('#screen-setup').classList.remove('active');
  $('#screen-dashboard').classList.add('active');
  mostraDashboard();
}

function popolaSelectSeggioAttivo() {
  const sel = $('#selectSeggioAttivo');
  sel.innerHTML = '';
  STATE.seggi.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = 'Sezione ' + s.sezione + ' · ' + (NOMI_MUNICIPI[s.municipio] || s.municipio);
    if (s.id === STATE.seggioAttivoId) opt.selected = true;
    sel.appendChild(opt);
  });
}

function onCambiaSeggioAttivo() {
  apriSeggio($('#selectSeggioAttivo').value);
}

// =======================================================================
// SCHERMATA 2 — DASHBOARD
// =======================================================================
function mostraDashboard() {
  if (STATE.profile && !Number(STATE.profile.elettori)) {
    const recuperati = elettoriSezioneLocali_(STATE.profile.municipio, STATE.profile.sezione);
    if (recuperati > 0) {
      memorizzaElettoriSezioneLocali_(STATE.profile.municipio, STATE.profile.sezione, recuperati);
    }
  }

  $('#btnLogout').hidden = false;
  $('#screen-login').classList.remove('active');
  $('#screen-setup').classList.remove('active');
  $('#screen-dashboard').classList.add('active');
  popolaSelectSeggioAttivo();
  const indirizzo = [STATE.profile.addr, STATE.profile.cap ? 'CAP ' + STATE.profile.cap : ''].filter(Boolean).join(' · ');
  $('#seggioIndirizzo').textContent = indirizzo || 'Municipio IX Roma';
  renderElettoriBanner();
  renderAffluenza();
  renderScrutinioListeECandidati();
  caricaBozzaScrutinio();
  renderTabellaInvii();
  aggiornaBadgeInCoda();
  aggiornaPulsanteCorrezioneScrutinio();
  renderHomeDashboard();
  const appLabel = $('#appVersionLabel');
  const backendLabel = $('#backendVersionLabel');
  if (appLabel) appLabel.textContent = APP_VERSION;
  if (backendLabel) backendLabel.textContent = (STATE.config && STATE.config.app && STATE.config.app.backendVersion) || '—';
  caricaMessaggi(true);
  setTimeout(() => eseguiControlloDispositivo(false), 300);
}

function renderElettoriBanner() {
  const el = STATE.profile.elettori;
  $('#elettoriValore').textContent = el ? el : 'non indicati';
  $('#elettoriBanner').classList.toggle('warnings', !el);
  $('#btnModificaElettori').textContent = el ? 'modifica' : 'imposta';
  renderHomeDashboard();
}

function attivaTabPerNome(nome) {
  const tab = document.querySelector('.tab[data-tab="' + nome + '"]');
  if (!tab) return;
  tab.click();
  const dashboard = $('#screen-dashboard');
  if (dashboard) dashboard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function inviiCorrenti(queueKey) {
  if (!STATE.profile) return [];
  return loadJSON(queueKey, []).filter((it) => it.payload && it.payload.sezione === STATE.profile.sezione && it.payload.municipio === STATE.profile.municipio);
}

function ultimoInvioAttivo(queueKey) {
  const sostituiti = idsSostituiti(queueKey);
  return inviiCorrenti(queueKey).filter((it) => !sostituiti.has(it.idInvio)).sort((a, b) => (a.creato < b.creato ? 1 : -1))[0] || null;
}

function statoTimelineDaInvio(item) {
  if (!item) return { classe: 'todo', etichetta: 'Da inviare' };
  if (item.status === QUEUE_STATUS.CONFIRMED) return { classe: 'done', etichetta: 'Ricevuto' };
  if (item.status === QUEUE_STATUS.ACTION_REQUIRED) return { classe: 'error', etichetta: 'Da controllare' };
  return { classe: 'queued', etichetta: 'Sul telefono' };
}

function prossimaAzioneHome() {
  const aff = inviiCorrenti(LS.QUEUE_AFF);
  const scr = inviiCorrenti(LS.QUEUE_SCR);
  const conErrore = [...aff, ...scr].filter((it) => it.status === QUEUE_STATUS.ACTION_REQUIRED);
  if (conErrore.length) {
    return {
      classe: 'attention',
      titolo: conErrore.length === 1 ? '1 comunicazione richiede attenzione' : conErrore.length + ' comunicazioni richiedono attenzione',
      testo: 'I dati sono conservati sul telefono, ma serve un controllo prima della conferma del coordinamento.',
      tab: 'invii',
      bottone: 'Controlla invii'
    };
  }

  const mappaAff = invitiAffluenzaSezione();
  const mancanti = orariAffluenza().filter((o) => !mappaAff[chiaveAffluenza(o.giorno, o.orario)]);
  if (mancanti.length) {
    const ordinati = mancanti.map((o, index) => ({ o, index, data: dataScadenza(o.giorno, o.orario) }))
      .sort((a, b) => {
        if (a.data && b.data) return a.data - b.data;
        if (a.data) return -1;
        if (b.data) return 1;
        return a.index - b.index;
      });
    let scelta = ordinati.find((x) => x.data && x.data.getTime() >= Date.now()) || ordinati.find((x) => x.data) || ordinati[0];
    const scadenza = scelta && statoScadenza(scelta.o.giorno, scelta.o.orario, false);
    return {
      classe: scadenza && scadenza.classe === 'error' ? 'attention' : 'turnout',
      titolo: 'Affluenza ' + (scelta.o.orario || ''),
      testo: scadenza ? (scadenza.etichetta + ' · ' + scadenza.testo) : ((scelta.o.giorno || 'Rilevazione') + ' · inserisci i votanti e conferma'),
      tab: 'affluenza',
      bottone: 'Comunica affluenza'
    };
  }

  const ultimoScr = ultimoInvioAttivo(LS.QUEUE_SCR);
  if (!ultimoScr) {
    return { classe: 'scrutiny', titolo: 'Scrutinio della sezione', testo: 'Le affluenze previste risultano compilate. Quando inizia lo scrutinio puoi inserire i risultati.', tab: 'scrutinio', bottone: 'Apri scrutinio' };
  }
  if (ultimoScr.status !== QUEUE_STATUS.CONFIRMED) {
    return { classe: 'queued', titolo: 'Scrutinio salvato sul telefono', testo: 'Il lavoro è conservato. Apri lo stato invii per verificare la ricezione del coordinamento.', tab: 'invii', bottone: 'Verifica ricezione' };
  }
  return { classe: 'complete', titolo: 'Comunicazioni completate', testo: 'L’ultimo scrutinio risulta ricevuto dal coordinamento. Conserva l’app installata fino alla chiusura delle operazioni.', tab: 'invii', bottone: 'Vedi ricevute' };
}

function renderProssimaAzioneHome() {
  const card = $('#homeNextAction');
  if (!card || !STATE.profile) return;
  const azione = prossimaAzioneHome();
  card.className = 'next-action-card ' + azione.classe;
  $('#homeNextActionTitle').textContent = azione.titolo;
  $('#homeNextActionText').textContent = azione.testo;
  const btn = $('#homeNextActionButton');
  btn.textContent = azione.bottone;
  btn.dataset.targetTab = azione.tab;
}

function renderHomeDashboard() {
  if (!STATE.profile) return;
  const nome = (STATE.profile.nome || 'rappresentante').trim().split(/\s+/)[0];
  const nomeEl = $('#homeNome');
  const seggioEl = $('#homeSeggio');
  if (nomeEl) nomeEl.textContent = nome.charAt(0).toUpperCase() + nome.slice(1).toLowerCase();
  if (seggioEl) seggioEl.textContent = 'Municipio IX Roma · Sezione ' + STATE.profile.sezione;
  const elettori = $('#homeElettori');
  if (elettori) elettori.textContent = STATE.profile.elettori || '—';

  const aff = inviiCorrenti(LS.QUEUE_AFF);
  const scr = inviiCorrenti(LS.QUEUE_SCR);
  const pending = [...aff, ...scr].filter((it) => it.status !== QUEUE_STATUS.CONFIRMED).length;
  const pendingEl = $('#homePending');
  if (pendingEl) pendingEl.textContent = pending;

  const timeline = $('#homeTimeline');
  if (timeline) {
    timeline.innerHTML = '';
    const mappaAff = invitiAffluenzaSezione();
    const orari = orariAffluenza();
    const voci = orari.length ? orari.map((o) => {
      const status = mappaAff[chiaveAffluenza(o.giorno, o.orario)];
      let stato = statoTimelineDaInvio(status ? { status } : null);
      const scadenza = statoScadenza(o.giorno, o.orario, !!status);
      if (scadenza) stato = { classe: scadenza.classe, etichetta: scadenza.etichetta };
      const sotto = [o.giorno || 'Rilevazione', scadenza && scadenza.testo].filter(Boolean).join(' · ');
      return { titolo: 'Affluenza ' + (o.orario || ''), sottotitolo: sotto, ...stato };
    }) : [{ titolo: 'Affluenze', sottotitolo: 'Orari non ancora configurati', classe: aff.length ? statoTimelineDaInvio(ultimoInvioAttivo(LS.QUEUE_AFF)).classe : 'todo', etichetta: aff.length ? statoTimelineDaInvio(ultimoInvioAttivo(LS.QUEUE_AFF)).etichetta : 'Da programmare' }];
    let scrStato = statoTimelineDaInvio(ultimoInvioAttivo(LS.QUEUE_SCR));
    const scrData = impostazione('DATA_LUNEDI', '') || impostazione('DATA_DOMENICA', '');
    const scrOra = impostazione('ORARIO_SCRUTINIO', '23:30');
    const scrScadenza = scrData ? statoScadenza(scrData === impostazione('DATA_LUNEDI', '') ? 'Lunedì' : 'Domenica', scrOra, !!ultimoInvioAttivo(LS.QUEUE_SCR)) : null;
    if (scrScadenza) scrStato = { classe: scrScadenza.classe, etichetta: scrScadenza.etichetta };
    voci.push({ titolo: 'Scrutinio', sottotitolo: ['Risultati finali della sezione', scrScadenza && scrScadenza.testo].filter(Boolean).join(' · '), ...scrStato });
    voci.forEach((voce) => {
      const row = document.createElement('div');
      row.className = 'timeline-item ' + voce.classe;
      row.innerHTML = '<span class="timeline-dot" aria-hidden="true"></span><div><strong>' + escapeHtml(voce.titolo) + '</strong><small>' + escapeHtml(voce.sottotitolo) + '</small></div><span class="timeline-state">' + escapeHtml(voce.etichetta) + '</span>';
      timeline.appendChild(row);
    });
  }

  const ultimo = [...aff.map((x) => ({ ...x, tipoHome: 'Affluenza' })), ...scr.map((x) => ({ ...x, tipoHome: 'Scrutinio' }))].sort((a, b) => (a.creato < b.creato ? 1 : -1))[0];
  const ultimoEl = $('#homeUltimoInvio');
  if (ultimoEl) {
    if (!ultimo) {
      ultimoEl.innerHTML = '<span class="latest-empty">Nessun dato ancora salvato per questa sezione.</span>';
    } else {
      const quando = new Date(ultimo.creato).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
      const stato = statoTimelineDaInvio(ultimo);
      let dettaglio = ultimo.tipoHome === 'Affluenza' ? (ultimo.payload.orario + ' · ' + ultimo.payload.totale + ' votanti') : ((ultimo.payload.votanti || 0) + ' votanti · risultati scrutinio');
      ultimoEl.innerHTML = '<div class="latest-icon ' + stato.classe + '" aria-hidden="true">' + (ultimo.tipoHome === 'Affluenza' ? '%' : '▣') + '</div><div><strong>' + ultimo.tipoHome + '</strong><span>' + escapeHtml(dettaglio) + '</span><small>' + escapeHtml(quando) + ' · ' + escapeHtml(stato.etichetta) + '</small></div>';
    }
  }
  renderProssimaAzioneHome();
  aggiornaStatoConnessione();
}

let focusPrimaModalElettori = null;

function apriModalElettori() {
  if (!STATE.profile) return;
  focusPrimaModalElettori = document.activeElement;
  const input = $('#inputModificaElettori');
  const errore = $('#modificaElettoriErrore');
  input.value = STATE.profile.elettori || '';
  errore.hidden = true;
  errore.textContent = '';
  $('#modalElettori').hidden = false;
  requestAnimationFrame(() => {
    input.focus();
    input.select();
  });
}

function chiudiModalElettori() {
  const modal = $('#modalElettori');
  if (modal) modal.hidden = true;
  const errore = $('#modificaElettoriErrore');
  if (errore) {
    errore.hidden = true;
    errore.textContent = '';
  }
  if (focusPrimaModalElettori && typeof focusPrimaModalElettori.focus === 'function') {
    focusPrimaModalElettori.focus();
  }
  focusPrimaModalElettori = null;
}

function salvaElettoriDaModal() {
  if (!STATE.profile) return;
  const input = $('#inputModificaElettori');
  const errore = $('#modificaElettoriErrore');
  const n = interoNonNegativo(String(input.value || '').trim());
  if (n === null || n === 0) {
    errore.textContent = 'Inserisci un numero intero maggiore di zero.';
    errore.hidden = false;
    input.focus();
    return;
  }

  STATE.profile.elettori = n;
  const seg = trovaSeggio(STATE.seggioAttivoId);
  if (seg) {
    seg.elettori = n;
    saveJSON(LS.SEGGI, STATE.seggi);
  }

  // Elettori e votanti sono dati condivisi fra affluenza e scrutinio:
  // aggiorna anche il campo dello scrutinio e la relativa bozza.
  const scElettori = $('#scElettori');
  if (scElettori) scElettori.value = n;

  renderElettoriBanner();
  renderAffluenza();
  aggiornaAvvisiScrutinio();
  pianificaSalvataggioBozzaScrutinio();
  chiudiModalElettori();
  showToast('Elettori aventi diritto aggiornati: ' + n + '.');
}

function onModificaElettori() {
  apriModalElettori();
}

function initTabs() {
  const tabs = $all('.tab');
  function attiva(tab, spostaFocus) {
    tabs.forEach((t) => {
      const active = t === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
      t.tabIndex = active ? 0 : -1;
      const panel = $('#tab-' + t.dataset.tab);
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
    const dashboard = $('#screen-dashboard');
    if (dashboard) dashboard.dataset.activeTab = tab.dataset.tab;
    // La tabella deve riflettere sempre la coda locale corrente, anche quando
    // l'invio è stato creato offline mentre la scheda Invii non era aperta.
    if (tab.dataset.tab === 'invii' && STATE.profile) {
      renderTabellaInvii();
      aggiornaBadgeInCoda();
    }
    if (spostaFocus) tab.focus();
  }
  tabs.forEach((tab, index) => {
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'tab-' + tab.dataset.tab);
    tab.addEventListener('click', () => attiva(tab, false));
    tab.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      let next = index;
      if (e.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (e.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (e.key === 'Home') next = 0;
      if (e.key === 'End') next = tabs.length - 1;
      attiva(tabs[next], true);
    });
  });
  attiva(tabs.find((t) => t.classList.contains('active')) || tabs[0], false);
}

// ---------------------------- AFFLUENZA --------------------------------
function chiaveAffluenza(giorno, orario) { return giorno + '|' + orario; }

function renderAffluenza() {
  const cont = $('#orariAffluenza');
  cont.innerHTML = '';
  const orari = orariAffluenza();
  const inviati = invitiAffluenzaSezione();
  if (!orari.length) {
    cont.innerHTML = '<p class="muted-text">Il coordinamento non ha ancora configurato gli orari di rilevazione. Puoi comunque inviare una rilevazione libera più sotto.</p>';
  }
  orari.forEach((o) => {
    const key = chiaveAffluenza(o.giorno, o.orario);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (inviati[key] ? ' inviato' : '');
    chip.textContent = (o.giorno ? o.giorno + ' ' : '') + o.orario + (inviati[key] ? ' ✓' : '');
    chip.onclick = () => apriFormAffluenza(o.giorno, o.orario);
    cont.appendChild(chip);
  });
  renderTabellaAffluenza();
}

let affluenzaCorrente = null;
let modalitaAffluenzaCorrente = 'rapido';
let correzioneAffluenzaId = null;
let tentativoAffluenzaDaSostituireId = null;

function apriFormAffluenza(giorno, orario) {
  affluenzaCorrente = { giorno, orario };
  $('#affluenzaOrarioTitolo').textContent = 'Rilevazione: ' + (giorno ? giorno + ' ' : '') + orario;
  $('#affTotaleVotanti').value = '';
  $('#affMaschi').value = '';
  $('#affFemmine').value = '';
  $('#affNote').value = '';
  $('#affMotivoCorrezione').value = '';
  $('#affCorrezioneBox').hidden = true;
  correzioneAffluenzaId = null;
  tentativoAffluenzaDaSostituireId = null;
  impostaModalitaAffluenza('rapido');
  aggiornaTotaleAffluenza();
  $('#formAffluenza').hidden = false;
}
function chiudiFormAffluenza() { $('#formAffluenza').hidden = true; affluenzaCorrente = null; correzioneAffluenzaId = null; tentativoAffluenzaDaSostituireId = null; $('#affCorrezioneBox').hidden = true; }

function impostaModalitaAffluenza(modo) {
  modalitaAffluenzaCorrente = modo;
  $$('#modalitaAffluenza .chip').forEach((c) => c.classList.toggle('selected', c.dataset.modalita === modo));
  $('#affRapido').hidden = modo !== 'rapido';
  $('#affDettaglio').hidden = modo !== 'dettaglio';
  aggiornaTotaleAffluenza();
}

function totaleAffluenzaCorrente() {
  if (modalitaAffluenzaCorrente === 'rapido') return numOr0($('#affTotaleVotanti').value);
  return numOr0($('#affMaschi').value) + numOr0($('#affFemmine').value);
}

function aggiornaTotaleAffluenza() {
  const tot = totaleAffluenzaCorrente();
  const el = STATE.profile.elettori;
  let testo = 'Totale votanti: ' + tot;
  if (el) testo += ' &nbsp;·&nbsp; Affluenza: ' + percentuale(tot, el) + '%';
  $('#affTotaleBox').innerHTML = testo;
}

function percentuale(parte, totale) {
  if (!totale) return '—';
  return Math.round((parte / totale) * 1000) / 10;
}

function elettoriSezioneLocali_(municipio, sezione) {
  const mu = String(municipio || '');
  const sez = String(sezione || '');

  if (STATE.profile &&
      STATE.profile.municipio === mu &&
      STATE.profile.sezione === sez &&
      Number(STATE.profile.elettori) > 0) {
    return Number(STATE.profile.elettori);
  }

  const seg = STATE.seggi.find((s) =>
    String(s.municipio || '') === mu &&
    String(s.sezione || '') === sez &&
    Number(s.elettori) > 0
  );
  if (seg) return Number(seg.elettori);

  const candidati = [
    ...loadJSON(LS.QUEUE_AFF, []),
    ...loadJSON(LS.QUEUE_SCR, [])
  ].filter((it) =>
    it && it.payload &&
    String(it.payload.municipio || '') === mu &&
    String(it.payload.sezione || '') === sez
  ).sort((a, b) => (a.creato < b.creato ? 1 : -1));

  for (const it of candidati) {
    const daPayload = Number(it.payload && it.payload.elettori);
    if (Number.isFinite(daPayload) && daPayload > 0) return daPayload;

    const daServer = Number(it.rispostaServer && it.rispostaServer.elettori);
    if (Number.isFinite(daServer) && daServer > 0) return daServer;
  }

  return 0;
}

function memorizzaElettoriSezioneLocali_(municipio, sezione, elettori) {
  const n = Number(elettori);
  if (!Number.isFinite(n) || n <= 0) return false;

  const mu = String(municipio || '');
  const sez = String(sezione || '');
  let cambiato = false;

  const seg = STATE.seggi.find((s) =>
    String(s.municipio || '') === mu &&
    String(s.sezione || '') === sez
  );
  if (seg && Number(seg.elettori) !== n) {
    seg.elettori = n;
    cambiato = true;
  }

  if (STATE.profile &&
      String(STATE.profile.municipio || '') === mu &&
      String(STATE.profile.sezione || '') === sez &&
      Number(STATE.profile.elettori) !== n) {
    STATE.profile.elettori = n;
    cambiato = true;
  }

  if (cambiato) saveJSON(LS.SEGGI, STATE.seggi);
  return cambiato;
}

function invitiAffluenzaSezione() {
  const tutti = loadJSON(LS.QUEUE_AFF, []);
  const mappa = {};
  tutti.filter((it) => it.payload.sezione === STATE.profile.sezione && it.payload.municipio === STATE.profile.municipio)
    .forEach((it) => { mappa[chiaveAffluenza(it.payload.giorno, it.payload.orario)] = it.status; });
  return mappa;
}

async function onInviaAffluenza() {
  if (!affluenzaCorrente) return;
  const errBox = $('#affluenzaErrori');
  errBox.hidden = true;
  const dettaglio = modalitaAffluenzaCorrente === 'dettaglio';
  const totaleInput = dettaglio ? null : interoNonNegativo($('#affTotaleVotanti').value);
  const maschi = dettaglio ? interoNonNegativo($('#affMaschi').value) : null;
  const femmine = dettaglio ? interoNonNegativo($('#affFemmine').value) : null;
  const totale = dettaglio && maschi !== null && femmine !== null ? maschi + femmine : totaleInput;
  const errori = [];

  impostaNonValido($('#affTotaleVotanti'), !dettaglio && totaleInput === null);
  impostaNonValido($('#affMaschi'), dettaglio && maschi === null);
  impostaNonValido($('#affFemmine'), dettaglio && femmine === null);
  if (totale === null) errori.push('Inserisci votanti usando numeri interi uguali o maggiori di zero.');
  if (STATE.profile.elettori && totale !== null && totale > STATE.profile.elettori) errori.push('I votanti non possono superare gli elettori iscritti.');
  if (correzioneAffluenzaId && !$('#affMotivoCorrezione').value.trim()) errori.push('Indica il motivo della correzione.');

  const precedenti = loadJSON(LS.QUEUE_AFF, []).filter((it) =>
    it.payload.municipio === STATE.profile.municipio && it.payload.sezione === STATE.profile.sezione &&
    it.payload.giorno === affluenzaCorrente.giorno && it.payload.orario === affluenzaCorrente.orario &&
    it.idInvio !== tentativoAffluenzaDaSostituireId &&
    !idsSostituiti(LS.QUEUE_AFF).has(it.idInvio)
  );
  if (precedenti.length && !correzioneAffluenzaId) errori.push('Esiste già una rilevazione per questo orario. Usa “Correggi” nella tabella.');
  if (errori.length) {
    errBox.innerHTML = '<ul>' + errori.map((e) => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
    errBox.hidden = false;
    return;
  }

  const payload = {
    tipo: 'affluenza', idInvio: tentativoAffluenzaDaSostituireId || uuid(),     municipio: STATE.profile.municipio, sezione: STATE.profile.sezione,
    telefono: STATE.profile.telefono,
    giorno: affluenzaCorrente.giorno, orario: affluenzaCorrente.orario,
    elettori: elettoriSezioneLocali_(STATE.profile.municipio, STATE.profile.sezione) || null,
    maschi, femmine, totale,
    note: $('#affNote').value.trim(),
    correzioneDi: correzioneAffluenzaId || '',
    motivoCorrezione: correzioneAffluenzaId ? $('#affMotivoCorrezione').value.trim() : '',
    versioneApp: APP_VERSION,
  };
  const tentativoDaSostituire = tentativoAffluenzaDaSostituireId;
  const salvato = tentativoDaSostituire
    ? sostituisciInvioInCoda(LS.QUEUE_AFF, tentativoDaSostituire, payload)
    : accodaInvio(LS.QUEUE_AFF, payload);
  if (!salvato) {
    errBox.textContent = 'Spazio di archiviazione del telefono non disponibile. Non chiudere la pagina e libera spazio prima di riprovare.';
    errBox.hidden = false;
    return;
  }
  const id = payload.idInvio;
  chiudiFormAffluenza();
  renderAffluenza();
  // Aggiorna subito anche lo storico locale. Quando il dispositivo è offline,
  // provaSvuotaCode() termina prima del blocco finally e, senza questo render,
  // il badge della coda si aggiornava ma la tabella “Stato invii” restava vuota.
  renderTabellaInvii();
  aggiornaBadgeInCoda();
  showToast(navigator.onLine ? 'Salvato sul telefono. Verifico la ricezione…' : 'Salvato sul telefono. Sarà inviato quando torna la rete.');
  await provaSvuotaCode();
  const item = trovaItem(LS.QUEUE_AFF, id);
  if (item && item.status === QUEUE_STATUS.CONFIRMED) showToast('Rilevazione ricevuta dal coordinamento.');
  else if (item && item.status === QUEUE_STATUS.ACTION_REQUIRED) showToast('Salvata sul telefono, ma non ancora ricevuta. Controlla “I miei invii”.', 4500);
}

function renderTabellaAffluenza() {
  const tbody = $('#tabellaAffluenza tbody');
  tbody.innerHTML = '';
  const sostituiti = idsSostituiti(LS.QUEUE_AFF);
  const tutti = loadJSON(LS.QUEUE_AFF, [])
    .filter((it) => it.payload.sezione === STATE.profile.sezione && it.payload.municipio === STATE.profile.municipio)
    .sort((a, b) => (a.creato < b.creato ? 1 : -1));
  if (!tutti.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="muted-text">Nessuna rilevazione ancora salvata.</td></tr>';
    return;
  }
  tutti.forEach((it) => {
    const p = it.payload;
    const el = Number(p.elettori) > 0
      ? Number(p.elettori)
      : elettoriSezioneLocali_(p.municipio, p.sezione);

    const percentualeServer = Number(
      (it.rispostaServer && it.rispostaServer.percentuale !== undefined)
        ? it.rispostaServer.percentuale
        : p.percentuale
    );
    const perc = Number.isFinite(percentualeServer)
      ? percentualeServer + '%'
      : (el ? percentuale(p.totale, el) + '%' : '—');

    const superato = sostituiti.has(it.idInvio);
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml((p.giorno ? p.giorno + ' ' : '') + p.orario) + '</td><td>' + (p.maschi ?? '—') +
      '</td><td>' + (p.femmine ?? '—') + '</td><td>' + p.totale + '</td><td>' + perc + '</td><td>' +
      (superato ? '<span class="pill neutral">sostituito</span>' : statoPillHtml(it.status)) + '</td><td></td>';
    if (!superato) {
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'btn ghost small'; btn.textContent = 'Correggi';
      btn.addEventListener('click', () => correggiAffluenza(it.idInvio));
      tr.lastElementChild.appendChild(btn);
    }
    tbody.appendChild(tr);
  });
}

function correggiAffluenza(idInvio) {
  const item = trovaItem(LS.QUEUE_AFF, idInvio);
  if (!item || !item.payload) return;
  const p = item.payload;
  apriFormAffluenza(p.giorno, p.orario);
  const giaRicevuto = item.status === QUEUE_STATUS.CONFIRMED;
  correzioneAffluenzaId = giaRicevuto ? idInvio : null;
  tentativoAffluenzaDaSostituireId = giaRicevuto ? null : idInvio;
  $('#affCorrezioneBox').hidden = !giaRicevuto;
  $('#affNote').value = p.note || '';
  if (p.maschi !== null && p.maschi !== undefined && p.femmine !== null && p.femmine !== undefined) {
    impostaModalitaAffluenza('dettaglio');
    $('#affMaschi').value = p.maschi;
    $('#affFemmine').value = p.femmine;
  } else {
    impostaModalitaAffluenza('rapido');
    $('#affTotaleVotanti').value = p.totale;
  }
  aggiornaTotaleAffluenza();
  $('#formAffluenza').scrollIntoView({ behavior: 'smooth', block: 'start' });
  (giaRicevuto ? $('#affMotivoCorrezione') : (modalitaAffluenzaCorrente === 'rapido' ? $('#affTotaleVotanti') : $('#affMaschi'))).focus();
}

function statoPillHtml(status) {
  const meta = window.SeggioUI ? window.SeggioUI.queueMeta(status) : null;
  if (meta) return '<span class="pill ' + meta.pill + '">' + escapeHtml(meta.label) + '</span>';
  if (status === QUEUE_STATUS.CONFIRMED) return '<span class="pill good">Ricevuto dal coordinamento</span>';
  if (status === QUEUE_STATUS.SENDING) return '<span class="pill neutral">Invio in corso…</span>';
  if (status === QUEUE_STATUS.ACTION_REQUIRED) return '<span class="pill bad">Richiede attenzione</span>';
  return '<span class="pill warn">Salvato sul telefono</span>';
}

// ---------------------------- SCRUTINIO ---------------------------------
function renderScrutinioListeECandidati() {
  renderDynList('#sindaciContainer', sindaci(), 'si');
  renderDynList('#presidentiContainer', presidentiMunicipioAttuale(), 'pr');
  renderDynList('#listeCapitolinaContainer', listeCapitolina(), 'lc');
  renderDynList('#listeMunicipioContainer', listeMunicipioAttuale(), 'lm');
  renderDynList('#preferenzeCapitolinaContainer', candidatiCapitolina(), 'pc');
  renderDynList('#preferenzeMunicipioContainer', candidatiMunicipioAttuale(), 'pm');
}

function renderDynList(selector, voci, prefix) {
  const cont = $(selector);
  if (!cont) return;
  if (window.SeggioUI) window.SeggioUI.clearNode(cont);
  else cont.textContent = '';
  if (!voci.length) {
    const empty = document.createElement('p');
    empty.className = 'dyn-empty';
    empty.textContent = 'Non ancora configurato dal coordinamento.';
    cont.appendChild(empty);
    return;
  }
  voci.forEach((nome, idx) => {
    const row = document.createElement('div');
    row.className = 'dyn-row';
    const id = prefix + '_' + idx;
    const label = document.createElement('label');
    label.htmlFor = id;
    label.textContent = nome;
    const input = document.createElement('input');
    input.id = id;
    input.type = 'number';
    input.min = '0';
    input.step = '1';
    input.inputMode = 'numeric';
    input.dataset.nome = nome;
    input.value = '0';
    row.append(label, input);
    cont.appendChild(row);
  });
}

function leggiDynList(prefix) {
  return $all('[id^="' + prefix + '_"]').map((inp) => ({ nome: inp.dataset.nome, voti: numOr0(inp.value) }));
}

function raccogliScrutinio() {
  return {
    elettori: numOr0($('#scElettori').value),
    votanti: numOr0($('#scVotanti').value),
    comune: {
      valide: numOr0($('#comValide').value), bianche: numOr0($('#comBianche').value),
      nulle: numOr0($('#comNulle').value), contestate: numOr0($('#comContestate').value),
      liste: leggiDynList('lc'), preferenze: leggiDynList('pc'),
    },
    municipio: {
      valide: numOr0($('#munValide').value), bianche: numOr0($('#munBianche').value),
      nulle: numOr0($('#munNulle').value), contestate: numOr0($('#munContestate').value),
      liste: leggiDynList('lm'), preferenze: leggiDynList('pm'),
    },
    note: $('#scNote').value.trim(),
  };
}

function sommaVoci(voci) {
  return (voci || []).reduce((tot, voce) => tot + numOr0(voce && voce.voti), 0);
}

function totaleScheda(blocco) {
  return numOr0(blocco.valide) + numOr0(blocco.bianche) + numOr0(blocco.nulle) + numOr0(blocco.contestate);
}

function validaScrutinio(s) {
  const errori = [], avvisi = [];
  const numerici = $all('#tab-scrutinio input[type="number"]');
  const invalidi = numerici.filter((el) => haValore(el.value) && interoNonNegativo(el.value) === null);
  numerici.forEach((el) => impostaNonValido(el, invalidi.includes(el)));
  if (invalidi.length) errori.push('Tutti i conteggi devono essere numeri interi non negativi.');
  if (!haValore($('#scElettori').value) || s.elettori <= 0) errori.push('Inserisci il numero di elettori iscritti.');
  if (!haValore($('#scVotanti').value)) errori.push('Inserisci il numero di votanti totali.');
  if (s.votanti > s.elettori) errori.push('I votanti non possono superare gli elettori iscritti.');

  ['comune', 'municipio'].forEach((k) => {
    const blocco = s[k];
    const nomeScheda = k === 'comune' ? 'Comune' : 'Municipio';
    const sommaSchede = totaleScheda(blocco);
    const sommaListe = sommaVoci(blocco.liste);
    const prefixCandidati = k === 'comune' ? 'si' : 'pr';
    const campiCandidati = $all('[id^="' + prefixCandidati + '_"]');
    const sommaCandidati = sommaVoci(leggiDynList(prefixCandidati));

    if (sommaSchede !== s.votanti) {
      const differenza = sommaSchede - s.votanti;
      errori.push('Scheda ' + nomeScheda + ': valide + bianche + nulle + contestate (' + sommaSchede + ') deve coincidere con i votanti (' + s.votanti + '). Differenza: ' + (differenza > 0 ? '+' : '') + differenza + '.');
    }
    if (sommaListe > blocco.valide) {
      errori.push('Scheda ' + nomeScheda + ': la somma dei voti di lista (' + sommaListe + ') supera le schede valide (' + blocco.valide + ').');
    }
    if (sommaCandidati > blocco.valide) {
      errori.push('Scheda ' + nomeScheda + ': la somma dei voti ai candidati (' + sommaCandidati + ') supera le schede valide (' + blocco.valide + ').');
    } else if (campiCandidati.length && blocco.valide > 0 && sommaCandidati !== blocco.valide) {
      avvisi.push('Scheda ' + nomeScheda + ': i voti complessivi ai candidati sono ' + sommaCandidati + ', mentre le schede valide sono ' + blocco.valide + '.');
    }
  });
  return { errori, avvisi };
}

function aggiornaContatoreScheda(id, detailId, nome, blocco, votanti) {
  const box = $(id);
  if (!box) return;
  const totale = totaleScheda(blocco);
  const differenza = votanti - totale;
  box.className = 'count-check ' + (!votanti && !totale ? 'neutral' : differenza === 0 ? 'good' : differenza > 0 ? 'warn' : 'bad');
  if (!votanti) box.textContent = 'Totale schede ' + nome + ': ' + totale + ' · inserisci i votanti per il confronto';
  else if (differenza === 0) box.textContent = '✓ Totale schede ' + nome + ': ' + totale + ' · coincide con i votanti';
  else if (differenza > 0) box.textContent = '⚠ Totale schede ' + nome + ': ' + totale + ' · mancano ' + differenza + ' rispetto ai votanti';
  else box.textContent = '⚠ Totale schede ' + nome + ': ' + totale + ' · supera i votanti di ' + Math.abs(differenza);

  const detail = $(detailId);
  if (detail) {
    detail.textContent = 'Valide ' + numOr0(blocco.valide) + ' · Bianche ' + numOr0(blocco.bianche) + ' · Nulle ' + numOr0(blocco.nulle) + ' · Contestate ' + numOr0(blocco.contestate);
  }
  return { totale, differenza };
}

function aggiornaRiepiloghiLive() {
  if (!STATE.profile) return;
  const s = raccogliScrutinio();
  const comune = aggiornaContatoreScheda('#comTotaleLive', '#comCheckDetail', 'Comune', s.comune, s.votanti);
  const municipio = aggiornaContatoreScheda('#munTotaleLive', '#munCheckDetail', 'Municipio', s.municipio, s.votanti);
  const final = $('#scrutinyFinalChecks');
  if (final) {
    const checks = [
      { ok: s.elettori > 0 && s.votanti >= 0 && s.votanti <= s.elettori, testo: s.elettori > 0 ? ('Elettori ' + s.elettori + ' · votanti ' + s.votanti) : 'Inserisci elettori e votanti' },
      { ok: !!comune && s.votanti > 0 && comune.differenza === 0, testo: 'Scheda Comune: ' + (comune ? comune.totale : 0) + ' schede' },
      { ok: !!municipio && s.votanti > 0 && municipio.differenza === 0, testo: 'Scheda Municipio: ' + (municipio ? municipio.totale : 0) + ' schede' }
    ];
    final.innerHTML = checks.map((c) => '<div class="final-check ' + (c.ok ? 'good' : 'warn') + '"><span aria-hidden="true">' + (c.ok ? '✓' : '!') + '</span><strong>' + escapeHtml(c.testo) + '</strong></div>').join('');
  }
  aggiornaStatoPassaggiScrutinio(s, comune, municipio);
}

function aggiornaStatoPassaggiScrutinio(s, comune, municipio) {
  const states = [
    s.elettori > 0 && haValore($('#scVotanti').value) && s.votanti <= s.elettori,
    !!comune && s.votanti > 0 && comune.differenza === 0,
    !!municipio && s.votanti > 0 && municipio.differenza === 0,
    false
  ];
  $$('.scrutiny-step').forEach((btn, index) => {
    btn.classList.toggle('complete', !!states[index]);
    btn.setAttribute('aria-label', (states[index] ? 'Completato: ' : '') + btn.textContent.trim());
  });
}

function aggiornaAvvisiScrutinio() {
  const s = raccogliScrutinio();
  const { avvisi } = validaScrutinio(s);
  aggiornaRiepiloghiLive();
  const box = $('#scrutinioAvviso');
  if (avvisi.length) {
    box.innerHTML = '<strong>Controlli da verificare</strong><ul>' + avvisi.map((a) => '<li>' + escapeHtml(a) + '</li>').join('') + '</ul>';
    box.hidden = false;
  } else { box.hidden = true; }
}

function chiaveBozza() {
  return STATE.profile ? LS.SCR_DRAFT(STATE.profile.municipio, STATE.profile.sezione) : '';
}

let timerBozzaScrutinio = null;
let caricamentoBozzaInCorso = false;

function estraiDocumentoBozza(documento) {
  if (!documento) return null;
  if (documento.payload && documento.salvataIl) return documento;
  return { versione: 1, salvataIl: '', stato: 'bozza', idInvio: '', payload: documento };
}

function bozzaHaContenuto(p) {
  if (!p) return false;
  const base = [p.elettori, p.votanti, p.comune && p.comune.valide, p.comune && p.comune.bianche,
    p.comune && p.comune.nulle, p.comune && p.comune.contestate, p.municipio && p.municipio.valide,
    p.municipio && p.municipio.bianche, p.municipio && p.municipio.nulle, p.municipio && p.municipio.contestate];
  return base.some((v) => numOr0(v) > 0) || !!String(p.note || '').trim() ||
    sommaVoci(p.comune && p.comune.liste) > 0 || sommaVoci(p.comune && p.comune.preferenze) > 0 ||
    sommaVoci(p.municipio && p.municipio.liste) > 0 || sommaVoci(p.municipio && p.municipio.preferenze) > 0;
}

function aggiornaStatoBozzaScrutinio(stato, dataIso) {
  const box = $('#bozzaScrutinioStatus');
  const testo = $('#bozzaScrutinioTesto');
  const elimina = $('#btnEliminaBozzaScrutinio');
  if (!box || !testo) return;
  box.className = 'draft-status ' + (stato || '');
  if (stato === 'saving') testo.textContent = 'Salvataggio automatico delle modifiche…';
  else if (stato === 'sent') testo.textContent = 'Dati sincronizzati con il coordinamento' + (dataIso ? ' alle ' + new Date(dataIso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) : '') + '.';
  else if (stato === 'queued') testo.textContent = 'Dati salvati sul telefono e in attesa di sincronizzazione.';
  else if (stato === 'error') testo.textContent = 'Bozza salvata. L’ultimo invio richiede attenzione nella scheda “I miei invii”.';
  else if (dataIso) testo.textContent = 'Bozza salvata automaticamente alle ' + new Date(dataIso).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) + '.';
  else testo.textContent = 'Bozza pronta per il salvataggio automatico.';
  if (elimina) elimina.hidden = !dataIso;
}

function salvaBozzaScrutinio(manuale, stato, idInvio) {
  if (!STATE.profile || caricamentoBozzaInCorso) return false;
  clearTimeout(timerBozzaScrutinio);
  timerBozzaScrutinio = null;
  const payload = raccogliScrutinio();
  const adesso = new Date().toISOString();
  const documentoPrecedente = estraiDocumentoBozza(loadJSON(chiaveBozza(), null));
  const documento = {
    versione: 2,
    salvataIl: adesso,
    stato: stato || (documentoPrecedente && documentoPrecedente.stato) || 'bozza',
    idInvio: idInvio || (documentoPrecedente && documentoPrecedente.idInvio) || '',
    sincronizzatoIl: documentoPrecedente && documentoPrecedente.sincronizzatoIl || '',
    payload,
  };
  const ok = saveJSON(chiaveBozza(), documento);
  if (ok) aggiornaStatoBozzaScrutinio(documento.stato === 'sincronizzato' ? 'sent' : documento.stato === 'in_coda' ? 'queued' : 'saved', documento.stato === 'sincronizzato' ? documento.sincronizzatoIl : adesso);
  if (manuale) showToast(ok ? 'Bozza salvata sul telefono.' : 'Impossibile salvare la bozza sul telefono.');
  return ok;
}

function pianificaSalvataggioBozzaScrutinio() {
  if (!STATE.profile || caricamentoBozzaInCorso) return;
  aggiornaStatoBozzaScrutinio('saving', '');
  clearTimeout(timerBozzaScrutinio);
  timerBozzaScrutinio = setTimeout(() => {
    timerBozzaScrutinio = null;
    salvaBozzaScrutinio(false, 'bozza');
  }, 650);
}

function resetCampiScrutinio() {
  caricamentoBozzaInCorso = true;
  ['#scElettori','#scVotanti','#comValide','#comBianche','#comNulle','#comContestate','#munValide','#munBianche','#munNulle','#munContestate'].forEach((sel) => {
    const el = $(sel); if (el) el.value = '';
  });
  $('#scNote').value = '';
  $all('#tab-scrutinio .dynamic-list input[type="number"]').forEach((el) => { el.value = '0'; });
  caricamentoBozzaInCorso = false;
}

function caricaBozzaScrutinio() {
  clearTimeout(timerBozzaScrutinio);
  resetCampiScrutinio();
  const documento = estraiDocumentoBozza(loadJSON(chiaveBozza(), null));
  if (!documento || !documento.payload) {
    if (STATE.profile && STATE.profile.elettori) $('#scElettori').value = STATE.profile.elettori;
    aggiornaStatoBozzaScrutinio('', '');
    aggiornaAvvisiScrutinio();
    return;
  }
  const bozza = documento.payload;
  caricamentoBozzaInCorso = true;
  $('#scElettori').value = bozza.elettori ?? '';
  $('#scVotanti').value = bozza.votanti ?? '';
  $('#comValide').value = (bozza.comune && bozza.comune.valide) ?? '';
  $('#comBianche').value = (bozza.comune && bozza.comune.bianche) ?? '';
  $('#comNulle').value = (bozza.comune && bozza.comune.nulle) ?? '';
  $('#comContestate').value = (bozza.comune && bozza.comune.contestate) ?? '';
  $('#munValide').value = (bozza.municipio && bozza.municipio.valide) ?? '';
  $('#munBianche').value = (bozza.municipio && bozza.municipio.bianche) ?? '';
  $('#munNulle').value = (bozza.municipio && bozza.municipio.nulle) ?? '';
  $('#munContestate').value = (bozza.municipio && bozza.municipio.contestate) ?? '';
  $('#scNote').value = bozza.note || '';
  impostaDynPerNome('lc', bozza.comune && bozza.comune.liste || []);
  impostaDynPerNome('lm', bozza.municipio && bozza.municipio.liste || []);
  impostaDynPerNome('pc', bozza.comune && bozza.comune.preferenze || []);
  impostaDynPerNome('pm', bozza.municipio && bozza.municipio.preferenze || []);
  caricamentoBozzaInCorso = false;
  const statoVisuale = documento.stato === 'sincronizzato' ? 'sent' : documento.stato === 'in_coda' ? 'queued' : documento.stato === 'errore' ? 'error' : 'saved';
  aggiornaStatoBozzaScrutinio(statoVisuale, documento.stato === 'sincronizzato' ? documento.sincronizzatoIl : documento.salvataIl);
  aggiornaAvvisiScrutinio();
}

function eliminaBozzaScrutinio() {
  if (!STATE.profile) return;
  apriConfermaAzione({
    kicker: 'Bozza scrutinio',
    titolo: 'Eliminare la bozza?',
    testo: 'I campi non ancora inviati verranno svuotati su questo dispositivo.',
    nota: 'Gli invii già ricevuti dal coordinamento non verranno cancellati.',
    conferma: 'Elimina bozza',
    onConfirm: eseguiEliminazioneBozzaScrutinio,
  });
}

function eseguiEliminazioneBozzaScrutinio() {
  removeJSON(chiaveBozza());
  resetCampiScrutinio();
  if (STATE.profile.elettori) $('#scElettori').value = STATE.profile.elettori;
  aggiornaStatoBozzaScrutinio('', '');
  aggiornaAvvisiScrutinio();
  renderHomeDashboard();
  showToast('Bozza eliminata dal telefono.');
}

function aggiornaDocumentoBozzaDaInvio(item, stato) {
  if (!item || !item.payload) return;
  const key = LS.SCR_DRAFT(item.payload.municipio, item.payload.sezione);
  const documento = estraiDocumentoBozza(loadJSON(key, null));
  if (!documento || documento.idInvio !== item.idInvio) return;
  documento.stato = stato;
  if (stato === 'sincronizzato') documento.sincronizzatoIl = item.sincronizzatoIl || new Date().toISOString();
  saveJSON(key, documento);
}

function scrutinioGiaInviato() {
  const tutti = loadJSON(LS.QUEUE_SCR, []);
  return tutti.some((it) => it.payload.sezione === STATE.profile.sezione && it.payload.municipio === STATE.profile.municipio);
}

function aggiornaBadgeScrutinio() {
  const badge = $('#scrutinioBadge');
  const ultimo = ultimoScrutinioAttivo();
  if (!ultimo) { badge.textContent = 'non inviato'; badge.className = 'pill neutral'; return; }
  if (ultimo.status === QUEUE_STATUS.CONFIRMED) { badge.textContent = ultimo.payload.correzioneDi ? 'correzione sincronizzata' : 'inviato e sincronizzato'; badge.className = 'pill good'; }
  else if (ultimo.status === QUEUE_STATUS.ACTION_REQUIRED) { badge.textContent = 'salvato, da riprovare'; badge.className = 'pill bad'; }
  else { badge.textContent = 'salvato sul telefono'; badge.className = 'pill warn'; }
}

let payloadScrutinioPronto = null;
let correzioneScrutinioId = null;
let tentativoScrutinioDaSostituireId = null;

async function onInviaScrutinio() {
  const errBox = $('#scrutinioErrori');
  errBox.hidden = true;

  // Uno scrutinio già ricevuto non può essere reinviato come nuovo record.
  // Per modificarlo è obbligatorio entrare dal pulsante “Correggi ultimo invio”,
  // così il backend può marcare il precedente come SUPERATO.
  const ultimoRicevuto = ultimoScrutinioAttivo();
  if (ultimoRicevuto && ultimoRicevuto.status === QUEUE_STATUS.CONFIRMED && !correzioneScrutinioId) {
    errBox.innerHTML = 'Esiste già uno scrutinio ricevuto per questa sezione. Usa <strong>Correggi ultimo invio</strong> per modificarlo senza creare duplicati.';
    errBox.hidden = false;
    aggiornaPulsanteCorrezioneScrutinio();
    const btnCorreggi = $('#btnCorreggiScrutinio');
    if (btnCorreggi && !btnCorreggi.hidden) btnCorreggi.focus();
    return;
  }

  const s = raccogliScrutinio();
  const { errori, avvisi } = validaScrutinio(s);
  if (errori.length) {
    errBox.innerHTML = '<ul>' + errori.map((e) => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
    errBox.hidden = false;
    return;
  }
  if (correzioneScrutinioId && !$('#scMotivoCorrezione').value.trim()) {
    errBox.textContent = 'Indica il motivo della correzione.'; errBox.hidden = false; return;
  }

  const idInvio = tentativoScrutinioDaSostituireId || uuid();
  payloadScrutinioPronto = {
    tipo: 'scrutinio', idInvio,     municipio: STATE.profile.municipio, sezione: STATE.profile.sezione,
    rappresentante: STATE.profile.nome, telefono: STATE.profile.telefono,
    elettori: s.elettori, votanti: s.votanti,
    schedaComune: { valide: s.comune.valide, bianche: s.comune.bianche, nulle: s.comune.nulle, contestate: s.comune.contestate },
    schedaMunicipio: { valide: s.municipio.valide, bianche: s.municipio.bianche, nulle: s.municipio.nulle, contestate: s.municipio.contestate },
    note: s.note,
    correzioneDi: correzioneScrutinioId || '',
    motivoCorrezione: correzioneScrutinioId ? $('#scMotivoCorrezione').value.trim() : '',
    versioneApp: APP_VERSION,
    sindaci: leggiDynList('si').map((x) => ({ nome: x.nome, voti: x.voti })),
    presidenti: leggiDynList('pr').map((x) => ({ nome: x.nome, voti: x.voti })),
    liste: [].concat(
      s.comune.liste.map((l) => ({ livello: 'Comune', nome: l.nome, voti: l.voti })),
      s.municipio.liste.map((l) => ({ livello: 'Municipio', nome: l.nome, voti: l.voti }))
    ),
    preferenze: [].concat(
      s.comune.preferenze.map((p) => ({ livello: 'Comune', candidato: p.nome, voti: p.voti })),
      s.municipio.preferenze.map((p) => ({ livello: 'Municipio', candidato: p.nome, voti: p.voti }))
    ),
  };

  mostraRiepilogoScrutinio(s, avvisi);
}

function mostraRiepilogoScrutinio(s, avvisi) {
  const cont = $('#riepilogoContenuto');
  cont.innerHTML = '';

  function sezioneRiep(titolo, righe) {
    const div = document.createElement('div');
    div.className = 'riepilogo-sezione';
    div.innerHTML = '<h3>' + titolo + '</h3>' + righe.map(([label, val]) => {
      const classe = String(label).indexOf('Totale schede') === 0 ? ' total-row' : '';
      return '<div class="riepilogo-row' + classe + '"><span>' + escapeHtml(label) + '</span><span>' +
        escapeHtml(String(val !== null && val !== undefined ? val : '—')) + '</span></div>';
    }).join('');
    cont.appendChild(div);
  }

  if (avvisi && avvisi.length) {
    sezioneRiep('Controlli da verificare', avvisi.map((testo, i) => ['Avviso ' + (i + 1), testo]));
  }

  sezioneRiep('Seggio', [
    ['Municipio', NOMI_MUNICIPI[STATE.profile.municipio] || STATE.profile.municipio],
    ['Sezione', STATE.profile.sezione],
    ['Rappresentante', STATE.profile.nome],
  ]);

  sezioneRiep('Elettori e votanti', [
    ['Elettori iscritti', s.elettori],
    ['Votanti totali', s.votanti],
    ['Affluenza', s.elettori ? Math.round(s.votanti / s.elettori * 1000) / 10 + '%' : '—'],
  ]);

  const sindaciList = leggiDynList('si').filter((x) => x.voti);
  if (sindaciList.length) sezioneRiep('Voti Sindaco', sindaciList.map((x) => [x.nome, x.voti]));

  sezioneRiep('Scheda Comune', [
    ['Valide', s.comune.valide], ['Bianche', s.comune.bianche],
    ['Nulle', s.comune.nulle], ['Contestate', s.comune.contestate],
    ['Totale schede Comune', totaleScheda(s.comune) + ' / ' + s.votanti],
    ...s.comune.liste.filter((l) => l.voti).map((l) => [l.nome, l.voti]),
    ...s.comune.preferenze.filter((p) => p.voti).map((p) => ['Pref. ' + p.nome, p.voti]),
  ]);

  const presidentiList = leggiDynList('pr').filter((x) => x.voti);
  if (presidentiList.length) sezioneRiep('Voti Presidente Municipio', presidentiList.map((x) => [x.nome, x.voti]));

  sezioneRiep('Scheda Municipio', [
    ['Valide', s.municipio.valide], ['Bianche', s.municipio.bianche],
    ['Nulle', s.municipio.nulle], ['Contestate', s.municipio.contestate],
    ['Totale schede Municipio', totaleScheda(s.municipio) + ' / ' + s.votanti],
    ...s.municipio.liste.filter((l) => l.voti).map((l) => [l.nome, l.voti]),
    ...s.municipio.preferenze.filter((p) => p.voti).map((p) => ['Pref. ' + p.nome, p.voti]),
  ]);

  if (s.note) sezioneRiep('Note', [['', s.note]]);

  $('#checkConfermaScrutinio').checked = false;
  $('#btnConfermaInvio').disabled = true;
  $('#modalRiepilogo').hidden = false;
  requestAnimationFrame(() => $('#checkConfermaScrutinio').focus());
}

async function onConfermaInvioScrutinio() {
  if (!$('#checkConfermaScrutinio').checked) {
    showToast('Conferma prima di aver confrontato i dati con il verbale.');
    return;
  }
  $('#modalRiepilogo').hidden = true;
  if (!payloadScrutinioPronto) return;
  const id = payloadScrutinioPronto.idInvio;
  const tentativoDaSostituire = tentativoScrutinioDaSostituireId;
  const salvato = tentativoDaSostituire
    ? sostituisciInvioInCoda(LS.QUEUE_SCR, tentativoDaSostituire, payloadScrutinioPronto)
    : accodaInvio(LS.QUEUE_SCR, payloadScrutinioPronto);
  if (!salvato) {
    showToast('Impossibile salvare sul telefono: spazio non disponibile.', 4500);
    return;
  }
  salvaBozzaScrutinio(false, 'in_coda', id);
  correzioneScrutinioId = null;
  tentativoScrutinioDaSostituireId = null;
  $('#scCorrezioneBox').hidden = true;
  $('#scMotivoCorrezione').value = '';
  aggiornaBadgeScrutinio(); renderTabellaInvii(); aggiornaBadgeInCoda();
  showToast(navigator.onLine ? 'Salvato sul telefono. Verifico la ricezione…' : 'Salvato sul telefono. Sarà inviato quando torna la rete.');
  payloadScrutinioPronto = null;
  await provaSvuotaCode();
  const item = trovaItem(LS.QUEUE_SCR, id);
  if (item && item.status === QUEUE_STATUS.CONFIRMED) showToast('Scrutinio ricevuto dal coordinamento.');
  else if (item && item.status === QUEUE_STATUS.ACTION_REQUIRED) showToast('Scrutinio salvato, ma non ancora ricevuto. Controlla “I miei invii”.', 4500);
}

function ultimoScrutinioAttivo() {
  const sostituiti = idsSostituiti(LS.QUEUE_SCR);
  return loadJSON(LS.QUEUE_SCR, []).filter((it) =>
    it.payload && it.payload.municipio === STATE.profile.municipio && it.payload.sezione === STATE.profile.sezione && !sostituiti.has(it.idInvio)
  ).sort((a, b) => a.creato < b.creato ? 1 : -1)[0] || null;
}

function aggiornaPulsanteCorrezioneScrutinio() {
  const btn = $('#btnCorreggiScrutinio');
  const ultimo = ultimoScrutinioAttivo();
  btn.hidden = !ultimo;
  if (ultimo) btn.textContent = ultimo.status === QUEUE_STATUS.CONFIRMED ? 'Correggi ultimo invio' : 'Correggi tentativo non inviato';
}

function impostaDynPerNome(prefix, valori, campoNome) {
  const mappa = new Map((valori || []).map((x) => [x[campoNome || 'nome'], x.voti]));
  $all('[id^="' + prefix + '_"]').forEach((inp) => { inp.value = mappa.get(inp.dataset.nome) ?? 0; });
}

function correggiUltimoScrutinio() {
  const item = ultimoScrutinioAttivo();
  if (!item) return;
  const p = item.payload;
  const giaRicevuto = item.status === QUEUE_STATUS.CONFIRMED;
  correzioneScrutinioId = giaRicevuto ? item.idInvio : null;
  tentativoScrutinioDaSostituireId = giaRicevuto ? null : item.idInvio;
  $('#scCorrezioneBox').hidden = !giaRicevuto;
  $('#scMotivoCorrezione').value = '';
  $('#scElettori').value = p.elettori ?? '';
  $('#scVotanti').value = p.votanti ?? '';
  const sc = p.schedaComune || {}, sm = p.schedaMunicipio || {};
  $('#comValide').value = sc.valide ?? ''; $('#comBianche').value = sc.bianche ?? ''; $('#comNulle').value = sc.nulle ?? ''; $('#comContestate').value = sc.contestate ?? '';
  $('#munValide').value = sm.valide ?? ''; $('#munBianche').value = sm.bianche ?? ''; $('#munNulle').value = sm.nulle ?? ''; $('#munContestate').value = sm.contestate ?? '';
  $('#scNote').value = p.note || '';
  impostaDynPerNome('si', p.sindaci || []); impostaDynPerNome('pr', p.presidenti || []);
  impostaDynPerNome('lc', (p.liste || []).filter((x) => x.livello === 'Comune'));
  impostaDynPerNome('lm', (p.liste || []).filter((x) => x.livello === 'Municipio'));
  impostaDynPerNome('pc', (p.preferenze || []).filter((x) => x.livello === 'Comune'), 'candidato');
  impostaDynPerNome('pm', (p.preferenze || []).filter((x) => x.livello === 'Municipio'), 'candidato');
  document.querySelector('.tab[data-tab="scrutinio"]').click();
  $('#scCorrezioneBox').scrollIntoView({ behavior: 'smooth', block: 'center' });
  aggiornaAvvisiScrutinio();
  $('#scMotivoCorrezione').focus();
}

// =======================================================================
// STORICO SERVER — RIPRISTINO CROSS-DEVICE / CROSS-VERSION
// =======================================================================
let sincronizzazioneStoricoInCorso = false;

function payloadDaStoricoServer(item) {
  const base = {
    tipo: item.tipo,
    idInvio: String(item.idInvio || ''),
    municipio: String(item.municipio || ''),
    sezione: String(item.sezione || ''),
    elettori: item.elettori === '' ? null : item.elettori,
    note: item.note || '',
    correzioneDi: item.correzioneDi || '',
    motivoCorrezione: item.motivoCorrezione || '',
    versioneApp: item.versioneApp || '',
  };

  if (item.tipo === 'affluenza') {
    return Object.assign(base, {
      giorno: item.giorno || '',
      orario: item.orario || '',
      maschi: item.maschi === '' ? null : item.maschi,
      femmine: item.femmine === '' ? null : item.femmine,
      totale: item.totale === '' ? null : item.totale,
      percentuale: item.percentuale === '' ? null : item.percentuale,
    });
  }

  return Object.assign(base, {
    votanti: item.votanti === '' ? null : item.votanti,
    schedaComune: Object.assign({}, item.schedaComune || {}),
    schedaMunicipio: Object.assign({}, item.schedaMunicipio || {}),
    liste: Array.isArray(item.liste) ? item.liste.map((x) => Object.assign({}, x)) : [],
    preferenze: Array.isArray(item.preferenze) ? item.preferenze.map((x) => Object.assign({}, x)) : [],
    sindaci: Array.isArray(item.sindaci) ? item.sindaci.map((x) => Object.assign({}, x)) : [],
    presidenti: Array.isArray(item.presidenti) ? item.presidenti.map((x) => Object.assign({}, x)) : [],
  });
}

function integraStoricoServerInCoda(queueKey, itemsServer) {
  const coda = loadJSON(queueKey, []);
  const perId = new Map(coda.filter((it) => it && it.idInvio).map((it) => [String(it.idInvio), it]));
  let cambiato = false;

  (itemsServer || []).forEach((serverItem) => {
    const id = String(serverItem && serverItem.idInvio || '').trim();
    if (!id) return;
    const payloadServer = payloadDaStoricoServer(serverItem);
    let locale = perId.get(id);

    if (!locale) {
      locale = {
        idInvio: id,
        payload: payloadServer,
        status: QUEUE_STATUS.CONFIRMED,
        creato: serverItem.creato || new Date().toISOString(),
        tentativi: 0,
        ultimoTentativo: null,
        ultimoErrore: '',
        codiceErrore: '',
        sincronizzatoIl: serverItem.creato || null,
        rispostaServer: {
          elettori: payloadServer.elettori,
          percentuale: serverItem.tipo === 'affluenza' ? payloadServer.percentuale : null,
          ripristinatoDaStorico: true,
        },
        statoServer: serverItem.stato || '',
        sostituitoDaServer: serverItem.sostituitoDa || '',
      };
      coda.push(locale);
      perId.set(id, locale);
      cambiato = true;
    } else {
      const prima = JSON.stringify({
        payload: locale.payload,
        status: locale.status,
        creato: locale.creato,
        sincronizzatoIl: locale.sincronizzatoIl,
        statoServer: locale.statoServer,
        sostituitoDaServer: locale.sostituitoDaServer,
      });
      // Se il record esiste sul server, il coordinamento ne ha confermato la ricezione.
      locale.payload = Object.assign({}, locale.payload || {}, payloadServer);
      locale.status = QUEUE_STATUS.CONFIRMED;
      locale.creato = serverItem.creato || locale.creato || new Date().toISOString();
      locale.sincronizzatoIl = serverItem.creato || locale.sincronizzatoIl || null;
      locale.ultimoErrore = '';
      locale.codiceErrore = '';
      locale.statoServer = serverItem.stato || locale.statoServer || '';
      locale.sostituitoDaServer = serverItem.sostituitoDa || locale.sostituitoDaServer || '';
      locale.rispostaServer = Object.assign({}, locale.rispostaServer || {}, {
        elettori: payloadServer.elettori,
        percentuale: serverItem.tipo === 'affluenza' ? payloadServer.percentuale : null,
        ripristinatoDaStorico: true,
      });
      const dopo = JSON.stringify({
        payload: locale.payload,
        status: locale.status,
        creato: locale.creato,
        sincronizzatoIl: locale.sincronizzatoIl,
        statoServer: locale.statoServer,
        sostituitoDaServer: locale.sostituitoDaServer,
      });
      if (prima !== dopo) cambiato = true;
    }

    if (Number(payloadServer.elettori) > 0) {
      memorizzaElettoriSezioneLocali_(payloadServer.municipio, payloadServer.sezione, payloadServer.elettori);
    }
  });

  if (cambiato) saveJSON(queueKey, coda);
  return cambiato;
}

async function sincronizzaStoricoDaServer(silenzioso) {
  if (sincronizzazioneStoricoInCorso || !navigator.onLine || !backendConfigurato() || !sessionToken()) return false;
  sincronizzazioneStoricoInCorso = true;
  try {
    const data = await inviaAlBackend({ tipo: 'storico_invii', limit: 200 });
    const items = Array.isArray(data.items) ? data.items : [];
    const aff = items.filter((it) => it && it.tipo === 'affluenza');
    const scr = items.filter((it) => it && it.tipo === 'scrutinio');
    const cambiatoAff = integraStoricoServerInCoda(LS.QUEUE_AFF, aff);
    const cambiatoScr = integraStoricoServerInCoda(LS.QUEUE_SCR, scr);

    if (STATE.profile) {
      renderTabellaAffluenza();
      aggiornaBadgeScrutinio();
      renderTabellaInvii();
      aggiornaPulsanteCorrezioneScrutinio();
      aggiornaBadgeInCoda();
      renderHomeDashboard();
    }

    if (!silenzioso) {
      showToast(items.length
        ? 'Storico aggiornato dal coordinamento: ' + items.length + (items.length === 1 ? ' invio disponibile.' : ' invii disponibili.')
        : 'Nessun invio precedente trovato per le sezioni assegnate.', 4500);
    }
    return true;
  } catch (e) {
    if (e && erroreRichiedeNuovoLogin(e.code)) {
      clearSessionCredentials();
      if (!silenzioso) showToast('Sessione scaduta: accedi nuovamente per aggiornare lo storico.', 5500);
      return false;
    }
    if (!silenzioso) showToast(messaggioErroreUtente(e, 'Non riesco ad aggiornare lo storico dal coordinamento.'), 5500);
    return false;
  } finally {
    sincronizzazioneStoricoInCorso = false;
  }
}

// =======================================================================
// CODA OFFLINE E INVIO AL BACKEND
// =======================================================================
let sincronizzazioneInCorso = false;

function accodaInvio(queueKey, payload) {
  const coda = loadJSON(queueKey, []);
  const payloadPersistito = Object.assign({}, payload || {});
  delete payloadPersistito.sessionToken;
  coda.push({
    idInvio: payloadPersistito.idInvio, payload: payloadPersistito, status: QUEUE_STATUS.LOCAL, creato: new Date().toISOString(),
    tentativi: 0, ultimoTentativo: null, ultimoErrore: '', sincronizzatoIl: null,
  });
  return saveJSON(queueKey, coda);
}

function sostituisciInvioInCoda(queueKey, idInvio, payload) {
  const coda = loadJSON(queueKey, []);
  const item = coda.find((x) => x.idInvio === idInvio);
  if (!item || item.status === QUEUE_STATUS.CONFIRMED) return false;
  const payloadPersistito = Object.assign({}, payload || {});
  delete payloadPersistito.sessionToken;
  item.payload = payloadPersistito;
  item.idInvio = payloadPersistito.idInvio;
  item.status = QUEUE_STATUS.LOCAL;
  item.tentativi = 0;
  item.ultimoTentativo = null;
  item.ultimoErrore = '';
  item.codiceErrore = '';
  item.sincronizzatoIl = null;
  item.rispostaServer = null;
  return saveJSON(queueKey, coda);
}

async function leggiRispostaBackend(res) {
  const testo = await res.text();
  let data;
  try { data = JSON.parse(testo); }
  catch (e) { throw new Error('Risposta del coordinamento non valida.'); }
  if (!data.ok) {
    const err = new Error(data.error || 'Invio rifiutato dal coordinamento.');
    err.code = data.code || '';
    throw err;
  }
  return data;
}

async function inviaAlBackend(payload) {
  if (!backendConfigurato()) throw new Error('Backend non configurato.');
  const token = sessionToken();
  if (!token) { const err = new Error('Sessione mancante: effettua nuovamente l’accesso.'); err.code = 'SESSION_INVALID'; throw err; }
  const body = Object.assign({}, payload || {}, { sessionToken: token });
  const data = await backendPostSicuro(body);
  if (!data.ok) {
    const err = new Error(data.error || 'Invio rifiutato dal coordinamento.');
    err.code = data.code || '';
    throw err;
  }
  return data;
}

async function provaSvuotaCode() {
  if (sincronizzazioneInCorso || !navigator.onLine || !backendConfigurato()) return false;
  sincronizzazioneInCorso = true;
  let almenoUnSuccesso = false;
  try {
    for (const queueKey of [LS.QUEUE_AFF, LS.QUEUE_SCR]) {
      const coda = loadJSON(queueKey, []);
      let cambiato = false;
      for (const item of coda) {
        if (item.status === QUEUE_STATUS.CONFIRMED) continue;
        // Errori logici non cambiano da soli: evita nuovi tentativi ogni 45 secondi.
        // L'utente può correggere il tentativo oppure usare “Invia come nuovo”.
        if (item.status === QUEUE_STATUS.ACTION_REQUIRED && ['CORRECTION_TARGET_NOT_FOUND', 'CORRECTION_NOT_ALLOWED', 'ALREADY_SUPERSEDED', 'ACTIVE_SCRUTINY_EXISTS', 'MULTIPLE_ACTIVE_SCRUTINIES', 'INVALID_DATA'].includes(item.codiceErrore)) continue;
        item.status = QUEUE_STATUS.SENDING; item.ultimoTentativo = new Date().toISOString(); cambiato = true;
        saveJSON(queueKey, coda);
        aggiornaBadgeInCoda();
        try {
          const risposta = await inviaAlBackend(item.payload);
          item.status = QUEUE_STATUS.CONFIRMED;
          item.sincronizzatoIl = new Date().toISOString();
          item.ultimoErrore = '';

          const salvatoServer = risposta && risposta.salvato && typeof risposta.salvato === 'object'
            ? risposta.salvato
            : {};

          item.rispostaServer = {
            duplicato: !!risposta.duplicato,
            correzione: !!risposta.correzione,
            elettori: salvatoServer.elettori !== undefined ? salvatoServer.elettori : null,
            percentuale: salvatoServer.percentuale !== undefined ? salvatoServer.percentuale : null,
          };

          if (queueKey === LS.QUEUE_AFF) {
            // Il backend può recuperare gli elettori da rilevazioni precedenti.
            // Riporta i valori canonici anche sul telefono, così percentuale,
            // banner e invii successivi restano coerenti.
            if (Number(salvatoServer.elettori) > 0) {
              item.payload.elettori = Number(salvatoServer.elettori);
              memorizzaElettoriSezioneLocali_(
                item.payload.municipio,
                item.payload.sezione,
                salvatoServer.elettori
              );
            }
            if (salvatoServer.percentuale !== undefined &&
                salvatoServer.percentuale !== null &&
                salvatoServer.percentuale !== '') {
              item.payload.percentuale = Number(salvatoServer.percentuale);
            }
            if (salvatoServer.maschi !== undefined && salvatoServer.maschi !== '') item.payload.maschi = salvatoServer.maschi;
            if (salvatoServer.femmine !== undefined && salvatoServer.femmine !== '') item.payload.femmine = salvatoServer.femmine;
            if (salvatoServer.totale !== undefined && salvatoServer.totale !== '') item.payload.totale = salvatoServer.totale;
          }

          if (queueKey === LS.QUEUE_SCR) {
            aggiornaDocumentoBozzaDaInvio(item, 'sincronizzato');
            if (STATE.profile && item.payload.municipio === STATE.profile.municipio && item.payload.sezione === STATE.profile.sezione) aggiornaStatoBozzaScrutinio('sent', item.sincronizzatoIl);
          }
          almenoUnSuccesso = true;
        } catch (e) {
          if (e && erroreRichiedeNuovoLogin(e.code)) {
            item.status = QUEUE_STATUS.LOCAL;
            item.ultimoErrore = 'Sessione da rinnovare prima della sincronizzazione.';
            item.codiceErrore = e.code;
            saveJSON(queueKey, coda);
            clearSessionCredentials();
            showToast('Sessione scaduta: effettua nuovamente l’accesso. Gli invii restano conservati sul telefono.', 6500);
            return false;
          }
          const codiceErrore = e && e.code ? String(e.code) : '';
          const temporaneo = ['', 'NETWORK_ERROR', 'NETWORK_TIMEOUT', 'BUSY', 'INTERNAL_ERROR', 'INVALID_SERVER_RESPONSE'].includes(codiceErrore);
          item.status = temporaneo ? QUEUE_STATUS.LOCAL : QUEUE_STATUS.ACTION_REQUIRED;
          item.tentativi = (item.tentativi || 0) + 1;
          item.ultimoErrore = messaggioErroreUtente(e, temporaneo ? 'Invio temporaneamente non riuscito' : 'Invio da controllare');
          item.codiceErrore = codiceErrore;
          if (queueKey === LS.QUEUE_SCR) {
            aggiornaDocumentoBozzaDaInvio(item, 'errore');
            if (STATE.profile && item.payload.municipio === STATE.profile.municipio && item.payload.sezione === STATE.profile.sezione) aggiornaStatoBozzaScrutinio('error', item.ultimoTentativo);
          }
        }
        cambiato = true;
        saveJSON(queueKey, coda);
      }
      if (cambiato) saveJSON(queueKey, coda);
    }
  } finally {
    sincronizzazioneInCorso = false;
    if (STATE.profile) {
      renderTabellaAffluenza(); aggiornaBadgeScrutinio(); renderTabellaInvii(); aggiornaPulsanteCorrezioneScrutinio();
    }
    aggiornaBadgeInCoda();
  }
  return almenoUnSuccesso;
}

function contaInCoda() {
  const conta = (key) => loadJSON(key, []).filter((i) => i.status !== QUEUE_STATUS.CONFIRMED).length;
  return conta(LS.QUEUE_AFF) + conta(LS.QUEUE_SCR);
}

function aggiornaBadgeInCoda() {
  const items = [...loadJSON(LS.QUEUE_AFF, []), ...loadJSON(LS.QUEUE_SCR, [])];
  const nonConfermati = items.filter((i) => i.status !== QUEUE_STATUS.CONFIRMED);
  const attenzione = nonConfermati.filter((i) => i.status === QUEUE_STATUS.ACTION_REQUIRED).length;
  const badge = $('#pendingBadge');
  if (nonConfermati.length > 0) {
    badge.hidden = false;
    badge.className = 'status-pill ' + (attenzione ? 'attention' : 'pending');
    badge.textContent = attenzione
      ? (attenzione === 1 ? '1 invio da controllare' : attenzione + ' invii da controllare')
      : (nonConfermati.length === 1 ? '1 salvato sul telefono' : nonConfermati.length + ' salvati sul telefono');
  } else {
    badge.hidden = true;
    badge.className = 'status-pill pending';
  }
  renderHomeDashboard();
  renderNotificheHome();
  aggiornaRiepilogoSincronizzazione();
}

function aggiornaRiepilogoSincronizzazione() {
  const box = $('#syncSummary');
  if (!box || !STATE.profile) return;
  const items = [...inviiCorrenti(LS.QUEUE_AFF), ...inviiCorrenti(LS.QUEUE_SCR)];
  const confermati = items.filter((i) => i.status === QUEUE_STATUS.CONFIRMED).length;
  const attenzione = items.filter((i) => i.status === QUEUE_STATUS.ACTION_REQUIRED).length;
  const locali = items.filter((i) => i.status !== QUEUE_STATUS.CONFIRMED && i.status !== QUEUE_STATUS.ACTION_REQUIRED).length;
  box.className = 'sync-summary ' + (attenzione ? 'attention' : locali ? 'pending' : 'good');
  const strong = document.createElement('strong');
  const span = document.createElement('span');
  if (attenzione) {
    strong.textContent = attenzione === 1 ? '1 comunicazione richiede attenzione' : attenzione + ' comunicazioni richiedono attenzione';
    span.textContent = 'I dati restano conservati sul telefono. Controlla il dettaglio prima di considerare concluso l’invio.';
  } else if (locali) {
    strong.textContent = locali === 1 ? '1 comunicazione salvata sul telefono' : locali + ' comunicazioni salvate sul telefono';
    span.textContent = navigator.onLine ? 'La sincronizzazione è automatica. Attendi la dicitura “Ricevuto dal coordinamento”.' : 'Sei offline: puoi continuare a lavorare e l’app invierà i dati appena torna la connessione.';
  } else if (confermati) {
    strong.textContent = 'Tutte le comunicazioni risultano ricevute';
    span.textContent = confermati + (confermati === 1 ? ' invio confermato dal coordinamento.' : ' invii confermati dal coordinamento.');
  } else {
    strong.textContent = 'Nessuna comunicazione ancora registrata';
    span.textContent = 'Quando salvi un dato, resta sul telefono finché il coordinamento non ne conferma la ricezione.';
  }
  box.replaceChildren(strong, span);
}

function renderTabellaInvii() {
  aggiornaRiepilogoSincronizzazione();
  const tbody = $('#tabellaInvii tbody');
  tbody.innerHTML = '';
  const sostAff = idsSostituiti(LS.QUEUE_AFF), sostScr = idsSostituiti(LS.QUEUE_SCR);
  const tutti = [
    ...loadJSON(LS.QUEUE_AFF, []).map((i) => ({ ...i, tipo: 'Affluenza', queueKey: LS.QUEUE_AFF, superato: sostAff.has(i.idInvio) })),
    ...loadJSON(LS.QUEUE_SCR, []).map((i) => ({ ...i, tipo: 'Scrutinio', queueKey: LS.QUEUE_SCR, superato: sostScr.has(i.idInvio) })),
  ].filter((i) => STATE.profile && i.payload.sezione === STATE.profile.sezione && i.payload.municipio === STATE.profile.municipio)
   .sort((a, b) => (a.creato < b.creato ? 1 : -1));

  if (!tutti.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="muted-text">Nessun invio per questa sezione.</td></tr>';
    return;
  }
  tutti.forEach((it) => {
    const tr = document.createElement('tr');
    const quando = new Date(it.creato).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
    let dettagli = '';
    const targetMancante = it.codiceErrore === 'CORRECTION_TARGET_NOT_FOUND' && it.payload.correzioneDi;
    if (targetMancante) dettagli = 'Il dato precedente è stato cancellato dal coordinamento. Puoi recuperare questi valori come nuovo invio.';
    else {
      if (it.payload.correzioneDi) dettagli += 'Correzione tracciata. ';
      if (it.ultimoErrore) dettagli += it.ultimoErrore;
      else if (it.sincronizzatoIl) dettagli += 'Ricevuto ' + new Date(it.sincronizzatoIl).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
      else dettagli += 'Conservato sul dispositivo.';
    }
    const stato = it.superato ? '<span class="pill neutral">sostituito</span>' : statoPillHtml(it.status);
    tr.innerHTML = '<td>' + it.tipo + '</td><td>' + quando + '</td><td>' + stato + '</td><td><span class="status-detail">' + escapeHtml(dettagli) + '</span></td>';
    if (targetMancante) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn primary small';
      btn.textContent = 'Invia come nuovo';
      btn.addEventListener('click', () => recuperaCorrezioneComeNuovo(it.queueKey, it.idInvio));
      tr.lastElementChild.appendChild(document.createElement('br'));
      tr.lastElementChild.appendChild(btn);
    }
    tbody.appendChild(tr);
  });
}

function recuperaCorrezioneComeNuovo(queueKey, idInvio) {
  const tipo = queueKey === LS.QUEUE_AFF ? 'affluenza' : 'scrutinio';
  apriConfermaAzione({
    kicker: 'Dati di prova azzerati',
    titolo: 'Inviare come nuovo dato?',
    testo: 'Il record che volevi correggere non esiste più nel foglio del coordinamento. I valori appena inseriti possono essere inviati come un nuovo ' + tipo + '.',
    nota: 'Il vecchio riferimento verrà rimosso solo dal telefono. I valori del nuovo invio resteranno invariati.',
    conferma: 'Invia come nuovo',
    pericolosa: false,
    onConfirm: async () => {
      const coda = loadJSON(queueKey, []);
      const item = coda.find((x) => x.idInvio === idInvio);
      if (!item || !item.payload) {
        showToast('Invio non più presente sul telefono.');
        return;
      }
      const vecchioTarget = item.payload.correzioneDi;
      const nuovoId = uuid();
      const nuovaCoda = coda.filter((x) => x.idInvio !== vecchioTarget || x.idInvio === idInvio);
      const corrente = nuovaCoda.find((x) => x.idInvio === idInvio);
      corrente.idInvio = nuovoId;
      corrente.payload = Object.assign({}, corrente.payload, {
        idInvio: nuovoId,
                correzioneDi: '',
        motivoCorrezione: '',
        versioneApp: APP_VERSION,
      });
      corrente.status = QUEUE_STATUS.LOCAL;
      corrente.creato = new Date().toISOString();
      corrente.tentativi = 0;
      corrente.ultimoTentativo = null;
      corrente.ultimoErrore = '';
      corrente.codiceErrore = '';
      corrente.sincronizzatoIl = null;
      corrente.rispostaServer = null;
      if (!saveJSON(queueKey, nuovaCoda)) {
        showToast('Non riesco ad aggiornare i dati sul telefono.', 4500);
        return;
      }
      if (queueKey === LS.QUEUE_SCR) {
        const key = LS.SCR_DRAFT(corrente.payload.municipio, corrente.payload.sezione);
        const documento = estraiDocumentoBozza(loadJSON(key, null));
        if (documento && documento.idInvio === idInvio) {
          documento.idInvio = nuovoId;
          documento.stato = 'in_coda';
          documento.sincronizzatoIl = '';
          saveJSON(key, documento);
        }
      }
      renderTabellaInvii();
      aggiornaBadgeInCoda();
      showToast('Preparato come nuovo invio. Verifico la ricezione…');
      await provaSvuotaCode();
      const aggiornato = trovaItem(queueKey, nuovoId);
      showToast(aggiornato && aggiornato.status === QUEUE_STATUS.CONFIRMED
        ? 'Dato ricevuto dal coordinamento.'
        : 'Dato salvato sul telefono. Controlla “I miei invii”.', 4500);
    },
  });
}

// =======================================================================
// CONDIVIDI RIEPILOGO (backup manuale, sempre disponibile)
// =======================================================================
function generaTestoRiepilogo() {
  if (!STATE.profile) return '';
  const p = STATE.profile;
  let righe = [];
  righe.push('RETE SEGGI FdI — Riepilogo sezione');
  righe.push('Municipio ' + p.municipio + ' — Sezione ' + p.sezione);
  righe.push('Seggio: ' + p.addr);
  righe.push('Rappresentante: ' + p.nome + ' (' + p.telefono + ')');
  righe.push('');

  const aff = loadJSON(LS.QUEUE_AFF, []).filter((i) => i.payload.sezione === p.sezione && i.payload.municipio === p.municipio);
  if (aff.length) {
    righe.push('AFFLUENZA:');
    aff.forEach((i) => {
      const d = i.payload;
      righe.push('- ' + (d.giorno ? d.giorno + ' ' : '') + d.orario + ': M ' + d.maschi + ' / F ' + d.femmine + ' / Tot ' + d.totale);
    });
    righe.push('');
  }

  const documentoBozza = estraiDocumentoBozza(loadJSON(chiaveBozza(), null));
  const bozza = documentoBozza && documentoBozza.payload;
  if (bozza && bozzaHaContenuto(bozza)) {
    righe.push('SCRUTINIO:');
    righe.push('Elettori: ' + (bozza.elettori || 0) + ' — Votanti: ' + (bozza.votanti || 0));
    righe.push('');
    righe.push('Scheda Comune — valide ' + bozza.comune.valide + ', bianche ' + bozza.comune.bianche + ', nulle ' + bozza.comune.nulle + ', contestate ' + bozza.comune.contestate);
    (bozza.comune.liste || []).forEach((l) => { if (l.voti) righe.push('  Lista ' + l.nome + ': ' + l.voti); });
    (bozza.comune.preferenze || []).forEach((pr) => { if (pr.voti) righe.push('  Pref. ' + pr.nome + ': ' + pr.voti); });
    righe.push('');
    righe.push('Scheda Municipio — valide ' + bozza.municipio.valide + ', bianche ' + bozza.municipio.bianche + ', nulle ' + bozza.municipio.nulle + ', contestate ' + bozza.municipio.contestate);
    (bozza.municipio.liste || []).forEach((l) => { if (l.voti) righe.push('  Lista ' + l.nome + ': ' + l.voti); });
    (bozza.municipio.preferenze || []).forEach((pr) => { if (pr.voti) righe.push('  Pref. ' + pr.nome + ': ' + pr.voti); });
    if (bozza.note) { righe.push(''); righe.push('Note: ' + bozza.note); }
  }
  return righe.join('\n');
}

let testoCondivisioneCorrente = '';

function chiudiModalCondivisione() {
  const modal = $('#modalCondivisione');
  if (modal) modal.hidden = true;
  testoCondivisioneCorrente = '';
}

function apriModalCondivisione(testo, messaggio) {
  testoCondivisioneCorrente = testo;
  const anteprima = $('#condividiAnteprima');
  const nota = $('#condividiNota');
  if (anteprima) anteprima.textContent = testo;
  if (nota) nota.textContent = messaggio || 'Scegli come inviare il riepilogo.';
  const modal = $('#modalCondivisione');
  if (modal) {
    modal.hidden = false;
    const primoPulsante = $('#btnShareWhatsApp');
    if (primoPulsante) primoPulsante.focus();
  }
}

async function copiaNegliAppunti(testo) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(testo);
      return true;
    } catch (e) { /* usa il metodo compatibile sotto */ }
  }
  const area = document.createElement('textarea');
  area.value = testo;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, area.value.length);
  let copiato = false;
  try { copiato = document.execCommand('copy'); } catch (e) { copiato = false; }
  area.remove();
  return copiato;
}

async function onCondividi() {
  try { salvaBozzaScrutinio(false); } catch (e) { console.warn('Salvataggio bozza prima della condivisione non riuscito', e); }

  let testo = '';
  try { testo = generaTestoRiepilogo(); }
  catch (e) {
    console.error('Errore durante la creazione del riepilogo', e);
    showToast('Non riesco a creare il riepilogo. Riapri la sezione e riprova.');
    return;
  }

  if (!testo || !testo.trim()) {
    showToast('Compila prima i dati della sezione.');
    return;
  }

  if (navigator.share) {
    try {
      await navigator.share({ title: 'Riepilogo sezione', text: testo });
      return;
    } catch (e) {
      // Se l'utente chiude volontariamente il pannello, non aprire WhatsApp a sorpresa.
      if (e && e.name === 'AbortError') return;
      console.warn('Condivisione nativa non disponibile, mostro le alternative', e);
      apriModalCondivisione(testo, 'Il pannello di condivisione del telefono non si è aperto. Scegli una delle alternative.');
      return;
    }
  }

  apriModalCondivisione(testo);
}

function condividiConWhatsApp() {
  if (!testoCondivisioneCorrente) return;
  window.location.href = 'https://wa.me/?text=' + encodeURIComponent(testoCondivisioneCorrente);
}

function condividiConEmail() {
  if (!testoCondivisioneCorrente) return;
  const oggetto = 'Riepilogo sezione elettorale';
  window.location.href = 'mailto:?subject=' + encodeURIComponent(oggetto) + '&body=' + encodeURIComponent(testoCondivisioneCorrente);
}

function condividiConSms() {
  if (!testoCondivisioneCorrente) return;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const separatore = ios ? '&' : '?';
  window.location.href = 'sms:' + separatore + 'body=' + encodeURIComponent(testoCondivisioneCorrente);
}

async function copiaRiepilogo() {
  if (!testoCondivisioneCorrente) return;
  const ok = await copiaNegliAppunti(testoCondivisioneCorrente);
  if (ok) {
    showToast('Riepilogo copiato. Ora puoi incollarlo dove preferisci.');
    chiudiModalCondivisione();
  } else {
    showToast('Copia non riuscita: seleziona il testo nell’anteprima.');
  }
}

// =======================================================================
// INSTALLAZIONE PWA (Android / iOS)
// =======================================================================
let deferredInstallEvent = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallEvent = e;
  $('#installBtn').hidden = false;
});


// =======================================================================
// V9 — MESSAGGI, ASSISTENZA, CONTROLLO DISPOSITIVO E AGGIORNAMENTI
// =======================================================================
let messaggiTimer = null;
let swReloading = false;

function messaggiCacheCorrenti() {
  if (!STATE.profile) return [];
  const all = loadJSON(LS.MESSAGGI, {});
  return all[STATE.profile.municipio + '-' + STATE.profile.sezione] || [];
}

function salvaMessaggiCache(items) {
  if (!STATE.profile) return;
  const all = loadJSON(LS.MESSAGGI, {});
  all[STATE.profile.municipio + '-' + STATE.profile.sezione] = items || [];
  saveJSON(LS.MESSAGGI, all);
}

async function caricaMessaggi(silent) {
  if (!STATE.profile) return [];
  STATE.messaggi = messaggiCacheCorrenti();
  renderNotificheHome();
  if (!navigator.onLine || !backendConfigurato() || !sessionToken()) return STATE.messaggi;
  try {
    const data = await backendPostSicuro({ tipo: 'messaggi', sessionToken: sessionToken(), municipio: STATE.profile.municipio, sezione: STATE.profile.sezione });
    if (!data.ok) throw Object.assign(new Error(data.error || 'Messaggi non disponibili'), { code: data.code || '' });
    const precedenti = new Set((STATE.messaggi || []).map((x) => x.id));
    STATE.messaggi = data.items || [];
    salvaMessaggiCache(STATE.messaggi);
    saveJSON(LS.LAST_MESSAGE_CHECK, new Date().toISOString());
    renderNotificheHome();
    if (!silent && STATE.messaggi.some((x) => !precedenti.has(x.id) && x.stato === 'NUOVO')) showToast('Nuovo messaggio dal coordinamento.', 5000);
    return STATE.messaggi;
  } catch (e) {
    if (e && erroreRichiedeNuovoLogin(e.code)) clearSessionCredentials();
    if (!silent) showToast('Messaggi non aggiornati: ' + (e.message || 'connessione non disponibile'), 4500);
    return STATE.messaggi;
  }
}

async function aggiornaMessaggio(id, stato) {
  if (!STATE.profile || !navigator.onLine) return showToast('Serve la connessione per aggiornare il messaggio.', 4000);
  try {
    const data = await backendPostSicuro({ tipo: 'messaggio_ack', sessionToken: sessionToken(), municipio: STATE.profile.municipio, sezione: STATE.profile.sezione, id, stato });
    if (!data.ok) throw Object.assign(new Error(data.error || 'Aggiornamento non riuscito'), { code: data.code || '' });
    await caricaMessaggi(true);
    showToast(stato === 'RISOLTO' ? 'Richiesta segnata come risolta.' : 'Messaggio segnato come letto.');
  } catch (e) {
    if (e && erroreRichiedeNuovoLogin(e.code)) clearSessionCredentials();
    showToast(e.message || 'Aggiornamento non riuscito.', 4500);
  }
}

function creaNotificaDom(titolo, testo, meta, classe) {
  const item = document.createElement('article');
  item.className = 'notification-item ' + (classe || '');
  const head = document.createElement('div'); head.className = 'notification-item-head';
  const h = document.createElement('h3'); h.textContent = titolo;
  head.appendChild(h); item.appendChild(head);
  const p = document.createElement('p'); p.textContent = testo; item.appendChild(p);
  if (meta) { const m = document.createElement('div'); m.className = 'notification-meta'; m.textContent = meta; item.appendChild(m); }
  return item;
}

function renderNotificheHome() {
  const card = $('#notificationsCard');
  const list = $('#homeNotifications');
  const count = $('#notificationsCount');
  if (!card || !list || !count) return;
  list.innerHTML = '';
  const entries = [];
  const pending = contaInCoda();
  if (pending) {
    const item = creaNotificaDom('Invii conservati sul telefono', pending + ' invio/i saranno trasmessi appena la connessione sarà disponibile.', navigator.onLine ? 'Puoi premere “Riprova ora” nella sezione Invii.' : 'Il dato non verrà perso.', '');
    entries.push(item);
  }
  if (STATE.profile) {
    const mappaAff = invitiAffluenzaSezione();
    const ritardi = orariAffluenza().filter((o) => !mappaAff[chiaveAffluenza(o.giorno, o.orario)])
      .map((o) => ({ slot: o, stato: statoScadenza(o.giorno, o.orario, false) }))
      .filter((x) => x.stato && x.stato.classe === 'error');
    if (ritardi.length) {
      const r = ritardi[0];
      entries.push(creaNotificaDom('Rilevazione in ritardo', 'L’affluenza delle ' + r.slot.orario + ' non risulta ancora ricevuta.', r.slot.giorno + ' · ' + r.stato.testo, 'urgent'));
    }
  }
  (STATE.messaggi || messaggiCacheCorrenti()).forEach((m) => {
    const item = creaNotificaDom(m.titolo || 'Messaggio dal coordinamento', m.messaggio || '', [m.priorita, m.creatoDa].filter(Boolean).join(' · '), String(m.priorita || '').toUpperCase() === 'URGENTE' ? 'urgent' : (m.stato === 'LETTO' ? 'read' : ''));
    const actions = document.createElement('div'); actions.className = 'notification-actions';
    if (m.stato === 'NUOVO') {
      const letto = document.createElement('button'); letto.type = 'button'; letto.className = 'btn ghost compact'; letto.textContent = 'Segna letto'; letto.addEventListener('click', () => aggiornaMessaggio(m.id, 'LETTO')); actions.appendChild(letto);
    }
    const risolto = document.createElement('button'); risolto.type = 'button'; risolto.className = 'btn primary compact'; risolto.textContent = 'Ho verificato'; risolto.addEventListener('click', () => aggiornaMessaggio(m.id, 'RISOLTO')); actions.appendChild(risolto);
    item.appendChild(actions); entries.push(item);
  });
  entries.forEach((x) => list.appendChild(x));
  count.textContent = entries.length;
  card.hidden = entries.length === 0;
}

function normalizzaTelefonoLink(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.indexOf('00') === 0) digits = digits.slice(2);
  if (digits.length === 10 && digits[0] === '3') digits = '39' + digits;
  return digits;
}

function testoDiagnostica() {
  const p = STATE.profile || {};
  return [
    'Rete Seggi ' + APP_VERSION,
    'Backend: ' + ((STATE.config && STATE.config.app && STATE.config.app.backendVersion) || 'non rilevato'),
    'Rappresentante: ' + (p.nome || '—'),
    'Municipio: ' + (p.municipio || '—'),
    'Sezione: ' + (p.sezione || '—'),
    'Connessione: ' + (navigator.onLine ? 'online' : 'offline'),
    'Invii in coda: ' + contaInCoda(),
    'PWA installata: ' + (isStandalone() ? 'sì' : 'no'),
    'Browser: ' + navigator.userAgent,
  ].join('\n');
}

function apriAssistenza() {
  const modal = $('#modalAssistenza');
  const tel = normalizzaTelefonoLink(impostazione('TELEFONO_ASSISTENZA', ''));
  const wa = normalizzaTelefonoLink(impostazione('WHATSAPP_ASSISTENZA', '') || impostazione('TELEFONO_ASSISTENZA', ''));
  const email = impostazione('EMAIL_ASSISTENZA', '');
  const base = impostazione('MESSAGGIO_ASSISTENZA', 'Ho bisogno di assistenza per la mia sezione.');
  const testo = base + '\n\n' + testoDiagnostica();
  const call = $('#supportCall'); const whatsapp = $('#supportWhatsapp'); const mail = $('#supportEmail');
  call.href = tel ? 'tel:+' + tel : '#'; call.hidden = !tel;
  whatsapp.href = wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent(testo) : '#'; whatsapp.hidden = !wa;
  mail.href = email ? 'mailto:' + encodeURIComponent(email) + '?subject=' + encodeURIComponent('Assistenza Rete Seggi - Sezione ' + ((STATE.profile && STATE.profile.sezione) || '')) + '&body=' + encodeURIComponent(testo) : '#'; mail.hidden = !email;
  $('#supportDiagnostics').textContent = testoDiagnostica();
  modal.hidden = false;
  modal.querySelector('.modal-box').focus();
}

function chiudiAssistenza() { $('#modalAssistenza').hidden = true; }

async function copiaDiagnostica() {
  const testo = testoDiagnostica();
  try { await navigator.clipboard.writeText(testo); showToast('Diagnostica copiata.'); }
  catch (e) { $('#supportDiagnostics').focus(); showToast('Seleziona e copia il testo mostrato.'); }
}

function applicaAccessibilita() {
  const attiva = !!loadJSON(LS.ACCESSIBILITY, false);
  document.body.classList.toggle('accessible-mode', attiva);
  const btn = $('#btnAccessibilita');
  if (btn) btn.textContent = attiva ? 'Disattiva modalità accessibile' : 'Attiva testo grande e alto contrasto';
}

function toggleAccessibilita() {
  saveJSON(LS.ACCESSIBILITY, !loadJSON(LS.ACCESSIBILITY, false));
  applicaAccessibilita();
}

function renderDeviceResults(results, openModal) {
  const box = $('#deviceCheckResults');
  if (box) {
    box.innerHTML = '';
    results.forEach((r) => {
      const row = document.createElement('div'); row.className = 'device-check-item ' + r.level;
      const icon = document.createElement('span'); icon.className = 'device-check-icon'; icon.textContent = r.level === 'ok' ? '✓' : (r.level === 'warn' ? '!' : '×');
      const text = document.createElement('div'); const strong = document.createElement('strong'); strong.textContent = r.title; const small = document.createElement('div'); small.textContent = r.detail;
      text.appendChild(strong); text.appendChild(small); row.appendChild(icon); row.appendChild(text); box.appendChild(row);
    });
  }
  const failures = results.filter((r) => r.level === 'error').length;
  const warnings = results.filter((r) => r.level === 'warn').length;
  const readiness = $('#deviceReadinessText');
  if (readiness) readiness.textContent = failures ? failures + ' problema/i da risolvere.' : (warnings ? 'Pronto, con ' + warnings + ' avviso/i.' : 'Tutti i controlli sono superati.');
  saveJSON(LS.DEVICE_CHECK_VERSION, APP_VERSION);
  if (openModal || failures) $('#modalDeviceCheck').hidden = false;
}

async function eseguiControlloDispositivo(openModal) {
  const results = [];

  let storageOk = false;
  try {
    localStorage.setItem('rs_device_test', '1');
    storageOk = localStorage.getItem('rs_device_test') === '1';
    localStorage.removeItem('rs_device_test');
  } catch (e) {}
  results.push({
    title: 'Salvataggio sul telefono',
    detail: storageOk ? 'Disponibile per bozze e invii in coda.' : 'Non disponibile: evita la navigazione privata e controlla le impostazioni del browser.',
    level: storageOk ? 'ok' : 'error'
  });

  // Verifichiamo le funzioni realmente necessarie, non il nome del browser.
  // Alcuni browser iOS possono non esporre il service worker in tutti i
  // contesti pur permettendo il normale utilizzo dell'app e della coda locale.
  const swSupported = 'serviceWorker' in navigator;
  let swReady = swSupported && !!navigator.serviceWorker.controller;
  let swRegistration = null;
  if (swSupported) {
    try {
      swRegistration = STATE.swRegistration || await navigator.serviceWorker.getRegistration();
      swReady = swReady || !!(swRegistration && (swRegistration.active || swRegistration.waiting));
    } catch (e) {}
  }

  if (swReady) {
    results.push({
      title: 'Riapertura offline',
      detail: 'App installata nella cache e pronta anche dopo la chiusura.',
      level: 'ok'
    });
  } else if (swSupported) {
    results.push({
      title: 'Riapertura offline',
      detail: 'Funzione disponibile ma non ancora attiva. Ricarica una volta la pagina con connessione.',
      level: 'warn'
    });
  } else {
    results.push({
      title: 'Riapertura offline',
      detail: 'Non verificabile in questo browser. Gli invii restano salvabili mentre l’app è aperta; su iPhone usa Safari per installazione e riapertura offline garantite.',
      level: 'warn'
    });
  }

  results.push({
    title: 'Sessione',
    detail: sessionToken() ? 'Sessione attiva solo nella sessione corrente del browser.' : 'Sessione non presente.',
    level: sessionToken() ? 'ok' : 'warn'
  });

  const min = STATE.config && STATE.config.app && STATE.config.app.versioneMinima;
  const versionOk = !min || confrontaVersioni(APP_VERSION, min) >= 0;
  results.push({
    title: 'Versione app',
    detail: versionOk ? 'Versione ' + APP_VERSION + ' aggiornata.' : 'È richiesta almeno la versione ' + min + '.',
    level: versionOk ? 'ok' : 'error'
  });

  if (navigator.onLine && backendConfigurato()) {
    try {
      const r = await fetch(BACKEND_URL + '?action=health', { cache: 'no-store' });
      const d = JSON.parse(await r.text());
      results.push({ title: 'Collegamento al coordinamento', detail: d.ok ? 'Backend raggiungibile.' : 'Risposta non valida.', level: d.ok ? 'ok' : 'error' });
    } catch (e) {
      const browser = browserCorrente();
      const aiuto = testoAiutoBrowser(browser);
      results.push({
        title: 'Collegamento al coordinamento',
        detail: browser === 'Brave'
          ? 'Bloccato da Brave o dalla rete. Disattiva Shields solo per SeggioLink e ripeti il controllo.'
          : 'Backend non raggiungibile. ' + aiuto.istruzioni,
        level: 'error'
      });
    }
  } else {
    results.push({ title: 'Collegamento al coordinamento', detail: 'Controllo rinviato perché il telefono è offline.', level: 'warn' });
  }

  renderDeviceResults(results, !!openModal);
  return results;
}

function mostraAggiornamento(testo, obbligatorio) {
  const banner = $('#updateBanner');
  if (!banner) return;
  $('#updateText').textContent = testo || 'È pronta una nuova versione dell’app.';
  banner.hidden = false;
  banner.dataset.mandatory = obbligatorio ? '1' : '0';
}

function verificaVersioneConfigurata() {
  const appCfg = STATE.config && STATE.config.app;
  if (!appCfg || !appCfg.versioneMinima) return;
  if (confrontaVersioni(APP_VERSION, appCfg.versioneMinima) < 0) {
    mostraAggiornamento('La versione minima richiesta è ' + appCfg.versioneMinima + '. Aggiorna prima di proseguire.', !!appCfg.aggiornamentoObbligatorio);
  }
}

async function initServiceWorkerUpdates() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('service-worker.js');
    STATE.swRegistration = reg;
    if (reg.waiting) { STATE.swWaiting = reg.waiting; mostraAggiornamento('È disponibile una nuova versione dell’app.', false); }
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
          STATE.swWaiting = worker;
          mostraAggiornamento('Aggiornamento scaricato e pronto.', false);
        }
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swReloading) return;
      swReloading = true;
      window.location.reload();
    });
    setInterval(() => reg.update().catch(() => {}), 15 * 60 * 1000);
  } catch (e) {}
}

function applicaAggiornamento() {
  const worker = STATE.swWaiting || (STATE.swRegistration && STATE.swRegistration.waiting);
  if (worker) worker.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
}


function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function initInstallBanner() {
  if (isStandalone() || localStorage.getItem(LS.INSTALL_DISMISSED)) return;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  $('#installInstructions').textContent = isIOS
    ? 'Su iPhone: tocca l\'icona Condividi in basso nel browser, poi "Aggiungi alla schermata Home".'
    : 'Su Android: tocca il pulsante "Installa app" qui sotto, oppure il menu del browser (⋮) e scegli "Installa app" / "Aggiungi a schermata Home".';
  $('#installBanner').hidden = false;
  $('#installBtn').addEventListener('click', async () => {
    if (!deferredInstallEvent) return;
    deferredInstallEvent.prompt();
    await deferredInstallEvent.userChoice;
    $('#installBtn').hidden = true;
  });
  $('#dismissInstallBtn').addEventListener('click', () => {
    localStorage.setItem(LS.INSTALL_DISMISSED, '1');
    $('#installBanner').hidden = true;
  });
}

// =======================================================================
// AVVIO APP
// =======================================================================
async function avvia() {
  migraStorageSicurezza();
  aggiornaStatoConnessione();
  applicaAccessibilita();
  initInstallBanner();
  initTabs();
  initServiceWorkerUpdates();

  // Mostra subito la UI con l'ultima configurazione disponibile e abilita il
  // login senza attendere Google Apps Script. Il refresh remoto parte solo
  // dopo un accesso riuscito (o al ripristino di una sessione già valida).
  STATE.config = loadJSON(LS.CONFIG, null) || configVuota();
  applicaConfigAggiornataAllaUI();

  $('#btnLogin').addEventListener('click', onLogin);
  $('#inputCodice').addEventListener('keydown', (e) => { if (e.key === 'Enter') onLogin(); });
  $('#loginTelefono').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#inputCodice').focus(); });
  $('#btnLogout').addEventListener('click', onLogout);
  $('#btnConfermaLogout').addEventListener('click', confermaLogout);
  $('#btnAnnullaLogout').addEventListener('click', chiudiModalLogout);
  $('#btnChiudiLogout').addEventListener('click', chiudiModalLogout);
  $('#modalLogout').addEventListener('click', (e) => { if (e.target.id === 'modalLogout') chiudiModalLogout(); });
  $('#btnEseguiConfermaAzione').addEventListener('click', eseguiConfermaAzione);
  $('#btnAnnullaConfermaAzione').addEventListener('click', chiudiConfermaAzione);
  $('#btnChiudiConfermaAzione').addEventListener('click', chiudiConfermaAzione);
  $('#modalConfermaAzione').addEventListener('click', (e) => { if (e.target.id === 'modalConfermaAzione') chiudiConfermaAzione(); });

  $('#selectMunicipio').addEventListener('change', onCambiaMunicipioSetup);
  $('#inputSezione').addEventListener('input', onCambiaSezioneSetup);
  $('#btnConferma').addEventListener('click', onConfermaSetup);
  $('#btnCercaVia').addEventListener('click', onCercaVia);
  $('#btnGestisciSeggi').addEventListener('click', onGestisciSeggi);
  $('#btnAnnullaAggiungiSeggio').addEventListener('click', onAnnullaAggiungiSeggio);
  $('#selectSeggioAttivo').addEventListener('change', onCambiaSeggioAttivo);
  $('#btnVaiAffluenza').addEventListener('click', () => attivaTabPerNome('affluenza'));
  $('#btnVaiScrutinio').addEventListener('click', () => attivaTabPerNome('scrutinio'));
  $('#btnVaiInvii').addEventListener('click', () => attivaTabPerNome('invii'));
  $('#homeNextActionButton').addEventListener('click', (e) => attivaTabPerNome(e.currentTarget.dataset.targetTab || 'home'));
  $('#btnHomeModificaElettori').addEventListener('click', onModificaElettori);
  $('#btnHomeCondividi').addEventListener('click', onCondividi);
  $('#btnAssistenza').addEventListener('click', apriAssistenza);
  $('#btnChiudiAssistenza').addEventListener('click', chiudiAssistenza);
  $('#modalAssistenza').addEventListener('click', (e) => { if (e.target.id === 'modalAssistenza') chiudiAssistenza(); });
  $('#btnCopyDiagnostics').addEventListener('click', copiaDiagnostica);
  $('#btnAccessibilita').addEventListener('click', toggleAccessibilita);
  $('#btnDeviceCheck').addEventListener('click', () => eseguiControlloDispositivo(true));
  $('#btnRiprovaDeviceCheck').addEventListener('click', () => eseguiControlloDispositivo(true));
  $('#btnChiudiDeviceCheck').addEventListener('click', () => { $('#modalDeviceCheck').hidden = true; });
  $('#btnChiudiDeviceCheck2').addEventListener('click', () => { $('#modalDeviceCheck').hidden = true; });
  $('#modalDeviceCheck').addEventListener('click', (e) => { if (e.target.id === 'modalDeviceCheck') $('#modalDeviceCheck').hidden = true; });
  $('#btnUpdateApp').addEventListener('click', applicaAggiornamento);
  $$('.scrutiny-step').forEach((btn) => btn.addEventListener('click', () => {
    $$('.scrutiny-step').forEach((b) => b.classList.toggle('active', b === btn));
    const target = document.getElementById(btn.dataset.scrollStep);
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  $('#affMaschi').addEventListener('input', aggiornaTotaleAffluenza);
  $('#affFemmine').addEventListener('input', aggiornaTotaleAffluenza);
  $('#affTotaleVotanti').addEventListener('input', aggiornaTotaleAffluenza);
  $$('#modalitaAffluenza .chip').forEach((c) => c.addEventListener('click', () => impostaModalitaAffluenza(c.dataset.modalita)));
  $('#btnModificaElettori').addEventListener('click', onModificaElettori);
  $('#btnSalvaElettori').addEventListener('click', salvaElettoriDaModal);
  $('#btnAnnullaModificaElettori').addEventListener('click', chiudiModalElettori);
  $('#btnChiudiModificaElettori').addEventListener('click', chiudiModalElettori);
  $('#inputModificaElettori').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      salvaElettoriDaModal();
    }
  });
  $('#modalElettori').addEventListener('click', (e) => {
    if (e.target.id === 'modalElettori') chiudiModalElettori();
  });
  $('#btnInviaAffluenza').addEventListener('click', onInviaAffluenza);
  $('#btnAnnullaAffluenza').addEventListener('click', chiudiFormAffluenza);

  $('#tab-scrutinio').addEventListener('input', (e) => {
    if (!e.target.matches('input, textarea')) return;
    aggiornaAvvisiScrutinio();
    pianificaSalvataggioBozzaScrutinio();
  });
  $('#btnSalvaBozzaScrutinio').addEventListener('click', () => salvaBozzaScrutinio(true, 'bozza'));
  $('#btnEliminaBozzaScrutinio').addEventListener('click', eliminaBozzaScrutinio);
  $('#btnInviaScrutinio').addEventListener('click', onInviaScrutinio);
  $('#btnCorreggiScrutinio').addEventListener('click', correggiUltimoScrutinio);
  $('#checkConfermaScrutinio').addEventListener('change', () => { $('#btnConfermaInvio').disabled = !$('#checkConfermaScrutinio').checked; });
  $('#btnConfermaInvio').addEventListener('click', onConfermaInvioScrutinio);
  $('#btnAnnullaInvio').addEventListener('click', () => {
    $('#modalRiepilogo').hidden = true;
    $('#checkConfermaScrutinio').checked = false;
    $('#btnConfermaInvio').disabled = true;
    payloadScrutinioPronto = null;
  });
  $('#btnRiprovaInvii').addEventListener('click', async () => {
    if (!navigator.onLine) { showToast('Sei offline: riproverò automaticamente.'); return; }
    showToast('Aggiorno invii e storico…');
    await provaSvuotaCode();
    const storicoOk = await sincronizzaStoricoDaServer(true);
    showToast(storicoOk ? 'Invii e storico aggiornati dal coordinamento.' : 'Invii locali verificati, ma non riesco ad aggiornare lo storico.', 4500);
  });
  $('#btnCondividi').addEventListener('click', onCondividi);
  $('#btnShareWhatsApp').addEventListener('click', condividiConWhatsApp);
  $('#btnShareSms').addEventListener('click', condividiConSms);
  $('#btnShareEmail').addEventListener('click', condividiConEmail);
  $('#btnCopySummary').addEventListener('click', copiaRiepilogo);
  $('#btnChiudiCondivisione').addEventListener('click', chiudiModalCondivisione);
  $('#modalCondivisione').addEventListener('click', (e) => { if (e.target.id === 'modalCondivisione') chiudiModalCondivisione(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#modalConfermaAzione').hidden) chiudiConfermaAzione();
    else if (!$('#modalLogout').hidden) chiudiModalLogout();
    else if (!$('#modalElettori').hidden) chiudiModalElettori();
    else if (!$('#modalCondivisione').hidden) chiudiModalCondivisione();
    else if (!$('#modalAssistenza').hidden) chiudiAssistenza();
    else if (!$('#modalDeviceCheck').hidden) $('#modalDeviceCheck').hidden = true;
  });

  migraDaProfiloSingolo();
  STATE.persona = loadJSON(LS.PERSONA, null);
  STATE.seggi = loadJSON(LS.SEGGI, []);
  STATE.seggioAttivoId = loadJSON(LS.SEGGIO_ATTIVO, null) || (STATE.seggi[0] && STATE.seggi[0].id) || null;
  ricostruisciProfileDaSeggioAttivo();

  // Il bearer token vive solo nella sessione del browser. Se l'app viene chiusa
  // completamente sarà richiesto un nuovo accesso online; le code offline restano
  // conservate in namespace isolati e si riaprono solo con lo stesso codice.
  const ownerEsistente = ownerStorageId();
  const tokenEsistente = sessionToken();
  const personaEsistente = loadJSON(LS.PERSONA, null);
  const seggiEsistenti = loadJSON(LS.SEGGI, []);

  if (!ownerEsistente || !tokenEsistente || !personaEsistente || !personaEsistente.nome || !seggiEsistenti.length) {
    clearSessionCredentials();
    removeJSON(LS.PERSONA);
    removeJSON(LS.SEGGI);
    removeJSON(LS.SEGGIO_ATTIVO);
    localStorage.removeItem(LS.OWNER);
    STATE.persona = null; STATE.seggi = []; STATE.seggioAttivoId = null; STATE.profile = null;
    $('#screen-login').classList.add('active');
    return;
  }

  if (STATE.profile) {
    try {
      STATE.municipioData = await caricaDatiMunicipio(STATE.profile.municipio);
      mostraDashboard();
    } catch (e) {
      // dati municipio non disponibili (mai aperta con connessione): resta sulla schermata di setup
      predisponiSchermataSetup(false);
    }
  } else {
    predisponiSchermataSetup(false);
  }

  aggiornaConfigInBackground().catch(() => {});
  provaSvuotaCode().then(() => sincronizzaStoricoDaServer(true));
  setInterval(provaSvuotaCode, 45000); // riprova periodica in background, utile su connessioni instabili
  const intervalloMessaggi = Math.max(60, Number(impostazione('INTERVALLO_MESSAGGI_SECONDI', '120')) || 120) * 1000;
  clearInterval(messaggiTimer);
  messaggiTimer = setInterval(() => caricaMessaggi(true), intervalloMessaggi);
  window.addEventListener('pagehide', () => {
    if (STATE.profile && timerBozzaScrutinio) salvaBozzaScrutinio(false, 'bozza');
  });
}

// Compatibilità: chi aveva già usato l'app prima dell'aggiornamento multi-seggio
// aveva un unico oggetto "rs_profile". Lo convertiamo automaticamente, una sola
// volta, nel nuovo formato persona + elenco seggi, senza perdere nulla.
function migraDaProfiloSingolo() {
  const vecchio = loadJSON('rs_profile', null);
  if (!vecchio) return;
  if (!loadJSON(LS.PERSONA, null)) saveJSON(LS.PERSONA, { nome: vecchio.nome, telefono: vecchio.telefono });
  const seggiAttuali = loadJSON(LS.SEGGI, []);
  const id = idSeggio(vecchio.municipio, vecchio.sezione);
  if (!seggiAttuali.some((s) => s.id === id)) {
    seggiAttuali.push({ id, municipio: vecchio.municipio, sezione: vecchio.sezione, addr: vecchio.addr, cap: vecchio.cap, elettori: vecchio.elettori || null });
    saveJSON(LS.SEGGI, seggiAttuali);
  }
  if (!loadJSON(LS.SEGGIO_ATTIVO, null)) saveJSON(LS.SEGGIO_ATTIVO, id);
  localStorage.removeItem('rs_profile');
}

document.addEventListener('DOMContentLoaded', avvia);
