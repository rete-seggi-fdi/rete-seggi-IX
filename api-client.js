'use strict';

(function () {
  const DEFAULT_TIMEOUT_MS = 20000;
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
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
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
        if (e && e.code) throw e;
        if (e && e.name === 'AbortError') throw appError('Il coordinamento non ha risposto in tempo.', 'NETWORK_ERROR', e);
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
        const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
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
          lastError = e && e.code ? e : (e && e.name === 'AbortError'
            ? appError('Il coordinamento non ha risposto in tempo.', 'NETWORK_ERROR', e)
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
