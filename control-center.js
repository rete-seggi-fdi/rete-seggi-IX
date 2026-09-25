'use strict';
const CFG=window.SEGGI_CONFIG||{};
const BACKEND=String(CFG.backendUrl||'').trim();
const TOKEN_KEY='seggi_dashboard_token',EXP_KEY='seggi_dashboard_token_expiry',LIVE_CACHE_KEY='seggi_control_center_live_1417';
// Token e dati live restano soltanto nella sessione della scheda/browser.
// Rimuoviamo anche eventuali residui persistenti delle versioni precedenti.
try{
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(EXP_KEY);
  ['seggi_control_center_live_1532','seggi_control_center_live_1400','seggi_control_center_live_1412','seggi_control_center_live_1417']
    .forEach(k=>localStorage.removeItem(k));
}catch(e){}
let dashboardToken=sessionStorage.getItem(TOKEN_KEY)||'',live=null,systemStatus=null;
let resultsLoaded=false,resultsPromise=null,quickRequestPromise=null,revisionRequestPromise=null,quickPollTimer=null;
const DASHBOARD_POLL_MS=Math.max(8000,Number(CFG.dashboardRefreshMs||12000));
let registry={schemaVersion:0,sezioniTotali:0,plessiTotali:0,sezioni:[]};
let geoPlessi={schemaVersion:0,plessiTotali:0,plessiGeocodificati:0,plessi:[]};
let registryBySection=new Map();
let mapInstance=null,mapMarkers=[],leafletPromise=null,boundaryLayer=null,boundaryVisible=true,boundaryGeoJson=null,userLocationMarker=null,userAccuracyCircle=null,geoReady=false,geoLoadPromise=null;
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
const fmt=n=>Number(n||0).toLocaleString('it-IT');
const pct=n=>(n===''||n==null||!Number.isFinite(Number(n)))?'—':Number(n).toLocaleString('it-IT',{maximumFractionDigits:1})+'%';
const esc=v=>String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
const normSection=v=>String(Number(String(v??'').replace(/\D/g,''))||'');
async function post(payload,tentativo=1){
  if(!BACKEND)throw new Error('URL backend assente: config.js non caricato.');

  const maxTentativi=3;
  const controller=new AbortController();
  const timeout=setTimeout(()=>{if(!controller.signal.aborted){try{controller.abort(new DOMException('Tempo massimo di risposta superato.','TimeoutError'))}catch(e){controller.abort()}}},Number(CFG.requestTimeoutMs||20000));
  let response;

  try{
    response=await fetch(BACKEND,{
      method:'POST',
      headers:{'Content-Type':'text/plain;charset=UTF-8'},
      body:JSON.stringify(payload),
      cache:'no-store',
      redirect:'follow',
      credentials:'omit',
      referrerPolicy:'no-referrer',
      signal:controller.signal
    });
  }catch(error){
    clearTimeout(timeout);
    if(tentativo<maxTentativi){
      const attesa=tentativo===1?700:1800;
      await new Promise(resolve=>setTimeout(resolve,attesa));
      return post(payload,tentativo+1);
    }
    if(controller.signal.aborted||error?.name==='AbortError'||error?.name==='TimeoutError')throw new Error('Il backend sta impiegando più del previsto. I dati restano visualizzati e il collegamento verrà riprovato.');
    throw new Error('Connessione al backend non riuscita: '+error.message);
  }

  clearTimeout(timeout);
  const testo=await response.text();

  if(!response.ok){
    // Apps Script può restituire temporaneamente 404/5xx durante propagazione o redirect.
    // Non consideriamo questi codici come revoca della sessione.
    if((response.status===404||response.status>=500)&&tentativo<maxTentativi){
      const attesa=tentativo===1?700:1800;
      await new Promise(resolve=>setTimeout(resolve,attesa));
      return post(payload,tentativo+1);
    }
    console.error('Errore backend',{status:response.status,urlFinale:response.url,risposta:testo,tipo:payload?.tipo||''});
    throw new Error('Backend HTTP '+response.status+'. Collegamento temporaneamente non disponibile.');
  }

  try{return JSON.parse(testo)}
  catch(error){
    console.error('Risposta backend non JSON:',testo);
    throw new Error('Il backend ha restituito una risposta non valida.');
  }
}
function setOnline(ok,text){$('#connectionDot')?.classList.toggle('online',ok);if($('#connectionText'))$('#connectionText').textContent=text}
function setLoginOnly(active){
  document.body.classList.toggle('login-only',Boolean(active));
}
function showLogin(message='',clearToken=false){
  if(clearToken)clearSession();
  setLoginOnly(true);
  $('#loginView').hidden=false;
  $('#appView').hidden=true;
  $('#loginError').textContent=message;
  ['refreshBtn','printBtn','logoutBtn'].forEach(id=>$('#'+id).hidden=true);
  setOnline(false,'Non collegato');
}
function showAppShell(){
  setLoginOnly(false);
  $('#loginView').hidden=true;
  $('#appView').hidden=false;
  ['refreshBtn','printBtn','logoutBtn'].forEach(id=>$('#'+id).hidden=false);
}
function clearSession(){
  dashboardToken='';
  stopDashboardPolling1417();
  resultsLoaded=false;
  resultsPromise=null;
  quickRequestPromise=null;
  revisionRequestPromise=null;
  try{localStorage.removeItem(TOKEN_KEY);localStorage.removeItem(EXP_KEY);localStorage.removeItem('seggi_control_center_live_1400');localStorage.removeItem(LIVE_CACHE_KEY)}catch(e){}
  sessionStorage.removeItem(TOKEN_KEY);sessionStorage.removeItem(EXP_KEY);sessionStorage.removeItem(LIVE_CACHE_KEY);
  live=null;
}
function tokenScaduto(){
  const exp=sessionStorage.getItem(EXP_KEY)||'';
  if(!exp)return false;
  const t=Date.parse(exp);
  return Number.isFinite(t)&&Date.now()>=t;
}
async function login(password){
  const x=await post({tipo:'dashboard_login',password});
  if(!x.ok)throw new Error(x.error||'Accesso non riuscito');
  dashboardToken=String(x.dashboardToken||'');
  if(!dashboardToken)throw new Error('Il backend non ha restituito il token.');
  sessionStorage.setItem(TOKEN_KEY,dashboardToken);
  sessionStorage.setItem(EXP_KEY,x.expiresAt||'');
  return x;
}
function validateRegistry(data){if(!data||typeof data!=='object'||!Array.isArray(data.sezioni))throw new Error('Archivio sezioni non valido.');const rows=data.sezioni.filter(x=>x&&x.sezione&&x.indirizzo).map(x=>({...x,sezione:normSection(x.sezione),numeroVie:Number(x.numeroVie||((x.vieAssegnate||[]).length)),vieAssegnate:Array.isArray(x.vieAssegnate)?x.vieAssegnate:[]}));if(!rows.length)throw new Error('Archivio sezioni vuoto.');const plessi=new Set(rows.map(x=>String(x.indirizzo).trim()+'|'+String(x.cap||'').trim()));return {...data,sezioni:rows,sezioniTotali:rows.length,plessiTotali:Number(data.plessiTotali||plessi.size)}}
async function loadRegistry(){const url='data/sezioni-ix-control.json?v=1417';const r=await fetch(url,{cache:'force-cache'});if(!r.ok)throw new Error('Archivio sezioni non raggiungibile ('+r.status+').');registry=validateRegistry(await r.json())}
async function loadGeoPlessi(){const url='data/plessi-ix-geocodificati.json?v=1417';const r=await fetch(url,{cache:'force-cache'});if(!r.ok)throw new Error('Archivio geografico non raggiungibile ('+r.status+').');const data=await r.json();if(!data||!Array.isArray(data.plessi))throw new Error('Archivio geografico non valido.');const validi=data.plessi.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Number(p.lat)!==0&&Number(p.lng)!==0);if(!validi.length)throw new Error('Nessun plesso geocodificato disponibile.');geoPlessi={...data,plessi:validi,plessiGeocodificati:validi.length}}

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
function ensureLeaflet(){if(window.L)return Promise.resolve(window.L);if(leafletPromise)return leafletPromise;leafletPromise=new Promise((resolve,reject)=>{if(!document.querySelector('link[data-seggi-leaflet]')){const link=document.createElement('link');link.rel='stylesheet';link.href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';link.integrity='sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';link.crossOrigin='anonymous';link.referrerPolicy='no-referrer';link.dataset.seggiLeaflet='1';document.head.appendChild(link)}const script=document.createElement('script');script.src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';script.integrity='sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';script.crossOrigin='anonymous';script.referrerPolicy='no-referrer';script.onload=()=>window.L?resolve(window.L):reject(new Error('Libreria mappa non inizializzata.'));script.onerror=()=>reject(new Error('Impossibile caricare la libreria della mappa.'));document.head.appendChild(script)});return leafletPromise}
function prepareMapLayout(){
  const view=$('#view-map');
  if(!view)return null;
  const layout=view.querySelector('.map-layout');
  const staticPanel=view.querySelector('.map-panel');
  const aside=view.querySelector('.map-sections');
  const list=$('#mapSectionList');
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
  if(version)version.textContent='CONTROL CENTER 14.1.7';
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
        <button type="button" id="mapBoundaryFitBtn" class="btn secondary">Inquadra confine IX</button>
      </div>
    </div>
    <div id="mapDiagnostics" class="map-diagnostics" aria-live="polite">
      <div><span>Plessi</span><strong id="diagPlessi">—</strong></div>
      <div><span>Sezioni associate</span><strong id="diagSezioni">—</strong></div>
      <div><span>Marker distinti</span><strong id="diagMarkers">—</strong></div>
      <div><span>Fuori confine</span><strong id="diagOutside">—</strong></div>
      <div><span>Coordinate mancanti</span><strong id="diagMissingCoords">—</strong></div>
      <div><span>Fascia sud</span><strong id="diagSouth">—</strong></div>
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
  $('#mapBoundaryFitBtn')?.addEventListener('click',fitMapToBoundary);
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

function fitMapToBoundary(){
  if(!mapInstance||!boundaryLayer)return;
  const b=boundaryLayer.getBounds();
  if(b&&b.isValid())mapInstance.fitBounds(b,{padding:[28,28],maxZoom:12});
}
function pointInRing_(lng,lat,ring){
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=Number(ring[i][0]),yi=Number(ring[i][1]),xj=Number(ring[j][0]),yj=Number(ring[j][1]);
    const hit=((yi>lat)!==(yj>lat))&&(lng<(xj-xi)*(lat-yi)/((yj-yi)||1e-12)+xi);
    if(hit)inside=!inside;
  }
  return inside;
}
function pointInPolygonCoords_(lng,lat,coords){
  if(!Array.isArray(coords)||!coords.length||!pointInRing_(lng,lat,coords[0]))return false;
  for(let i=1;i<coords.length;i++)if(pointInRing_(lng,lat,coords[i]))return false;
  return true;
}
function pointInsideBoundary_(lat,lng){
  if(!boundaryGeoJson?.features?.length)return null;
  for(const f of boundaryGeoJson.features){
    const g=f?.geometry;if(!g)continue;
    if(g.type==='Polygon'&&pointInPolygonCoords_(lng,lat,g.coordinates))return true;
    if(g.type==='MultiPolygon')for(const poly of g.coordinates||[])if(pointInPolygonCoords_(lng,lat,poly))return true;
  }
  return false;
}
function updateMapDiagnostics(){
  const plessi=geoPlessi.plessi||[];
  const configured=Number(geoPlessi.plessiTotali||plessi.length);
  const valid=plessi.filter(p=>Number.isFinite(Number(p.lat))&&Number.isFinite(Number(p.lng))&&Number(p.lat)!==0&&Number(p.lng)!==0);
  const coords=new Set(valid.map(p=>Number(p.lat).toFixed(6)+','+Number(p.lng).toFixed(6)));
  const missing=Math.max(0,configured-valid.length);
  let outside='—',south='—';
  if(boundaryLayer&&boundaryGeoJson?.features?.length){
    const b=boundaryLayer.getBounds(),mid=b&&b.isValid()?b.getCenter().lat:null;
    if(Number.isFinite(mid))south=valid.filter(p=>Number(p.lat)<mid).length;
    outside=valid.filter(p=>pointInsideBoundary_(Number(p.lat),Number(p.lng))===false).length;
  }
  const put=(id,v)=>{const el=$(id);if(el)el.textContent=String(v)};
  put('#diagPlessi',valid.length+'/'+configured);put('#diagSezioni',geoSectionsTotal());put('#diagMarkers',coords.size);
  put('#diagOutside',outside);put('#diagMissingCoords',missing);put('#diagSouth',south);
  $('#mapDiagnostics')?.classList.toggle('has-warning',missing>0||(typeof outside==='number'&&outside>0)||coords.size!==valid.length);
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
async function loadMunicipioBoundary(L){if(boundaryLayer)return boundaryLayer;const endpoint='https://services-eu1.arcgis.com/CQGl8ODCKnscqiME/ArcGIS/rest/services/Perimetrazioni_Comune_di_Roma/FeatureServer/0/query?where=1%3D1&outFields=MUNICIPIO%2CDENOMINAZI&returnGeometry=true&outSR=4326&f=geojson';const r=await fetch(endpoint,{cache:'force-cache'});if(!r.ok)throw new Error('Confine municipale non raggiungibile ('+r.status+').');const all=await r.json();const features=(all.features||[]).filter(f=>romanToNumber(f?.properties?.MUNICIPIO)===9||/municipio\s*ix/i.test(String(f?.properties?.DENOMINAZI||'')));if(!features.length)throw new Error('Confine del Municipio IX non trovato.');boundaryGeoJson={type:'FeatureCollection',features};boundaryLayer=L.geoJSON(boundaryGeoJson,{style:{color:'#0b3b75',weight:4,opacity:.95,fillColor:'#2f6fb0',fillOpacity:.08,dashArray:'9 6'},interactive:true}).bindPopup('<strong>Municipio IX Roma</strong><br>Confine amministrativo');boundaryLayer.addTo(mapInstance);boundaryVisible=true;return boundaryLayer}
function addBoundaryToggle(L){if($('#mapBoundaryToggle'))return;const Control=L.Control.extend({options:{position:'topright'},onAdd(){const box=L.DomUtil.create('div','leaflet-bar');const b=L.DomUtil.create('button','',box);b.id='mapBoundaryToggle';b.type='button';b.title='Mostra o nascondi il confine del Municipio IX';b.setAttribute('aria-label',b.title);b.style.cssText='width:auto;min-width:40px;height:34px;padding:0 10px;border:0;background:white;font-weight:700;cursor:pointer';const sync=()=>b.textContent=boundaryVisible?'Confine ✓':'Confine';sync();L.DomEvent.disableClickPropagation(box);L.DomEvent.on(b,'click',()=>{if(!boundaryLayer)return;if(boundaryVisible){mapInstance.removeLayer(boundaryLayer);boundaryVisible=false}else{boundaryLayer.addTo(mapInstance);boundaryVisible=true}sync()});return box}});mapInstance.addControl(new Control())}

async function renderGeoMap(){
  const el=ensureMapContainer();
  if(!el)return;
  await ensureGeoReady();
  const L=await ensureLeaflet();
  const staticPanel=$('#view-map .map-panel');
  if(!mapInstance){
    mapInstance=L.map(el,{zoomControl:true,scrollWheelZoom:true,preferCanvas:true}).setView([41.805,12.47],12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{
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
  // La mappa dinamica deve comparire subito: il confine ArcGIS è un livello
  // accessorio e viene caricato in background, senza tenere visibile il fallback.
  if(staticPanel)staticPanel.hidden=true;
  setTimeout(()=>{mapInstance.invalidateSize();fitMapToPlessi();},60);

  const info=$('#mapGeoSummary');
  if(info)info.textContent=`${fmt(geoPlessi.plessiGeocodificati)} plessi geocodificati · ${fmt(geoSectionsTotal())} sezioni associate · caricamento confine…`;
  updateMapDiagnostics();

  loadMunicipioBoundary(L).then(()=>{
    updateMapDiagnostics();
    if(info)info.textContent=`${fmt(geoPlessi.plessiGeocodificati)} plessi geocodificati · ${fmt(geoSectionsTotal())} sezioni associate · confine Municipio IX attivo`;
  }).catch(e=>{
    console.warn(e);
    updateMapDiagnostics();
    if(info)info.textContent=`${fmt(geoPlessi.plessiGeocodificati)} plessi geocodificati · ${fmt(geoSectionsTotal())} sezioni associate · confine non disponibile`;
  });
}
async function focusSectionOnMap(section){const sec=normSection(section);if(!mapInstance||!mapMarkers.length){try{await renderGeoMap()}catch(e){console.error(e)}}const marker=mapMarkers.find(m=>m._seggiSections?.has(sec));if(marker&&mapInstance){mapInstance.setView(marker.getLatLng(),16,{animate:true});marker.openPopup();return true}openSection(sec);return false}
function emptyLive1417(){
  return {
    ok:true,
    serverTime:'',
    versioneBackend:'',
    dataRevision:0,
    resultsRevision:0,
    resultsLoaded:false,
    totali:{elettori:0,maschi:0,femmine:0,totale:0,percentuale:''},
    sezioniAttese:0,sezioniRicevute:0,sezioniMancanti:0,
    perMunicipio:[],sezioni:[],mancanti:[],ultimiInvii:[],
    scrutiniDettaglio:[],risultatiListe:[],riepilogoFdi:{}
  };
}
function normalizeLive1417(data){
  const base=emptyLive1417(),x=(data&&typeof data==='object')?data:{};
  return {
    ...base,...x,
    totali:{...base.totali,...(x.totali||{})},
    perMunicipio:Array.isArray(x.perMunicipio)?x.perMunicipio:[],
    sezioni:Array.isArray(x.sezioni)?x.sezioni:[],
    mancanti:Array.isArray(x.mancanti)?x.mancanti:[],
    ultimiInvii:Array.isArray(x.ultimiInvii)?x.ultimiInvii:[],
    scrutiniDettaglio:Array.isArray(x.scrutiniDettaglio)?x.scrutiniDettaglio:[],
    risultatiListe:Array.isArray(x.risultatiListe)?x.risultatiListe:[],
    riepilogoFdi:(x.riepilogoFdi&&typeof x.riepilogoFdi==='object')?x.riepilogoFdi:{}
  };
}
function saveLiveCache1417(){
  if(!live)return;
  try{sessionStorage.setItem(LIVE_CACHE_KEY,JSON.stringify({savedAt:Date.now(),data:live}))}catch(e){}
}
function restoreLiveCache(){
  if(live)return false;
  try{
    const cached=JSON.parse(sessionStorage.getItem(LIVE_CACHE_KEY)||'null');
    if(!cached?.data)return false;
    live=normalizeLive1417(cached.data);
    resultsLoaded=Boolean(live.resultsLoaded&&Array.isArray(live.risultatiListe));
    renderAll();
    showAppShell();
    $('#lastUpdate').textContent='Dati memorizzati · aggiornamento in corso…';
    return true;
  }catch(e){return false}
}
function activeViewName1417(){
  return $('.nav-item.active')?.dataset?.view||'overview';
}
function renderActiveView1417(){
  const name=activeViewName1417();
  if(name==='data')renderDataView();
  if(name==='rankings'){
    renderRankings($('#rankingLevel').value,'#bestRankings',15,false);
    renderRankings($('#rankingLevel').value,'#worstRankings',15,true);
  }
  if(name==='sections')renderRegistry();
  if(name==='map'){
    try{renderMapList()}catch(e){console.error(e)}
    if(mapInstance){
      mapMarkers.forEach(m=>m.setIcon(markerIcon(statusForPlesso(m._seggiPlesso))));
    }
  }
}
function stopDashboardPolling1417(){
  if(quickPollTimer){clearInterval(quickPollTimer);quickPollTimer=null}
}
async function checkDashboardRevision1417(){
  if(!dashboardToken||tokenScaduto())return false;
  if(revisionRequestPromise)return revisionRequestPromise;

  revisionRequestPromise=(async()=>{
    try{
      const x=await post({tipo:'dashboard_revision',dashboardToken});
      if(!x.ok){
        if(String(x.code||'').includes('SESSION')){showLogin(x.error||'Sessione scaduta.',true);return false}
        throw new Error(x.error||'Errore controllo aggiornamenti');
      }

      const current=String(live?.dataRevision??'');
      const incoming=String(x.dataRevision??'');
      if(x.liveDirty||!x.liveReady||!live?.serverTime||current!==incoming){
        await load({silent:true});
      }else if(!resultsLoaded){
        ensureResultsLoaded1417(false).catch(e=>console.error(e));
      }
      return true;
    }catch(e){
      console.error(e);
      return false;
    }
  })();

  try{return await revisionRequestPromise}
  finally{revisionRequestPromise=null}
}
function startDashboardPolling1417(){
  if(quickPollTimer||!dashboardToken)return;
  quickPollTimer=setInterval(()=>{
    if(document.visibilityState!=='visible'||!dashboardToken||tokenScaduto())return;
    checkDashboardRevision1417().catch(e=>console.error(e));
  },DASHBOARD_POLL_MS);
}
async function ensureResultsLoaded1417(force=false){
  if(!dashboardToken)return false;
  if(resultsLoaded&&!force)return true;
  if(resultsPromise)return resultsPromise;

  resultsPromise=(async()=>{
    const x=await post({tipo:'dashboard_results',dashboardToken});
    if(!x.ok){
      if(String(x.code||'').includes('SESSION')){showLogin(x.error||'Sessione scaduta.',true);return false}
      throw new Error(x.error||'Errore caricamento risultati');
    }

    const currentRevision=String(live?.resultsRevision??'');
    const responseRevision=String(x.resultsRevision??'');
    if(currentRevision&&responseRevision&&currentRevision!==responseRevision){
      resultsLoaded=false;
      window.setTimeout(()=>ensureResultsLoaded1417(false).catch(e=>console.error(e)),350);
      return false;
    }

    live=normalizeLive1417({
      ...(live||emptyLive1417()),
      risultatiListe:Array.isArray(x.risultatiListe)?x.risultatiListe:[],
      scrutiniDettaglio:Array.isArray(x.scrutiniDettaglio)?x.scrutiniDettaglio:(live?.scrutiniDettaglio||[]),
      riepilogoFdi:x.riepilogoFdi||{},
      configurazioneFdi:x.configurazioneFdi||live?.configurazioneFdi||{},
      resultsRevision:x.resultsRevision??live?.resultsRevision??0,
      resultsLoaded:true,
      versioneBackend:x.versioneBackend||live?.versioneBackend||''
    });
    resultsLoaded=true;
    saveLiveCache1417();
    renderAll();
    renderActiveView1417();
    return true;
  })();

  try{return await resultsPromise}
  finally{resultsPromise=null}
}
async function load(options={}){
  if(!dashboardToken)return showLogin('',false);
  if(quickRequestPromise)return quickRequestPromise;

  const silent=Boolean(options.silent);
  const restored=!live&&restoreLiveCache();
  if(!live)live=emptyLive1417();

  if(!silent)setOnline(false,restored?'Aggiornamento…':'Caricamento dati…');
  const refreshBtn=$('#refreshBtn');
  if(refreshBtn&&!silent)refreshBtn.disabled=true;

  quickRequestPromise=(async()=>{
    try{
      const x=await post({tipo:'dashboard_quick',dashboardToken});
      if(!x.ok){
        if(String(x.code||'').includes('SESSION'))return showLogin(x.error||'Sessione scaduta.',true);
        if(x.code==='DASHBOARD_UPDATING'){
          showAppShell();
          setOnline(false,'Aggiornamento…');
          $('#lastUpdate').textContent='Sincronizzazione dati in corso…';
          window.setTimeout(()=>load({silent:true}).catch(e=>console.error(e)),1200);
          return false;
        }
        throw new Error(x.error||'Errore backend');
      }

      const previous=normalizeLive1417(live);
      const sameResultsRevision=
        resultsLoaded &&
        String(previous.resultsRevision??'')===String(x.resultsRevision??'');

      live=normalizeLive1417({
        ...previous,
        ...x,
        risultatiListe:sameResultsRevision?previous.risultatiListe:[],
        riepilogoFdi:sameResultsRevision?previous.riepilogoFdi:{},
        // La risposta quick contiene TUTTI gli scrutini ricevuti, quindi mappa e
        // stato sezioni sono corretti senza attendere i risultati di lista.
        scrutiniDettaglio:Array.isArray(x.scrutiniDettaglio)?x.scrutiniDettaglio:[],
        resultsLoaded:sameResultsRevision
      });
      resultsLoaded=sameResultsRevision;

      saveLiveCache1417();
      renderAll();
      showAppShell();
      setOnline(true,resultsLoaded?'Online':'Online · risultati in aggiornamento');
      $('#backendVersion').textContent='Backend '+(x.versioneBackend||'-');
      $('#lastUpdate').textContent='Aggiornato '+new Date(x.serverTime||Date.now()).toLocaleString('it-IT');

      startDashboardPolling1417();

      // Precarica cartografia e risultati senza bloccare l'interfaccia.
      ensureGeoReady().catch(e=>console.warn('Precaricamento mappa:',e));
      ensureLeaflet().catch(e=>console.warn('Precaricamento Leaflet:',e));
      if(!resultsLoaded){
        window.setTimeout(()=>{
          ensureResultsLoaded1417(false).catch(e=>{
            console.error(e);
            if(live)setOnline(true,'Online · risultati da aggiornare');
          });
        },180);
      }
      return true;
    }catch(e){
      const hasData=Boolean(live?.serverTime||live?.sezioni?.length||live?.scrutiniDettaglio?.length);
      // Un errore HTTP/rete NON deve mai riportare al login: la sessione viene
      // chiusa soltanto quando il backend restituisce esplicitamente un errore SESSION.
      showAppShell();
      setOnline(false,hasData?'Dati memorizzati':'Backend temporaneamente non disponibile');
      if($('#lastUpdate')){
        $('#lastUpdate').textContent=hasData
          ? 'Dati memorizzati · collegamento in ripristino…'
          : (e.message||'Backend temporaneamente non disponibile.');
      }
      console.error(e);
      return false;
    }finally{
      if(refreshBtn&&!silent)refreshBtn.disabled=false;
    }
  })();

  try{return await quickRequestPromise}
  finally{quickRequestPromise=null}
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
  renderRecent();renderMissingTerritorial();renderRankings($('#rankLevel').value,'#topList',5,false);renderRegistry();renderMapList();if($('#view-data')?.classList.contains('active'))renderDataView();
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
function hasAnyScrutinio1417(){return Boolean((live?.scrutiniDettaglio||[]).length||(live?.risultatiListe||[]).length)}
function emptyResultsMessage1417(){if(!resultsLoaded)return 'Risultati elettorali in aggiornamento…';if(!hasAnyScrutinio1417())return 'In attesa dei primi scrutini.';return 'Nessun risultato disponibile per questo livello.'}
function renderRankings(level,target,count=10,reverse=false){let rows=rankingRows(level);if(reverse)rows=rows.slice().reverse();rows=rows.slice(0,count);$(target).innerHTML=rows.map((r,i)=>`<div class="ranking-row" data-section="${esc(r.sezione)}"><span class="ranking-index">${i+1}</span><div><strong>Sezione ${esc(normSection(r.sezione)||r.sezione)}</strong><small>${fmt(r.fdiVoti)} voti FdI</small></div><span class="ranking-value">${pct(r.fdiSuValidi)}</span></div>`).join('')||`<p class="empty-state">${emptyResultsMessage1417()}</p>`;$$(`${target} [data-section]`).forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function statusFor(section){const data=live||emptyLive1417();const sec=normSection(section);const scr=(data.scrutiniDettaglio||[]).some(x=>normSection(x.sezione)===sec)||(data.risultatiListe||[]).some(x=>normSection(x.sezione)===sec);if(scr)return{label:'Scrutinio ricevuto',cls:'done'};const aff=(data.sezioni||[]).some(x=>normSection(x.sezione)===sec);return aff?{label:'Affluenza ricevuta',cls:'partial'}:{label:'Nessun dato',cls:'missing'}}
function filteredRegistry(q,status='all'){q=String(q||'').trim().toLowerCase();return registry.sezioni.filter(x=>{const matchesText=!q||String(x.sezione).includes(q)||String(x.indirizzo).toLowerCase().includes(q)||String(x.cap||'').includes(q);const st=statusFor(x.sezione);return matchesText&&(status==='all'||st.cls===status)})}
function renderRegistry(){const rows=filteredRegistry($('#sectionSearch')?.value,$('#sectionStatus')?.value||'all');$('#registrySummary').textContent=`${fmt(registry.sezioniTotali)} sezioni in ${fmt(registry.plessiTotali)} plessi elettorali`;$('#sectionsBody').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<tr data-section="${esc(r.sezione)}"><td><strong>${esc(r.sezione)}</strong></td><td>${esc(r.indirizzo)}</td><td>${esc(r.cap)}</td><td>${fmt(r.numeroVie)}</td><td><span class="state ${st.cls}">${st.label}</span></td></tr>`}).join('')||'<tr><td colspan="5" class="empty-cell">Nessuna sezione corrisponde al filtro.</td></tr>';$$('#sectionsBody tr[data-section]').forEach(x=>x.onclick=()=>openSection(x.dataset.section))}
function renderMapList(){const q=$('#mapSearch')?.value||'';const rows=filteredRegistry(q);$('#mapSectionList').innerHTML=rows.map(r=>{const st=statusFor(r.sezione);return`<button type="button" class="map-section-card" data-section="${esc(r.sezione)}"><strong>Sezione ${esc(r.sezione)}</strong><small>${esc(r.indirizzo)}${r.cap?' · '+esc(r.cap):''}</small><span class="state ${st.cls}">${st.label}</span></button>`}).join('')||'<p class="empty-state">Nessuna sezione corrisponde alla ricerca.</p>';$$('.map-section-card').forEach(x=>x.onclick=()=>focusSectionOnMap(x.dataset.section));const exact=rows.length===1&&normSection(q)===normSection(rows[0].sezione);if(exact)setTimeout(()=>focusSectionOnMap(rows[0].sezione),50)}

function dataResultRows(){
  if(!live)return[];
  const level=$('#dataLevel')?.value||'Comune';
  const q=normSection($('#dataSectionSearch')?.value||'');
  return (live.risultatiListe||[])
    .filter(r=>String(r.municipio||'').replace(/\D/g,'').padStart(2,'0')==='09')
    .filter(r=>r.livello===level)
    .filter(r=>registryBySection.has(normSection(r.sezione)))
    .filter(r=>!q||normSection(r.sezione).includes(q))
    .map(r=>{
      const iscritti=Number(r.elettori||0),votanti=Number(r.votanti||0),validi=Number(r.votiValidi||0),fdi=Number(r.fdiVoti||0);
      return {...r,iscritti,votanti,validi,fdi,altri:Math.max(0,validi-fdi),
        pctValidi:validi?fdi/validi*100:'',pctVotanti:votanti?fdi/votanti*100:'',pctIscritti:iscritti?fdi/iscritti*100:''};
    }).sort((a,b)=>Number(a.sezione)-Number(b.sezione));
}
function renderDataSummary(rows){
  const box=$('#dataFdiSummary');if(!box)return;
  const a=rows.reduce((t,r)=>{t.sezioni++;t.iscritti+=r.iscritti;t.votanti+=r.votanti;t.validi+=r.validi;t.fdi+=r.fdi;if(Number(r.posizioneFdi||0)===1)t.prime++;return t;},{sezioni:0,iscritti:0,votanti:0,validi:0,fdi:0,prime:0});
  box.innerHTML=`<article><span>Voti FdI</span><strong>${fmt(a.fdi)}</strong></article><article><span>FdI sui validi</span><strong>${a.validi?pct(a.fdi/a.validi*100):'—'}</strong></article><article><span>FdI sui votanti</span><strong>${a.votanti?pct(a.fdi/a.votanti*100):'—'}</strong></article><article><span>FdI sugli iscritti</span><strong>${a.iscritti?pct(a.fdi/a.iscritti*100):'—'}</strong></article><article><span>FdI primo</span><strong>${fmt(a.prime)}/${fmt(a.sezioni)}</strong></article>`;
}
function renderDataView(){
  if(!live)return;
  const t=live.totali||{},received=territorialReceived(),expected=territorialExpected();
  $('#dataKpiTurnout').textContent=pct(t.percentuale);$('#dataKpiVoters').textContent=fmt(t.totale);$('#dataKpiMF').textContent=fmt(t.maschi)+' / '+fmt(t.femmine);$('#dataKpiSections').textContent=fmt(received)+' / '+fmt(expected);
  const rows=dataResultRows();$('#dataResultCount').textContent=fmt(rows.length)+' sezioni';renderDataSummary(rows);
  $('#dataResultsBody').innerHTML=rows.map(r=>{const reg=registryForSection(r.sezione),positive=Number(r.distaccoPrimoAltro||0)>=0,confronto=r.primoAltroPartito?`${positive?'+':''}${fmt(r.distaccoPrimoAltro)} su ${esc(r.primoAltroPartito)}`:'—';return `<tr data-section="${esc(r.sezione)}"><td><strong>${esc(normSection(r.sezione)||r.sezione)}</strong></td><td>${esc(reg?.indirizzo||'—')}</td><td>${fmt(r.iscritti)}</td><td>${fmt(r.votanti)}</td><td>${fmt(r.validi)}</td><td><strong>${fmt(r.fdi)}</strong></td><td>${fmt(r.altri)}</td><td><strong>${pct(r.pctValidi)}</strong></td><td>${pct(r.pctVotanti)}</td><td>${pct(r.pctIscritti)}</td><td>${r.posizioneFdi?esc(r.posizioneFdi)+'°':'—'}</td><td class="${positive?'positive':'negative'}">${confronto}</td></tr>`}).join('')||`<tr><td colspan="12" class="empty-cell">${resultsLoaded?(hasAnyScrutinio1417()?'Nessun risultato disponibile con questo filtro.':'In attesa dei primi scrutini.'):'Risultati elettorali in aggiornamento…'}</td></tr>`;
  $$('#dataResultsBody tr[data-section]').forEach(tr=>tr.onclick=()=>openSection(tr.dataset.section));
  const q=normSection($('#dataSectionSearch')?.value||'');
  const aff=(live.sezioni||[]).filter(r=>registryBySection.has(normSection(r.sezione))).filter(r=>!q||normSection(r.sezione).includes(q)).sort((a,b)=>Number(a.sezione)-Number(b.sezione));
  $('#dataAffluenzaCount').textContent=fmt(aff.length)+' sezioni';
  $('#dataAffluenzaBody').innerHTML=aff.map(r=>`<tr data-section="${esc(r.sezione)}"><td><strong>${esc(normSection(r.sezione)||r.sezione)}</strong></td><td>${esc((r.giorno||'')+' '+(r.orario||''))}</td><td>${fmt(r.maschi)}</td><td>${fmt(r.femmine)}</td><td>${fmt(r.totale)}</td><td>${pct(r.percentuale)}</td></tr>`).join('')||'<tr><td colspan="6" class="empty-cell">Nessun dato di affluenza.</td></tr>';
  $$('#dataAffluenzaBody tr[data-section]').forEach(tr=>tr.onclick=()=>openSection(tr.dataset.section));
  const seen=new Set();(live.sezioni||[]).forEach(r=>seen.add(normSection(r.sezione)));(live.scrutiniDettaglio||[]).forEach(r=>seen.add(normSection(r.sezione)));
  const missing=(registry.sezioni||[]).filter(r=>!seen.has(normSection(r.sezione))).filter(r=>!q||normSection(r.sezione).includes(q));
  $('#dataMissingCount').textContent=fmt(missing.length)+' mancanti';
  $('#dataMissingList').innerHTML=missing.length?missing.slice(0,80).map(r=>`<button class="chip" data-section="${esc(r.sezione)}">${esc(r.sezione)}</button>`).join(''):'<span class="state done">Nessuna sezione mancante</span>';
  $$('#dataMissingList [data-section]').forEach(b=>b.onclick=()=>openSection(b.dataset.section));
}

function openSection(section){
  if(!resultsLoaded)ensureResultsLoaded1417(false).catch(e=>console.error(e));
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

      preview.innerHTML=`<div class="report-sheet"><div class="report-title"><p class="eyebrow">RETE SEGGI FDI - IX MUNICIPIO ROMA</p><h2>Dossier elettorale - Elezioni amministrative</h2><p>Generato il ${new Date().toLocaleString('it-IT',{hour12:false})}</p></div><div class="report-grid"><div class="report-stat"><span>Sezioni presidiate</span><strong>${fmt(live.sezioniAttese)}</strong></div><div class="report-stat"><span>Sezioni territoriali/cartografiche</span><strong>${fmt(territorialExpected())}</strong></div><div class="report-stat"><span>Sezioni ricevute</span><strong>${fmt(territorialReceived())}</strong></div><div class="report-stat"><span>Affluenza</span><strong>${pct(live.totali?.percentuale)}</strong></div><div class="report-stat"><span>Votanti</span><strong>${fmt(live.totali?.totale)}</strong></div><div class="report-stat"><span>FdI Comune</span><strong>${fmt(c.fdiVoti)}</strong><small>${pct(c.fdiSuValidi)}</small></div><div class="report-stat"><span>FdI Municipio</span><strong>${fmt(m.fdiVoti)}</strong><small>${pct(m.fdiSuValidi)}</small></div><div class="report-stat"><span>Plessi</span><strong>${fmt(registry.plessiTotali)}</strong></div><div class="report-stat"><span>Sezioni territoriali</span><strong>${fmt(registry.sezioniTotali)}</strong></div></div><div class="report-table"><h3>Top 10 sezioni FdI - Comune</h3>${top.length?`<table><thead><tr><th>Pos.</th><th>Sezione</th><th>Voti FdI</th><th>% validi</th><th>Indirizzo</th></tr></thead><tbody>${top.map((r,i)=>{const reg=registryForSection(r.sezione);return`<tr><td>${i+1}</td><td>${esc(normSection(r.sezione)||r.sezione)}</td><td>${fmt(r.fdiVoti)}</td><td>${pct(r.fdiSuValidi)}</td><td>${esc(reg?.indirizzo||'Indirizzo non disponibile')}</td></tr>`}).join('')}</tbody></table>`:`<p class="empty-state">${hasAnyScrutinio1417()?'Nessun risultato disponibile per questo livello.':'In attesa dei primi scrutini.'}</p>`}</div></div>`;

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
    if(!rows.length){preview.innerHTML='<p class="empty-state">Il report sezioni sarà disponibile dopo la ricezione del primo scrutinio.</p>';return false;}
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
    if(!rows.length){alert('Il file CSV sarà disponibile dopo la ricezione del primo scrutinio.');return;}
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


function systemDate(value){if(!value)return'—';const d=new Date(value);return Number.isFinite(d.getTime())?d.toLocaleString('it-IT',{hour12:false}):'—'}
function systemBool(ok,yes='ATTIVO',no='NON ATTIVO'){return `<span class="state ${ok?'done':'missing'}">${ok?yes:no}</span>`}
function renderSystemStatus(){
  const s=systemStatus;if(!s)return;
  const hero=$('#systemHero'),label=$('#systemStateLabel'),detail=$('#systemStateDetail');
  const state=String(s.stato||'warning');hero.className='system-hero is-'+state;
  label.textContent=state==='ok'?'SISTEMA OPERATIVO':state==='critical'?'INTERVENTO NECESSARIO':'ATTENZIONE';
  detail.textContent=state==='ok'?'Tutti i controlli operativi principali risultano regolari.':state==='critical'?'È presente almeno una criticità che richiede verifica.':'Il sistema è operativo con uno o più avvisi da controllare.';
  $('#systemCheckedAt').textContent='Verificato '+systemDate(s.serverTime);
  $('#systemFrontendVersion').textContent='14.1.7';
  $('#systemBackendVersion').textContent=String(s.versioneBackend||'—').replace('-security-session-registry-production','').replace('-performance-production','');
  $('#systemBackendEnv').textContent=String(s.ambiente||'—');
  $('#systemSections').textContent=fmt(s.sezioniAttive||0);
  $('#systemErrors').textContent=fmt(s.log?.errori15m||0);
  $('#systemServicesBadge').textContent=s.dashboard?.triggerAttivo?'OPERATIVI':'VERIFICA';
  $('#systemServices').innerHTML=[
    ['Backend/API',systemBool(true,'ONLINE','OFFLINE')],
    ['Database',systemBool(Boolean(s.database?.ok),'OK','ERRORE')],
    ['Control Center live',systemBool(Boolean(s.dashboard?.liveReady&&!s.dashboard?.liveDirty),'PRONTO','DA SINCRONIZZARE')],
    ['Dashboard automatica',systemBool(Boolean(s.dashboard?.triggerAttivo))],
    ['Cache login',systemBool(Boolean(s.login?.cacheIndicizzata),'CALDA','DA PREPARARE')],
    ['Simulatore isolato',systemBool(Boolean(s.simulator?.isolato),'ISOLATO','NON ISOLATO')]
  ].map(x=>`<div class="system-row"><span>${esc(x[0])}</span><strong>${x[1]}</strong></div>`).join('');
  const backupOk=Boolean(s.backup?.automaticoAttivo&&s.backup?.ultimoSnapshot);
  $('#systemBackupBadge').textContent=backupOk?'PROTETTO':'DA VERIFICARE';
  $('#systemBackup').innerHTML=[
    ['Snapshot automatici',systemBool(Boolean(s.backup?.automaticoAttivo))],
    ['Ultimo snapshot',`<span>${esc(systemDate(s.backup?.ultimoSnapshot))}</span>`],
    ['Nome',`<span>${esc(s.backup?.ultimoNome||'—')}</span>`],
    ['Stato backup',`<span>${esc(s.backup?.statoUltimo||'—')}</span>`],
    ['In lavorazione',`<span>${esc(s.backup?.pending?.nome||'—')}</span>`],
    ['Retention',`<span>ultimi ${fmt(s.backup?.retention||0)}</span>`]
  ].map(x=>`<div class="system-row"><span>${esc(x[0])}</span><strong>${x[1]}</strong></div>`).join('');
  $('#systemActivity').innerHTML=[
    ['Ultima affluenza',systemDate(s.ultimoInvioAffluenza)],
    ['Ultimo scrutinio',systemDate(s.ultimoScrutinio)],
    ['Dashboard generale',systemDate(s.dashboard?.ultimoAggiornamentoGenerale)],
    ['Dashboard affluenza',systemDate(s.dashboard?.ultimoAggiornamentoAffluenza)],
    ['Control Center live',systemDate(s.dashboard?.liveBuiltAt)],
    ['Cache login riscaldata',systemDate(s.login?.cacheRiscaldataIl)]
  ].map(x=>`<div class="system-row"><span>${esc(x[0])}</span><strong>${esc(x[1])}</strong></div>`).join('');
  const alerts=[...(s.criticita||[]).map(t=>({kind:'critical',text:t})),...(s.avvisi||[]).map(t=>({kind:'warning',text:t}))];
  $('#systemWarnings').innerHTML=alerts.length?alerts.map(a=>`<div class="system-alert ${a.kind}">${esc(a.text)}</div>`).join(''):'<div class="system-alert ok">Nessuna criticità o avviso operativo.</div>';
}
async function loadSystemStatus(force=false){
  if(!dashboardToken)return showLogin('',false);
  const btn=$('#systemRefreshBtn');if(btn)btn.disabled=true;
  try{
    const x=await post({tipo:'dashboard_system_status',dashboardToken,force:!!force});
    if(!x.ok){if(String(x.code||'').includes('SESSION'))return showLogin(x.error,true);throw new Error(x.error||'Errore stato sistema')}
    systemStatus=x;renderSystemStatus();
  }catch(e){console.error(e);const w=$('#systemWarnings');if(w)w.innerHTML=`<div class="system-alert critical">${esc(e.message||e)}</div>`}
  finally{if(btn)btn.disabled=false}
}
async function createSystemSnapshot(){
  const btn=$('#systemSnapshotBtn');if(btn){btn.disabled=true;btn.textContent='Programmazione…'}
  try{
    const x=await post({tipo:'dashboard_snapshot',dashboardToken});
    if(!x.ok){const extra=x.code==='SNAPSHOT_RATE_LIMITED'&&x.retryAfterSeconds?' Riprova tra '+Math.ceil(Number(x.retryAfterSeconds)/60)+' min.':'';throw new Error((x.error||'Snapshot non riuscito')+extra)}
    await loadSystemStatus(true);
    alert('Snapshot programmato in background: '+(x.nome||'in coda')+'\n\nControlla Stato Sistema tra alcuni minuti.');
  }catch(e){alert('Impossibile programmare lo snapshot: '+(e.message||e))}
  finally{if(btn){btn.disabled=false;btn.textContent='Crea snapshot ora'}}
}

function switchView(name){
  $$('.view').forEach(x=>x.classList.toggle('active',x.id==='view-'+name));
  $$('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.view===name));

  if(name==='system')loadSystemStatus();

  if(name==='data'){
    renderDataView();
    ensureResultsLoaded1417(false).then(()=>renderDataView()).catch(e=>console.error(e));
  }

  if(name==='rankings'){
    renderRankings($('#rankingLevel').value,'#bestRankings',15,false);
    renderRankings($('#rankingLevel').value,'#worstRankings',15,true);
    ensureResultsLoaded1417(false).then(()=>{
      renderRankings($('#rankingLevel').value,'#bestRankings',15,false);
      renderRankings($('#rankingLevel').value,'#worstRankings',15,true);
    }).catch(e=>console.error(e));
  }

  if(name==='sections')renderRegistry();

  if(name==='map'){
    // L'elenco e la cartografia sono indipendenti: un errore nel primo non deve
    // mai impedire a Leaflet di inizializzarsi.
    try{renderMapList()}catch(e){console.error('Errore elenco mappa:',e)}
    renderGeoMap().catch(e=>{
      console.error(e);
      const info=$('#mapGeoSummary');
      if(info)info.textContent='Mappa interattiva non disponibile: '+e.message;
    });
  }

  if(name==='report'){
    const p=$('#reportPreview');
    if(p&&!p.querySelector('.report-sheet'))p.innerHTML='<p class="empty-state">Scegli “Dossier riepilogo” oppure “Report sezioni”.</p>';
    ensureResultsLoaded1417(false).catch(e=>console.error(e));
  }

  window.scrollTo({top:0,behavior:'smooth'});
}
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
        button.textContent='Accesso riuscito';
        showAppShell();
        const cached=restoreLiveCache();
        if(!cached){
          setOnline(false,'Caricamento…');
          $('#lastUpdate').textContent='Accesso effettuato · caricamento dati…';
        }
        await load();
      }catch(err){
        showLogin(err.message,false);
        setOnline(false,'Errore');
      }finally{
        button.disabled=false;
        button.textContent=originalLabel;
        passwordInput.disabled=false;
      }
    });
  }

  if(refreshBtn)refreshBtn.addEventListener('click',async()=>{
    await load({silent:false});
    try{await ensureResultsLoaded1417(true)}catch(e){console.error(e)}
  });
  $('#systemRefreshBtn')?.addEventListener('click',()=>loadSystemStatus(true));
  $('#systemSnapshotBtn')?.addEventListener('click',createSystemSnapshot);
  if(logoutBtn)logoutBtn.addEventListener('click',()=>showLogin('',true));
  if(printBtn)printBtn.addEventListener('click',async()=>{
    switchView('report');
    try{await ensureResultsLoaded1417(false)}catch(e){console.error(e)}
    const preview=$('#reportPreview');
    if(!preview?.querySelector('.report-sheet'))generateReport();
    setTimeout(()=>window.print(),220);
  });

  if(!generateReportBtn)console.error('Pulsante #generateReportBtn non trovato.');
  if(generateDetailedReportBtn)generateDetailedReportBtn.addEventListener('click',async()=>{
    try{await ensureResultsLoaded1417(false);generateDetailedReport()}
    catch(e){alert('Impossibile aggiornare i risultati: '+(e.message||e))}
  });
  if(downloadDetailedCsvBtn)downloadDetailedCsvBtn.addEventListener('click',downloadDetailedCsv);

  if(closeDialog)closeDialog.addEventListener('click',()=>$('#sectionDialog').close());

  $$('.nav-item').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.view)));
  $$('[data-view-link]').forEach(b=>b.addEventListener('click',()=>switchView(b.dataset.viewLink)));

  const rankLevel=$('#rankLevel');
  const rankingLevel=$('#rankingLevel');
  const sectionSearch=$('#sectionSearch');
  const sectionStatus=$('#sectionStatus');
  const mapSearch=$('#mapSearch');
  const dataLevel=$('#dataLevel');
  const dataSectionSearch=$('#dataSectionSearch');

  if(rankLevel)rankLevel.addEventListener('change',e=>renderRankings(e.target.value,'#topList',5,false));
  if(rankingLevel)rankingLevel.addEventListener('change',e=>{
    renderRankings(e.target.value,'#bestRankings',15,false);
    renderRankings(e.target.value,'#worstRankings',15,true);
  });
  if(sectionSearch)sectionSearch.addEventListener('input',renderRegistry);
  if(sectionStatus)sectionStatus.addEventListener('change',renderRegistry);
  if(mapSearch)mapSearch.addEventListener('input',renderMapList);
  if(dataLevel)dataLevel.addEventListener('change',renderDataView);
  if(dataSectionSearch)dataSectionSearch.addEventListener('input',renderDataView);

  document.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&$('#sectionDialog')?.open)$('#sectionDialog').close();
  });
}

bindControlCenterEvents();
document.addEventListener('click',async e=>{
  const b=e.target.closest?.('#generateReportBtn');
  if(!b)return;
  e.preventDefault();
  try{await ensureResultsLoaded1417(false);generateReport()}
  catch(err){alert('Impossibile aggiornare i risultati: '+(err.message||err))}
},{capture:true});
(async()=>{
  if(tokenScaduto()){clearSession();dashboardToken='';}
  if(!dashboardToken)showLogin('',false);
  else setLoginOnly(false);

  try{
    $('#sectionSearch').value='';
    $('#mapSearch').value='';
    await loadRegistry();
    rebuildRegistryIndex();
    if(live)renderAll();
    // Precaricamento non bloccante: quando l'utente apre la mappa, dati
    // geografici e Leaflet sono normalmente già disponibili.
    ensureGeoReady().catch(err=>console.warn('Precaricamento geografia:',err));
    ensureLeaflet().catch(err=>console.warn('Precaricamento Leaflet:',err));
  }catch(e){
    console.error(e);
    $('#registrySummary').textContent=e.message;
    $('#sectionsBody').innerHTML=`<tr><td colspan="5" class="empty-cell error">${esc(e.message)}</td></tr>`;
    $('#mapSectionList').innerHTML=`<p class="empty-state error">${esc(e.message)}</p>`;
  }

  if(dashboardToken){
    const cached=restoreLiveCache();
    if(!cached){
      showAppShell();
      setOnline(false,'Aggiornamento…');
      $('#lastUpdate').textContent='Sessione valida · caricamento dati…';
    }
    load();
  }
})();
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='visible'&&dashboardToken&&!tokenScaduto()){
    checkDashboardRevision1417().catch(e=>console.error(e));
  }
});
window.addEventListener('pagehide',stopDashboardPolling1417);
window.addEventListener('hashchange',()=>{const v=location.hash.replace('#','');if(['overview','system','data','map','sections','rankings','report'].includes(v))switchView(v)});
