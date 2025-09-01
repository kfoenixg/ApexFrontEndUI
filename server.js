// server.js
// APEX UI dev server: serves static files + JSON API mirroring database.json shape.

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const multer = require('multer');

// Orchestrator (Tier A/B/C runner)
const { start: startDetection, status: detectionStatus } =
  require('./server/services/detectionOrchestrator');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- In-memory Jobs (dev only) ----------------

const jobs = new Map(); // jobId -> { id, createdAt, mode, files:[], timelineMs, stages }
const JOB_DEFAULT_TIMELINE_MS = { validating: 12000, processing: 18000 }; // 12s + 18s
const makeId = (p = 'J') =>
  `${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function createJob({ mode = 'success' } = {}) {
  const id = makeId('J');
  const now = Date.now();
  const t = JOB_DEFAULT_TIMELINE_MS;

  const stages = [
    { name: 'PENDING', start: 0, end: 0 },
    { name: 'VALIDATING', start: 0, end: t.validating },
    { name: 'PROCESSING', start: t.validating, end: t.validating + t.processing },
    {
      name: mode === 'fail' ? 'ERROR' : 'SUCCESS',
      start: t.validating + t.processing,
      end: t.validating + t.processing
    }
  ];

  const job = { id, createdAt: now, mode, files: [], timelineMs: t, stages };
  jobs.set(id, job);
  return job;
}

function getJobStatus(job) {
  const elapsed = Date.now() - job.createdAt;
  const { validating, processing } = job.timelineMs;
  let stage = 'PENDING';
  let percent = 0;
  let messages = [];

  if (elapsed <= 0) {
    stage = 'PENDING';
    percent = 0;
    messages = ['Queued'];
  } else if (elapsed < validating) {
    stage = 'VALIDATING';
    percent = Math.max(
      1,
      Math.floor((elapsed / (validating + processing)) * 100 * 0.4) // → ~40%
    );
    messages = ['Checking headers…', 'Verifying required fields…'];
  } else if (elapsed < validating + processing) {
    stage = 'PROCESSING';
    const procElapsed = elapsed - validating;
    percent = Math.min(99, 40 + Math.floor((procElapsed / processing) * 59)); // 40→99
    messages = ['Normalizing rows…', 'Converting to CSV…'];
  } else {
    stage = job.mode === 'fail' ? 'ERROR' : 'SUCCESS';
    percent = 100;
    messages =
      stage === 'SUCCESS'
        ? ['All reports converted.']
        : ['Validation failed: Header mismatch in one or more files.'];
  }
  return { jobId: job.id, stage, percent, messages, fileCount: job.files.length };
}

// ---------------- Upload storage ----------------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const ALLOWED_EXTS = new Set(['.csv', '.xls', '.xlsx']);
const ALLOWED_MIMES = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^\w.\-]+/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  }
});

const upload = multer({
  storage,
  limits: { files: 20, fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    try {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const ok = ALLOWED_EXTS.has(ext) || ALLOWED_MIMES.has(file.mimetype);
      if (!ok) return cb(new Error('Unsupported file type'));
      cb(null, true);
    } catch (e) {
      cb(e);
    }
  }
});

// ---------------- Middleware & static ----------------
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(express.static(__dirname, { etag: true, cacheControl: true }));

// ---------------- DB helpers ----------------
const DB_PATH = path.join(__dirname, 'database.json');

async function loadDB() {
  const raw = await fsp.readFile(DB_PATH, 'utf8');
  return JSON.parse(raw);
}

// optional persistence for learning_data (disabled)
/*
async function saveDB(db) {
  await fsp.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}
*/

// ---------------- Root & system info ----------------
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'apex-ui', ts: Date.now() });
});

app.get('/api/system/info', async (_req, res) => {
  try {
    const db = await loadDB();
    const sd = db.system_data || {};
    res.json({
      schema_version: sd.schema_version ?? null,
      generated_at: sd.generated_at ?? null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load system info' });
  }
});

// ---------------- Adapters for work-order nouns ----------------
function buildInstitutionsView(db, mode = 'administrators') {
  const admins = db.mock_lookups?.administrators ?? [];
  const engagements = db.mock_lookups?.engagements ?? [];

  if (mode === 'engagements') {
    return engagements.map(e => {
      const admin = admins.find(a => a.id === e.administrator_id);
      return {
        id: e.id,
        name: e.name,
        type: 'engagement',
        administrator_id: e.administrator_id,
        administrator_name: admin?.name ?? e.administrator_id,
        period_end: e.period_end,
        period_end_iso: e.period_end_iso ?? null
      };
    });
  }

  // default: administrators with nested engagements
  return admins.map(a => ({
    id: a.id,
    name: a.name,
    type: 'administrator',
    engagements: engagements
      .filter(e => e.administrator_id === a.id)
      .map(e => ({
        id: e.id,
        name: e.name,
        period_end: e.period_end,
        period_end_iso: e.period_end_iso ?? null
      }))
  }));
}

function buildReportsList(db) {
  const routines = db.system_data?.routines ?? [];
  const byKey = new Map(); // key -> { key, human_name, formats:Set, required_by:Set }

  for (const r of routines) {
    for (const f of r.required_files ?? []) {
      const entry =
        byKey.get(f.key) ||
        { key: f.key, human_name: f.human_name, formats: new Set(), required_by: new Set() };
      const fmts = Array.isArray(f.import?.formats) ? f.import.formats : [];
      fmts.forEach(x => entry.formats.add(String(x).toLowerCase()));
      entry.required_by.add(r.id);
      byKey.set(f.key, entry);
    }
  }

  return Array.from(byKey.values()).map(x => ({
    key: x.key,
    human_name: x.human_name,
    formats: Array.from(x.formats), // ["xlsx","xls","csv"]
    required_by: Array.from(x.required_by)
  }));
}

// ---------------- Mock lookups & system data ----------------
app.get('/api/mock-lookups/:key', async (req, res) => {
  try {
    const db = await loadDB();
    const { key } = req.params; // administrators | custodians | engagements
    const data = db.mock_lookups?.[key];
    if (!data) return res.status(404).json({ error: `Unknown lookup: ${key}` });
    res.json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load mock lookups' });
  }
});

app.get('/api/system/routines', async (_req, res) => {
  try {
    const db = await loadDB();
    res.json(db.system_data?.routines ?? []);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load routines' });
  }
});

app.get('/api/system/report-field-specs', async (req, res) => {
  try {
    const db = await loadDB();
    const all = db.system_data?.report_field_specs ?? {};
    const keysParam = req.query.keys;

    if (!keysParam) return res.json(all);

    const keys = String(keysParam)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);

    const subset = {};
    keys.forEach(k => {
      if (all[k]) subset[k] = all[k];
    });

    res.json(subset);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load report field specs' });
  }
});

app.get('/api/system/report-field-specs/:reportKey', async (req, res) => {
  try {
    const db = await loadDB();
    const spec = db.system_data?.report_field_specs?.[req.params.reportKey];
    if (!spec) return res.status(404).json({ error: `Unknown reportKey: ${req.params.reportKey}` });
    res.json(spec);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load report field spec' });
  }
});

app.get('/api/system/learning', async (_req, res) => {
  try {
    const db = await loadDB();
    res.json(db.system_data?.learning_data ?? {});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load learning data' });
  }
});

// ---------------- Work-order adapter routes ----------------
app.get('/api/institutions', async (req, res) => {
  try {
    const db = await loadDB();
    const mode = (req.query.mode || 'administrators').toString().toLowerCase();
    if (!['administrators', 'engagements'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Use administrators | engagements' });
    }
    res.json(buildInstitutionsView(db, mode));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load institutions' });
  }
});

app.get('/api/reports', async (req, res) => {
  try {
    const db = await loadDB();
    const all = buildReportsList(db);
    const keysParam = req.query.keys;
    if (!keysParam) return res.json(all);

    const keys = String(keysParam)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    res.json(all.filter(r => keys.includes(r.key)));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load reports' });
  }
});

// ---------------- Jobs API ----------------
app.post('/api/jobs', (req, res) => {
  try {
    const mode = (req.body?.mode || 'success').toString().toLowerCase();
    const job = createJob({ mode: mode === 'fail' ? 'fail' : 'success' });
    res.json({ ok: true, jobId: job.id, mode: job.mode, createdAt: job.createdAt });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Failed to create job' });
  }
});

app.get('/api/jobs/:jobId/status', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Unknown jobId' });
  res.json({ ok: true, ...getJobStatus(job) });
});

app.get('/api/jobs/:jobId/results', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Unknown jobId' });

  const status = getJobStatus(job);
  if (status.stage !== 'SUCCESS') {
    return res.status(409).json({ ok: false, error: `Job not complete (${status.stage})` });
  }

  // Mock KPIs + pretend download URLs
  const kpis = {
    filesProcessed: job.files.length,
    rowsConverted: 45678,
    durationSec: Math.ceil((Date.now() - job.createdAt) / 1000),
    errorRate: 0.0
  };
  const reports = [
    {
      key: 'period_end_soi',
      human_name: 'Period End SOI',
      filename: 'Period-End SOI.csv',
      downloadUrl: `/downloads/${job.id}/Period-End%20SOI.csv`
    },
    {
      key: 'prior_period_end_soi',
      human_name: 'Prior Period End SOI',
      filename: 'Prior Period-End SOI.csv',
      downloadUrl: `/downloads/${job.id}/Prior%20Period-End%20SOI.csv`
    },
    {
      key: 'purchases_and_sales_report',
      human_name: 'Purchases & Sales Report',
      filename: 'P&S Report.csv',
      downloadUrl: `/downloads/${job.id}/P%26S%20Report.csv`
    }
  ];
  res.json({ ok: true, jobId: job.id, createdAt: job.createdAt, kpis, reports });
});



// ---------------- Detection Orchestrator API ----------------

// Start (idempotent): seeds a detection job and begins processing
app.post('/api/detection/start', async (req, res) => {
  try {
    const { jobId, engagementId, adminId, reportKeys = [], routineCodes = [] } = req.body || {};
    console.log(`[API] detection/start jobId=${jobId} reports=${reportKeys.length} routines=${routineCodes.length}`);
    if (!jobId) return res.status(400).json({ ok:false, error:'Missing jobId' });

    // Ensure the job exists in your in-memory Map you already use for uploads
    const job = jobs.get(jobId) || createJob({ mode: 'success' });
    jobs.set(jobId, job);

    // Load DB so tiers can use it if needed
    const db = await loadDB();

    // Kick off orchestrator (idempotent)
    const result = await startDetection(jobId, {
      db,
      files: job.files || [],
      engagementId,
      adminId,
      routineCodes,
      reportKeys
    });

    console.log(`[API] detection/start ok jobId=${jobId} ->`, result);
    res.json({ ok:true, ...result });
  } catch (e) {
    console.error('[API] detection/start error:', e);
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});

// Status: returns overall + per-report statuses
app.get('/api/detection/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const snap = await detectionStatus(jobId);
    if (!snap) {
      console.warn(`[API] detection/status unknown jobId=${jobId}`);
      return res.status(404).json({ ok:false, error:'Unknown jobId' });
    }
    console.log(`[API] detection/status jobId=${jobId} overall=${snap.overall} ${snap.progress.done}/${snap.progress.total}`);
    res.json({ ok:true, ...snap });
  } catch (e) {
    console.error('[API] detection/status error:', e);
    res.status(500).json({ ok:false, error:String(e?.message || e) });
  }
});


// Status: returns overall + per-report statuses
app.get('/api/detection/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const snapshot = await orchestrator.status(jobId);
    if (!snapshot) return res.status(404).json({ error: 'Unknown jobId' });
    res.json(snapshot);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to fetch detection status' });
  }
});



// ---------------- Uploads ----------------
// Accepts optional ?jobId=... or body.jobId to associate uploads with a job
app.post('/api/upload', (req, res) => {
  upload.array('files', 20)(req, res, err => {
    if (err) {
      const msg = err?.message || 'Upload failed';
      return res.status(400).json({ ok: false, error: msg });
    }
    const files = (req.files || []).map(f => ({
      serverName: path.basename(f.path),
      originalName: f.originalname,
      size: f.size,
      mimeType: f.mimetype
    }));

    const { engagementId, routineCodes, reportKeys } = req.body || {};
    const jobId = (req.query.jobId || req.body?.jobId || '').toString();

    if (jobId && jobs.has(jobId)) {
      const job = jobs.get(jobId);
      job.files.push(...files);
    }

    res.json({ ok: true, files, engagementId, routineCodes, reportKeys, jobId: jobId || null });
  });
});

// ---------------- SPA fallback ----------------
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.method !== 'GET') return next();
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------------- Start ----------------
app.listen(PORT, () => {
  console.log(`APEX UI server running at http://localhost:${PORT}`);
});




// server/services/detectionOrchestrator.js
module.exports = {
  start(jobId, payload) { /* seed job state, kick off processing */ },
  status(jobId) { return { jobId, overall: 'running', progress:{done:0,total:0}, reports:[] }; }
};

// server/services/detectionTierA.js
module.exports = {
  locateAndMap({ job, db, reportKey }) { 
    // return { located:'yes'|'no'|'pending', mapped:'yes'|'no'|'pending', locatedSource:'db', mappedCount:0, totalFields:0, message:null }
  }
};

// server/services/detectionTierB.js
module.exports = {
  locateAndMap({ job, db, reportKey }) {
    // return same shape, with locatedSource:'ai'
  }
};

// server/services/detectionTierC.js (optional)
module.exports = { locateAndMap(/*...*/) { /* later */ } };
