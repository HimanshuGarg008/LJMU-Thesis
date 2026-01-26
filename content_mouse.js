// content_mouse.js
// Capture mouse movement, clicks, and scroll. When video capturing is active on the page, mouse capture for raw (non-video) is suppressed.

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
      try { chrome.runtime.sendMessage({ type: 'mouseEventBatch', events: buffer.splice(0) }); } catch(e){}
    }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  }

  let lastMouseTs = null;
  function onMove(e) {
    try {
      if (window.__vc_videoCaptureActive) return;
      const now = Date.now();
      const dt = lastMouseTs ? (now - lastMouseTs) : 0;
      lastMouseTs = now;
      buffer.push({ ts: now, event_type: 'move', x: e.clientX, y: e.clientY });
      scheduleFlush();
    } catch (err) {}
  }
  function onClick(e) {
    try {
      if (window.__vc_videoCaptureActive) return;
      const now = Date.now();
      buffer.push({ ts: now, event_type: 'click', x: e.clientX, y: e.clientY });
      scheduleFlush();
    } catch (err) {}
  }
  function onScroll(e) {
    try {
      if (window.__vc_videoCaptureActive) return;
      const now = Date.now();
      buffer.push({ ts: now, event_type: 'scroll', x: window.scrollX || 0, y: window.scrollY || 0 });
      scheduleFlush();
    } catch (err) {}
  }

  document.addEventListener('mousemove', onMove, { passive: true });
  document.addEventListener('click', onClick, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true });

  window.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', () => flush());
})();