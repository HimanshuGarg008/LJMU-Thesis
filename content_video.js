// Updated content_video.js
// - Emits rows for play/pause/ended/source_changed/tab_closed.
// - Collects cursor samples and local keyboard timing while video is playing.
// - Computes cursor and typing aggregates ONLY while playing (incremental).
// - Privacy: does NOT read key identity, URLs, DOM content.

(function () {
  const DEFAULT_FLUSH_MS = 2000;
  const MAX_SAMPLES_PER_FLUSH = 1000;

  function log(...args) { try { console.log('VC:', ...args); } catch (e) { } }
  function makeSessionId() { return 'vid_' + Math.random().toString(36).slice(2, 10); }

  function attachToVideo(el) {
    try {
      if (!el || el.__vc_attached) return;
      el.__vc_attached = true;
      log('attach', el, 'src?', el.currentSrc || el.src);

      let sessionId = null;
      let playing = false;
      let playingStartTs = null;
      let cumulativePlayMs = 0;
      let lastPlayTs = null;

      let cursorSamples = [];
      let clickCount = 0;
      let scrollCount = 0;

      let keyboardEventCount = 0;
      let keyboardHoldSamples = [];
      let keyboardDdSamples = [];
      let keyboardUdSamples = [];
      const pendingDownStack = [];
      let prevKeydownTs = null;
      let lastKeyupTs = null;

      let pauseCount = 0;
      let resumeCount = 0;
      let currentSrc = el.currentSrc || el.src || null;
      let flushTimer = null;

      function scheduleFlush() {
        if (flushTimer) return;
        flushTimer = setTimeout(() => { flush('periodic'); }, DEFAULT_FLUSH_MS);
      }

      function computeCursorStats(samples) {
        if (!samples || samples.length < 2) {
          return { cursor_path_length: 0, cursor_mean_speed: 0, cursor_entropy: 0, cursor_sample_count: samples.length || 0 };
        }
        let pathLen = 0;
        const speeds = [];
        for (let i = 1; i < samples.length; i++) {
          const a = samples[i - 1], b = samples[i];
          const dist = Math.hypot(b.x - a.x, b.y - a.y);
          const dt = Math.max(1, b.ts - a.ts);
          pathLen += dist;
          speeds.push(dist / (dt / 1000));
        }
        const meanSpeed = speeds.length ? (speeds.reduce((s, v) => s + v, 0) / speeds.length) : 0;
        let entropy = 0;
        try {
          const xs = samples.map(s => s.x), ys = samples.map(s => s.y);
          const bins = 8;
          const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
          const xR = maxX - minX + 1e-9, yR = maxY - minY + 1e-9;
          const H = new Array(bins * bins).fill(0);
          for (let i = 0; i < xs.length; i++) {
            const xi = Math.min(bins - 1, Math.floor(((xs[i] - minX) / xR) * bins));
            const yi = Math.min(bins - 1, Math.floor(((ys[i] - minY) / yR) * bins));
            H[yi * bins + xi]++;
          }
          const p = H.filter(c => c > 0).map(c => c / xs.length);
          entropy = p.reduce((s, pv) => s - pv * Math.log2(pv), 0);
        } catch (e) { }
        return { cursor_path_length: pathLen, cursor_mean_speed: meanSpeed, cursor_entropy: entropy, cursor_sample_count: samples.length };
      }

      function computeKeyboardTypingStats(holds, dds, uds) {
        const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
        return { keyboard_event_count: keyboardEventCount, keyboard_hold_mean: mean(holds), keyboard_dd_mean: mean(dds), keyboard_ud_mean: mean(uds) };
      }

      function computeInteractionDensity(cursorCount, keyCount, durationSec) {
        if (!durationSec || durationSec <= 0) return 0;
        return (cursorCount + keyCount) / durationSec;
      }

      function computePauseResumeRate(pauseCnt, resumeCnt, playSeconds) {
        if (!playSeconds || playSeconds <= 0) return 0;
        return ((pauseCnt + resumeCnt) / playSeconds) * 60;
      }

      function flush(reason) {
        try {
          const cursorStats = computeCursorStats(cursorSamples);
          const typingStats = computeKeyboardTypingStats(keyboardHoldSamples, keyboardDdSamples, keyboardUdSamples);
          const now = Date.now();
          let sessionPlayMs = cumulativePlayMs;
          if (playing && lastPlayTs) sessionPlayMs += (now - lastPlayTs);

          const videoRow = {
            ts_start: playingStartTs || Date.now(),
            ts_end: now,
            video_session_id: sessionId || makeSessionId(),
            tab_id: null,
            video_state: playing ? 'playing' : (reason === 'periodic' ? 'playing_checkpoint' : (reason || 'unknown')),
            video_duration_sec: (el.duration && isFinite(el.duration)) ? el.duration : (sessionPlayMs / 1000),
            volume: el.volume || 0,
            cursor_path_length: cursorStats.cursor_path_length,
            cursor_mean_speed: cursorStats.cursor_mean_speed,
            cursor_entropy: cursorStats.cursor_entropy,
            cursor_sample_count: cursorStats.cursor_sample_count,
            keyboard_event_count: typingStats.keyboard_event_count,
            keyboard_hold_mean: typingStats.keyboard_hold_mean,
            keyboard_dd_mean: typingStats.keyboard_dd_mean,
            keyboard_ud_mean: typingStats.keyboard_ud_mean,
            click_count: clickCount,
            scroll_count: scrollCount,
            interaction_density: computeInteractionDensity(cursorStats.cursor_sample_count, typingStats.keyboard_event_count, DEFAULT_FLUSH_MS / 1000),
            pause_resume_rate: computePauseResumeRate(pauseCount, resumeCount, sessionPlayMs / 1000),
            is_tab_closed: false,
            config_version: (window.__vc_config_version || 1)
          };

          if (reason === 'play') videoRow.video_state = 'play';
          else if (reason === 'pause') videoRow.video_state = 'pause';
          else if (reason === 'ended') videoRow.video_state = 'ended';
          else if (reason === 'source_changed') videoRow.video_state = 'source_changed';
          else if (reason === 'tab_closed') { videoRow.video_state = 'tab_closed'; videoRow.is_tab_closed = true; }

          chrome.runtime.sendMessage({ type: 'videoCursorBatch', event: videoRow }, () => { });
          log('sent video row', { reason, state: videoRow.video_state, samples: videoRow.cursor_sample_count });

          cursorSamples = [];
          clickCount = 0; scrollCount = 0;
          keyboardEventCount = 0; keyboardHoldSamples = []; keyboardDdSamples = []; keyboardUdSamples = []; prevKeydownTs = null; pendingDownStack.length = 0;
          pauseCount = 0; resumeCount = 0;

          if (reason === 'ended' || reason === 'source_changed' || reason === 'tab_closed') {
            cumulativePlayMs = 0; lastPlayTs = null; playingStartTs = null; lastKeyupTs = null;
            if (reason === 'source_changed') sessionId = makeSessionId();
          }
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        } catch (err) { log('flush error', err); }
      }

      function onPlay() {
        if (!sessionId) sessionId = makeSessionId();
        lastPlayTs = Date.now();
        if (!playingStartTs) playingStartTs = lastPlayTs;
        playing = true;
        window.__vc_videoCaptureActive = true;
        resumeCount++;
        log('video play - session', sessionId);
        flush('play');
        window.addEventListener('mousemove', onMouseMove, { passive: true });
        window.addEventListener('click', onClick, { passive: true });
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        scheduleFlush();
      }

      function onPause() {
        if (!playing) return;
        if (lastPlayTs) { cumulativePlayMs += (Date.now() - lastPlayTs); lastPlayTs = null; }
        playing = false;
        window.__vc_videoCaptureActive = false;
        pauseCount++;
        log('video pause - session', sessionId);
        flush('pause');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('click', onClick);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
      }

      function onEnded() {
        if (playing && lastPlayTs) { cumulativePlayMs += (Date.now() - lastPlayTs); lastPlayTs = null; }
        playing = false;
        window.__vc_videoCaptureActive = false;
        log('video ended - session', sessionId);
        flush('ended');
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('click', onClick);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
      }

      const attrObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && (m.attributeName === 'src' || m.attributeName === 'currentSrc')) {
            const newSrc = el.currentSrc || el.src || null;
            if (currentSrc && newSrc && currentSrc !== newSrc) {
              if (playing && lastPlayTs) { cumulativePlayMs += (Date.now() - lastPlayTs); lastPlayTs = Date.now(); }
              flush('source_changed');
              currentSrc = newSrc;
              sessionId = makeSessionId();
            } else currentSrc = newSrc;
          }
        }
      });
      try { attrObserver.observe(el, { attributes: true, attributeFilter: ['src'] }); } catch (e) { }

      function onMouseMove(e) {
        if (!playing) return;
        cursorSamples.push({ ts: Date.now(), x: e.clientX, y: e.clientY });
        if (cursorSamples.length >= MAX_SAMPLES_PER_FLUSH) flush('buffer_full');
      }
      function onClick(e) { if (playing) clickCount++; }
      function onScroll(e) { if (playing) scrollCount++; }

      function onKeyDown(e) {
        if (!playing) return;
        const ts = Date.now();
        if (prevKeydownTs !== null) keyboardDdSamples.push(ts - prevKeydownTs);
        if (lastKeyupTs !== null) keyboardUdSamples.push(ts - lastKeyupTs);
        prevKeydownTs = ts;
        pendingDownStack.push(ts);
        keyboardEventCount++;
      }
      function onKeyUp(e) {
        if (!playing) return;
        const ts = Date.now();
        lastKeyupTs = ts;
        if (pendingDownStack.length) keyboardHoldSamples.push(ts - pendingDownStack.pop());
      }

      const removalObserver = new MutationObserver(() => {
        if (!document.body.contains(el)) {
          if (playing && lastPlayTs) { cumulativePlayMs += (Date.now() - lastPlayTs); lastPlayTs = null; }
          playing = false;
          window.__vc_videoCaptureActive = false;
          flush('tab_closed');
          removalObserver.disconnect();
        }
      });
      removalObserver.observe(document, { childList: true, subtree: true });

      if (!el.paused) onPlay();
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('ended', onEnded);

      try {
        const attachPing = {
          ts_start: Date.now(), ts_end: Date.now(), video_session_id: sessionId || makeSessionId(),
          video_state: 'attach_ping', video_duration_sec: el.duration || 0, volume: el.volume || 0,
          cursor_path_length: 0, cursor_mean_speed: 0, cursor_entropy: 0, cursor_sample_count: 0,
          keyboard_event_count: 0, keyboard_hold_mean: 0, keyboard_dd_mean: 0, keyboard_ud_mean: 0,
          click_count: 0, scroll_count: 0, interaction_density: 0, pause_resume_rate: 0, is_tab_closed: false, config_version: (window.__vc_config_version || 1)
        };
        chrome.runtime.sendMessage({ type: 'videoCursorBatch', event: attachPing }, () => { });
      } catch (e) { }

    } catch (err) { log('attachToVideo error', err); }
  }

  function scanDocumentForVideos(doc) {
    try {
      const vids = Array.from(doc.getElementsByTagName ? doc.getElementsByTagName('video') : []);
      vids.forEach(attachToVideo);
      const allElems = doc.querySelectorAll ? Array.from(doc.querySelectorAll('*')) : [];
      for (const el of allElems) {
        if (el.shadowRoot) {
          const sv = Array.from(el.shadowRoot.querySelectorAll ? el.shadowRoot.querySelectorAll('video') : []);
          sv.forEach(attachToVideo);
        }
      }
    } catch (e) { }
  }

  function scanAllFrames() {
    try { scanDocumentForVideos(document); } catch (e) { }
    try {
      const iframes = Array.from(document.getElementsByTagName('iframe'));
      for (const f of iframes) {
        try { if (f.contentDocument) scanDocumentForVideos(f.contentDocument); } catch (e) { }
      }
    } catch (e) { }
  }

  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          if (n.tagName && n.tagName.toLowerCase() === 'video') attachToVideo(n);
          else if (n.querySelectorAll) n.querySelectorAll('video').forEach(attachToVideo);
          if (n.shadowRoot) n.shadowRoot.querySelectorAll('video').forEach(attachToVideo);
        }
      }
    }
  });
  mo.observe(document, { childList: true, subtree: true });

  try { scanAllFrames(); log('initial scan completed'); } catch (e) { }
  setInterval(() => { try { scanAllFrames(); } catch (e) { } }, 5000);

  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      chrome.runtime.sendMessage({ type: 'videoFlushAll', ts: Date.now() });
      const closeRow = { ts_start: Date.now(), ts_end: Date.now(), video_session_id: makeSessionId(), video_state: 'tab_closed', video_duration_sec: 0, volume: 0, cursor_path_length: 0, cursor_mean_speed: 0, cursor_entropy: 0, cursor_sample_count: 0, keyboard_event_count: 0, keyboard_hold_mean: 0, keyboard_dd_mean: 0, keyboard_ud_mean: 0, click_count: 0, scroll_count: 0, interaction_density: 0, pause_resume_rate: 0, is_tab_closed: true, config_version: (window.__vc_config_version || 1) };
      chrome.runtime.sendMessage({ type: 'videoCursorBatch', event: closeRow }, () => { });
    }
  });
  window.addEventListener('pagehide', () => {
    chrome.runtime.sendMessage({ type: 'videoFlushAll', ts: Date.now() });
  });
})();