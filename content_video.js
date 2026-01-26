// Updated content_video.js
// - Emits rows for play/pause/ended/source_changed/tab_closed.
// - Collects cursor samples and local keyboard timing while video is playing.
// - Computes cursor and typing aggregates only while playing and includes them in video_raw rows.
// - Privacy: does NOT read key identity, URLs, DOM content.

(function() {
  const DEFAULT_FLUSH_MS = 2000;
  const MAX_SAMPLES_PER_FLUSH = 1000;

  function log(...args) { try { console.log('VC:', ...args); } catch(e) {} }
  function makeSessionId() { return 'vid_' + Math.random().toString(36).slice(2,10); }

  // Attach to a particular <video> element
  function attachToVideo(el) {
    try {
      if (!el || el.__vc_attached) return;
      el.__vc_attached = true;
      log('attach', el, 'src?', el.currentSrc || el.src);

      // Per-session / per-attachment state
      let sessionId = null;
      let playing = false;
      let playingStartTs = null;
      let cumulativePlayMs = 0; // accumulate play time across play/pause cycles within the same session
      let lastPlayTs = null;

      // Cursor samples and counts while playing
      let cursorSamples = []; // {ts,x,y}
      let clickCount = 0;
      let scrollCount = 0;

      // Keyboard timing while playing (privacy-preserving)
      let keyboardEventCount = 0;
      let keyboardHoldSamples = []; // hold_ms values from matched keydown->keyup
      let keyboardDdSamples = [];   // down-down deltas computed on keydown
      // local pending keydown timestamps for pairing keyup to compute hold
      const pendingDownStack = [];
      let prevKeydownTs = null; // for computing dd on keydown

      // Pause/resume stats
      let pauseCount = 0;
      let resumeCount = 0;

      // For detecting source change (different video played)
      let currentSrc = el.currentSrc || el.src || null;

      // Flush timer
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
          const a = samples[i-1], b = samples[i];
          const dx = b.x - a.x, dy = b.y - a.y;
          const dist = Math.hypot(dx, dy);
          const dt = Math.max(1, b.ts - a.ts);
          pathLen += dist;
          speeds.push(dist / (dt / 1000)); // px/sec
        }
        const meanSpeed = speeds.length ? (speeds.reduce((s,v)=>s+v,0)/speeds.length) : 0;
        // 2D histogram entropy (bins = 8)
        let entropy = 0;
        try {
          const xs = samples.map(s => s.x), ys = samples.map(s => s.y);
          const bins = 8;
          const minX = Math.min(...xs), maxX = Math.max(...xs);
          const minY = Math.min(...ys), maxY = Math.max(...ys);
          const eps = 1e-9;
          const xRange = maxX - minX + eps, yRange = maxY - minY + eps;
          const H = new Array(bins * bins).fill(0);
          for (let i=0;i<xs.length;i++) {
            const xi = Math.min(bins - 1, Math.floor(((xs[i] - minX) / xRange) * bins));
            const yi = Math.min(bins - 1, Math.floor(((ys[i] - minY) / yRange) * bins));
            H[yi * bins + xi] += 1;
          }
          const p = H.filter(c => c > 0).map(c => c / xs.length);
          entropy = p.reduce((s, pv) => s - pv * Math.log2(pv), 0);
        } catch (e) {
          entropy = 0;
        }
        return { cursor_path_length: pathLen, cursor_mean_speed: meanSpeed, cursor_entropy: entropy, cursor_sample_count: samples.length };
      }

      function computeKeyboardTypingStats(holds, dds) {
        const mean = arr => arr.length ? arr.reduce((a,b)=>a+b,0)/arr.length : 0;
        return { keyboard_event_count: keyboardEventCount, keyboard_hold_mean: mean(holds), keyboard_dd_mean: mean(dds) };
      }

      function computeInteractionDensity(cursorCount, keyCount, durationSec) {
        if (!durationSec || durationSec <= 0) return 0;
        return (cursorCount + keyCount) / durationSec;
      }

      function computePauseResumeRate(pauseCnt, resumeCnt, playSeconds) {
        if (!playSeconds || playSeconds <= 0) return 0;
        // define pause_resume_rate = (pauseCount + resumeCount) per minute of play
        return ((pauseCnt + resumeCnt) / playSeconds) * 60;
      }

      function flush(reason) {
        try {
          // Build aggregated row only when appropriate. We always include aggregated stats in rows for: play (initial), pause, ended, source_changed, tab_closed
          // and also periodic flushes while playing for checkpointing.
          // Only use cursorSamples and keyboard samples collected while playing.
          const cursorStats = computeCursorStats(cursorSamples);
          const typingStats = computeKeyboardTypingStats(keyboardHoldSamples, keyboardDdSamples);
          // compute play duration so far for the session (ms)
          const now = Date.now();
          let sessionPlayMs = cumulativePlayMs;
          if (playing && lastPlayTs) sessionPlayMs += (now - lastPlayTs);

          const durationSec = (el.duration && isFinite(el.duration)) ? el.duration : (sessionPlayMs / 1000);
          const interactionDensity = computeInteractionDensity(cursorStats.cursor_sample_count, typingStats.keyboard_event_count, durationSec);
          const pauseResumeRate = computePauseResumeRate(pauseCount, resumeCount, sessionPlayMs / 1000);

          const videoRow = {
            ts_start: playingStartTs || Date.now(),
            ts_end: now,
            video_session_id: sessionId || makeSessionId(),
            tab_id: (window && window.frameElement && window.frameElement.ownerDocument && window.frameElement.ownerDocument.defaultView && null) || null, // background will add sender.tab
            video_state: playing ? 'playing' : (reason === 'periodic' ? 'playing_checkpoint' : (reason || 'unknown')),
            video_duration_sec: durationSec,
            volume: (typeof el.volume === 'number' ? el.volume : 0),
            cursor_path_length: cursorStats.cursor_path_length,
            cursor_mean_speed: cursorStats.cursor_mean_speed,
            cursor_entropy: cursorStats.cursor_entropy,
            cursor_sample_count: cursorStats.cursor_sample_count,
            keyboard_event_count: typingStats.keyboard_event_count,
            keyboard_hold_mean: typingStats.keyboard_hold_mean,
            keyboard_dd_mean: typingStats.keyboard_dd_mean,
            click_count: clickCount,
            scroll_count: scrollCount,
            interaction_density: interactionDensity,
            pause_resume_rate: pauseResumeRate,
            is_tab_closed: false,
            config_version: (window.__vc_config_version || 1)
          };

          // For specific reasons, set video_state appropriately
          if (reason === 'play') videoRow.video_state = 'play';
          else if (reason === 'pause') videoRow.video_state = 'pause';
          else if (reason === 'ended') videoRow.video_state = 'ended';
          else if (reason === 'source_changed') videoRow.video_state = 'source_changed';
          else if (reason === 'tab_closed') { videoRow.video_state = 'tab_closed'; videoRow.is_tab_closed = true; }

          // Send to background
          try {
            chrome.runtime.sendMessage({ type: 'videoCursorBatch', event: videoRow }, function() {});
            log('sent video row', { reason, video_state: videoRow.video_state, cursor_samples: videoRow.cursor_sample_count, key_events: videoRow.keyboard_event_count });
          } catch (e) {
            log('sendMessage failed', e);
          }

          // After sending snapshot row, if reason indicates session end or source change or tab close, we may reset some state
          if (reason === 'ended' || reason === 'source_changed' || reason === 'tab_closed') {
            // reset session-level accumulators
            cursorSamples = [];
            clickCount = 0; scrollCount = 0;
            keyboardEventCount = 0; keyboardHoldSamples = []; keyboardDdSamples = []; prevKeydownTs = null; pendingDownStack.length = 0;
            pauseCount = 0; resumeCount = 0;
            cumulativePlayMs = 0; lastPlayTs = null; playingStartTs = null;
            // keep sessionId for audit (we may generate a new sessionId on next play/source change)
            if (reason === 'source_changed') {
              // Do not keep same sessionId for new video; create a new session
              sessionId = makeSessionId();
            }
          } else {
            // If periodic checkpoint while playing, we keep data and continue
          }

          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        } catch (err) {
          log('flush error', err);
        }
      }

      // Lifecycle handlers
      function onPlay() {
        // If no session started yet, start one
        if (!sessionId) sessionId = makeSessionId();
        // resume play timers
        lastPlayTs = Date.now();
        if (!playingStartTs) playingStartTs = lastPlayTs;
        playing = true;
        window.__vc_videoCaptureActive = true; // suppress keyboard/mouse raw in top frames
        resumeCount += 1;
        log('video play - session', sessionId);
        flush('play'); // send a play-row snapshot
        // attach listeners
        window.addEventListener('mousemove', onMouseMove, { passive: true });
        window.addEventListener('click', onClick, { passive: true });
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('keyup', onKeyUp, true);
        scheduleFlush();
      }

      function onPause() {
        if (!playing) return;
        // update cumulative play time
        const now = Date.now();
        if (lastPlayTs) {
          cumulativePlayMs += (now - lastPlayTs);
          lastPlayTs = null;
        }
        playing = false;
        window.__vc_videoCaptureActive = false;
        pauseCount += 1;
        log('video pause - session', sessionId);
        flush('pause');
        // remove listeners
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('click', onClick);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
      }

      function onEnded() {
        // treat similarly to pause but mark ended
        if (playing && lastPlayTs) {
          cumulativePlayMs += (Date.now() - lastPlayTs);
          lastPlayTs = null;
        }
        playing = false;
        window.__vc_videoCaptureActive = false;
        log('video ended - session', sessionId);
        flush('ended');
        // remove listeners
        window.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('click', onClick);
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('keydown', onKeyDown, true);
        window.removeEventListener('keyup', onKeyUp, true);
      }

      // Detect source changes (different video played). We observe attribute changes on the element.
      const attrObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes' && (m.attributeName === 'src' || m.attributeName === 'currentSrc')) {
            const newSrc = el.currentSrc || el.src || null;
            if (currentSrc && newSrc && currentSrc !== newSrc) {
              log('video source changed', { from: currentSrc, to: newSrc });
              // flush and mark source_changed
              // update cumulative play if was playing
              if (playing && lastPlayTs) {
                cumulativePlayMs += (Date.now() - lastPlayTs);
                lastPlayTs = Date.now();
              }
              flush('source_changed');
              currentSrc = newSrc;
              // reset sessionId to new session for the new video
              sessionId = makeSessionId();
              // keep playing state - continue monitoring new video
            } else {
              currentSrc = newSrc;
            }
          }
        }
      });
      try { attrObserver.observe(el, { attributes: true, attributeFilter: ['src'] }); } catch(e){}

      // Mouse/keyboard handlers used only during playing
      function onMouseMove(e) {
        try {
          if (!playing) return;
          cursorSamples.push({ ts: Date.now(), x: e.clientX, y: e.clientY });
          if (cursorSamples.length >= MAX_SAMPLES_PER_FLUSH) flush('buffer_full');
        } catch (err) {}
      }
      function onClick(e) {
        try { if (!playing) return; clickCount += 1; } catch(e){}
      }
      function onScroll(e) {
        try { if (!playing) return; scrollCount += 1; } catch(e){}
      }

      // Keyboard: we capture timing only while playing.
      function onKeyDown(e) {
        try {
          if (!playing) return;
          const ts = Date.now();
          // compute down-down delta using prevKeydownTs
          if (prevKeydownTs !== null) {
            const dd = ts - prevKeydownTs;
            keyboardDdSamples.push(dd);
          }
          prevKeydownTs = ts;
          pendingDownStack.push(ts);
          keyboardEventCount += 1;
        } catch (err) {}
      }
      function onKeyUp(e) {
        try {
          if (!playing) return;
          const ts = Date.now();
          let hold = 0;
          if (pendingDownStack.length) {
            const downTs = pendingDownStack.pop();
            hold = Math.max(0, ts - downTs);
            keyboardHoldSamples.push(hold);
          }
          // we do not send per-key rows; we aggregate locally
        } catch (err) {}
      }

      // If the element is removed from DOM, treat as tab/element closed
      const removalObserver = new MutationObserver(() => {
        if (!document.body.contains(el)) {
          log('video element removed from DOM - treat as tab_closed for this video session');
          // If playing, update cumulative play time
          if (playing && lastPlayTs) { cumulativePlayMs += (Date.now() - lastPlayTs); lastPlayTs = null; }
          playing = false;
          window.__vc_videoCaptureActive = false;
          flush('tab_closed');
          removalObserver.disconnect();
        }
      });
      removalObserver.observe(document, { childList: true, subtree: true });

      // start monitoring if video already playing
      try {
        if (!el.paused) {
          onPlay();
        }
      } catch(e) {}

      // Attach event listeners for play/pause/ended
      el.addEventListener('play', onPlay);
      el.addEventListener('pause', onPause);
      el.addEventListener('ended', onEnded);

      // Immediate attach ping row (lightweight) for debugging & traceability
      try {
        const attachPing = {
          ts_start: Date.now(),
          ts_end: Date.now(),
          video_session_id: sessionId || makeSessionId(),
          video_state: 'attach_ping',
          video_duration_sec: el.duration || 0,
          volume: el.volume || 0,
          cursor_path_length: 0,
          cursor_mean_speed: 0,
          cursor_entropy: 0,
          cursor_sample_count: 0,
          keyboard_event_count: 0,
          keyboard_hold_mean: 0,
          keyboard_dd_mean: 0,
          click_count: 0,
          scroll_count: 0,
          interaction_density: 0,
          pause_resume_rate: 0,
          is_tab_closed: false,
          config_version: (window.__vc_config_version || 1)
        };
        chrome.runtime.sendMessage({ type: 'videoCursorBatch', event: attachPing }, () => {});
        log('sent attach ping for video');
      } catch(e) { log('attach ping failed', e); }

    } catch (err) {
      log('attachToVideo error', err);
    }
  }

  // Scan doc, shadow roots, and try same-origin iframes
  function scanDocumentForVideos(doc) {
    try {
      const vids = Array.from(doc.getElementsByTagName ? doc.getElementsByTagName('video') : []);
      vids.forEach(attachToVideo);
      // Shadow roots (best-effort)
      const allElems = doc.querySelectorAll ? Array.from(doc.querySelectorAll('*')) : [];
      for (const el of allElems) {
        try {
          if (el.shadowRoot) {
            const sv = Array.from(el.shadowRoot.querySelectorAll ? el.shadowRoot.querySelectorAll('video') : []);
            sv.forEach(attachToVideo);
          }
        } catch(e){}
      }
    } catch(e) { log('scanDocumentForVideos error', e); }
  }

  function scanAllFrames() {
    try { scanDocumentForVideos(document); } catch(e){}
    try {
      const iframes = Array.from(document.getElementsByTagName('iframe'));
      for (const f of iframes) {
        try {
          const fdoc = f.contentDocument;
          if (fdoc) scanDocumentForVideos(fdoc);
        } catch(e) { /* cross-origin - content script should be injected into those frames separately (manifest all_frames:true) */ }
      }
    } catch(e){}
  }

  // Observe DOM for dynamic video insertion
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        try {
          if (n.nodeType === 1) {
            if (n.tagName && n.tagName.toLowerCase() === 'video') attachToVideo(n);
            else if (n.querySelectorAll) {
              const vids = n.querySelectorAll('video');
              vids.forEach(attachToVideo);
            }
            try { if (n.shadowRoot) { const sv = Array.from(n.shadowRoot.querySelectorAll('video')); sv.forEach(attachToVideo); } } catch(e){}
          }
        } catch(e){}
      }
    }
  });
  mo.observe(document, { childList: true, subtree: true });

  // Initial scan and periodic rescan
  try { scanAllFrames(); log('initial scan completed'); } catch(e) { log('initial scan error', e); }
  setInterval(() => { try { scanAllFrames(); } catch(e){} }, 5000);

  // Send tab_closed marker on visibility/pagehide
  window.addEventListener('visibilitychange', () => {
    try {
      if (document.visibilityState === 'hidden') {
        chrome.runtime.sendMessage({ type: 'videoFlushAll', ts: Date.now() });
        // Also send tab_closed snapshot (best-effort)
        chrome.runtime.sendMessage({ type: 'videoCursorBatch', event: { ts_start: Date.now(), ts_end: Date.now(), video_session_id: makeSessionId(), video_state: 'tab_closed', video_duration_sec: 0, volume: 0, cursor_path_length: 0, cursor_mean_speed: 0, cursor_entropy: 0, cursor_sample_count: 0, keyboard_event_count: 0, keyboard_hold_mean: 0, keyboard_dd_mean: 0, click_count: 0, scroll_count: 0, interaction_density: 0, pause_resume_rate: 0, is_tab_closed: true, config_version: (window.__vc_config_version || 1) } }, () => {});
      }
    } catch(e){}
  });
  window.addEventListener('pagehide', () => {
    try {
      chrome.runtime.sendMessage({ type: 'videoFlushAll', ts: Date.now() });
      chrome.runtime.sendMessage({ type: 'videoCursorBatch', event: { ts_start: Date.now(), ts_end: Date.now(), video_session_id: makeSessionId(), video_state: 'tab_closed', video_duration_sec: 0, volume: 0, cursor_path_length: 0, cursor_mean_speed: 0, cursor_entropy: 0, cursor_sample_count: 0, keyboard_event_count: 0, keyboard_hold_mean: 0, keyboard_dd_mean: 0, click_count: 0, scroll_count: 0, interaction_density: 0, pause_resume_rate: 0, is_tab_closed: true, config_version: (window.__vc_config_version || 1) } }, () => {});
    } catch(e){}
  });
})();