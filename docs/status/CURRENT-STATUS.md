# Current Status

Generated from real evidence only. Every section is labeled EVIDENCE or UNKNOWN; no value is invented.

## Base commit (origin/main) — EVIDENCE
- sha: `65a69dea19360c4a122d39c70096d477c4a73768`
- subject: Require floor occupancy for staircase waypoints
- date: 2026-10-08T19:44:33+09:00

## Open pull requests — EVIDENCE
- count: 0
- no open pull requests

## Open issues — EVIDENCE
- count: 0
- P0: 0
- P1: 0
- priority source: labels first, then title prefix (0 counted from title only)
- labels: no labels
- no open issues

## Resident snapshot — UNKNOWN
live: unavailable

## CI gate (repo-invariants) — EVIDENCE
- verdict: INFRA_UNKNOWN
- run: 37765476919
- head: 65a69dea19360c4a122d39c70096d477c4a73768
- jobs: 0/5 executed at least one step
- reason: no job executed a single step (5/5 never started)
- job convergence: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job core-deterministic: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job system2-harness: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job jev-harness: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- job authority-contract: INFRA_UNKNOWN (0/0 executed steps, raw conclusion=failure)
- NOTE: no job executed a step. This run is NOT a code verdict (issue #299).
- NOTE: do not cite GitHub Actions as a passing or failing gate for this head until the workflow actually runs.

## Evidence commands — EVIDENCE
- `git log -1 --format=%H%n%s%n%cI origin/main`
- `gh pr list --state open --limit 1000 --json number,title,headRefName`
- `gh issue list --state open --limit 1000 --json number,title,labels`
- `socket /home/s0u7a/mc-ai/packages/buddy-driver/data/resident/control.sock <- {"cmd":"report"} (2000ms timeout)`
- `gh run list --workflow=repo-invariants.yml --limit 1 --json databaseId,headSha,createdAt,conclusion,headBranch`
- `gh api repos/souta-lab/minecraft-jev-agent/actions/runs/37765476919/jobs`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/113271966300/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/113271966614/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/113271966634/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/113271966637/annotations`
- `gh api repos/souta-lab/minecraft-jev-agent/check-runs/113271966677/annotations`
