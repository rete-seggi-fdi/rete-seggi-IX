'use strict';

const CFG = window.SEGGI_CONFIG || {};
const BACKEND = String(
  CFG.backendUrl ||
  'https://script.google.com/macros/s/AKfycby6OzgGBRZ4IXIHm5wGhIsz0pWV7O4Y_XDat0sSgwV6rqeAdoqj14AsId712iU9wFj6tA/exec'
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
const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');

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
  const result = await postBackend({ tipo: 'dashboard_login', password });
  if (!result.ok) throw new Error(result.error || 'Accesso non riuscito.');

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
      `<option value="${esc(municipality)}">Municipio ${esc(municipality)}</option>`
    ).join('');
  select.value = previousValue;

  $('#municipiBody').innerHTML = (data.perMunicipio || []).map((item) =>
    `<tr>
      <td>${esc(item.municipioNome)}</td>
      <td>${fmt(item.sezioniRicevute)}/${fmt(item.sezioniAttese)}</td>
      <td>${fmt(item.sezioniMancanti)}</td>
      <td>${fmt(item.elettori)}</td>
      <td>${fmt(item.maschi)}</td>
      <td>${fmt(item.femmine)}</td>
      <td>${fmt(item.totale)}</td>
      <td>${pct(item.percentuale)}</td>
    </tr>`
  ).join('');

  renderFiltered();
}

function renderFdiSummary(rows, level) {
  const summary = (data.riepilogoFdi || {})[level];
  if (!summary || !rows.length) {
    $('#fdiSummary').innerHTML =
      '<p class="empty-message">Nessun dato di scrutinio disponibile per questo filtro.</p>';
    return;
  }

  // Recalculate on active municipality/section filters.
  const aggregate = rows.reduce((acc, row) => {
    acc.sezioni++;
    acc.elettori += Number(row.elettori || 0);
    acc.votanti += Number(row.votanti || 0);
    acc.validi += Number(row.votiValidi || 0);
    acc.fdi += Number(row.fdiVoti || 0);
    if (row.posizioneFdi === 1) acc.prime++;
    return acc;
  }, { sezioni: 0, elettori: 0, votanti: 0, validi: 0, fdi: 0, prime: 0 });

  const percent = (part, whole) => whole > 0 ? part / whole * 100 : '';
  $('#fdiSummary').innerHTML = `
    <article><span>Voti FdI</span><strong>${fmt(aggregate.fdi)}</strong></article>
    <article><span>FdI sui validi</span><strong>${pct(percent(aggregate.fdi, aggregate.validi))}</strong></article>
    <article><span>FdI sui votanti</span><strong>${pct(percent(aggregate.fdi, aggregate.votanti))}</strong></article>
    <article><span>FdI sugli iscritti</span><strong>${pct(percent(aggregate.fdi, aggregate.elettori))}</strong></article>
    <article><span>FdI primo</span><strong>${fmt(aggregate.prime)}/${fmt(aggregate.sezioni)}</strong></article>
  `;
}

function renderResults() {
  if (!data) return;
  const municipality = $('#filterMunicipio').value;
  const sectionQuery = $('#filterSezione').value.trim();
  const level = $('#filterLivello').value;

  const rows = (data.risultatiListe || []).filter((item) =>
    item.livello === level &&
    (!municipality || item.municipio === municipality) &&
    (!sectionQuery || String(item.sezione).includes(sectionQuery))
  );

  renderFdiSummary(rows, level);

  $('#risultatiBody').innerHTML = rows.map((item, index) => {
    const positive = Number(item.distaccoPrimoAltro || 0) >= 0;
    const comparison = item.primoAltroPartito
      ? `${positive ? '+' : ''}${fmt(item.distaccoPrimoAltro)} su ${esc(item.primoAltroPartito)}`
      : '—';
    const rankClass = item.posizioneFdi === 1 ? 'rank-first' : 'rank-other';

    return `<tr class="result-row" tabindex="0" data-result-index="${index}">
      <td>${esc(item.municipio)}</td>
      <td><strong>${esc(item.sezione)}</strong></td>
      <td>${fmt(item.elettori)}</td>
      <td>${fmt(item.votanti)}</td>
      <td>${fmt(item.votiValidi)}</td>
      <td><strong>${fmt(item.fdiVoti)}</strong></td>
      <td>${fmt(item.altriVoti)}</td>
      <td><strong>${pct(item.fdiSuValidi)}</strong></td>
      <td>${pct(item.fdiSuVotanti)}</td>
      <td>${pct(item.fdiSuIscritti)}</td>
      <td><span class="rank ${rankClass}">${item.posizioneFdi ? item.posizioneFdi + '°' : '—'}</span></td>
      <td class="${positive ? 'positive' : 'negative'}">${comparison}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="12">Nessun risultato disponibile</td></tr>';

  const visibleRows = rows;
  document.querySelectorAll('#risultatiBody .result-row').forEach((row) => {
    const open = () => openResultDialog(visibleRows[Number(row.dataset.resultIndex)]);
    row.addEventListener('click', open);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
  });
}

function openResultDialog(result) {
  if (!result) return;

  $('#dialogTitle').textContent =
    `Municipio ${result.municipio} · Sezione ${result.sezione} · ${result.livello}`;

  $('#dialogMetrics').innerHTML = `
    <article><span>Iscritti</span><strong>${fmt(result.elettori)}</strong></article>
    <article><span>Votanti</span><strong>${fmt(result.votanti)}</strong></article>
    <article><span>Voti validi</span><strong>${fmt(result.votiValidi)}</strong></article>
    <article><span>FdI</span><strong>${fmt(result.fdiVoti)} · ${pct(result.fdiSuValidi)}</strong></article>
  `;

  $('#dialogParties').innerHTML = (result.liste || []).map((party) =>
    `<tr class="${party.isFdi ? 'fdi-row' : ''}">
      <td>${party.isFdi ? '<strong>' + esc(party.nome) + '</strong>' : esc(party.nome)}</td>
      <td>${fmt(party.voti)}</td>
      <td>${pct(party.percentuale)}</td>
    </tr>`
  ).join('');

  const dialog = $('#sectionDialog');
  if (typeof dialog.showModal === 'function') dialog.showModal();
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
      <td>${esc(item.municipio)}</td>
      <td><strong>${esc(item.sezione)}</strong></td>
      <td>${esc(item.giorno || '')} ${esc(item.orario || '')}</td>
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
        `<span class="missing">${esc(item.municipio)} · Sez. ${esc(item.sezione)}</span>`
      ).join('')
    : '<span class="ok-empty">Nessuna sezione mancante</span>';

  renderResults();
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
$('#filterLivello').addEventListener('change', renderResults);
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
