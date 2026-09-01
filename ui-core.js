'use strict';

(function () {
  const QUEUE_STATUS = Object.freeze({
    LOCAL: 'pending',
    SENDING: 'syncing',
    CONFIRMED: 'synced',
    ACTION_REQUIRED: 'error'
  });

  function queueMeta(status) {
    if (status === QUEUE_STATUS.CONFIRMED) return { key: 'confirmed', label: 'Ricevuto dal coordinamento', pill: 'good' };
    if (status === QUEUE_STATUS.SENDING) return { key: 'sending', label: 'Invio in corso…', pill: 'neutral' };
    if (status === QUEUE_STATUS.ACTION_REQUIRED) return { key: 'attention', label: 'Richiede attenzione', pill: 'bad' };
    return { key: 'local', label: 'Salvato sul telefono', pill: 'warn' };
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function text(tag, value, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    return node;
  }

  window.SeggioUI = Object.freeze({ QUEUE_STATUS, queueMeta, clearNode, text });
}());
