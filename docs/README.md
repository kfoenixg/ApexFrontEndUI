# APEX Front-End — Developer Notes

This repo contains a vanilla HTML/CSS/JS front-end and a Node/Express mock API that simulates AMAP-fed data and a processing engine. It’s designed for fast UI iteration; the back-end team can later swap the mock API for the real one.

---

## Quick Start

Run from project root:

```powershell
C:\Development\node\node.exe server.js
```

App: http://localhost:3000  
Health check: http://localhost:3000/api/health


What’s Implemented (Today)
Pages
index.html — Data Import

Select routines (driven by Dev Mode’s AMAP feed).

Shows Expected Reports from selected routines (required vs optional).

Upload Files via drag-and-drop or picker (filename-agnostic).

Confirm Files for Upload with counts and Continue.

upload-analysis/* — Upload Analysis

Not wired yet for detectors UI. We simply navigate there.

On Continue, a job is created and files are background-uploaded, so the analysis page can immediately poll job status when it’s implemented.

Dev Mode (mock AMAP feed)
Pick Administrator and Engagement (all engagements shown; labels include admin).

Toggle which routines AMAP “fed” us.

On Apply, the run-now selection mirrors the AMAP-fed routines. The UI re-renders Selected Routines + Reports.

➡ See: docs/DEV_MODE.md for full details.

Pre-Upload + Job Flow (server-backed)
On Continue:

Save sessionStorage.apex-staged-list = minimal {name,size} list.

POST /api/jobs → store sessionStorage.apex-job-id.

POST /api/upload (fire-and-forget) with files + metadata + jobId.

Navigate to upload-analysis/upload-analysis.html.

By the time the analysis page loads, there’s already a job to poll and the uploads are underway.

API (Mock)
Lookups
GET /api/mock-lookups/administrators

GET /api/mock-lookups/engagements

Routines
GET /api/system/routines

Report Specs
GET /api/system/report-field-specs

GET /api/system/report-field-specs/:reportKey

GET /api/system/report-field-specs?keys=a,b,c

Learning (placeholder)
GET /api/system/learning

Work-order adapters
GET /api/institutions (administrators with nested engagements)

GET /api/institutions?mode=engagements

GET /api/reports (merged & de-duped across routines)

Jobs
POST /api/jobs → { ok, jobId, mode, createdAt }

GET /api/jobs/:jobId/status → { stage, percent, messages, fileCount }

GET /api/jobs/:jobId/results (after SUCCESS)

Uploads
POST /api/upload — multipart; accepts files[], jobId, engagementId, routineCodes, reportKeys

Data Sources
database.json

mock_lookups: administrators, engagements, custodians.

system_data.routines: list of routines and required_files[] with import.formats.

system_data.report_field_specs: field specs for SOI, prior-period SOI, P&S.

system_data.learning_data: scaffolding for learned mappings, knowledge base, attribute rules.

Front-End State (index)
state.amapRoutineIds: routines AMAP “fed” us via Dev Mode.

state.selectedRoutineIds: subset the user will run now (mirrors AMAP on Apply).

Expected Reports derive from selectedRoutineIds.

Upload area stages File[] and stores minimal info to sessionStorage on Continue.

Session Storage Keys
apex-staged-list — [{ name, size }, ...]

apex-job-id — job id from POST /api/jobs

Project Layout (relevant bits)

assets/                # logos
upload-analysis/       # analysis page (polling/detectors to be wired)
uploads/               # runtime uploads (gitignored)
docs/                  # documentation, screenshots, specs
samples/               # test CSV/XLSX
index.html
styles.css
script.js
server.js
database.json
Next Steps (Milestones)
Analysis page: read apex-job-id, poll /api/jobs/:id/status, show a progress bar.

Detectors (filename + report spec heuristics) — surface best-guess report mapping per file.

Data Preview / Mapping screen (header row, sheet selection).

Learning persistence (learning_data + IndexedDB).

Results dashboard (mock → real): KPIs and download links.

If you’re still reading this, you probably deserve a donut. 🍩



✅ That’s the whole file — now it’ll paste cleanly without breaking into multiple blocks.  

Want me to do the same for `docs/DEV_MODE.md` so you can drop it straight in?