/* Configurazione ambiente: non inserire segreti in questo file. */

/* Protezione di fallback contro embedding/clickjacking quando l'hosting statico
   non consente di impostare l'header CSP frame-ancestors. */
if (window.top !== window.self) {
  document.documentElement.textContent = '';
  throw new Error('SeggioLink non può essere eseguito dentro un frame.');
}

window.SEGGI_CONFIG = Object.freeze({
  appVersion: '14.0.7',
  buildDate: '2026-09-01',
  environment: 'production',
  latestVersionUrl: 'build-info.json',
  appName: 'SeggioLink Roma',
  backendProvider: 'apps-script',
  backendUrl: 'https://script.google.com/macros/s/AKfycbzmCq7kgjqIK7eCDD_rq1JuCJ9qr0b4HP7JPZrt9Is8neON1GH27dxJMtsPH5-T0o1L_w/exec',
  requestTimeoutMs: 60000,
  enabledMunicipalities: ['09'],
  allowAllMunicipalitiesData: false
});
