// test-repeated-outcome-escalation.mts - the cross-action bound on one action's
// own bounded outcome repeating at the same target.
//
// THE MEASURED CLASS (live `m3-live` record, 1.34M lines, read-only):
//
//   ASCEND:habitat:p3_68_22 - 184 typed failures / 161 attempts in 24m38s AT ONE
//   CELL (2026-09-21T19:55:26 -> 20:20:04), interleaved with PILLAR_UP_STEP
//   successes, and NO cross-action escalation ever emitted:
//     PILLAR_FAIL step=apex reason=apex_missed  160
//     PILLAR_FAIL step=place reason=refused      23
//     PILLAR_FAIL step=apex reason=apex_timeout   1
//     PILLAR_RETIRE 0   PILLAR_RELOCATE 0
//     ACTION_FAILURE_REPEAT 0   ACTION_FAILURE_EXHAUSTED 0
//     LOCAL_RECOVERY_EXHAUSTED 0   LOCAL_OSCILLATION_BOUNDARY 0
//     PLACE_RETRIES_EXHAUSTED 1 (whole run)
//   The settled outcomes at that one (action, cell) ALTERNATED
//   `failed/unverified/none` (184) with `done/verified/body` (200) and BOTH
//   carried `progressDelta=0`: the `done` is the rise half of the same attempt
//   whose placement the server refused.
//
// This fixture pins the four required behaviours:
//   (i)   the measured shape: the same action with no state change N times at one
//         cell -> retired/relocated exactly ONCE, typed, and the count DURABLE
//         across a generation swap;
//   (ii)  control: each attempt carries a NEW fact -> never retired;
//   (iii) control: the outcome differs between attempts -> never retired;
//   (iv)  the bound is stated in ONE place and reused, never re-derived.
//
// No bot, no network, no clock (every timestamp is injected).
//
// Run: cd jev-agent && bun ./test-repeated-outcome-escalation.mts
import { readFileSync } from 'node:fs'
import {
  ACTION_REPEAT_EXHAUSTED_MARKER,
  ACTION_REPEAT_MARKER,
  ACTION_TARGET_RETIRED_MARKER,
  actionShapeOf,
  filterRetiredRepeats,
  formatActionRepeat,
  formatActionRepeatExhausted,
  formatActionTargetRetired,
  isRepeatTrackedKind,
  RepeatedOutcomeEscalation,
  repeatedOutcomeCell,
  repeatedOutcomeFactSignature,
  repeatedOutcomeKey,
  repeatedOutcomeSemanticProgress,
  repeatedOutcomeToken,
  REPEATED_OUTCOME_LIMIT_DEFAULT,
  resolveRepeatedOutcomeLimit,
  restoreRepeatedOutcomeEntry,
} from './src/repeatedOutcomeEscalation.ts'
import { reachabilityFingerprint, reachabilityTargetSignature } from './src/reachability.ts'
import type { ReachabilityFingerprintInput } from './src/reachability.ts'

// --- the harness (matches test-zero-progress-route.mts) --------------------------

interface CaseResult {
  pass: boolean
  detail: string
}

const cases: Array<{ name: string; run: () => CaseResult }> = []

function addCase(name: string, run: () => CaseResult): void {
  cases.push({ name, run })
}

function ok(condition: boolean, detail: string): CaseResult {
  return { pass: condition, detail }
}

// --- the measured shape, reduced to its facts -----------------------------------
//
// One cell, one action shape, one target. The body rises one block inside the
// attempt and falls back; the rise reports `progress=body`, the placement is
// refused. None of that changes a fact about whether the action is grounded.

const MEASURED_ACTION = 'ASCEND:habitat:p3_68_22'
const MEASURED_SHAPE = actionShapeOf(MEASURED_ACTION)
const MEASURED_CELL = repeatedOutcomeCell('overworld', { x: 3, y: 68, z: 22 }, { x: 3, y: 67, z: 22 })
const MEASURED_FACTS = repeatedOutcomeFactSignature({
  affordanceFingerprint: 'rv1|3,68,22|reachable|missing=[]|place=1|tools=[]|hazard=0|approach=1|head=1|foot=1',
  planIdentity: 'g3:ascend:habitat',
  worldKey: 'overworld|epoch=7',
})

/** The measured alternation: rise half (`done`, body only) then refusal half. */
function measuredObservation(half: 'rise' | 'refuse', at: number): {
  actionId: string
  actionShape: string
  cell: string
  outcome: string
  failureCode: string | null
  semanticProgress: boolean
  factSignature: string
  now: number
} {
  const failure = half === 'refuse' ? 'stuck' : null
  return {
    actionId: MEASURED_ACTION,
    actionShape: MEASURED_SHAPE,
    cell: MEASURED_CELL,
    outcome: repeatedOutcomeToken({ failure, status: half === 'refuse' ? 'failed' : 'done', verified: half === 'rise' }),
    failureCode: failure,
    // `progressKinds=["body"]` on the rise half: NOT semantic progress.
    semanticProgress: repeatedOutcomeSemanticProgress({
      progressKinds: half === 'rise' ? ['body'] : ['none'],
      itemsGained: 0,
      blockRemoved: false,
    }),
    factSignature: MEASURED_FACTS,
    now: at,
  }
}

/**
 * Replay the measured alternation and return the decisions. The runaway was
 * 184 refusals + 200 rises; the ledger must fire well inside that.
 */
function replayMeasured(limit: number, cycles: number): ReturnType<RepeatedOutcomeEscalation['note']>[] {
  const ledger = new RepeatedOutcomeEscalation({ limit })
  const decisions: ReturnType<RepeatedOutcomeEscalation['note']>[] = []
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    decisions.push(ledger.note(measuredObservation('refuse', 1_000 + cycle * 2)))
    decisions.push(ledger.note(measuredObservation('rise', 1_001 + cycle * 2)))
  }
  return decisions
}

// --- (i) the measured shape -----------------------------------------------------

addCase('(i-a) the measured alternation retires the target ONCE, at the bound, typed', () => {
  const decisions = replayMeasured(REPEATED_OUTCOME_LIMIT_DEFAULT, 12)
  const escalations = decisions.filter((decision) => decision.escalate)
  const last = decisions[decisions.length - 1]
  if (last === undefined) return ok(false, 'no decisions')
  return ok(
    escalations.length === 1 &&
      escalations[0]?.count === REPEATED_OUTCOME_LIMIT_DEFAULT &&
      last.retired === true &&
      escalations[0]?.cell === MEASURED_CELL &&
      escalations[0]?.actionShape === MEASURED_SHAPE,
    `escalations=${escalations.length} count=${escalations[0]?.count} limit=${REPEATED_OUTCOME_LIMIT_DEFAULT} retired=${last.retired} cell=${last.cell} shape=${last.actionShape}`,
  )
})

addCase('(i-b) the escalation fires inside the measured 184-refusal budget, not after it', () => {
  const decisions = replayMeasured(REPEATED_OUTCOME_LIMIT_DEFAULT, 60)
  const index = decisions.findIndex((decision) => decision.escalate)
  // The measured run spent 161 attempts; the bound must be a small fraction of it.
  return ok(
    index >= 0 && index < 161 && index <= 2 * REPEATED_OUTCOME_LIMIT_DEFAULT,
    `firstEscalationAtIndex=${index} measuredAttempts=161 limit=${REPEATED_OUTCOME_LIMIT_DEFAULT}`,
  )
})

addCase('(i-c) the escalation names the action, the cell, the outcome, the count, the bound and the consequence', () => {
  const decision = replayMeasured(REPEATED_OUTCOME_LIMIT_DEFAULT, 12).find((entry) => entry.escalate)
  if (decision === undefined) return ok(false, 'no escalation')
  const line = formatActionRepeatExhausted(decision, MEASURED_ACTION)
  return ok(
    line.startsWith(`${ACTION_REPEAT_EXHAUSTED_MARKER} `) &&
      line.includes(`count=${REPEATED_OUTCOME_LIMIT_DEFAULT}/${REPEATED_OUTCOME_LIMIT_DEFAULT}`) &&
      line.includes(`action=${MEASURED_ACTION}`) &&
      line.includes(`shape=${MEASURED_SHAPE}`) &&
      line.includes(`cell=${MEASURED_CELL}`) &&
      line.includes('outcome=status:done:verified') &&
      line.includes('failure=stuck') &&
      line.includes(`bound=${REPEATED_OUTCOME_LIMIT_DEFAULT}`) &&
      line.includes('-> retire target for this action'),
    line,
  )
})

addCase('(i-d) the counter is DURABLE: a generation swap resumes the streak instead of restarting it', () => {
  // Generation A: 4 zero-progress attempts at the measured cell, then the resident
  // hot-reloads. The durable record is what the HOST would have persisted.
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const first = new RepeatedOutcomeEscalation({ limit })
  const firstHalf: ReturnType<RepeatedOutcomeEscalation['note']>[] = []
  // `limit - 1` zero-progress settles: one short of the bound, so the NEXT
  // generation's single attempt is what trips it.
  for (let attempt = 0; attempt < limit - 1; attempt += 1) {
    firstHalf.push(first.note(measuredObservation(attempt % 2 === 0 ? 'refuse' : 'rise', 1_000 + attempt)))
  }
  const carriedCount = firstHalf[firstHalf.length - 1]?.count ?? 0
  const durable = JSON.parse(JSON.stringify(first.snapshot())) as unknown[]

  // Generation B is constructed from the durable bytes alone.
  const second = new RepeatedOutcomeEscalation({ limit, initialEntries: durable })
  const decision = second.note(measuredObservation('refuse', 9_000))
  return ok(
    carriedCount > 0 &&
      carriedCount < limit &&
      // exactly ONE more zero-progress attempt reaches the bound, because the
      // count came across the generation boundary with the ledger
      decision.count === carriedCount + 1 &&
      decision.escalate === true &&
      decision.retired === true,
    `carried=${carriedCount} afterSwap=${decision.count} escalate=${decision.escalate} limit=${limit}`,
  )
})

addCase('(i-e) the retirement removes the candidate from the offer and says so, once', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  for (let cycle = 0; cycle < limit; cycle += 1) {
    ledger.note(measuredObservation('refuse', 1_000 + cycle * 2))
    ledger.note(measuredObservation('rise', 1_001 + cycle * 2))
  }
  const candidates = [
    { id: MEASURED_ACTION, kind: 'MOVE', target: { x: 3, y: 68, z: 22 } },
    { id: 'ASCEND:habitat:p4_68_22', kind: 'MOVE', target: { x: 4, y: 68, z: 22 } },
    { id: 'WAIT', kind: 'WAIT', target: null },
  ]
  const { kept, withheld } = filterRetiredRepeats(candidates, ledger, 'overworld', { x: 3, y: 67, z: 22 })
  const entry = withheld[0]
  const line =
    entry === undefined
      ? 'no withhold'
      : formatActionTargetRetired({
          actionId: entry.candidate.id,
          actionShape: entry.actionShape,
          cell: entry.cell,
          outcome: entry.outcome,
          count: entry.count,
          limit: entry.limit,
        })
  return ok(
    withheld.length === 1 &&
      kept.length === 2 &&
      // the relocation is FORCED: the same shape at a different cell survives, and
      // the retired cell's candidate is gone from the offer
      kept.some((candidate) => candidate.id === 'ASCEND:habitat:p4_68_22') &&
      kept.some((candidate) => candidate.id === 'WAIT') &&
      line.startsWith(`${ACTION_TARGET_RETIRED_MARKER} `) &&
      line.includes(`cell=${MEASURED_CELL}`) &&
      line.includes('reason=repeated_identical_outcome'),
    `withheld=${withheld.length} kept=${kept.map((candidate) => candidate.id).join(',')} | ${line}`,
  )
})

addCase('(i-f) the retirement LIFTS when a new fact arrives, so it is not a permanent semantic verdict', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  for (let cycle = 0; cycle < limit; cycle += 1) {
    ledger.note(measuredObservation('refuse', 1_000 + cycle * 2))
    ledger.note(measuredObservation('rise', 1_001 + cycle * 2))
  }
  const retired = ledger.isRetired(MEASURED_SHAPE, MEASURED_CELL)
  // A tool/block the action needs is now different: the affordance signature moves.
  const newFact = ledger.note({
    ...measuredObservation('refuse', 9_000),
    factSignature: repeatedOutcomeFactSignature({
      affordanceFingerprint: 'rv1|3,68,22|reachable|missing=[]|place=1|tools=[dirt:1]|hazard=0|approach=1|head=1|foot=1',
      planIdentity: 'g3:ascend:habitat',
      worldKey: 'overworld|epoch=7',
    }),
  })
  return ok(
    retired === true &&
      newFact.restarted === 'new_fact' &&
      newFact.count === 1 &&
      newFact.retired === false &&
      ledger.isRetired(MEASURED_SHAPE, MEASURED_CELL) === false,
    `retiredBefore=${retired} restarted=${newFact.restarted} count=${newFact.count} retiredAfter=${newFact.retired}`,
  )
})

// --- (ii) control: a NEW fact each attempt -> never retired ----------------------

addCase('(ii-a) control: a new fact between attempts never retires (inventory/tool changes)', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  const decisions: ReturnType<RepeatedOutcomeEscalation['note']>[] = []
  for (let attempt = 0; attempt < limit * 4; attempt += 1) {
    decisions.push(
      ledger.note({
        ...measuredObservation('refuse', 1_000 + attempt),
        // the held tier of a needed tool advances every attempt: real new evidence
        factSignature: repeatedOutcomeFactSignature({
          affordanceFingerprint: `rv1|3,68,22|reachable|missing=[]|place=1|tools=[pickaxe:${attempt}]|hazard=0|approach=1|head=1|foot=1`,
          planIdentity: 'g3:ascend:habitat',
          worldKey: 'overworld|epoch=7',
        }),
      }),
    )
  }
  return ok(
    decisions.every((decision) => !decision.escalate && !decision.retired) &&
      decisions.every((decision) => decision.count === 1) &&
      decisions.slice(1).every((decision) => decision.restarted === 'new_fact') &&
      ledger.isRetired(MEASURED_SHAPE, MEASURED_CELL) === false,
    `escalations=${decisions.filter((decision) => decision.escalate).length} counts=${[...new Set(decisions.map((decision) => decision.count))].join(',')} restarts=${[...new Set(decisions.map((decision) => decision.restarted))].join(',')}`,
  )
})

addCase('(ii-b) control: semantic progress resets the streak', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  for (let cycle = 0; cycle < limit - 1; cycle += 1) {
    ledger.note(measuredObservation('refuse', 1_000 + cycle * 2))
    ledger.note(measuredObservation('rise', 1_001 + cycle * 2))
  }
  const beforeProgress = ledger.countFor(MEASURED_SHAPE, MEASURED_CELL)
  // The objective advanced: `progressKinds=["goal"]`. That IS new information.
  const afterProgress = ledger.note({
    ...measuredObservation('refuse', 5_000),
    outcome: repeatedOutcomeToken({ failure: null, status: 'done', verified: true }),
    failureCode: null,
    semanticProgress: true,
  })
  return ok(
    beforeProgress === 2 * (limit - 1) &&
      afterProgress.count === 1 &&
      afterProgress.restarted === 'new_fact' &&
      afterProgress.escalate === false,
    `beforeProgress=${beforeProgress} after=${afterProgress.count} restarted=${afterProgress.restarted}`,
  )
})

// --- (iii) control: the outcome differs between attempts -> never retired --------

addCase('(iii-a) control: a DIFFERENT failure code at the same cell never retires', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  const codes = ['stuck', 'path_no_path', 'no_standable_approach', 'tunnel_entry_refused']
  const decisions: ReturnType<RepeatedOutcomeEscalation['note']>[] = []
  for (let attempt = 0; attempt < limit * 3; attempt += 1) {
    const code = codes[attempt % codes.length] ?? 'stuck'
    decisions.push(
      ledger.note({
        ...measuredObservation('refuse', 1_000 + attempt),
        outcome: repeatedOutcomeToken({ failure: code, status: 'failed', verified: false }),
        failureCode: code,
      }),
    )
  }
  const escalations = decisions.filter((decision) => decision.escalate)
  const restarts = [...new Set(decisions.map((decision) => decision.restarted))]
  return ok(
    escalations.length === 0 &&
      ledger.isRetired(MEASURED_SHAPE, MEASURED_CELL) === false &&
      restarts.includes('different_outcome') &&
      decisions.every((decision) => decision.count === 1),
    `escalations=${escalations.length} restarts=${restarts.join(',')} counts=${[...new Set(decisions.map((decision) => decision.count))].join(',')}`,
  )
})

addCase('(iii-b) control: a different action KIND at the same cell is a different question', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  const shapes = ['ASCEND:habitat:p*', 'MOVE:p*', 'DIG:down:p*', 'BRIDGE:E:p*']
  for (let attempt = 0; attempt < limit * 3; attempt += 1) {
    const shape = shapes[attempt % shapes.length] ?? 'MOVE:p*'
    ledger.note({ ...measuredObservation('refuse', 1_000 + attempt), actionShape: shape })
  }
  return ok(
    shapes.every((shape) => ledger.isRetired(shape, MEASURED_CELL) === false) &&
      shapes.every((shape) => ledger.countFor(shape, MEASURED_CELL) <= Math.ceil((limit * 3) / shapes.length)),
    shapes.map((shape) => `${shape}=${ledger.countFor(shape, MEASURED_CELL)}`).join(' '),
  )
})

// --- (iv) the bound is stated in ONE place and reused ---------------------------

addCase('(iv-a) the bound is the module constant, reused by the resolver and the controller default', () => {
  const resolved = resolveRepeatedOutcomeLimit({})
  const overridden = resolveRepeatedOutcomeLimit({ BUDDY_REPEATED_OUTCOME_LIMIT: '3' })
  const invalid = resolveRepeatedOutcomeLimit({ BUDDY_REPEATED_OUTCOME_LIMIT: 'nope' })
  return ok(
    resolved === REPEATED_OUTCOME_LIMIT_DEFAULT &&
      overridden === 3 &&
      invalid === REPEATED_OUTCOME_LIMIT_DEFAULT,
    `default=${REPEATED_OUTCOME_LIMIT_DEFAULT} resolved=${resolved} overridden=${overridden} invalid=${invalid}`,
  )
})

addCase('(iv-b) no other literal re-derives the bound in the ledger or the controller', () => {
  const ledgerSrc = readFileSync(new URL('./src/repeatedOutcomeEscalation.ts', import.meta.url), 'utf8')
  const controllerSrc = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const declarationCount = (ledgerSrc.match(/REPEATED_OUTCOME_LIMIT_DEFAULT\s*=\s*\d+/g) ?? []).length
  // The controller must consume the resolver, never a bare literal.
  const controllerUsesResolver = controllerSrc.includes('repeatedOutcomeLimit: resolveRepeatedOutcomeLimit()')
  const controllerLiterals = (controllerSrc.match(/repeatedOutcomeLimit:\s*\d+/g) ?? []).length
  return ok(
    declarationCount === 1 && controllerUsesResolver && controllerLiterals === 0,
    `declarations=${declarationCount} controllerUsesResolver=${controllerUsesResolver} controllerLiterals=${controllerLiterals}`,
  )
})

addCase('(iv-c) the escalation markers are mirrored, so the escalation reaches the live record', () => {
  const controllerSrc = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  return ok(
    controllerSrc.includes('ACTION_REPEAT_MARKER,') &&
      controllerSrc.includes('ACTION_REPEAT_EXHAUSTED_MARKER,') &&
      controllerSrc.includes('ACTION_TARGET_RETIRED_MARKER,'),
    'ACTION_REPEAT / ACTION_REPEAT_EXHAUSTED / ACTION_TARGET_RETIRED must all be in MIRRORED_MARKERS',
  )
})

// The ledger's live path needs a bot to exercise, so the two wire points are
// pinned here: the fact must be OBSERVED at the settle site and must have a
// CONSEQUENCE in the candidate chain. A computed fact without both is the exact
// defect class this lane exists to close.
addCase('(iv-d) the controller OBSERVES at the settle site and PRUNES in the candidate chain', () => {
  const src = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const outcomeSrc = readFileSync(new URL('./src/legacy/outcome-accounting.ts', import.meta.url), 'utf8')
  const observed = outcomeSrc.includes('host.noteRepeatedOutcome(result, candidate, truth.verified, taxonomy.progressKinds)')
  const pruned = src.includes('candidates = this.filterRepeatedOutcomeCandidates(candidates, state)')
  // The observation must use the TARGET signature (no body-relative gap), never
  // the full fingerprint whose `gap` term alternated 122x/115x in the live record.
  const usesTargetSignature = src.includes('entry.targetSignature')
  const usesFullFingerprint = src.includes('[entry.candidate.id, entry.fingerprint]')
  return ok(
    observed && pruned && usesTargetSignature && !usesFullFingerprint,
    `observed=${observed} pruned=${pruned} targetSig=${usesTargetSignature} fullFp=${usesFullFingerprint}`,
  )
})

addCase('(iv-e) the ledger is DURABLE through the HOST class-A world memory, like its siblings', () => {
  const resident = readFileSync(new URL('../buddy-driver/resident-types.ts', import.meta.url), 'utf8')
  const staging = readFileSync(new URL('../buddy-driver/proposal-staging.ts', import.meta.url), 'utf8')
  const runner = readFileSync(new URL('../buddy-driver/agent-runner.mts', import.meta.url), 'utf8')
  const entry = readFileSync(new URL('../buddy-driver/generation-entry.ts', import.meta.url), 'utf8')
  const store = resident.includes('repeatedOutcomes: RepeatedOutcomeEntryJson[]')
  const delta = resident.includes('repeatedOutcomes?: RepeatedOutcomeEntryJson[]')
  const normalise = resident.includes('memory.repeatedOutcomes = Array.isArray(memory.repeatedOutcomes)')
  const merge = staging.includes('memory.repeatedOutcomes = delta.repeatedOutcomes.map(')
  // cloneMemory is the #80 omission class: a field the canonical merge handles but
  // the generation seed forgets is silently dropped on every reload.
  const clone = runner.includes('repeatedOutcomes: normal.repeatedOutcomes.map((entry) => ({ ...entry }))')
  const seed = entry.includes('repeatedOutcomeEntries: world.repeatedOutcomes')
  const write = entry.includes('ctx.proposeWorldMemory({ repeatedOutcomes: world.repeatedOutcomes })')
  return ok(
    store && delta && normalise && merge && clone && seed && write,
    `store=${store} delta=${delta} normalise=${normalise} merge=${merge} clone=${clone} seed=${seed} write=${write}`,
  )
})

// --- supporting contracts --------------------------------------------------------

addCase('(s-a) the action SHAPE collapses coordinate/ordinal suffixes but not the kind', () => {
  const rows: Array<[string, string]> = [
    ['ASCEND:habitat:p3_68_22', 'ASCEND:habitat:p*'],
    ['MOVE:p-7_69_-7', 'MOVE:p*'],
    ['PLACE:obsidian:build:4@p26_66_9', 'PLACE:obsidian:build:*@p*'],
    ['RETRIEVE:known:station:furnace:b29_61_35', 'RETRIEVE:known:station:furnace:b*'],
  ]
  const bad = rows.filter(([input, want]) => actionShapeOf(input) !== want)
  return ok(bad.length === 0, bad.map(([input, got]) => `${input} -> ${actionShapeOf(input)} (want ${got})`).join(' | '))
})

addCase('(s-b) the cell key reuses the sibling failure memory convention, and a targetless action uses the body cell', () => {
  const withTarget = repeatedOutcomeCell('overworld', { x: 3, y: 68, z: 22 }, { x: 9, y: 9, z: 9 })
  const withoutTarget = repeatedOutcomeCell('overworld', null, { x: 3, y: 67.9, z: 22.4 })
  const otherDimension = repeatedOutcomeCell('the_nether', { x: 3, y: 68, z: 22 }, { x: 9, y: 9, z: 9 })
  return ok(
    withTarget === 'overworld:3,68,22' &&
      withoutTarget === 'overworld:3,67,22' &&
      otherDimension === 'the_nether:3,68,22' &&
      repeatedOutcomeKey('ASCEND:habitat:p*', withTarget) === 'ASCEND:habitat:p*@overworld:3,68,22',
    `${withTarget} | ${withoutTarget} | ${otherDimension}`,
  )
})

addCase('(s-c) WAIT/ESCALATE are not repeat-tracked kinds: they have their own bound', () => {
  return ok(
    isRepeatTrackedKind('MOVE') &&
      isRepeatTrackedKind('ASCEND') &&
      isRepeatTrackedKind('CRAFT') &&
      !isRepeatTrackedKind('WAIT') &&
      !isRepeatTrackedKind('ESCALATE'),
    `WAIT=${isRepeatTrackedKind('WAIT')} ESCALATE=${isRepeatTrackedKind('ESCALATE')} MOVE=${isRepeatTrackedKind('MOVE')}`,
  )
})

addCase('(s-d) the counter line is emitted for a repeat and names the restart reason', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  ledger.note(measuredObservation('refuse', 1_000))
  const second = ledger.note(measuredObservation('rise', 1_001))
  const restarted = ledger.note(measuredObservation('refuse', 1_002))
  // The rise advanced the count (body-only success is not new information), and
  // the refuse after it reaches 3 - still one streak.
  return ok(
    second.count === 2 &&
      second.restarted === null &&
      restarted.count === 3 &&
      restarted.restarted === null &&
      formatActionRepeat(restarted).startsWith(`${ACTION_REPEAT_MARKER} count=3/`) &&
      formatActionRepeat(restarted).includes(`cell=${MEASURED_CELL}`),
    `second=${second.count}/${second.restarted} third=${restarted.count}/${restarted.restarted} | ${formatActionRepeat(restarted)}`,
  )
})

addCase('(s-e) a malformed durable entry is dropped, and a retired entry survives restore', () => {
  const limit = REPEATED_OUTCOME_LIMIT_DEFAULT
  const ledger = new RepeatedOutcomeEscalation({ limit })
  for (let cycle = 0; cycle < limit; cycle += 1) {
    ledger.note(measuredObservation('refuse', 1_000 + cycle * 2))
    ledger.note(measuredObservation('rise', 1_001 + cycle * 2))
  }
  const good = ledger.snapshot()
  const restored = new RepeatedOutcomeEscalation({
    limit,
    initialEntries: [null, 7, 'nope', {}, { actionShape: 'X' }, ...good],
  })
  return ok(
    restoreRepeatedOutcomeEntry(null) === null &&
      restoreRepeatedOutcomeEntry({ actionShape: 'X', cell: 'c', outcome: 'o' }) === null &&
      restored.size() === 1 &&
      restored.isRetired(MEASURED_SHAPE, MEASURED_CELL) === true &&
      restored.countFor(MEASURED_SHAPE, MEASURED_CELL) === good[0]?.count,
    `size=${restored.size()} retired=${restored.isRetired(MEASURED_SHAPE, MEASURED_CELL)} count=${restored.countFor(MEASURED_SHAPE, MEASURED_CELL)}`,
  )
})

addCase('(s-f) the declared bound stays far below the measured 184-refusal budget', () => {
  // A guard, not a style check: if the bound is ever raised toward the measured
  // runaway length the escalation stops being an escalation.
  return ok(
    REPEATED_OUTCOME_LIMIT_DEFAULT >= 2 && REPEATED_OUTCOME_LIMIT_DEFAULT <= 12,
    `limit=${REPEATED_OUTCOME_LIMIT_DEFAULT} measuredRefusals=184`,
  )
})

// --- the fingerprint refactor must be byte-identical, and the target signature ---
//
// `reachabilityFingerprint` gained an option; the DEFAULT form is pinned by other
// fixtures and by the live log, so this asserts the refactor changed nothing and
// that the target signature is exactly the default minus the body-relative gap.

const FINGERPRINT_INPUT: ReachabilityFingerprintInput = {
  target: {
    candidateId: 'ASCEND:habitat:p3_68_22',
    kind: 'MOVE',
    position: { x: 3, y: 68, z: 22 },
    barrier: null,
  },
  result: { reachable: true, reason: 'reachable', missingCapabilities: [] },
  inventory: { dirt: 3 },
  world: {
    self: { x: 3.5, y: 67, z: 22.5 },
    approach: { x: 3, y: 67, z: 22 },
    reach: 5,
    hazardAtTarget: false,
    footingSolid: true,
    headroomClear: true,
  },
  placeableBlock: true,
}

addCase('(s-g) the default fingerprint is unchanged by the refactor, and the target signature drops only the gap', () => {
  const full = reachabilityFingerprint(FINGERPRINT_INPUT)
  const target = reachabilityTargetSignature(FINGERPRINT_INPUT)
  const gap = Math.round(68 - 67)
  const expectedFull = `rv1|3,68,22|reachable|missing=[]|gap=${gap}|place=1|tools=[]|hazard=0|approach=1|head=1|foot=1`
  const expectedTarget = 'rv1|3,68,22|reachable|missing=[]|place=1|tools=[]|hazard=0|approach=1|head=1|foot=1'
  return ok(
    full === expectedFull && target === expectedTarget && !target.includes('gap='),
    `full=${full} | target=${target}`,
  )
})

addCase('(s-h) THE MEASURED LAUNDERING: the full fingerprint alternates with the body, the target signature does not', () => {
  // The live record shows the measured candidate's fingerprint alternating
  // `gap=1` x122 / `gap=0` x115 as its own step rose one block and fell back.
  const bodyOnGround = { ...FINGERPRINT_INPUT, world: { ...FINGERPRINT_INPUT.world, self: { x: 3.5, y: 67, z: 22.5 } } }
  const bodyRisen = { ...FINGERPRINT_INPUT, world: { ...FINGERPRINT_INPUT.world, self: { x: 3.5, y: 68, z: 22.5 } } }
  const fullA = reachabilityFingerprint(bodyOnGround)
  const fullB = reachabilityFingerprint(bodyRisen)
  const targetA = reachabilityTargetSignature(bodyOnGround)
  const targetB = reachabilityTargetSignature(bodyRisen)
  // A counter keyed on the FULL fingerprint would restart on every attempt...
  const fullLedger = new RepeatedOutcomeEscalation()
  let fullEscalations = 0
  // ...while one keyed on the TARGET signature fires at the bound.
  const targetLedger = new RepeatedOutcomeEscalation()
  let targetEscalations = 0
  for (let attempt = 0; attempt < REPEATED_OUTCOME_LIMIT_DEFAULT + 2; attempt += 1) {
    const body = attempt % 2 === 0 ? bodyOnGround : bodyRisen
    const observation = {
      ...measuredObservation('refuse', 1_000 + attempt),
      semanticProgress: false,
      failureCode: 'stuck',
      outcome: 'failure:stuck',
    }
    if (
      fullLedger.note({
        ...observation,
        factSignature: repeatedOutcomeFactSignature({
          affordanceFingerprint: reachabilityFingerprint(body),
          planIdentity: 'g3:ascend:habitat',
          worldKey: 'overworld|epoch=7',
        }),
      }).escalate
    ) {
      fullEscalations += 1
    }
    if (
      targetLedger.note({
        ...observation,
        factSignature: repeatedOutcomeFactSignature({
          affordanceFingerprint: reachabilityTargetSignature(body),
          planIdentity: 'g3:ascend:habitat',
          worldKey: 'overworld|epoch=7',
        }),
      }).escalate
    ) {
      targetEscalations += 1
    }
  }
  return ok(
    fullA !== fullB && targetA === targetB && fullEscalations === 0 && targetEscalations === 1,
    `fullAlternates=${fullA !== fullB} targetStable=${targetA === targetB} fullEscalations=${fullEscalations} targetEscalations=${targetEscalations}`,
  )
})

// --- runner ----------------------------------------------------------------------

let failed = 0
for (const testCase of cases) {
  let result: CaseResult
  try {
    result = testCase.run()
  } catch (error) {
    result = { pass: false, detail: `threw: ${String(error)}` }
  }
  if (!result.pass) failed += 1
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${testCase.name}${result.pass ? '' : ` :: ${result.detail}`}`)
}
console.log('------------------------------------------------------------------------')
console.log(`${cases.length - failed}/${cases.length} repeated-outcome-escalation cases passed`)
if (failed > 0) process.exit(1)
