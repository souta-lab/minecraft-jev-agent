// test-candidate-starvation.mts - two boundary defects behind the live
// `CANDIDATE_STARVATION presented=2 productive=0 goal="collect:raw_iron:23"
// blockedBy=precondition:pickaxe missing=["RETRIEVE:known:raw_iron:b37_56_41:open_path"]`
// loop (repeat=12..14, Jev re-selected ESCALATE, ACTION_UNVERIFIED):
//
//  (a) an unreachable RETRIEVE/collect target was dropped and replaced by a bare
//      missingCapabilities report, so the policy only ever saw WAIT/ESCALATE. The
//      generator's existing STEP/MOVE/DESCEND families must be contributed as the
//      enabling affordance (CAN enumeration only; the model keeps WHAT and WHICH).
//
//  (b) repeated `productive=0` never triggered the System2/Mercury re-summon
//      path (`needLlm`/`llmResummon`). It must, at a small repeat threshold, with
//      a `candidate_starvation` reason - and must NOT substitute a deterministic
//      plan.
//
// Pure: no bot, no network, no model. Run: npx tsx test-candidate-starvation.mts
import { readFileSync } from 'node:fs'
import {
  applyReachabilityGate,
  defaultCandidateOptions,
  digAccessCandidateId,
  generateGroundedCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { evaluateSummonConditions, LLM_SUMMON_REASONS } from './src/system2.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, StepCut, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

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

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
    ...overrides,
  }
}

function goal(targetItem: string): GoalState {
  return {
    id: `collect:${targetItem}`,
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queuedGoal(targetItem: string): QueuedGoal {
  return {
    id: `g-${targetItem}`,
    kind: 'collect',
    description: `collect 1 x ${targetItem}`,
    targetItem,
    requiredCount: 1,
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

const BOT: Vec3Json = { x: 0, y: 60, z: 0 }
const FRONTIER: Vec3Json = { x: 5, y: 60, z: 0 }
const KNOWN_IRON: Vec3Json = { x: 37, y: 56, z: 41 }

const CUT: StepCut = {
  dir: 'E',
  dx: 1,
  dz: 0,
  cut: { x: 1, y: 61, z: 0 },
  step: { x: 1, y: 61, z: 0 },
  name: 'stone',
  safe: true,
  reason: 'safe',
}

function worldState(overrides: {
  position?: Vec3Json
  inventory?: InventoryState
  signals?: AgentSignals
  standable?: Vec3Json[]
  stepCuts?: WorldState['stepCuts']
  descent?: WorldState['descent']
  blocks?: BlockState[]
  goal: GoalState
  goalQueue?: GoalQueueState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position ?? BOT),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: overrides.blocks ?? [],
    terrain: { standable: overrides.standable ?? [BOT, FRONTIER] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    descent: overrides.descent ?? [],
    stepCuts: overrides.stepCuts ?? [],
    headroomCuts: [],
    goal: overrides.goal,
    goalQueue: overrides.goalQueue ?? queueWith(queuedGoal(overrides.goal.targetItem ?? 'log')),
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

/** The live path probe: the remembered target has no path, the frontier does. */
const livePathProbe = (position: Vec3Json): 'reachable' | 'no_path' =>
  position.x === KNOWN_IRON.x && position.z === KNOWN_IRON.z ? 'no_path' : 'reachable'

function optionsWith(pathProbe: CandidateOptions['reachability']): CandidateOptions {
  return { ...defaultCandidateOptions, reachability: pathProbe ?? null }
}

function productive(candidates: readonly Candidate[]): Candidate[] {
  return candidates.filter((candidate) => candidate.kind !== 'WAIT' && candidate.kind !== 'ESCALATE')
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
  process.stdout.write('candidate starvation: enabling affordance + model re-summon\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // Dynamic so the red run against the fixed base reports the missing export as a
  // failed check instead of aborting the whole suite on a module-load error.
  const controllerModule = (await import('./src/controller.ts')) as unknown as Record<string, unknown>
  const candidateStarvationSummon = controllerModule.candidateStarvationSummon as StarvationSummonFn | undefined

  // (a) RED: the live shape - a remembered raw_iron with no path. Before the fix
  // the RETRIEVE is withheld with `open_path` and NOTHING productive is presented.
  {
    const state = worldState({
      signals: signals({
        escalationRecommended: true,
        knownResources: [{ name: 'iron_ore', kind: 'ore', position: KNOWN_IRON }],
      }),
      stepCuts: [CUT],
      goal: goal('raw_iron'),
    })
    const grounded = generateGroundedCandidates(state, optionsWith({ memory: null, pathProbe: livePathProbe }))
    const withheld = grounded.withheld.find((entry) => entry.candidate.id.startsWith('RETRIEVE:known:raw_iron'))
    const presented = productive(grounded.candidates)
    await check(
      '(a) an unreachable RETRIEVE is withheld with open_path (the live capability)',
      withheld !== undefined && withheld.result.missingCapabilities.some((capability) => capability.kind === 'open_path'),
      `withheld=${withheld?.candidate.id ?? 'none'} reason=${withheld?.result.reason ?? 'none'} missing=[${(withheld?.result.missingCapabilities ?? []).map((c) => c.kind).join(',')}]`,
    )
    await check(
      '(a) generic enabling candidates are PRESENTED, not only WAIT/ESCALATE',
      presented.length > 0 &&
        presented.some((candidate) => candidate.kind === 'STEP' || candidate.kind === 'MOVE' || candidate.kind === 'DESCEND'),
      `productive=[${presented.map((candidate) => `${candidate.kind}:${candidate.id}`).join(',')}] all=[${grounded.candidates.map((candidate) => candidate.id).join(',')}]`,
    )
    const step = grounded.candidates.find((candidate) => candidate.kind === 'STEP')
    await check(
      '(a) the enabling candidate is attributed to the withheld capability (generic, acquisition-tagged)',
      step !== undefined && step.meta.capabilityAcquisition === true && step.meta.missingCapability === 'open_path',
      step === undefined ? 'no STEP presented' : JSON.stringify(step.meta),
    )
  }

  // (a2) the `standable_approach` capability: a dig target with no interaction
  // stand is dropped as `no_standable_approach`; the same STEP/MOVE affordance must
  // be on offer (the task's other named reason).
  {
    const state = worldState({
      stepCuts: [CUT],
      goal: goal('raw_iron'),
    })
    const digRefused: Candidate = {
      id: digAccessCandidateId({ x: 10, y: 64, z: 0 }),
      kind: 'MOVE',
      label: 'no reachable dig access for iron_ore',
      targetName: 'iron_ore',
      target: { x: 10, y: 64, z: 0 },
      targetEntityId: null,
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: false,
      hasStandableAdjacent: false,
      meta: { tick: state.tick, digAccess: true, digAccessRefusal: 'no_interaction_stand' },
    }
    const gated = applyReachabilityGate([digRefused], state, optionsWith({ memory: null, pathProbe: () => 'reachable' }))
    const presented = productive(gated.candidates)
    await check(
      '(a2) a dropped standable_approach target still contributes the STEP/MOVE affordance',
      gated.withheld[0]?.result.reason === 'no_standable_approach' &&
        presented.some((candidate) => candidate.kind === 'STEP' || candidate.kind === 'MOVE'),
      `withheld=${gated.withheld[0]?.result.reason ?? 'none'} presented=[${presented.map((candidate) => `${candidate.kind}:${candidate.id}`).join(',')}]`,
    )
  }

  // (b) RED: repeated productive=0 triggers the System2/Mercury re-summon reason.
  {
    const below = candidateStarvationSummon?.(0, 1, 'collect:raw_iron:23', 'precondition:pickaxe')
    const repeated = candidateStarvationSummon?.(0, 2, 'collect:raw_iron:23', 'precondition:pickaxe', [
      'RETRIEVE:known:raw_iron:b37_56_41:open_path',
    ])
    const healthy = candidateStarvationSummon?.(1, 9, 'collect:raw_iron:23', 'no_productive_action')
    await check(
      '(b) a single starved tick does not summon (small threshold)',
      candidateStarvationSummon !== undefined && below?.summon === false,
      `defined=${candidateStarvationSummon !== undefined} summon=${below?.summon ?? 'n/a'} detail=${below?.detail ?? 'n/a'}`,
    )
    await check(
      '(b) repeated productive=0 triggers the re-summon path with candidate_starvation',
      repeated?.summon === true && repeated.reason === 'candidate_starvation' && repeated.detail.includes('candidate_starvation'),
      `summon=${repeated?.summon ?? 'n/a'} reason=${repeated?.reason ?? 'n/a'} detail=${repeated?.detail ?? 'n/a'}`,
    )
    await check(
      '(b) a productive candidate clears the starvation summon',
      healthy?.summon === false,
      `summon=${healthy?.summon ?? 'n/a'}`,
    )
    await check(
      '(b) no deterministic plan is substituted (the decision is a resummon reason only)',
      repeated !== undefined &&
        !('goals' in repeated) &&
        !('plan' in repeated) &&
        LLM_SUMMON_REASONS.some((reason) => reason === repeated.reason),
      `keys=[${repeated === undefined ? 'n/a' : Object.keys(repeated).join(',')}]`,
    )
    await check(
      '(b) candidate_starvation is a documented summon reason and condition',
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

  // (c) wiring: the generator contributes the route-opening families and the
  // controller invokes the re-summon path. No applyPlan in the starvation branch.
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
    await check(
      '(c) enabling-affordance generation and starvation re-summon are wired',
      candidatesWired && controllerWired,
      `candidates=${candidatesWired} controller=${controllerWired}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`candidate-starvation: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
