// test-wire-prereq-beta.mts - #63 wiring/compliance guard for #58 + #22.
//
// #63 found that a module (and its log markers) can exist without being on the
// runtime decision path, so "the marker exists" is not proof of semantics.
// This suite closes that class of gap for the two modules:
//
//   1. STATIC  - the controller/candidates sources actually invoke
//                `planPrereqOptions` / `formatPrereqSwitch` / `formatPrereqOptionFor`
//                and `betaAuthorityDecision`, and gate adoption behind
//                `options.betaAuthority`.
//   2. #58     - a held furnace chooses `place_held` and the logged line names
//                the path the controller actually follows (not the cost-optimal
//                one it overrode after a `PREREQ_SWITCH`).
//   3. #22     - with `betaAuthority:false`, beta=1 records `BETA_SHADOW ...
//                actual=continue` and can NEVER adopt, even unprotected.
//
// Pure: no bot, no network, no model.
import { readFileSync } from 'node:fs'
import { betaAuthorityDecision, formatJevHeads } from './src/betaAuthority.ts'
import { betaShadowDecision, formatBetaShadow, resolveBetaAuthority } from './src/jev.ts'
import { defaultCandidateOptions, furnacePrereqInputFromState, generateCandidates } from './src/candidates.ts'
import {
  evaluatePrereqStall,
  formatPrereqOptionFor,
  formatPrereqSwitch,
  nextPrereqPath,
  planPrereqOptions,
  prereqProgressSignature,
  PREREQ_STALL_TICKS_DEFAULT,
} from './src/prereqOption.ts'
import type { PrereqPath, PrereqProgress } from './src/prereqOption.ts'
import type { GoalLike } from './src/placementGuard.ts'
import type { AgentSignals, BlockState, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const smeltGoal: GoalLike = { kind: 'smelt', targetItem: 'iron_ingot' }
const collectGoal: GoalLike = { kind: 'collect', targetItem: 'diamond' }

function self(position: Vec3Json): SelfState {
  return {
    username: 'AI_WIRE',
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
    ...overrides,
  }
}

function smeltGoalState(): GoalState {
  return {
    id: 'smelt:iron_ingot',
    description: 'smelt 3 x iron_ingot',
    targetItem: 'iron_ingot',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function worldState(input: {
  inventory: InventoryState
  signals: AgentSignals
  placementSpots: Vec3Json[]
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self({ x: 29, y: 61, z: 35 }),
    inventory: input.inventory,
    entities: [],
    blocks: [] as BlockState[],
    terrain: { standable: [{ x: 29, y: 61, z: 35 }] },
    craftingTables: [],
    furnaces: [],
    placementSpots: input.placementSpots,
    goal: smeltGoalState(),
    goalQueue: {
      depth: 3,
      current: {
        id: 'g41:smelt:iron_ingot',
        kind: 'smelt',
        description: 'smelt 3 x iron_ingot',
        targetItem: 'iron_ingot',
        requiredCount: 3,
        startCount: 0,
        haveCount: 0,
        status: 'active',
        origin: 'llm',
        createdAt: 0,
        updatedAt: 0,
        detail: null,
      },
      empty: false,
      hasImpossible: false,
      done: 0,
      goals: [],
    },
    recentEvents: [],
    signals: input.signals,
  }
}

const knownFurnace: KnownResource = { name: 'furnace', kind: 'station', position: { x: 22, y: 66, z: 29 } }
const heldFurnace = worldState({
  inventory: inventory({ furnace: 1, raw_iron: 8, coal: 7, cobblestone: 112 }),
  signals: signals({ knownResources: [knownFurnace] }),
  placementSpots: [{ x: 30, y: 61, z: 35 }],
})
const prereqInput = furnacePrereqInputFromState(heldFurnace, defaultCandidateOptions)
const heldDecision = planPrereqOptions(prereqInput)

// --- 1. static wiring --------------------------------------------------------

addCase('#63: controller.ts calls applyFurnacePrereq on the tick candidate path', () => {
  const text = `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`
  const missing = [
    'const unreachableStations = this.unreachableStationKeys(state)',
    'candidates = this.applyFurnacePrereq(state, candidates, unreachableStations)',
  ].filter((needle) => !text.includes(needle))
  return {
    pass: missing.length === 0,
    detail:
      missing.length === 0
        ? 'tick calls applyFurnacePrereq(state, candidates, unreachableStations)'
        : `call site missing ${missing.join(', ')}`,
  }
})

addCase('#63: controller.ts invokes planPrereqOptions / formatPrereqSwitch / formatPrereqOptionFor', () => {
  const text = `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`
  const missing = ['planPrereqOptions(input)', 'formatPrereqSwitch(', 'formatPrereqOptionFor(decision, chosen)'].filter(
    (needle) => !text.includes(needle),
  )
  return { pass: missing.length === 0, detail: missing.length === 0 ? 'all prereqOption call sites present' : `missing ${missing.join(', ')}` }
})

addCase('#63: candidates.ts tags prereq candidates via planPrereqOptions + meta.prereqPath', () => {
  const text = source('./src/candidates.ts')
  const pass = text.includes('planPrereqOptions(input)') && text.includes('prereqPath: option.path')
  return { pass, detail: pass ? 'candidates.ts wires planPrereqOptions + prereqPath' : 'candidates wiring missing' }
})

addCase('#63: controller.ts gates beta adoption behind the verdict + betaAuthority', () => {
  const text = `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`
  const pass =
    text.includes('betaAuthorityDecision({') &&
    text.includes('classifyAbandonRequest({') &&
    text.includes('private abandonVerdict(') &&
    text.includes('private applyAbandon(') &&
    text.includes('this.options.betaAuthority') &&
    text.includes('return { adopt: vote.adopt')
  return { pass, detail: pass ? 'betaAuthorityDecision + abandonVerdict + authority path present' : 'beta gate missing' }
})

// --- 2. #58 prereq path ------------------------------------------------------

addCase('#58: a held furnace chooses place_held and logs the alternatives', () => {
  const expected = 'PREREQ_OPTION chosen=place_held over=[use_known_station,craft_and_place] reason=place_held cost=2'
  const candidate = generateCandidates(heldFurnace, defaultCandidateOptions).find((entry) => entry.meta.prereqPath !== undefined)
  const pass =
    heldDecision.chosen === 'place_held' &&
    heldDecision.line === expected &&
    candidate !== undefined &&
    candidate.id.startsWith('PLACE:furnace') &&
    candidate.meta.prereqPath === 'place_held'
  return { pass, detail: `${heldDecision.line} first=${candidate?.id ?? 'none'}` }
})

addCase('#63: after a forced switch the logged line names the path actually followed', () => {
  const forced = formatPrereqOptionFor(heldDecision, 'use_known_station')
  const identity = formatPrereqOptionFor(heldDecision, 'place_held')
  const pass =
    forced.startsWith('PREREQ_OPTION chosen=use_known_station over=[') &&
    forced.includes('reason=use_known_station cost=') &&
    identity === heldDecision.line &&
    heldDecision.line.startsWith('PREREQ_OPTION chosen=place_held')
  return { pass, detail: `forced="${forced}" identityOk=${identity === heldDecision.line}` }
})

addCase('#58: a stalled place_held switches to use_known_station instead of repeating', () => {
  const signature = prereqProgressSignature('place_held', prereqInput)
  let progress: PrereqProgress | null = null
  let stalled = false
  for (let tick = 0; tick <= PREREQ_STALL_TICKS_DEFAULT; tick += 1) {
    const evaluated = evaluatePrereqStall({ previous: progress, path: 'place_held', signature, stallTicks: PREREQ_STALL_TICKS_DEFAULT })
    progress = evaluated.progress
    stalled = evaluated.stalled
  }
  const next = nextPrereqPath(heldDecision, 'place_held')
  const switchLine = formatPrereqSwitch('place_held', (next ?? 'craft_and_place') as PrereqPath)
  const expected = 'PREREQ_SWITCH from=place_held to=use_known_station reason=no_progress'
  return { pass: stalled && next === 'use_known_station' && switchLine === expected, detail: `${switchLine} stalled=${stalled}` }
})

// --- 3. #22 beta shadow ------------------------------------------------------

addCase('#22: betaAuthority=false means beta=1 can never adopt (protected path)', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: 'shadow' }),
    abandonRequested: true,
    actionId: 'RETRIEVE:known:station:furnace:b29_61_35',
    goals: [smeltGoal],
    placedFurnaceCount: 0,
  })
  const shadow = betaShadowDecision({ optionId: 'smelt:iron_ingot', beta: 1, actualReplan: vote.adopt })
  const line = formatBetaShadow(shadow)
  const expected = 'BETA_SHADOW option=smelt:iron_ingot beta=1 threshold=0.5 would=abandon actual=continue'
  const heads = formatJevHeads('RETRIEVE:known:station:furnace:b29_61_35', 1, vote.adopt)
  const pass =
    vote.adopt === false &&
    vote.shadowed === true &&
    line === expected &&
    heads === 'JEV_HEADS action=RETRIEVE:known:station:furnace:b29_61_35 abandon=1 -> continue'
  return { pass, detail: `adopt=${vote.adopt} shadowed=${vote.shadowed} | ${line}` }
})

addCase('#22: betaAuthority=false means beta=1 cannot adopt even unprotected', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: 'shadow' }),
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  const shadow = betaShadowDecision({ optionId: 'collect:raw_iron', beta: 1, actualReplan: vote.adopt })
  const pass = vote.adopt === false && vote.shadowed === true && formatBetaShadow(shadow).endsWith('actual=continue')
  return { pass, detail: `adopt=${vote.adopt} shadowed=${vote.shadowed} | ${formatBetaShadow(shadow)}` }
})

addCase('#22: the same unprotected vote WOULD adopt only with explicit authority', () => {
  const vote = betaAuthorityDecision({
    betaAuthority: true,
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  const pass = vote.adopt === true && vote.shadowed === false && formatJevHeads('MINE:b10_64_0', 1, vote.adopt).endsWith('-> replan')
  return { pass, detail: `adopt=${vote.adopt} shadowed=${vote.shadowed}` }
})

let failures = 0
process.stdout.write('#63 wiring guard: prereqOption + betaAuthority are on the decision path (#58/#22)\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} wire-prereq-beta cases passed\n`)

if (failures > 0) process.exit(1)
