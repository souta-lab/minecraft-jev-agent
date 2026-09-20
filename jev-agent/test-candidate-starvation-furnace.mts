// test-candidate-starvation-furnace.mts - FOCUSED regression for the frozen run
// run-mu98ondr-192ql (RC_SHA 928601f), classified boundary = candidate starvation
// on the M2 `place:furnace` rung.
//
// The run had `OPTION_COMPILE emitted place:furnace` (furnace=1, iron_ingot=3,
// iron_pickaxe=1) and the next evidence was exactly:
//
//   REACHABILITY candidate=MOVE:p56_60_24 reachable=false reason=no_path missing=[open_path]
//   CANDIDATE_WITHHELD
//   CANDIDATE_STARVATION goal=place:furnace:1 presented=2 productive=0
//
// Only WAIT / ESCALATE were on offer, so Jev could not make a mechanically valid
// body change and re-selected ESCALATE. The reachability gate's
// capability-acquisition pass already turns a withheld target into grounded
// enabling candidates for `headroom`, `tool` and `descend_plan`; it had no arm
// for `open_path` / `standable_approach`, so a locomotion target refused for
// `no_path` / `no_standable_approach` contributed NOTHING.
//
// This suite proves, for the exact `place:furnace` shape:
//   (a) the withheld `MOVE:p56_60_24` is still the live no_path/open_path refusal
//       and the pre-fix set is the barren `presented=2 productive=0` one;
//   (b) after the port the existing generic route-opening family (STEP / MOVE /
//       DESCEND) is enumerated as the `open_path` acquisition, so Jev is offered
//       a forward body change instead of a permanent WAIT;
//   (c) no deterministic selection/priority/ranking/substitution is injected -
//       the candidates are facts and the model keeps WHAT and WHICH;
//   (d) repeated `productive=0` triggers the System2/Mercury re-summon with a
//       `candidate_starvation` reason and never a deterministic plan.
//
// Pure: no bot, no network, no model. Run: npx tsx test-candidate-starvation-furnace.mts
import { readFileSync } from 'node:fs'
import { applyReachabilityGate, blockId, defaultCandidateOptions } from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { capabilityKey } from './src/reachability.ts'
import { evaluateSummonConditions, LLM_SUMMON_REASONS } from './src/system2.ts'
import type { DescentOption, GoalState, InventoryState, StepCut, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}
function note(label: string, detail: string): void {
  process.stdout.write(`NOTE  ${label}\n      ${detail}\n`)
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

// --- the exact live boundary shape --------------------------------------------

const BOT: Vec3Json = { x: 0.5, y: 60, z: 0.5 }
/** The live unreachable MOVE destination `MOVE:p56_60_24`. */
const OPEN_TARGET: Vec3Json = { x: 56, y: 60, z: 24 }
/** A standable frontier that IS reachable: the route-opening MOVE fact. */
const FRONTIER: Vec3Json = { x: 3, y: 60, z: 0 }

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_STARVE',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function goal(targetItem: string): GoalState {
  return {
    id: `goal:${targetItem}`,
    description: `place ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string, kind: QueuedGoal['kind'], requiredCount = 1): QueuedGoal {
  return {
    id: `g-${targetItem}`,
    kind,
    description: `place 1 x ${targetItem}`,
    targetItem,
    requiredCount,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  inventory?: InventoryState
  goal: GoalState
  goalQueue: GoalQueueState
  standable?: Vec3Json[]
  stepCuts?: StepCut[]
  descent?: DescentOption[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 11,
    timestampMs: 1_700_000_000_000,
    self: self(BOT),
    inventory: overrides.inventory ?? inventory({ furnace: 1, iron_ingot: 3, iron_pickaxe: 1 }),
    entities: [],
    blocks: [],
    terrain: { standable: overrides.standable ?? [BOT, FRONTIER] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: overrides.stepCuts ?? [],
    headroomCuts: [],
    goal: overrides.goal,
    goalQueue: overrides.goalQueue,
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: 'path_no_path',
      lastPathStatus: 'noPath',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: true,
      failedCandidates: {},
      knownResources: [],
    },
  }
}

function waitCandidate(tick: number): Candidate {
  return {
    id: 'WAIT',
    kind: 'WAIT',
    label: 'do nothing for one tick',
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick, waitMs: 300 },
  }
}

/** The live `MOVE:p56_60_24` whose own destination has no path. */
function unreachableMove(tick: number): Candidate {
  return {
    id: `MOVE:${blockId('p', OPEN_TARGET)}`,
    kind: 'MOVE',
    label: 'walk to the unreachable furnace placement spot',
    targetName: null,
    target: OPEN_TARGET,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: { tick },
  }
}

/** `no_path` for the live MOVE target only; every other destination is reachable. */
const pathProbe = (position: Vec3Json): 'no_path' | 'reachable' =>
  position.x === OPEN_TARGET.x && position.z === OPEN_TARGET.z ? 'no_path' : 'reachable'

function optionsWith(): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: { memory: null, pathProbe } }
}

const isProductive = (candidate: Candidate): boolean =>
  candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE'

const productive = (candidates: readonly Candidate[]): Candidate[] => candidates.filter(isProductive)

const selectionKeys = ['priority', 'rank', 'order', 'selected', 'chosen', 'forced', 'deterministic', 'override']

function safeStepCut(): StepCut {
  return {
    dir: 'E',
    dx: 1,
    dz: 0,
    cut: { x: 1, y: 61, z: 0 },
    step: { x: 1, y: 61, z: 0 },
    name: 'dirt',
    safe: true,
    reason: 'safe',
  }
}

function downDescent(): DescentOption {
  return {
    dir: 'N',
    mode: 'down',
    dx: 0,
    dz: -1,
    step: { x: 0, y: 59, z: -1 },
    wall: { x: 0, y: 60, z: -1 },
    head: { x: 0, y: 61, z: -1 },
    floor: { x: 0, y: 59, z: -1 },
    wallSolid: true,
    headSolid: false,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'dirt',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  }
}

interface StarvationSummon {
  summon: boolean
  reason: string
  detail: string
}
type StarvationSummonFn = (
  productive: number,
  repeats: number,
  goal: string,
  blockedBy: string,
  missing?: readonly string[],
  threshold?: number,
) => StarvationSummon

async function main(): Promise<void> {
  process.stdout.write('candidate starvation (place:furnace, run-mu98ondr-192ql)\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // Dynamic so the red run against the unported 928601f reports the missing export
  // as a failed check instead of aborting the suite on a module-load error.
  const controllerModule = (await import('./src/controller.ts')) as unknown as Record<string, unknown>
  const candidateStarvationSummon = controllerModule.candidateStarvationSummon as StarvationSummonFn | undefined
  const candidateStarvationLine = controllerModule.candidateStarvationLine as (
    candidates: readonly Candidate[],
    goal: string,
    goalComplete: boolean,
    blockedBy: string,
    missing?: readonly string[],
  ) => string | null

  const placeState = worldState({
    goal: goal('furnace'),
    goalQueue: queueWith(queuedGoal('furnace', 'place', 1)),
    stepCuts: [safeStepCut()],
  })

  // (a) the live boundary: the exact `MOVE:p56_60_24` refusal and the barren set.
  {
    const raw = [waitCandidate(placeState.tick), unreachableMove(placeState.tick)]
    const grounded = applyReachabilityGate(raw, placeState, optionsWith())
    const withheld = grounded.withheld.find((entry) => entry.candidate.id === `MOVE:${blockId('p', OPEN_TARGET)}`)
    const missing = (withheld?.result.missingCapabilities ?? []).map(capabilityKey)

    check(
      '(a) live shape: MOVE:p56_60_24 is withheld for no_path with missing=[open_path]',
      withheld !== undefined && withheld.result.reason === 'no_path' && missing.join(',') === 'open_path',
      `id=${withheld?.candidate.id ?? 'none'} reason=${withheld?.result.reason ?? 'none'} missing=[${missing.join(',')}]`,
    )
    // The exact marker the controller logs while the set is barren (the frozen
    // run-mu98ondr-192ql line). After the port it must disappear.
    const marker = candidateStarvationLine(
      grounded.candidates,
      'place:furnace:1',
      false,
      'no_productive_action',
      [`MOVE:${blockId('p', OPEN_TARGET)}:open_path`],
    )
    const presentedCount = grounded.candidates.length
    const productiveCount = productive(grounded.candidates).length
    note(
      '(a) frozen-run baseline',
      marker === null
        ? `CANDIDATE_STARVATION absent after the port (presented=${presentedCount} productive=${productiveCount})`
        : `CANDIDATE_STARVATION presented=2 productive=0 goal="place:furnace:1" blockedBy=no_productive_action missing=["MOVE:p56_60_24:open_path"]`,
    )
    check(
      '(a) the live starvation marker is reproduced while barren and removed once enabling facts exist',
      marker === null ||
        marker.includes('CANDIDATE_STARVATION presented=2 productive=0 goal="place:furnace:1"'),
      `marker=${marker ?? 'none'}`,
    )
  }

  // (b) after the port: the generic route-opening family is the open_path acquisition.
  {
    const grounded = applyReachabilityGate(
      [waitCandidate(placeState.tick), unreachableMove(placeState.tick)],
      placeState,
      optionsWith(),
    )
    const productiveCandidates = productive(grounded.candidates)
    const acquisitions = productiveCandidates.filter((candidate) => candidate.meta.capabilityAcquisition === true)
    const kinds = acquisitions.map((candidate) => candidate.kind)
    const step = acquisitions.find((candidate) => candidate.kind === 'STEP')
    const move = acquisitions.find((candidate) => candidate.kind === 'MOVE')
    const enabled = step !== undefined || move !== undefined || acquisitions.some((c) => c.kind === 'DESCEND')

    check(
      '(b) route-opening candidates are presented instead of a barren WAIT-only set',
      productiveCandidates.length > 0 && enabled,
      `productive=[${productiveCandidates.map((candidate) => `${candidate.kind}:${candidate.id}`).join(',')}]`,
    )
    check(
      '(b) the route-opening family (STEP/MOVE/DESCEND) is offered',
      step !== undefined && move !== undefined,
      `families=[${[...new Set(kinds)].join(',')}]`,
    )
    check(
      '(b) every enabling candidate is attributed to the withheld open_path capability',
      acquisitions.length >= 2 &&
        acquisitions.every((candidate) => candidate.meta.missingCapability === 'open_path'),
      `acquisitions=[${acquisitions.map((candidate) => `${candidate.id}:${String(candidate.meta.missingCapability)}`).join(',')}]`,
    )
    check(
      '(b) the withheld MOVE target itself is still NOT presented (reachability truth preserved)',
      grounded.candidates.every((candidate) => candidate.id !== `MOVE:${blockId('p', OPEN_TARGET)}`),
      `presented=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    const marker = candidateStarvationLine(
      grounded.candidates,
      'place:furnace:1',
      false,
      'no_productive_action',
      [],
    )
    check(
      '(b) after the fix the starvation marker is gone (productive>0)',
      marker === null,
      `marker=${marker ?? 'none'} productive=${productiveCandidates.length}`,
    )
  }

  // (c) authority: the gate enumerates facts, it never picks or ranks.
  {
    const grounded = applyReachabilityGate(
      [waitCandidate(placeState.tick), unreachableMove(placeState.tick)],
      placeState,
      optionsWith(),
    )
    const acquisitions = grounded.candidates.filter((candidate) => candidate.meta.capabilityAcquisition === true)
    const families = new Set(acquisitions.map((candidate) => candidate.kind))
    const carriesSelection = acquisitions.some((candidate) =>
      selectionKeys.some((key) => candidate.meta[key] !== undefined),
    )
    check(
      '(c) no deterministic selection/priority/ranking is injected into the enabling facts',
      acquisitions.length > 0 && !carriesSelection,
      `selectionKeys=${selectionKeys.filter((key) => acquisitions.some((candidate) => candidate.meta[key] !== undefined)).join(',') || 'none'}`,
    )
    check(
      '(c) more than one candidate family remains, so Jev still SELECTS',
      families.size >= 2,
      `families=[${[...families].join(',')}]`,
    )
  }

  // (b2) generic: a proven safe down step also yields the DESCEND recovery for a
  // non-place goal - no item/coordinate special-casing.
  {
    const collect = worldState({
      goal: goal('cobblestone'),
      goalQueue: queueWith(queuedGoal('cobblestone', 'collect', 1)),
      descent: [downDescent()],
    })
    const grounded = applyReachabilityGate(
      [waitCandidate(collect.tick), unreachableMove(collect.tick)],
      collect,
      optionsWith(),
    )
    const descend = grounded.candidates.find(
      (candidate) => candidate.kind === 'DESCEND' && candidate.meta.capabilityAcquisition === true,
    )
    check(
      '(b2) a proven safe down step yields the generic DESCEND open_path acquisition',
      descend !== undefined && descend.meta.missingCapability === 'open_path',
      `descend=${descend === undefined ? 'none' : descend.id} candidates=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
  }

  // (d) the starvation re-summon path: repeated productive=0 wakes System2/Mercury
  // with a `candidate_starvation` reason and NEVER a deterministic plan.
  {
    const below = candidateStarvationSummon?.(0, 1, 'place:furnace:1', 'no_productive_action')
    const repeated = candidateStarvationSummon?.(0, 2, 'place:furnace:1', 'no_productive_action', [
      `MOVE:${blockId('p', OPEN_TARGET)}:open_path`,
    ])
    const healthy = candidateStarvationSummon?.(1, 9, 'place:furnace:1', 'no_productive_action')

    check(
      '(d) a single starved tick does not re-summon',
      candidateStarvationSummon !== undefined && below?.summon === false,
      `defined=${candidateStarvationSummon !== undefined} summon=${below?.summon ?? 'n/a'}`,
    )
    check(
      '(d) repeated productive=0 triggers the candidate_starvation re-summon',
      repeated?.summon === true && repeated.reason === 'candidate_starvation' && repeated.detail.includes('candidate_starvation'),
      `summon=${repeated?.summon ?? 'n/a'} reason=${repeated?.reason ?? 'n/a'} detail=${repeated?.detail ?? 'n/a'}`,
    )
    check(
      '(d) a productive candidate clears the starvation re-summon',
      healthy?.summon === false,
      `summon=${healthy?.summon ?? 'n/a'}`,
    )
    check(
      '(d) no deterministic plan/goal is substituted (reason only, WHAT stays with System2)',
      repeated !== undefined &&
        !('goals' in repeated) &&
        !('plan' in repeated) &&
        LLM_SUMMON_REASONS.some((reason) => reason === repeated.reason),
      `keys=[${repeated === undefined ? 'n/a' : Object.keys(repeated).join(',')}]`,
    )
    check(
      '(d) candidate_starvation is a documented summon reason and condition',
      LLM_SUMMON_REASONS.includes('candidate_starvation') &&
        evaluateSummonConditions({
          queueEmpty: false,
          needLlm: false,
          actionImpossible: false,
          unknownSituation: false,
          noProgress: false,
          candidateStarvation: true,
        }).includes('candidate_starvation'),
      `reasons=[${LLM_SUMMON_REASONS.join(',')}]`,
    )
  }

  // (e) wiring: the generator contributes the route-opening families and the
  // controller invokes the re-summon; the starvation branch calls no applyPlan.
  {
    const candidates = source('./src/candidates.ts')
    const controller = source('./src/controller-legacy.ts')
    const candidatesWired =
      candidates.includes('function routeOpeningCandidates') &&
      candidates.includes("capability.kind === 'standable_approach' || capability.kind === 'open_path'") &&
      candidates.includes('stepCutCandidates(state, options)') &&
      candidates.includes('descendCandidates(state, options, focus, [], null)')
    const controllerWired =
      controller.includes('export function candidateStarvationSummon') &&
      controller.includes('this.summonLlm(starvationSummon.reason, starvationSummon.detail)')
    check(
      '(e) enabling-affordance generation and starvation re-summon are wired',
      candidatesWired && controllerWired,
      `candidates=${candidatesWired} controller=${controllerWired}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`candidate-starvation-furnace: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
