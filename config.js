/* Configurazione ambiente: non inserire segreti in questo file. */
window.SEGGI_CONFIG = Object.freeze({
  appVersion: '13.1.0',
  buildDate: '2026-07-20',

  // Ambiente
  environment: 'test', // 'test' oppure 'production'

  // Informazioni applicazione
  latestVersionUrl: 'build-info.json',
  appName: 'SeggioLink Roma',

  // Backend
  backendProvider: 'apps-script',
  backendUrl: 'https://script.google.com/macros/s/AKfycbxdjMHth9B70bN9Ug6-McqckZXxt3vNlvfyOd12CJiulwmroniK9azwInxRsNKVv3eLyg/exec',

  // Timeout richieste
  requestTimeoutMs: 20000,

  // Municipi attivi
  enabledMunicipalities: ['09'],
  allowAllMunicipalitiesData: true
});
