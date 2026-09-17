# DEVELOPMENT-METHOD.md: how this project is actually developed

Scope: a factual, reviewable description of the development *process* for `minecraft-jev-agent`
(`/home/s0u7a/mc-ai`), so an external reviewer can critique the methodology, not the code.

Evidence basis: `AGENTS.md`, `TODO.md`, `PLANNERS.md`, `ARCHITECTURE.md`, `RESIDENT-MODE.md`,
`tools/*.mjs`, `git log --oneline` (all branches), `git worktree list`, `git branch -r`,
`git ls-remote origin`, and live markers grepped from `buddy-driver/buddy.log`.

This document is a snapshot. Log counters below were read on 2026-09-18 from the live
`buddy-driver/buddy.log` (21.5 MB at read time). Anything not backed by a file, command, or log
marker is labelled `UNVERIFIED`.

Notation: every command and path is literal and re-runnable unless marked otherwise.

---

## 1. Purpose and actors

The project builds an embodied Minecraft agent. The development *process* is itself an experiment
in running an autonomous coding loop under a human-set objective, with an external reviewer
auditing it.

| Actor | Identity / venue | What it does | Authority | Evidence |
|---|---|---|---|---|
| Human user | `s0u7a`, owner of the local world and server | Sets standing orders and the final objective (M4: kill the Ender Dragon); mostly absent; protects the live host | Highest: can change the mission, the model/budget policy, and the priority order | `AGENTS.md` §0, `TODO.md` lines 117-128 |
| Supervising agent | Sisyphus / OpenCode at the repo root | Reads standing orders, picks the next lane from open issues, launches sub-agents, verifies lane evidence, merges one lane at a time, files new issues on live evidence | Operational lead; cannot inject goals into the live resident | `AGENTS.md` §0, §4; `ARCHITECTURE.md` line 485 (goal/milestone cannot be injected) |
| Delegated sub-agents | task categories `deep`, `quick`, `unspecified-*`, `writing`; plus `explore`, `librarian`, `oracle` | Implement a single lane inside a dedicated worktree; produce evidence per §3 | Scoped to the declared files of their lane | `TODO.md` lines 88, 112, 137; this task itself (lane `task/dev-method-doc`) |
| External reviewer "Sol" | Issues and PRs on the GitHub remote (`souta-lab/minecraft-jev-agent`) | Files code-level issues with root causes, audits architecture, merges via PRs | Advisory: drives the backlog and the canonical priority order | `ARCHITECTURE.md` lines 3, 180, 344-353; `RESIDENT-MODE.md` §13-0 line 195; branch `origin/sol/system2-ci-mercury`; PRs #2, #47, #51, #53 |

Notes on role boundaries:

- The supervising agent is explicitly told not to wait for the user and to find work when idle
  (`AGENTS.md` §0.2). See §6 for the failure this rule exists to correct.
- The external reviewer is named in `ARCHITECTURE.md` ("外部シニアレビュア（Sol）") and its
  recommendations are marked as canonical in places (`RESIDENT-MODE.md` §13-0 "外部レビュー改訂"
  supersedes §13).
- Sub-agent categories are named in `TODO.md` line 88 (`quick/unspecified-low`, `deep/oracle`)
  and line 112. `quick` has a recorded failure history (see §8.7).
- `explore`, `librarian`, `oracle` appear in `TODO.md` line 89 and line 113 as delegation targets
  for large research, to protect main-context budget. Their use is a budget measure, not a
  correctness measure.

---

## 2. The development loop as actually practised

The loop is written down in `AGENTS.md` §4.0 and §4.0-A, and is visible in `git log` and
`git worktree list`. Nominal shape:

```
issue (from Sol / backlog / live evidence)
  -> lane (one task)
  -> dedicated git worktree + branch, created from origin/main
  -> implement
  -> self-verification (tests + grep + live markers + push proof)
  -> push branch
  -> supervisor verification (gate tools, log counters)
  -> merge one lane at a time into main (no-ff), then push
  -> gate re-check on the live host (RELOAD ok=true + tools/verify-*.mjs)
  -> next lane
```

Real command shapes, quoted from `AGENTS.md` lines 112-127 and 132:

```bash
# lane start (from the canonical policy text)
cd /home/s0u7a/mc-ai
git fetch origin
git worktree add /tmp/opencode/wt-<task> -b task/<name> origin/main

# lane finish
git -C /tmp/opencode/wt-<task> add -A
git -C /tmp/opencode/wt-<task> commit -m "..."
git -C /tmp/opencode/wt-<task> push -u origin task/<name>

# land into main, one at a time
git fetch && git merge --no-ff origin/task/<name> && git push

# when the shared tree holds another task's WIP and cannot be touched
git push origin HEAD:refs/heads/tools/verify-mercury

# cleanup
git worktree remove /tmp/opencode/wt-<task>
```

Observed state that confirms the shape:

| Observation | Command | Result |
|---|---|---|
| Many concurrent lane worktrees | `git worktree list` | 12 entries: `/tmp/opencode/wt-fix12`, `wt-main`, `wt-merge-26`, `wt-merge-46`, `wt-pr2`, `wt19`, `wt43b`, `wt46`, `wt58`, `wtObs`, `wtPlace`, plus the shared tree |
| Lane branches | `git branch -a` | local `task/15-advisor-cache`, `task/19-plan-kinds`, `task/43b-fuel`, `task/46-order`, `task/58-flexible-prereq`, `task/agent-report`, `task/furnace-place`, `merge/26-simdeath`, `merge/46-order`, `fix/verify-issue12-spread` |
| Merge discipline | `git log --merges --oneline` | `Merge pull request #47 from souta-lab/merge/26-simdeath`, `#51 ... merge/46-order`, `#53 ... fix/verify-issue12-spread`, plus explicit `merge:` commits |
| Main is the build source | `git ls-remote origin main` | `d9c49ec... refs/heads/main` |
| Remote lane branches | `git ls-remote origin` | `origin/task/43b-fuel`, `origin/task/agent-report`, `origin/task/furnace-place`, `origin/sol/system2-ci-mercury` |

Important property of the loop: the live resident host is rebuilt from the working tree, not from
`main` as such. `AGENTS.md` lines 118-123 state that the host generates its bundle from the work
tree, and that a branch fix is not live until merged. Therefore "landed" is defined as merged into
`main`, and merging is done one lane at a time while no other task holds uncommitted files.

`UNVERIFIED`: the precise shell history of past lanes. The repository text and merge commits
strongly indicate the loop above, but raw shell transcripts are not retained in the repo
(`ARCHITECTURE.md` §6.7 notes this evidence gap explicitly).

---

## 3. Evidence standards

The rule is stated in `TODO.md` lines 136-137: each task must prove, with the following five
elements, or state clearly that it is incomplete ("成功偽装の禁止", faking success is forbidden).
`AGENTS.md` §0.4 requires primary evidence (log lines, inventory, commits), not opinion.

| # | Required proof | Concrete command / source | Example found in repo |
|---|---|---|---|
| a | Code exists at the changed location | `grep -rn '<symbol>' <file>` | `TODO.md` line 136 mandates it; commits cite file+symbol |
| b | Full test suite green, with counts | `npm run typecheck`, `guard-test`, `gating-test`, `loop-test`, `m1-test`, `audit-test`, `step-pipeline-test`, `movement-patch:check` (`jev-agent/package.json`) | `TODO.md` line 167: `typecheck / throttle 15/15 / audit 9/9 / guard 12/12 / loop 7/7 / m1 5/5 / issue43 11/11 / retrieval-body 10/10` |
| c | Branch actually pushed | `git ls-remote origin` | `AGENTS.md` line 136 mandates it; lane branches present under `refs/heads/task/*` |
| d | Live log lines for behaviour changes | grep `buddy-driver/buddy.log` for the named marker | see marker table below |
| e | Explicit statement of what remains | lane report must say if incomplete | `TODO.md` line 136; `ARCHITECTURE.md` lines 406-409 |

Marker vocabulary used as live proof (counts read from `buddy-driver/buddy.log` on 2026-09-18):

| Marker | Count | Meaning |
|---|---|---|
| `LADDER_RESUME` | 60 | inventory-aware ladder resume instead of restarting at wood |
| `PRECONDITION_PROTECTED` | 102 | a prerequisite goal was protected from abandon |
| `REPLAN_THROTTLED` | 18635 | replan suppressed by the #44 throttle |
| `RETURN_TO_KNOWN_RESOURCE` | 3122 | known-resource retrieval issued |
| `BETA_SHADOW` | 16973 | shadow `abandon_option` decision logged |
| `CAUSAL` | 16695 | end-to-end causal record |
| `RELOAD` | 245 | host reload attempts |
| `GENERATION_START` | 348 | generation starts |
| `GENERATION_STOP` | 535 | generation stops (with `ticks=N`) |
| `RECONNECT` | 77 | reconnect events |
| `FURNACE_READY` | 0 | never observed |
| `SMELT_DONE` | 0 | never observed |

The two zeros are included on purpose: they are the honest negative evidence for M2.

Why "reported success without evidence" is treated as failure:

1. The loop is autonomous and long-running; a false "done" silently poisons the backlog and the
   next lane. `ARCHITECTURE.md` §6.7 records delegated tasks cancelled after six minutes with no
   artifact.
2. The resident host cannot be driven by external goal injection
   (`ARCHITECTURE.md` line 485: "Goal/milestone CANNOT be injected externally: the only way to
   unstick the agent is a code fix"). So a lane that claims a fix but does not prove a live
   behaviour change leaves the agent stuck while appearing fixed.
3. Historical false positives are documented: `ARCHITECTURE.md` line 416 records a "STALE CLAIM"
   correction where "hot reload not delivered" and "all tests green" were both wrong.

---

## 4. Gate and verifier tooling

All tools are read-only, print no secrets, and live under `tools/`.

| Tool | What it measures | Decision it gates | Key evidence |
|---|---|---|---|
| `tools/buddy-status.mjs` | Host process count (`pgrep -af 'node agent-runner.mts'`, excluding bash wrappers), control-socket `report`, generations/reloads/recoveries/reconnects, `listenerLeak`, wedge, world memory, marker counts, latest acceptance/freeze artifact, last commit | Is the resident healthy and single-instance? Does it look stuck? | lines 19-27 (host filter), 47-50 (marker list), 105-126 |
| `tools/verify-issue12.mjs` | 6 checks: `ladder_prereq_present`, `no_1tick_rotation`, `generation_survives_100_ticks`, `digging_resumed`, `raw_iron_obtained`, `churn_reduced` | Is #12 (precondition chain) accepted? | lines 69-76; recent 10-min window at lines 25-40 |
| `tools/verify-issue13.mjs` | Samples the control socket `--samples` times; asserts no event listener count exceeds baseline, and `listenerLeak` is false in all samples | Is the #13 listener leak closed? | lines 35-62 |
| `tools/verify-mercury.mjs` | Mercury call records + advisor log: successful calls, no cache-hit-with-empty-plan, at least one non-empty plan, retry accounting present, no cached-strategy loop (`maxConsecutiveSameStrategy <= 2`) | Are #15/#30/#18 accepted? | lines 39-74 |
| `tools/replay.mjs` | Deterministic offline A/B over `logs/jev/decisions.jsonl`: Policy A = recorded action, Policy B = β-as-authority (`ESCALATE` when `beta >= threshold`); reports agreement rate, divergences, verified outcomes | Should β get authority (#23/#24)? | lines 1-46; `SCHEMA_VERSION=1`, `DEFAULT_THRESHOLD=0.5` |
| `tools/agent-report.mjs` (+ `tools/test-agent-report.mjs`) | Read-only report combining the control socket with `buddy.log`: identity, rung, current action, blockers, stuck heuristics, VERDICT | Is the agent stuck, and why? | commit `22b135e`; stuck thresholds at lines 34-41 |
| Per-lane `test-*.mts` suites | Pure unit/behaviour tests per lane | Lane-level correctness | `jev-agent/package.json`: `replan-throttle-test`, `issue43-test`, `option-spec-test`, `retrieval-stall-test`, `vertical-plan-test`, `predicate-goal-test`, `descend-plan-test`, `fuel-guard-test`, `skill-candidate-test`, `observability-test` |
| `tools/test-replay.mjs` | Offline fixture tests for the replay harness | Replay harness correctness | present in `tools/` |

Gate design flaws found and fixed (each is a real commit):

| Flaw | Symptom | Fix commit | Fix |
|---|---|---|---|
| Judging on all-time history | Pre-fix 1-tick stops poisoned the verdict forever | `5592f90` | Judge on a recent 10-minute window |
| Treating no generation stops as failure | A long-lived (healthy) generation produced an empty window, which failed the check | `b3d1f9c` | "No stops in window" is healthy; use all-time `maxTicks` as fallback |
| Treating 0 churn as failure | The goal (no churn) registered as FAIL | `ce62256` | `churn_reduced` passes at 0 generations per 5 min |
| Over-strict smoke test | `RELOAD ok=false ... smoke test failed: empty plan and no completed goals` blocked hot reload | `ARCHITECTURE.md` lines 284-285; `RESIDENT-MODE.md` §13-0 P1 | Split structural smoke (must pass with empty plan) from mission preflight |
| Cache-loop window not anchored | All-time counts included the pre-fix loop | `a663d08` | Anchor counting after the first `ADVISOR_CACHE_GUARD` marker |
| Verifier spread of a huge timestamp array | `verify-issue12` could exhaust the stack on a multi-MB log | `5689214` (PR #53) | Reduce the timestamp array instead of spreading it |
| Missing-ledger crash on resume | Reload crash when no ledger snapshot existed | `20b6092`, merged in `8265aeb` | Guard the missing ledger in the resume path |

Residual gate issue: `verify-issue12.mjs` reads the single shared `buddy.log`. A lane's counter
window is therefore global, not per-lane (see §10).

---

## 5. Safety and discipline rules

| Rule | Statement | Source |
|---|---|---|
| Never checkout/merge/cherry-pick in the shared tree | The live host rebuilds the bundle from the work tree, so a checkout would run another branch's code and break other tasks' edits | `AGENTS.md` lines 112-131; commit `15a77f6`; incident below |
| Host-layer lanes serialized | Only one lane at a time may touch `buddy-driver/agent-runner.mts`, `buddy-driver/resident-types.ts`, or `buddy-driver/package.json` | `AGENTS.md` §4.0-A; commit `f53d7ee`; conflict precedent #26/#34 vs #27/#28 |
| Abort and delegate on conflict | Resolve conflicts inside the lane worktree, report the merged branch, then land one at a time | `AGENTS.md` lines 104-105; `git cherry-pick --abort` in `TODO.md` line 147 |
| No force-push, no history rewrite | Explicitly forbidden | `AGENTS.md` line 128 |
| No secrets | Never print anything under `/home/s0u7a/.config/kimaki-secrets/`; tools are "read-only, no secrets printed" | `AGENTS.md` line 148; headers of `verify-mercury.mjs`, `buddy-status.mjs`, `agent-report.mjs` |
| No `any`, no `@ts-ignore` | Forbidden in the resident code | `RESIDENT-MODE.md` §13-0 line 214; `AGENTS.md` line 56 of `RESIDENT-MODE.md` §1 |
| One host process | `tools/buddy-status.mjs` asserts `hostCount === 1`; kill by PID only, because `pkill -f` self-matches | `AGENTS.md` lines 139, 146; `buddy-status.mjs` lines 19-27, 80 |
| `simdeath` never used against the resident | A rehearsal rewinds live progress, so use a separate bot or a non-destructive mode | `TODO.md` line 138; commit `90d57f8` (soft mode default, `--hard` opt-in) |
| Destructive ops forbidden | No server stop, world deletion, history rewrite, or force push while unattended; `worldreset` is not used | `AGENTS.md` §0.6, lines 146; `ARCHITECTURE.md` line 486 |

Observed rollback proof (the discipline rule that paid off):

`TODO.md` lines 142-151 record a real incident. A lane commit was `git cherry-pick`ed into the
shared tree, produced conflict markers, and the host rejected the broken bundle:

```
RELOAD ok=false trigger=source-changed ms=12 message=Build failed:
  ../jev-agent/src/executor.ts:709:2: ERROR: Unexpected "<<"
```

The host kept the old generation running, so downtime was zero. Recovery was
`git cherry-pick --abort`, return to `beac6f6`, `typecheck ok`, then
`RELOAD ok=true skipped=unchanged`. The recorded lesson: never cherry-pick or merge in the main
tree; always do integration in a worktree. Earlier, `ARCHITECTURE.md` lines 282-284 also show the
host rejecting bad generations (`pos.floored is not a function`, smoke-test failures) while
staying up.

`UNVERIFIED`: that every historical lane obeyed the host-layer serialization rule. It is stated
as policy and has one documented violation, but a full audit of parallel lane file sets is not
recorded.

---

## 6. Autonomy and its limits

Standing orders (`AGENTS.md` §0, `TODO.md` lines 117-128):

- Final goal is M4 (Ender Dragon). M2 is a waypoint.
- Do not wait for the user. If there is nothing to do, invent the next work.
- Keep primary evidence (log lines, inventory, commits). Do not claim success from opinion.
- Commit and push in small units, with a secret scan.
- Stop condition: the Nether portal is built and all open issues are resolved (`TODO.md` line 119).

Recorded failure of "monitoring-only" periods:

`TODO.md` lines 130-135 and commit `eaa2c3c` record that between 05:00 and 07:30 there were no
additional commits: after a fuel fix landed, the loop only watched the descent. The corrective
action was to launch four lanes at once (`#26/#34`, `#27/#28`, `#30/#33`, `#40`), and to add the
rule "never let commits stall; always start the next lane". This is an honest process defect: the
autonomy rule was not followed by the supervising agent, not a missing capability.

Model and budget constraint (`TODO.md` lines 94-115):

- Active model: `opencode-go/deepseek-v4.1-flash` for both `model` and `small_model`
  (`/home/s0u7a/.config/opencode/opencode.jsonc`).
- Instruction: stay on `opencode-go` for about 16 hours; `commandcode` is also rate-limited, so
  switching is not available. A fallback procedure to `commandcode/deepseek-v4.1-flash` is
  documented but deliberately not pre-applied, because editing config can drop the running session.
- Token frugality while limited: no polling (start a task and wait for notification), short
  replies, delegate large research to `librarian`/`explore`, collapse gate checks into one
  `tools/*.mjs` command, do not read long transcripts (verify from artifact files).
- Explicit constraint: frugality must not reduce quality (`TODO.md` line 81: only save cost in
  ways that do not lower capability or correctness).

Limits of autonomy:

- The agent cannot be steered by injecting goals; only a code fix unsticks it
  (`ARCHITECTURE.md` line 485).
- Exactly one host process is allowed; two hosts cause mutual disconnects (§8.1).
- The host must not be reloaded while WIP exists in the tree it builds from.
- `UNVERIFIED`: whether the 16-hour budget window was actually respected end to end; the config
  and the instruction are the only evidence.

---

## 7. Issue-driven workflow

The backlog is issue-driven, and the external reviewer supplies code-level root causes.

- `ARCHITECTURE.md` §5.5 lists "Sol audit derived applied items" (bounded question sets, boolean
  uncertainty band, action-only authority, trigger priority, epoch/hash staleness checks,
  monotonic subgoal ledger, `PlanOp`).
- `ARCHITECTURE.md` §8 lists seven open questions for the reviewer to redirect.
- `RESIDENT-MODE.md` §13-0 is titled "外部レビュー改訂" and explicitly supersedes §13, fixing the
  priority order.
- PRs are opened from `souta-lab` branches (`Merge pull request #47`, `#51`, `#53`); one open PR is
  `#2` (CI + bounded Mercury adapter), recorded as mergeable but blocked on red CI
  (`ARCHITECTURE.md` line 492).

Pinned priority order (canonical):

1. `RESIDENT-MODE.md` §13-0 (`P0` green build, `P1` atomic generation swap, `P2` freeze/resume,
   `P3` M1 golden regression, `P4` 2-block movement fixture, `P5` Jev shadow then authority,
   `P6` M2 ladder). `ARCHITECTURE.md` line 9 states this supersedes its own §7 order.
2. `AGENTS.md` §2 priority list (`#5/#13/#28/#38/#40` safety first, then `#11` skeleton, then
   shadow/eval, then Mercury correctness, then `#24`, M2, `#35`, `#41`, M3/M4).
3. `TODO.md` "critical path" (current operational head).

How issues are closed or kept open:

| Issue | Outcome | Evidence |
|---|---|---|
| `#15` cached-strategy loop | Closed as green | `TODO.md` lines 178-184: `verify-mercury` PASS 5/5, `maxConsecutiveSameStrategy=2` (was 112), `bypasses=5`, `refusals=9` |
| `#13` listener leak | Addressed; `listenerLeak=false` observed | `TODO.md` line 210; `verify-issue13.mjs` is the gate |
| `#12` precondition chain | Kept open | `TODO.md` line 151: gate 5/6, only `raw_iron_obtained` remains |
| `#44` replan spin | Landed (churn 27 -> 1) | `TODO.md` lines 163-169 |
| `#14` known-resource retrieval | Landed, but iron not obtained | `TODO.md` lines 153-159, gate 5/6 |

New issues are filed from live evidence, not speculation. Examples: `#43` was opened from a live
observation that inventory already held `charcoal:1` while the plan still scheduled charcoal
(`TODO.md` lines 188-189); `#44`, `#45`, `#46` were opened from the spin, the retrieval stall, and
the furnace-abandonment observations respectively.

---

## 8. Observed failure modes and mitigations

This is the honest core of the document. Each row gives symptom, evidence, mitigation, and whether
the mitigation is verified.

### 8.1 Duplicate host processes causing mutual kicks

- Symptom: two resident hosts logged in as `AI_Buddy` kick each other, each reconnect kicks the
  other in a loop.
- Evidence: `buddy-driver/buddy.log`
  `[2026-09-17T15:36:51.299Z] ERROR where=bot.kicked ... "multiplayer.disconnect.duplicate_login"`
  and a second occurrence at `15:36:56.350Z`.
- Mitigation: a `HOST_LOCK` file (`data/resident/host.lock`), the single-instance assertion in
  `tools/buddy-status.mjs` (`hostCount === 1`), and the kill-by-PID rule (never `pkill -f`).
  Evidence of the lock working: `[2026-09-17T23:27:12.337Z] HOST_LOCK acquired pid=320397
  path=.../host.lock`.
- Verified: partially. The lock and the status assertion exist and the lock has been observed
  acquired. A dedicated regression test that two hosts cannot both hold the lock is not present in
  `tools/` (`UNVERIFIED`).

### 8.2 Cached-strategy loop (112 consecutive identical cached strategies)

- Symptom: the advisor replayed the same cached strategy forever, so the body never moved; the
  agent looked alive but issued no new action.
- Evidence: `TODO.md` line 9 ("同一cached戦略が112回連続"); `verify-mercury.mjs` reproduces the
  historical loop with `--all`.
- Mitigation: `ADVISOR_CACHE_GUARD`, bypass of repeated no-progress strategies, grounding refusals
  of inapplicable strategies (`#15/#29`), plus a temporary config escape
  (`system2.config.json` `{"mercury": true}`).
- Verified: yes. `TODO.md` lines 178-184: `verify-mercury` PASS 5/5, `maxConsecutiveSameStrategy=2`
  after the guard, `bypasses=5`, `refusals=9`.

### 8.3 WAIT limit that became a replan loop (churn 1 -> 27 per 5 min)

- Symptom: a WAIT-cooldown counter turned each WAIT into a replan, which re-emitted WAIT, producing
  generation churn and no progress.
- Evidence: `TODO.md` line 173 (`gensLast5min は 1→7→17→27 と悪化`, `generations=401`,
  `recoveries=206`, `POS` unchanged), and a manual `FREEZE`.
- Mitigation: issue `#44`: replan throttle (same `(reason, stateHash)` at most once per 10 s
  window), a new-information gate, a body-delta requirement, and grounding of known-resource
  retrieval. Live counter `REPLAN_THROTTLED=18635`.
- Verified: yes for the loop. `TODO.md` line 165: `gensLast5min=1 (27 -> 1)`; issue #12 gate
  recovered to 4/6 and then 5/6.

### 8.4 Generations dying after 1 tick

- Symptom: the plan head required a precondition (for example `smelt 3 x iron_ingot` needing a
  furnace and `raw_iron`) that was missing, so the generation stopped after a tick and the host
  recovered it into the same impossible goal, a roughly 10-15 s rotation.
- Evidence: `ARCHITECTURE.md` update lines 461-470: `PRECONDITION_MISSING=133 LADDER_PREREQ=0`,
  `generations=213 recoveries=88`, `TOOL_CHOICE/DIG_PATH/JUMP_ATTEMPT/DESCEND_LIMIT` all zero.
- Mitigation: issue `#12` replaces the plan with the prerequisite chain from live inventory
  (`LADDER_PREREQ goal=... need=... -> replace goals=[...]`), stops only when provably
  unsatisfiable, and does not stop again for at least 20 ticks.
- Verified: partially. Positive: `LADDER_PREREQ=176`, `PRECONDITION_PROTECTED=102`,
  `maxTicks=794` (`TODO.md` line 158). Negative: `TODO.md` line 210 says the 1-tick stop
  "remains", and `raw_iron_obtained` is still failing.

### 8.5 A simdeath rehearsal reset the live ladder to wood

- Symptom: an operator rehearsal of death recovery reset the live rung to wood and discarded
  held materials, rewinding real progress.
- Evidence: `buddy-driver/buddy.log`
  `LADDER_RESET reason=death invEmpty=true cause=simulated simulated=true` immediately followed by
  `LADDER_RESET reason=death invEmpty=true rungIndex=0 rungId=wood goals=["collect 3 x log","craft 1 x wooden_pickaxe"]`.
- Mitigation: commit `90d57f8` adds a soft `simdeath` mode (default) that snapshots the ledger,
  milestone, and hazard memory, exercises the death path, then restores them; `--hard` keeps the
  old destructive semantics and is opt-in. Simulated hazards are written to a non-durable
  rehearsal namespace with `HAZARD_SKIPPED source=simulation`. `TODO.md` line 138 forbids
  rehearsals against the resident at all. Commit `826cb4e` makes ladder resume inventory-aware so
  materials held are not lost ("never restart at wood with materials held").
- Verified: mitigations present and merged (`PR #47`). The restore path is logged
  (`SIMDEATH_RESTORE`, `DEATH rehearsalMode=`) per the commit message. `UNVERIFIED`: an
  independent log capture of a soft `simdeath` restoring the exact pre-rehearsal ladder.

### 8.6 Stale integration branch invalidated by later merges

- Symptom: an integration branch resolved conflicts, but `main` advanced underneath it, so the
  integration had to be re-merged before it could land.
- Evidence: repeated merge commits
  `Merge remote-tracking branch 'origin/main' into task/20-integrate2` (`fc0c5b1`),
  `into task/45-integrate` (`d5c25b5`), `into task/21-optionspec` (`9cc9007`),
  `into merge/46-order` (`4050da8`), `into merge/26-simdeath` (`93de286`).
- Mitigation: merge `main` into the lane worktree, resolve conflicts there, then land the resolved
  branch one at a time (`AGENTS.md` lines 104-105). Host-layer file serialization (commit
  `f53d7ee`) reduces the frequency.
- Verified: yes at the level of "it lands", by the existence of the re-merge and the following
  merge commits. No metric tracks how many re-merges a lane needed.

### 8.7 `quick`-category lanes returning empty

- Symptom: `quick` sub-agent lanes sometimes produced no artifact.
- Evidence: `TODO.md` line 137: "quickカテゴリは空振り実績があるためコード変更はdeepを使う"
  (quick has a history of empty results, so code changes use deep).
- Mitigation: route code changes to `deep`; delegate only cheap work to `quick`.
- Verified: operationally as a routing policy; there is no tracked count of empty quick lanes
  (`UNVERIFIED` rate).

### 8.8 Worktree and merge conflict treadmill

- Symptom: parallel lanes repeatedly collided on the same files, creating merge conflicts and
  re-integration work; one collision produced a broken shared tree and a failed reload.
- Evidence: `AGENTS.md` §4.0-A lines 100-102 cites `#26/#34` and `#27/#28` colliding on
  `agent-runner.mts` and `package.json`, forcing a merge abort. The cherry-pick incident in
  `TODO.md` lines 142-151 produced `<<<<<<<` markers and `RELOAD ok=false`.
- Mitigation: serialize host-layer lanes, declare owned files before starting, integrate inside a
  worktree, keep `main` buildable, and never merge in the shared tree. The host's generation
  contract (build, import, smoke, then swap) turns a bad bundle into a rejected reload instead of
  a crash.
- Verified: yes for containment (zero-downtime rollback observed); the treadmill itself persists as
  process overhead (see §10).

---

## 9. Metrics in use

| Metric | Definition | Source / command | Observed value |
|---|---|---|---|
| Generation churn | `GENERATION_START` count in the last 5 minutes, target `<= 3` | `tools/verify-issue12.mjs` (`gensLast5min`); `buddy-status.mjs` | 27 before #44, 1 after (`TODO.md` lines 165, 173) |
| Ticks per generation | `ticks=N` in `GENERATION_STOP` | `verify-issue12.mjs` lines 36-40 | `maxTicks=794` (`TODO.md` line 158); 1-tick residual still noted |
| Reconnect count | `stats.reconnects` and `reconnectsLastHour` from the control socket | `buddy-status.mjs` lines 87-88 | 77 `RECONNECT` markers in `buddy.log`; `#27` recorded `reconnects=65` (`TODO.md` line 31) |
| Listener-leak flag | `listenerLeak` boolean plus per-event listener counts vs baseline | `tools/verify-issue13.mjs`; `buddy-status.mjs` line 93 | `listenerLeak=false` (`TODO.md` line 210); `RELOAD` lines show `listeners={"physicsTick":2,...} listenerLeak=false` |
| Gate pass counts | pass/total from each verifier | `verify-issue12/13/mercury.mjs` | #12 `5/6`; #13 is 2 checks; Mercury `5/5` |
| Cost per Mercury call | `cost` field in `mercury-calls.jsonl` | `tools/verify-mercury.mjs` reads it | `cost=0.000281`, `cost=0.000289`, `cost=0.000329` (`TODO.md` line 11; `ARCHITECTURE.md` line 444) |
| Jev call cost | mean cost per Jev call from `jev-calls.jsonl` | `ARCHITECTURE.md` lines 80 | about `$0.00018/call`, p50 latency 410-720 ms |
| M1 milestone | 4/4 subgoals, `llm.called==false`, wedge 0 | `README.md`; `jev-agent/logs/m1-fresh2-console.log`; `ARCHITECTURE.md` §5.1 | `planned=4 done=4`, `with_llm_called_true=0`, `verifiedDigs=22` |
| M2 milestone evidence | iron obtained, proven by inventory | `buddy.log` `LADDER_RESUME ... inventory={...,"raw_iron":8,...}` and `HEARTBEAT ... inv={...,"raw_iron":8,...}` | `raw_iron:8`, charcoal smelted 2026-09-18 00:13 JST (`README.md`); `FURNACE_READY=0`, `SMELT_DONE=0` |
| Stuck heuristics | movement < 5 blocks, action repeats >= 8, no inventory change >= 10 min, abandons >= 3 in a 30-min window | `tools/agent-report.mjs` lines 34-41 | tool exists; VERDICT output is its gate |

Honest reading of the metrics: the improvement signals (churn down, ticks up, digging markers
nonzero) are real, but the milestone signal for M2 is still negative (`FURNACE_READY=0`,
`SMELT_DONE=0`, `raw_iron_obtained` failing). A churn metric of 0 can also mean the agent is
frozen rather than productive, which is why `#44` used `FREEZE` deliberately and why
`verify-issue12` now treats a long-lived generation as healthy.

---

## 10. Open methodological questions for the reviewer

1. Is the parallel-lane model scaling? `git worktree list` shows 12 worktrees and `git branch -a`
   shows many lane branches, yet the host layer must be serialized. Is the throughput gain worth
   the conflict overhead, or should lanes be capped and serialized entirely?
2. Should gates be per-lane or global? `tools/verify-issue12.mjs` reads one shared `buddy.log` and
   judges a recent window, so concurrent lanes contaminate each other's counters. Should each lane
   emit its own machine-readable acceptance record, as `RESIDENT-MODE.md` §13-0 P1 already
   proposes, and should gates read that instead?
3. How should autonomy and supervision be balanced? The recorded 2.5-hour monitoring gap
   (`eaa2c3c`) was corrected by a rule, not a mechanism. Is a hard "no commits in N minutes"
   circuit-breaker warranted, or is that itself a source of busywork?
4. Is the evidence-first rule too heavy or too weak? Five required proofs per lane (grep, full
   suite, push, live markers, remainder statement) are strong, yet M2 is still not proven and
   `FURNACE_READY`/`SMELT_DONE` are zero. What is the right evidence bar for "progress" versus
   "completion"?
5. Is the merge treadmill a symptom of missing CI or of the worktree policy? PR `#2` (CI) is open
   with red CI and `main` merges rely on the live host as the integration test. Would per-PR CI
   with the gate tools remove the re-merge cycle, or would the live-only acceptance requirement
   keep it?
6. Does a metric like generation churn reward the wrong thing? Zero churn can mean a frozen or a
   healthy long-lived generation. How should productivity be measured per unit cost (the TODO
   proposes "cost per meaningful progress")?
7. Is "no external goal injection" the right design for long autonomy? It forces every unstick to
   be a code change, which is safe but slow. Is there a bounded, auditable injection channel that
   preserves the safety property?
8. Is the issue-ownership model sufficient? Host-layer serialization is a convention with one
   documented violation. Should file ownership be enforced mechanically (for example a
   pre-commit or lint rule) rather than by convention?

---

## Appendix A: file and command index

| Item | Path |
|---|---|
| Standing orders | `AGENTS.md` §0, §2, §4 |
| Backlog / current critical path | `TODO.md` |
| Layer responsibilities | `PLANNERS.md` |
| As-built architecture and evidence | `ARCHITECTURE.md` |
| Resident-mode canonical requirements | `RESIDENT-MODE.md` |
| Gate tools | `tools/buddy-status.mjs`, `tools/verify-issue12.mjs`, `tools/verify-issue13.mjs`, `tools/verify-mercury.mjs`, `tools/replay.mjs`, `tools/agent-report.mjs`, `tools/test-replay.mjs`, `tools/test-agent-report.mjs` |
| Lane tests | `jev-agent/test-*.mts`, `jev-agent/data/step-pipeline-test.mts` |
| Live host log | `buddy-driver/buddy.log` |
| Mercury call records | `buddy-driver/logs/jev/mercury-calls.jsonl` |
| Jev call records | `buddy-driver/logs/jev/jev-calls.jsonl` |
| Control socket | `buddy-driver/data/resident/control.sock` (0600) |
| Branch model | `git worktree list`; `git ls-remote origin` |

## Appendix B: status of claims

- VERIFIED: actor roles, lane command shapes, merge discipline, tool behavior, marker counts,
  gate fixes, safety rules, the rollback incident, the failure modes with log or commit evidence,
  the metrics with source files.
- `UNVERIFIED`: shell history of past lanes; a lock-regression test for duplicate hosts; an
  independent log capture of a soft `simdeath` restore; the empty-`quick` rate; end-to-end
  adherence to the 16-hour budget instruction; the exact number of crafting tables in the world.
- Not assessed here: code-level correctness of the agent stack. This document is about method.
