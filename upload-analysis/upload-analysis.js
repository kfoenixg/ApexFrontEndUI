(function(){
  // ---------- Config & helpers ----------
  const BASE = window.location.origin.startsWith('file') ? 'http://localhost:3000' : '';
  const API = {
    admins:           `${BASE}/api/mock-lookups/administrators`,
    engagements:      `${BASE}/api/mock-lookups/engagements`,
    routines:         `${BASE}/api/system/routines`,
    detectionStart:   `${BASE}/api/detection/start`,
    detectionStatus:  (jobId) => `${BASE}/api/detection/${encodeURIComponent(jobId)}/status`,
  };

  const qs  = (s, el=document) => el.querySelector(s);
  const qsa = (s, el=document) => [...el.querySelectorAll(s)];
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }
  async function postJSON(url, body) {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ---------- Redirect hard refresh back to index ----------
  try {
    const nav = performance.getEntriesByType && performance.getEntriesByType('navigation');
    const entry = nav && nav[0];
    if (entry && entry.type === 'reload') {
      window.location.replace('../index.html');
    }
  } catch {}

  // ---------- Report helpers ----------
  function collectAllReportDefs(routines) {
    const map = new Map();
    routines.forEach(r => {
      (r.required_files || []).forEach(f => {
        if (!map.has(f.key)) map.set(f.key, f);
      });
    });
    return map;
  }

  function mergeRequiredReports(routines, selectedIds) {
    const required = new Map();
    routines
      .filter(r => selectedIds.size === 0 || selectedIds.has(r.id))
      .forEach(r => {
        (r.required_files || []).forEach(f => {
          if (f.required) required.set(f.key, f);
        });
      });
    return [...required.values()];
  }

  // ---------- Renderers ----------
  function renderRows(el, reports) {
    if (!el) return;
    el.innerHTML = ''; // rows only (header is in HTML)

    reports.forEach(rep => {
      el.insertAdjacentHTML('beforeend', `
        <div class="row" role="row" data-report-key="${rep.key}">
          <div>${rep.human_name}</div>
          <div style="text-align:center"><span class="badge neutral" data-cell="located">—</span></div>
          <div style="text-align:center"><span class="badge neutral" data-cell="mapped">—</span></div>
        </div>
      `);
    });
  }

  function setCellState(row, kind /* 'located'|'mapped' */, value /* 'yes'|'no'|'pending' */) {
    const cell = row?.querySelector(`.badge[data-cell="${kind}"]`);
    if (!cell) return;
    cell.classList.remove('neutral','success','fail');
    let txt = '—';
    if (value === 'yes') { cell.classList.add('success'); txt = 'Yes'; }
    else if (value === 'no') { cell.classList.add('fail'); txt = 'No'; }
    else { cell.classList.add('neutral'); txt = '—'; }
    cell.textContent = txt;
    cell.setAttribute('aria-label', txt);
  }

  function renderMiniHeader(admins, engagements) {
    let adminId = null, engagementId = null;

    try {
      engagementId = sessionStorage.getItem('apex-engagement-id') || null;
      adminId      = sessionStorage.getItem('apex-admin-id') || null;
    } catch {}

    if (!adminId || !engagementId) {
      try {
        const raw = localStorage.getItem('apex-dev-config');
        if (raw) {
          const cfg = JSON.parse(raw);
          adminId      = adminId      || cfg?.adminId || null;
          engagementId = engagementId || cfg?.engagementId || null;
        }
      } catch {}
    }

    const eng = engagements.find(e => e.id === engagementId);
    const resolvedAdminId = adminId || eng?.administrator_id;
    const admin = admins.find(a => a.id === resolvedAdminId);

    const a = qs('#mini-admin strong');
    const e = qs('#mini-engagement strong');
    const p = qs('#mini-period strong');

    if (a) a.textContent = admin ? admin.name : '—';
    if (e) e.textContent = eng ? eng.name : '—';
    if (p) p.textContent = eng?.period_end ?? '—';
  }

  // ---------- Loader canvas (RGB spiral) ----------
  function initLoaderCanvas() {
    const loader = document.getElementById('ua-loader');   // overlay div
    const canvas = document.getElementById('mainCanvas');  // the only canvas now
    if (!loader || !canvas) return;

    // ensure it's visible (in case any earlier CSS/JS hid it)
    loader.style.display = 'flex';

    const ctx = canvas.getContext('2d');

    function resize() {
      // Use the canvas' CSS box as the sizing source
      const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const cssW = canvas.clientWidth || 140;
      const cssH = canvas.clientHeight || 90;
      canvas.width  = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
    }
    window.addEventListener('resize', resize, { passive: true });
    resize();

    function frame(ms) {
      const t = ms * 0.001; // seconds
      const w = canvas.width, h = canvas.height;
      const cx = w / 2, cy = h / 2;

      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'lighter';

      const base = Math.min(w, h);
      const radius = base * 0.42;
      const thickness = base * 0.06;
      const count = 70;

      for (let i = 0; i < count; i++) {
        // reverse spin
        const a = i * 0.17 - t * 1.0;
        const r = radius * (0.35 + 0.65 * (i / count));
        const ex = 1.0, ey = 0.55 + 0.1 * Math.sin(t * 0.8);

        const x = cx + Math.cos(a) * r * ex;
        const y = cy + Math.sin(a) * r * ey;

        const s = (thickness * (0.35 + 0.65 * Math.sin(t * 2 + i))) * (0.6 + (i / count) * 0.6);
        const hue = (i * 9 + t * 90) % 360;

        ctx.fillStyle = `hsla(${hue}, 85%, 60%, 0.65)`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.5, s * 0.35), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }



  // ---------- Main ----------
  (async function init(){
    const rowsEl   = qs('#ua-rows');
    const progress = qs('#analysis-progress');
    const nextBtn  = qs('#ua-next');
    if (!rowsEl) return;

    // Continue stays disabled until orchestrator finishes
    if (nextBtn) nextBtn.disabled = true;

    initLoaderCanvas();

    console.group('[UA] Upload Analysis init');

    // Load catalogs
    console.log('Loading catalogs…');
    const [admins, engagements, routines] = await Promise.all([
      fetchJSON(API.admins),
      fetchJSON(API.engagements),
      fetchJSON(API.routines),
    ]);
    console.log('Catalogs:', { admins: admins.length, engagements: engagements.length, routines: routines.length });

    renderMiniHeader(admins, engagements);

    // Build lookup for mapping selected keys -> defs
    const allReportMap = collectAllReportDefs(routines);

    // Preferred explicit report keys from previous page
    let pickedReportKeys = [];
    try {
      const raw = sessionStorage.getItem('apex-report-keys');
      if (raw) pickedReportKeys = JSON.parse(raw) || [];
    } catch {}

    let reportsToShow = [];
    if (pickedReportKeys && pickedReportKeys.length) {
      reportsToShow = pickedReportKeys.map(k => allReportMap.get(k)).filter(Boolean);
    } else {
      let selectedRoutineIds = new Set();
      try {
        const rawSel = sessionStorage.getItem('apex-selected-routine-ids');
        const arrSel = rawSel ? JSON.parse(rawSel) : [];
        selectedRoutineIds = new Set(arrSel || []);
      } catch {}
      if (selectedRoutineIds.size === 0) {
        try {
          const rawDev = localStorage.getItem('apex-dev-config');
          if (rawDev) {
            const cfg = JSON.parse(rawDev);
            const arr = (cfg?.selectedRoutineIds?.length ? cfg.selectedRoutineIds : cfg?.amapRoutineIds) || [];
            selectedRoutineIds = new Set(arr);
          }
        } catch {}
      }
      reportsToShow = mergeRequiredReports(routines, selectedRoutineIds);
      pickedReportKeys = reportsToShow.map(r => r.key); // ensure we pass something to backend
    }

    console.log('Reports to show:', reportsToShow.map(r => r.key));
    renderRows(rowsEl, reportsToShow);

    // --- Seed GV reports (single source of truth) ---
    window.APEX.setReports(
      reportsToShow.map(r => ({
        reportKey: r.key,
        reportName: r.human_name || r.key,
        fieldsMapped: 'pending',
        attributesMapped: 'pending'
      }))
    );


    // Get jobId; defensively (re)start orchestrator (idempotent)
    const jobId = sessionStorage.getItem('apex-job-id');
    if (!jobId) {
      if (progress) progress.textContent = 'No job found';
      console.warn('No apex-job-id in sessionStorage; cannot start detection');
      console.groupEnd();
      return;
    }

    // Try idempotent start (ok if already started)
    try {
      console.log('POST /api/detection/start', { jobId, reportKeys: pickedReportKeys });
      await postJSON(API.detectionStart, {
        jobId,
        reportKeys: pickedReportKeys,
        engagementId: sessionStorage.getItem('apex-engagement-id') || null,
        adminId: sessionStorage.getItem('apex-admin-id') || null,
        routineCodes: [] // optional here
      });
      console.log('Detection start: OK');
    } catch (e) {
      console.warn('detectionStart failed (will still poll):', e);
    }

    // Poll status and paint Yes/No
    let timer = null;
    const poll = async () => {
      try {
        const url = API.detectionStatus(jobId);
        const resp = await fetchJSON(url);

        const total = resp.progress?.total ?? reportsToShow.length;
        const done  = resp.progress?.done ?? 0;
        if (progress) progress.textContent = `Analyzing ${Math.min(done, total)} of ${total}…`;

        (resp.reports || []).forEach(rep => {
          const row = rowsEl.querySelector(`.row[data-report-key="${rep.reportKey}"]`);
          if (!row) return;

          // Keep UI in sync (data-cell names remain 'located' & 'mapped')
          setCellState(row, 'located', rep.fieldsMapped     || 'pending');     // UI "Fields Mapped"
          setCellState(row, 'mapped',  rep.attributesMapped || 'pending');     // UI "Attributes Mapped"

          // Sync GV
          window.APEX.updateReport(rep.reportKey, {
            fieldsMapped:     rep.fieldsMapped     || 'pending',
            attributesMapped: rep.attributesMapped || 'pending'
          });

        });

        // When orchestrator is done, unlock the button and hide loader
        if (resp.overall === 'success' || resp.overall === 'failed') {
          if (progress) {
            progress.textContent =
              resp.overall === 'success'
                ? `Analysis complete — ${total} scanned`
                : `Analysis ended — ${done}/${total}`;
          }

          console.log('Detection finished:', resp.overall, `${done}/${total}`);

          clearInterval(timer);
          timer = null;

          const loader = document.getElementById('ua-loader');
          if (loader) loader.style.display = 'none';

          // Enable Continue only after detection completes
          if (nextBtn) nextBtn.disabled = false;

          try { window.dispatchEvent(new Event('analysis:complete')); } catch {}
          console.groupEnd();
        }

      } catch (e) {
        console.warn('poll error:', e);
        // keep polling; transient errors happen
      }
    };

    console.log('Start polling…');
    await poll();
    timer = setInterval(poll, 600);

    // Controls
    const backBtn = qs('#ua-back');
    if (backBtn) backBtn.onclick = () => window.location.href = '../index.html';

    if (nextBtn) {
      nextBtn.onclick = () => {
        const results = window.APEX.getReports();
        console.log('Continue clicked. Results:', results);
        // Use centralized router (fields → attributes → complete)
        window.APEX.routeNext();
      };
    }

  })();
})();