# docs/

Repository documentation, organized by role per `architecture/TYPESCRIPT-PACKAGE-ARCHITECTURE.md` §10.
The constitutional entrypoints remain at the repository root: `README.md` and `AGENTS.md`.

- `architecture/` — current normative architecture. Canonical: `architecture/NEW-ARCHITECTURE-V4.1.2.md`;
  `architecture/v4.1/` holds the kernel contract prose mirroring `packages/kernel/` code.
- `decision/` — planner/Jev decision-plane boundaries and the observer read-model.
- `development/` — development method, definition of done, regression corpus,
  package-ownership map and bounded-improvement roadmap (`PBF-OWNERSHIP-MAP.md`).
- `history/` — superseded and dated material retained for provenance:
  `architecture/` (old architecture versions and authority models),
  `incidents/` (dated incident/defect reports),
  `investigations/` (surveys and audits), `milestones/` (closed-milestone evidence),
  `runs/` (checked-in historical run reports; generated output stays in root `runs/`).
- `jev/` — what Jev is and what the live evidence does and does not prove.
- `operations/` — resident runtime spec, acceptance runbooks, clean-run procedure, benches.
- `status/` — current status snapshot, TODOs, milestone ledger.
