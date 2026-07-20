/* Configurazione ambiente: non inserire segreti in questo file. */
window.SEGGI_CONFIG = Object.freeze({
  appVersion: '12.0.0',
  appName: 'SeggioLink Roma',
  backendProvider: 'apps-script', // 'apps-script' oppure 'cloudflare-d1'
  backendUrl: 'https://script.google.com/macros/s/INSERIRE_NUOVO_DEPLOYMENT/exec',
  requestTimeoutMs: 20000,
  enabledMunicipalities: ['09'],
  allowAllMunicipalitiesData: true
});
