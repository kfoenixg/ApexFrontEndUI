# Dev Mode (Mock AMAP Feed)

Dev Mode lets you simulate the “AMAP-fed” inputs without a live back end. It’s a modal opened from the footer **Dev Mode** button.

## What It Controls

- **Administrator** — e.g., *SS&C*, *Trident*, *Citco*.
- **Engagement** — shows **all** engagements; the option labels include the admin for clarity.
- **Routines** — the set AMAP is telling us to run. This is stored in `state.amapRoutineIds`.

## What Happens On Apply

- The **run-now** set (`state.selectedRoutineIds`) becomes an exact mirror of `state.amapRoutineIds`.
- The UI re-renders:
  - **Selected Routines** — checkboxes reflect run-now.
  - **Expected Reports** — derived from run-now routines, combining `required_files` while preserving any `required: true`.

This keeps behavior predictable: if AMAP changes, the run-now view refreshes to match it.

## Why It Exists

- To develop the front-end **without** waiting for the live AMAP feed.
- To demo different scenarios quickly (different admins/engagements, different routine sets).
- To guarantee deterministic defaults: the page starts fresh each visit (first engagement + all routines selected).

## Persistence

- The UI **does not** auto-load saved Dev Mode config on page load (by design for demos).
- If you later want to persist across reloads, call `loadDevConfig()` in `init()` (currently commented out).

## Interaction With Upload Flow

- The **Reports** card derives from run-now routines.
- On **Continue**, we:
  1. Create a **job** (`POST /api/jobs`).
  2. **Background-upload** staged files to `/api/upload` with `jobId`, `engagementId`, `routineCodes`, `reportKeys`.
  3. Navigate to the analysis page, which can immediately poll `/api/jobs/:id/status`.

## Edge Cases / Notes

- If you uncheck all routines in Dev Mode and click Apply, the run-now set becomes empty; the page will show no Expected Reports until routines are re-selected.
- If you change the engagement, the **header mini-summary** (Admin, Engagement, Period End) updates to match.
- The upload area accepts **CSV/XLS/XLSX**. Other files are ignored client-side and rejected server-side.
