'use strict';

const CFG = window.SEGGI_CONFIG || {};
const BACKEND = String(
  CFG.backendUrl ||
  'https://script.google.com/macros/s/AKfycbx9s5sLN-O6_BN5dZgU6oxjqkw5R9lV31BrC6S5T560dylxZdrBMWv2V9PXeoUkc1k5qw/exec'
);
const REQUEST_TIMEOUT_MS = Number(CFG.requestTimeoutMs || 20000);
const TOKEN_KEY = 'seggi_dashboard_token';
const TOKEN_EXPIRY_KEY = 'seggi_dashboard_token_expiry';

const $ = (selector) => document.querySelector(selector);
let data = null;
let timer = null;
let dashboardToken = sessionStorage.getItem(TOKEN_KEY) || '';
let tokenExpiry = sessionStorage.getItem(TOKEN_EXPIRY_KEY) || '';

const fmt = (n) => Number(n || 0).toLocaleString('it-IT');
const pct = (n) => n === '' || n == null
  ? '—'
  : Number(n).toLocaleString('it-IT', { maximumFractionDigits: 1 }) + '%';

function setStatus(text) {
  $('#status').textContent = text;
}

function clearSession() {
  dashboardToken = '';
  tokenExpiry = '';
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(TOKEN_EXPIRY_KEY);
}

function showLogin(message = '') {
  $('#loginCard').hidden = false;
  $('#app').hidden = true;
  $('#refreshBtn').hidden = true;
  $('#logoutBtn').hidden = true;
  $('#loginError').textContent = message;
  setStatus('Non collegato');
}

function showApp() {
  $('#loginCard').hidden = true;
  $('#app').hidden = false;
  $('#refreshBtn').hidden = false;
  $('#logoutBtn').hidden = false;
}

async function postBackend(payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(BACKEND, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify(payload),
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error('Backend non raggiungibile (' + response.status + ').');
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function login(password) {
  const result = await postBackend({
    tipo: 'dashboard_login',
    password
  });

  if (!result.ok) {
    throw new Error(result.error || 'Accesso non riuscito.');
  }

  dashboardToken = String(result.dashboardToken || '');
  tokenExpiry = String(result.expiresAt || '');
  if (!dashboardToken) throw new Error('Il backend non ha restituito il token.');

  sessionStorage.setItem(TOKEN_KEY, dashboardToken);
  sessionStorage.setItem(TOKEN_EXPIRY_KEY, tokenExpiry);
}

async function load() {
  if (!dashboardToken) {
    showLogin();
    return;
  }

  setStatus('Aggiornamento…');

  try {
    const result = await postBackend({
      tipo: 'dashboard_affluenza',
      dashboardToken
    });

    if (!result.ok) {
      if (result.code === 'DASHBOARD_SESSION_INVALID' ||
          result.code === 'DASHBOARD_SESSION_EXPIRED') {
        clearSession();
        showLogin(result.error || 'Sessione scaduta. Accedi nuovamente.');
        return;
      }
      throw new Error(result.error || 'Errore backend.');
    }

    data = result;
    render();
    showApp();
    setStatus('Online');
  } catch (error) {
    setStatus('Errore');
    if (!data) showLogin(error.message);
    console.error(error);
  }
}

function render() {
  const totals = data.totali || {};
  $('#kpiPerc').textContent = pct(totals.percentuale);
  $('#kpiTotale').textContent = fmt(totals.totale);
  $('#kpiMF').textContent = fmt(totals.maschi) + ' / ' + fmt(totals.femmine);
  $('#kpiSezioni').textContent =
    fmt(data.sezioniRicevute) + ' / ' + fmt(data.sezioniAttese);
  $('#updatedAt').textContent =
    'Aggiornato: ' + new Date(data.serverTime).toLocaleString('it-IT');

  const select = $('#filterMunicipio');
  const previousValue = select.value;
  const municipalities = [
    ...new Set((data.perMunicipio || []).map((item) => item.municipio))
  ];
  select.innerHTML =
    '<option value="">Tutti</option>' +
    municipalities.map((municipality) =>
      `<option value="${municipality}">Municipio ${municipality}</option>`
    ).join('');
  select.value = previousValue;

  $('#municipiBody').innerHTML = (data.perMunicipio || []).map((item) =>
    `<tr>
      <td>${item.municipioNome}</td>
      <td>${item.sezioniRicevute}/${item.sezioniAttese}</td>
      <td>${item.sezioniMancanti}</td>
      <td>${fmt(item.elettori)}</td>
      <td>${fmt(item.maschi)}</td>
      <td>${fmt(item.femmine)}</td>
      <td>${fmt(item.totale)}</td>
      <td>${pct(item.percentuale)}</td>
    </tr>`
  ).join('');

  renderFiltered();
}

function renderFiltered() {
  if (!data) return;

  const municipality = $('#filterMunicipio').value;
  const query = $('#filterSezione').value.trim();
  const rows = (data.sezioni || []).filter((item) =>
    (!municipality || item.municipio === municipality) &&
    (!query || String(item.sezione).includes(query))
  );

  $('#sectionCount').textContent = rows.length + ' sezioni';
  $('#sezioniBody').innerHTML = rows.map((item) =>
    `<tr>
      <td>${item.municipio}</td>
      <td><strong>${item.sezione}</strong></td>
      <td>${item.giorno || ''} ${item.orario || ''}</td>
      <td>${fmt(item.maschi)}</td>
      <td>${fmt(item.femmine)}</td>
      <td>${fmt(item.totale)}</td>
      <td>${pct(item.percentuale)}</td>
      <td>${item.timestamp ? new Date(item.timestamp).toLocaleString('it-IT') : ''}</td>
    </tr>`
  ).join('') || '<tr><td colspan="8">Nessun dato</td></tr>';

  const missing = (data.mancanti || []).filter((item) =>
    !municipality || item.municipio === municipality
  );
  $('#missingCount').textContent = missing.length + ' mancanti';
  $('#mancanti').innerHTML = missing.length
    ? missing.map((item) =>
        `<span class="missing">${item.municipio} · Sez. ${item.sezione}</span>`
      ).join('')
    : '<span class="ok-empty">Nessuna sezione mancante</span>';
}

function schedule() {
  clearInterval(timer);
  if ($('#autoRefresh').checked && dashboardToken) {
    timer = setInterval(load, 30000);
  }
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();

  const passwordInput = $('#dashboardPassword');
  const loginButton = $('#loginBtn');
  const password = passwordInput.value;

  $('#loginError').textContent = '';
  loginButton.disabled = true;
  loginButton.textContent = 'Accesso…';

  try {
    await login(password);
    passwordInput.value = '';
    await load();
    schedule();
  } catch (error) {
    clearSession();
    showLogin(error.message);
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Accedi';
  }
});

$('#refreshBtn').addEventListener('click', load);
$('#logoutBtn').addEventListener('click', () => {
  clearSession();
  clearInterval(timer);
  data = null;
  showLogin();
});
$('#filterMunicipio').addEventListener('change', renderFiltered);
$('#filterSezione').addEventListener('input', renderFiltered);
$('#autoRefresh').addEventListener('change', schedule);

if (dashboardToken) {
  if (tokenExpiry && Date.now() >= Date.parse(tokenExpiry)) {
    clearSession();
    showLogin('Sessione scaduta. Accedi nuovamente.');
  } else {
    load();
    schedule();
  }
} else {
  showLogin();
}
