// background.js
// Core storage, sessionization, deterministic aggregation, export, recompute and ML hook.
//
// Invariants enforced here:
// - Sessionization (per-modality) with INACTIVITY_THRESHOLD (ms).
// - Aggregation only when SUM(active_dt_ms) >= aggregation_window_ms within a single session.
// - No cross-session aggregation.
// - Raw rows stored with session_id, is_session_start, is_session_end, active_dt_ms, included_in_agg, agg_window_id.
// - Video plays own capture and keyboard/mouse raw capture is suppressed while video is playing.

const STORAGE_KEYS = {
  KEYBOARD_RAW: 'keyboard_raw',
  MOUSE_RAW: 'mouse_raw',
  VIDEO_RAW: 'video_raw',
  KEYBOARD_AGG: 'keyboard_agg',
  MOUSE_AGG: 'mouse_agg',
  CONFIG_LOG: 'config_log',
  CONFIG: 'config',
  AGG_COUNTER: 'agg_counter'
};

const DEFAULT_CONFIG = {
  config_version: 1,
  aggregation_window_ms: 10000, // 10s for LSTM windows
  nudge_interval_ms: 30 * 60 * 1000, // 30 mins default
  pause_threshold_ms: 2000,
  inactivity_threshold_ms: 30 * 1000,
  cold_start_threshold_ms: 24 * 60 * 60 * 1000, // 24 hours
  bridge_url: 'http://localhost:5000'
};

let CONFIG = Object.assign({}, DEFAULT_CONFIG);

// init config and counters
(async function initConfig() {
  const s = await chrome.storage.local.get(['config', 'config_log', STORAGE_KEYS.AGG_COUNTER]);
  if (s.config) CONFIG = Object.assign({}, DEFAULT_CONFIG, s.config);
  else {
    await chrome.storage.local.set({ config: CONFIG });
    await appendConfigLog(CONFIG);
  }
  if (!s[STORAGE_KEYS.AGG_COUNTER]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.AGG_COUNTER]: 0 });
  }
})();

async function appendConfigLog(cfg) {
  const item = { config_version: cfg.config_version, ts: Date.now(), aggregation_window_ms: cfg.aggregation_window_ms, nudge_interval_ms: cfg.nudge_interval_ms, pause_threshold_ms: cfg.pause_threshold_ms, inactivity_threshold_ms: cfg.inactivity_threshold_ms };
  const s = await chrome.storage.local.get(['config_log']);
  const arr = s.config_log || [];
  arr.push(item);
  await chrome.storage.local.set({ config_log: arr });
}

function makeSessionId(prefix = 'sess') {
  return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}

async function appendRows(key, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return;
  const s = await chrome.storage.local.get([key]);
  const arr = s[key] || [];
  arr.push(...rows);
  // bound storage
  if (arr.length > 100000) arr.splice(0, arr.length - 80000);
  await chrome.storage.local.set({ [key]: arr });
}
async function appendRow(key, row) { await appendRows(key, [row]); }

let modalityState = {
  keyboard: { lastTs: null, sessionId: null, sessionStartTs: null, prevKeydownTs: null, prevKeyupTs: null, lstmBuffer: [] },
  mouse: { lastTs: null, sessionId: null, sessionStartTs: null, prevMoveTs: null },
  lastNudgeTs: 0,
  currentNudgeMultiplier: 1,
  lastPredictions: { keyboard: 0.5, mouse: 0.5 }
};

async function loadState() {
  const s = await chrome.storage.local.get(['modality_state']);
  if (s.modality_state) {
    modalityState = s.modality_state;
  }
}

async function saveState() {
  await chrome.storage.local.set({ modality_state: modalityState });
}

// Track which tabs have active video sessions to coordinate cross-frame suppression
const activeVideoTabs = new Set();

async function loadConfig() {
  const s = await chrome.storage.local.get(['config']);
  if (s.config) { CONFIG = Object.assign({}, DEFAULT_CONFIG, s.config); }
  return CONFIG;
}
async function updateConfig(newCfgPartial) {
  await loadConfig();
  const newCfg = Object.assign({}, CONFIG, newCfgPartial);
  newCfg.config_version = (CONFIG.config_version || 1) + 1;
  CONFIG = newCfg;
  await chrome.storage.local.set({ config: CONFIG });
  await appendConfigLog(CONFIG);
}

async function markRawRowsWithAgg(key, rowIndices, aggWindowId) {
  const s = await chrome.storage.local.get([key]);
  const arr = s[key] || [];
  for (const idx of rowIndices) {
    if (arr[idx]) {
      arr[idx].included_in_agg = true;
      arr[idx].agg_window_id = aggWindowId;
      arr[idx].config_version = CONFIG.config_version;
    }
  }
  await chrome.storage.local.set({ [key]: arr });
}

function objectsToCsv(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const keys = Array.from(arr.reduce((s, o) => { if (o && typeof o === 'object') Object.keys(o).forEach(k => s.add(k)); return s; }, new Set()));
  const esc = v => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const lines = [];
  lines.push(keys.join(','));
  for (const o of arr) lines.push(keys.map(k => esc(o[k])).join(','));
  return lines.join('\n');
}

// Message handling and ingest
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async function () {
    if (!msg || !msg.type) return;
    await loadConfig();
    await loadState();

    if (msg.type === 'keyboardEventBatch' && Array.isArray(msg.events)) {
      const events = msg.events.slice().sort((a, b) => a.ts - b.ts);
      const rowsToAppend = [];
      const state = modalityState.keyboard;
      for (const e of events) {
        const ts = Number(e.ts) || Date.now();
        let isSessionStart = false;
        let active_dt_ms = 0;
        if (!state.lastTs || (ts - state.lastTs) > CONFIG.inactivity_threshold_ms) {
          isSessionStart = true;
          state.sessionId = makeSessionId('kbd');
          state.sessionStartTs = ts;
          state.prevKeydownTs = null;
          state.prevKeyupTs = null;
          active_dt_ms = 0;
        } else {
          active_dt_ms = ts - state.lastTs;
        }
        state.lastTs = ts;

        let down_down_ms = 0, up_down_ms = 0;
        if (e.event_type === 'keydown') {
          down_down_ms = (!isSessionStart && state.prevKeydownTs) ? (ts - state.prevKeydownTs) : 0;
          state.prevKeydownTs = ts;
        } else if (e.event_type === 'keyup') {
          up_down_ms = (!isSessionStart && state.prevKeyupTs) ? (ts - state.prevKeyupTs) : 0;
          state.prevKeyupTs = ts;
        }

        const hold_ms = (typeof e.hold_ms === 'number') ? e.hold_ms : 0;

        const row = {
          ts,
          session_id: state.sessionId,
          event_type: e.event_type,
          hold_ms,
          down_down_ms,
          up_down_ms,
          active_dt_ms,
          is_session_start: !!isSessionStart,
          is_session_end: false,
          included_in_agg: false,
          agg_window_id: null,
          config_version: CONFIG.config_version
        };
        rowsToAppend.push(row);
      }
      await appendRows(STORAGE_KEYS.KEYBOARD_RAW, rowsToAppend);
      await attemptAggregations('keyboard');
      await saveState();
    }

    else if (msg.type === 'mouseEventBatch' && Array.isArray(msg.events)) {
      const events = msg.events.slice().sort((a, b) => a.ts - b.ts);
      const rowsToAppend = [];
      const state = modalityState.mouse;
      for (const e of events) {
        const ts = Number(e.ts) || Date.now();
        let isSessionStart = false, active_dt_ms = 0;
        if (!state.lastTs || (ts - state.lastTs) > CONFIG.inactivity_threshold_ms) {
          isSessionStart = true;
          state.sessionId = makeSessionId('mse');
          state.sessionStartTs = ts;
          state.prevMoveTs = null;
          active_dt_ms = 0;
        } else {
          active_dt_ms = ts - state.lastTs;
        }
        const dt_ms = isSessionStart ? 0 : (state.prevMoveTs ? ts - state.prevMoveTs : active_dt_ms);
        if (e.event_type === 'move') state.prevMoveTs = ts;
        state.lastTs = ts;

        const row = {
          ts,
          session_id: state.sessionId,
          event_type: e.event_type,
          x: (typeof e.x === 'number' ? e.x : null),
          y: (typeof e.y === 'number' ? e.y : null),
          dt_ms,
          is_session_start: !!isSessionStart,
          is_session_end: false,
          included_in_agg: false,
          agg_window_id: null,
          config_version: CONFIG.config_version
        };
        rowsToAppend.push(row);
      }
      await appendRows(STORAGE_KEYS.MOUSE_RAW, rowsToAppend);
      await attemptAggregations('mouse');
      await saveState();
    }

    else if (msg.type === 'videoCursorBatch' && msg.event) {
      const payload = Object.assign({}, msg.event);
      const tabId = sender.tab ? sender.tab.id : null;
      payload.tab_id = tabId;
      payload.ts_start = payload.ts_start || payload.ts || Date.now();
      payload.ts_end = payload.ts_end || (payload.ts || Date.now());
      payload.video_session_id = payload.video_session_id || makeSessionId('vid');
      payload.config_version = CONFIG.config_version;

      // Coordination: if video is playing/checkpointing, tell the whole tab to suppress raw kbd/mouse
      if (tabId && (payload.video_state === 'playing' || payload.video_state === 'play' || payload.video_state === 'playing_checkpoint')) {
        if (!activeVideoTabs.has(tabId)) {
          activeVideoTabs.add(tabId);
          chrome.tabs.sendMessage(tabId, { type: 'suppressRaw', active: true }).catch(() => { });
        }
      } else if (tabId && (payload.video_state === 'pause' || payload.video_state === 'ended' || payload.video_state === 'tab_closed')) {
        // Only remove if this was the last active video in the tab (simplified for now: assume one video per tab or global pause)
        activeVideoTabs.delete(tabId);
        chrome.tabs.sendMessage(tabId, { type: 'suppressRaw', active: false }).catch(() => { });
      }

      // Keep video row succinct: we store summary stats not raw samples
      if (payload.samples) payload.cursor_sample_count = payload.cursor_sample_count || payload.samples.length;
      delete payload.samples;
      try {
        console.log('BG: received videoCursorBatch', { preview: { video_session_id: payload.video_session_id, state: payload.video_state, cursor_sample_count: payload.cursor_sample_count }, fromTab: payload.tab_id });
      } catch (e) { }
      await appendRow(STORAGE_KEYS.VIDEO_RAW, payload);
    }

    else if (msg.type === 'videoFlushAll') {
      try { console.log('BG: received videoFlushAll marker from tab', sender && sender.tab ? sender.tab.id : null); } catch (e) { }
      const marker = { ts: msg.ts || Date.now(), event: 'page_hidden', tab_id: sender.tab ? sender.tab.id : null, config_version: CONFIG.config_version };
      await appendRow(STORAGE_KEYS.VIDEO_RAW, marker);
    }

    else if (msg.type === 'requestRecompute') {
      const res = await recomputeAllAggregatesAndCompare();
      chrome.runtime.sendMessage({ type: 'recomputeResult', result: res });
    }

    else if (msg.type === 'updateConfig' && msg.newConfig) {
      await updateConfig(msg.newConfig);
      chrome.runtime.sendMessage({ type: 'configUpdated', config: CONFIG });
    }

    else if (msg.type === 'loadConfig') {
      await loadConfig();
      sendResponse({ ok: true, config: CONFIG });
      return;
    }

    else if (msg.type === 'exportAll') {
      const data = await exportAllCsvObjects();
      sendResponse({ ok: true, data });
      return;
    }

    else if (msg.type === 'recomputeAndCompare') {
      const result = await recomputeAllAggregatesAndCompare();
      sendResponse({ ok: true, result });
      return;
    }

    else if (msg.type === 'storeCentroids' && msg.kind && msg.centroids) {
      const key = (msg.kind === 'keyboard') ? 'kmeans_keyboard' : 'kmeans_mouse';
      await chrome.storage.local.set({ [key]: msg.centroids });
      sendResponse({ ok: true });
      return;
    }

    // ensure sendResponse semantics for async handlers
  })();
  return true;
});

// ML INTERFACE CALLS
async function runKeyboardInference(feat, state, rowCount) {
  const isColdStart = (Date.now() - (state.sessionStartTs || Date.now())) < CONFIG.cold_start_threshold_ms;

  if (isColdStart) {
    try {
      const resp = await fetch(`${CONFIG.bridge_url}/predict/keyboard_clustering`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mean_hold_ms: feat.mean_hold_ms,
          mean_dd_ms: feat.mean_dd_ms,
          mean_ud_ms: feat.mean_ud_ms,
          hold_cv: feat.hold_cv,
          dd_cv: feat.dd_cv,
          latency_spike_count_Flag: feat.latency_spike_count > 0 ? 1 : 0
        })
      });
      const res = await resp.json();
      modalityState.lastPredictions.keyboard = res.cluster; // 0 or 1 etc
      await saveState();
    } catch (e) {
      console.error('Keyboard Clustering Error:', e);
      modalityState.lastPredictions.keyboard = 1; // Fallback to safe prediction to avoid false nudges
      await saveState();
    }
  } else {
    // Sequential LSTM
    const lstmFeat = [
      feat.mean_hold_ms, feat.hold_std, feat.mean_dd_ms, feat.dd_std,
      feat.mean_ud_ms, feat.hold_std, // Placeholder for UD_std
      feat.latency_spike_count > 0 ? 1 : 0,
      (rowCount / (CONFIG.aggregation_window_ms / 1000)) || 0, // typing rate
      rowCount // keystroke count
    ];
    state.lstmBuffer.push(lstmFeat);
    if (state.lstmBuffer.length > 2) state.lstmBuffer.shift();

    if (state.lstmBuffer.length === 2) {
      try {
        const resp = await fetch(`${CONFIG.bridge_url}/predict/keyboard_lstm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sequence: state.lstmBuffer })
        });
        const res = await resp.json();
        modalityState.lastPredictions.keyboard = res.probability_expert;
        await saveState();
      } catch (e) {
        console.error('Keyboard LSTM Error:', e);
        modalityState.lastPredictions.keyboard = 0.5;
        await saveState();
      }
    } else {
      await saveState();
    }
  }
}

async function runMouseInference(feat) {
  try {
    const resp = await fetch(`${CONFIG.bridge_url}/predict/cursor_xgb`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mean_speed: feat.mean_speed,
        speed_std: feat.speed_std,
        pause_fraction: feat.pause_fraction,
        path_entropy: feat.path_entropy,
        distance_rate: feat.total_distance / (CONFIG.aggregation_window_ms / 1000),
        click_rate: feat.total_clicks / (CONFIG.aggregation_window_ms / 1000),
        scroll_rate: 0, // simplified
        movement_density: feat.movement_density,
        jitter_index: feat.jitter_index
      })
    });
    const res = await resp.json();
    modalityState.lastPredictions.mouse = res.attention_score;
    await saveState();
  } catch (e) {
    console.error('Mouse Inference Error:', e);
    modalityState.lastPredictions.mouse = 0.5;
    await saveState();
  }
}

async function runVideoInference(payload) {
  // Video capture only, as requested.
  // We can add logic here if we ever want to analyze video state.
}

// NUDGING SYSTEM (Using Alarms instead of setInterval for MV3 durability)
chrome.alarms.create('nudgeCheck', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'nudgeCheck') {
    await loadConfig();
    await loadState();

    const now = Date.now();
    const baseInterval = CONFIG.nudge_interval_ms || (30 * 60 * 1000);
    const currentInterval = baseInterval * modalityState.currentNudgeMultiplier;

    if (modalityState.lastNudgeTs === 0) {
      modalityState.lastNudgeTs = now;
      await saveState();
    }

    if (now - modalityState.lastNudgeTs >= currentInterval) {
      const kScore = modalityState.lastPredictions.keyboard || 0.5;
      const mScore = modalityState.lastPredictions.mouse || 0.5;

      // Performance check: threshold < 0.4 indicates attention dip
      if (kScore < 0.4 || mScore < 0.4) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'icon128.png',
          title: 'Attention Nudge',
          message: 'Your attention metrics are decreasing. Please try to refocus.'
        });
        modalityState.currentNudgeMultiplier = 1; // 30*1 = 30 mins
      } else {
        // Good performance: slow down by adding 1 base interval to the multiplier
        modalityState.currentNudgeMultiplier = Math.min(5, modalityState.currentNudgeMultiplier + 1); // 1x, 2x, 3x, 4x, 5x
      }
      modalityState.lastNudgeTs = now;
      await saveState();
    }
  }
});

// AGGREGATION helpers (keyboard and mouse)
async function attemptAggregations(kind) {
  if (kind === 'keyboard') await keyboardAggregator();
  else if (kind === 'mouse') await mouseAggregator();
}

async function getNextAggWindowId() {
  const s = await chrome.storage.local.get([STORAGE_KEYS.AGG_COUNTER]);
  let c = s[STORAGE_KEYS.AGG_COUNTER] || 0;
  c += 1;
  await chrome.storage.local.set({ [STORAGE_KEYS.AGG_COUNTER]: c });
  return `agg_${c}`;
}

async function keyboardAggregator() {
  const s = await chrome.storage.local.get([STORAGE_KEYS.KEYBOARD_RAW, STORAGE_KEYS.KEYBOARD_AGG]);
  const raw = s[STORAGE_KEYS.KEYBOARD_RAW] || [];
  const aggArr = s[STORAGE_KEYS.KEYBOARD_AGG] || [];

  const bySession = {};
  raw.forEach((r, idx) => {
    if (!r.session_id) return;
    if (!bySession[r.session_id]) bySession[r.session_id] = [];
    bySession[r.session_id].push({ row: r, index: idx });
  });

  for (const sessionId of Object.keys(bySession)) {
    const rowsWithIdx = bySession[sessionId];
    let segment = [];
    let segmentIndices = [];
    let activeSum = 0;
    for (const item of rowsWithIdx) {
      const r = item.row;
      const idx = item.index;
      if (r.included_in_agg) {
        segment = []; segmentIndices = []; activeSum = 0; continue;
      }
      segment.push(r);
      segmentIndices.push(idx);
      activeSum += (r.active_dt_ms || 0);
      if (activeSum >= CONFIG.aggregation_window_ms) {
        const feat = computeKeyboardAggregateFeatures(segment);
        feat.agg_window_id = await getNextAggWindowId();
        feat.session_ids_used = [sessionId];
        feat.aggregation_window_ms = CONFIG.aggregation_window_ms;
        feat.config_version = CONFIG.config_version;
        feat.active_time_ms = Math.min(activeSum, CONFIG.aggregation_window_ms);
        aggArr.push(feat);
        await runKeyboardInference(feat, modalityState.keyboard, segmentIndices.length);
        await markRawRowsWithAgg(STORAGE_KEYS.KEYBOARD_RAW, segmentIndices, feat.agg_window_id);
        segment = []; segmentIndices = []; activeSum = 0;
      }
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.KEYBOARD_AGG]: aggArr });
}

function computeKeyboardAggregateFeatures(rows) {
  const numeric = rows.filter(r => r);
  const holdVals = numeric.filter(r => typeof r.hold_ms === 'number').map(r => r.hold_ms);
  const ddVals = numeric.filter(r => typeof r.down_down_ms === 'number').map(r => r.down_down_ms);
  const udVals = numeric.filter(r => typeof r.up_down_ms === 'number').map(r => r.up_down_ms);
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const std = arr => { if (!arr.length) return 0; const m = mean(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length); };
  const cv = arr => { const m = mean(arr); return m ? std(arr) / m : 0; };

  const mean_hold = mean(holdVals);
  const mean_dd = mean(ddVals);
  const mean_ud = mean(udVals);
  const sd_dd = Math.max(std(ddVals), 1e-6);

  // bursts
  const BURST_GAP_MS = 200;
  let burst_count = 0, burst_lengths = [];
  let current_burst = 0, lastTs = null;
  numeric.forEach(r => {
    if (lastTs === null || (r.active_dt_ms && r.active_dt_ms <= BURST_GAP_MS)) current_burst += 1;
    else { if (current_burst > 1) { burst_count++; burst_lengths.push(current_burst); } current_burst = 1; }
    lastTs = r.ts;
  });
  if (current_burst > 1) { burst_count++; burst_lengths.push(current_burst); }
  const burst_mean_length = burst_lengths.length ? (burst_lengths.reduce((a, b) => a + b, 0) / burst_lengths.length) : 0;

  const MICRO_LOW = 100, MICRO_HIGH = 500;
  const micro_count = numeric.filter(r => (r.active_dt_ms || 0) >= MICRO_LOW && (r.active_dt_ms || 0) <= MICRO_HIGH).length;
  const micro_pause_ratio = numeric.length ? micro_count / numeric.length : 0;
  const latency_spike_count = ddVals.filter(x => x > (mean_dd + 2 * sd_dd)).length;
  const pause_gap_count = ddVals.filter(x => x > CONFIG.pause_threshold_ms).length;

  return {
    mean_hold_ms: mean_hold,
    mean_dd_ms: mean_dd,
    mean_ud_ms: mean_ud,
    hold_std: std(holdVals),
    dd_std: sd_dd,
    hold_cv: cv(holdVals),
    dd_cv: cv(ddVals),
    burst_count,
    burst_mean_length,
    micro_pause_ratio,
    latency_spike_count,
    pause_gap_count
  };
}

async function mouseAggregator() {
  const s = await chrome.storage.local.get([STORAGE_KEYS.MOUSE_RAW, STORAGE_KEYS.MOUSE_AGG]);
  const raw = s[STORAGE_KEYS.MOUSE_RAW] || [];
  const aggArr = s[STORAGE_KEYS.MOUSE_AGG] || [];
  const bySession = {};
  raw.forEach((r, idx) => {
    if (!r.session_id) return;
    if (!bySession[r.session_id]) bySession[r.session_id] = [];
    bySession[r.session_id].push({ row: r, index: idx });
  });

  for (const sessionId of Object.keys(bySession)) {
    const rowsWithIdx = bySession[sessionId];
    let segment = [];
    let segmentIndices = [];
    let activeSum = 0;
    for (const item of rowsWithIdx) {
      const r = item.row, idx = item.index;
      if (r.included_in_agg) { segment = []; segmentIndices = []; activeSum = 0; continue; }
      segment.push(r); segmentIndices.push(idx);
      activeSum += (r.dt_ms || 0);
      if (activeSum >= CONFIG.aggregation_window_ms) {
        const feat = computeMouseAggregateFeatures(segment);
        feat.agg_window_id = await getNextAggWindowId();
        feat.session_ids_used = [sessionId];
        feat.aggregation_window_ms = CONFIG.aggregation_window_ms;
        feat.config_version = CONFIG.config_version;
        feat.active_time_ms = Math.min(activeSum, CONFIG.aggregation_window_ms);
        aggArr.push(feat);
        await runMouseInference(feat);
        await markRawRowsWithAgg(STORAGE_KEYS.MOUSE_RAW, segmentIndices, feat.agg_window_id);
        segment = []; segmentIndices = []; activeSum = 0;
      }
    }
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.MOUSE_AGG]: aggArr });
}

function computeMouseAggregateFeatures(rows) {
  const pos = rows.filter(r => typeof r.x === 'number' && typeof r.y === 'number');
  const total_distance = pos.reduce((sum, r, i) => { if (i === 0) return 0; const prev = pos[i - 1]; return sum + Math.hypot(r.x - prev.x, r.y - prev.y); }, 0);
  const speeds = [];
  for (let i = 1; i < pos.length; i++) {
    const dx = pos[i].x - pos[i - 1].x, dy = pos[i].y - pos[i - 1].y;
    const dt = Math.max(1, pos[i].ts - pos[i - 1].ts);
    speeds.push(Math.hypot(dx, dy) / (dt / 1000));
  }
  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const std = arr => arr.length ? Math.sqrt(arr.reduce((s, x) => s + (x - mean(arr)) * (x - mean(arr)), 0) / arr.length) : 0;
  const mean_speed = mean(speeds);
  const max_speed = speeds.length ? Math.max(...speeds) : 0;
  const speed_std = std(speeds);
  const jitter_index = speeds.length ? (speed_std / (mean_speed + 1e-8)) : 0;

  function pathEntropy(xs, ys, bins = 8) {
    if (xs.length < 2) return 0;
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const eps = 1e-9; const xRange = maxX - minX + eps; const yRange = maxY - minY + eps;
    const H = new Array(bins * bins).fill(0);
    for (let i = 0; i < xs.length; i++) {
      const xi = Math.min(bins - 1, Math.floor(((xs[i] - minX) / xRange) * bins));
      const yi = Math.min(bins - 1, Math.floor(((ys[i] - minY) / yRange) * bins));
      H[yi * bins + xi] += 1;
    }
    const p = H.filter(c => c > 0).map(c => c / xs.length);
    let ent = 0; for (const pr of p) ent -= pr * Math.log2(pr); return ent;
  }
  const xs = pos.map(p => p.x), ys = pos.map(p => p.y);
  const entropy = pathEntropy(xs, ys, 8);
  const active_time_ms = rows.reduce((s, r) => s + (r.dt_ms || 0), 0) || 1;
  const movement_density = total_distance / active_time_ms;
  const dts_sec = rows.map(r => (r.dt_ms || 0) / 1000); // snippet uses seconds
  const pause_fraction = dts_sec.length ? (dts_sec.filter(dt => dt > 0.3).length / (dts_sec.length + 1)) : 0;
  const total_clicks = rows.filter(r => r.event_type === 'click').length;
  const total_scrolls = rows.filter(r => r.event_type === 'scroll').length;

  return {
    total_distance,
    mean_speed,
    speed_std,
    distance_rate: total_distance / (active_time_ms / 1000),
    click_rate: total_clicks / (active_time_ms / 1000),
    scroll_rate: total_scrolls / (active_time_ms / 1000),
    path_entropy: entropy,
    movement_density,
    pause_fraction,
    jitter_index,
    total_clicks,
    total_scrolls
  };
}

// Export and recompute helpers
async function exportAllCsvObjects() {
  const s = await chrome.storage.local.get([STORAGE_KEYS.KEYBOARD_RAW, STORAGE_KEYS.MOUSE_RAW, STORAGE_KEYS.VIDEO_RAW, STORAGE_KEYS.KEYBOARD_AGG, STORAGE_KEYS.MOUSE_AGG, 'config_log']);
  return {
    keyboard_raw: s[STORAGE_KEYS.KEYBOARD_RAW] || [],
    mouse_raw: s[STORAGE_KEYS.MOUSE_RAW] || [],
    video_raw: s[STORAGE_KEYS.VIDEO_RAW] || [],
    keyboard_agg: s[STORAGE_KEYS.KEYBOARD_AGG] || [],
    mouse_agg: s[STORAGE_KEYS.MOUSE_AGG] || [],
    config_log: s['config_log'] || []
  };
}

async function recomputeAllAggregatesAndCompare() {
  const s = await chrome.storage.local.get([STORAGE_KEYS.KEYBOARD_RAW, STORAGE_KEYS.MOUSE_RAW, STORAGE_KEYS.KEYBOARD_AGG, STORAGE_KEYS.MOUSE_AGG]);
  const rawK = (s[STORAGE_KEYS.KEYBOARD_RAW] || []).map(r => Object.assign({}, r));
  const rawM = (s[STORAGE_KEYS.MOUSE_RAW] || []).map(r => Object.assign({}, r));
  const storedKAgg = s[STORAGE_KEYS.KEYBOARD_AGG] || [];
  const storedMAgg = s[STORAGE_KEYS.MOUSE_AGG] || [];

  function recomputeKeyboardAgg(rawRows) {
    const bySession = {};
    rawRows.forEach((r, idx) => { if (!r.session_id) return; if (!bySession[r.session_id]) bySession[r.session_id] = []; bySession[r.session_id].push({ row: r, index: idx }); });
    const recomputed = []; let localAggCounter = 0;
    for (const sessionId of Object.keys(bySession)) {
      const rowsWithIdx = bySession[sessionId];
      let segment = [], activeSum = 0;
      for (const item of rowsWithIdx) {
        const r = item.row;
        if (r.included_in_agg && r.agg_window_id) { segment = []; activeSum = 0; continue; }
        segment.push(r); activeSum += (r.active_dt_ms || 0);
        if (activeSum >= CONFIG.aggregation_window_ms) {
          const feat = computeKeyboardAggregateFeatures(segment);
          localAggCounter++;
          feat.agg_window_id = `recomp_${sessionId}_${localAggCounter}`;
          feat.session_ids_used = [sessionId];
          feat.aggregation_window_ms = CONFIG.aggregation_window_ms;
          feat.config_version = CONFIG.config_version;
          feat.active_time_ms = Math.min(activeSum, CONFIG.aggregation_window_ms);
          recomputed.push(feat);
          segment = []; activeSum = 0;
        }
      }
    }
    return recomputed;
  }

  function recomputeMouseAgg(rawRows) {
    const bySession = {};
    rawRows.forEach((r, idx) => { if (!r.session_id) return; if (!bySession[r.session_id]) bySession[r.session_id] = []; bySession[r.session_id].push({ row: r, index: idx }); });
    const recomputed = []; let localAggCounter = 0;
    for (const sessionId of Object.keys(bySession)) {
      const rowsWithIdx = bySession[sessionId];
      let segment = [], activeSum = 0;
      for (const item of rowsWithIdx) {
        const r = item.row;
        if (r.included_in_agg && r.agg_window_id) { segment = []; activeSum = 0; continue; }
        segment.push(r); activeSum += (r.dt_ms || 0);
        if (activeSum >= CONFIG.aggregation_window_ms) {
          const feat = computeMouseAggregateFeatures(segment);
          localAggCounter++;
          feat.agg_window_id = `recomp_${sessionId}_${localAggCounter}`;
          feat.session_ids_used = [sessionId];
          feat.aggregation_window_ms = CONFIG.aggregation_window_ms;
          feat.config_version = CONFIG.config_version;
          feat.active_time_ms = Math.min(activeSum, CONFIG.aggregation_window_ms);
          recomputed.push(feat);
          segment = []; activeSum = 0;
        }
      }
    }
    return recomputed;
  }

  const recomputedK = recomputeKeyboardAgg(rawK);
  const recomputedM = recomputeMouseAgg(rawM);

  function compareAggArrays(stored, recomputed) {
    const tol = 1e-6; const issues = [];
    if (stored.length !== recomputed.length) issues.push({ type: 'count_mismatch', stored_count: stored.length, recomputed_count: recomputed.length });
    const minLen = Math.min(stored.length, recomputed.length);
    for (let i = 0; i < minLen; i++) {
      const sA = stored[i], rA = recomputed[i];
      for (const k of Object.keys(rA)) {
        const aVal = sA[k], bVal = rA[k];
        if (typeof bVal === 'number') {
          const diff = Math.abs((aVal || 0) - bVal);
          if (diff > tol) issues.push({ type: 'value_mismatch', index: i, key: k, stored: aVal, recomputed: bVal, diff });
        } else {
          const sa = (aVal === undefined) ? null : aVal;
          const rb = (bVal === undefined) ? null : bVal;
          if (String(sa) !== String(rb) && k !== 'agg_window_id') issues.push({ type: 'value_mismatch', index: i, key: k, stored: sa, recomputed: rb });
        }
      }
    }
    return issues;
  }

  const keyboardIssues = compareAggArrays(storedKAgg, recomputedK);
  const mouseIssues = compareAggArrays(storedMAgg, recomputedM);
  return { keyboard: { stored_count: storedKAgg.length, recomputed_count: recomputedK.length, issues: keyboardIssues }, mouse: { stored_count: storedMAgg.length, recomputed_count: recomputedM.length, issues: mouseIssues } };
}