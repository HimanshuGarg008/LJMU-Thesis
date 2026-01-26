// content_keyboard.js
// Minimal, privacy-preserving keyboard timing capture. DOES NOT RECORD KEY IDENTITY.
// When a video play session is active on the page, keyboard capture is suppressed (video content script sets window.__vc_videoCaptureActive).

(function() {
  const buffer = [];
  let flushTimer = null;
  const FLUSH_MS = 2000;

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, FLUSH_MS);
  }
  function flush() {
    if (buffer.length) {
      try { chrome.runtime.sendMessage({ type: 'keyboardEventBatch', events: buffer.splice(0) }); } catch(e){}
    }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  const pendingDown = [];

  function handleKeyDown(ev) {
    try {
      if (window.__vc_videoCaptureActive) return;
      const now = Date.now();
      pendingDown.push({ ts: now });
      buffer.push({ ts: now, event_type: 'keydown' });
      scheduleFlush();
    } catch (err) {}
  }
  function handleKeyUp(ev) {
    try {
      if (window.__vc_videoCaptureActive) return;
      const now = Date.now();
      let hold = 0;
      if (pendingDown.length) {
        const d = pendingDown.pop();
        hold = Math.max(0, now - d.ts);
      }
      buffer.push({ ts: now, event_type: 'keyup', hold_ms: hold });
      scheduleFlush();
    } catch (err) {}
  }

  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('keyup', handleKeyUp, true);
  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', () => flush());
})();