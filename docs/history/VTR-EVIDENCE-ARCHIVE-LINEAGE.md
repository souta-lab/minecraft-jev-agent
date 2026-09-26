# VTR Reach evidence archive — retained lineage

Recorded 2026-09-26 when `/home/s0u7a/vtr-evidence-archive` was pruned to the
latest accepted lineage (previously ~19 GB / 26 attempts). This document is the
durable record of what each deleted attempt proved; full artifacts survive only
for the retained pair listed last.

## Accepted authority attempts (deleted)

| Attempt | Source SHA | Run | Seed | Archive validation |
|---|---|---|---|---|
| `vtr-reach-authority-5acfd43-01` | `5acfd43a` | `run-muifmfch-1fhtn` | `5561042675159042621` | 140/140 PASS — first PBF-tree proof |
| `vtr-reach-authority-6b03ba5-01` | `6b03ba50` | `run-muhyzavr-qlj2` | `5557849939691426597` | 138 pass / 0 fail / 1 incomplete |
| `vtr-reach-authority-7d44bfd-01` | `7d44bfde` | `run-muidflnq-18i45` | `648981784027239626` | 138 pass / 0 fail / 1 incomplete |
| `vtr-reach-authority-87e66d2-01` | `87e66d22` | `run-muhx0uez-of22` | `-6738366832838009748` | 140/140 PASS |
| `vtr-reach-authority-c5a319d-01` | `c5a319d7` | `run-muhw9osr-njxz` | `2617726313477390578` | 140/140 PASS |
| `vtr-reach-authority-d180f28-01` | `d180f289` | `run-mui8k5y8-12a8a` | `8108948243556536257` | 140/140 PASS |
| `vtr-reach-authority-9628251-01` | `96282512` | `run-muhw2ycc-nbdy` | `-7498014102648787628` | 137 pass / 0 fail / 2 incomplete |
| `vtr-reach-authority-f02632b-01` | `f02632b` | — | — | no validation-report (partial attempt) |

## Live-conformance attempts (deleted)

- `vtr-reach-live-conformance-2b18378-01` — **PASS** (137/137): only accepted
  Phase-1 shadow-observer live conformance run on record.
- FAIL attempts (deleted): `28b539e`, `8f9a76c`, `a15e3d9`, `a6282f5`,
  `c3e4151`, `e1b35ba` — each failed on capture/mapping coverage gaps;
  historical rejection evidence only.

## Legacy-baseline raw runs (deleted)

`vtr-reach-legacy-baseline-*` for SHAs `5acfd43`, `6b03ba5`, `7d44bfd`,
`87e66d2`, `c5a319d`, `d180f28` (×2), `d5a42fa`, `df8398b` — raw
resident-host collect runs consumed by `tools/compare-vtr-reach.mjs` to produce
each authority attempt's `comparison/legacy-baseline.json`. Their comparator
output remains embedded in the retained archive for `83f44e5` and in the
deleted archives' recorded statuses above.

## Earlier evidence generation (deleted)

`evidence-20260925/` (~877 MB): pre-attempt-format raw runs and inspection
outputs (`vtr-reach-*` raw run dirs, focused-test logs, rebind snapshots).
Superseded by the attempt-format archive.

## Note on `9ddbadd`

Old `AGENTS.md` §8 required preserving a `9ddbadd` Phase-0 attempt root
(capture PASS / archive-validation FAIL). As of 2026-09-26 no such attempt
root exists anywhere under `~/vtr-evidence-archive` or `~` — only a stale
`/tmp/live-run-9ddbadd.log`. Phase-0 archive validation therefore remains
**FAIL with no inspectable artifact**; legacy Reach authority deletion stays
prohibited until a fresh Phase-0 archive validates.

## Retained (still on disk)

| Path | Contents |
|---|---|
| `attempts/vtr-reach-authority-83f44e5-01` | Latest accepted VTR Reach proof: source `83f44e5d`, run `run-muihx1lv-1lzff`, seed `3215552101730736439`, transition `bafec343-c139-407d-80d3-284411e82490`, validator **140/140 PASS / 0 fail / 0 incomplete**, `migrationMilestoneStatus: PASS` |
| `attempts/vtr-reach-legacy-baseline-83f44e5-01` | Same-seed/geometry legacy collect run `run-muii3j63-1mdew` consumed by the retained archive's `comparison/legacy-baseline.json` (`acceptanceEligible: true`, `evidenceClass: run-scoped-raw-events`) |

Regeneration path for a deleted-era proof: `git checkout <sha>` +
`bun tools/run-vtr-reach-live-probe.mjs --run` (see
`tools/run-vtr-reach-live-probe.mjs` HELP) + the legacy-baseline driver recipe
archived under the retained baseline attempt's `runner/drive-legacy-baseline.mjs`.
