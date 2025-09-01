// fieldSelector/fieldSelector.js
// Step 1: choose file per report with Fields Mapped = "no"
// NO auto-redirects here. Routing decisions happen upstream.

(function(){
  // ---------- Config & helpers ----------
  const BASE = window.location.origin.startsWith('file') ? 'http://localhost:3000' : '';
  const API = {
    admins:      `${BASE}/api/mock-lookups/administrators`,
    engagements: `${BASE}/api/mock-lookups/engagements`,
    routines:    `${BASE}/api/system/routines`,
  };

  const qs  = (s, el=document) => el.querySelector(s);
  const qsa = (s, el=document) => [...el.querySelectorAll(s)];

  async function fetchJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  function bytesToNice(n){
    if (!Number.isFinite(n)) return '—';
    const u = ['B','KB','MB','GB','TB'];
    let i=0, v=n;
    while (v>=1024 && i<u.length-1){ v/=1024; i++; }
    return `${v.toFixed(v<10?1:0)} ${u[i]}`;
  }

  // Build key->reportDef (human_name) from routines
  function collectAllReportDefs(routines){
    const map = new Map();
    routines.forEach(r => (r.required_files || []).forEach(f => {
      if (!map.has(f.key)) map.set(f.key, f);
    }));
    return map;
  }

  function readStagedFiles(){
    try {
      const raw = sessionStorage.getItem('apex-staged-list'); // canonical key
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  // Determine whether fields are "no" for a detection row
  function fieldsIsNo(row){
    const v = (row.fieldsMapped ?? row.located);
    return v === 'no';
  }

  // Persist cursor & selections so refreshes are safe
  function getCursor(){
    const v = sessionStorage.getItem('fs-cursor');
    return v ? Number(v) : 0;
  }
  function setCursor(i){
    sessionStorage.setItem('fs-cursor', String(i));
  }

  function getSelections() {
    // Prefer GV if available
    if (window.APEX && typeof window.APEX.getReports === 'function') {
      const reports = window.APEX.getReports();
      const out = {};
      reports.forEach(r => {
        if (r.selectedFile) out[r.reportKey] = r.selectedFile;
      });
      if (Object.keys(out).length) return out;
    }
    // Fallback to sessionStorage
    try {
      const raw = sessionStorage.getItem('fs-selections');
      return raw ? JSON.parse(raw) : {};
    } catch { 
      return {}; 
    }
  }

  function setSelections(obj) {
    sessionStorage.setItem('fs-selections', JSON.stringify(obj || {}));
    if (window.APEX && typeof window.APEX.updateReport === 'function') {
      for (const [reportKey, fileName] of Object.entries(obj || {})) {
        window.APEX.updateReport(reportKey, { selectedFile: fileName });
      }
    }
  }

  // Mini header population
  function renderMiniHeader(admins, engagements){
    let adminId=null, engagementId=null;
    try {
      engagementId = sessionStorage.getItem('apex-engagement-id') || null;
      adminId      = sessionStorage.getItem('apex-admin-id') || null;
    } catch {}
    if (!adminId || !engagementId){
      try{
        const raw = localStorage.getItem('apex-dev-config');
        if (raw){
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

  // ---------- Renderers ----------
  function renderFileList(files, currentSelection){
    const list = qs('#fs-file-list');
    list.innerHTML = '';
    files.forEach((f, idx) => {
      const id = `fs_file_${idx}`;
      const row = document.createElement('label');
      row.className = 'file-row';
      row.setAttribute('for', id);
      row.innerHTML = `
        <input type="radio" name="fs-file" id="${id}" value="${encodeURIComponent(f.name)}" ${currentSelection === f.name ? 'checked' : ''}/>
        <div class="file-name">${f.name}</div>
        <div class="file-meta">${bytesToNice(f.size)}</div>
      `;
      list.appendChild(row);
    });
  }

  function setReportPrompts(humanName){
    const a = qs('#fs-report-name');
    const b = qs('#fs-report-name-2');
    if (a) a.textContent = humanName || '—';
    if (b) b.textContent = humanName || '—';
  }

  function showDoneMessage() {
    const stepTitle = qs('.fs-step-title');
    const stepSub   = qs('#fs-step-sub');
    const picker    = qs('#fs-filepicker');
    if (stepTitle) stepTitle.textContent = 'All field selections captured';
    if (stepSub)   stepSub.textContent   = 'You can return to Data Mapping when ready.';
    if (picker)    picker.hidden = true;
  }

  // ---------- Main ----------
  (async function init(){
    console.group('[FS] Field Selector init');

    // Load catalogs for header + report name lookup
    const [admins, engagements, routines] = await Promise.all([
      fetchJSON(API.admins),
      fetchJSON(API.engagements),
      fetchJSON(API.routines),
    ]);
    renderMiniHeader(admins, engagements);

    const reportMap = collectAllReportDefs(routines);

    // Pull from GV
    const results = (window.APEX && typeof window.APEX.getReports === 'function')
      ? window.APEX.getReports()
      : [];

    const queue = results.filter(fieldsIsNo).map(r => r.reportKey);
    console.log('Queue (fields NO):', queue);

    if (queue.length === 0){
      console.log('[FS] Nothing to fix — standing by.');
      showDoneMessage();
      console.groupEnd();
      return;
    }

    // Cursor & current report
    let idx = Math.min(getCursor(), queue.length - 1);
    const currentKey = queue[idx];
    const def = reportMap.get(currentKey);
    const human = def?.human_name || currentKey;
    setReportPrompts(human);

    // Files
    const files = readStagedFiles();
    const empty = qs('#fs-empty');
    const picker = qs('#fs-filepicker');
    if (!files.length){
      picker.hidden = true;
      empty.hidden = false;
      qs('#fs-go-upload')?.addEventListener('click', () => {
        window.location.href = '../index.html';
      });
      console.groupEnd();
      return;
    } else {
      picker.hidden = false;
      empty.hidden = true;
    }

    // Restore selection (auto-select if only one file)
    const selections = getSelections();
    const pre = selections[currentKey] || (files.length === 1 ? files[0].name : null);
    renderFileList(files, pre);

    const nextBtn = qs('#fs-next');
    const backBtn = qs('#fs-back');
    const skipBtn = qs('#fs-skip');

    function getSelectedFileName(){
      const sel = qs('input[name="fs-file"]:checked');
      return sel ? decodeURIComponent(sel.value) : null;
    }
    function updateNextEnabled(){
      if (nextBtn) nextBtn.disabled = !getSelectedFileName();
    }
    qsa('input[name="fs-file"]').forEach(r => {
      r.addEventListener('change', updateNextEnabled);
    });
    updateNextEnabled();

    if (!nextBtn) console.warn('[FS] No #fs-next button in DOM — selection will not advance.');

    if (backBtn){
      backBtn.onclick = () => window.location.href = '../upload-analysis/upload-analysis.html';
    }

    if (skipBtn){
      skipBtn.onclick = () => {
        const newIdx = idx + 1;
        if (newIdx >= queue.length){
          setCursor(0);
          showDoneMessage();
        } else {
          setCursor(newIdx);
          window.location.reload();
        }
      };
    }

    if (nextBtn){
      nextBtn.onclick = () => {
        const selected = getSelectedFileName();
        if (!selected) return;

        const all = getSelections();
        all[currentKey] = selected;
        setSelections(all);

        console.log('[FS] Selected file for report', { reportKey: currentKey, file: selected });

        const newIdx = idx + 1;
        if (newIdx >= queue.length){
          setCursor(0);
          showDoneMessage();
        } else {
          setCursor(newIdx);
          window.location.reload();
        }
      };
    }

    console.groupEnd();
  })();
})();
