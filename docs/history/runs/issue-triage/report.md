# Issue triage — reconcile issue state with landed code

- Date: 2026-09-21 (UTC)
- Base revision audited: `origin/main` = `d8d53c2` (worktree `task/issue-triage`, `/home/s0u7a/mc-ai-worktrees/issue-triage`)
- Runner: Bun 1.4.2 only (`bun install --frozen-lockfile`, `bun test`, `bun tools/*.mjs`)
- Live resident observed read-only: `AI_Buddy`, pid 1939257, run `run-muaxgdyk-15kc9`, m3-live worktree, log `/home/s0u7a/mc-ai-worktrees/m3-live/packages/buddy-driver/buddy.log`
- Shared checkout `/home/s0u7a/mc-ai` was **not** modified (it is on a diverged local `main`, see "Repo-state finding").

## Method

1. Confirmed every landed commit is an ancestor of `origin/main` (not just present in the local tree).
2. Read each candidate issue's acceptance criteria and checked the current `origin/main` code (`file:line`), not PR titles.
3. Ran the landed regression fixtures and the run-scoped M2/M3 gates on the live run (read-only).
4. Posted one evidence comment per issue with PASS/FAIL/UNKNOWN per criterion; closed nothing (no issue met full acceptance).
5. Scanned open issues for commit references that are not ancestors of `origin/main`.

Landed commits verified as ancestors of `origin/main`:

| Commit | Subject | Referenced by |
|---|---|---|
| `7164b92` | fix(obsidian): name-scan obsidian so `collect:obsidian` has a grounded route (#322) | #80 |
| `4928ca3` | feat(m3-gate): run-scoped 12-Eyes acceptance gate (#323) | #37 |
| `9331e91` | feat(nether): typed dimension transfer through the lit portal (#37) (#324) | #37 |
| `4d53aae` | chore(test): register dig-down-guard fixture script (#325) | (no owning issue) |
| `703c17d` | fix(safety): refuse MINE on the block the bot stands on | (no owning issue) |
| `de3f1ec` | fix(#78): bound stalled local recovery with `LOCAL_RECOVERY_EXHAUSTED` (#326) | #327, #78 |
| `d8d53c2` | fix(#80): retain a durable verified portal site (#328) | #80 |

## Verdict table

| Issue | State | Verdict | Action | Evidence |
|---|---|---|---|---|
| #80 M2 diamond→Nether gate | OPEN | Implementation PASS, live acceptance **UNKNOWN** | commented, **left OPEN** | M2 gate `status=UNKNOWN` exit 2 on `run-muaxgdyk-15kc9`; `diamond_ready=PASS`, materials/frame/lit UNKNOWN; #322 + #328 fixtures 7/7 and 9/9 |
| #37 M3/M4 roadmap (primitive #4) | OPEN | Primitive #4 + M3 gate **PASS (static+offline)**, M3 milestone **UNKNOWN live** | commented, **left OPEN** | `netherPortalPlan.ts:1323`, `candidates.ts:427`, `executor.ts:4253`; `test-nether-transfer.mts` ALL PASS; `test-m3-gate.mjs` 15/15; M3 gate `UNKNOWN` exit 2 |
| #327 local-recovery stall freeze | OPEN | Code PASS, live **FAIL/UNKNOWN** (freeze reproduces, no escalation marker) | commented, **left OPEN** | `replanThrottle.ts:281-315`, `controller-legacy.ts:4331-4376`, `test-stall-escalation.mts` 12/12; live `LOCAL_PROGRESS_STALL boundary=local_recovery` ~5.6 min, `LOCAL_RECOVERY_*` count 0 |
| #78 held-furnace/prereq (CLOSED historical) | CLOSED | Historical; #326 generalizes it | commented, **not reopened** | `de3f1ec` on main; live acceptance tracked in #327 |
| #79 unverified zero-progress (CLOSED historical) | CLOSED | Invariant PASS; original live acceptance **UNKNOWN**; closure not evidenced | commented, **not reopened**, recommended owner decision | `test-action-verify.mts` 12/12; M2 gate UNKNOWN; `closedAt=2026-09-19T17:20:35Z` with no closing evidence comment |
| #73 empty goal queue at iron rung (CLOSED historical) | CLOSED | Symptom superseded; original acceptance **not met** | commented, **not reopened** | live `rung=nether_portal`, non-empty queue; M2 gate UNKNOWN; `closedAt=2026-09-19T17:17:19Z` |
| #325/#703c17d dig-down guard | — | PASS (fixture registered + green) | no issue exists to comment | `packages/jev-agent/package.json:38`; `candidates.ts:362`, `executor.ts:1436`; `test-dig-down-guard.mts` all PASS |

No issue was closed: none met its full acceptance from landed + verified evidence.

## Per-criterion detail

### #80 — M2 diamond-to-Nether gate (OPEN)
- c1 `diamond>=3` + diamond pickaxe: **PASS (live)** — gate `diamond_ready: PASS`, facts `diamond=true diamond_pickaxe=true`.
- c2 flint_and_steel + obsidian>=10, obsidian refuses without diamond pickaxe: **UNKNOWN (live) / IMPLEMENTED** — #322 `state.ts:463` `DIRECT_BLOCK_SOURCES`, `:472` `scannedBlockNames`, `candidates.ts:2939` `retrievalWant`, `generation-entry.ts:964` durable known obsidian; tool gate from minecraft-data `harvestTools` (`state.ts:1074`); `test-obsidian-route.mts` 7/7 (case 2: no tool → no obsidian action). Live `flint_and_steel=false obsidian=false`.
- c3/c4 valid 4x5 frame + `PORTAL_FRAME_READY ... shape=ok` before lighting: **UNKNOWN (live) / IMPLEMENTED** — `netherPortalPlan.ts:39,498`; gate parses at `tools/m2-gate.mjs:149,223,247`. Live `frame=false`.
- c5 `PORTAL_LIT` + `PORTAL_VERIFIED=true` in overworld: **UNKNOWN (live) / IMPLEMENTED** — `netherPortalPlan.ts:43,45,716-718,823`. Live `lit=false`.
- c6 typed/bounded plan: **PASS (static)** — typed step/postcondition kinds, no inventory-count predicate.
- #328 durable verified portal site: **IMPLEMENTED + offline PASS** — `resident-types.ts:113`, `generation-entry.ts:403,487`, `state.ts:1515`; `test-portal-site.mts` 9/9. Live re-approach after respawn not yet observed.
- Required to close: one runId proving all four M2 stages in order; plus one post-respawn generation that re-approaches/enters the remembered site without rebuilding.

### #37 — M3/M4 roadmap (OPEN)
- Primitive #4 dimension transfer: **PASS (static + offline)** — `enter:nether_portal` / `dimensionIs` (`netherPortalPlan.ts:168,191`), `netherPortalEntryGoal` `:1323-1329`, `planPortalEntry` `:899`, `ENTER_PORTAL` candidate `candidates.ts:427,466`, executor requires live dimension change `executor.ts:4253,4305`; `test-nether-transfer.mts` ALL PASS (6 checks).
- M3 gate #323: **PASS (offline)** — `tools/m3-gate.mjs:55,66`; `test-m3-gate.mjs` 15/15 incl. cross-run isolation and fallback→UNKNOWN.
- M3 milestone acceptance: **UNKNOWN (live)** — `M3_RUN_RESULT status=UNKNOWN` exit 2, `ender_eye=0 dimension=minecraft:overworld`; no live `PORTAL_ENTERED` in the log.
- Primitives #1,#2,#3,#5,#6,#7: not delivered by these commits.

### #327 — local_recovery freeze (OPEN)
- Code: `replanThrottle.ts:51` (`N=6`), `:281-315` (rule 4, streak in `tryReplan`), `:195-222` markers; `controller-legacy.ts:4331-4376` emission + `-> wake System2`. `test-stall-escalation.mts` 12/12.
- Live: `GENERATION_READY` at 08:15:08Z (rung `nether_portal`, queue `smelt 1 x iron_ingot`); HEARTBEATs frozen at `pos=8.7,65.0,-9.3` with WAIT/SMELT/idle; `LOCAL_PROGRESS_STALL stalledMs=312254` (08:20:20Z) and `338933` (08:26:04Z), both `boundary=local_recovery`.
- Marker counts in the live log: `LOCAL_RECOVERY_NO_PROGRESS=0`, `LOCAL_RECOVERY_EXHAUSTED=0`, `REPLAN_THROTTLED=6`. All six `REPLAN_THROTTLED` lines are at 07:50–07:55Z under `BOOT source=7164b92` (pre-#326); the newest generation bundles (17:05–17:15 JST) do contain the escalation code, and after that the freeze produced no escalation marker at all.
- Required to close: `LOCAL_RECOVERY_NO_PROGRESS count=n/N` → `LOCAL_RECOVERY_EXHAUSTED count=N/N ... -> wake System2` → a new System2 decision → the WAIT loop breaks within a bounded wall-clock window, on an exact-source run.

### #73 / #78 / #79 — CLOSED historical issues
- All three were batch-closed 2026-09-19T17:17–17:20Z (their last evidence comments predate closure).
- #79's core invariant is landed and pinned (`test-action-verify.mts` 12/12), but its end-to-end live acceptance is still UNKNOWN (M2 gate exit 2).
- #73's literal symptom (empty queue at `rung=iron_ingot`) is superseded by the current live state (`rung=nether_portal`, non-empty queue), but its iron acceptance was never demonstrated live.
- #78 was explicitly out of scope for reopening; the landed #326 generalizes the same "local recovery makes no progress" idea, with live acceptance tracked by #327.
- Recommendation recorded in each comment; no state change was made unilaterally.

### #325 / #703c17d — dig-down guard (no owning issue)
- Fixture registered: `packages/jev-agent/package.json:38` (`dig-down-guard-test`).
- Code: `candidates.ts:362` `digsBotSupport`, `:371` `formatDigDownRefused`, `:1100` support-cell MINE withheld; `executor.ts:1436` refuses support-cell target.
- `bun test packages/jev-agent/test-dig-down-guard.mts` → all cases pass (controlled DESCEND preserved, unsafe MINE withheld, executor wired).
- No OPEN issue states this symptom, so no comment was posted.

## False-completion check

Scanned every OPEN issue body + comments for hex tokens and checked resolvability/ancestry against `origin/main`:

- **No open issue claims a landed fix that is absent from `origin/main`.** The only non-ancestor SHAs referenced by open issues are explicitly qualified branch/PR heads with "offline only / no live claim / compliance pending":
  - #56 → `b5f644d`, `7f6eb4a`, `e4a5b50`, `64e2792`, `871f6dc`, `eb6b7bf`, `fc9ff31` (PR/integration branches; comments say "resident remains on pre-merge source", "offline/integration evidence only").
  - #121 → `6a84d56` ("Full #121 compliance remains pending").
  - #136 → `8418052` (PR #174; `compliance=unknown`, "No live PASS is claimed").
  - #13 → `e2c8f09` ("closure still pending after source landing").
- Open issue #327 says `Fix (landed) de3f1ec` — that commit **is** an ancestor of `origin/main`; the issue also states the remaining live gap, so it is not a false claim.

## Repo-state finding (not modified)

- The shared checkout `/home/s0u7a/mc-ai` local `main` (`7736265`) has **diverged** from `origin/main` (`d8d53c2`).
  - local-only (not on `origin/main`): `b8e3fa7`, `336eb1a`, `3840972`, `7736265`.
  - `origin/main`-only (i.e. the landed fixes): `703c17d`, `4d53aae`, `de3f1ec`, `d8d53c2`.
  - No open issue references those local-only SHAs, so this is not a false-completion claim; it is reported here as risk (shared-tree `main` is not the landed revision).
- The live resident is running from `/home/s0u7a/mc-ai-worktrees/m3-live` at `d8d53c2`; it was booted earlier with `BOOT source=7164b92`, and its newest generation bundles contain the `d8d53c2` code.

## Deliberately not touched

- No issue was closed or reopened.
- No new issue was opened: the only live P1 symptom found (#327's freeze) already has an OPEN owning issue.
- The shared checkout, the live resident (`m3-live`), the control socket, and the Minecraft server were not modified or restarted; only read-only log/artifact reads and the read-only run-scoped gates were used.
- #226/#221/#299/#296/#308/#11/#13/#3 and the research issues were not touched: the landed commits above do not address their stated symptoms.
- Unmerged local-only commits on the shared tree were not integrated, rebased, or pushed.

## Exact `gh` commands run (comments)

```
gh auth status
gh repo view --json nameWithOwner -q .nameWithOwner
gh issue list --state open --limit 100 --json number,title,labels,updatedAt --template '{{range .}}#{{.number}} [{{.updatedAt}}] {{.title}}{{"\n"}}{{end}}'
gh issue view 80 --json number,title,state,labels,closedAt,body --template '...'
gh issue view 37 --json number,title,state,labels,closedAt,body --template '...'
gh issue view 73 --json number,title,state,labels,closedAt,body --template '...'
gh issue view 78 --json number,title,state,labels,closedAt,body --template '...'
gh issue view 79 --json number,title,state,labels,closedAt,body --template '...'
gh issue view 327 --json number,title,state,labels,closedAt,body --template '...'
gh issue view <n> --json comments --template '{{range .comments}}--- {{.author.login}} {{.createdAt}} ---{{"\n"}}{{.body}}{{"\n"}}{{end}}'   # 73,78,79,80,37,56,121,136,13
gh search issues --repo souta-lab/minecraft-jev-agent obsidian|"dig-down"|nether --limit 20 --json number,title,state
gh issue comment 80  --body-file /tmp/triage/c80.md
gh issue comment 37  --body-file /tmp/triage/c37.md
gh issue comment 327 --body-file /tmp/triage/c327.md
gh issue comment 78  --body-file /tmp/triage/c78.md
gh issue comment 79  --body-file /tmp/triage/c79.md
gh issue comment 73  --body-file /tmp/triage/c73.md
```

Posted comment URLs:

- #80 https://github.com/souta-lab/minecraft-jev-agent/issues/80#issuecomment-5757572973
- #37 https://github.com/souta-lab/minecraft-jev-agent/issues/37#issuecomment-5757573251
- #327 https://github.com/souta-lab/minecraft-jev-agent/issues/327#issuecomment-5757573540
- #78 https://github.com/souta-lab/minecraft-jev-agent/issues/78#issuecomment-5757573775
- #79 https://github.com/souta-lab/minecraft-jev-agent/issues/79#issuecomment-5757574028
- #73 https://github.com/souta-lab/minecraft-jev-agent/issues/73#issuecomment-5757574246

## Verification commands (read-only)

```
bun install --frozen-lockfile
(cd jev-agent && bun test ./test-obsidian-route.mts)         # 7/7
(cd jev-agent && bun ./test-nether-transfer.mts)             # ALL PASS (6)
(cd jev-agent && bun test ./test-dig-down-guard.mts)         # all pass
(cd jev-agent && bun test ./test-stall-escalation.mts)       # 12/12
(cd jev-agent && bun test ./test-action-verify.mts)          # 12/12
(cd buddy-driver && bun test ./test-portal-site.mts)         # 9/9
bun tools/test-m3-gate.mjs                                    # 15/15
bun tools/test-m2-gate.mjs                                    # 23/23
bun tools/lane-guard.mjs                                      # NO_DUPLICATES
bun tools/m2-gate.mjs --run run-muaxgdyk-15kc9 --snapshot-dir <m3-live data/resident> --log <m3-live buddy.log>   # UNKNOWN, exit 2
bun tools/m3-gate.mjs --run run-muaxgdyk-15kc9 --snapshot-dir <m3-live data/resident> --log <m3-live buddy.log>   # UNKNOWN, exit 2
```
