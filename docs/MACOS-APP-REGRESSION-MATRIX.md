# MOZI.app Packaged Regression Matrix

This ledger implements GitHub Issue #514. The live Issue and Epic #506 remain authoritative. A row is complete only when its evidence comes from the packaged arm64 app, not a source-only server.

| Surface | Packaged evidence | Result | Defect |
| --- | --- | --- | --- |
| Launch, health, UI, graceful quit | `reports/desktop-packaged-matrix.json`, `output/desktop-matrix/packaged-workspace.png`, #523 | Pass: 26 checks; 5/5 navigation-race cycles; port released | #523 fixed by #524 |
| Auth, onboarding, provider setup | Fresh-home Chromium smoke; real App Support packaged login | Pass: current onboarding completes; desktop defaults to usable local email/password auth | #525 fixed by #526 |
| Chat, stream, retry, cancel, refresh | Full E2E 5/5; packaged real WebSocket provider attempt | Scripted paths pass. Real stream reached provider and surfaced the invalid DeepSeek key truthfully; credential update required | External provider credential |
| Sessions, memory, search, digests | 26-check packaged matrix; real migrated SQLite audit | Pass in isolated owner; migrated DB retains 40 sessions and 11 facts across existing identities; local login preserves the 34-session administrator | - |
| Files, upload, download, generated links | Packaged file API/download check; browser artifact smoke | Pass | - |
| DOCX/XLSX/PPTX/PDF generation and preview | #511 generation artifacts; final real capability endpoint | Pass: Python modules, generation, preview, soffice, Poppler, Docker, and ONLYOFFICE all true | #537 fixed by #538/#539 |
| Shell, browser, desktop, git, workers, sandbox | #511 real invocations; final capability endpoint | Pass with truthful limitation: Codex/Gemini ready; Claude unavailable until its credential file exists | - |
| Plans, tasks, scheduler, background work | Unit 2793/2793; integration 18/18; E2E 5/5; complex-task gate 2/2; packaged scheduler write | Pass | #531 fixed by #532 |
| Settings, admin, diagnostics, logs | Current Chromium Web UI smoke and screenshots | Pass | #533 fixed by #534 |
| Migration, upgrade, rollback, SQLite integrity | #510 backup/manifest evidence; final `PRAGMA integrity_check` | Pass (`ok`) | - |

## Final Owner Input

- The configured DeepSeek key is rejected as invalid. The packaged app surfaces an actionable Settings error; a valid key is required for the final real-model response in #515.
- External messaging channels, including follow-up #535, are explicitly deferred and do not block the local MOZI.app desktop channel.

Artifacts are stored under `reports/` and `output/desktop-matrix/`. Generated reports and screenshots are local evidence and are not committed unless an Issue requires them.
