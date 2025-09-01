// server/services/detectionOrchestrator.js
// Orchestrates detection runs per jobId. Idempotent start; status returns a snapshot.

const TierA = require('./detectionTierA');
const TierB = require('./detectionTierB');

// ---- Logging helpers --------------------------------------------------------
const DEBUG = true; // set false to quiet logs

function ts() {
  const d = new Date();
  return d.toISOString().split('T')[1].replace('Z', 'Z');
}
function log(...args) { if (DEBUG) console.log(`[Orch ${ts()}]`, ...args); }
function warn(...args) { console.warn(`[Orch ${ts()}]`, ...args); }

// -----------------------------------------------------------------------------
//
// In-memory store (dev only).
// jobId -> {
//   startedAt: number,
//   overall: 'running'|'success'|'failed',
//   progress: { done:number, total:number },
//   reports: Array<{
//     reportKey: string,
//     fieldsMapped:     'pending'|'yes'|'no',
//     attributesMapped: 'pending'|'yes'|'no',
//     locatedSource: 'db'|'ai'|null,
//     mappedCount: number,
//     totalFields: number,
//     message: string|null
//   }>,
//   outcome: {
//     fieldsAnyNo: boolean,
//     attributesAnyNo: boolean,
//     fieldsAllYes: boolean,
//     attributesAllYes: boolean
//   },
//   _timer: NodeJS.Timeout | null,
//   _cursor: number,
//   message?: string|null
// }
// -----------------------------------------------------------------------------
const store = new Map();

/** Compute overall outcome booleans from current report states. */
function computeOutcome(reports = []) {
  const fieldsAnyNo      = reports.some(r => r.fieldsMapped === 'no');
  const attributesAnyNo  = reports.some(r => r.attributesMapped === 'no');
  const fieldsAllYes     = reports.length > 0 && reports.every(r => r.fieldsMapped === 'yes');
  const attributesAllYes = reports.length > 0 && reports.every(r => r.attributesMapped === 'yes');
  return { fieldsAnyNo, attributesAnyNo, fieldsAllYes, attributesAllYes };
}

/** Normalize any tier result (old or new keys) into new shape. */
function normalizeTierResult(r) {
  if (!r) return null;

  // accept both old and new keys
  const fieldsMappedRaw     = r.fieldsMapped     ?? r.located;
  const attributesMappedRaw = r.attributesMapped ?? r.mapped;

  // normalize to 'yes' | 'no' | 'pending' (default stays 'pending' here;
  // we terminalize later)
  const fieldsMapped = (fieldsMappedRaw === 'yes') ? 'yes'
                    : (fieldsMappedRaw === 'no')  ? 'no'
                    : fieldsMappedRaw || 'pending';

  const attributesMapped = (attributesMappedRaw === 'yes') ? 'yes'
                        : (attributesMappedRaw === 'no')  ? 'no'
                        : attributesMappedRaw || 'pending';

  return {
    fieldsMapped,
    attributesMapped,
    locatedSource: r.locatedSource || null,
    mappedCount: Number.isFinite(r.mappedCount) ? r.mappedCount : 0,
    totalFields: Number.isFinite(r.totalFields) ? r.totalFields : 0,
    message: r.message || null
  };
}

function compactResult(r) {
  if (!r) return r;
  return {
    fieldsMapped: r.fieldsMapped,
    attributesMapped: r.attributesMapped,
    locatedSource: r.locatedSource || null,
    mappedCount: r.mappedCount ?? 0,
    totalFields: r.totalFields ?? 0
  };
}

/** Seed a job if not present. */
function ensureJob(jobId, reportKeys = []) {
  if (store.has(jobId)) {
    log(`ensureJob: found existing job ${jobId}`);
    return store.get(jobId);
  }

  const reports = (reportKeys || []).map(k => ({
    reportKey: k,
    fieldsMapped: 'pending',
    attributesMapped: 'pending',
    locatedSource: null,
    mappedCount: 0,
    totalFields: 0,
    message: null
  }));

  const job = {
    startedAt: Date.now(),
    overall: 'running',
    progress: { done: 0, total: reports.length },
    reports,
    outcome: computeOutcome(reports),
    _timer: null,
    _cursor: 0,
    message: null
  };
  store.set(jobId, job);
  log(`ensureJob: seeded job ${jobId} with ${reports.length} report(s)`);
  return job;
}

/**
 * Advance one report per tick through Tier A → Tier B.
 * - Tier A tries deterministic rules.
 * - If Tier A can’t conclude, Tier B runs (stubbed now).
 * - Terminalize each report to yes/no on both fields.
 */
async function step(jobId, ctx) {
  const job = store.get(jobId);
  if (!job) { warn(`step: unknown jobId ${jobId}`); return; }
  if (job.overall !== 'running') { log(`step: job ${jobId} not running (${job.overall})`); return; }

  const i = job._cursor;
  if (i >= job.reports.length) {
    job.overall = 'success';
    clearTimer(job);
    log(`step: job ${jobId} completed (no more reports)`);
    return;
  }

  const r = job.reports[i];
  log(`step: job ${jobId} report[${i+1}/${job.reports.length}] key=${r.reportKey}`);

  try {
    // --- Tier A ---
    const resA = normalizeTierResult(await TierA.locateAndMap({
      jobId,
      reportKey: r.reportKey,
      files: ctx.files || [],
      db: ctx.db || null,
      engagementId: ctx.engagementId || null,
      adminId: ctx.adminId || null,
      routineCodes: ctx.routineCodes || []
    }));
    log(`  TierA ->`, compactResult(resA));

    let result = resA;

    // --- Tier B (only if either field still pending/unknown) ---
    const aNeedsB = !result
      || (result.fieldsMapped !== 'yes' && result.fieldsMapped !== 'no')
      || (result.attributesMapped !== 'yes' && result.attributesMapped !== 'no');

    if (aNeedsB) {
      const resB = normalizeTierResult(await TierB.locateAndMap({
        jobId,
        reportKey: r.reportKey,
        files: ctx.files || [],
        db: ctx.db || null
      }));
      log(`  TierB ->`, compactResult(resB));

      // Prefer existing A values; fill only where pending
      result = {
        fieldsMapped:     (result?.fieldsMapped     && result.fieldsMapped     !== 'pending') ? result.fieldsMapped     : resB?.fieldsMapped     ?? 'pending',
        attributesMapped: (result?.attributesMapped && result.attributesMapped !== 'pending') ? result.attributesMapped : resB?.attributesMapped ?? 'pending',
        locatedSource: result?.locatedSource || resB?.locatedSource || null,
        mappedCount: result?.mappedCount ?? resB?.mappedCount ?? 0,
        totalFields: result?.totalFields ?? resB?.totalFields ?? 0,
        message: result?.message || resB?.message || null
      };
    }

    // Terminalize (no more "pending" after a step)
    const fieldsMapped     = (result?.fieldsMapped     === 'yes') ? 'yes' : (result?.fieldsMapped     === 'no') ? 'no' : 'no';
    const attributesMapped = (result?.attributesMapped === 'yes') ? 'yes' : (result?.attributesMapped === 'no') ? 'no' : 'no';

    // Apply to report
    r.fieldsMapped     = fieldsMapped;
    r.attributesMapped = attributesMapped;
    r.locatedSource    = (fieldsMapped === 'yes') ? (result?.locatedSource || null) : null;
    r.mappedCount      = Number.isFinite(result?.mappedCount) ? result.mappedCount : 0;
    r.totalFields      = Number.isFinite(result?.totalFields) ? result.totalFields : 0;
    r.message          = result?.message || null;

    job._cursor += 1;
    job.progress.done = Math.min(job._cursor, job.progress.total);

    // Update outcome snapshot after each report update
    job.outcome = computeOutcome(job.reports);

    log(`  applied -> fieldsMapped=${r.fieldsMapped}${r.locatedSource ? `(${r.locatedSource})` : ''}, attributesMapped=${r.attributesMapped}, progress=${job.progress.done}/${job.progress.total}`);

    // Finish if that was the last
    if (job._cursor >= job.reports.length) {
      job.overall = 'success';
      clearTimer(job);
      log(`step: job ${jobId} completed (all reports processed)`);
    }
  } catch (err) {
    job.overall = 'failed';
    job.message = String(err?.message || err);
    clearTimer(job);
    warn(`step: job ${jobId} errored: ${job.message}`);
  }
}

/** Internal: schedule ticking until done. */
function schedule(jobId, ctx) {
  const job = store.get(jobId);
  if (!job) { warn(`schedule: unknown jobId ${jobId}`); return; }

  clearTimer(job);

  // Tick cadence: 500ms per report (adjustable)
  job._timer = setInterval(() => {
    step(jobId, ctx).catch(err => {
      job.overall = 'failed';
      job.message = String(err?.message || err);
      clearTimer(job);
      warn(`schedule/step: job ${jobId} errored: ${job.message}`);
    });
  }, 500);

  log(`schedule: job ${jobId} started ticking (interval=500ms)`);
}

function clearTimer(job) {
  if (job?._timer) {
    clearInterval(job._timer);
    job._timer = null;
  }
}

/**
 * Public: start a detection run (idempotent).
 * payload: { db, files, engagementId, adminId, routineCodes, reportKeys }
 */
async function start(jobId, payload = {}) {
  if (!jobId) throw new Error('start(jobId) requires jobId');
  const { reportKeys = [] } = payload;

  const job = ensureJob(jobId, reportKeys);

  if (job.progress.total === 0) {
    log(`start: job ${jobId} has no reportKeys — marking success`);
    job.overall = 'success';
    // keep outcome up to date even for empty jobs
    job.outcome = computeOutcome(job.reports);
    return { jobId, started: true, empty: true };
  }

  if (job.overall !== 'running') {
    log(`start: job ${jobId} already ${job.overall} — noop`);
    return { jobId, started: true, already: true };
  }
  if (job._timer) {
    log(`start: job ${jobId} already ticking — noop`);
    return { jobId, started: true, already: true };
  }

  schedule(jobId, {
    db: payload.db || null,
    files: payload.files || [],
    engagementId: payload.engagementId || null,
    adminId: payload.adminId || null,
    routineCodes: payload.routineCodes || []
  });

  log(`start: job ${jobId} accepted with ${reportKeys.length} reportKey(s)`);
  return { jobId, started: true };
}

/** Public: status snapshot */
async function status(jobId) {
  const job = store.get(jobId);
  if (!job) {
    warn(`status: unknown jobId ${jobId}`);
    return null;
  }

  const snapshot = {
    jobId,
    overall: job.overall,
    progress: { ...job.progress },
    outcome: { ...job.outcome }, // <-- expose outcome to the client
    reports: job.reports.map(r => {
      const fieldsMapped     = r.fieldsMapped;
      const attributesMapped = r.attributesMapped;
      return {
        reportKey: r.reportKey,

        // NEW API (preferred)
        fieldsMapped,
        attributesMapped,

        // Legacy mirrors for compatibility with existing frontend
        located: fieldsMapped,
        mapped: attributesMapped,

        locatedSource: r.locatedSource,
        mappedCount: r.mappedCount,
        totalFields: r.totalFields,
        message: r.message || null
      };
    })
  };

  log(`status: job ${jobId} -> overall=${snapshot.overall}, progress=${snapshot.progress.done}/${snapshot.progress.total}`);
  return snapshot;
}

module.exports = { start, status };
