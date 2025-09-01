// server/services/detectionTierB.js
// AI fallback (stub). For now, always returns 'no' for both located and mapped.
// Later this will call a model/service and may return 'yes' with confidence/reasons.

async function locateAndMap({ jobId, reportKey /*, files, db */ }) {
  return {
    located: 'no',
    mapped: 'no',
    locatedSource: 'ai',
    mappedCount: 0,
    totalFields: 0,
    message: null
  };
}

module.exports = { locateAndMap };


// Tier B: heuristic/AI assist (stub)
module.exports.locateAndMap = async function locateAndMap(ctx) {
  console.log(`[TierB] job=${ctx.jobId} report=${ctx.reportKey} files=${(ctx.files||[]).length}`);
  // For now: also "no"
  return { located: 'no', mapped: 'no', locatedSource: 'ai', mappedCount: 0, totalFields: 0, message: null };
};
