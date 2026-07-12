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
const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbzL7HuHmf5CDNwbMhYDySBRLcEWsC-GcxSmkpZoVHsKK83hvhTFGPaJQx32iSXL-EJYDQ/exec';
const APP_VERSION = '4.0.0';

const NOMI_MUNICIPI = {
  '01':'Municipio I','02':'Municipio II','03':'Municipio III','04':'Municipio IV',
  '05':'Municipio V','06':'Municipio VI','07':'Municipio VII','08':'Municipio VIII',
  '09':'Municipio IX','10':'Municipio X','11':'Municipio XI','12':'Municipio XII',
  '13':'Municipio XIII','14':'Municipio XIV','15':'Municipio XV',
};

const LS = {
  CODICE: 'rs_codice',
  TOKEN: 'rs_session_token',
  TOKEN_EXPIRES: 'rs_session_expires',
  PERSONA: 'rs_persona',
  SEGGI: 'rs_seggi',
  SEGGIO_ATTIVO: 'rs_seggio_attivo',
  CONFIG: 'rs_config_cache',
  MUN_DATA: (mu) => 'rs_mun_data_' + mu,
  QUEUE_AFF: 'rs_queue_affluenza',
  QUEUE_SCR: 'rs_queue_scrutinio',
  SCR_DRAFT: (mu, sez) => 'rs_scrutinio_draft_' + mu + '_' + sez,
  INSTALL_DISMISSED: 'rs_install_dismissed',
};

let STATE = {
  profile: null,       // persona + seggio attivo, fusi insieme (compatibilità col resto del codice)
  persona: null,       // { nome, telefono }
  seggi: [],           // [{ id, municipio, sezione, addr, cap, elettori }, ...]
  seggioAttivoId: null,
  municipioData: null,
  config: null,
  modalitaAggiungiSeggio: false, // true quando si torna al setup per aggiungere un seggio in più (persona già nota)
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

function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { return fallback; }
}
function saveJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { return false; }
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
function sessionToken() { return loadJSON(LS.TOKEN, ''); }
function impostaNonValido(el, invalido) {
  if (!el) return;
  if (invalido) el.setAttribute('aria-invalid', 'true');
  else el.removeAttribute('aria-invalid');
}
function trovaItem(queueKey, idInvio) {
  return loadJSON(queueKey, []).find((it) => it.idInvio === idInvio) || null;
}
function idsSostituiti(queueKey) {
  return new Set(loadJSON(queueKey, []).map((it) => it.payload && it.payload.correzioneDi).filter(Boolean));
}
function aggiornaTokenInviiInCoda(token) {
  [LS.QUEUE_AFF, LS.QUEUE_SCR].forEach((queueKey) => {
    const coda = loadJSON(queueKey, []);
    let changed = false;
    coda.forEach((item) => {
      if (item.status !== 'synced' && item.payload) { item.payload.sessionToken = token; changed = true; }
    });
    if (changed) saveJSON(queueKey, coda);
  });
}

// ---------------------------------------------------------------------
// STATO CONNESSIONE
// ---------------------------------------------------------------------
function aggiornaStatoConnessione() {
  const pill = $('#connStatus');
  if (navigator.onLine) {
    pill.textContent = 'Online';
    pill.className = 'status-pill online';
  } else {
    pill.textContent = 'Offline · i dati restano in coda';
    pill.className = 'status-pill offline';
  }
}
window.addEventListener('online', () => { aggiornaStatoConnessione(); provaSvuotaCode(); });
window.addEventListener('offline', aggiornaStatoConnessione);

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
  return BACKEND_URL && BACKEND_URL.indexOf('http') === 0;
}

async function caricaConfig() {
  if (!backendConfigurato()) {
    const cached = loadJSON(LS.CONFIG, null);
    STATE.config = cached || configVuota();
    return STATE.config;
  }
  try {
    const res = await fetch(BACKEND_URL + '?action=config', { cache: 'no-store', redirect: 'follow' });
    const testo = await res.text();
    const data = JSON.parse(testo);
    if (!data.ok) throw new Error(data.error || 'Configurazione non valida');
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
  return { ok: false, municipi: [], liste: { capitolina: [], municipio: {} }, candidati: { capitolina: [], municipio: {} }, orari: [] };
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
    const url = BACKEND_URL + '?action=verifica_codice&codice=' + encodeURIComponent(codice);
    const res = await fetch(url, { cache: 'no-store', redirect: 'follow' });
    const data = JSON.parse(await res.text());
    if (!data.ok || !data.sessionToken) throw new Error(data.error || 'Codice non valido.');

    saveJSON(LS.CODICE, codice);
    saveJSON(LS.TOKEN, data.sessionToken);
    saveJSON(LS.TOKEN_EXPIRES, data.sessionExpiresAt || null);
    aggiornaTokenInviiInCoda(data.sessionToken);
    STATE.persona = { nome: data.nome || 'Rappresentante', telefono };
    saveJSON(LS.PERSONA, STATE.persona);
    STATE.seggi = [];

    if (data.sezioni && data.sezioni.length > 0) {
      for (const assegnazione of data.sezioni) {
        try {
          const munData = await caricaDatiMunicipio(assegnazione.municipio);
          const sezInfo = trovaSezione(munData, assegnazione.sezione) || { s: assegnazione.sezione, addr: '', cap: '' };
          const id = idSeggio(assegnazione.municipio, sezInfo.s);
          if (!STATE.seggi.some((seg) => seg.id === id)) {
            STATE.seggi.push({ id, municipio: assegnazione.municipio, sezione: sezInfo.s, addr: sezInfo.addr, cap: sezInfo.cap, elettori: null });
          }
        } catch (e) {
          const id = idSeggio(assegnazione.municipio, assegnazione.sezione);
          if (!STATE.seggi.some((seg) => seg.id === id)) {
            STATE.seggi.push({ id, municipio: assegnazione.municipio, sezione: assegnazione.sezione, addr: '', cap: '', elettori: null });
          }
        }
      }
      saveJSON(LS.SEGGI, STATE.seggi);
      STATE.seggioAttivoId = STATE.seggi[0].id;
      saveJSON(LS.SEGGIO_ATTIVO, STATE.seggioAttivoId);
      ricostruisciProfileDaSeggioAttivo();
      mostraDashboard();
      showToast('Accesso effettuato come ' + STATE.persona.nome + '.');
    } else {
      vaiAlSetupPrecompilato(data);
    }
  } catch (e) {
    errBox.textContent = e.message === 'Failed to fetch'
      ? 'Connessione non disponibile. Il primo accesso richiede la rete.'
      : (e.message || 'Impossibile verificare il codice.');
    errBox.hidden = false;
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
  const codice = loadJSON(LS.CODICE, null);
  if (!codice) {
    $('#screen-login').classList.add('active');
    return true;
  }
  return false;
}

function onLogout() {
  if (!confirm('Uscire da Rete Seggi su questo dispositivo? Gli invii già sincronizzati restano nel foglio; le bozze e gli invii in coda resteranno sul telefono.')) return;
  [LS.CODICE, LS.TOKEN, LS.TOKEN_EXPIRES, LS.PERSONA, LS.SEGGI, LS.SEGGIO_ATTIVO].forEach((key) => localStorage.removeItem(key));
  STATE.persona = null; STATE.seggi = []; STATE.seggioAttivoId = null; STATE.profile = null;
  $('#screen-dashboard').classList.remove('active');
  $('#screen-setup').classList.remove('active');
  $('#screen-login').classList.add('active');
  $('#btnLogout').hidden = true;
  $('#inputCodice').value = '';
  $('#loginTelefono').value = '';
  $('#inputCodice').focus();
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

  if (haPersona && (modalitaAggiungi || loadJSON(LS.CODICE, null))) {
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
  STATE.seggioAttivoId = id;
  saveJSON(LS.SEGGIO_ATTIVO, id);
  ricostruisciProfileDaSeggioAttivo();
  mostraDashboard();
}

function rimuoviSeggio(id) {
  const seg = trovaSeggio(id);
  if (!seg) return;
  if (!confirm('Rimuovere la Sezione ' + seg.sezione + ' (' + (NOMI_MUNICIPI[seg.municipio] || seg.municipio) + ') dal tuo elenco?\n\nI dati già inviati al coordinamento restano comunque salvati sul Google Sheet: questo rimuove solo il seggio dal tuo telefono.')) return;
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
  $('#btnLogout').hidden = false;
  $('#screen-login').classList.remove('active');
  $('#screen-setup').classList.remove('active');
  $('#screen-dashboard').classList.add('active');
  popolaSelectSeggioAttivo();
  $('#seggioIndirizzo').textContent = STATE.profile.addr + ' · CAP ' + STATE.profile.cap;
  renderElettoriBanner();
  renderAffluenza();
  renderScrutinioListeECandidati();
  caricaBozzaScrutinio();
  renderTabellaInvii();
  aggiornaBadgeInCoda();
  aggiornaPulsanteCorrezioneScrutinio();
}

function renderElettoriBanner() {
  const el = STATE.profile.elettori;
  $('#elettoriValore').textContent = el ? el : 'non indicati';
  $('#elettoriBanner').classList.toggle('warnings', !el);
}

function onModificaElettori() {
  const attuale = STATE.profile.elettori || '';
  const v = prompt('Elettori aventi diritto al voto in questa sezione (numero fisso, te lo conferma il presidente di seggio):', attuale);
  if (v === null) return;
  const n = interoNonNegativo(v.trim());
  if (n === null || n === 0) {
    showToast('Inserisci un numero intero maggiore di zero.');
    return;
  }
  STATE.profile.elettori = n;
  const seg = trovaSeggio(STATE.seggioAttivoId);
  if (seg) { seg.elettori = n; saveJSON(LS.SEGGI, STATE.seggi); }
  renderElettoriBanner();
  renderAffluenza();
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
  impostaModalitaAffluenza('rapido');
  aggiornaTotaleAffluenza();
  $('#formAffluenza').hidden = false;
}
function chiudiFormAffluenza() { $('#formAffluenza').hidden = true; affluenzaCorrente = null; correzioneAffluenzaId = null; $('#affCorrezioneBox').hidden = true; }

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
    !idsSostituiti(LS.QUEUE_AFF).has(it.idInvio)
  );
  if (precedenti.length && !correzioneAffluenzaId) errori.push('Esiste già una rilevazione per questo orario. Usa “Correggi” nella tabella.');
  if (errori.length) {
    errBox.innerHTML = '<ul>' + errori.map((e) => '<li>' + escapeHtml(e) + '</li>').join('') + '</ul>';
    errBox.hidden = false;
    return;
  }

  const payload = {
    tipo: 'affluenza', idInvio: uuid(), sessionToken: sessionToken(),
    municipio: STATE.profile.municipio, sezione: STATE.profile.sezione,
    telefono: STATE.profile.telefono,
    giorno: affluenzaCorrente.giorno, orario: affluenzaCorrente.orario,
    elettori: STATE.profile.elettori || null, maschi, femmine, totale,
    note: $('#affNote').value.trim(),
    correzioneDi: correzioneAffluenzaId || '',
    motivoCorrezione: correzioneAffluenzaId ? $('#affMotivoCorrezione').value.trim() : '',
    versioneApp: APP_VERSION,
  };
  if (!accodaInvio(LS.QUEUE_AFF, payload)) {
    errBox.textContent = 'Spazio di archiviazione del telefono non disponibile. Non chiudere la pagina e libera spazio prima di riprovare.';
    errBox.hidden = false;
    return;
  }
  const id = payload.idInvio;
  chiudiFormAffluenza();
  renderAffluenza();
  aggiornaBadgeInCoda();
  showToast(navigator.onLine ? 'Salvato sul telefono. Verifico la ricezione…' : 'Salvato sul telefono. Sarà inviato quando torna la rete.');
  await provaSvuotaCode();
  const item = trovaItem(LS.QUEUE_AFF, id);
  if (item && item.status === 'synced') showToast('Rilevazione ricevuta dal coordinamento.');
  else if (item && item.status === 'error') showToast('Salvata sul telefono, ma non ancora ricevuta. Controlla “I miei invii”.', 4500);
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
    const el = p.elettori || STATE.profile.elettori;
    const perc = el ? percentuale(p.totale, el) + '%' : '—';
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
  correzioneAffluenzaId = idInvio;
  $('#affCorrezioneBox').hidden = false;
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
  $('#affMotivoCorrezione').focus();
}

function statoPillHtml(status) {
  if (status === 'synced') return '<span class="pill good">inviato</span>';
  if (status === 'syncing') return '<span class="pill warn">invio…</span>';
  if (status === 'error') return '<span class="pill bad">da riprovare</span>';
  return '<span class="pill warn">sul telefono</span>';
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
  cont.innerHTML = '';
  if (!voci.length) {
    cont.innerHTML = '<p class="dyn-empty">Non ancora configurato dal coordinamento.</p>';
    return;
  }
  voci.forEach((nome, idx) => {
    const row = document.createElement('div');
    row.className = 'dyn-row';
    const id = prefix + '_' + idx;
    row.innerHTML = '<label for="' + id + '">' + escapeHtml(nome) + '</label>' +
      '<input id="' + id + '" type="number" min="0" step="1" inputmode="numeric" data-nome="' + escapeHtml(nome) + '" value="0" />';
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
    const sommaSchede = blocco.valide + blocco.bianche + blocco.nulle + blocco.contestate;
    if (sommaSchede && s.votanti && sommaSchede !== s.votanti) {
      avvisi.push('Scheda ' + (k === 'comune' ? 'Comune' : 'Municipio') + ': valide+bianche+nulle+contestate (' + sommaSchede + ') non coincide con i votanti (' + s.votanti + '). Con il voto disgiunto può succedere: verifica comunque.');
    }
  });
  return { errori, avvisi };
}

function aggiornaAvvisiScrutinio() {
  const s = raccogliScrutinio();
  const { avvisi } = validaScrutinio(s);
  const box = $('#scrutinioAvviso');
  if (avvisi.length) {
    box.innerHTML = '<strong>Promemoria</strong><ul>' + avvisi.map((a) => '<li>' + escapeHtml(a) + '</li>').join('') + '</ul>';
    box.hidden = false;
  } else { box.hidden = true; }
}

function chiaveBozza() { return LS.SCR_DRAFT(STATE.profile.municipio, STATE.profile.sezione); }

function salvaBozzaScrutinio(manuale) {
  saveJSON(chiaveBozza(), raccogliScrutinio());
  if (manuale) showToast('Bozza salvata sul telefono.');
}

function caricaBozzaScrutinio() {
  const bozza = loadJSON(chiaveBozza(), null);
  if (!bozza) return;
  $('#scElettori').value = bozza.elettori || '';
  $('#scVotanti').value = bozza.votanti || '';
  $('#comValide').value = bozza.comune.valide || '';
  $('#comBianche').value = bozza.comune.bianche || '';
  $('#comNulle').value = bozza.comune.nulle || '';
  $('#comContestate').value = bozza.comune.contestate || '';
  $('#munValide').value = bozza.municipio.valide || '';
  $('#munBianche').value = bozza.municipio.bianche || '';
  $('#munNulle').value = bozza.municipio.nulle || '';
  $('#munContestate').value = bozza.municipio.contestate || '';
  $('#scNote').value = bozza.note || '';
  (bozza.comune.liste || []).forEach((l, i) => { const el = $('#lc_' + i); if (el) el.value = l.voti; });
  (bozza.municipio.liste || []).forEach((l, i) => { const el = $('#lm_' + i); if (el) el.value = l.voti; });
  (bozza.comune.preferenze || []).forEach((p, i) => { const el = $('#pc_' + i); if (el) el.value = p.voti; });
  (bozza.municipio.preferenze || []).forEach((p, i) => { const el = $('#pm_' + i); if (el) el.value = p.voti; });
}

function scrutinioGiaInviato() {
  const tutti = loadJSON(LS.QUEUE_SCR, []);
  return tutti.some((it) => it.payload.sezione === STATE.profile.sezione && it.payload.municipio === STATE.profile.municipio);
}

function aggiornaBadgeScrutinio() {
  const badge = $('#scrutinioBadge');
  const ultimo = ultimoScrutinioAttivo();
  if (!ultimo) { badge.textContent = 'non inviato'; badge.className = 'pill neutral'; return; }
  if (ultimo.status === 'synced') { badge.textContent = ultimo.payload.correzioneDi ? 'correzione sincronizzata' : 'inviato e sincronizzato'; badge.className = 'pill good'; }
  else if (ultimo.status === 'error') { badge.textContent = 'salvato, da riprovare'; badge.className = 'pill bad'; }
  else { badge.textContent = 'salvato sul telefono'; badge.className = 'pill warn'; }
}

let payloadScrutinioPronto = null;
let correzioneScrutinioId = null;

async function onInviaScrutinio() {
  const errBox = $('#scrutinioErrori');
  errBox.hidden = true;
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
  if (avvisi.length && !confirm('Ci sono alcuni promemoria sui numeri inseriti:\n\n' + avvisi.join('\n') + '\n\nVuoi procedere comunque?')) return;

  const idInvio = uuid();
  payloadScrutinioPronto = {
    tipo: 'scrutinio', idInvio, sessionToken: sessionToken(),
    municipio: STATE.profile.municipio, sezione: STATE.profile.sezione,
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

  mostraRiepilogoScrutinio(s);
}

function mostraRiepilogoScrutinio(s) {
  const cont = $('#riepilogoContenuto');
  cont.innerHTML = '';

  function sezioneRiep(titolo, righe) {
    const div = document.createElement('div');
    div.className = 'riepilogo-sezione';
    div.innerHTML = '<h3>' + titolo + '</h3>' + righe.map(([label, val]) =>
      '<div class="riepilogo-row"><span>' + escapeHtml(label) + '</span><span>' +
      escapeHtml(String(val !== null && val !== undefined ? val : '—')) + '</span></div>'
    ).join('');
    cont.appendChild(div);
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
    ...s.comune.liste.filter((l) => l.voti).map((l) => [l.nome, l.voti]),
    ...s.comune.preferenze.filter((p) => p.voti).map((p) => ['Pref. ' + p.nome, p.voti]),
  ]);

  const presidentiList = leggiDynList('pr').filter((x) => x.voti);
  if (presidentiList.length) sezioneRiep('Voti Presidente Municipio', presidentiList.map((x) => [x.nome, x.voti]));

  sezioneRiep('Scheda Municipio', [
    ['Valide', s.municipio.valide], ['Bianche', s.municipio.bianche],
    ['Nulle', s.municipio.nulle], ['Contestate', s.municipio.contestate],
    ...s.municipio.liste.filter((l) => l.voti).map((l) => [l.nome, l.voti]),
    ...s.municipio.preferenze.filter((p) => p.voti).map((p) => ['Pref. ' + p.nome, p.voti]),
  ]);

  if (s.note) sezioneRiep('Note', [['', s.note]]);

  $('#modalRiepilogo').hidden = false;
  requestAnimationFrame(() => $('#btnConfermaInvio').focus());
}

async function onConfermaInvioScrutinio() {
  $('#modalRiepilogo').hidden = true;
  if (!payloadScrutinioPronto) return;
  const id = payloadScrutinioPronto.idInvio;
  if (!accodaInvio(LS.QUEUE_SCR, payloadScrutinioPronto)) {
    showToast('Impossibile salvare sul telefono: spazio non disponibile.', 4500);
    return;
  }
  salvaBozzaScrutinio(false);
  correzioneScrutinioId = null;
  $('#scCorrezioneBox').hidden = true;
  $('#scMotivoCorrezione').value = '';
  aggiornaBadgeScrutinio(); renderTabellaInvii(); aggiornaBadgeInCoda();
  showToast(navigator.onLine ? 'Salvato sul telefono. Verifico la ricezione…' : 'Salvato sul telefono. Sarà inviato quando torna la rete.');
  payloadScrutinioPronto = null;
  await provaSvuotaCode();
  const item = trovaItem(LS.QUEUE_SCR, id);
  if (item && item.status === 'synced') showToast('Scrutinio ricevuto dal coordinamento.');
  else if (item && item.status === 'error') showToast('Scrutinio salvato, ma non ancora ricevuto. Controlla “I miei invii”.', 4500);
}

function ultimoScrutinioAttivo() {
  const sostituiti = idsSostituiti(LS.QUEUE_SCR);
  return loadJSON(LS.QUEUE_SCR, []).filter((it) =>
    it.payload && it.payload.municipio === STATE.profile.municipio && it.payload.sezione === STATE.profile.sezione && !sostituiti.has(it.idInvio)
  ).sort((a, b) => a.creato < b.creato ? 1 : -1)[0] || null;
}

function aggiornaPulsanteCorrezioneScrutinio() {
  $('#btnCorreggiScrutinio').hidden = !ultimoScrutinioAttivo();
}

function impostaDynPerNome(prefix, valori, campoNome) {
  const mappa = new Map((valori || []).map((x) => [x[campoNome || 'nome'], x.voti]));
  $all('[id^="' + prefix + '_"]').forEach((inp) => { inp.value = mappa.get(inp.dataset.nome) ?? 0; });
}

function correggiUltimoScrutinio() {
  const item = ultimoScrutinioAttivo();
  if (!item) return;
  const p = item.payload;
  correzioneScrutinioId = item.idInvio;
  $('#scCorrezioneBox').hidden = false;
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
  $('#scMotivoCorrezione').focus();
}

// =======================================================================
// CODA OFFLINE E INVIO AL BACKEND
// =======================================================================
let sincronizzazioneInCorso = false;

function accodaInvio(queueKey, payload) {
  const coda = loadJSON(queueKey, []);
  coda.push({
    idInvio: payload.idInvio, payload, status: 'pending', creato: new Date().toISOString(),
    tentativi: 0, ultimoTentativo: null, ultimoErrore: '', sincronizzatoIl: null,
  });
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
  if (!payload.sessionToken) throw new Error('Sessione mancante: effettua nuovamente l’accesso.');
  const body = JSON.stringify(payload);
  let errorePost = null;

  try {
    const post = await fetch(BACKEND_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body, cache: 'no-store', redirect: 'follow',
    });
    return await leggiRispostaBackend(post);
  } catch (e) {
    errorePost = e;
  }

  // Compatibilità con alcune distribuzioni Apps Script che non espongono
  // correttamente la risposta CORS delle POST. L'ID invio rende il fallback idempotente.
  const url = BACKEND_URL + '?invio=' + encodeURIComponent(body);
  if (url.length > 7800) throw new Error('Invio troppo grande per il canale di emergenza. Riprova con una connessione stabile.');
  try {
    const get = await fetch(url, { method: 'GET', cache: 'no-store', redirect: 'follow' });
    return await leggiRispostaBackend(get);
  } catch (e) {
    throw e && e.message ? e : errorePost;
  }
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
        if (item.status === 'synced') continue;
        item.status = 'syncing'; item.ultimoTentativo = new Date().toISOString(); cambiato = true;
        saveJSON(queueKey, coda);
        aggiornaBadgeInCoda();
        try {
          const risposta = await inviaAlBackend(item.payload);
          item.status = 'synced';
          item.sincronizzatoIl = new Date().toISOString();
          item.ultimoErrore = '';
          item.rispostaServer = { duplicato: !!risposta.duplicato, correzione: !!risposta.correzione };
          almenoUnSuccesso = true;
        } catch (e) {
          item.status = 'error';
          item.tentativi = (item.tentativi || 0) + 1;
          item.ultimoErrore = e && e.message ? e.message : 'Errore di rete';
          item.codiceErrore = e && e.code ? e.code : '';
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
  const conta = (key) => loadJSON(key, []).filter((i) => i.status !== 'synced').length;
  return conta(LS.QUEUE_AFF) + conta(LS.QUEUE_SCR);
}

function aggiornaBadgeInCoda() {
  const n = contaInCoda();
  const badge = $('#pendingBadge');
  if (n > 0) { badge.hidden = false; badge.textContent = n + (n === 1 ? ' invio da sincronizzare' : ' invii da sincronizzare'); }
  else { badge.hidden = true; }
}

function renderTabellaInvii() {
  const tbody = $('#tabellaInvii tbody');
  tbody.innerHTML = '';
  const sostAff = idsSostituiti(LS.QUEUE_AFF), sostScr = idsSostituiti(LS.QUEUE_SCR);
  const tutti = [
    ...loadJSON(LS.QUEUE_AFF, []).map((i) => ({ ...i, tipo: 'Affluenza', superato: sostAff.has(i.idInvio) })),
    ...loadJSON(LS.QUEUE_SCR, []).map((i) => ({ ...i, tipo: 'Scrutinio', superato: sostScr.has(i.idInvio) })),
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
    if (it.payload.correzioneDi) dettagli += 'Correzione tracciata. ';
    if (it.ultimoErrore) dettagli += it.ultimoErrore;
    else if (it.sincronizzatoIl) dettagli += 'Ricevuto ' + new Date(it.sincronizzatoIl).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    else dettagli += 'Conservato sul dispositivo.';
    const stato = it.superato ? '<span class="pill neutral">sostituito</span>' : statoPillHtml(it.status);
    tr.innerHTML = '<td>' + it.tipo + '</td><td>' + quando + '</td><td>' + stato + '</td><td><span class="status-detail">' + escapeHtml(dettagli) + '</span></td>';
    tbody.appendChild(tr);
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

  const bozza = loadJSON(chiaveBozza(), null);
  if (bozza) {
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

async function onCondividi() {
  salvaBozzaScrutinio(false);
  const testo = generaTestoRiepilogo();
  if (!testo) { showToast('Compila prima i dati della sezione.'); return; }
  if (navigator.share) {
    try { await navigator.share({ title: 'Riepilogo sezione', text: testo }); return; }
    catch (e) { /* utente ha annullato: prosegue con fallback sotto */ }
  }
  const url = 'https://wa.me/?text=' + encodeURIComponent(testo);
  window.open(url, '_blank');
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
  aggiornaStatoConnessione();
  initInstallBanner();
  initTabs();

  await caricaConfig();
  popolaSelectMunicipi();

  $('#btnLogin').addEventListener('click', onLogin);
  $('#inputCodice').addEventListener('keydown', (e) => { if (e.key === 'Enter') onLogin(); });
  $('#loginTelefono').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#inputCodice').focus(); });
  $('#btnLogout').addEventListener('click', onLogout);

  $('#selectMunicipio').addEventListener('change', onCambiaMunicipioSetup);
  $('#inputSezione').addEventListener('input', onCambiaSezioneSetup);
  $('#btnConferma').addEventListener('click', onConfermaSetup);
  $('#btnCercaVia').addEventListener('click', onCercaVia);
  $('#btnGestisciSeggi').addEventListener('click', onGestisciSeggi);
  $('#btnAnnullaAggiungiSeggio').addEventListener('click', onAnnullaAggiungiSeggio);
  $('#selectSeggioAttivo').addEventListener('change', onCambiaSeggioAttivo);

  $('#affMaschi').addEventListener('input', aggiornaTotaleAffluenza);
  $('#affFemmine').addEventListener('input', aggiornaTotaleAffluenza);
  $('#affTotaleVotanti').addEventListener('input', aggiornaTotaleAffluenza);
  $$('#modalitaAffluenza .chip').forEach((c) => c.addEventListener('click', () => impostaModalitaAffluenza(c.dataset.modalita)));
  $('#btnModificaElettori').addEventListener('click', onModificaElettori);
  $('#btnInviaAffluenza').addEventListener('click', onInviaAffluenza);
  $('#btnAnnullaAffluenza').addEventListener('click', chiudiFormAffluenza);

  $all('#tab-scrutinio input, #tab-scrutinio textarea').forEach((el) => {
    el.addEventListener('input', () => { aggiornaAvvisiScrutinio(); });
  });
  $('#btnSalvaBozzaScrutinio').addEventListener('click', () => salvaBozzaScrutinio(true));
  $('#btnInviaScrutinio').addEventListener('click', onInviaScrutinio);
  $('#btnCorreggiScrutinio').addEventListener('click', correggiUltimoScrutinio);
  $('#btnConfermaInvio').addEventListener('click', onConfermaInvioScrutinio);
  $('#btnAnnullaInvio').addEventListener('click', () => { $('#modalRiepilogo').hidden = true; payloadScrutinioPronto = null; });
  $('#btnRiprovaInvii').addEventListener('click', async () => { showToast('Provo a sincronizzare…'); const ok = await provaSvuotaCode(); showToast(ok ? 'Sincronizzazione completata.' : (navigator.onLine ? 'Nessun invio ricevuto: controlla i dettagli.' : 'Sei offline: riproverò automaticamente.')); });
  $('#btnCondividi').addEventListener('click', onCondividi);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  }

  migraDaProfiloSingolo();
  STATE.persona = loadJSON(LS.PERSONA, null);
  STATE.seggi = loadJSON(LS.SEGGI, []);
  STATE.seggioAttivoId = loadJSON(LS.SEGGIO_ATTIVO, null) || (STATE.seggi[0] && STATE.seggi[0].id) || null;
  ricostruisciProfileDaSeggioAttivo();

  // Controlla se c'è un accesso completo salvato (codice + persona + almeno un seggio)
  const codiceEsistente = loadJSON(LS.CODICE, null);
  const tokenEsistente = loadJSON(LS.TOKEN, null);
  const personaEsistente = loadJSON(LS.PERSONA, null);
  const seggiEsistenti = loadJSON(LS.SEGGI, []);

  if (!codiceEsistente || !tokenEsistente || !personaEsistente || !personaEsistente.nome || !seggiEsistenti.length) {
    // Dati incompleti: mostra sempre la schermata di login
    localStorage.removeItem(LS.CODICE);
    localStorage.removeItem(LS.PERSONA);
    localStorage.removeItem(LS.TOKEN);
    localStorage.removeItem(LS.TOKEN_EXPIRES);
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

  provaSvuotaCode();
  setInterval(provaSvuotaCode, 45000); // riprova periodica in background, utile su connessioni instabili
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
