/* script.js — Dev Mode + data fetch + rendering + Continue→Analysis wiring
   Talks to server.js endpoints:
   - GET /api/mock-lookups/administrators
   - GET /api/mock-lookups/engagements
   - GET /api/system/routines
*/


/* ===== APEX Global State (GV) — paste at TOP of script.js ===== */

(() => {
  const APEX_KEYS = {
    REPORTS:      'apex-reports',        // canonical report array
    STAGED:       'apex-staged-list',    // [{ name, size }]
    ENGAGEMENT:   'apex-engagement-id',
    ADMIN:        'apex-admin-id'
  };

  // Safe JSON helpers
  const read = (k, fb) => {
    try { const v = sessionStorage.getItem(k); return v ? JSON.parse(v) : fb; }
    catch { return fb; }
  };
  const write = (k, v) => {
    try { sessionStorage.setItem(k, JSON.stringify(v)); } catch {}
  };

  // Normalize a report object to our schema
  const normalizeReport = (r) => ({
    reportKey: String(r.reportKey ?? r.key ?? ''),
    reportName: String(r.reportName ?? r.human_name ?? r.key ?? ''),
    fieldsMapped: ['yes','no','pending'].includes(r.fieldsMapped) ? r.fieldsMapped : 'pending',
    attributesMapped: ['yes','no','pending'].includes(r.attributesMapped) ? r.attributesMapped : 'pending',
    selectedFile: r.selectedFile ?? null
  });

  const APEX = window.APEX || {};

  // ---- Core Reports API ----
  APEX.getReports = () => read(APEX_KEYS.REPORTS, []);

  APEX.setReports = (reports) => {
    const arr = Array.isArray(reports) ? reports.map(normalizeReport) : [];
    write(APEX_KEYS.REPORTS, arr);
    return arr;
  };

  APEX.updateReport = (reportKey, patch = {}) => {
    const key = String(reportKey ?? '');
    if (!key) return null;
    const arr = APEX.getReports();
    const i = arr.findIndex(r => r.reportKey === key);
    if (i === -1) return null;

    const merged = normalizeReport({ ...arr[i], ...patch, reportKey: key });
    arr[i] = merged;
    write(APEX_KEYS.REPORTS, arr);
    return merged;
  };

  // ---- Files API ----
  APEX.getStagedFiles = () => read(APEX_KEYS.STAGED, []);
  APEX.setStagedFiles = (files) => {
    const minimal = Array.isArray(files)
      ? files.map(f => ({ name: String(f.name || ''), size: Number(f.size) || 0 }))
      : [];
    write(APEX_KEYS.STAGED, minimal);
    return minimal;
  };

  // ---- Header / Context ----
  APEX.getHeader = () => ({
    engagementId: (() => { try { return sessionStorage.getItem(APEX_KEYS.ENGAGEMENT) || null; } catch { return null; } })(),
    adminId:      (() => { try { return sessionStorage.getItem(APEX_KEYS.ADMIN) || null; } catch { return null; } })()
  });

  // ---- Detection helpers ----
  APEX.isDetectionComplete = () => {
    const reps = APEX.getReports();
    return reps.length > 0 && reps.every(r =>
      r.fieldsMapped !== 'pending' && r.attributesMapped !== 'pending'
    );
  };

  // Strict router (fields → attributes → complete). Paths are relative to UA page.
  APEX.routeNext = () => {
    const detectionResults = APEX.getReports();
    if (!detectionResults.length) {
      alert('No reports selected. Please go back and select reports.');
      return;
    }
    const anyFieldsNo  = detectionResults.some(r => r.fieldsMapped === 'no');
    const allFieldsYes = detectionResults.every(r => r.fieldsMapped === 'yes');

    const anyAttrsNo   = detectionResults.some(r => r.attributesMapped === 'no');
    const allAttrsYes  = detectionResults.every(r => r.attributesMapped === 'yes');

    if (anyFieldsNo) {
      window.location.href = '../fieldSelector/fieldSelector.html';
      return;
    }
    if (allFieldsYes && anyAttrsNo) {
      window.location.href = '../attributeSelector/attributeSelector.html';
      return;
    }
    if (allFieldsYes && allAttrsYes) {
      window.location.href = '../processComplete/processComplete.html';
      return;
    }
    alert('Analysis still in progress. Please wait a moment and try again.');
  };

  // Expose on window
  window.APEX = APEX;
})();



// -------- Base / API --------
const BASE = window.location.origin.startsWith('file') ? 'http://localhost:3000' : '';

const API = {
  admins:       `${BASE}/api/mock-lookups/administrators`,
  engagements:  `${BASE}/api/mock-lookups/engagements`,
  routines:     `${BASE}/api/system/routines`,
  // NEW
  upload:       `${BASE}/api/upload`,
  jobs:         `${BASE}/api/jobs`,
  detectionStart:`${BASE}/api/detection/start`
};



// -------- State --------
const state = {
  adminOptions: [],
  engagements: [],
  allRoutines: [],
  adminId: null,
  engagementId: null,

  amapRoutineIds: new Set(),      // routines AMAP says are required/selected
  selectedRoutineIds: new Set(),  // subset user will run now

  stagedFiles: [],                // File[] (browser File objects)
};

// -------- Utilities --------
const qs  = (sel, el=document) => el.querySelector(sel);
const qsa = (sel, el=document) => [...el.querySelectorAll(sel)];
const fmtBytes = (b) => {
  if (!Number.isFinite(b) || b <= 0) return '—';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
};

// --- Helpers to read selections for the pre-upload metadata ---
function getCheckedReportKeys() {
  const inputs = qsa('#report-list input[type="checkbox"][data-report-key]');
  return inputs.filter(i => i.checked).map(i => i.getAttribute('data-report-key'));
}

function getSelectedRoutineCodes() {
  const byId = new Map(state.allRoutines.map(r => [r.id, r]));
  const codes = [];
  state.selectedRoutineIds.forEach(id => {
    const r = byId.get(id);
    if (r && r.code) codes.push(r.code);
  });
  return codes;
}


function saveDevConfig() {
  try {
    localStorage.setItem('apex-dev-config', JSON.stringify({
      adminId: state.adminId,
      engagementId: state.engagementId,
      amapRoutineIds: [...state.amapRoutineIds],
      selectedRoutineIds: [...state.selectedRoutineIds],
    }));
  } catch {}
}
function loadDevConfig() {
  try {
    const raw = localStorage.getItem('apex-dev-config');
    if (!raw) return;
    const cfg = JSON.parse(raw);
    state.adminId = cfg.adminId || null;
    state.engagementId = cfg.engagementId || null;
    state.amapRoutineIds = new Set(cfg.amapRoutineIds || []);
    state.selectedRoutineIds = new Set(cfg.selectedRoutineIds || []);
  } catch {}
}

// -------- Fetch data --------

// --- Jobs + pre-upload (non-blocking) ---
async function createJob(mode = 'success') {
  try {
    const r = await fetch(API.jobs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    if (!r.ok) throw new Error(`jobs POST ${r.status}`);
    const data = await r.json();
    return data?.jobId || null;
  } catch (e) {
    console.warn('createJob failed:', e);
    return null;
  }
}

async function preUploadToJob(jobId, files, meta = {}) {
  try {
    const fd = new FormData();
    if (jobId) fd.append('jobId', jobId);
    if (meta.engagementId) fd.append('engagementId', meta.engagementId);
    if (Array.isArray(meta.routineCodes)) fd.append('routineCodes', JSON.stringify(meta.routineCodes));
    if (Array.isArray(meta.reportKeys))   fd.append('reportKeys',   JSON.stringify(meta.reportKeys));
    (files || []).forEach(f => fd.append('files', f, f.name));

    const r = await fetch(API.upload, { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`upload HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn('preUploadToJob failed:', e);
    return { ok: false, error: String(e?.message || e) };
  }
}



async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function loadCatalogs() {
  const [admins, engagements, routines] = await Promise.all([
    fetchJSON(API.admins),
    fetchJSON(API.engagements),
    fetchJSON(API.routines),
  ]);

  state.adminOptions = admins;
  state.engagements  = engagements;
  state.allRoutines  = routines;

  if (!state.adminId && admins[0]) state.adminId = admins[0].id;

  const engsForAdmin = engagements.filter(e => e.administrator_id === state.adminId);
  if (!state.engagementId && engsForAdmin[0]) state.engagementId = engsForAdmin[0].id;

  // If AMAP hasn't been set yet, default to "all routines"
  if (state.amapRoutineIds.size === 0) {
    routines.forEach(r => state.amapRoutineIds.add(r.id));
  }
  // If run-now set is empty, start as a copy of AMAP-fed
  if (state.selectedRoutineIds.size === 0) {
    state.selectedRoutineIds = new Set([...state.amapRoutineIds]);
  } else {
    // Keep run-now subset aligned to AMAP (intersect)
    state.selectedRoutineIds = new Set(
      [...state.selectedRoutineIds].filter(id => state.amapRoutineIds.has(id))
    );
  }
}

// -------- Dev Modal --------
function openDevModal() {
  const modal = qs('#dev-modal');
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'false');

  // Admin select
  const adminSel = qs('#dev-admin');
  if (adminSel) {
    adminSel.innerHTML = '';
    state.adminOptions.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.id;
      opt.textContent = a.name;
      if (a.id === state.adminId) opt.selected = true;
      adminSel.appendChild(opt);
    });
  }

  // Engagement select — SHOW ALL, label with admin
  const engSel = qs('#dev-engagement');
  function renderEngagementOptions() {
    if (!engSel) return;
    engSel.innerHTML = '';
    state.engagements.forEach(e => {
      const adminName = state.adminOptions.find(a => a.id === e.administrator_id)?.name || e.administrator_id;
      const opt = document.createElement('option');
      opt.value = e.id;
      opt.textContent = `${e.name} — ${adminName}`;
      if (e.id === state.engagementId) opt.selected = true;
      engSel.appendChild(opt);
    });
    if (!state.engagementId && state.engagements[0]) state.engagementId = state.engagements[0].id;
  }
  renderEngagementOptions();

  // Routines checklist (AMAP-fed selection)
  const list = qs('#dev-routines');
  function renderRoutineChecklist() {
    if (!list) return;
    list.innerHTML = '';
    state.allRoutines.forEach(r => {
      const li = document.createElement('li');
      li.innerHTML = `
        <label class="chk">
          <input type="checkbox" value="${r.id}" ${state.amapRoutineIds.has(r.id) ? 'checked' : ''}/>
          <span>${r.name}</span>
        </label>
      `;
      list.appendChild(li);
    });
  }
  renderRoutineChecklist();

  // Events
  if (adminSel) {
    adminSel.onchange = (e) => { state.adminId = e.target.value; };
  }
  if (engSel) {
    engSel.onchange = (e) => {
      state.engagementId = e.target.value;
      const eng = state.engagements.find(x => x.id === state.engagementId);
      if (eng) state.adminId = eng.administrator_id; // keep admin synced
    };
  }
  if (list) {
    list.onchange = (e) => {
      if (e.target.type === 'checkbox') {
        const id = e.target.value;
        if (e.target.checked) state.amapRoutineIds.add(id);
        else state.amapRoutineIds.delete(id);
      }
    };
  }
}

function closeDevModal() {
  const modal = qs('#dev-modal');
  if (!modal) return;
  modal.setAttribute('aria-hidden', 'true');
}

function bindDevControls() {
  const toggle = qs('#dev-toggle');
  if (toggle) toggle.addEventListener('click', openDevModal);

  // Close handlers (backdrop + X + Cancel)
  qsa('[data-close]').forEach(el => el.addEventListener('click', closeDevModal));

  const apply = qs('#dev-apply');
  if (apply) {
    apply.addEventListener('click', () => {
      // On Apply, make run-now mirror the AMAP-fed list (simple, predictable).
      state.selectedRoutineIds = new Set([...state.amapRoutineIds]);

      saveDevConfig();
      closeDevModal();
      renderAll();      // refresh Selected Routines + Reports
    });
  }
}


// -------- Rendering --------
function renderMiniHeader() {
  const eng = state.engagements.find(e => e.id === state.engagementId);
  const resolvedAdminId = (state.adminId && state.adminId !== '__ALL__') ? state.adminId : eng?.administrator_id;
  const admin = state.adminOptions.find(a => a.id === resolvedAdminId);

  const a = qs('#mini-admin strong');
  const e = qs('#mini-engagement strong');
  const p = qs('#mini-period strong');

  if (a) a.textContent = admin ? admin.name : '—';
  if (e) e.textContent = eng ? eng.name : '—';
  if (p) p.textContent = eng?.period_end ?? '—';
}

function renderRoutinesCard() {
  const list = qs('#routine-list');
  if (!list) return;
  list.innerHTML = '';

  // Only render routines that AMAP fed us
  const fed = state.allRoutines.filter(r => state.amapRoutineIds.has(r.id));

  fed.forEach(r => {
    const checked = state.selectedRoutineIds.has(r.id);
    const li = document.createElement('li');
    li.innerHTML = `
      <label class="chk">
        <input type="checkbox" value="${r.id}" ${checked ? 'checked' : ''} />
        <span>${r.name}</span>
      </label>
    `;
    list.appendChild(li);
  });

  // Toggle only the "run-now" set; DO NOT hide items when unchecked
  list.onchange = (e) => {
    if (e.target.type !== 'checkbox') return;
    const id = e.target.value;
    if (e.target.checked) state.selectedRoutineIds.add(id);
    else state.selectedRoutineIds.delete(id);
    renderReportsCard();   // refresh expected reports
    saveDevConfig();
  };
}

function mergeReportsFromSelectedRoutines() {
  // Each routine has required_files [{key, human_name, required, import, export}]
  const required = new Map(); // key -> file object
  const optional = new Map();

  state.allRoutines
    .filter(r => state.selectedRoutineIds.has(r.id))
    .forEach(r => {
      (r.required_files || []).forEach(f => {
        // "required" flag per routine; if any routine says required=true, it's required overall
        if (f.required) {
          required.set(f.key, f);
          optional.delete(f.key);
        } else {
          if (!required.has(f.key)) optional.set(f.key, f);
        }
      });
    });

  return {
    required: [...required.values()],
    optional: [...optional.values()]
  };
}

function fmtImport(f) {
  if (!f || !f.import || !Array.isArray(f.import.formats)) return '';

  const kinds = new Set();
  for (const x of f.import.formats) {
    const t = String(x).toLowerCase();
    if (t === 'xlsx' || t === 'xls') kinds.add('Excel');
    else if (t === 'csv') kinds.add('CSV');
    else if (t === 'pdf') kinds.add('PDF');
    else kinds.add(t.toUpperCase());
  }

  const arr = [...kinds];
  if (!arr.length) return '';
  const last = arr.pop();
  const txt = arr.length ? `${arr.join(', ')} or ${last}` : last;
  return ` (${txt})`;
}


function renderReportsCard() {
  const { required, optional } = mergeReportsFromSelectedRoutines();
  const list = qs('#report-list');
  if (!list) return;
  list.innerHTML = '';

  const mkItem = (f, isRequired) => `
    <li>
      <label class="chk">
        <input type="checkbox" data-report-key="${f.key}" checked />
        <span>${f.human_name}${fmtImport(f)}</span>
        ${isRequired ? '<em class="req">required</em>' : ''}
      </label>
    </li>
  `;

  required.forEach(f => list.insertAdjacentHTML('beforeend', mkItem(f, true)));
  optional.forEach(f => list.insertAdjacentHTML('beforeend', mkItem(f, false)));

  const badge = qs('#reports-required-count');
  if (badge) badge.textContent = `${required.length} required`;
}

// -------- Upload area --------
const ALLOWED_EXTENSIONS = new Set(['csv','xls','xlsx']);
function isAllowedFile(file) {
  const name = (file?.name || '').toLowerCase();
  const ext = name.split('.').pop();
  return ALLOWED_EXTENSIONS.has(ext);
}

function bindUploadArea() {
  const drop      = qs('.dropzone');
  const fileInput = qs('#file-input');

  // Prefer explicit id; fallback to the first button in the upload card
  const chooseBtn = qs('#choose-files-btn') || qs('#card-upload .btn');

  if (chooseBtn && fileInput) chooseBtn.onclick = () => fileInput.click();
  if (fileInput) {
    fileInput.onchange = () => {
      if (!fileInput.files?.length) return;
      stageFiles(fileInput.files);
      fileInput.value = ''; // allow re-adding same file
    };
  }

  if (!drop) return;

  // Keyboard focus support: hitting Enter opens picker
  drop.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && fileInput) {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Drag & drop
  ['dragenter','dragover'].forEach(ev => {
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('drag'); }, false);
  });
  ['dragleave','drop'].forEach(ev => {
    drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('drag'); }, false);
  });
  drop.addEventListener('drop', e => {
    const files = e.dataTransfer?.files || [];
    stageFiles(files);
  });
}

function stageFiles(fileList) {
  const incoming = [...(fileList || [])];
  if (!incoming.length) return;

  // filter by allowed types and dedupe by name+size+lastModified
  const existingKey = (f) => `${f.name}|${f.size}|${f.lastModified}`;
  const existing = new Set(state.stagedFiles.map(existingKey));

  const filtered = incoming.filter(f => isAllowedFile(f));
  const newOnes  = filtered.filter(f => !existing.has(existingKey(f)));

  if (!newOnes.length) {
    renderStagedFiles(); // still ensure buttons reflect state
    return;
  }

  state.stagedFiles.push(...newOnes);
  renderStagedFiles();
}

function renderStagedFiles() {
  const table = qs('#staged-list');
  if (!table) return;

  // wipe existing rows except the header
  qsa('.files-table .row:not(.head)', table).forEach(el => el.remove());

  if (state.stagedFiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'row empty';
    empty.id = 'no-files-row';
    empty.innerHTML = '<div>No files yet</div><div>—</div><div>—</div>';
    table.appendChild(empty);
  } else {
    state.stagedFiles.forEach(f => {
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<div>${f.name}</div><div>${fmtBytes(f.size)}</div><div>staged</div>`;
      table.appendChild(row);
    });
  }

  // counters + buttons
  const stagedCountEl = qs('#staged-count');
  if (stagedCountEl) stagedCountEl.textContent = String(state.stagedFiles.length);

  const continueBtn =
    qs('#continue-btn') || qsa('#card-status .btn').find(b => /continue/i.test(b.textContent)) || null;

  if (continueBtn) {
    // enable only if there are staged files and we're not already in a "busy" click
    const isBusy = continueBtn.dataset.busy === '1';
    continueBtn.disabled = state.stagedFiles.length === 0 || isBusy;

    // ---- Double-click guard (capture phase) ----
    // Bind once per element; capture=true ensures this fires before the main handler.
    if (!continueBtn.__dcGuardBound) {
      continueBtn.addEventListener(
        'click',
        () => {
          if (continueBtn.disabled) return;
          // Immediately lock the button so rapid double-clicks do nothing
          continueBtn.disabled = true;
          continueBtn.dataset.busy = '1';
        },
        { capture: true }
      );
      continueBtn.__dcGuardBound = true;
    }
  }

  const clearBtn = qs('#clear-staged-btn') || qs('#card-status .btn.ghost');
  if (clearBtn) {
    clearBtn.onclick = () => {
      state.stagedFiles = [];
      // Reset any busy state on Continue since we cleared files
      const btn = qs('#continue-btn');
      if (btn) {
        delete btn.dataset.busy;
        btn.disabled = true;
      }
      renderStagedFiles();
    };
  }

  // (Re)bind continue navigation after DOM changes
  wireContinue();
}


// -------- Continue → Analysis wiring --------
function wireContinue() {
  const btn = qs('#continue-btn');
  if (!btn) return;

  // Guard: don't stack listeners across re-renders
  if (btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';

  // Ensure it never submits a form
  btn.setAttribute('type', 'button');

  btn.addEventListener('click', async (e) => {
    e.preventDefault();

    if (!state?.stagedFiles?.length) return;

    // Hard-disable immediately to prevent double/triple clicks
    btn.disabled = true;

    // 1) Persist minimal file list
    const minimal = state.stagedFiles.map(f => ({ name: f.name, size: f.size }));
    try { sessionStorage.setItem('apex-staged-list', JSON.stringify(minimal)); } catch {}

    // 2) Persist which reports were actually checked on the page
    let reportKeys = [];
    try {
      reportKeys = qsa('#report-list input[type="checkbox"][data-report-key]')
        .filter(i => i.checked)
        .map(i => i.getAttribute('data-report-key'));
      sessionStorage.setItem('apex-report-keys', JSON.stringify(reportKeys));
    } catch {}

    // 3) Persist selected routine ids for expected-report derivation
    try {
      sessionStorage.setItem('apex-selected-routine-ids', JSON.stringify([...state.selectedRoutineIds]));
    } catch {}

    // 4) Persist engagement/admin for header
    try {
      sessionStorage.setItem('apex-engagement-id', state.engagementId || '');
      sessionStorage.setItem('apex-admin-id', state.adminId || '');
    } catch {}

    // 5) Create a job, upload files to it, and start detection BEFORE navigation
    try {
      const jobId = await createJob('success');
      if (jobId) {
        sessionStorage.setItem('apex-job-id', jobId);

        const routineCodes = getSelectedRoutineCodes();

        // Upload files to the job (await so backend can see filenames)
        await preUploadToJob(jobId, state.stagedFiles, {
          engagementId: state.engagementId,
          routineCodes,
          reportKeys
        });

        // Start orchestrator (idempotent)
        await fetch(API.detectionStart, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobId,
            engagementId: state.engagementId,
            adminId: state.adminId,
            reportKeys,
            routineCodes
          })
        });

        // Mark that detection has been started this session (UA page will not re-start)
        sessionStorage.setItem('apex-detection-started', '1');
      } else {
        console.warn('createJob returned null; proceeding without orchestrator start');
        btn.disabled = false; // allow retry if desired
        return;
      }
    } catch (err) {
      console.warn('Continue flow (job/upload/start) failed:', err);
      btn.disabled = false; // allow retry on failure
      return;
    }

    // 6) Navigate to analysis screen (path is from /index.html)
    window.location.href = './upload-analysis/upload-analysis.html';
  });
}





// -------- Main render --------
function renderAll() {
  renderMiniHeader();
  renderRoutinesCard();
  renderReportsCard();
  renderStagedFiles();   // updates DOM for the button
  wireContinue();        // <-- bind (or re-bind) the click handler
}


// -------- Fresh defaults --------
function applyFreshDevDefaults() {
  // Pick the first engagement and sync admin from it (keeps header consistent)
  const firstEng = state.engagements[0] || null;
  state.engagementId = firstEng?.id || null;

  // If we have an engagement, use its admin; otherwise fall back to first admin
  const firstAdmin = state.adminOptions[0] || null;
  state.adminId = firstEng?.administrator_id || firstAdmin?.id || null;

  // AMAP feed = all routines; Run-now = same as AMAP (full set)
  const allIds = state.allRoutines.map(r => r.id);
  state.amapRoutineIds     = new Set(allIds);
  state.selectedRoutineIds = new Set(allIds);

  // Clear any previously staged files
  state.stagedFiles = [];

  // Persist so Dev modal reflects the defaults
  saveDevConfig();
}

// -------- Init --------
(async function init(){
  // Intentionally start fresh every visit (no loadDevConfig)
  // loadDevConfig();

  await loadCatalogs();        // fetch admins, engagements, routines
  applyFreshDevDefaults();     // enforce fresh AMAP-style defaults

  bindDevControls();
  bindUploadArea();
  renderAll();
  // ensure Continue bound at least once
  wireContinue();
})();
