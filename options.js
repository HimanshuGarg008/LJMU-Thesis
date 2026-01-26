// options.js - Options UI, export, recompute, and centroid upload for ML hooks.
// Includes robust loadConfig (message with timeout then fallback to chrome.storage) and logging.

(function() {
  const aggregationWindowEl = document.getElementById('aggregation_window_ms');
  const pauseThresholdEl = document.getElementById('pause_threshold_ms');
  const nudgeIntervalEl = document.getElementById('nudge_interval_ms');
  const inactivityThresholdEl = document.getElementById('inactivity_threshold_ms');
  const saveBtn = document.getElementById('save');
  const statusEl = document.getElementById('status');
  const statsEl = document.getElementById('stats');
  const logEl = document.getElementById('log');

  const btnExportAll = document.getElementById('btnExportAll');
  const btnExportRaw = document.getElementById('btnExportRaw');
  const btnExportAgg = document.getElementById('btnExportAgg');
  const btnRecompute = document.getElementById('btnRecompute');
  const btnClear = document.getElementById('btnClear');
  const centroidsInput = document.getElementById('centroidsInput');
  const btnLoadCentroids = document.getElementById('btnLoadCentroids');

  function log(msg) {
    const t = new Date().toISOString();
    logEl.value = `[${t}] ${msg}\n` + logEl.value;
    console.log('Options:', msg);
  }

  async function loadConfig() {
    log('loadConfig() start');
    let got = null;
    try {
      got = await new Promise((resolve) => {
        let called = false;
        const timer = setTimeout(() => {
          if (!called) { called = true; resolve(null); }
        }, 800);
        try {
          chrome.runtime.sendMessage({ type: 'loadConfig' }, (resp) => {
            if (called) return;
            called = true; clearTimeout(timer);
            if (chrome.runtime.lastError) { console.warn('sendMessage loadConfig runtime.lastError:', chrome.runtime.lastError); resolve(null); }
            else resolve(resp);
          });
        } catch (err) {
          console.warn('sendMessage threw', err);
          if (!called) { called = true; clearTimeout(timer); resolve(null); }
        }
      });
    } catch (err) {
      console.warn('loadConfig message attempt failed', err);
      got = null;
    }

    if (got && got.ok && got.config) {
      try {
        const cfg = got.config;
        aggregationWindowEl.value = cfg.aggregation_window_ms;
        pauseThresholdEl.value = cfg.pause_threshold_ms;
        nudgeIntervalEl.value = cfg.nudge_interval_ms;
        inactivityThresholdEl.value = cfg.inactivity_threshold_ms;
        log('Loaded config from background via sendMessage');
        window.__vc_config_version = cfg.config_version || window.__vc_config_version;
        await refreshStats();
        return;
      } catch (err) {
        console.error('Error applying config from background', err);
        log('Error applying config from background: ' + err.message);
      }
    }

    try {
      const s = await chrome.storage.local.get(['config']);
      const c = s.config || {};
      aggregationWindowEl.value = c.aggregation_window_ms || 300000;
      pauseThresholdEl.value = c.pause_threshold_ms || 2000;
      nudgeIntervalEl.value = c.nudge_interval_ms || 600000;
      inactivityThresholdEl.value = c.inactivity_threshold_ms || 30000;
      log('Loaded config from chrome.storage.local fallback');
    } catch (err) {
      console.error('Failed to load config from storage', err);
      log('Failed to load config from storage: ' + (err.message || err));
    }
    await refreshStats();
  }

  async function saveConfig() {
    const newCfg = {
      aggregation_window_ms: Number(aggregationWindowEl.value),
      pause_threshold_ms: Number(pauseThresholdEl.value),
      nudge_interval_ms: Number(nudgeIntervalEl.value),
      inactivity_threshold_ms: Number(inactivityThresholdEl.value)
    };
    chrome.runtime.sendMessage({ type: 'updateConfig', newConfig: newCfg });
    statusEl.textContent = 'Saved';
    setTimeout(()=>statusEl.textContent='',2000);
    log('Config updated: ' + JSON.stringify(newCfg));
    await refreshStats();
  }
  saveBtn.addEventListener('click', saveConfig);

  async function refreshStats() {
    const keys = ['keyboard_raw','mouse_raw','video_raw','keyboard_agg','mouse_agg','config_log'];
    const s = await chrome.storage.local.get(keys);
    const parts = [];
    for (const k of keys) {
      parts.push(`<div><strong>${k}:</strong> ${(s[k]||[]).length} rows</div>`);
    }
    statsEl.innerHTML = parts.join('');
  }

  async function fetchAllData() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'exportAll' }, (resp) => {
        if (resp && resp.ok && resp.data) resolve(resp.data);
        else {
          chrome.storage.local.get(['keyboard_raw','mouse_raw','video_raw','keyboard_agg','mouse_agg','config_log'], (s) => {
            resolve({
              keyboard_raw: s.keyboard_raw || [],
              mouse_raw: s.mouse_raw || [],
              video_raw: s.video_raw || [],
              keyboard_agg: s.keyboard_agg || [],
              mouse_agg: s.mouse_agg || [],
              config_log: s.config_log || []
            });
          });
        }
      });
    });
  }

  function arrayToCsv(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return '';
    const keys = Array.from(arr.reduce((s, o) => { if (o && typeof o === 'object') Object.keys(o).forEach(k => s.add(k)); return s; }, new Set()));
    const esc = v => { if (v === null || v === undefined) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); if (/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"'; return s; };
    const lines = [keys.join(',')];
    for (const o of arr) lines.push(keys.map(k => esc(o[k])).join(','));
    return lines.join('\n');
  }

  async function downloadZipOfCSVs(mapOfArrays, filenamePrefix='behavior_capture_all') {
    const ts = new Date().toISOString().replace(/[:.]/g,'-');
    const filename = `${filenamePrefix}_${ts}.zip`;
    if (typeof JSZip === 'undefined') {
      for (const k of Object.keys(mapOfArrays)) {
        const csv = arrayToCsv(mapOfArrays[k]);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = `${k}_${ts}.csv`; document.body.appendChild(a); a.click();
        setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 2000);
        await new Promise(r=>setTimeout(r,250));
      }
      return;
    }
    const zip = new JSZip();
    for (const k of Object.keys(mapOfArrays)) {
      const csv = arrayToCsv(mapOfArrays[k]);
      zip.file(`${k}.csv`, csv);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 2000);
  }

  btnExportAll.addEventListener('click', async () => {
    const all = await fetchAllData();
    await downloadZipOfCSVs(all, 'behavior_capture_all');
    log('Exported all CSVs as zip');
  });
  btnExportRaw.addEventListener('click', async () => {
    const all = await fetchAllData();
    const rawOnly = { keyboard_raw: all.keyboard_raw, mouse_raw: all.mouse_raw, video_raw: all.video_raw, config_log: all.config_log };
    await downloadZipOfCSVs(rawOnly, 'behavior_capture_raw');
    log('Exported raw CSVs');
  });
  btnExportAgg.addEventListener('click', async () => {
    const all = await fetchAllData();
    const aggOnly = { keyboard_agg: all.keyboard_agg, mouse_agg: all.mouse_agg };
    await downloadZipOfCSVs(aggOnly, 'behavior_capture_agg');
    log('Exported aggregate CSVs');
  });

  btnRecompute.addEventListener('click', async () => {
    log('Starting recompute & compare...');
    chrome.runtime.sendMessage({ type: 'recomputeAndCompare' }, (resp) => {
      if (resp && resp.ok && resp.result) log('Recompute result: ' + JSON.stringify(resp.result, null, 2));
      else log('Recompute failed or no result returned');
    });
  });

  btnClear.addEventListener('click', async () => {
    if (!confirm('Clear ALL RAW and AGGREGATE data from storage? This cannot be undone.')) return;
    await chrome.storage.local.set({ keyboard_raw: [], mouse_raw: [], video_raw: [], keyboard_agg: [], mouse_agg: [], pending_lstm: [] });
    log('All data cleared');
    await refreshStats();
  });

  btnLoadCentroids.addEventListener('click', async () => {
    const file = centroidsInput.files[0];
    if (!file) { alert('Select a JSON file'); return; }
    try {
      const text = await file.text();
      const obj = JSON.parse(text);
      if (!obj.kind || !obj.centroids) { alert('Invalid centroid JSON. Provide { kind, centroids, featureNames }'); return; }
      chrome.runtime.sendMessage({ type: 'storeCentroids', kind: obj.kind, centroids: obj }, (resp) => {
        log('Centroids uploaded for ' + obj.kind);
      });
    } catch (err) {
      alert('Error parsing JSON: ' + err.message);
    }
  });

  (async function init() {
    try {
      await loadConfig();
      await refreshStats();
      const defaultKey = 'keyboard_agg';
      const ds = document.getElementById('datasetSelect');
      if (ds) ds.value = defaultKey;
      const data = await chrome.storage.local.get([defaultKey]);
      const arr = data && data[defaultKey] ? data[defaultKey] : [];
      // optional: show initial table (renderTable defined earlier in previous versions; omitted to keep options.js focused on control flow)
      log('Options initialized successfully');
    } catch (err) {
      console.error('Options init failed', err);
      log('Options init failed: ' + (err && err.message ? err.message : String(err)));
      try { await refreshStats(); } catch(e){}
    }
  })();
})();