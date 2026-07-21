'use strict';

/* Service worker per Rete Seggi FdI.
   Strategia: cache-first per i file dell'app (sempre disponibile offline),
   network-first con fallback in cache per i dati di sezione/via
   (così se cambiano vengono aggiornati appena c'è connessione).
   Le richieste verso il backend (Apps Script, altro dominio) non vengono
   mai intercettate: passano sempre direttamente alla rete. */

const VERSIONE = 'seggiolink-v13.3.8';
const CACHE_SHELL = 'shell-' + VERSIONE;
const CACHE_DATI = 'dati-' + VERSIONE;

const FILE_APP = [
  './',
  './index.html',
  './config.js',
  './build-info.json',
  './styles.css',
  './app.js',
  './manifest.json',
  './data/indice-sezioni.json',
  './data/municipio-01.json',
  './data/municipio-02.json',
  './data/municipio-03.json',
  './data/municipio-04.json',
  './data/municipio-05.json',
  './data/municipio-06.json',
  './data/municipio-07.json',
  './data/municipio-08.json',
  './data/municipio-09.json',
  './data/municipio-10.json',
  './data/municipio-11.json',
  './data/municipio-12.json',
  './data/municipio-13.json',
  './data/municipio-14.json',
  './data/municipio-15.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/icon-1024.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL).then((cache) => cache.addAll(FILE_APP))
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((nomi) =>
      Promise.all(nomi.filter((n) => n !== CACHE_SHELL && n !== CACHE_DATI).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Non toccare mai le richieste verso altri domini (es. il backend Apps Script):
  // devono sempre andare in rete, mai passare dalla cache.
  if (url.origin !== self.location.origin) return;

  if (event.request.method !== 'GET') return;

  // Dati sezioni/vie: network-first, fallback alla cache se offline.
  if (url.pathname.indexOf('/data/') !== -1) {
    event.respondWith(
      fetch(event.request).then((res) => {
        const copia = res.clone();
        caches.open(CACHE_DATI).then((cache) => cache.put(event.request, copia));
        return res;
      }).catch(() => caches.match(event.request))
    );
    return;
  }

  // File dell'app (HTML/JS/CSS): network-first, con fallback alla cache solo se offline.
  // Così ogni aggiornamento pubblicato è visibile subito al primo caricamento con
  // connessione, e l'app resta comunque utilizzabile offline grazie al fallback.
  event.respondWith(
    fetch(event.request).then((res) => {
      if (res && res.ok) {
        const copia = res.clone();
        caches.open(CACHE_SHELL).then((cache) => cache.put(event.request, copia));
      }
      return res;
    }).catch(async () => {
      const cached = await caches.match(event.request);
      if (cached) return cached;
      if (event.request.mode === 'navigate') return caches.match('./index.html');
      return new Response('Contenuto non disponibile offline.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    })
  );
});
