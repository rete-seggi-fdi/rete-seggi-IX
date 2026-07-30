'use strict';
const CFG=window.SEGGI_CONFIG||{};
const BACKEND=String(CFG.backendUrl||'').trim();
const TOKEN_KEY='seggi_dashboard_token',EXP_KEY='seggi_dashboard_token_expiry';
let dashboardToken=localStorage.getItem(TOKEN_KEY)||sessionStorage.getItem(TOKEN_KEY)||'',live=null;
let registry={schemaVersion:0,sezioniTotali:0,plessiTotali:0,sezioni:[]};
let geoPlessi={schemaVersion:0,plessiTotali:0,plessiGeocodificati:0,plessi:[]};
let registryBySection=new Map();
let mapInstance=null,mapMarkers=[],leafletPromise=null,boundaryLayer=null,boundaryVisible=true;
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
async function loadRegistry(){const url='data/sezioni-ix-control.json?v=14.4.2';const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('Archivio sezioni non raggiungibile ('+r.status+').');registry=validateRegistry(await r.json())}
async function loadGeoPlessi(){const url='data/plessi-ix-geocodificati.json?v=14.4.2';const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('Archivio geografico non raggiungibile ('+r.status+').');const data=await r.json();if(!data||!Array.isArray(data.plessi))throw new Error('Archivio geografico non valido.');const validi=data.plessi.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Number(p.lat)!==0&&Number(p.lng)!==0);if(!validi.length)throw new Error('Nessun plesso geocodificato disponibile.');geoPlessi={...data,plessi:validi,plessiGeocodificati:validi.length}}

function rebuildRegistryIndex(){
  registryBySection=new Map();
  (registry.sezioni||[]).forEach(row=>{
    const sec=normSection(row.sezione);
    if(sec)registryBySection.set(sec,row);
  });
}
function mergeRegistryWithGeo(){
  const rows=new Map();
  (registry.sezioni||[]).forEach(row=>{
    const sec=normSection(row.sezione);
    if(sec)rows.set(sec,{...row,sezione:sec});
  });
  (geoPlessi.plessi||[]).forEach(plesso=>{
    (plesso.sezioni||[]).forEach(value=>{
      const sec=normSection(value);
      if(!sec)return;
      const precedente=rows.get(sec)||{};
      rows.set(sec,{
        ...precedente,
        sezione:sec,
        municipio:String(precedente.municipio||plesso.municipio||'09'),
        indirizzo:String(precedente.indirizzo||plesso.indirizzo||'').trim(),
        cap:String(precedente.cap||plesso.cap||'').trim(),
        comune:String(precedente.comune||plesso.comune||'Roma').trim(),
        plessoId:String(precedente.plessoId||plesso.id||'').trim(),
        numeroVie:Number(precedente.numeroVie||((precedente.vieAssegnate||[]).length)||0),
        vieAssegnate:Array.isArray(precedente.vieAssegnate)?precedente.vieAssegnate:[]
      });
    });
  });
  const complete=[...rows.values()].filter(x=>x.sezione&&x.indirizzo)
    .sort((a,b)=>Number(a.sezione)-Number(b.sezione));
  const plessi=new Set(complete.map(x=>String(x.indirizzo).trim()+'|'+String(x.cap||'').trim()));
  registry={...registry,sezioni:complete,sezioniTotali:complete.length,plessiTotali:plessi.size};
  rebuildRegistryIndex();
}
function registryForSection(section){
  return registryBySection.get(normSection(section))||null;
}
function ensureLeaflet(){if(window.L)return Promise.resolve(window.L);if(leafletPromise)return leafletPromise;leafletPromise=new Promise((resolve,reject)=>{if(!document.querySelector('link[data-seggi-leaflet]')){const link=document.createElement('link');link.rel='stylesheet';link.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';link.dataset.seggiLeaflet='1';document.head.appendChild(link)}const script=document.createElement('script');script.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';script.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';script.crossOrigin='';script.onload=()=>resolve(window.L);script.onerror=()=>reject(new Error('Impossibile caricare la libreria della mappa.'));document.head.appendChild(script)});return leafletPromise}
function prepareMapLayout(){
  const view=$('#view-map');
  if(!view)return null;
  const layout=view.querySelector('.map-layout');
  const staticPanel=view.querySelector('.map-panel');
  const aside=view.querySelector('.map-sections');
  const list=$('#mapSectionList');
  if(staticPanel)staticPanel.remove();
  if(layout){
    layout.style.display='block';
    layout.style.gridTemplateColumns='none';
    layout.style.width='100%';
  }
  if(aside){
    aside.style.width='100%';
    aside.style.maxWidth='none';
    aside.style.height='auto';
    aside.style.maxHeight='none';
    aside.style.overflow='visible';
    aside.style.padding='0';
    aside.style.background='transparent';
    aside.style.border='0';
    aside.style.boxShadow='none';
  }
  if(list){
    list.style.display='grid';
    list.style.gridTemplateColumns='repeat(auto-fit,minmax(240px,1fr))';
    list.style.gap='10px';
    list.style.maxHeight='330px';
    list.style.overflow='auto';
    list.style.padding='2px 4px 8px 2px';
  }
  const version=[...document.querySelectorAll('small,.brand-subtitle')].find(x=>/CONTROL CENTER/i.test(x.textContent||''));
  if(version)version.textContent='CONTROL CENTER 14.4.2';
  return {layout,aside,list};
}
function ensureMapContainer(){
  const parts=prepareMapLayout();
  if(!parts?.layout||!parts.list)return null;
  let el=$('#mapCanvas');
  if(el)return el;
  const info=document.createElement('p');
  info.id='mapGeoSummary';
  info.style.cssText='margin:0 0 12px;font-size:.92rem;opacity:.82';
  el=document.createElement('div');
  el.id='mapCanvas';
  el.setAttribute('aria-label','Mappa dinamica dei plessi elettorali con confine del Municipio IX');
  el.style.cssText='height:min(68vh,720px);min-height:560px;width:100%;border-radius:18px;overflow:hidden;margin:0 0 18px;background:#e9ecef;box-shadow:0 8px 28px rgba(0,0,0,.12)';
  parts.layout.insertBefore(info,parts.aside);
  parts.layout.insertBefore(el,parts.aside);
  return el;
}
function statusForPlesso(p){const sez=Array.isArray(p.sezioni)?p.sezioni.map(normSection).filter(Boolean):[];if(!sez.length)return'missing';const stati=sez.map(statusFor);if(stati.every(x=>x.cls==='done'))return'done';if(stati.some(x=>x.cls==='done'||x.cls==='partial'))return'partial';return'missing'}
function markerIcon(cls){const colors={done:'#16803c',partial:'#d97706',missing:'#b42318'};const c=colors[cls]||'#1d4ed8';return window.L.divIcon({className:'',html:`<span style="display:block;width:18px;height:18px;border-radius:50%;background:${c};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.38)"></span>`,iconSize:[18,18],iconAnchor:[9,9],popupAnchor:[0,-10]})}
function romanToNumber(value){const v=String(value||'').trim().toUpperCase().replace(/[^IVX0-9]/g,'');if(/^0?9$/.test(v))return 9;const m={I:1,V:5,X:10};let n=0,prev=0;for(const ch of [...v].reverse()){const x=m[ch]||0;n+=x<prev?-x:x;prev=Math.max(prev,x)}return n}
async function loadMunicipioBoundary(L){if(boundaryLayer)return boundaryLayer;const endpoint='https://services-eu1.arcgis.com/CQGl8ODCKnscqiME/ArcGIS/rest/services/Perimetrazioni_Comune_di_Roma/FeatureServer/0/query?where=1%3D1&outFields=MUNICIPIO%2CDENOMINAZI&returnGeometry=true&outSR=4326&f=geojson';const r=await fetch(endpoint,{cache:'force-cache'});if(!r.ok)throw new Error('Confine municipale non raggiungibile ('+r.status+').');const all=await r.json();const features=(all.features||[]).filter(f=>romanToNumber(f?.properties?.MUNICIPIO)===9||/municipio\s*ix/i.test(String(f?.properties?.DENOMINAZI||'')));if(!features.length)throw new Error('Confine del Municipio IX non trovato.');boundaryLayer=L.geoJSON({type:'FeatureCollection',features},{style:{color:'#0b3b75',weight:4,opacity:.95,fillColor:'#2f6fb0',fillOpacity:.08,dashArray:'9 6'},interactive:true}).bindPopup('<strong>Municipio Roma IX</strong><br>Confine amministrativo');boundaryLayer.addTo(mapInstance);boundaryVisible=true;return boundaryLayer}
function addBoundaryToggle(L){if($('#mapBoundaryToggle'))return;const Control=L.Control.extend({options:{position:'topright'},onAdd(){const box=L.DomUtil.create('div','leaflet-bar');const b=L.DomUtil.create('button','',box);b.id='mapBoundaryToggle';b.type='button';b.title='Mostra o nascondi il confine del Municipio IX';b.setAttribute('aria-label',b.title);b.style.cssText='width:auto;min-width:40px;height:34px;padding:0 10px;border:0;background:white;font-weight:700;cursor:pointer';const sync=()=>b.textContent=boundaryVisible?'Confine ✓':'Confine';sync();L.DomEvent.disableClickPropagation(box);L.DomEvent.on(b,'click',()=>{if(!boundaryLayer)return;if(boundaryVisible){mapInstance.removeLayer(boundaryLayer);boundaryVisible=false}else{boundaryLayer.addTo(mapInstance);boundaryVisible=true}sync()});return box}});mapInstance.addControl(new Control())}

async function renderGeoMap(){const el=ensureMapContainer();if(!el||!geoPlessi.plessi.length)return;const L=await ensureLeaflet();if(!mapInstance){mapInstance=L.map(el,{zoomControl:true,scrollWheelZoom:true}).setView([41.805,12.47],12);L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(mapInstance);addBoundaryToggle(L)}mapMarkers.forEach(m=>m.remove());mapMarkers=[];const bounds=[];geoPlessi.plessi.forEach(p=>{const cls=statusForPlesso(p);const sez=(p.sezioni||[]).map(normSection).filter(Boolean);const marker=L.marker([Number(p.lat),Number(p.lng)],{icon:markerIcon(cls),title:p.indirizzo}).addTo(mapInstance);marker.bindPopup(`<div style="min-width:230px"><strong>${esc(p.id)} · ${esc(p.indirizzo)}</strong><br><small>${esc(p.cap||'')} ${esc(p.comune||'Roma')}</small><p style="margin:.55rem 0 0"><b>Sezioni:</b> ${sez.map(esc).join(', ')||'—'}</p></div>`);marker._seggiSections=new Set(sez);mapMarkers.push(marker);bounds.push([Number(p.lat),Number(p.lng)])});let confineOk=false;try{await loadMunicipioBoundary(L);confineOk=true}catch(e){console.warn(e)}if(bounds.length)mapInstance.fitBounds(bounds,{padding:[42,42],maxZoom:13});const info=$('#mapGeoSummary');if(info)info.textContent=`${fmt(geoPlessi.plessiGeocodificati)} punti visibili · ${fmt(geoPlessi.plessiGeocodificati)}/${fmt(geoPlessi.plessiTotali||geoPlessi.plessi.length)} plessi geocodificati${confineOk?' · confine Municipio IX attivo':' · confine non disponibile'}`;setTimeout(()=>mapInstance.invalidateSize(),80)}
function focusSectionOnMap(section){const sec=normSection(section);const marker=mapMarkers.find(m=>m._seggiSections?.has(sec));if(marker&&mapInstance){mapInstance.setView(marker.getLatLng(),16,{animate:true});marker.openPopup()}}
async function load(){if(!dashboardToken)return showLogin();setOnline(false,'Aggiornamento…');try{const x=await post({tipo:'dashboard_affluenza',dashboardToken});if(!x.ok){if(String(x.code).includes('SESSION'))return showLogin(x.error);throw new Error(x.error||'Errore backend')}live=x;renderAll();$('#loginView').hidden=true;$('#appView').hidden=false;['refreshBtn','printBtn','logoutBtn'].forEach(id=>$('#'+id).hidden=false);setOnline(true,'Online');$('#backendVersion').textContent='Backend '+(x.versioneBackend||'-');$('#lastUpdate').textContent='Aggiornato '+new Date(x.serverTime).toLocaleString('it-IT')}catch(e){setOnline(false,'Errore');if(!live)showLogin(e.message);console.error(e)}}
function summary(level){return (live.riepilogoFdi||{})[level]||{}}
function geoSectionsTotal(){const set=new Set();(geoPlessi.plessi||[]).forEach(p=>(p.sezioni||[]).forEach(s=>{const n=normSection(s);if(n)set.add(n)}));return set.size}
function territorialExpected(){return Math.max(Number(registry.sezioniTotali||0),geoSectionsTotal())}
function monitoredExpected(){return Number(live.sezioniAttese||0)}
function renderAll(){const t=live.totali||{},presidi=monitoredExpected(),expected=territorialExpected(),received=Number(live.sezioniRicevute||0),progress=expected?Math.min(100,received/expected*100):0;$('#kpiExpected').textContent=fmt(presidi);$('#kpiTerritory').textContent=fmt(expected)+' sezioni territoriali/cartografiche';$('#kpiReceived').textContent=fmt(received);$('#kpiProgress').textContent=pct(progress)+' completato';$('#kpiTurnout').textContent=pct(t.percentuale);$('#kpiVoters').textContent=fmt(t.totale)+' votanti';const scrSections=new Set((live.scrutiniDettaglio||[]).map(x=>x.municipio+'|'+x.sezione));if(!scrSections.size)(live.risultatiListe||[]).forEach(x=>scrSections.add(x.municipio+'|'+x.sezione));$('#kpiScrutini').textContent=fmt(scrSections.size);const c=summary('Comune'),m=summary('Municipio');$('#kpiFdiComune').textContent=fmt(c.fdiVoti);$('#kpiFdiComunePct').textContent=pct(c.fdiSuValidi)+' sui validi';$('#kpiFdiMunicipio').textContent=fmt(m.fdiVoti);$('#kpiFdiMunicipioPct').textContent=pct(m.fdiSuValidi)+' sui validi';$('#progressBar').style.width=Math.min(100,progress)+'%';$('#progressLabel').textContent=pct(progress);$('#legendReceived').textContent=fmt(received);$('#legendMissing').textContent=fmt(live.sezioniMancanti);$('#missingBadge').textContent=fmt(live.sezioniMancanti);renderRecent();renderMissing();renderRankings($('#rankLevel').value,'#topList',5,false);renderRegistry();renderMapList()}
function renderRecent(){const rows=(live.ultimiInvii||[]).slice(0,7);$('#recentList').innerHTML=rows.map(r=>`<div class="recent-row"><i class="status-dot"></i><div><strong>Sezione ${esc(normSection(r.sezione)||r.sezione)}</strong><small>${esc(r.giorno)} ${esc(r.orario)}</small></div><span>${r.percentuale===''?'—':pct(r.percentuale)}</span></div>`).join('')||'<p class="empty-state">Nessun invio disponibile.</p>'}
function renderMissing(){const rows=live.mancanti||[];$('#missingList').innerHTML=rows.slice(0,40).map(r=>`<button class="chip" data-section="${esc(r.sezione)}">${esc(normSection(r.sezione)||r.sezione)}</button>`).join('')||'<span class="state done">Tutte le sezioni presidiate hanno inviato</span>';$$('#missingList [data-section]').forEach(b=>b.onclick=()=>openSection(b.dataset.section))}
function rankingRows(level){return (live.risultatiListe||[]).filter(x=>x.livello===level&&x.municipio==='09'&&Number(x.fdiVoti||0)>0).sort((a,b)=>Number(b.fdiSuValidi||0)-Number(a.fdiSuValidi||0))}
function renderRankings(level,target,count=10,reverse=false){let rows=rankingRows(level);if(reverse)rows=rows.slice().reverse();rows=rows.slice(0,count);$(target).innerHTML=rows.map((r,i)=>`<div class="ranking-row" data-section="${esc(r.sezione)}"><span class="ranking-index">${i+1}</span><div><strong>Sezione ${esc(normSection(r.sezione)||r.sezione)}</strong><small>${fmt(r.fdiVoti)} voti FdI</small></div><span class="ranking-value">${pct(r.fdiSuValidi)}</span></div>`).join('')||'<p class="empty-state">Nessun risultato FdI valorizzato per questo livello.</p>';$$(`${target} [data-section]`).forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function statusFor(section){const sec=normSection(section);const scr=(live.scrutiniDettaglio||[]).some(x=>normSection(x.sezione)===sec)||(live.risultatiListe||[]).some(x=>normSection(x.sezione)===sec);if(scr)return{label:'Scrutinio ricevuto',cls:'done'};const aff=(live.sezioni||[]).some(x=>normSection(x.sezione)===sec);return aff?{label:'Affluenza ricevuta',cls:'partial'}:{label:'Nessun dato',cls:'missing'}}
function filteredRegistry(q,status='all'){q=String(q||'').trim().toLowerCase();return registry.sezioni.filter(x=>{const matchesText=!q||String(x.sezione).includes(q)||String(x.indirizzo).toLowerCase().includes(q)||String(x.cap||'').includes(q);const st=statusFor(x.sezione);return matchesText&&(status==='all'||st.cls===status)})}
function renderRegistry(){const rows=filteredRegistry($('#sectionSearch')?.value,$('#sectionStatus')?.value||'all');$('#registrySummary').textContent=`${fmt(registry.sezioniTotali)} sezioni in ${fmt(registry.plessiTotali)} plessi elettorali`;$('#sectionsBody').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<tr data-section="${esc(r.sezione)}"><td><strong>${esc(r.sezione)}</strong></td><td>${esc(r.indirizzo)}</td><td>${esc(r.cap)}</td><td>${fmt(r.numeroVie)}</td><td><span class="state ${st.cls}">${st.label}</span></td></tr>`}).join('')||'<tr><td colspan="5" class="empty-cell">Nessuna sezione corrisponde al filtro.</td></tr>';$$('#sectionsBody tr[data-section]').forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function renderMapList(){const rows=filteredRegistry($('#mapSearch')?.value);$('#mapSectionList').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<div class="map-section-card" data-section="${esc(r.sezione)}"><strong>Sezione ${esc(r.sezione)}</strong><small>${esc(r.indirizzo)}</small><span class="state ${st.cls}">${st.label}</span></div>`}).join('')||'<p class="empty-state">Nessuna sezione corrisponde alla ricerca.</p>';$$('.map-section-card').forEach(x=>x.onclick=()=>{focusSectionOnMap(x.dataset.section);openSection(x.dataset.section)})}
function openSection(section){
  const sec=normSection(section);
  const reg=registryForSection(sec);
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
function generateReport(){
  const preview=$('#reportPreview');
  const button=$('#generateReportBtn');

  if(!preview){
    alert('Errore: contenitore anteprima non trovato.');
    return false;
  }

  if(button){
    button.disabled=true;
    button.textContent='Generazione…';
  }

  preview.innerHTML='<p class="empty-state">Generazione anteprima in corso…</p>';

  window.setTimeout(()=>{
    try{
      if(!live){
        throw new Error('Dati elettorali non ancora disponibili. Premi Aggiorna e riprova.');
      }

      const c=summary('Comune');
      const m=summary('Municipio');
      const top=rankingRows('Comune').slice(0,10);

      preview.innerHTML=`<div class="report-sheet"><div class="report-title"><p class="eyebrow">RETE SEGGI FDI - IX MUNICIPIO ROMA</p><h2>Dossier elettorale - Elezioni amministrative</h2><p>Generato il ${new Date().toLocaleString('it-IT',{hour12:false})}</p></div><div class="report-grid"><div class="report-stat"><span>Sezioni presidiate</span><strong>${fmt(live.sezioniAttese)}</strong></div><div class="report-stat"><span>Sezioni territoriali/cartografiche</span><strong>${fmt(territorialExpected())}</strong></div><div class="report-stat"><span>Sezioni ricevute</span><strong>${fmt(live.sezioniRicevute)}</strong></div><div class="report-stat"><span>Affluenza</span><strong>${pct(live.totali?.percentuale)}</strong></div><div class="report-stat"><span>Votanti</span><strong>${fmt(live.totali?.totale)}</strong></div><div class="report-stat"><span>FdI Comune</span><strong>${fmt(c.fdiVoti)}</strong><small>${pct(c.fdiSuValidi)}</small></div><div class="report-stat"><span>FdI Municipio</span><strong>${fmt(m.fdiVoti)}</strong><small>${pct(m.fdiSuValidi)}</small></div><div class="report-stat"><span>Plessi</span><strong>${fmt(registry.plessiTotali)}</strong></div><div class="report-stat"><span>Sezioni territoriali</span><strong>${fmt(registry.sezioniTotali)}</strong></div></div><div class="report-table"><h3>Top 10 sezioni FdI - Comune</h3>${top.length?`<table><thead><tr><th>Pos.</th><th>Sezione</th><th>Voti FdI</th><th>% validi</th><th>Indirizzo</th></tr></thead><tbody>${top.map((r,i)=>{const reg=registryForSection(r.sezione);return`<tr><td>${i+1}</td><td>${esc(normSection(r.sezione)||r.sezione)}</td><td>${fmt(r.fdiVoti)}</td><td>${pct(r.fdiSuValidi)}</td><td>${esc(reg?.indirizzo||'Indirizzo non disponibile')}</td></tr>`}).join('')}</tbody></table>`:'<p class="empty-state">Nessun risultato FdI valorizzato.</p>'}</div></div>`;

      preview.classList.remove('report-flash');
      void preview.offsetWidth;
      preview.classList.add('report-flash');
      preview.scrollIntoView({behavior:'smooth',block:'start'});
    }catch(error){
      console.error('Errore generazione anteprima:',error);
      preview.innerHTML='<p class="empty-state error">Errore generazione anteprima: '+esc(error?.message||error)+'</p>';
    }finally{
      if(button){
        button.disabled=false;
        button.textContent='Rigenera anteprima';
      }
    }
  },50);

  return false;
}
function switchView(name){$$('.view').forEach(x=>x.classList.toggle('active',x.id==='view-'+name));$$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===name));if(name==='rankings'){renderRankings($('#rankingLevel').value,'#bestRankings',15,false);renderRankings($('#rankingLevel').value,'#worstRankings',15,true)}if(name==='sections')renderRegistry();if(name==='map'){renderMapList();renderGeoMap().catch(e=>{console.error(e);const info=$('#mapGeoSummary');if(info)info.textContent=e.message})}if(name==='report'){const p=$('#reportPreview');if(p&&!p.querySelector('.report-sheet'))p.innerHTML='<p class="empty-state">Premi “Genera anteprima” per creare il report.</p>';}window.scrollTo({top:0,behavior:'smooth'})}
window.SeggioLinkGenerateReport=generateReport;

function bindControlCenterEvents(){
  const refreshBtn=$('#refreshBtn');
  const logoutBtn=$('#logoutBtn');
  const printBtn=$('#printBtn');
  const generateReportBtn=$('#generateReportBtn');
  const closeDialog=$('#closeDialog');
  const loginForm=$('#loginForm');

  if(loginForm){
    loginForm.addEventListener('submit',async e=>{
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
    });
  }

  if(refreshBtn)refreshBtn.addEventListener('click',load);
  if(logoutBtn)logoutBtn.addEventListener('click',()=>showLogin());
  if(printBtn)printBtn.addEventListener('click',()=>{
    switchView('report');
    generateReport();
    setTimeout(()=>window.print(),150);
  });

  if(!generateReportBtn)console.error('Pulsante #generateReportBtn non trovato.');

  if(closeDialog)closeDialog.addEventListener('click',()=>$('#sectionDialog').close());

  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  $$('[data-view-link]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.viewLink)));

  const rankLevel=$('#rankLevel');
  const rankingLevel=$('#rankingLevel');
  const sectionSearch=$('#sectionSearch');
  const sectionStatus=$('#sectionStatus');
  const mapSearch=$('#mapSearch');

  if(rankLevel)rankLevel.addEventListener('change',e=>renderRankings(e.target.value,'#topList',5,false));
  if(rankingLevel)rankingLevel.addEventListener('change',e=>{
    renderRankings(e.target.value,'#bestRankings',15,false);
    renderRankings(e.target.value,'#worstRankings',15,true);
  });
  if(sectionSearch)sectionSearch.addEventListener('input',renderRegistry);
  if(sectionStatus)sectionStatus.addEventListener('change',renderRegistry);
  if(mapSearch)mapSearch.addEventListener('input',renderMapList);

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&$('#sectionDialog')?.open)$('#sectionDialog').close();
  });
}

bindControlCenterEvents();
document.addEventListener('click',e=>{const b=e.target.closest?.('#generateReportBtn');if(b){e.preventDefault();generateReport();}},{capture:true});
(async()=>{try{$('#sectionSearch').value='';$('#mapSearch').value='';await Promise.all([loadRegistry(),loadGeoPlessi()]);mergeRegistryWithGeo()}catch(e){console.error(e);$('#registrySummary').textContent=e.message;$('#sectionsBody').innerHTML=`<tr><td colspan="5" class="empty-cell error">${esc(e.message)}</td></tr>`;$('#mapSectionList').innerHTML=`<p class="empty-state error">${esc(e.message)}</p>`}if(dashboardToken)await load();else showLogin()})();
