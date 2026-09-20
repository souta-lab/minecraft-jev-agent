// test-wire-prereq-beta.mts - #295 wiring/compliance guard for the #11 authority facade.
//
// The controller is now intentionally split:
//   controller.ts        = small #11 semantic-authority strangler/facade
//   controller-legacy.ts = preserved mechanical loop + explicit A/B baseline
//
// Structural tests therefore inspect the runtime composition, never one file in
// isolation. Legacy prerequisite ranking/stall behaviour is still tested as the
// explicit deterministic baseline, while the facade must prove that real Jev
// keeps WHICH authority. Beta is authoritative by default; shadow is explicit.
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
const runtimeControllerSource = (): string =>
  `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`

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

// --- 1. runtime composition / authority strangler ----------------------------

addCase('#295: runtime controller keeps the legacy prereq call site and the facade prevents it from seizing real-Jev WHICH authority', () => {
  const text = runtimeControllerSource()
  const legacyCall =
    text.includes('const unreachableStations = this.unreachableStationKeys(state)') &&
    text.includes('candidates = this.applyFurnacePrereq(state, candidates, unreachableStations)')
  const facadeStrangler =
    text.includes('internals.applyFurnacePrereq = (state, candidates, unreachableStations) => {') &&
    text.includes('if (!realJev(internals)) return legacyApplyPrereq(state, candidates, unreachableStations)') &&
    text.includes('clearLegacyPrereqSelection(internals)') &&
    text.includes('return [...candidates]')
  return {
    pass: legacyCall && facadeStrangler,
    detail: `legacyCall=${legacyCall} facadeStrangler=${facadeStrangler}`,
  }
})

addCase('#295: runtime composition retains the explicit deterministic prerequisite baseline wiring', () => {
  const text = runtimeControllerSource()
  const missing = ['planPrereqOptions(input)', 'formatPrereqSwitch(', 'formatPrereqOptionFor(decision, chosen)'].filter(
    (needle) => !text.includes(needle),
  )
  return { pass: missing.length === 0, detail: missing.length === 0 ? 'legacy A/B prereq wiring present' : `missing ${missing.join(', ')}` }
})

addCase('#63: candidates.ts tags prereq candidates via planPrereqOptions + meta.prereqPath', () => {
  const text = source('./src/candidates.ts')
  const pass = text.includes('planPrereqOptions(input)') && text.includes('prereqPath: option.path')
  return { pass, detail: pass ? 'candidates.ts wires planPrereqOptions + prereqPath' : 'candidates wiring missing' }
})

addCase('#295: runtime beta path retains baseline metadata but facade gives authoritative beta the final semantic verdict', () => {
  const text = runtimeControllerSource()
  const pass =
    text.includes('betaAuthorityDecision({') &&
    text.includes('classifyAbandonRequest({') &&
    text.includes('this.abandonVerdict(result, optionId, planId)') &&
    text.includes('internals.abandonVerdict = (decision, optionId, planId) => {') &&
    text.includes('const adopt = abandonRequested(decision)') &&
    text.includes('enforced: false') &&
    text.includes('suppressed: false')
  return { pass, detail: pass ? 'legacy evidence + authoritative facade verdict both present' : 'beta runtime composition missing' }
})

// --- 2. explicit deterministic A/B prerequisite baseline ---------------------

addCase('#58 baseline: a held furnace ranks place_held and logs the alternatives', () => {
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

addCase('#58 baseline: after a forced switch the logged line names the path actually followed', () => {
  const forced = formatPrereqOptionFor(heldDecision, 'use_known_station')
  const identity = formatPrereqOptionFor(heldDecision, 'place_held')
  const pass =
    forced.startsWith('PREREQ_OPTION chosen=use_known_station over=[') &&
    forced.includes('reason=use_known_station cost=') &&
    identity === heldDecision.line &&
    heldDecision.line.startsWith('PREREQ_OPTION chosen=place_held')
  return { pass, detail: `forced="${forced}" identityOk=${identity === heldDecision.line}` }
})

addCase('#58 baseline: a stalled place_held can switch to use_known_station', () => {
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

// --- 3. #11 beta default authority + explicit shadow -------------------------

addCase('#295: explicit beta shadow means beta=1 cannot adopt on the protected baseline path', () => {
  const shadowMode = resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: 'shadow' })
  const vote = betaAuthorityDecision({
    betaAuthority: shadowMode,
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
    shadowMode === false &&
    vote.adopt === false &&
    vote.shadowed === true &&
    line === expected &&
    heads === 'JEV_HEADS action=RETRIEVE:known:station:furnace:b29_61_35 abandon=1 -> continue'
  return { pass, detail: `mode=${shadowMode} adopt=${vote.adopt} shadowed=${vote.shadowed} | ${line}` }
})

addCase('#295: explicit beta shadow means beta=1 cannot adopt even unprotected', () => {
  const shadowMode = resolveBetaAuthority({ BUDDY_BETA_AUTHORITY: 'shadow' })
  const vote = betaAuthorityDecision({
    betaAuthority: shadowMode,
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  const shadow = betaShadowDecision({ optionId: 'collect:raw_iron', beta: 1, actualReplan: vote.adopt })
  const pass = shadowMode === false && vote.adopt === false && vote.shadowed === true && formatBetaShadow(shadow).endsWith('actual=continue')
  return { pass, detail: `mode=${shadowMode} adopt=${vote.adopt} shadowed=${vote.shadowed} | ${formatBetaShadow(shadow)}` }
})

addCase('#295: beta authority is ON by default and an unprotected positive vote can adopt', () => {
  const defaultAuthority = resolveBetaAuthority({})
  const vote = betaAuthorityDecision({
    betaAuthority: defaultAuthority,
    abandonRequested: true,
    actionId: 'MINE:b10_64_0',
    goals: [collectGoal],
    placedFurnaceCount: 0,
  })
  const pass =
    defaultAuthority === true &&
    vote.adopt === true &&
    vote.shadowed === false &&
    formatJevHeads('MINE:b10_64_0', 1, vote.adopt).endsWith('-> replan')
  return { pass, detail: `defaultAuthority=${defaultAuthority} adopt=${vote.adopt} shadowed=${vote.shadowed}` }
})

let failures = 0
process.stdout.write('#295 wiring guard: authority facade + explicit legacy baseline\n')
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
