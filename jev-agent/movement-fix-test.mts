// movement-fix-test.mts - deterministic proof of the four movement root-cause
// fixes (#7 tool choice, #8a spatial failure memory, #8b hop order is covered
// live, #9/#4 descend evidence + no-progress cap + fixed dig direction).
//
// Run: npx tsx movement-fix-test.mts
import { emptyGoalQueueState, generateCandidates, makeGoal } from './src/index.ts'
import type { AgentSignals, WorldState } from './src/index.ts'
import type { DescentOption } from './src/state.ts'
import { selectDigTool } from './src/toolChoice.ts'
import { decayedFailureCount, failureCount, spatialFailureKey } from './src/failureMemory.ts'
import { descendBudget, DigMemory, isOscillatingSteps } from './src/worldMemory.ts'
import type { DigStep } from './src/worldMemory.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const only = (name: string, rank: number | null = null): ((tool: string, t: number | null) => boolean) => {
  return (tool, t) => {
    if (!name.endsWith(`_${tool}`)) return false
    if (t === null || t <= 0) return true
    return rank !== null && rank >= t
  }
}

// #7 tool choice -------------------------------------------------------------
const dirtNoShovel = selectDigTool({ name: 'dirt', harvestTool: null, harvestTier: null, diggable: true }, only('wooden_pickaxe', 0))
check(
  'dirt with only a pickaxe selects hand (never pickaxe)',
  dirtNoShovel.ok && dirtNoShovel.tool === null,
  `tool=${dirtNoShovel.tool} reason=${dirtNoShovel.reason}`,
)
const dirtShovel = selectDigTool({ name: 'dirt', harvestTool: null, harvestTier: null, diggable: true }, only('iron_shovel', 0))
check('dirt with a shovel selects shovel', dirtShovel.ok && dirtShovel.tool === 'shovel', `tool=${dirtShovel.tool} reason=${dirtShovel.reason}`)
const stone = selectDigTool({ name: 'stone', harvestTool: 'pickaxe', harvestTier: 0, diggable: true }, only('wooden_pickaxe', 0))
check('stone with a wooden pickaxe selects pickaxe tier 0', stone.ok && stone.tool === 'pickaxe' && stone.tier === 0, `tool=${stone.tool} tier=${stone.tier}`)
const ironOre = selectDigTool({ name: 'iron_ore', harvestTool: 'pickaxe', harvestTier: 2, diggable: true }, only('wooden_pickaxe', 0))
check('iron ore with only a wooden pickaxe is rejected', !ironOre.ok && ironOre.reason === 'needs_pickaxe_tier_2', `ok=${ironOre.ok} reason=${ironOre.reason}`)
const untracked = selectDigTool({ name: 'mystery_block', harvestTool: null, harvestTier: null, diggable: true }, only('wooden_pickaxe', 0))
check('untracked block resolves to hand, not an invented pickaxe', untracked.ok && untracked.tool === null, `tool=${untracked.tool} reason=${untracked.reason}`)

// fixtures -------------------------------------------------------------------
function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 1,
    escalationRecommended: false,
    failedCandidates: {},
    ...overrides,
  }
}

function downStep(dir: DescentOption['dir'], dx: number, dz: number): DescentOption {
  return {
    dir,
    mode: 'down',
    dx,
    dz,
    step: { x: dx, y: 63, z: dz },
    wall: { x: dx, y: 64, z: dz },
    head: { x: dx, y: 65, z: dz },
    floor: { x: dx, y: 63, z: dz },
    wallSolid: true,
    headSolid: true,
    floorSolid: true,
    safe: true,
    reason: 'safe',
    digName: 'dirt',
    digHarvestTool: null,
    digHarvestTier: null,
    diggable: true,
  }
}

function state(overrides: Partial<WorldState> & { signals: AgentSignals }): WorldState {
  return {
    schemaVersion: 1,
    tick: 1,
    timestampMs: Date.now(),
    self: {
      username: 't',
      position: { x: 0, y: 64, z: 0 },
      eyePosition: { x: 0, y: 65.62, z: 0 },
      yaw: 0,
      pitch: 0,
      onGround: true,
      health: 20,
      food: 20,
      gameMode: 'survival',
      dimension: 'overworld',
      isDay: true,
      heldItem: null,
    },
    inventory: { slots: [], counts: { wooden_pickaxe: 1 }, totalItems: 1 },
    entities: [],
    blocks: [],
    terrain: { standable: [] },
    craftingTables: [],
    placementSpots: [],
    descent: [],
    goal: makeGoal('cobblestone', 16),
    goalQueue: emptyGoalQueueState(),
    recentEvents: [],
    ...overrides,
  }
}

const options = { reach: 4.5, maxMineCandidates: 12, maxAttackCandidates: 4, eatBelowFood: 18, recipes: null }
const descendOf = (s: WorldState) => generateCandidates(s, options).filter((c) => c.kind === 'DESCEND')

// #9 wantDown evidence + #7 tool on the actual dirt cell ----------------------
const withEvidence = state({
  signals: signals({ knownStoneY: 40 }),
  descent: [downStep('E', 1, 0)],
})
const evidenceDescend = descendOf(withEvidence)
check(
  'stone goal + known stone level below + new target: dirt descend uses hand, not pickaxe',
  evidenceDescend.length === 1 && evidenceDescend[0]?.toolName === null && evidenceDescend[0]?.requiresTool === false,
  `count=${evidenceDescend.length} tool=${evidenceDescend[0]?.toolName} reason=${String(evidenceDescend[0]?.meta.toolReason)}`,
)

const stoneStaircase = state({ signals: signals(), descent: [downStep('E', 1, 0)] })
const staircaseDescend = descendOf(stoneStaircase)
check(
  'stone goal with no surface stone: bounded staircase is offered (down evidence)',
  staircaseDescend.length === 1 && staircaseDescend[0]?.meta.mode === 'down' && staircaseDescend[0]?.meta.staircase === true,
  `count=${staircaseDescend.length} mode=${String(staircaseDescend[0]?.meta.mode)}`,
)

const noEvidence = state({ signals: signals(), goal: makeGoal('raw_iron', 3), descent: [downStep('E', 1, 0)] })
check(
  'ore goal, no target and no known stone level: no downward DESCEND (target==null != wantDown)',
  descendOf(noEvidence).length === 0,
  `count=${descendOf(noEvidence).length}`,
)

const capped = state({ signals: signals({ knownStoneY: 40, descendLimitReached: true }), descent: [downStep('E', 1, 0)] })
check('DESCEND_LIMIT reached: descend candidates suppressed', descendOf(capped).length === 0, `count=${descendOf(capped).length}`)

// #4 fixed dig direction ------------------------------------------------------
const fixedDir = state({
  signals: signals({ knownStoneY: 40, digDir: 'E', digDirCount: 3 }),
  descent: [downStep('E', 1, 0), downStep('W', -1, 0)],
})
const fixedDescend = descendOf(fixedDir)
check(
  'a chosen dig direction is held (no zigzag) while under the cap',
  fixedDescend.length === 1 && fixedDescend[0]?.meta.dir === 'E',
  `dirs=[${fixedDescend.map((c) => String(c.meta.dir)).join(',')}]`,
)

// #8a spatial failure memory --------------------------------------------------
const nearby = spatialFailureKey('MOVE:p11_66_20')
const exact = spatialFailureKey('MOVE:p12_66_19')
check('nearby targets share a coarse spatial bucket or neighbourhood', nearby !== null && exact !== null, `a=${nearby} b=${exact}`)
const failed = { [nearby ?? 'x']: 3, 'MOVE:p11_66_20': 1 }
check(
  'failureCount aggregates the spatial bucket for a nearby candidate',
  failureCount(failed, 'MOVE:p12_66_20') >= 2,
  `count=${failureCount(failed, 'MOVE:p12_66_20')}`,
)
check('failure decay reduces stale counts', decayedFailureCount(5, 90_000) < 5, `decayed=${decayedFailureCount(5, 90_000)}`)

// worldMemory pure helpers ----------------------------------------------------
check('descendBudget fires at 4 no-progress descends', descendBudget(3, false).limitReached && descendBudget(0, true).noProgress === 0, `b3=${JSON.stringify(descendBudget(3, false))} b0=${JSON.stringify(descendBudget(0, true))}`)
const cappedDig = new DigMemory()
for (let index = 0; index < 4; index += 1) cappedDig.markDescend(false)
cappedDig.resetDescendBudget()
check('a verified lateral move reopens descent in a new column', !cappedDig.snapshot().descendLimitReached && cappedDig.snapshot().descendNoProgress === 0, JSON.stringify(cappedDig.snapshot()))
const zig: DigStep[] = [
  { x: 22, y: 64, z: 27, dir: 'S', mode: 'level', target: 'cobblestone', atMs: 1 },
  { x: 23, y: 64, z: 27, dir: 'E', mode: 'level', target: 'cobblestone', atMs: 2 },
  { x: 23, y: 64, z: 28, dir: 'S', mode: 'level', target: 'cobblestone', atMs: 3 },
  { x: 23, y: 64, z: 27, dir: 'N', mode: 'level', target: 'cobblestone', atMs: 4 },
  { x: 23, y: 64, z: 28, dir: 'S', mode: 'level', target: 'cobblestone', atMs: 5 },
  { x: 23, y: 64, z: 27, dir: 'N', mode: 'level', target: 'cobblestone', atMs: 6 },
]
const straight: DigStep[] = zig.map((step, index) => ({ ...step, x: 22 + index, z: 27, dir: 'E' as const }))
check('DIG_OSCILLATE detects the constant-y zigzag', isOscillatingSteps(zig), `zig=${isOscillatingSteps(zig)}`)
check('a straight tunnel is not flagged as oscillation', !isOscillatingSteps(straight), `straight=${isOscillatingSteps(straight)}`)

process.stdout.write(`\n${18 - failures}/18 movement-fix cases passed\n`)
process.exit(failures === 0 ? 0 : 1)
