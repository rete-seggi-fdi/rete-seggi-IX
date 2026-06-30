'use strict';

/* Service worker per Rete Seggi FdI.
   Strategia: cache-first per i file dell'app (sempre disponibile offline),
   network-first con fallback in cache per i dati di sezione/via
   (così se cambiano vengono aggiornati appena c'è connessione).
   Le richieste verso il backend (Apps Script, altro dominio) non vengono
   mai intercettate: passano sempre direttamente alla rete. */

const VERSIONE = 'rete-seggi-v3';
const CACHE_SHELL = 'shell-' + VERSIONE;
const CACHE_DATI = 'dati-' + VERSIONE;

const FILE_APP = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_SHELL).then((cache) => cache.addAll(FILE_APP)).then(() => self.skipWaiting())
  );
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
    }).catch(() => caches.match(event.request))
  );
});
