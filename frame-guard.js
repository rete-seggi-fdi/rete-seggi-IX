'use strict';

(function () {
  try {
    if (window.top === window.self) return;
  } catch (e) {
    // Se il confronto è impedito dal browser, trattalo come embedding ostile.
  }
  try { document.documentElement.style.display = 'none'; } catch (e) {}
  try { window.stop(); } catch (e) {}
}());
