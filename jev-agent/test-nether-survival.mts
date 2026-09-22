// test-nether-survival.mts - M3 Nether-side survival + progression (route/CAN only).
//
// Live evidence this fixture pins (run-muc3qbug-18vg3, source 35dfd29, the body's
// first 18 s in `minecraft:the_nether`, `buddy-driver/logs/jev/run.jsonl`):
//
//   03:28:15.216 LADDER_RESUME rung=blaze_rods            (the rung EXISTS)
//   03:28:16.359 candidates = [RETRIEVE:known:blaze_rod:b35_60_-23, WAIT]
//   03:28:24.147 trigger=damage_taken attackerName=spider  -> preempts the retrieve
//   03:28:24.971 JEV_HEADS action=RETREAT:p16_59_3         (Jev chose a retreat)
//   03:28:25.162 chosen candidate RETREAT:p16_59_3 vanished between the Jev answer and execution
//   03:28:26.354 chosen candidate RETREAT:p17_59_2 vanished ...
//   03:28:27.619 chosen candidate RETREAT:p16_59_3 vanished ...
//   03:28:29.295 chosen candidate RETREAT:p22_60_-11 vanished ...
//   03:28:32.130 chosen candidate RETREAT:p18_60_-11 vanished ...
//   03:28:32.634 DEATH pos=23.5,59.0,-3.7 dimension=minecraft:the_nether
//
// Buddy.log's ACTION counter ran `n=5136` (03:28:16.875) -> `n=5137`
// (03:28:31.301): 14.4 s in which the body executed NOTHING while
// `THREAT_NEARBY threat=spider distance=1.38m contact=true` and a ghast shelled
// it (health 18 -> 7.5). The run contains 630 such drops.
//
// Cases:
//   (a) arrival in the Nether with a hostile nearby -> the survival actions are
//       offered AND a chosen survival action whose volatile id changed is
//       re-grounded instead of leaving the tick with no action at all;
//   (b) a SENSED nether-brick structure -> an approach route is offered (the
//       durable-site RETRIEVE only exists after the host has minted a site);
//   (c) a sensed blaze/enderman within reach with a SUFFICIENT kit -> the fight
//       is offered with its real capability facts (weapon damage, armour, and
//       the reach the mob answers from);
//   (d) a genuinely insufficient kit -> a typed bounded prerequisite naming what
//       is missing, plus the grounded route that would close it (never a silent
//       walk into a fight the body cannot win).
//
// Route/CAN only: `nether_bricks` is never made to yield `blaze_rod`, the ATTACK
// is never removed, and no coordinate or dimension route is hard-coded.
//
// Run: bun test ./test-nether-survival.mts
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createRecipeIndex } from './src/crafting.ts'
import { combatKitGap, defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import { mirroredEventToken } from './src/controller-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import { buildWorldState, defaultSensorOptions } from './src/state.ts'
import {
  bodySurvivalFacts,
  formatDeathCause,
  formatThreatRangedUnanswered,
  regroundVanishedSurvivalChoice,
  unansweredRangedThreats,
  weaponFacts,
} from './src/threat.ts'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { assessCombatKit, CRAFTABLE_SWORDS } from './src/gearPlan.ts'
import type { BlockState, EntityState, GoalState, InventoryState, KnownResource, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

const require = createRequire(import.meta.url)
const RECIPES = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const SELF: Vec3Json = { x: 0.5, y: 61, z: 0.5 }

function selfState(held: string | null, armor: Record<string, { name: string; count: number }> = {}): SelfState {
  return {
    username: 'AI_NETHER',
    position: SELF,
    eyePosition: { x: SELF.x, y: SELF.y + 1.62, z: SELF.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'minecraft:the_nether',
    isDay: true,
    heldItem: held === null ? null : { name: held, count: 1, slot: 36 },
    armor,
  } as unknown as SelfState
}

function goalState(targetItem: string): GoalState {
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
    id: `g3:collect:${targetItem}`,
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

function queue(current: QueuedGoal): GoalQueueState {
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function hostile(id: number, name: string, distance: number): EntityState {
  return {
    id,
    name,
    kind: name,
    username: null,
    position: { x: SELF.x + distance, y: SELF.y, z: SELF.z },
    distance,
    hostile: true,
    lineOfSight: true,
    heldItem: null,
    health: 20,
    attackedSelf: false,
  } as unknown as EntityState
}

/** A sensed Nether-fortress body cell (#342 shape: `nether_bricks`, pickaxe tier 0). */
function fortressBody(position: Vec3Json, distance: number): BlockState {
  return {
    kind: 'ore',
    name: 'nether_bricks',
    position,
    distance,
    diggable: true,
    inReach: false,
    hasAdjacentStandable: true,
    adjacentStandable: { x: position.x, y: position.y - 1, z: position.z },
    yield: 'nether_bricks',
    harvestTool: 'pickaxe',
    harvestTier: 0,
    visible: true,
  } as unknown as BlockState
}

function build(input: {
  target: string
  held: string | null
  entities?: EntityState[]
  blocks?: BlockState[]
  known?: KnownResource[]
  counts?: Record<string, number>
  armor?: Record<string, { name: string; count: number }>
  table?: boolean
}): WorldState {
  const counts: Record<string, number> = { ...(input.counts ?? {}) }
  if (input.held !== null) counts[input.held] = (counts[input.held] ?? 0) + 1
  const inventory: InventoryState = {
    slots: [],
    counts,
    totalItems: Object.values(counts).reduce((sum, count) => sum + count, 0),
  }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: selfState(input.held, input.armor ?? {}),
    inventory,
    entities: input.entities ?? [],
    blocks: input.blocks ?? [],
    // `escapeCells` is the wider threat-escape scan `state.ts` runs while a
    // hostile is inside the danger radius (`buildEscapeCells`). It is the set a
    // real retreat destination comes from; the 5x5x3 `standable` window alone
    // can never hold a genuine escape (see `pickRetreats`).
    terrain: {
      standable: [SELF, { x: 3, y: 61, z: 0 }, { x: 0, y: 61, z: 3 }],
      escapeCells: [
        { x: -6, y: 61, z: 0 },
        { x: -6, y: 61, z: -5 },
        { x: 0, y: 61, z: -6 },
      ],
    },
    craftingTables:
      input.table === true
        ? [{ x: 2, y: 61, z: 0, name: 'crafting_table', source: 'sensed' }]
        : [],
    furnaces: [],
    placementSpots: [],
    goal: goalState(input.target),
    goalQueue: queue(queuedGoal(input.target)),
    recentEvents: [],
    signals: {
      consecutiveFailures: 0,
      lastFailureCode: null,
      lastPathStatus: 'idle',
      stalledMs: 0,
      lastPolicyConfidence: null,
      maxConcurrentActions: 0,
      escalationRecommended: false,
      failedCandidates: {},
      knownResources: input.known ?? [],
    },
  } as unknown as WorldState
}

const OPTIONS = {
  ...defaultCandidateOptions,
  recipes: RECIPES,
  reachability: { memory: null, pathProbe: () => 'reachable' as const },
}

function offered(state: WorldState): Candidate[] {
  const grounded = generateGroundedCandidates(state, OPTIONS)
  return [...grounded.candidates, ...grounded.withheld.map((entry) => entry.candidate)]
}

const ids = (candidates: readonly Candidate[]): string => `[${candidates.map((c) => c.id).join(' ')}]`

// ---------------------------------------------------------------------------
// (a) arrival in the Nether with a hostile nearby
// ---------------------------------------------------------------------------

addCase('(a1) a hostile on arrival keeps grounded survival actions offered (never "stand and die")', () => {
  const state = build({ target: 'blaze_rod', held: 'stone_pickaxe', entities: [hostile(49202, 'spider', 1.4)] })
  const all = offered(state)
  const attack = all.filter((candidate) => candidate.kind === 'ATTACK')
  const retreat = all.filter((candidate) => candidate.kind === 'RETREAT')
  const work = all.filter((candidate) => candidate.kind === 'MINE' || candidate.kind === 'RETRIEVE')
  return {
    pass: attack.length >= 1 && retreat.length >= 1 && work.length === 0,
    detail: `attack=${ids(attack)} retreat=${ids(retreat)} work=${ids(work)} all=${ids(all)}`,
  }
})

addCase('(a2) a RETREAT id that changed with the body is re-grounded to the fresh retreat (not dropped)', () => {
  // The live drop: the chosen `RETREAT:p16_59_3` no longer exists in the fresh
  // offer because a spider bite knocked the body one block and re-anchored the
  // radius-6 escape scan. The result must still be a retreat.
  const chosen = {
    id: 'RETREAT:p16_59_3',
    kind: 'RETREAT',
    targetEntityId: null,
    meta: { threatEntityId: 49202, threatName: 'spider', separationGain: 8.34 },
  }
  const fresh = [
    { id: 'RETREAT:p17_59_2', kind: 'RETREAT', targetEntityId: null, meta: { threatEntityId: 49202, separationGain: 7.41 } },
    { id: 'RETREAT:p18_60_-11', kind: 'RETREAT', targetEntityId: null, meta: { threatEntityId: 49202, separationGain: 5.2 } },
    { id: 'ATTACK:e49202', kind: 'ATTACK', targetEntityId: 49202, meta: { entityId: 49202 } },
    { id: 'WAIT', kind: 'WAIT', targetEntityId: null, meta: {} },
  ]
  const result = regroundVanishedSurvivalChoice(chosen, fresh)
  return {
    pass: result.candidateId === 'RETREAT:p17_59_2' && result.kind === 'RETREAT' && result.reason === 'same_threat_keep_distance',
    detail: `id=${result.candidateId} kind=${result.kind} reason=${result.reason}`,
  }
})

addCase('(a3) re-grounding preserves the generator order and never requires a "safer" replacement', () => {
  // Same threat, only the boundary cells changed: the FIRST fresh retreat in the
  // generator's own farthest-first order is taken, even though its separation
  // gain is lower than the dropped one (re-deciding for a better spot is another
  // way to end the tick with no action).
  const chosen = {
    id: 'RETREAT:p22_60_-11',
    kind: 'RETREAT',
    targetEntityId: null,
    meta: { threatEntityId: 49202 },
  }
  const fresh = [
    { id: 'RETREAT:p20_60_-9', kind: 'RETREAT', targetEntityId: null, meta: { threatEntityId: 49202, separationGain: 1.0 } },
    { id: 'RETREAT:p21_60_-8', kind: 'RETREAT', targetEntityId: null, meta: { threatEntityId: 49202, separationGain: 9.0 } },
  ]
  const result = regroundVanishedSurvivalChoice(chosen, fresh)
  return {
    pass: result.candidateId === 'RETREAT:p20_60_-9',
    detail: `id=${result.candidateId} reason=${result.reason}`,
  }
})

addCase('(a4) an ATTACK keeps its exact target; a vanished entity is not retargeted', () => {
  const chosen = { id: 'ATTACK:e49201', kind: 'ATTACK', targetEntityId: 49201, meta: { entityId: 49201 } }
  const sameTarget = regroundVanishedSurvivalChoice(chosen, [
    { id: 'ATTACK:e99999', kind: 'ATTACK', targetEntityId: 99999, meta: { entityId: 99999 } },
    { id: 'ATTACK:e49201', kind: 'ATTACK', targetEntityId: 49201, meta: { entityId: 49201 } },
  ])
  const gone = regroundVanishedSurvivalChoice(chosen, [
    { id: 'ATTACK:e99999', kind: 'ATTACK', targetEntityId: 99999, meta: { entityId: 99999 } },
  ])
  return {
    pass:
      sameTarget.candidateId === 'ATTACK:e49201' &&
      sameTarget.reason === 'same_target_attack' &&
      gone.candidateId === null &&
      gone.reason === 'no_grounded_equivalent',
    detail: `same=${sameTarget.candidateId}/${sameTarget.reason} gone=${gone.candidateId}/${gone.reason}`,
  }
})

addCase('(a5) a non-survival choice is still a hard guard rejection (no new retarget authority)', () => {
  const chosen = { id: 'RETRIEVE:known:blaze_rod:b35_60_-23', kind: 'RETRIEVE', targetEntityId: null, meta: {} }
  const result = regroundVanishedSurvivalChoice(chosen, [
    { id: 'RETRIEVE:known:blaze_rod:b37_58_-21', kind: 'RETRIEVE', targetEntityId: null, meta: {} },
    { id: 'RETREAT:p18_60_-11', kind: 'RETREAT', targetEntityId: null, meta: {} },
  ])
  return {
    pass: result.candidateId === null && result.kind === null && result.reason === 'not_a_survival_action',
    detail: `id=${result.candidateId} kind=${result.kind} reason=${result.reason}`,
  }
})

addCase('(a6) the revalidation guard re-grounds first, and an un-re-groundable SURVIVAL choice asks again instead of ending the tick idle', () => {
  // Intent unchanged: the guard tries the re-grounding rule before it rejects.
  // Strengthened after a measured live death: the old code ended the tick with
  // NO action when the re-ground failed (`if (reground.candidateId === null) return`)
  // while a wither skeleton was in contact at 0.57 m with health 4.36, even though
  // the fresh offer still held a reachable ATTACK on that same mob. Ending the tick
  // idle is what killed the body, so the ungrounded branch must also queue the fresh
  // offer for the next decision (`damage_taken`) - code still does not choose
  // fight-vs-flight (section 8), it only declines to stand still.
  const text = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
  const guard = text.indexOf('const reground = regroundVanishedSurvivalChoice(')
  const reject = text.indexOf('this.guardRejections += 1', guard)
  // The ungrounded branch must (a) requeue the decision so the tick is never the
  // LAST thing that happens, and (b) when a hostile is in contact and a grounded
  // CONTROL action is on offer, EXECUTE it (issue #436 section 9 / the measured
  // DEATH 32) - a bare rejection or a bare requeue is not enough, and only a
  // missing control action may let the tick end without one.
  const ungrounded = text.indexOf('if (reground.candidateId === null) {', reject)
  const requeue = text.indexOf("this.requestDecision('damage_taken'", ungrounded)
  const tagged = text.indexOf("source: 'survival_reground_failed'", ungrounded)
  const returnsOnlyWhenUngrounded = text.includes('if (reground.candidateId === null && controlId === null) return')
  const hasControlFallback = text.includes('survivalControlFallback({')
  return {
    pass:
      guard > 0 &&
      reject > guard &&
      ungrounded > reject &&
      requeue > ungrounded &&
      tagged > ungrounded &&
      returnsOnlyWhenUngrounded &&
      hasControlFallback,
    detail:
      `regroundCallAt=${guard} guardRejectAt=${reject} ungroundedBlockAt=${ungrounded} ` +
      `requeuesDecisionAt=${requeue} tagged=${tagged > ungrounded} ` +
      `returnsOnlyWhenUngrounded=${returnsOnlyWhenUngrounded} controlFallback=${hasControlFallback}`,
  }
})

addCase('(a7) the threat + survival markers ride the mirrored host event path (buddy.log)', () => {
  // The live buddy.log contained ZERO `THREAT_NEARBY` lines over the whole run
  // while the body was being killed by a spider in melee contact: the markers
  // were written to the generation event stream only. `mirroredEventToken` is
  // what decides which lines the host mirrors.
  const tokens = [
    'THREAT_NEARBY goal=objective:blaze_rod:7 threat=spider distance=1.38m',
    'THREAT_NO_ESCAPE goal=objective:blaze_rod:7 threat=spider inContact=true',
    'THREAT_CLEAR goal=objective:blaze_rod:7 clearMs=8000',
    'SURVIVAL_REGROUND from=RETREAT:p16_59_3 to=RETREAT:p17_59_2 kind=RETREAT',
    'SURVIVAL_NO_GROUNDED_ACTION chosen=RETREAT:p16_59_3 kind=RETREAT',
    'GUARD_REJECTIONS total=2 dropped=1 regrounded=1',
    'COMBAT_KIT_GAP focus=blaze_rod target=blaze missing=[sword,armor]',
    'DEATH_CAUSE dimension=minecraft:the_nether killer=spider',
  ]
  const mirrored = tokens.map((line) => mirroredEventToken(line))
  return {
    pass: mirrored.every((token, index) => token === tokens[index]?.split(' ')[0]),
    detail: `mirrored=[${mirrored.join(' ')}]`,
  }
})

addCase('(a8) the death line names the killer, the contact threat and the surrounding mobs', () => {
  // The exact live death (03:28:32.634Z) had only `cause=damage`: a post-mortem
  // could not tell a spider in melee from a ghast shelling from outside
  // perception. The generation owns the attribution and the danger state, so it
  // records them once, mirrored, before it is disposed.
  const line = formatDeathCause({
    dimension: 'minecraft:the_nether',
    position: { x: 23.5, y: 59, z: -3.7 },
    health: 0.5,
    food: 18,
    hostCause: 'damage',
    lastDamage: { atMs: 1_700_000_000_000 - 320, health: 0.5, sourceId: 49202, sourceName: 'spider' },
    threat: {
      active: true,
      activeMs: 8200,
      threatId: 49202,
      threatName: 'spider',
      threatDistance: 1.38,
      threatHeldItem: null,
      threatEngaged: true,
      threatLineOfSight: false,
      inContact: true,
      inDanger: true,
      hostileCount: 2,
      clearMs: 8000,
      clearForMs: 0,
      entryReason: 'contact',
      exitReason: null,
      enteredAtMs: 1_700_000_000_000 - 8200,
    },
    hostiles: [
      { name: 'spider', distance: 1.38, hostile: true },
      { name: 'ghast', distance: 31.2, hostile: true },
      { name: 'piglin', distance: 14, hostile: false },
    ],
    weapon: weaponFacts('dirt'),
    wornArmorCount: 0,
    damageAgeMs: 320,
  })
  return {
    pass:
      line.startsWith('DEATH_CAUSE ') &&
      line.includes('dimension=minecraft:the_nether') &&
      line.includes('killer=spider') &&
      line.includes('killerId=49202') &&
      line.includes('contact=true') &&
      line.includes('hostiles=[spider:1m,ghast:31m]'),
    detail: line.slice(0, 280),
  }
})

addCase('(a9) an unattributed death says so instead of leaving the cause to be guessed', () => {
  const line = formatDeathCause({
    dimension: 'minecraft:overworld',
    position: { x: 0, y: 64, z: 0 },
    health: 2,
    food: 0,
    hostCause: 'damage',
    lastDamage: null,
    threat: null,
    hostiles: [],
    weapon: weaponFacts(null),
    wornArmorCount: 0,
    damageAgeMs: null,
  })
  return {
    pass: line.includes('killer=unattributed') && line.includes('threat=none') && line.includes('hostiles=[]'),
    detail: line.slice(0, 220),
  }
})

// ---------------------------------------------------------------------------
// (b) a sensed nether-brick structure
// ---------------------------------------------------------------------------

addCase('(b1) a SENSED fortress body grounds an approach route with no durable site', () => {
  const cell: Vec3Json = { x: 8, y: 61, z: 0 }
  const state = build({ target: 'blaze_rod', held: 'stone_pickaxe', blocks: [fortressBody(cell, 8)] })
  const all = offered(state)
  const approach = all.find((candidate) => candidate.id === 'MOVE:b8_61_0')
  return {
    pass:
      approach !== undefined &&
      approach.kind === 'MOVE' &&
      approach.meta.structureApproach === true &&
      approach.meta.resourceKind === 'structure' &&
      approach.target?.x === 8 &&
      approach.target?.z === 0,
    detail: `approach=${approach?.id ?? 'none'} meta=${JSON.stringify(approach?.meta ?? {}).slice(0, 200)} all=${ids(all)}`,
  }
})

addCase('(b2) fortress fabric is still never a SOURCE: no MINE and no yield claim for blaze_rod', () => {
  const cell: Vec3Json = { x: 2, y: 61, z: 0 }
  const state = build({ target: 'blaze_rod', held: 'stone_pickaxe', blocks: [fortressBody(cell, 2)] })
  const all = offered(state)
  const mines = all.filter((candidate) => candidate.kind === 'MINE')
  const fabric = all.filter((candidate) => candidate.targetName === 'nether_bricks')
  const claimsYield = fabric.some(
    (candidate) => candidate.meta.yieldItem === 'blaze_rod' || candidate.itemName === 'blaze_rod',
  )
  return {
    pass: mines.length === 0 && claimsYield === false,
    detail: `mines=${ids(mines)} fabric=${ids(fabric)} claimsYield=${claimsYield} all=${ids(all)}`,
  }
})

addCase('(b3) the approach is a route, not a tool gate: it is offered without a pickaxe of the fabric tier', () => {
  const state = build({ target: 'blaze_rod', held: null, blocks: [fortressBody({ x: 8, y: 61, z: 0 }, 8)] })
  const approach = offered(state).find((candidate) => candidate.meta.structureApproach === true)
  return {
    pass: approach !== undefined && approach.requiresTool === false && approach.toolName === null,
    detail: `approach=${approach?.id ?? 'none'} requiresTool=${approach?.requiresTool} tool=${approach?.toolName ?? 'none'}`,
  }
})

// ---------------------------------------------------------------------------
// (c) a sensed producer with a sufficient kit
// ---------------------------------------------------------------------------

const FULL_IRON = {
  head: { name: 'iron_helmet', count: 1 },
  torso: { name: 'iron_chestplate', count: 1 },
  legs: { name: 'iron_leggings', count: 1 },
  feet: { name: 'iron_boots', count: 1 },
}

addCase('(c1) a sensed blaze with a sword and armour is offered the fight with its real capability facts', () => {
  const state = build({
    target: 'blaze_rod',
    held: 'iron_sword',
    armor: FULL_IRON,
    entities: [hostile(900, 'blaze', 3)],
  })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const fight = grounded.candidates.find((candidate) => candidate.id === 'ATTACK:e900')
  const meta = fight?.meta ?? {}
  return {
    pass:
      fight !== undefined &&
      meta.weapon === 'iron_sword' &&
      meta.weaponDamage === 6 &&
      meta.goalDrop === 'blaze_rod' &&
      meta.requiresKill === true &&
      meta.targetStandoff === 12 &&
      grounded.combatKitGap === null,
    detail: `fight=${fight?.id ?? 'none'} meta=${JSON.stringify(meta).slice(0, 260)} gap=${grounded.combatKitGap === null ? 'none' : 'present'}`,
  }
})

addCase('(c2) a sensed enderman is offered the ender_pearl hunt with the same facts', () => {
  const state = build({
    target: 'ender_pearl',
    held: 'iron_sword',
    armor: FULL_IRON,
    entities: [hostile(901, 'enderman', 4)],
  })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const fight = grounded.candidates.find((candidate) => candidate.id === 'ATTACK:e901')
  const meta = fight?.meta ?? {}
  return {
    pass:
      fight !== undefined &&
      meta.goalDrop === 'ender_pearl' &&
      meta.requiresKill === true &&
      meta.weaponDamage === 6 &&
      grounded.combatKitGap === null,
    detail: `fight=${fight?.id ?? 'none'} meta=${JSON.stringify(meta).slice(0, 220)}`,
  }
})

addCase('(c3) the assessment itself: sword + one armour piece is sufficient, bare fists are not', () => {
  const armed = assessCombatKit({
    heldItem: 'iron_sword',
    worn: { torso: { name: 'iron_chestplate' } },
    health: 20,
    food: 20,
  })
  const bare = assessCombatKit({ heldItem: null, worn: {}, health: 20, food: 20 })
  const pick = assessCombatKit({ heldItem: 'stone_pickaxe', worn: {}, health: 20, food: 20 })
  return {
    pass:
      armed.insufficient === false &&
      armed.swingDamage === 6 &&
      bare.insufficient === true &&
      bare.missing.join(',') === 'sword,armor' &&
      pick.insufficient === true &&
      pick.swingDamage === 1,
    detail: `armed=${JSON.stringify(armed)} bare=${JSON.stringify(bare)} pick=${JSON.stringify(pick)}`,
  }
})

addCase('(c3b) a sword CARRIED in the inventory is a weapon even when the hand holds a block', () => {
  // Measured live (run-mucaq28q-1ftq1): the marker said `held=cobblestone swingDamage=1 ... missing=sword
  // prerequisite=CRAFT:iron_sword` while a diamond_sword sat in the inventory, so System2 was told to craft a
  // weapon the body already had. The attack path equips the best CARRIED weapon before the first swing.
  const carrying = assessCombatKit({
    heldItem: 'cobblestone',
    carried: { cobblestone: 402, diamond_sword: 1, iron_ingot: 2 },
    worn: {},
    health: 20,
    food: 20,
  })
  const trulyBare = assessCombatKit({
    heldItem: 'cobblestone',
    carried: { cobblestone: 402, iron_ingot: 2 },
    worn: {},
    health: 20,
    food: 20,
  })
  return {
    pass:
      carrying.hasWeapon === true &&
      carrying.missing.includes('sword') === false &&
      carrying.swingDamage > 1 &&
      trulyBare.hasWeapon === false &&
      trulyBare.missing.includes('sword') === true,
    detail: `carrying=${JSON.stringify(carrying)} trulyBare=${JSON.stringify(trulyBare)}`,
  }
})

// ---------------------------------------------------------------------------
// (c4/c5) an attacker beyond the response envelope
// ---------------------------------------------------------------------------

addCase('(c4) a ghast that damaged the body from 38m is reported as an unanswered ranged threat', () => {
  const ghast = {
    id: 49201,
    name: 'ghast',
    kind: 'ghast',
    username: null,
    position: { x: SELF.x + 38, y: SELF.y + 6, z: SELF.z },
    distance: 38.5,
    hostile: true,
    lineOfSight: true,
    heldItem: null,
    health: 10,
    attackedSelf: true,
  } as unknown as EntityState
  const bystander = { ...ghast, id: 5, name: 'zombie', distance: 30, attackedSelf: false }
  const unanswered = unansweredRangedThreats([ghast, bystander])
  const line = formatThreatRangedUnanswered({
    goalKey: 'objective:blaze_rod:7',
    threat: unanswered[0] ?? null,
    sourceName: null,
    body: bodySurvivalFacts({ health: 7.5, food: 20 }),
    weapon: weaponFacts('dirt'),
  })
  return {
    pass:
      unanswered.length === 1 &&
      unanswered[0]?.name === 'ghast' &&
      line.startsWith('THREAT_RANGED_UNANSWERED') &&
      line.includes('distance=39m') &&
      line.includes('sensed=true') &&
      line.includes('attackRange=64'),
    detail: `unanswered=${unanswered.length} ${line.slice(0, 220)}`,
  }
})

addCase('(c5) an unsensed attacker is named from damage attribution, and no action is invented', () => {
  // The exact live shape: `attackerId=49201 attackerName=ghast` with the ghast
  // outside every sensor radius. No entity carries the attribution, so the
  // recorded damage source is the only evidence - and the marker must say so.
  const line = formatThreatRangedUnanswered({
    goalKey: 'objective:blaze_rod:7',
    threat: null,
    sourceName: 'ghast',
    body: bodySurvivalFacts({ health: 7.5, food: 20 }),
    weapon: weaponFacts('dirt'),
  })
  return {
    pass:
      line.includes('threat=ghast') &&
      line.includes('distance=unsensed') &&
      line.includes('sensed=false') &&
      line.includes('no grounded attack/keep-distance route'),
    detail: line.slice(0, 240),
  }
})

addCase('(c6) the sensor keeps a hostile visible out to the widened hostile radius only', () => {
  const position = new Vec3(0.5, 10, 0.5)
  const botWith = (entities: Record<number, unknown>): Bot =>
    ({
      username: 'AI_NETHER',
      entity: { id: 1, position, yaw: 0, pitch: 0, onGround: true },
      heldItem: null,
      health: 20,
      food: 20,
      game: { gameMode: 'survival', dimension: 'minecraft:the_nether', minY: 0, height: 256 },
      time: { isDay: false },
      registry: null,
      entities,
      inventory: { items: () => [] },
      blockAt: () => ({ name: 'air', boundingBox: 'empty' }),
      canSeeBlock: () => false,
      findBlocks: () => [],
    }) as never
  const farGhast = {
    id: 49201,
    name: 'ghast',
    kind: 'ghast',
    position: new Vec3(40.5, 12, 0.5),
    isValid: true,
    heldItem: null,
  }
  const farPig = { id: 7, name: 'pig', kind: 'animal', position: new Vec3(40.5, 10, 0.5), isValid: true, heldItem: null }
  const input = { tick: 4, goal: goalState('blaze_rod'), goalQueue: queue(queuedGoal('blaze_rod')), recentEvents: [], signals: { knownResources: [] } as unknown as WorldState['signals'] }
  const sensed = buildWorldState(botWith({ 49201: farGhast, 7: farPig }), input, defaultSensorOptions)
  const names = sensed.entities.map((entity) => entity.name)
  return {
    pass: names.includes('ghast') && !names.includes('pig'),
    detail: `sensed=${names.join(',')} entityRadius=${defaultSensorOptions.entityRadius} hostileRadius=${defaultSensorOptions.hostileRadius}`,
  }
})

// ---------------------------------------------------------------------------
// (d) a genuinely insufficient kit
// ---------------------------------------------------------------------------

addCase('(d1) an unwinnable required kill is typed, naming exactly what is missing', () => {
  const state = build({ target: 'blaze_rod', held: null, entities: [hostile(900, 'blaze', 3)] })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const gap = grounded.combatKitGap
  return {
    pass:
      gap !== null &&
      gap.focus === 'blaze_rod' &&
      gap.target === 'blaze' &&
      gap.assessment.missing.join(',') === 'sword,armor' &&
      gap.assessment.swingDamage === 1 &&
      gap.prerequisite === null,
    detail: `gap=${gap === null ? 'none' : JSON.stringify(gap)}`,
  }
})

addCase('(d2) the prerequisite is grounded when the live inventory can make a sword', () => {
  const state = build({
    target: 'blaze_rod',
    held: null,
    entities: [hostile(900, 'blaze', 3)],
    counts: { cobblestone: 2, stick: 1 },
    table: true,
  })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const craft = grounded.candidates.find((candidate) => candidate.meta.combatKit === 'sword')
  const gap = grounded.combatKitGap
  return {
    pass:
      craft !== undefined &&
      craft.kind === 'CRAFT' &&
      craft.meta.combatWeapon === 'stone_sword' &&
      craft.meta.combatTarget === 'blaze' &&
      gap !== null &&
      gap.prerequisite === craft.id,
    detail: `craft=${craft?.id ?? 'none'} weapon=${String(craft?.meta.combatWeapon ?? 'none')} gapPrereq=${gap?.prerequisite ?? 'none'}`,
  }
})

addCase('(d3) the ATTACK is never removed by the gap: Jev still owns whether to fight', () => {
  const state = build({ target: 'blaze_rod', held: null, entities: [hostile(900, 'blaze', 3)] })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const fight = grounded.candidates.find((candidate) => candidate.id === 'ATTACK:e900')
  const offeredSword = CRAFTABLE_SWORDS.filter((sword) => sword.length > 0).length
  return {
    pass: fight !== undefined && fight.meta.weaponDamage === 1 && offeredSword === CRAFTABLE_SWORDS.length,
    detail: `fight=${fight?.id ?? 'none'} weaponDamage=${String(fight?.meta.weaponDamage ?? 'none')} swordFamilies=${offeredSword}`,
  }
})

addCase('(d4) the gap is not claimed when no producer is sensed (it is not a wandering refusal)', () => {
  const state = build({ target: 'blaze_rod', held: null })
  const grounded = generateGroundedCandidates(state, OPTIONS)
  const direct = combatKitGap(state, grounded.candidates)
  return {
    pass: grounded.combatKitGap === null && direct === null,
    detail: `gap=${grounded.combatKitGap === null ? 'none' : 'present'} direct=${direct === null ? 'none' : 'present'}`,
  }
})

let failures = 0
process.stdout.write('M3 Nether arrival survival + blaze/pearl progression (route/CAN only)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} nether-survival cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
