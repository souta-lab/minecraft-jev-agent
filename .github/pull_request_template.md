## Scope

Linked issue(s):

What changed, in one paragraph:

## Authority / state boundary

- [ ] Mechanics/world-truth semantics changed
- [ ] Safety/Guard/VERIFY semantics changed
- [ ] Jev π or β authority changed
- [ ] System2/planner authority changed
- [ ] Resident durable state / lifecycle / actuation ownership changed
- [ ] None of the above

Durable schema/ownership migration required? **yes / no** — details:

Rollout: **baseline / shadow / experimental / authoritative / no runtime behavior change**

## Evidence

Evidence class: **unit / deterministic fixture / integration / replay / structural smoke / resident soak / live embodied / closed-loop milestone**

Commands/results:

```text
<exact commands + counts>
```

Known-red baseline / no-new-regression:

- Baseline artifact: `tools/known-red-baseline.json` (record its `baselineId` and `baseCommit`)
- Current result artifact: `<path>` with `schemaVersion=1`, `commit`, and per-test `PASS|FAIL|UNKNOWN`
- Comparator: `node tools/known-red.mjs --baseline tools/known-red-baseline.json --current <path>`
- Result must be `PASS` or `PASS_WITH_WAIVER`; `FAIL` is a new regression and `UNKNOWN` is not a pass.
- Runner allocation/startup failures (`steps=[]`, no assertion executed) are `UNKNOWN`, not known-red tests.

Live acceptance required by the linked issue? **yes / no**

- [ ] completed in this PR/run artifact
- [ ] intentionally pending after merge; issue remains open / WAITING_LIVE
- [ ] not required

## Post-merge

- [ ] landed on latest main (or merge is the intended next step)
- [ ] reload/restart gate checked when runtime behavior requires it
- [ ] linked issue evidence state reconciled; merge alone was not treated as live acceptance
- [ ] remaining gap/follow-up is explicit

See `DEFINITION-OF-DONE.md`. Keep this template factual; do not turn it into a second design document.
