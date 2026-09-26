// test-cached-plan-executability.mts
//
// The cached-plan replay boundary: an INSTALLED WHAT that the very next tick
// refuses, because it was re-validated for ADMISSIBILITY but never for
// EXECUTABILITY.
//
// Measured live: the body stood at (26.5, 79.0, -3.5), 12 blocks ABOVE the
// portal interior, and the affordance gate had already typed the refusal -
//   CANDIDATE_WITHHELD reason=needs_descend candidate=ENTER:...
//     missing=["descend_plan:no_support@27,78,-4:air"]
// - so ENTER was not executable. `validateMercuryPlanAgainstState` only asks
// whether the goal is ADMISSIBLE (`portal.verified === true`), so the cached
// answer `mercury_patch_enter_portal_goal` ("gate verified, so enter instead of a
// blocked descent") was re-installed and the next tick refused it as
// `action_impossible`.
//
// Three outcomes, and each one is asserted here:
//   executable          -> applied exactly as today, byte-compared
//   not_executable_now  -> typed refusal naming goal + blocker + provenance, no
//                          apply, the ordinary zero-goal/escalation path takes over
//   unknown             -> the honest third outcome, mirrored, never collapsed
//                          into either side and never a SILENT apply
//
// The executable-here fact re-used here is the tick's own typed withheld
// projection (`blockers.withheld[]` with its verbatim `reason` + `missing`), not
// a new rule and not the dimension-only `reconcileNotExecutableHead` (whose
// transfer-row exemption deliberately excludes this exact portal-entry row).
//
// Canonical run: cd buddy-driver && bun ./test-cached-plan-executability.mts

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MERCURY_CACHE_SCHEMA_VERSION,
  MERCURY_PLAN_EXECUTABILITY_MARKER,
  MERCURY_PLAN_NOT_EXECUTABLE_MARKER,
  MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON,
  MercurySystem2,
  classifyMercuryPlanExecutability,
  formatMercuryPlanExecutability,
  formatMercuryPlanNotExecutable,
  goalExecutorCandidateKinds,
  hashMercuryState,
  plannedGoalsFromMercury,
} from './mercury-system2.ts'
import type { MercuryPlanJson, MercuryStateSummary, MercuryRepairResult } from './mercury-system2.ts'
import {
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  netherPortalEntryGoal,
} from '../jev-agent/src/netherPortalPlan.ts'
import type { System2Outcome, System2PlanRequest } from '../jev-agent/src/system2/service.ts'
import type { PlannedGoal } from '../jev-agent/src/goalQueue.ts'
import { MIRRORED_MARKERS, mirroredEventToken } from '../jev-agent/src/controller-legacy.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
function check(name: string, pass: boolean, detail = ''): void {
  checks.push({ name, pass, detail })
  if (!pass) console.error(`FAIL ${name}${detail === '' ? '' : ` :: ${detail}`}`)
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** Mirrors the host logger's `event key=value ...` line format. */
function hostLog(sink: string[]): (event: string, detail?: Record<string, unknown>) => void {
  return (event, detail) => {
    const parts = Object.entries(detail ?? {}).map(([key, value]) => {
      const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value)
      return `${key}=${text}`
    })
    sink.push(`${event}${parts.length > 0 ? ` ${parts.join(' ')}` : ''}`)
  }
}

function outcome(actionId: string): System2Outcome {
  return { actionId, status: 'ok', failure: null, verified: false, detail: '' }
}

function planRequest(): System2PlanRequest {
  return {
    reason: 'action_impossible',
    detail: 'row not executable here: goal=place:nether_portal:1 declared=the_nether live=overworld',
    tick: 1,
    goalQueueState: { depth: 1, current: null, empty: false, hasImpossible: false, done: 0, goals: [] },
    objective: { targetItem: 'nether_portal', requiredCount: 1, haveCount: 0, complete: false },
    recentEvents: [],
    recentOutcomes: [outcome('WAIT'), outcome('WAIT'), outcome('WAIT')],
  }
}

/**
 * The MEASURED live shape: the gate is verified (so `enter_portal` is admissible)
 * and the body cannot execute the entry (so it is not executable here).
 */
function liveBlockers(): NonNullable<MercuryStateSummary['blockers']> {
  return {
    blockedBy: 'no_productive_action',
    missing: ['ENTER:26,79,-4:needs_descend'],
    repeats: { count: 8, bound: 8 },
    withheldTotal: 1,
    withheld: [
      {
        candidate: 'ENTER:26,79,-4',
        kind: 'ENTER_PORTAL',
        reason: 'needs_descend',
        missing: ['descend_plan:no_support@27,78,-4:air'],
        suppressed: false,
      },
    ],
    tools: { held: [], unmet: [] },
  }
}

/** A tick that DID measure a refusal - just not of the goal under test. */
function unrelatedBlockers(): NonNullable<MercuryStateSummary['blockers']> {
  return {
    blockedBy: 'no_productive_action',
    missing: ['MINE:27,62,15:needs_ascend'],
    withheldTotal: 1,
    withheld: [
      {
        candidate: 'MINE:27,62,15',
        kind: 'MINE',
        reason: 'needs_ascend',
        missing: ['headroom@27,62,15'],
        suppressed: false,
      },
    ],
    tools: { held: [], unmet: [] },
  }
}

function mercuryState(overrides: Partial<MercuryStateSummary> = {}): MercuryStateSummary {
  return {
    humanMission: 'Defeat the Ender Dragon',
    trigger: 'action_impossible',
    wakeReason: 'action_impossible',
    wakeDetail: 'row not executable here',
    position: { x: 26, y: 79, z: -4 },
    dimension: 'minecraft:overworld',
    health: 20,
    toolRank: 3,
    inventory: { obsidian: 10, flint_and_steel: 1 },
    stations: { craftingTables: 1, furnaces: 1 },
    portal: { verified: true, knownSites: 1 },
    knownOres: ['coal_ore'],
    recentFailures: [],
    consecutiveWait: 0,
    queue: { depth: 1, done: 12, current: 'place:nether_portal:1', hasImpossible: false },
    objective: { targetItem: 'nether_portal', requiredCount: 1, haveCount: 0, complete: false },
    deathHistory: [],
    allowedGoals: { collect: [], craft: [], smelt: [], place: ['nether_portal'] },
    ...overrides,
  }
}

/** The cached answer the live run replayed: "gate verified, so enter". */
const CACHED_ENTER: MercuryPlanJson = {
  op: 'patch',
  goals: [{ kind: 'enter_portal' }],
  reason: 'gate verified, so enter instead of a blocked descent',
}
const CACHED_ENTER_STRATEGY = 'mercury_patch_enter_portal_goal'

function cacheFile(entries: Record<string, unknown>): string {
  return `${JSON.stringify({
    version: MERCURY_CACHE_SCHEMA_VERSION,
    worldKey: 'local|unknown|0',
    worldEpoch: 0,
    schemaVersion: MERCURY_CACHE_SCHEMA_VERSION,
    entries,
    callTimes: [],
    consecutiveStrategy: null,
    consecutiveCount: 0,
  })}\n`
}

function cacheEntry(plan: MercuryPlanJson, strategy: string, replays = 0): Record<string, unknown> {
  return {
    op: plan.op,
    goals: plan.goals.map((goal) => ({ ...goal })),
    reason: plan.reason,
    strategy,
    costUsd: 0,
    ts: Date.now(),
    replays,
  }
}

interface ReplayRun {
  result: MercuryRepairResult | null
  thrown: unknown
  logs: string[]
  callLog: 'written' | 'absent'
  cacheAfter: { entries: Record<string, { strategy: string; replays?: number; goals?: MercuryPlanJson['goals'] }> }
  cachePath: string
}

interface FreshRun extends ReplayRun {
  call: Record<string, unknown> | null
  transportCalls: number
}

async function runFresh(summary: MercuryStateSummary, plan: MercuryPlanJson): Promise<FreshRun> {
  const dir = mkdtempSync(join(tmpdir(), 'fresh-plan-exec-'))
  const cachePath = join(dir, 'mercury-cache.json')
  const callsPath = join(dir, 'mercury-calls.jsonl')
  const logs: string[] = []
  let transportCalls = 0
  const mercury = new MercurySystem2({
    summarize: () => summary,
    log: hostLog(logs),
    callsPath,
    cachePath,
    maxPerHour: 1,
    resolveKey: () => ({ key: 'fixture-key', origin: 'fixture' }),
    transport: async () => {
      transportCalls += 1
      return {
        toolCalls: [{ input: plan }],
        text: 'Use the verified portal, subject to the live movement refusal.',
        usage: { inputTokens: 1, outputTokens: 1 },
      }
    },
  })
  let result: MercuryRepairResult | null = null
  let thrown: unknown = null
  try {
    result = await mercury.tryRepair(planRequest(), 'action_impossible')
  } catch (error) {
    thrown = error
  }
  return {
    result,
    thrown,
    logs,
    callLog: existsSync(callsPath) ? 'written' : 'absent',
    call: existsSync(callsPath) ? JSON.parse(readFileSync(callsPath, 'utf8').trim().split('\n')[0]!) as Record<string, unknown> : null,
    cacheAfter: JSON.parse(readFileSync(cachePath, 'utf8')),
    cachePath,
    transportCalls,
  }
}

/**
 * Run ONE `tryRepair` against a seeded cache. `maxPerHour: 0` means any model
 * call would fail loudly, so "no model call happened" is provable from the
 * absence of a call record (and from the absence of a throw).
 */
async function runReplay(
  summary: MercuryStateSummary,
  plan: MercuryPlanJson,
  strategy: string,
  replays = 0,
  existingCachePath?: string,
): Promise<ReplayRun> {
  const dir = mkdtempSync(join(tmpdir(), 'cached-plan-exec-'))
  const cachePath = existingCachePath ?? join(dir, 'mercury-cache.json')
  if (existingCachePath === undefined) {
    writeFileSync(cachePath, cacheFile({ [hashMercuryState(summary)]: cacheEntry(plan, strategy, replays) }))
  }
  const logs: string[] = []
  const mercury = new MercurySystem2({
    summarize: () => summary,
    log: hostLog(logs),
    callsPath: join(dir, 'mercury-calls.jsonl'),
    cachePath,
    maxPerHour: 0,
  })
  let result: MercuryRepairResult | null = null
  let thrown: unknown = null
  try {
    result = await mercury.tryRepair(planRequest(), 'action_impossible')
  } catch (error) {
    thrown = error
  }
  return {
    result,
    thrown,
    logs,
    callLog: existsSync(join(dir, 'mercury-calls.jsonl')) ? 'written' : 'absent',
    cacheAfter: JSON.parse(readFileSync(cachePath, 'utf8')),
    cachePath,
  }
}

function linesWith(logs: readonly string[], token: string): string[] {
  return logs.filter((line) => line.startsWith(token))
}

// ---------------------------------------------------------------------------
// (i) the measured shape: a cached enter_portal the body cannot execute
// ---------------------------------------------------------------------------

{
  const summary = mercuryState({ blockers: liveBlockers() })
  const run = await runReplay(summary, CACHED_ENTER, CACHED_ENTER_STRATEGY)
  const verdictLines = linesWith(run.logs, MERCURY_PLAN_EXECUTABILITY_MARKER)
  const refusalLines = linesWith(run.logs, MERCURY_PLAN_NOT_EXECUTABLE_MARKER)

  check(
    '(i) a cached enter_portal the state refuses is NOT executed as a plan',
    run.thrown === null && run.result !== null && run.result.goals.length === 0,
    `thrown=${run.thrown === null ? 'none' : String(run.thrown)} goals=${JSON.stringify(run.result?.goals)}`,
  )
  check(
    '(i) nothing was applied, yet the hit is still reported as a cache outcome',
    run.result?.cached === true && run.result.op === 'patch',
    `cached=${String(run.result?.cached)} op=${String(run.result?.op)}`,
  )
  check(
    '(i) the verdict is mirrored, typed as not_executable_now, and names the cache as its source',
    verdictLines.length === 1 && verdictLines[0]!.includes('verdict=not_executable_now') && verdictLines[0]!.includes('intentSource=cached'),
    verdictLines.join(' | '),
  )
  check(
    '(i) the refusal names the goal, the exact withheld candidate and the typed blocker fact verbatim',
    refusalLines.length === 1 &&
      refusalLines[0]!.includes('intentSource=cached') &&
      refusalLines[0]!.includes('goal=place:nether_portal:1') &&
      refusalLines[0]!.includes('candidate=ENTER:26,79,-4') &&
      refusalLines[0]!.includes('candidateKind=ENTER_PORTAL') &&
      refusalLines[0]!.includes('reason=needs_descend') &&
      refusalLines[0]!.includes('missing=[descend_plan:no_support@27,78,-4:air]') &&
      refusalLines[0]!.includes('action=refused'),
    refusalLines.join(' | '),
  )
  check(
    '(i) the refusal is handed to the queue channel that already names an empty answer',
    run.result?.plan.provenance?.noGoalsReason === MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON &&
      run.result?.plan.provenance?.intentSource === 'cached',
    JSON.stringify(run.result?.plan.provenance),
  )
  check(
    '(i) the zero-goal hand-off reaches the MIRRORED plan plane, naming this reason',
    MIRRORED_MARKERS.has('SYSTEM2_PLAN_NO_GOALS') &&
      mirroredEventToken(
        `SYSTEM2_PLAN_NO_GOALS op=patch reason=${MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON} intentSource=cached detail=1`,
      ) === 'SYSTEM2_PLAN_NO_GOALS',
    `noGoalsReason=${String(run.result?.plan.provenance?.noGoalsReason)}`,
  )
  check(
    '(i) no model call was made and nothing was silently replayed',
    run.callLog === 'absent' &&
      run.logs.filter((line) => line.startsWith('ADVISOR ')).length === 0 &&
      linesWith(run.logs, 'ADVISOR_CACHE bypass').length === 0,
    `calls=${run.callLog} advisor=${run.logs.filter((line) => line.startsWith('ADVISOR ')).length}`,
  )

  // The cache stays usable and the refusal is not charged as a replay: the same
  // state must keep getting the honest answer, and the entry survives.
  const entry = run.cacheAfter.entries[hashMercuryState(summary)]
  check(
    '(i) the refused entry is kept with its replay counter untouched',
    entry !== undefined && entry.replays === 0 && entry.strategy === CACHED_ENTER_STRATEGY,
    JSON.stringify(entry),
  )
  const second = await runReplay(summary, CACHED_ENTER, CACHED_ENTER_STRATEGY)
  check(
    '(i) a second identical summon is refused again without a model call',
    second.thrown === null && second.result?.goals.length === 0 && second.callLog === 'absent',
    `goals=${JSON.stringify(second.result?.goals)} calls=${second.callLog}`,
  )
}

// (i-b) the mapping is derived from the generator's own gate, not written for
// `enter_portal`: the OTHER exclusive portal executor is covered too.
{
  const igniteBlockers = unrelatedBlockers()
  igniteBlockers.withheld = [
    {
      candidate: 'IGNITE:26,67,9',
      kind: 'IGNITE',
      reason: 'needs_ascend',
      missing: ['headroom@27,68,9'],
      suppressed: false,
    },
  ]
  const summary = mercuryState({ blockers: igniteBlockers })
  const plan: MercuryPlanJson = { op: 'patch', goals: [{ kind: 'light_portal' }], reason: 'light the gate' }
  const run = await runReplay(summary, plan, 'mercury_patch_light_portal_goal')
  const refusalLines = linesWith(run.logs, MERCURY_PLAN_NOT_EXECUTABLE_MARKER)
  check(
    '(i-b) a cached light_portal whose IGNITE executor is withheld is refused with the same vocabulary',
    run.result?.goals.length === 0 &&
      refusalLines.length === 1 &&
      refusalLines[0]!.includes('candidateKind=IGNITE') &&
      refusalLines[0]!.includes('reason=needs_ascend') &&
      refusalLines[0]!.includes('missing=[headroom@27,68,9]'),
    `${refusalLines.join(' | ')} goals=${JSON.stringify(run.result?.goals)}`,
  )
}

// ---------------------------------------------------------------------------
// (ii) a cached plan that IS executable is applied exactly as today
// ---------------------------------------------------------------------------

{
  const withBlockers = mercuryState({ blockers: unrelatedBlockers() })
  const withoutBlockers = mercuryState()
  const executable = await runReplay(withBlockers, CACHED_ENTER, CACHED_ENTER_STRATEGY)
  const baseline = await runReplay(withoutBlockers, CACHED_ENTER, CACHED_ENTER_STRATEGY)
  const expected = JSON.stringify(plannedGoalsFromMercury(CACHED_ENTER, withoutBlockers))

  check(
    '(ii) a hit whose plan IS executable still applies',
    executable.thrown === null && executable.result !== null && executable.result.goals.length > 0,
    `goals=${JSON.stringify(executable.result?.goals)}`,
  )
  check(
    '(ii) the applied plan is byte-identical to the pre-fix replay',
    JSON.stringify(executable.result?.goals) === expected && JSON.stringify(baseline.result?.goals) === expected,
    `executable=${JSON.stringify(executable.result?.goals)} baseline=${JSON.stringify(baseline.result?.goals)} expected=${expected}`,
  )
  check(
    '(ii) the replay keeps its note, provenance and cache identity',
    JSON.stringify(executable.result?.plan) === JSON.stringify(baseline.result?.plan) &&
      executable.result?.plan.note === `cached mercury ${CACHED_ENTER_STRATEGY}` &&
      executable.result?.plan.provenance?.intentSource === 'cached',
    `plan=${JSON.stringify(executable.result?.plan)}`,
  )
  check(
    '(ii) the executable verdict is mirrored and no refusal is emitted',
    linesWith(executable.logs, MERCURY_PLAN_EXECUTABILITY_MARKER).some((line) => line.includes('verdict=executable')) &&
      linesWith(executable.logs, MERCURY_PLAN_NOT_EXECUTABLE_MARKER).length === 0,
    linesWith(executable.logs, MERCURY_PLAN_EXECUTABILITY_MARKER).join(' | '),
  )
  check(
    '(ii) the replay is still charged as a replay (the existing bound is untouched)',
    executable.cacheAfter.entries[hashMercuryState(withBlockers)]?.replays === 1,
    JSON.stringify(executable.cacheAfter.entries[hashMercuryState(withBlockers)]),
  )
}

// ---------------------------------------------------------------------------
// (iii) a fresh answer uses the same install-time executability boundary
// ---------------------------------------------------------------------------

{
  const summary = mercuryState({ blockers: liveBlockers() })
  const fresh = await runFresh(summary, CACHED_ENTER)
  const freshVerdict = linesWith(fresh.logs, MERCURY_PLAN_EXECUTABILITY_MARKER)
  const freshRefusal = linesWith(fresh.logs, MERCURY_PLAN_NOT_EXECUTABLE_MARKER)
  check(
    '(iii) a fresh answer refused by the same live blocker is not installed',
    fresh.thrown === null && fresh.result?.cached === false && fresh.result.goals.length === 0 &&
      fresh.result.op === 'patch' &&
      fresh.result.plan.provenance?.noGoalsReason === MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON,
    `thrown=${fresh.thrown === null ? 'none' : String(fresh.thrown)} result=${JSON.stringify(fresh.result?.plan)}`,
  )
  check(
    '(iii) the fresh verdict/refusal names the exact source and grounded blocker',
    freshVerdict.length === 1 && freshVerdict[0]!.includes('verdict=not_executable_now') &&
      freshVerdict[0]!.includes('intentSource=fresh') &&
      freshRefusal.length === 1 && freshRefusal[0]!.includes('candidateKind=ENTER_PORTAL') &&
      freshRefusal[0]!.includes('reason=needs_descend') &&
      freshRefusal[0]!.includes('missing=[descend_plan:no_support@27,78,-4:air]'),
    `verdict=${freshVerdict.join(' | ')} refusal=${freshRefusal.join(' | ')}`,
  )
  check(
    '(iii) fresh unexecutable WHAT is recorded with the exact typed refusal and never cached',
    fresh.transportCalls === 1 && fresh.callLog === 'written' &&
      fresh.call?.outcome === 'plan_rejected' &&
      (fresh.call?.executability as { verdict?: string } | undefined)?.verdict === 'not_executable_now' &&
      (fresh.call?.response as { goals?: unknown[] } | undefined)?.goals?.length === 1 &&
      fresh.call?.intentSource === 'enrichment' &&
      Object.keys(fresh.cacheAfter.entries).length === 0,
    `calls=${fresh.transportCalls} record=${JSON.stringify(fresh.call)} cache=${JSON.stringify(fresh.cacheAfter.entries)}`,
  )
  const frozen = Object.freeze(
    plannedGoalsFromMercury(CACHED_ENTER, summary).map((goal) => Object.freeze({ ...goal })),
  ) as readonly PlannedGoal[]
  const before = JSON.stringify(frozen)
  const verdict = classifyMercuryPlanExecutability(frozen, summary.blockers)
  check(
    '(iii) classifying a plan never mutates it',
    verdict.verdict === 'not_executable_now' && JSON.stringify(frozen) === before,
    `verdict=${verdict.verdict} before=${before} after=${JSON.stringify(frozen)}`,
  )
  const unknownSummary = mercuryState({ blockers: unrelatedBlockers() })
  unknownSummary.allowedGoals.collect.push('stone')
  const unknownPlan: MercuryPlanJson = {
    op: 'patch',
    goals: [{ kind: 'collect', item: 'stone', count: 12 }],
    reason: 'collect reachable stone',
  }
  const unknownFresh = await runFresh(unknownSummary, unknownPlan)
  const unknownVerdicts = linesWith(unknownFresh.logs, MERCURY_PLAN_EXECUTABILITY_MARKER)
  check(
    '(iii) fresh unknown executability remains unknown and does not trigger refusal or fallback',
    unknownFresh.thrown === null && unknownFresh.result?.cached === false && unknownFresh.result.goals.length > 0 &&
      unknownVerdicts.length === 1 && unknownVerdicts[0]!.includes('verdict=unknown') &&
      unknownVerdicts[0]!.includes('no_executor_mapping_for_goal:collect:stone:12') &&
      linesWith(unknownFresh.logs, MERCURY_PLAN_NOT_EXECUTABLE_MARKER).length === 0 &&
      !unknownFresh.logs.some((line) => line.startsWith('PLANNER_FALLBACK')),
    `thrown=${String(unknownFresh.thrown)} goals=${JSON.stringify(unknownFresh.result?.goals)} verdict=${unknownVerdicts.join(' | ')}`,
  )
}

// ---------------------------------------------------------------------------
// (iv) an unknown-executability state is the honest third outcome
// ---------------------------------------------------------------------------

{
  // (a) an ordinary summon: this tick measured NO refusal at all, so there is no
  // grounded verdict. The plan is not refused, and the apply is not silent.
  const ordinary = mercuryState()
  const run = await runReplay(ordinary, CACHED_ENTER, CACHED_ENTER_STRATEGY)
  const verdictLines = linesWith(run.logs, MERCURY_PLAN_EXECUTABILITY_MARKER)
  check(
    '(iv-a) with no measured refusal the verdict is unknown, not executable and not refused',
    verdictLines.length === 1 &&
      verdictLines[0]!.includes('verdict=unknown') &&
      verdictLines[0]!.includes('unknownReason=no_blocker_facts_in_state') &&
      linesWith(run.logs, MERCURY_PLAN_NOT_EXECUTABLE_MARKER).length === 0,
    verdictLines.join(' | '),
  )
  check(
    '(iv-a) the plan is applied (status quo preserved) but never REPORTED as verified-executable',
    run.result?.goals.length === 1 &&
      run.result.plan.provenance?.intentSource === 'cached' &&
      !run.logs.some((line) => line.includes('verdict=executable')),
    `goals=${JSON.stringify(run.result?.goals)}`,
  )

  // (b) a goal code owns no EXCLUSIVE executor mapping for: an unknown verdict
  // even though this tick DID measure refusals.
  const collected: MercuryPlanJson = { op: 'patch', goals: [{ item: 'stone', count: 12 }], reason: 'collect stone' }
  const unmappedSummary = mercuryState({ blockers: unrelatedBlockers() })
  const unmapped = await runReplay(unmappedSummary, collected, 'mercury_patch_collect_stone')
  const unmappedLines = linesWith(unmapped.logs, MERCURY_PLAN_EXECUTABILITY_MARKER)
  check(
    '(iv-b) a goal with no exclusive executor mapping is unknown, with the goal named in the reason',
    unmappedLines.length === 1 &&
      unmappedLines[0]!.includes('verdict=unknown') &&
      unmappedLines[0]!.includes('unknownReason=no_executor_mapping_for_goal:collect:stone:12') &&
      linesWith(unmapped.logs, MERCURY_PLAN_NOT_EXECUTABLE_MARKER).length === 0,
    unmappedLines.join(' | '),
  )
  check(
    '(iv-b) an unknown goal is still replayed exactly as today',
    JSON.stringify(unmapped.result?.goals) === JSON.stringify(plannedGoalsFromMercury(collected, unmappedSummary)),
    JSON.stringify(unmapped.result?.goals),
  )
}

// ---------------------------------------------------------------------------
// the classifier as a pure unit
// ---------------------------------------------------------------------------

{
  const enter = netherPortalEntryGoal('the_nether')
  const lit: PlannedGoal = { kind: 'place', description: 'light it', targetItem: 'nether_portal', requiredCount: 1, targetPredicate: PORTAL_LIT_PREDICATE }
  const collectStone: PlannedGoal = { kind: 'collect', description: 'collect stone', targetItem: 'stone', requiredCount: 12 }
  const undeclaredPlace: PlannedGoal = { kind: 'place', description: 'place a furnace', targetItem: 'furnace', requiredCount: 1 }

  check(
    '(unit) only goals with an exclusive code-owned executor get a candidate class',
    enter.targetPredicate === PORTAL_ENTERED_PREDICATE &&
      JSON.stringify(goalExecutorCandidateKinds(enter)) === '["ENTER_PORTAL"]' &&
      JSON.stringify(goalExecutorCandidateKinds(lit)) === '["IGNITE"]' &&
      goalExecutorCandidateKinds(collectStone) === null &&
      goalExecutorCandidateKinds(undeclaredPlace) === null,
    `enter=${JSON.stringify(goalExecutorCandidateKinds(enter))} lit=${JSON.stringify(goalExecutorCandidateKinds(lit))}`,
  )

  const blocked = classifyMercuryPlanExecutability([enter], liveBlockers())
  check(
    '(unit) not-executable-now carries the verbatim blocker, not a paraphrase',
    blocked.verdict === 'not_executable_now' &&
      blocked.unknownReason === null &&
      blocked.refusals.length === 1 &&
      blocked.refusals[0]!.index === 0 &&
      blocked.refusals[0]!.goal === 'place:nether_portal:1' &&
      blocked.refusals[0]!.candidate === 'ENTER:26,79,-4' &&
      blocked.refusals[0]!.candidateKind === 'ENTER_PORTAL' &&
      blocked.refusals[0]!.reason === 'needs_descend' &&
      JSON.stringify(blocked.refusals[0]!.missing) === '["descend_plan:no_support@27,78,-4:air"]',
    JSON.stringify(blocked),
  )
  check(
    '(unit) the three outcomes never collapse',
    classifyMercuryPlanExecutability([enter], unrelatedBlockers()).verdict === 'executable' &&
      classifyMercuryPlanExecutability([enter], undefined).verdict === 'unknown' &&
      classifyMercuryPlanExecutability([enter], null).verdict === 'unknown' &&
      classifyMercuryPlanExecutability([collectStone], unrelatedBlockers()).verdict === 'unknown' &&
      classifyMercuryPlanExecutability([], liveBlockers()).verdict === 'executable',
    JSON.stringify([
      classifyMercuryPlanExecutability([enter], unrelatedBlockers()),
      classifyMercuryPlanExecutability([enter], undefined),
      classifyMercuryPlanExecutability([collectStone], unrelatedBlockers()),
      classifyMercuryPlanExecutability([], liveBlockers()),
    ]),
  )
  check(
    '(unit) the mirrored lines are one line, stable, and carry the provenance token',
    formatMercuryPlanNotExecutable(blocked.refusals[0]!, 'cached').startsWith(`${MERCURY_PLAN_NOT_EXECUTABLE_MARKER} intentSource=cached `) &&
      formatMercuryPlanExecutability(blocked, { intentSource: 'cached', trigger: 'action_impossible', goals: 1 }).startsWith(
        `${MERCURY_PLAN_EXECUTABILITY_MARKER} verdict=not_executable_now intentSource=cached `,
      ) &&
      MERCURY_PLAN_NOT_EXECUTABLE_NO_GOALS_REASON === 'plan_not_executable_now',
    formatMercuryPlanNotExecutable(blocked.refusals[0]!, 'cached'),
  )
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const failures = checks.filter((entry) => !entry.pass)
console.log(`${checks.length - failures.length}/${checks.length} cached-plan-executability checks passed`)
for (const failure of failures) console.error(`FAILED ${failure.name} :: ${failure.detail}`)
if (failures.length > 0) process.exit(1)
