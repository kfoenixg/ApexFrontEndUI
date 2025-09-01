// server/services/detectionTierA.js
// Deterministic “database/rules” pass.
// Very simple demo rules for now:
// - If an uploaded filename includes the report's human_name or key (case-insensitive) → located 'yes'.
// - For mapped: if we can find a spec for the report (in db), mark 'yes' with totalFields count; otherwise 'no'.

/**
 * Resolve human name and field spec for reportKey from db.
 */
function findReportMeta(db, reportKey) {
  const routines = db?.system_data?.routines || [];
  let human = null;

  for (const r of routines) {
    for (const f of (r.required_files || [])) {
      if (String(f.key) === String(reportKey)) {
        human = f.human_name || null;
      }
    }
  }

  const spec = db?.system_data?.report_field_specs?.[reportKey] || null;
  const totalFields = Array.isArray(spec?.fields) ? spec.fields.length : 0;

  return { humanName: human, totalFields };
}

/**
 * Basic filename heuristic: does any uploaded file name contain the report name or key?
 */
function looksLikeMatch(files = [], reportKey, humanName) {
  const q = String(reportKey).toLowerCase();
  const h = String(humanName || '').toLowerCase();

  return (files || []).some(f => {
    const name = String(f.originalName || f.serverName || '').toLowerCase();
    return name.includes(q) || (h && name.includes(h));
  });
}

async function locateAndMap({ jobId, reportKey, files = [], db = null }) {
  const { humanName, totalFields } = findReportMeta(db, reportKey);

  const locatedYes = looksLikeMatch(files, reportKey, humanName);
  // For demo: if located, we say mapping exists when we have a field spec
  const mappedYes = locatedYes && totalFields > 0;

  return {
    located: locatedYes ? 'yes' : 'no',
    mapped: mappedYes ? 'yes' : 'no',
    locatedSource: 'db',
    mappedCount: mappedYes ? totalFields : 0,
    totalFields,
    message: null
  };
}

module.exports = { locateAndMap };

// Tier A: deterministic rules (stub)
module.exports.locateAndMap = async function locateAndMap(ctx) {
  console.log(`[TierA] job=${ctx.jobId} report=${ctx.reportKey} files=${(ctx.files||[]).length} routines=${(ctx.routineCodes||[]).length}`);
  // For now: always "no" so we see TierB run
  return { located: 'no', mapped: 'no', locatedSource: null, mappedCount: 0, totalFields: 0, message: null };
};
