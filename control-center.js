'use strict';
const CFG=window.SEGGI_CONFIG||{};
const BACKEND=String(CFG.backendUrl||'').trim();
const TOKEN_KEY='seggi_dashboard_token',EXP_KEY='seggi_dashboard_token_expiry';
let dashboardToken=localStorage.getItem(TOKEN_KEY)||sessionStorage.getItem(TOKEN_KEY)||'',live=null;
let registry={schemaVersion:0,sezioniTotali:0,plessiTotali:0,sezioni:[]};
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const fmt=n=>Number(n||0).toLocaleString('it-IT');
const pct=n=>(n===''||n==null||!Number.isFinite(Number(n)))?'—':Number(n).toLocaleString('it-IT',{maximumFractionDigits:1})+'%';
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const normSection=v=>String(Number(String(v??'').replace(/\D/g,''))||'');
async function post(payload){
  if(!BACKEND){
    throw new Error('URL backend assente: config.js non caricato.');
  }

  const url=BACKEND+'?_='+Date.now();
  let response;

  try{
    response=await fetch(url,{
      method:'POST',
      headers:{'Content-Type':'text/plain;charset=UTF-8'},
      body:JSON.stringify(payload),
      cache:'no-store',
      redirect:'follow'
    });
  }catch(error){
    throw new Error('Connessione al backend non riuscita: '+error.message);
  }

  const testo=await response.text();

  if(!response.ok){
    console.error('Errore backend',{
      status:response.status,
      urlFinale:response.url,
      risposta:testo
    });
    throw new Error('Backend HTTP '+response.status+'. URL finale: '+response.url);
  }

  try{
    return JSON.parse(testo);
  }catch(error){
    console.error('Risposta backend non JSON:',testo);
    throw new Error('Il backend ha restituito una risposta non valida.');
  }
}
function setOnline(ok,text){$('#connectionDot').classList.toggle('online',ok);$('#connectionText').textContent=text}
function showLogin(message=''){clearSession();$('#loginView').hidden=false;$('#appView').hidden=true;$('#loginError').textContent=message;['refreshBtn','printBtn','logoutBtn'].forEach(id=>$('#'+id).hidden=true);setOnline(false,'Non collegato')}
function clearSession(){dashboardToken='';localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(EXP_KEY);sessionStorage.removeItem(TOKEN_KEY);sessionStorage.removeItem(EXP_KEY)}
async function login(password){const x=await post({tipo:'dashboard_login',password});if(!x.ok)throw new Error(x.error||'Accesso non riuscito');dashboardToken=x.dashboardToken;localStorage.setItem(TOKEN_KEY,dashboardToken);localStorage.setItem(EXP_KEY,x.expiresAt||'');sessionStorage.removeItem(TOKEN_KEY);sessionStorage.removeItem(EXP_KEY)}
function validateRegistry(data){if(!data||typeof data!=='object'||!Array.isArray(data.sezioni))throw new Error('Archivio sezioni non valido.');const rows=data.sezioni.filter(x=>x&&x.sezione&&x.indirizzo).map(x=>({...x,sezione:normSection(x.sezione),numeroVie:Number(x.numeroVie||((x.vieAssegnate||[]).length)),vieAssegnate:Array.isArray(x.vieAssegnate)?x.vieAssegnate:[]}));if(!rows.length)throw new Error('Archivio sezioni vuoto.');const plessi=new Set(rows.map(x=>String(x.indirizzo).trim()+'|'+String(x.cap||'').trim()));return {...data,sezioni:rows,sezioniTotali:rows.length,plessiTotali:Number(data.plessiTotali||plessi.size)}}
async function loadRegistry(){const url='data/sezioni-ix-control.json?v=14.2.0';const r=await fetch(url,{cache:'reload'});if(!r.ok)throw new Error('Archivio sezioni non raggiungibile ('+r.status+').');registry=validateRegistry(await r.json())}
async function load(){if(!dashboardToken)return showLogin();setOnline(false,'Aggiornamento…');try{const x=await post({tipo:'dashboard_affluenza',dashboardToken});if(!x.ok){if(String(x.code).includes('SESSION'))return showLogin(x.error);throw new Error(x.error||'Errore backend')}live=x;renderAll();$('#loginView').hidden=true;$('#appView').hidden=false;['refreshBtn','printBtn','logoutBtn'].forEach(id=>$('#'+id).hidden=false);setOnline(true,'Online');$('#backendVersion').textContent='Backend '+(x.versioneBackend||'-');$('#lastUpdate').textContent='Aggiornato '+new Date(x.serverTime).toLocaleString('it-IT')}catch(e){setOnline(false,'Errore');if(!live)showLogin(e.message);console.error(e)}}
function summary(level){return (live.riepilogoFdi||{})[level]||{}}
function monitoredExpected(){return Number(live.sezioniAttese||0)}
function renderAll(){const t=live.totali||{},expected=monitoredExpected(),received=Number(live.sezioniRicevute||0),progress=expected?received/expected*100:0;$('#kpiExpected').textContent=fmt(expected);$('#kpiTerritory').textContent=fmt(registry.sezioniTotali)+' sezioni territoriali';$('#kpiReceived').textContent=fmt(received);$('#kpiProgress').textContent=pct(progress)+' completato';$('#kpiTurnout').textContent=pct(t.percentuale);$('#kpiVoters').textContent=fmt(t.totale)+' votanti';const scrSections=new Set((live.scrutiniDettaglio||[]).map(x=>x.municipio+'|'+x.sezione));if(!scrSections.size)(live.risultatiListe||[]).forEach(x=>scrSections.add(x.municipio+'|'+x.sezione));$('#kpiScrutini').textContent=fmt(scrSections.size);const c=summary('Comune'),m=summary('Municipio');$('#kpiFdiComune').textContent=fmt(c.fdiVoti);$('#kpiFdiComunePct').textContent=pct(c.fdiSuValidi)+' sui validi';$('#kpiFdiMunicipio').textContent=fmt(m.fdiVoti);$('#kpiFdiMunicipioPct').textContent=pct(m.fdiSuValidi)+' sui validi';$('#progressBar').style.width=Math.min(100,progress)+'%';$('#progressLabel').textContent=pct(progress);$('#legendReceived').textContent=fmt(received);$('#legendMissing').textContent=fmt(live.sezioniMancanti);$('#missingBadge').textContent=fmt(live.sezioniMancanti);renderRecent();renderMissing();renderRankings($('#rankLevel').value,'#topList',5,false);renderRegistry();renderMapList()}
function renderRecent(){const rows=(live.ultimiInvii||[]).slice(0,7);$('#recentList').innerHTML=rows.map(r=>`<div class="recent-row"><i class="status-dot"></i><div><strong>Sezione ${esc(normSection(r.sezione)||r.sezione)}</strong><small>${esc(r.giorno)} ${esc(r.orario)}</small></div><span>${r.percentuale===''?'—':pct(r.percentuale)}</span></div>`).join('')||'<p class="empty-state">Nessun invio disponibile.</p>'}
function renderMissing(){const rows=live.mancanti||[];$('#missingList').innerHTML=rows.slice(0,40).map(r=>`<button class="chip" data-section="${esc(r.sezione)}">${esc(normSection(r.sezione)||r.sezione)}</button>`).join('')||'<span class="state done">Tutte le sezioni presidiate hanno inviato</span>';$$('#missingList [data-section]').forEach(b=>b.onclick=()=>openSection(b.dataset.section))}
function rankingRows(level){return (live.risultatiListe||[]).filter(x=>x.livello===level&&x.municipio==='09'&&Number(x.fdiVoti||0)>0).sort((a,b)=>Number(b.fdiSuValidi||0)-Number(a.fdiSuValidi||0))}
function renderRankings(level,target,count=10,reverse=false){let rows=rankingRows(level);if(reverse)rows=rows.slice().reverse();rows=rows.slice(0,count);$(target).innerHTML=rows.map((r,i)=>`<div class="ranking-row" data-section="${esc(r.sezione)}"><span class="ranking-index">${i+1}</span><div><strong>Sezione ${esc(normSection(r.sezione)||r.sezione)}</strong><small>${fmt(r.fdiVoti)} voti FdI</small></div><span class="ranking-value">${pct(r.fdiSuValidi)}</span></div>`).join('')||'<p class="empty-state">Nessun risultato FdI valorizzato per questo livello.</p>';$$(`${target} [data-section]`).forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function statusFor(section){const sec=normSection(section);const scr=(live.scrutiniDettaglio||[]).some(x=>normSection(x.sezione)===sec)||(live.risultatiListe||[]).some(x=>normSection(x.sezione)===sec);if(scr)return{label:'Scrutinio ricevuto',cls:'done'};const aff=(live.sezioni||[]).some(x=>normSection(x.sezione)===sec);return aff?{label:'Affluenza ricevuta',cls:'partial'}:{label:'Nessun dato',cls:'missing'}}
function filteredRegistry(q,status='all'){q=String(q||'').trim().toLowerCase();return registry.sezioni.filter(x=>{const matchesText=!q||String(x.sezione).includes(q)||String(x.indirizzo).toLowerCase().includes(q)||String(x.cap||'').includes(q);const st=statusFor(x.sezione);return matchesText&&(status==='all'||st.cls===status)})}
function renderRegistry(){const rows=filteredRegistry($('#sectionSearch')?.value,$('#sectionStatus')?.value||'all');$('#registrySummary').textContent=`${fmt(registry.sezioniTotali)} sezioni in ${fmt(registry.plessiTotali)} plessi elettorali`;$('#sectionsBody').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<tr data-section="${esc(r.sezione)}"><td><strong>${esc(r.sezione)}</strong></td><td>${esc(r.indirizzo)}</td><td>${esc(r.cap)}</td><td>${fmt(r.numeroVie)}</td><td><span class="state ${st.cls}">${st.label}</span></td></tr>`}).join('')||'<tr><td colspan="5" class="empty-cell">Nessuna sezione corrisponde al filtro.</td></tr>';$$('#sectionsBody tr[data-section]').forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function renderMapList(){const rows=filteredRegistry($('#mapSearch')?.value);$('#mapSectionList').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<div class="map-section-card" data-section="${esc(r.sezione)}"><strong>Sezione ${esc(r.sezione)}</strong><small>${esc(r.indirizzo)}</small><span class="state ${st.cls}">${st.label}</span></div>`}).join('')||'<p class="empty-state">Nessuna sezione corrisponde alla ricerca.</p>';$$('.map-section-card').forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function openSection(section){
  const sec=normSection(section);
  const reg=registry.sezioni.find(x=>normSection(x.sezione)===sec);
  const aff=(live.sezioni||[]).find(x=>normSection(x.sezione)===sec);

  const scrutini=(live.scrutiniDettaglio||[]).filter(x=>normSection(x.sezione)===sec);
  const scrutinio=scrutini.find(x=>String(x.stato||'').toUpperCase()==='ATTIVO')||scrutini[0]||null;

  const results=(live.risultatiListe||[]).filter(x=>normSection(x.sezione)===sec);
  const comune=results.find(x=>x.livello==='Comune');
  const municipio=results.find(x=>x.livello==='Municipio');

  const elettoriScrutinio=Number(
    scrutinio?.elettori ??
    scrutinio?.Elettori ??
    scrutinio?.numeroElettori ??
    0
  );

  const votantiScrutinio=Number(
    scrutinio?.votanti ??
    scrutinio?.Votanti ??
    scrutinio?.totaleVotanti ??
    0
  );

  const usaScrutinio=Boolean(scrutinio&&elettoriScrutinio>0);
  const votantiFinali=usaScrutinio?votantiScrutinio:Number(aff?.totale||comune?.votanti||0);
  const affluenzaFinale=usaScrutinio
    ?(votantiScrutinio/elettoriScrutinio*100)
    :aff?.percentuale;

  /*
   * Il backend può creare record riepilogativi con fdiVoti=0 anche quando
   * i voti di lista non sono stati acquisiti. Finché non esiste un valore
   * FdI positivo, il Control Center mostra il dato come non disponibile.
   * In futuro il backend dovrà fornire un flag esplicito (es. listePresenti).
   */
  const hasComune=Boolean(comune&&Number(comune.fdiVoti)>0);
  const hasMunicipio=Boolean(municipio&&Number(municipio.fdiVoti)>0);

  const fdiComuneVoti=hasComune?fmt(comune.fdiVoti):'—';
  const fdiComunePct=hasComune?pct(comune.fdiSuValidi):'Dato non disponibile';
  const fdiMunicipioVoti=hasMunicipio?fmt(municipio.fdiVoti):'—';
  const fdiMunicipioPct=hasMunicipio?pct(municipio.fdiSuValidi):'Dato non disponibile';

  $('#sectionDialogContent').innerHTML=`
    <p class="eyebrow">DETTAGLIO SEZIONE</p>
    <h2>Sezione ${esc(sec||section)}</h2>
    <p><strong>${esc(reg?.indirizzo||'Indirizzo non disponibile')}</strong><br>${esc(reg?.cap||'')}</p>

    <div class="report-grid">
      <div class="report-stat">
        <span>${usaScrutinio?'Affluenza finale':'Affluenza'}</span>
        <strong>${pct(affluenzaFinale)}</strong>
      </div>

      <div class="report-stat">
        <span>Votanti</span>
        <strong>${fmt(votantiFinali)}</strong>
        ${usaScrutinio?`<small>su ${fmt(elettoriScrutinio)} elettori</small>`:''}
      </div>

      <div class="report-stat">
        <span>FdI Comune</span>
        <strong>${fdiComuneVoti}</strong>
        <small>${fdiComunePct}</small>
      </div>

      <div class="report-stat">
        <span>FdI Municipio</span>
        <strong>${fdiMunicipioVoti}</strong>
        <small>${fdiMunicipioPct}</small>
      </div>
    </div>

    <h3>Vie assegnate (${fmt(reg?.numeroVie)})</h3>
    <p class="street-list">${(reg?.vieAssegnate||[]).slice(0,40).map(esc).join(' · ')||'—'}</p>
  `;

  $('#sectionDialog').showModal();
}
function generateReport(){const c=summary('Comune'),m=summary('Municipio'),top=rankingRows('Comune').slice(0,10);$('#reportPreview').innerHTML=`<div class="report-sheet"><div class="report-title"><p class="eyebrow">RETE SEGGI FDI - IX MUNICIPIO ROMA</p><h2>Dossier elettorale - Elezioni amministrative</h2><p>Generato il ${new Date().toLocaleString('it-IT')}</p></div><div class="report-grid"><div class="report-stat"><span>Sezioni presidiate</span><strong>${fmt(live.sezioniAttese)}</strong></div><div class="report-stat"><span>Sezioni ricevute</span><strong>${fmt(live.sezioniRicevute)}</strong></div><div class="report-stat"><span>Affluenza</span><strong>${pct(live.totali?.percentuale)}</strong></div><div class="report-stat"><span>Votanti</span><strong>${fmt(live.totali?.totale)}</strong></div><div class="report-stat"><span>FdI Comune</span><strong>${fmt(c.fdiVoti)}</strong><small>${pct(c.fdiSuValidi)}</small></div><div class="report-stat"><span>FdI Municipio</span><strong>${fmt(m.fdiVoti)}</strong><small>${pct(m.fdiSuValidi)}</small></div><div class="report-stat"><span>Plessi</span><strong>${fmt(registry.plessiTotali)}</strong></div><div class="report-stat"><span>Sezioni territoriali</span><strong>${fmt(registry.sezioniTotali)}</strong></div></div><div class="report-table"><h3>Top 10 sezioni FdI - Comune</h3>${top.length?`<table><thead><tr><th>Pos.</th><th>Sezione</th><th>Voti FdI</th><th>% validi</th><th>Indirizzo</th></tr></thead><tbody>${top.map((r,i)=>{const reg=registry.sezioni.find(x=>normSection(x.sezione)===normSection(r.sezione));return`<tr><td>${i+1}</td><td>${esc(normSection(r.sezione)||r.sezione)}</td><td>${fmt(r.fdiVoti)}</td><td>${pct(r.fdiSuValidi)}</td><td>${esc(reg?.indirizzo||'')}</td></tr>`}).join('')}</tbody></table>`:'<p class="empty-state">Nessun risultato FdI valorizzato.</p>'}</div></div>`}
function switchView(name){$$('.view').forEach(x=>x.classList.toggle('active',x.id==='view-'+name));$$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===name));if(name==='rankings'){renderRankings($('#rankingLevel').value,'#bestRankings',15,false);renderRankings($('#rankingLevel').value,'#worstRankings',15,true)}if(name==='sections')renderRegistry();if(name==='map')renderMapList();if(name==='report'&&live)generateReport();window.scrollTo({top:0,behavior:'smooth'})}
$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault();

  const form=e.currentTarget;
  const button=form.querySelector('button[type="submit"]');
  const passwordInput=$('#password');
  const originalLabel=button.textContent;

  $('#loginError').textContent='';
  button.disabled=true;
  button.textContent='Accesso in corso…';
  passwordInput.disabled=true;
  setOnline(false,'Accesso…');

  try{
    await login(passwordInput.value);
    passwordInput.value='';
    button.textContent='Caricamento dati…';
    await load();
  }catch(err){
    $('#loginError').textContent=err.message;
    setOnline(false,'Errore');
  }finally{
    button.disabled=false;
    button.textContent=originalLabel;
    passwordInput.disabled=false;
  }
});$('#refreshBtn').onclick=load;$('#logoutBtn').onclick=()=>showLogin();$('#printBtn').onclick=()=>{switchView('report');generateReport();setTimeout(()=>window.print(),100)};$('#generateReportBtn').onclick=generateReport;$('#closeDialog').onclick=()=>$('#sectionDialog').close();$$('.nav-item').forEach(b=>b.onclick=()=>switchView(b.dataset.view));$$('[data-view-link]').forEach(b=>b.onclick=()=>switchView(b.dataset.viewLink));$('#rankLevel').onchange=e=>renderRankings(e.target.value,'#topList',5,false);$('#rankingLevel').onchange=e=>{renderRankings(e.target.value,'#bestRankings',15,false);renderRankings(e.target.value,'#worstRankings',15,true)};$('#sectionSearch').oninput=renderRegistry;$('#sectionStatus').onchange=renderRegistry;$('#mapSearch').oninput=renderMapList;document.addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#sectionDialog').open)$('#sectionDialog').close()});
(async()=>{try{$('#sectionSearch').value='';$('#mapSearch').value='';await loadRegistry()}catch(e){console.error(e);$('#registrySummary').textContent=e.message;$('#sectionsBody').innerHTML=`<tr><td colspan="5" class="empty-cell error">${esc(e.message)}</td></tr>`;$('#mapSectionList').innerHTML=`<p class="empty-state error">${esc(e.message)}</p>`}if(dashboardToken)await load();else showLogin()})();
