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
  LOG: 'Log Errori',
};

const BACKEND_VERSION = '11.0.0';
const SESSION_TTL_SECONDS = 21600;

const NOMI_MUNICIPI = {
  '01': 'Municipio I', '02': 'Municipio II', '03': 'Municipio III',
  '04': 'Municipio IV', '05': 'Municipio V', '06': 'Municipio VI',
  '07': 'Municipio VII', '08': 'Municipio VIII', '09': 'Municipio IX',
  '10': 'Municipio X', '11': 'Municipio XI', '12': 'Municipio XII',
  '13': 'Municipio XIII', '14': 'Municipio XIV', '15': 'Municipio XV',
};

// ===================== ENDPOINT WEB ========================================

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || '';
    if (action === 'config') return jsonOutput(buildConfig());
    if (action === 'ping' || action === 'health') return jsonOutput({ ok: true, backendVersion: BACKEND_VERSION, time: new Date().toISOString() });
    // Compatibilità temporanea con vecchie versioni. Non usare per nuovi accessi.
    if (action === 'verifica_codice') return jsonOutput(creaSessione((e.parameter && e.parameter.codice) || ''));
    return jsonOutput({ ok: false, code: 'UNKNOWN_ACTION', error: 'Azione non riconosciuta: ' + action });
  } catch (err) {
    logError('doGet', err);
    return jsonOutput({ ok: false, code: 'SERVER_ERROR', error: String(err) });
  }
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) return jsonOutput({ ok: false, code: 'EMPTY_REQUEST', error: 'Richiesta vuota' });
    const body = JSON.parse(e.postData.contents);
    if (body.tipo === 'login') return jsonOutput(creaSessione(body.codice || ''));
    if (body.tipo === 'affluenza') return jsonOutput(salvaAffluenza(body));
    if (body.tipo === 'scrutinio') return jsonOutput(salvaScrutinio(body));
    return jsonOutput({ ok: false, code: 'UNKNOWN_TYPE', error: 'Tipo richiesta non riconosciuto: ' + body.tipo });
  } catch (err) {
    logError('doPost', err);
    return jsonOutput({ ok: false, code: 'SERVER_ERROR', error: String(err) });
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

// ===================== CONFIGURAZIONE (lettura fogli) ======================

function verificaCodice(codice) {
  if (!codice) return { ok: false, error: 'Codice non fornito' };
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!sh) return { ok: false, error: 'Foglio rappresentanti non trovato' };
  const rows = sh.getDataRange().getValues();
  const sezioni = [];
  let nome = '';
  let disattivato = false;

  for (let i = 1; i < rows.length; i++) {
    const [cod, nomeCella, municipio, sezione, attivo] = rows[i];
    if (!cod) continue;
    if (String(cod).trim().toUpperCase() !== String(codice).trim().toUpperCase()) continue;

    const isAttivo = attivo === true || String(attivo).toUpperCase() === 'TRUE' || String(attivo).toUpperCase() === 'VERO';
    if (!isAttivo) { disattivato = true; continue; }

    if (!nome) nome = String(nomeCella).trim();
    if (municipio && sezione) {
      sezioni.push({
        municipio: String(Math.round(Number(municipio))).padStart(2, '0'),
        sezione: String(sezione).trim(),
      });
    }
  }

  if (!nome && !sezioni.length) {
    if (disattivato) return { ok: false, error: 'Codice disattivato. Contatta il coordinamento.' };
    return { ok: false, error: 'Codice non riconosciuto. Controlla di averlo scritto correttamente.' };
  }

  return { ok: true, nome: nome, sezioni: sezioni };
}


function creaSessione(codice) {
  const verifica = verificaCodice(codice);
  if (!verifica.ok) return verifica;
  const token = Utilities.getUuid() + Utilities.getUuid();
  const sessione = {
    codice: String(codice).trim().toUpperCase(),
    nome: verifica.nome,
    sezioni: verifica.sezioni,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  CacheService.getScriptCache().put('session:' + token, JSON.stringify(sessione), SESSION_TTL_SECONDS);
  return {
    ok: true,
    nome: verifica.nome,
    sezioni: verifica.sezioni,
    sessionToken: token,
    sessionExpiresAt: new Date(sessione.expiresAt).toISOString(),
    dataRevision: PropertiesService.getScriptProperties().getProperty('DATA_REVISION') || '1'
  };
}

function leggiSessione(token) {
  if (!token) return null;
  const raw = CacheService.getScriptCache().get('session:' + token);
  if (!raw) return null;
  const sessione = JSON.parse(raw);
  if (!sessione.expiresAt || sessione.expiresAt < Date.now()) return null;
  return sessione;
}

function autorizzaInvio(body) {
  const sessione = leggiSessione(body.sessionToken);
  if (!sessione) return { ok: false, code: 'SESSION_EXPIRED', error: 'Sessione scaduta. Effettua nuovamente l’accesso.' };
  const mu = String(body.municipio || '').padStart(2, '0');
  const sezione = String(body.sezione || '').trim();
  const assegnata = (sessione.sezioni || []).some(function(s) { return s.municipio === mu && String(s.sezione) === sezione; });
  if (!assegnata) return { ok: false, code: 'SECTION_NOT_ASSIGNED', error: 'Questa sezione non è assegnata al tuo codice.' };
  body.codice = sessione.codice;
  body.rappresentante = sessione.nome;
  return { ok: true, sessione: sessione };
}

function validaIntero(v, nome, obbligatorio) {
  if ((v === '' || v === null || v === undefined) && !obbligatorio) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(nome + ' deve essere un numero intero non negativo.');
  return n;
}

function buildConfig() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

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

  return { ok: true, municipi, liste, candidati, sindaci, presidenti, orari, dataRevision: PropertiesService.getScriptProperties().getProperty('DATA_REVISION') || '1', app: { backendVersion: BACKEND_VERSION, versioneMinima: '11.0.0', modalitaDemo: false }, generatoIl: new Date().toISOString() };
}

// ===================== SALVATAGGIO INVII =====================================

function salvaAffluenza(body) {
  const auth = autorizzaInvio(body);
  if (!auth.ok) return auth;
  try {
    const totale = validaIntero(body.totale, 'Totale votanti', true);
    const maschi = validaIntero(body.maschi, 'Votanti maschi', false);
    const femmine = validaIntero(body.femmine, 'Votanti femmine', false);
    const elettori = validaIntero(body.elettori, 'Elettori', false);
    if (maschi !== null && femmine !== null && maschi + femmine !== totale) return { ok:false, code:'INVALID_DATA', error:'Maschi e femmine non coincidono con il totale.' };
    if (elettori !== null && totale > elettori) return { ok:false, code:'INVALID_DATA', error:'I votanti non possono superare gli elettori.' };
    if (body.correzioneDi && !String(body.motivoCorrezione || '').trim()) return { ok:false, code:'INVALID_DATA', error:'La correzione richiede una motivazione.' };
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      const sh = getOrCreateSheet(FOGLI.AFFLUENZA, [
        'Timestamp', 'ID Invio', 'Codice', 'Municipio', 'Sezione', 'Rappresentante', 'Telefono',
        'Giorno', 'Orario', 'Elettori', 'Maschi', 'Femmine', 'Totale', '% Affluenza', 'Note',
        'Correzione di', 'Motivo correzione', 'Versione app'
      ]);
      if (gia_inviato(sh, body.idInvio)) return { ok: true, duplicato: true, idInvio: body.idInvio, ricevutoIl: new Date().toISOString() };
      if (body.correzioneDi && !gia_inviato(sh, body.correzioneDi)) return { ok:false, code:'CORRECTION_TARGET_NOT_FOUND', error:'Invio originale non trovato.' };
      const perc = elettori ? Math.round((totale / elettori) * 1000) / 10 : '';
      sh.appendRow([new Date(), body.idInvio || Utilities.getUuid(), body.codice, body.municipio, body.sezione,
        body.rappresentante, body.telefono || '', body.giorno || '', body.orario || '',
        elettori === null ? '' : elettori, maschi === null ? '' : maschi, femmine === null ? '' : femmine,
        totale, perc, body.note || '', body.correzioneDi || '', body.motivoCorrezione || '', body.versioneApp || '' ]);
      return { ok: true, idInvio: body.idInvio, ricevutoIl: new Date().toISOString() };
    } finally { lock.releaseLock(); }
  } catch(err) { return { ok:false, code:'INVALID_DATA', error:String(err.message || err) }; }
}

function salvaScrutinio(body) {
  const auth = autorizzaInvio(body);
  if (!auth.ok) return auth;
  try {
    const idInvio = body.idInvio || Utilities.getUuid();
    const elettori = validaIntero(body.elettori, 'Elettori', true);
    const votanti = validaIntero(body.votanti, 'Votanti', true);
    if (votanti > elettori) return { ok:false, code:'INVALID_DATA', error:'I votanti non possono superare gli elettori.' };
    if (body.correzioneDi && !String(body.motivoCorrezione || '').trim()) return { ok:false, code:'INVALID_DATA', error:'La correzione richiede una motivazione.' };
    const sc = body.schedaComune || {}, sm = body.schedaMunicipio || {};
    ['valide','bianche','nulle','contestate'].forEach(function(k){ validaIntero(sc[k], 'Comune '+k, true); validaIntero(sm[k], 'Municipio '+k, true); });
    const totC = Number(sc.valide)+Number(sc.bianche)+Number(sc.nulle)+Number(sc.contestate);
    const totM = Number(sm.valide)+Number(sm.bianche)+Number(sm.nulle)+Number(sm.contestate);
    if (totC !== votanti || totM !== votanti) return { ok:false, code:'INVALID_DATA', error:'Il totale delle schede Comune e Municipio deve coincidere con i votanti.' };
    const lock = LockService.getScriptLock(); lock.waitLock(20000);
    try {
      const shRiepilogo = getOrCreateSheet(FOGLI.SCRUTINIO, [
        'Timestamp','ID Invio','Codice','Municipio','Sezione','Rappresentante','Telefono','Elettori','Votanti',
        'Comune - Valide','Comune - Bianche','Comune - Nulle','Comune - Contestate',
        'Municipio - Valide','Municipio - Bianche','Municipio - Nulle','Municipio - Contestate','Note',
        'Correzione di','Motivo correzione','Versione app'
      ]);
      if (gia_inviato(shRiepilogo, idInvio)) return { ok:true, duplicato:true, idInvio:idInvio, ricevutoIl:new Date().toISOString() };
      if (body.correzioneDi && !gia_inviato(shRiepilogo, body.correzioneDi)) return { ok:false, code:'CORRECTION_TARGET_NOT_FOUND', error:'Scrutinio originale non trovato.' };
      shRiepilogo.appendRow([new Date(),idInvio,body.codice,body.municipio,body.sezione,body.rappresentante,body.telefono||'',elettori,votanti,
        sc.valide,sc.bianche,sc.nulle,sc.contestate,sm.valide,sm.bianche,sm.nulle,sm.contestate,body.note||'',body.correzioneDi||'',body.motivoCorrezione||'',body.versioneApp||'']);
      const shListe=getOrCreateSheet(FOGLI.VOTI_LISTE,['Timestamp','ID Invio','Municipio','Sezione','Livello','Lista','Voti']);
      (body.liste||[]).forEach(function(x){if(x&&x.nome)shListe.appendRow([new Date(),idInvio,body.municipio,body.sezione,x.livello||'',x.nome,numOrVuoto(x.voti)]);});
      const shPref=getOrCreateSheet(FOGLI.PREFERENZE,['Timestamp','ID Invio','Municipio','Sezione','Livello','Candidato','Preferenze']);
      (body.preferenze||[]).forEach(function(x){if(x&&x.candidato)shPref.appendRow([new Date(),idInvio,body.municipio,body.sezione,x.livello||'',x.candidato,numOrVuoto(x.voti)]);});
      const shSind=getOrCreateSheet(FOGLI.VOTI_SINDACI,['Timestamp','ID Invio','Municipio','Sezione','Candidato Sindaco','Voti']);
      (body.sindaci||[]).forEach(function(x){if(x&&x.nome)shSind.appendRow([new Date(),idInvio,body.municipio,body.sezione,x.nome,numOrVuoto(x.voti)]);});
      const shPres=getOrCreateSheet(FOGLI.VOTI_PRESIDENTI,['Timestamp','ID Invio','Municipio','Sezione','Candidato Presidente','Voti']);
      (body.presidenti||[]).forEach(function(x){if(x&&x.nome)shPres.appendRow([new Date(),idInvio,body.municipio,body.sezione,x.nome,numOrVuoto(x.voti)]);});
      return { ok:true, idInvio:idInvio, ricevutoIl:new Date().toISOString() };
    } finally { lock.releaseLock(); }
  } catch(err) { return { ok:false, code:'INVALID_DATA', error:String(err.message || err) }; }
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

// ===================== UTILITY ===============================================

function getOrCreateSheet(nome, intestazioni) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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

// ===================== INIZIALIZZAZIONE (eseguire una sola volta) ===========

function inizializza() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Foglio Municipi: tutti i 15, solo il IX attivo di default
  const shMun = getOrCreateSheet(FOGLI.MUNICIPI, ['Municipio', 'Nome', 'Attivo']);
  if (shMun.getLastRow() < 2) {
    Object.keys(NOMI_MUNICIPI).sort().forEach(function (m) {
      shMun.appendRow([m, NOMI_MUNICIPI[m], true]);
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

  // Fogli di raccolta dati: creati vuoti, pronti a riempirsi con gli invii
  getOrCreateSheet(FOGLI.AFFLUENZA, [
    'Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Rappresentante', 'Telefono',
    'Giorno', 'Orario', 'Elettori', 'Maschi', 'Femmine', 'Totale', '% Affluenza', 'Note',
  ]);
  getOrCreateSheet(FOGLI.SCRUTINIO, [
    'Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Rappresentante', 'Telefono',
    'Elettori', 'Votanti',
    'Comune - Valide', 'Comune - Bianche', 'Comune - Nulle', 'Comune - Contestate',
    'Municipio - Valide', 'Municipio - Bianche', 'Municipio - Nulle', 'Municipio - Contestate',
    'Note',
  ]);
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
  const shRapp = getOrCreateSheet(FOGLI.RAPPRESENTANTI, ['Codice', 'Nome e Cognome', 'Municipio', 'Sezione', 'Attivo']);
  if (shRapp.getLastRow() < 2) {
    shRapp.appendRow(['ESEMPIO2026', 'Mario Rossi', '09', '1667', true]);
  }

  getOrCreateSheet(FOGLI.VOTI_SINDACI, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Sindaco', 'Voti']);
  getOrCreateSheet(FOGLI.VOTI_PRESIDENTI, ['Timestamp', 'ID Invio', 'Municipio', 'Sezione', 'Candidato Presidente', 'Voti']);

  // Riordino i fogli: configurazione prima, dati raccolti dopo
  const ordine = [FOGLI.RAPPRESENTANTI, FOGLI.MUNICIPI, FOGLI.LISTE, FOGLI.CANDIDATI, FOGLI.SINDACI, FOGLI.PRESIDENTI, FOGLI.ORARI,
    FOGLI.SCRUTINIO, FOGLI.VOTI_LISTE, FOGLI.VOTI_SINDACI, FOGLI.VOTI_PRESIDENTI, FOGLI.PREFERENZE, FOGLI.AFFLUENZA, FOGLI.LOG];
  ordine.forEach(function (nome, idx) {
    const sh = ss.getSheetByName(nome);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(idx + 1); }
  });

  SpreadsheetApp.getActiveSpreadsheet().toast(
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
    .addItem('📊 Aggiorna Dashboard ora', 'aggiornaDashboard')
    .addItem('⏱️ Attiva aggiornamento automatico (5 min)', 'attivaAggiornamentoAutomatico')
    .addItem('⏹️ Disattiva aggiornamento automatico', 'disattivaAggiornamentoAutomatico')
    .addSeparator()
    .addItem('📧 Configura alert email', 'configurazionEmail')
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
  // Versione silenziosa chiamata dal trigger automatico (senza popup)
  try {
    aggiornaDashboardInterno();
    // Controlla alert email dopo ogni aggiornamento automatico
    controllaEInviaAlert();
  } catch(e) {
    logError('aggiornaDashboardSilente', e);
  }
}

// ===================== ALERT EMAIL =====================================

function configurazionEmail() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const shRapp = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!shRapp) return;
  const sezioniAttive = [];
  const rappRows = shRapp.getDataRange().getValues();
  for (let i = 1; i < rappRows.length; i++) {
    const [, , municipio, sezione, attivo] = rappRows[i];
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
    const headers = shScr.getRange(1, 1, 1, shScr.getLastColumn()).getValues()[0];
    const colMun = headers.indexOf('Municipio');
    const colSez = headers.indexOf('Sezione');
    const sRows = shScr.getRange(2, 1, shScr.getLastRow()-1, shScr.getLastColumn()).getValues();
    sRows.forEach(function(r) {
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

// ===================== STATISTICHE AGGREGATE ===========================

function mostraStatistiche() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  const shAff = ss.getSheetByName(FOGLI.AFFLUENZA);
  const shScr = ss.getSheetByName(FOGLI.SCRUTINIO);
  const shRapp = ss.getSheetByName(FOGLI.RAPPRESENTANTI);

  // Sezioni attive
  const sezioniAttive = new Set();
  if (shRapp && shRapp.getLastRow() > 1) {
    const rows = shRapp.getDataRange().getValues();
    for (let i = 1; i < rows.length; i++) {
      const [, , municipio, sezione, attivo] = rows[i];
      if (!sezione) continue;
      if (attivo === true || String(attivo).toUpperCase() === 'TRUE') {
        sezioniAttive.add(String(Math.round(Number(municipio))).padStart(2,'0') + '-' + String(sezione).trim());
      }
    }
  }

  // Affluenza per orario
  const affluenzaPerOrario = {};
  if (shAff && shAff.getLastRow() > 1) {
    const headers = shAff.getRange(1, 1, 1, shAff.getLastColumn()).getValues()[0];
    const colGio = headers.indexOf('Giorno');
    const colOra = headers.indexOf('Orario');
    const colTot = headers.indexOf('Totale');
    const colEl = headers.indexOf('Elettori');
    const rows = shAff.getRange(2, 1, shAff.getLastRow()-1, shAff.getLastColumn()).getValues();
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
    const headers = shScr.getRange(1, 1, 1, shScr.getLastColumn()).getValues()[0];
    const colMun = headers.indexOf('Municipio');
    const colSez = headers.indexOf('Sezione');
    const colEl = headers.indexOf('Elettori');
    const colVot = headers.indexOf('Votanti');
    const rows = shScr.getRange(2, 1, shScr.getLastRow()-1, shScr.getLastColumn()).getValues();
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // 1) Leggo le sezioni dal foglio Rappresentanti
  const shRapp = ss.getSheetByName(FOGLI.RAPPRESENTANTI);
  if (!shRapp) { ui.alert('Foglio "Rappresentanti" non trovato. Esegui prima "Inizializzazione".'); return; }

  const sezioniAssegnate = [];
  const rappRows = shRapp.getDataRange().getValues();
  for (let i = 1; i < rappRows.length; i++) {
    const [codice, nome, municipio, sezione, attivo] = rappRows[i];
    if (!sezione) continue;
    const isAttivo = attivo === true || String(attivo).toUpperCase() === 'TRUE' || String(attivo).toUpperCase() === 'VERO';
    const key = String(Math.round(Number(municipio))).padStart(2,'0') + '-' + String(sezione).trim();
    if (!sezioniAssegnate.find(s => s.key === key)) {
      sezioniAssegnate.push({
        key, codice: String(codice).trim(), nome: String(nome).trim(),
        municipio: String(Math.round(Number(municipio))).padStart(2,'0'),
        sezione: String(sezione).trim(), attivo: isAttivo,
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
    const aRows = shAff.getRange(2, 1, shAff.getLastRow()-1, shAff.getLastColumn()).getValues();
    const headers = shAff.getRange(1, 1, 1, shAff.getLastColumn()).getValues()[0];
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
    const sRows = shScr.getRange(2, 1, shScr.getLastRow()-1, shScr.getLastColumn()).getValues();
    const headers = shScr.getRange(1, 1, 1, shScr.getLastColumn()).getValues()[0];
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
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // Conta sezioni univoche per affluenza
  const shAff = ss.getSheetByName(FOGLI.AFFLUENZA);
  const sezioniAff = new Set();
  if (shAff && shAff.getLastRow() > 1) {
    const dati = shAff.getRange(2, 4, shAff.getLastRow() - 1, 1).getValues(); // colonna D = Sezione
    dati.forEach(function(r) { if (r[0]) sezioniAff.add(String(r[0])); });
  }

  // Conta sezioni univoche per scrutinio
  const shScr = ss.getSheetByName(FOGLI.SCRUTINIO);
  const sezioniScr = new Set();
  if (shScr && shScr.getLastRow() > 1) {
    const dati = shScr.getRange(2, 4, shScr.getLastRow() - 1, 1).getValues();
    dati.forEach(function(r) { if (r[0]) sezioniScr.add(String(r[0])); });
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

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const fogli_dati = [
    FOGLI.AFFLUENZA, FOGLI.SCRUTINIO, FOGLI.VOTI_LISTE,
    FOGLI.VOTI_SINDACI, FOGLI.VOTI_PRESIDENTI, FOGLI.PREFERENZE, FOGLI.LOG,
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
