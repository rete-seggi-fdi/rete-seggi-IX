'use strict';
const CFG=window.SEGGI_CONFIG||{};
const BACKEND=String(CFG.backendUrl||'').trim();
const TOKEN_KEY='seggi_dashboard_token',EXP_KEY='seggi_dashboard_token_expiry',LIVE_CACHE_KEY='seggi_control_center_live_1521';
let dashboardToken=localStorage.getItem(TOKEN_KEY)||sessionStorage.getItem(TOKEN_KEY)||'',live=null;
let registry={schemaVersion:0,sezioniTotali:0,plessiTotali:0,sezioni:[]};
let geoPlessi={schemaVersion:0,plessiTotali:0,plessiGeocodificati:0,plessi:[]};
let registryBySection=new Map();
let mapInstance=null,mapMarkers=[],leafletPromise=null,boundaryLayer=null,boundaryVisible=true,userLocationMarker=null,userAccuracyCircle=null,geoReady=false,geoLoadPromise=null;
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
async function loadRegistry(){const url='data/sezioni-ix-control.json?v=15.0.0';const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('Archivio sezioni non raggiungibile ('+r.status+').');registry=validateRegistry(await r.json())}
async function loadGeoPlessi(){const url='data/plessi-ix-geocodificati.json?v=15.0.0';const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw new Error('Archivio geografico non raggiungibile ('+r.status+').');const data=await r.json();if(!data||!Array.isArray(data.plessi))throw new Error('Archivio geografico non valido.');const validi=data.plessi.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Number(p.lat)!==0&&Number(p.lng)!==0);if(!validi.length)throw new Error('Nessun plesso geocodificato disponibile.');geoPlessi={...data,plessi:validi,plessiGeocodificati:validi.length}}

function rebuildRegistryIndex(){
  registryBySection=new Map();
  (registry.sezioni||[]).forEach(row=>{
    const sec=normSection(row.sezione);
    if(sec)registryBySection.set(sec,row);
  });
}
function mergeRegistryWithGeo(){
  // L’elenco corretto è composto da tutte le sezioni associate ai 38 plessi
  // del file geografico. Il registro completa vie e metadati, ma non elimina
  // nessuna sezione presente nei plessi.
  const rows=new Map();
  (registry.sezioni||[]).forEach(row=>{
    const sec=normSection(row.sezione);
    if(sec)rows.set(sec,{...row,sezione:sec});
  });
  const plessiCompleti=[];
  (geoPlessi.plessi||[]).forEach(plesso=>{
    const sezioni=[...new Set((plesso.sezioni||[]).map(normSection).filter(Boolean))];
    if(!sezioni.length)return;
    plessiCompleti.push({...plesso,sezioni});
    sezioni.forEach(sec=>{
      const precedente=rows.get(sec)||{};
      rows.set(sec,{
        ...precedente,
        sezione:sec,
        municipio:String(precedente.municipio||plesso.municipio||'09').padStart(2,'0'),
        indirizzo:String(plesso.indirizzo||precedente.indirizzo||'').trim(),
        cap:String(plesso.cap||precedente.cap||'').trim(),
        comune:String(plesso.comune||precedente.comune||'Roma').trim(),
        plessoId:String(plesso.id||precedente.plessoId||'').trim(),
        numeroVie:Number(precedente.numeroVie||((precedente.vieAssegnate||[]).length)||0),
        vieAssegnate:Array.isArray(precedente.vieAssegnate)?precedente.vieAssegnate:[]
      });
    });
  });
  const complete=[...rows.values()].filter(x=>x.sezione)
    .sort((a,b)=>Number(a.sezione)-Number(b.sezione));
  registry={...registry,sezioni:complete,sezioniTotali:complete.length,plessiTotali:plessiCompleti.length};
  geoPlessi={...geoPlessi,plessi:plessiCompleti,plessiGeocodificati:plessiCompleti.length,plessiTotali:plessiCompleti.length};
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
  if(staticPanel)staticPanel.hidden=true;
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
  if(version)version.textContent='CONTROL CENTER 15.2.1';
  return {layout,aside,list,staticPanel};
}
function ensureMapContainer(){
  const parts=prepareMapLayout();
  if(!parts?.layout||!parts.list)return null;
  let wrap=$('#mapInteractiveWrap');
  if(wrap)return $('#mapCanvas');

  wrap=document.createElement('section');
  wrap.id='mapInteractiveWrap';
  wrap.className='map-interactive-wrap';
  wrap.innerHTML=`
    <div class="map-toolbar" aria-label="Strumenti mappa">
      <div>
        <strong>Mappa operativa dei plessi</strong>
        <small id="mapGeoSummary">Caricamento cartografia…</small>
      </div>
      <div class="map-toolbar-actions">
        <button type="button" id="mapLocateBtn" class="btn secondary">⌖ La mia posizione</button>
        <button type="button" id="mapResetBtn" class="btn secondary">Inquadra plessi</button>
      </div>
    </div>
    <div class="map-legend" aria-label="Legenda stato plessi">
      <span><i class="legend-dot done"></i> Scrutinio ricevuto</span>
      <span><i class="legend-dot partial"></i> Solo affluenza</span>
      <span><i class="legend-dot missing"></i> Nessun dato</span>
      <span><i class="legend-dot user"></i> La mia posizione</span>
    </div>
    <div id="mapCanvas" role="application" aria-label="Mappa dinamica dei plessi elettorali del Municipio IX"></div>
    <p id="mapLocationStatus" class="map-location-status" aria-live="polite"></p>`;

  parts.layout.insertBefore(wrap,parts.aside);
  $('#mapLocateBtn')?.addEventListener('click',locateUserOnMap);
  $('#mapResetBtn')?.addEventListener('click',fitMapToPlessi);
  return $('#mapCanvas');
}
async function ensureGeoReady(){
  if(geoReady&&geoPlessi.plessi.length)return geoPlessi;
  if(geoLoadPromise)return geoLoadPromise;
  geoLoadPromise=(async()=>{
    await loadGeoPlessi();
    geoReady=true;
    return geoPlessi;
  })().finally(()=>{geoLoadPromise=null});
  return geoLoadPromise;
}
function mapPlessoBounds(){
  return (geoPlessi.plessi||[])
    .filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng)))
    .map(p=>[Number(p.lat),Number(p.lng)]);
}
function fitMapToPlessi(){
  if(!mapInstance||!window.L)return;
  const bounds=mapPlessoBounds();
  if(bounds.length)mapInstance.fitBounds(bounds,{padding:[42,42],maxZoom:13});
}
function distanceMeters(lat1,lng1,lat2,lng2){
  const R=6371000,toRad=x=>x*Math.PI/180;
  const dLat=toRad(lat2-lat1),dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function nearestPlesso(lat,lng){
  let best=null;
  (geoPlessi.plessi||[]).forEach(p=>{
    const d=distanceMeters(lat,lng,Number(p.lat),Number(p.lng));
    if(!best||d<best.distance)best={plesso:p,distance:d};
  });
  return best;
}
function fmtDistance(m){
  if(!Number.isFinite(m))return'—';
  return m<1000?Math.round(m)+' m':(m/1000).toLocaleString('it-IT',{maximumFractionDigits:1})+' km';
}
function locateUserOnMap(){
  const status=$('#mapLocationStatus');
  if(!navigator.geolocation){if(status)status.textContent='Geolocalizzazione non supportata da questo browser.';return;}
  const btn=$('#mapLocateBtn');
  if(btn){btn.disabled=true;btn.textContent='Localizzazione…';}
  if(status)status.textContent='Richiesta posizione in corso…';
  navigator.geolocation.getCurrentPosition(pos=>{
    const lat=pos.coords.latitude,lng=pos.coords.longitude,accuracy=Number(pos.coords.accuracy||0);
    const L=window.L;
    if(!mapInstance||!L)return;
    if(userLocationMarker)userLocationMarker.remove();
    if(userAccuracyCircle)userAccuracyCircle.remove();
    userLocationMarker=L.circleMarker([lat,lng],{radius:9,color:'#0b5fff',weight:3,fillColor:'#fff',fillOpacity:1}).addTo(mapInstance).bindPopup('<strong>La mia posizione</strong>');
    if(accuracy>0)userAccuracyCircle=L.circle([lat,lng],{radius:accuracy,color:'#0b5fff',weight:1,fillOpacity:.05}).addTo(mapInstance);
    mapInstance.setView([lat,lng],15,{animate:true});
    userLocationMarker.openPopup();
    const near=nearestPlesso(lat,lng);
    if(status&&near){
      const sez=(near.plesso.sezioni||[]).map(normSection).filter(Boolean).join(', ');
      status.innerHTML=`Plesso più vicino: <strong>${esc(near.plesso.indirizzo)}</strong> · ${fmtDistance(near.distance)} · sezioni ${esc(sez||'—')}`;
    }else if(status)status.textContent='Posizione rilevata.';
  },err=>{
    const msg=err.code===1?'Permesso posizione negato. Abilitalo nelle impostazioni del browser.':err.code===2?'Posizione non disponibile.':'Tempo scaduto durante la localizzazione.';
    if(status)status.textContent=msg;
  },{enableHighAccuracy:true,timeout:12000,maximumAge:60000});
  window.setTimeout(()=>{if(btn){btn.disabled=false;btn.textContent='⌖ La mia posizione';}},13000);
}
function statusForPlesso(p){const sez=Array.isArray(p.sezioni)?p.sezioni.map(normSection).filter(Boolean):[];if(!sez.length)return'missing';const stati=sez.map(statusFor);if(stati.every(x=>x.cls==='done'))return'done';if(stati.some(x=>x.cls==='done'||x.cls==='partial'))return'partial';return'missing'}
function markerIcon(cls){const colors={done:'#16803c',partial:'#d97706',missing:'#b42318'};const c=colors[cls]||'#1d4ed8';return window.L.divIcon({className:'',html:`<span style="display:block;width:18px;height:18px;border-radius:50%;background:${c};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,.38)"></span>`,iconSize:[18,18],iconAnchor:[9,9],popupAnchor:[0,-10]})}
function romanToNumber(value){const v=String(value||'').trim().toUpperCase().replace(/[^IVX0-9]/g,'');if(/^0?9$/.test(v))return 9;const m={I:1,V:5,X:10};let n=0,prev=0;for(const ch of [...v].reverse()){const x=m[ch]||0;n+=x<prev?-x:x;prev=Math.max(prev,x)}return n}
async function loadMunicipioBoundary(L){if(boundaryLayer)return boundaryLayer;const endpoint='https://services-eu1.arcgis.com/CQGl8ODCKnscqiME/ArcGIS/rest/services/Perimetrazioni_Comune_di_Roma/FeatureServer/0/query?where=1%3D1&outFields=MUNICIPIO%2CDENOMINAZI&returnGeometry=true&outSR=4326&f=geojson';const r=await fetch(endpoint,{cache:'force-cache'});if(!r.ok)throw new Error('Confine municipale non raggiungibile ('+r.status+').');const all=await r.json();const features=(all.features||[]).filter(f=>romanToNumber(f?.properties?.MUNICIPIO)===9||/municipio\s*ix/i.test(String(f?.properties?.DENOMINAZI||'')));if(!features.length)throw new Error('Confine del Municipio IX non trovato.');boundaryLayer=L.geoJSON({type:'FeatureCollection',features},{style:{color:'#0b3b75',weight:4,opacity:.95,fillColor:'#2f6fb0',fillOpacity:.08,dashArray:'9 6'},interactive:true}).bindPopup('<strong>Municipio Roma IX</strong><br>Confine amministrativo');boundaryLayer.addTo(mapInstance);boundaryVisible=true;return boundaryLayer}
function addBoundaryToggle(L){if($('#mapBoundaryToggle'))return;const Control=L.Control.extend({options:{position:'topright'},onAdd(){const box=L.DomUtil.create('div','leaflet-bar');const b=L.DomUtil.create('button','',box);b.id='mapBoundaryToggle';b.type='button';b.title='Mostra o nascondi il confine del Municipio IX';b.setAttribute('aria-label',b.title);b.style.cssText='width:auto;min-width:40px;height:34px;padding:0 10px;border:0;background:white;font-weight:700;cursor:pointer';const sync=()=>b.textContent=boundaryVisible?'Confine ✓':'Confine';sync();L.DomEvent.disableClickPropagation(box);L.DomEvent.on(b,'click',()=>{if(!boundaryLayer)return;if(boundaryVisible){mapInstance.removeLayer(boundaryLayer);boundaryVisible=false}else{boundaryLayer.addTo(mapInstance);boundaryVisible=true}sync()});return box}});mapInstance.addControl(new Control())}

async function renderGeoMap(){
  const el=ensureMapContainer();
  if(!el)return;
  await ensureGeoReady();
  const L=await ensureLeaflet();
  if(!mapInstance){
    mapInstance=L.map(el,{zoomControl:true,scrollWheelZoom:true,preferCanvas:true}).setView([41.805,12.47],12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      maxZoom:19,
      attribution:'&copy; OpenStreetMap contributors'
    }).addTo(mapInstance);
    addBoundaryToggle(L);
  }
  mapMarkers.forEach(m=>m.remove());
  mapMarkers=[];
  const bounds=[];
  geoPlessi.plessi.forEach(p=>{
    const cls=statusForPlesso(p);
    const sez=(p.sezioni||[]).map(normSection).filter(Boolean);
    const marker=L.marker([Number(p.lat),Number(p.lng)],{icon:markerIcon(cls),title:p.indirizzo}).addTo(mapInstance);
    const navUrl='https://www.google.com/maps/dir/?api=1&destination='+encodeURIComponent(Number(p.lat)+','+Number(p.lng));
    marker.bindPopup(`<div class="map-popup"><strong>${esc(p.id)} · ${esc(p.indirizzo)}</strong><br><small>${esc(p.cap||'')} ${esc(p.comune||'Roma')}</small><p><b>Sezioni:</b> ${sez.map(esc).join(', ')||'—'}</p><a href="${navUrl}" target="_blank" rel="noopener">Apri indicazioni</a></div>`);
    marker._seggiSections=new Set(sez);
    marker._seggiPlesso=p;
    mapMarkers.push(marker);
    bounds.push([Number(p.lat),Number(p.lng)]);
  });
  let confineOk=false;
  try{await loadMunicipioBoundary(L);confineOk=true}catch(e){console.warn(e)}
  if(bounds.length)mapInstance.fitBounds(bounds,{padding:[42,42],maxZoom:13});
  const info=$('#mapGeoSummary');
  if(info)info.textContent=`${fmt(geoPlessi.plessiGeocodificati)} plessi geocodificati · ${fmt(geoSectionsTotal())} sezioni associate${confineOk?' · confine Municipio IX attivo':' · confine non disponibile'}`;
  setTimeout(()=>mapInstance.invalidateSize(),80);
}
async function focusSectionOnMap(section){const sec=normSection(section);if(!mapInstance||!mapMarkers.length){try{await renderGeoMap()}catch(e){console.error(e)}}const marker=mapMarkers.find(m=>m._seggiSections?.has(sec));if(marker&&mapInstance){mapInstance.setView(marker.getLatLng(),16,{animate:true});marker.openPopup();return true}openSection(sec);return false}
function restoreLiveCache(){
  if(live)return false;
  try{
    const cached=JSON.parse(localStorage.getItem(LIVE_CACHE_KEY)||'null');
    if(!cached?.data)return false;
    live=cached.data;
    renderAll();
    $('#loginView').hidden=true;
    $('#appView').hidden=false;
    ['refreshBtn','printBtn','logoutBtn'].forEach(id=>$('#'+id).hidden=false);
    $('#lastUpdate').textContent='Dati memorizzati · aggiornamento in corso…';
    return true;
  }catch(e){return false}
}
async function load(){
  if(!dashboardToken)return showLogin();
  const restored=restoreLiveCache();
  setOnline(false,restored?'Aggiornamento…':'Caricamento…');
  const refreshBtn=$('#refreshBtn');
  if(refreshBtn)refreshBtn.disabled=true;
  try{
    const x=await post({tipo:'dashboard_affluenza',dashboardToken});
    if(!x.ok){if(String(x.code).includes('SESSION'))return showLogin(x.error);throw new Error(x.error||'Errore backend')}
    live=x;
    try{localStorage.setItem(LIVE_CACHE_KEY,JSON.stringify({savedAt:Date.now(),data:x}))}catch(e){}
    renderAll();
    $('#loginView').hidden=true;$('#appView').hidden=false;
    ['refreshBtn','printBtn','logoutBtn'].forEach(id=>$('#'+id).hidden=false);
    setOnline(true,'Online');
    $('#backendVersion').textContent='Backend '+(x.versioneBackend||'-');
    $('#lastUpdate').textContent='Aggiornato '+new Date(x.serverTime).toLocaleString('it-IT');
  }catch(e){
    setOnline(false,live?'Dati memorizzati':'Errore');
    if(!live)showLogin(e.message);
    console.error(e)
  }finally{if(refreshBtn)refreshBtn.disabled=false}
}
function summary(level){return (live.riepilogoFdi||{})[level]||{}}
function geoSectionsTotal(){const set=new Set();(geoPlessi.plessi||[]).forEach(p=>(p.sezioni||[]).forEach(s=>{const n=normSection(s);if(n)set.add(n)}));return set.size}
function territorialExpected(){return Number(registry.sezioniTotali||0)}
function territorialReceived(){const valid=new Set((registry.sezioni||[]).map(x=>normSection(x.sezione)));const seen=new Set();(live?.sezioni||[]).forEach(x=>{const sec=normSection(x.sezione);if(valid.has(sec))seen.add(sec)});(live?.scrutiniDettaglio||[]).forEach(x=>{const sec=normSection(x.sezione);if(valid.has(sec))seen.add(sec)});return seen.size}
function monitoredExpected(){return Number(live.sezioniAttese||0)}
function renderAll(){
  const t=live.totali||{},presidi=monitoredExpected(),expected=territorialExpected(),received=territorialReceived(),missing=Math.max(0,expected-received),progress=expected?Math.min(100,received/expected*100):0;
  $('#kpiExpected').textContent=fmt(presidi);
  $('#kpiTerritory').textContent=fmt(expected)+' sezioni territoriali';
  $('#kpiReceived').textContent=fmt(received);
  $('#kpiProgress').textContent=pct(progress)+' completato';
  $('#kpiTurnout').textContent=pct(t.percentuale);$('#kpiVoters').textContent=fmt(t.totale)+' votanti';
  const scrSections=new Set((live.scrutiniDettaglio||[]).filter(x=>registryBySection.has(normSection(x.sezione))).map(x=>normSection(x.sezione)));
  if(!scrSections.size)(live.risultatiListe||[]).filter(x=>registryBySection.has(normSection(x.sezione))).forEach(x=>scrSections.add(normSection(x.sezione)));
  $('#kpiScrutini').textContent=fmt(scrSections.size);
  const c=summary('Comune'),m=summary('Municipio');
  $('#kpiFdiComune').textContent=fmt(c.fdiVoti);$('#kpiFdiComunePct').textContent=pct(c.fdiSuValidi)+' sui validi';
  $('#kpiFdiMunicipio').textContent=fmt(m.fdiVoti);$('#kpiFdiMunicipioPct').textContent=pct(m.fdiSuValidi)+' sui validi';
  $('#progressBar').style.width=progress+'%';$('#progressLabel').textContent=pct(progress);
  $('#legendReceived').textContent=fmt(received);$('#legendMissing').textContent=fmt(missing);$('#missingBadge').textContent=fmt(missing);
  renderRecent();renderMissingTerritorial();renderRankings($('#rankLevel').value,'#topList',5,false);renderRegistry();renderMapList();
}
function renderMissingTerritorial(){
  const received=new Set();(live.sezioni||[]).forEach(x=>received.add(normSection(x.sezione)));(live.scrutiniDettaglio||[]).forEach(x=>received.add(normSection(x.sezione)));
  const rows=(registry.sezioni||[]).filter(x=>!received.has(normSection(x.sezione)));
  $('#missingList').innerHTML=rows.slice(0,40).map(r=>`<button class="chip" data-section="${esc(r.sezione)}">${esc(r.sezione)}</button>`).join('')||'<span class="state done">Tutte le sezioni territoriali hanno inviato</span>';
  $$('#missingList [data-section]').forEach(b=>b.onclick=()=>openSection(b.dataset.section));
}
function renderRecent(){const rows=(live.ultimiInvii||[]).slice(0,7);$('#recentList').innerHTML=rows.map(r=>`<div class="recent-row"><i class="status-dot"></i><div><strong>Sezione ${esc(normSection(r.sezione)||r.sezione)}</strong><small>${esc(r.giorno)} ${esc(r.orario)}</small></div><span>${r.percentuale===''?'—':pct(r.percentuale)}</span></div>`).join('')||'<p class="empty-state">Nessun invio disponibile.</p>'}
function renderMissing(){const rows=live.mancanti||[];$('#missingList').innerHTML=rows.slice(0,40).map(r=>`<button class="chip" data-section="${esc(r.sezione)}">${esc(normSection(r.sezione)||r.sezione)}</button>`).join('')||'<span class="state done">Tutte le sezioni presidiate hanno inviato</span>';$$('#missingList [data-section]').forEach(b=>b.onclick=()=>openSection(b.dataset.section))}
function rankingRows(level){return (live.risultatiListe||[]).filter(x=>x.livello===level&&x.municipio==='09'&&Number(x.fdiVoti||0)>0).sort((a,b)=>Number(b.fdiSuValidi||0)-Number(a.fdiSuValidi||0))}
function renderRankings(level,target,count=10,reverse=false){let rows=rankingRows(level);if(reverse)rows=rows.slice().reverse();rows=rows.slice(0,count);$(target).innerHTML=rows.map((r,i)=>`<div class="ranking-row" data-section="${esc(r.sezione)}"><span class="ranking-index">${i+1}</span><div><strong>Sezione ${esc(normSection(r.sezione)||r.sezione)}</strong><small>${fmt(r.fdiVoti)} voti FdI</small></div><span class="ranking-value">${pct(r.fdiSuValidi)}</span></div>`).join('')||'<p class="empty-state">Nessun risultato FdI valorizzato per questo livello.</p>';$$(`${target} [data-section]`).forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function statusFor(section){const sec=normSection(section);const scr=(live.scrutiniDettaglio||[]).some(x=>normSection(x.sezione)===sec)||(live.risultatiListe||[]).some(x=>normSection(x.sezione)===sec);if(scr)return{label:'Scrutinio ricevuto',cls:'done'};const aff=(live.sezioni||[]).some(x=>normSection(x.sezione)===sec);return aff?{label:'Affluenza ricevuta',cls:'partial'}:{label:'Nessun dato',cls:'missing'}}
function filteredRegistry(q,status='all'){q=String(q||'').trim().toLowerCase();return registry.sezioni.filter(x=>{const matchesText=!q||String(x.sezione).includes(q)||String(x.indirizzo).toLowerCase().includes(q)||String(x.cap||'').includes(q);const st=statusFor(x.sezione);return matchesText&&(status==='all'||st.cls===status)})}
function renderRegistry(){const rows=filteredRegistry($('#sectionSearch')?.value,$('#sectionStatus')?.value||'all');$('#registrySummary').textContent=`${fmt(registry.sezioniTotali)} sezioni in ${fmt(registry.plessiTotali)} plessi elettorali`;$('#sectionsBody').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<tr data-section="${esc(r.sezione)}"><td><strong>${esc(r.sezione)}</strong></td><td>${esc(r.indirizzo)}</td><td>${esc(r.cap)}</td><td>${fmt(r.numeroVie)}</td><td><span class="state ${st.cls}">${st.label}</span></td></tr>`}).join('')||'<tr><td colspan="5" class="empty-cell">Nessuna sezione corrisponde al filtro.</td></tr>';$$('#sectionsBody tr[data-section]').forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function renderMapList(){const q=$('#mapSearch')?.value||'';const rows=filteredRegistry(q);$('#mapSectionList').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<button type="button" class="map-section-card" data-section="${esc(r.sezione)}"><strong>Sezione ${esc(r.sezione)}</strong><small>${esc(r.indirizzo)}${r.cap?' · '+esc(r.cap):''}</small><span class="state ${st.cls}">${st.label}</span></button>`}).join('')||'<p class="empty-state">Nessuna sezione corrisponde alla ricerca.</p>';$$('.map-section-card').forEach(x=>x.onclick=()=>focusSectionOnMap(x.dataset.section));const exact=rows.length===1&&normSection(q)===normSection(rows[0].sezione);if(exact)setTimeout(()=>focusSectionOnMap(rows[0].sezione),50)}
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

      preview.innerHTML=`<div class="report-sheet"><div class="report-title"><p class="eyebrow">RETE SEGGI FDI - IX MUNICIPIO ROMA</p><h2>Dossier elettorale - Elezioni amministrative</h2><p>Generato il ${new Date().toLocaleString('it-IT',{hour12:false})}</p></div><div class="report-grid"><div class="report-stat"><span>Sezioni presidiate</span><strong>${fmt(live.sezioniAttese)}</strong></div><div class="report-stat"><span>Sezioni territoriali/cartografiche</span><strong>${fmt(territorialExpected())}</strong></div><div class="report-stat"><span>Sezioni ricevute</span><strong>${fmt(territorialReceived())}</strong></div><div class="report-stat"><span>Affluenza</span><strong>${pct(live.totali?.percentuale)}</strong></div><div class="report-stat"><span>Votanti</span><strong>${fmt(live.totali?.totale)}</strong></div><div class="report-stat"><span>FdI Comune</span><strong>${fmt(c.fdiVoti)}</strong><small>${pct(c.fdiSuValidi)}</small></div><div class="report-stat"><span>FdI Municipio</span><strong>${fmt(m.fdiVoti)}</strong><small>${pct(m.fdiSuValidi)}</small></div><div class="report-stat"><span>Plessi</span><strong>${fmt(registry.plessiTotali)}</strong></div><div class="report-stat"><span>Sezioni territoriali</span><strong>${fmt(registry.sezioniTotali)}</strong></div></div><div class="report-table"><h3>Top 10 sezioni FdI - Comune</h3>${top.length?`<table><thead><tr><th>Pos.</th><th>Sezione</th><th>Voti FdI</th><th>% validi</th><th>Indirizzo</th></tr></thead><tbody>${top.map((r,i)=>{const reg=registryForSection(r.sezione);return`<tr><td>${i+1}</td><td>${esc(normSection(r.sezione)||r.sezione)}</td><td>${fmt(r.fdiVoti)}</td><td>${pct(r.fdiSuValidi)}</td><td>${esc(reg?.indirizzo||'Indirizzo non disponibile')}</td></tr>`}).join('')}</tbody></table>`:'<p class="empty-state">Nessun risultato FdI valorizzato.</p>'}</div></div>`;

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

function detailedScrutinioRows(){
  const bySection=new Map();
  (live?.scrutiniDettaglio||[]).forEach(r=>{
    const municipio=String(r?.municipio||'').replace(/\D/g,'').padStart(2,'0');
    const sezione=normSection(r?.sezione);
    if(municipio!=='09'||!sezione)return;
    const row={
      sezione,
      iscritti:Number(r.elettori||0),
      votanti:Number(r.votanti||0),
      valideComune:Number(r.valideComune||0),
      biancheComune:Number(r.biancheComune||0),
      nulleComune:Number(r.nulleComune||0),
      contestateComune:Number(r.contestateComune||0),
      valideMunicipio:Number(r.valideMunicipio||0),
      biancheMunicipio:Number(r.biancheMunicipio||0),
      nulleMunicipio:Number(r.nulleMunicipio||0),
      contestateMunicipio:Number(r.contestateMunicipio||0)
    };
    bySection.set(sezione,row);
  });
  return [...bySection.values()].sort((a,b)=>Number(a.sezione)-Number(b.sezione));
}
function detailedReportTotals(rows){
  return rows.reduce((t,r)=>{
    Object.keys(t).forEach(k=>t[k]+=Number(r[k]||0));
    return t;
  },{iscritti:0,votanti:0,valideComune:0,biancheComune:0,nulleComune:0,contestateComune:0,valideMunicipio:0,biancheMunicipio:0,nulleMunicipio:0,contestateMunicipio:0});
}
function generateDetailedReport(){
  const preview=$('#reportPreview');
  const button=$('#generateDetailedReportBtn');
  if(!preview)return false;
  if(button){button.disabled=true;button.textContent='Generazione…';}
  try{
    if(!live)throw new Error('Dati elettorali non ancora disponibili. Premi Aggiorna e riprova.');
    const rows=detailedScrutinioRows();
    if(!rows.length)throw new Error('Nessuno scrutinio disponibile per il report sezioni.');
    const t=detailedReportTotals(rows);
    const aff=t.iscritti?Math.round(t.votanti/t.iscritti*1000)/10:'';
    preview.innerHTML=`<div class="report-sheet detailed-report-sheet"><div class="report-title"><p class="eyebrow">RETE SEGGI FDI - IX MUNICIPIO ROMA</p><h2>Report amministrative - dettaglio per sezione</h2><p>Generato il ${new Date().toLocaleString('it-IT',{hour12:false})} · ${fmt(rows.length)} sezioni</p></div><div class="report-grid detailed-summary"><div class="report-stat"><span>Sezioni nel report</span><strong>${fmt(rows.length)}</strong></div><div class="report-stat"><span>Iscritti</span><strong>${fmt(t.iscritti)}</strong></div><div class="report-stat"><span>Votanti</span><strong>${fmt(t.votanti)}</strong></div><div class="report-stat"><span>Affluenza</span><strong>${pct(aff)}</strong></div></div><div class="report-table detailed-report-table"><table><thead><tr><th>Sezione</th><th>Iscritti</th><th>Votanti</th><th>Valide Comune</th><th>Bianche Comune</th><th>Nulle Comune</th><th>Contestate Comune</th><th>Valide Municipio</th><th>Bianche Municipio</th><th>Nulle Municipio</th><th>Contestate Municipio</th></tr></thead><tbody>${rows.map(r=>`<tr><td><strong>${esc(r.sezione)}</strong></td><td>${fmt(r.iscritti)}</td><td>${fmt(r.votanti)}</td><td>${fmt(r.valideComune)}</td><td>${fmt(r.biancheComune)}</td><td>${fmt(r.nulleComune)}</td><td>${fmt(r.contestateComune)}</td><td>${fmt(r.valideMunicipio)}</td><td>${fmt(r.biancheMunicipio)}</td><td>${fmt(r.nulleMunicipio)}</td><td>${fmt(r.contestateMunicipio)}</td></tr>`).join('')}</tbody><tfoot><tr><th>TOTALE</th><th>${fmt(t.iscritti)}</th><th>${fmt(t.votanti)}</th><th>${fmt(t.valideComune)}</th><th>${fmt(t.biancheComune)}</th><th>${fmt(t.nulleComune)}</th><th>${fmt(t.contestateComune)}</th><th>${fmt(t.valideMunicipio)}</th><th>${fmt(t.biancheMunicipio)}</th><th>${fmt(t.nulleMunicipio)}</th><th>${fmt(t.contestateMunicipio)}</th></tr></tfoot></table></div></div>`;
    preview.classList.remove('report-flash');void preview.offsetWidth;preview.classList.add('report-flash');preview.scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){
    console.error('Errore report sezioni:',error);
    preview.innerHTML='<p class="empty-state error">Errore report sezioni: '+esc(error?.message||error)+'</p>';
  }finally{
    if(button){button.disabled=false;button.textContent='Report sezioni';}
  }
  return false;
}
function csvCell(value){return '"'+String(value??'').replace(/"/g,'""')+'"';}
function downloadDetailedCsv(){
  try{
    if(!live)throw new Error('Dati elettorali non ancora disponibili.');
    const rows=detailedScrutinioRows();
    if(!rows.length)throw new Error('Nessuno scrutinio disponibile da esportare.');
    const headers=['Sezione','Iscritti','Votanti','Valide Comune','Bianche Comune','Nulle Comune','Contestate Comune','Valide Municipio','Bianche Municipio','Nulle Municipio','Contestate Municipio'];
    const body=[headers,...rows.map(r=>[r.sezione,r.iscritti,r.votanti,r.valideComune,r.biancheComune,r.nulleComune,r.contestateComune,r.valideMunicipio,r.biancheMunicipio,r.nulleMunicipio,r.contestateMunicipio])]
      .map(row=>row.map(csvCell).join(';')).join('\r\n');
    const blob=new Blob(['\ufeff'+body],{type:'text/csv;charset=utf-8'});
    const url=URL.createObjectURL(blob);
    const a=document.createElement('a');
    const now=new Date();
    const stamp=[now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),String(now.getDate()).padStart(2,'0')].join('')+'_'+String(now.getHours()).padStart(2,'0')+String(now.getMinutes()).padStart(2,'0');
    a.href=url;a.download='SeggioLink_Report_Amministrative_IX_'+stamp+'.csv';
    document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(error){
    console.error('Errore esportazione CSV:',error);
    alert('Errore esportazione CSV: '+(error?.message||error));
  }
  return false;
}


function styleEmbeddedDashboardFrame(){
  const frame=$('#dashboardFrame');
  if(!frame)return;
  try{
    const doc=frame.contentDocument||frame.contentWindow?.document;
    if(!doc||!doc.head)return;

    let style=doc.getElementById('seggi-control-center-embedded-style');
    if(!style){
      style=doc.createElement('style');
      style.id='seggi-control-center-embedded-style';
      doc.head.appendChild(style);
    }

    style.textContent=`
      /* Vista dashboard incorporata nel Control Center 15.2.1 */
      .top-actions #reportBtn{
        background:transparent !important;
        color:#e7edf7 !important;
        border:0 !important;
        padding:8px 4px !important;
        border-radius:0 !important;
        box-shadow:none !important;
        text-decoration:none !important;
        font-weight:700 !important;
      }
      .top-actions #reportBtn:hover,
      .top-actions #reportBtn:focus-visible{
        color:#fff !important;
        text-decoration:underline !important;
        outline:none !important;
      }
      .top-actions{
        gap:14px !important;
      }
      .top-actions .status{
        display:inline-flex;
        align-items:center;
        gap:7px;
      }
      .top-actions .status::before{
        content:"";
        width:8px;
        height:8px;
        border-radius:50%;
        background:#33c779;
        display:inline-block;
      }
      @media(max-width:700px){
        .top-actions #reportBtn{
          width:auto !important;
        }
      }
    `;

    const report=doc.getElementById('reportBtn');
    if(report){
      report.setAttribute('title','Apri il report finale');
      report.setAttribute('aria-label','Apri il report finale');
    }
  }catch(error){
    console.warn('Impossibile rifinire la dashboard incorporata:',error);
  }
}
function bindEmbeddedDashboardFrame(){
  const frame=$('#dashboardFrame');
  if(!frame||frame.dataset.seggiStyled==='1')return;
  frame.dataset.seggiStyled='1';
  frame.addEventListener('load',styleEmbeddedDashboardFrame);
  try{styleEmbeddedDashboardFrame()}catch(e){}
}

function switchView(name){$$('.view').forEach(x=>x.classList.toggle('active',x.id==='view-'+name));$$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===name));if(name==='dashboard'){const f=$('#dashboardFrame');if(f&&!f.src){f.src=f.dataset.src||'dashboard.html?v=1521';}bindEmbeddedDashboardFrame();setTimeout(styleEmbeddedDashboardFrame,120);}if(name==='rankings'){renderRankings($('#rankingLevel').value,'#bestRankings',15,false);renderRankings($('#rankingLevel').value,'#worstRankings',15,true)}if(name==='sections')renderRegistry();if(name==='map'){renderMapList();renderGeoMap().catch(e=>{console.error(e);const info=$('#mapGeoSummary');if(info)info.textContent=e.message})}if(name==='report'){const p=$('#reportPreview');if(p&&!p.querySelector('.report-sheet'))p.innerHTML='<p class="empty-state">Scegli “Dossier riepilogo” oppure “Report sezioni”.</p>';}window.scrollTo({top:0,behavior:'smooth'})}
window.SeggioLinkGenerateReport=generateReport;

function bindControlCenterEvents(){
  const refreshBtn=$('#refreshBtn');
  const logoutBtn=$('#logoutBtn');
  const printBtn=$('#printBtn');
  const generateReportBtn=$('#generateReportBtn');
  const generateDetailedReportBtn=$('#generateDetailedReportBtn');
  const downloadDetailedCsvBtn=$('#downloadDetailedCsvBtn');
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
    const preview=$('#reportPreview');
    if(!preview?.querySelector('.report-sheet'))generateReport();
    setTimeout(()=>window.print(),220);
  });

  if(!generateReportBtn)console.error('Pulsante #generateReportBtn non trovato.');
  if(generateDetailedReportBtn)generateDetailedReportBtn.addEventListener('click',generateDetailedReport);
  if(downloadDetailedCsvBtn)downloadDetailedCsvBtn.addEventListener('click',downloadDetailedCsv);

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
bindEmbeddedDashboardFrame();
document.addEventListener('click',e=>{const b=e.target.closest?.('#generateReportBtn');if(b){e.preventDefault();generateReport();}},{capture:true});
(async()=>{try{$('#sectionSearch').value='';$('#mapSearch').value='';await loadRegistry();rebuildRegistryIndex()}catch(e){console.error(e);$('#registrySummary').textContent=e.message;$('#sectionsBody').innerHTML=`<tr><td colspan="5" class="empty-cell error">${esc(e.message)}</td></tr>`;$('#mapSectionList').innerHTML=`<p class="empty-state error">${esc(e.message)}</p>`}if(dashboardToken)await load();else showLogin()})();
window.addEventListener('hashchange',()=>{const v=location.hash.replace('#','');if(['overview','dashboard','map','sections','rankings','report'].includes(v))switchView(v)});
