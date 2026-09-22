// test-env-hazard.mts - SAFE: the body's own environmental hazard (fire / lava /
// burning / drowning) is OBSERVED and AVOIDABLE.
//
// Measured live (`m3-live`, `run-mucaq28q-1ftq1`, main 99f0020,
// `buddy-driver/logs/jev/run.jsonl`, mirror `buddy.log`):
//
//   06:42:46 HEARTBEAT pos=24.7,60.2,-2.8 health=3.58 rung=blaze_rods action=RETRIEVE
//   06:42:11 CRITICAL_DAMAGE health=4.578 food=19 source=environment damage=1/3
//   06:42:14 CRITICAL_DAMAGE health=3.578 food=17 source=environment damage=2/3
//   06:43:06 DEATH pos=34.9,30.7,-19.4 dimension=the_nether cause=lava
//   06:43:06 DEATH_CAUSE dimension=the_nether killer=null killerId=null threat=null
//   marker scan of the whole run: FIRE 0 | LAVA 0 | HAZARD_FIRE 0 | IN_FIRE 0 | BURN 0
//
// Fire, lava and burning have no attacking entity, so every tick of it arrived as
// an unattributed `source=null` and the entity-keyed `THREAT_*` machinery could
// never name it. Nothing read the block the body stood in, so the body could not
// know it was in a hazard, could not prefer a safer cell and could not attribute
// the damage.
//
// Cases (issue #436 section B shape: a uniquely-determined safety action may run
// as a bounded reflex; SEVERAL ways out stay Jev's WHICH):
//   (a) the measured shape: body in fire in a 3x3 stone pocket -> the hazard is
//       typed and an exit candidate is offered (Jev chooses among several);
//   (a2) the SAME hazard with exactly ONE grounded exit -> the unique escape is a
//       reflex (with the `REFLEX` evidence shape), never a fixed direction;
//   (b) fire with lava on every side -> typed refusal (`ENV_HAZARD_NO_EXIT`,
//       bounded, no suicide: no candidate into the hazard) and the unattributed
//       damage is attributed to the hazard (lava);
//   (c) a body in NO hazard -> byte-identical offer, no cells, no markers, no
//       false positives;
//   (d) a body burning beside water -> the water destination is preferred;
//   (e) `DEATH_CAUSE` gains killer=fire/lava/drowning only when the environmental
//       evidence is real (a Mineflayer attribution always wins);
//   (f) the drowning geometry (water at the head, verified air above) is carried
//       by the same state, and the `drowning` damage attribution is typed.
//
// Run: bun ./test-env-hazard.mts
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { createRecipeIndex } from './src/crafting.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import {
  blockId,
  defaultCandidateOptions,
  envHazardEscapeCandidates,
  envHazardEscapeRoutes,
  envHazardEscapeSpots,
  envHazardReflexAction,
  generateCandidates,
  restrictCandidatesDuringEnvHazard,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { buildWorldState, defaultSensorOptions } from './src/state.ts'
import type { AgentSignals, GoalState, SelfState, Vec3Json, WorldState } from './src/state.ts'
import {
  buildEnvHazardState,
  ENV_HAZARD,
  ENV_HAZARD_CLEAR,
  ENV_HAZARD_NO_EXIT,
  EnvHazardTracker,
  envHazardDamageSource,
  formatEnvHazard,
  formatEnvHazardClear,
  formatEnvHazardNoExit,
  formatEnvHazardReflexEvidence,
  selectEnvHazardEscapes,
} from './src/envHazard.ts'
import type { EnvHazardCell, EnvHazardState } from './src/envHazard.ts'
import { bodySurvivalFacts, formatDeathCause, weaponFacts } from './src/threat.ts'
import { formatReflex, formatSkillInterrupt, formatSkillPolicyBoundary, formatSkillStep, formatSkillStepAuthority, REFLEX, SKILL_INTERRUPT, SKILL_POLICY_BOUNDARY, SKILL_STEP } from './src/netherPortalPlan.ts'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const RECIPES = createRecipeIndex(require('minecraft-data')('1.21.11') as unknown)
const OPTIONS: CandidateOptions = { ...defaultCandidateOptions, recipes: RECIPES }

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const NOW = 1_700_000_000_000
const FEET: Vec3Json = { x: 10, y: 60, z: 5 }

type BlockSpec = { name: string; boundingBox: string; diggable?: boolean }

/**
 * A real sensor double: a block map the body's own column, the adjacent ring and
 * Mineflayer's metadata flags/breath are read from. No behaviour is stubbed - the
 * test drives the real `buildWorldState` -> `envHazard` -> candidate pipeline.
 */
function envBot(input: {
  blocks: Map<string, BlockSpec>
  metadata?: unknown
  oxygenLevel?: number
  feet?: Vec3Json
}): Bot {
  const feet = input.feet ?? FEET
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const air: BlockSpec = { name: 'air', boundingBox: 'empty' }
  const blockAt = (p: { x: number; y: number; z: number }): BlockSpec =>
    input.blocks.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? air
  const findBlocks = (options: { matching: (block: BlockSpec) => boolean; maxDistance: number; count: number }): Vec3[] => {
    const origin = new Vec3(feet.x, feet.y, feet.z)
    return [...input.blocks.entries()]
      .filter(([, block]) => options.matching(block))
      .map(([cell]) => {
        const [x, y, z] = cell.split(',').map(Number)
        return new Vec3(x as number, y as number, z as number)
      })
      .filter((cell) => cell.distanceTo(origin) <= options.maxDistance)
      .slice(0, options.count)
  }
  return {
    username: 'AI_ENVHAZ',
    entity: {
      id: 1,
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      metadata: input.metadata,
    },
    heldItem: null,
    health: 12,
    food: 18,
    oxygenLevel: input.oxygenLevel ?? 300,
    game: { gameMode: 'survival', dimension: 'minecraft:the_nether', minY: 0, height: 256 },
    time: { isDay: false },
    registry: null,
    entities: {},
    inventory: { items: () => [{ name: 'cobblestone', count: 8, slot: 0 }] },
    blockAt,
    canSeeBlock: () => false,
    findBlocks,
  } as never
}

function goalState(): GoalState {
  return {
    id: 'collect:blaze_rod',
    description: 'collect 1 x blaze_rod',
    targetItem: 'blaze_rod',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queued(): QueuedGoal {
  return {
    id: 'g3:collect:blaze_rod',
    kind: 'collect',
    description: 'collect 1 x blaze_rod',
    targetItem: 'blaze_rod',
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

function queue(): GoalQueueState {
  const current = queued()
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

function perceive(bot: Bot, tick = 5): WorldState {
  return buildWorldState(
    bot,
    {
      tick,
      goal: goalState(),
      goalQueue: queue(),
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
        knownResources: [],
      } as AgentSignals,
    },
    defaultSensorOptions,
  )
}

const AIR: BlockSpec = { name: 'air', boundingBox: 'empty' }
const STONE: BlockSpec = { name: 'stone', boundingBox: 'block', diggable: true }
const FIRE: BlockSpec = { name: 'fire', boundingBox: 'empty' }
const LAVA: BlockSpec = { name: 'lava', boundingBox: 'empty' }
const WATER: BlockSpec = { name: 'water', boundingBox: 'empty' }

function floor(map: Map<string, BlockSpec>, radius: number, y = FEET.y - 1): void {
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dz = -radius; dz <= radius; dz += 1) {
      map.set(`${FEET.x + dx},${y},${FEET.z + dz}`, STONE)
    }
  }
}

function key(x: number, y: number, z: number): string {
  return `${x},${y},${z}`
}

/** The body's own column plus a 3x3 pocket of air at feet/head level. */
function pocket(): Map<string, BlockSpec> {
  const map = new Map<string, BlockSpec>()
  floor(map, 1)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      map.set(key(FEET.x + dx, FEET.y, FEET.z + dz), AIR)
      map.set(key(FEET.x + dx, FEET.y + 1, FEET.z + dz), AIR)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// (a) the measured shape: fire in a 3x3 pocket -> hazard typed, exit offered
// ---------------------------------------------------------------------------
{
  const map = pocket()
  map.set(key(FEET.x, FEET.y, FEET.z), FIRE)
  const state = perceive(envBot({ blocks: map }))
  const hazard = state.self.envHazard
  const typed =
    hazard?.active === true &&
    hazard.inFire === true &&
    hazard.inLava === false &&
    hazard.kinds.join('+') === 'fire' &&
    hazard.block === 'fire' &&
    hazard.cell?.x === FEET.x &&
    hazard.cell?.y === FEET.y &&
    hazard.cell?.z === FEET.z &&
    hazard.escapeRequired === true
  check(
    '(a) a body standing in fire is typed from real block truth (kind=fire, own cell)',
    typed,
    `hazard=${JSON.stringify(hazard)}`,
  )
  const cells = state.envHazardCells ?? []
  const exits = envHazardEscapeSpots(state)
  const candidates = envHazardEscapeCandidates(state)
  check(
    '(a) the hazard cell sample is carried and grounded exits are offered',
    cells.length === 24 &&
      exits.length > 0 &&
      candidates.length === exits.length &&
      candidates.every((candidate) => candidate.kind === 'MOVE' && candidate.meta.envHazardEscape === 'fire'),
    `cells=${cells.length} exits=${exits.map((escape) => `${escape.spot.x},${escape.spot.y},${escape.spot.z}`).join(' ')} ids=${candidates.map((candidate) => candidate.id).join(' ')}`,
  )
  check(
    '(a) no escape is offered INTO the fire cell or any hazard cell',
    candidates.every(
      (candidate) =>
        candidate.target !== null &&
        cells.some((cell) => cell.position.x === candidate.target?.x && cell.position.y === candidate.target?.y && cell.position.z === candidate.target?.z && cell.hazard === null),
    ),
    `targets=${candidates.map((candidate) => JSON.stringify(candidate.target)).join(' ')}`,
  )
  // Several grounded ways out: the body must still CHOOSE (issue #436: "two
  // different safe directions" is Jev's WHICH, not a reflex).
  const reflex = envHazardReflexAction(state, candidates)
  check(
    '(a) several safe directions are Jev\'s choice: no reflex is taken',
    exits.length >= 2 && reflex === null,
    `exits=${exits.length} reflex=${reflex?.candidate.id ?? 'none'}`,
  )
  // The marker is typed and names the cell.
  const tracker = new EnvHazardTracker()
  const evidence = tracker.note({ atMs: NOW, hazard: state.self.envHazard ?? null, damageObserved: true })
  const line = formatEnvHazard('objective:blaze_rod:7', evidence, exits)
  check(
    '(a) the ENV_HAZARD marker names the hazard, its cell and the exits',
    line.startsWith(ENV_HAZARD) &&
      line.includes('kind=fire') &&
      line.includes(`cell=${FEET.x},${FEET.y},${FEET.z}`) &&
      line.includes('block=fire') &&
      line.includes('damage=1') &&
      line.includes(`exits=${exits.length}`),
    `"${line}"`,
  )
  // A synthetic offer with the two failure modes the restriction must handle:
  // a route INTO the fire cell is never an escape, and work/stall kinds are
  // dropped while a grounded exit exists.
  const set: Candidate[] = [
    candidates[0] as Candidate,
    { id: 'RETRIEVE:known:blaze_rod:b39_59_-20', kind: 'RETRIEVE', target: { x: 39, y: 59, z: -20 }, meta: {} },
    { id: 'MOVE:env:fire:p10_60_5', kind: 'MOVE', target: { x: FEET.x, y: FEET.y, z: FEET.z }, meta: { envHazardEscape: 'fire' } },
    { id: 'PLACE:furnace:p9_60_5', kind: 'PLACE', target: { x: 9, y: 60, z: 5 }, meta: {} },
    { id: 'WAIT', kind: 'WAIT', target: null, meta: {} },
  ] as unknown as Candidate[]
  const restricted = restrictCandidatesDuringEnvHazard(
    { self: state.self, envHazardCells: state.envHazardCells },
    set,
  )
  const keptIds = restricted.map((candidate) => candidate.id)
  check(
    '(a) a route INTO the hazard cell is never an escape, and work/stall is dropped while an exit exists',
    !keptIds.includes('MOVE:env:fire:p10_60_5') &&
      !keptIds.includes('RETRIEVE:known:blaze_rod:b39_59_-20') &&
      !keptIds.includes('PLACE:furnace:p9_60_5') &&
      !keptIds.includes('WAIT') &&
      keptIds.length === 1 &&
      keptIds[0] === candidates[0]?.id,
    `kept=[${keptIds.join(' ')}]`,
  )
  // The whole grounded pipeline keeps the escapes on offer and drops the work.
  const grounded = generateCandidates(state, OPTIONS)
  const offered = grounded.map((candidate) => candidate.id)
  check(
    '(a) the generated offer contains the grounded exits',
    candidates.every((candidate) => offered.includes(candidate.id)) && offered.length > 0,
    `offered=[${offered.join(' ')}]`,
  )
}

// ---------------------------------------------------------------------------
// (a2) exactly ONE grounded exit -> the unique escape is a bounded reflex
// ---------------------------------------------------------------------------
{
  // A one-cell slot: only the +x neighbour is standable, everything else is
  // stone in the body's own column (no fixed direction: the exit is whatever the
  // world leaves open).
  const map = pocket()
  map.set(key(FEET.x, FEET.y, FEET.z), FIRE)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue
      const solid = !(dx === 1 && dz === 0)
      map.set(key(FEET.x + dx, FEET.y, FEET.z + dz), solid ? STONE : AIR)
      map.set(key(FEET.x + dx, FEET.y + 1, FEET.z + dz), solid ? STONE : AIR)
    }
  }
  const state = perceive(envBot({ blocks: map }))
  const exits = envHazardEscapeSpots(state)
  const candidates = envHazardEscapeCandidates(state)
  const reflex = envHazardReflexAction(state, candidates)
  check(
    '(a2) exactly one grounded exit: the escape is uniquely determined',
    exits.length === 1 &&
      exits[0]?.spot.x === FEET.x + 1 &&
      exits[0]?.spot.z === FEET.z &&
      candidates.length === 1 &&
      reflex !== null &&
      reflex.candidate.id === candidates[0]?.id,
    `exits=${JSON.stringify(exits)} reflex=${reflex?.candidate.id ?? 'none'}`,
  )
  // A "dig down" alternative is a second, semantically meaningful way out: the
  // choice returns to Jev.
  const descend = {
    ...(candidates[0] as Candidate),
    id: 'DESCEND:down:E:b11_59_5',
    kind: 'DESCEND' as const,
    target: { x: FEET.x + 1, y: FEET.y - 1, z: FEET.z },
  }
  const withDescend = envHazardReflexAction(state, [...candidates, descend])
  check(
    '(a2) "dig down vs walk out" is several ways out: no reflex, Jev chooses',
    envHazardEscapeRoutes(state, [...candidates, descend]).length === 2 && withDescend === null,
    `routes=${envHazardEscapeRoutes(state, [...candidates, descend]).map((candidate) => candidate.id).join(' ')}`,
  )
  // The reflex evidence names the block and flag that proved it.
  const tracker = new EnvHazardTracker()
  const evidence = tracker.note({ atMs: NOW, hazard: state.self.envHazard ?? null, damageObserved: true })
  const reflexEvidence = formatEnvHazardReflexEvidence(evidence)
  check(
    '(a2) the reflex evidence is the block/flag that proved the hazard',
    reflexEvidence.includes('kind=fire') &&
      reflexEvidence.includes(`block=fire@${FEET.x},${FEET.y},${FEET.z}`) &&
      reflexEvidence.includes('onFire=') &&
      reflexEvidence.includes('damage=1'),
    `"${reflexEvidence}"`,
  )
  // The reflex line uses the SHARED #436 vocabulary (`netherPortalPlan.ts`), so
  // the portal's section-A reflex and this section-B hazard reflex cannot drift
  // into two marker shapes, and the interrupt names the interrupted skill.
  const reflexLine = formatReflex({
    ownerSkill: 'MOVE:known:blaze_rod:b39_59_-20',
    reason: 'hard_safety',
    action: reflex?.candidate.id ?? 'none',
    evidence: reflexEvidence,
  })
  const interruptLine = formatSkillInterrupt('MOVE:known:blaze_rod:b39_59_-20', 'fire')
  const portalLine = formatReflex({ ownerSkill: 'ENTER_PORTAL(portalSite)', action: 'walk_into_portal_interior', evidence: 'enter=1,2,3' })
  check(
    '(a2) the reflex and interrupt lines use the one #436 vocabulary',
    reflexLine.startsWith(REFLEX) &&
      reflexLine.includes('reason=hard_safety') &&
      reflexLine.includes('ownerSkill=') &&
      reflexLine.includes('action=MOVE:env:fire:') &&
      reflexLine.includes('evidence=') &&
      interruptLine.startsWith(SKILL_INTERRUPT) &&
      interruptLine.includes('reason=fire') &&
      // section A keeps its own reason by default: one formatter, two reasons
      portalLine.includes('reason=unique_binding_prerequisite'),
    `"${reflexLine}" / "${interruptLine}"`,
  )
  // A hostile on the body owns the response: no environmental reflex then.
  const threatened: WorldState = {
    ...state,
    entities: [
      {
        id: 42,
        name: 'magma_cube',
        kind: 'hostile',
        username: null,
        position: { x: FEET.x + 1.5, y: FEET.y, z: FEET.z + 0.5 },
        distance: 1.5,
        hostile: true,
        lineOfSight: true,
        heldItem: null,
        attackedSelf: true,
      },
    ],
  }
  check(
    '(a2) a hostile in contact keeps the decision with the threat envelope',
    envHazardReflexAction(threatened, candidates) === null,
    `reflex=${envHazardReflexAction(threatened, candidates)?.candidate.id ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (b) IN lava with lava on every side -> typed refusal, no suicide, damage named
// ---------------------------------------------------------------------------
{
  const map = pocket()
  map.set(key(FEET.x, FEET.y, FEET.z), LAVA)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue
      map.set(key(FEET.x + dx, FEET.y, FEET.z + dz), LAVA)
      map.set(key(FEET.x + dx, FEET.y + 1, FEET.z + dz), AIR)
      map.set(key(FEET.x + dx, FEET.y - 1, FEET.z + dz), LAVA)
    }
  }
  const state = perceive(envBot({ blocks: map }))
  const exits = envHazardEscapeSpots(state)
  const candidates = envHazardEscapeCandidates(state)
  const reflex = envHazardReflexAction(state, candidates)
  check(
    '(b) lava on every side grounds NO exit and NO reflex (no suicide)',
    state.self.envHazard?.inLava === true &&
      state.self.envHazard.kinds.join('+') === 'lava' &&
      exits.length === 0 &&
      candidates.length === 0 &&
      reflex === null,
    `kinds=${state.self.envHazard?.kinds.join('+')} exits=${exits.length} candidates=${candidates.length} reflex=${reflex?.candidate.id ?? 'none'}`,
  )
  const tracker = new EnvHazardTracker()
  const evidence = tracker.note({ atMs: NOW, hazard: state.self.envHazard ?? null, damageObserved: true })
  const gap = formatEnvHazardNoExit('objective:blaze_rod:7', evidence, state.envHazardCells?.length ?? 0)
  check(
    '(b) the refusal is typed and bounded',
    gap.startsWith(ENV_HAZARD_NO_EXIT) &&
      gap.includes('reason=no_safe_adjacent_cell') &&
      gap.includes('sampled=24') &&
      gap.includes('damage=1'),
    `"${gap}"`,
  )
  // The unknown affordance must stay observable: the offer is preserved, never
  // silently erased, and nothing is added that walks into the lava.
  // With NO grounded exit at all the original offer is preserved, so the missing
  // affordance stays observable instead of the set being silently erased.
  const noExitSet: Candidate[] = [
    { id: 'RETRIEVE:known:blaze_rod:b39_59_-20', kind: 'RETRIEVE', target: { x: 39, y: 59, z: -20 }, meta: {} },
    { id: 'WAIT', kind: 'WAIT', target: null, meta: {} },
  ] as unknown as Candidate[]
  const preserved = restrictCandidatesDuringEnvHazard(
    { self: state.self, envHazardCells: state.envHazardCells },
    noExitSet,
  )
  check(
    '(b) with no grounded exit the offer is preserved so the missing affordance stays observable',
    preserved.length === noExitSet.length &&
      preserved.every((candidate, index) => candidate.id === noExitSet[index]?.id),
    `kept=[${preserved.map((candidate) => candidate.id).join(' ')}]`,
  )
  // The unattributed damage is attributed to the hazard with evidence.
  const attribution = envHazardDamageSource(evidence.kinds)
  check(
    '(b) unattributed damage while in lava is attributed to lava, never to a mob',
    attribution === 'lava' && evidence.kinds.join('+') === 'lava',
    `kinds=${evidence.kinds.join('+')} attribution=${String(attribution)}`,
  )
  // A body on fire with lava all around still reports BOTH facts (the fire it is
  // in and the lava it must not step into), and attributes the damage to the fire
  // that is actually under it.
  const mixed = pocket()
  mixed.set(key(FEET.x, FEET.y, FEET.z), FIRE)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue
      mixed.set(key(FEET.x + dx, FEET.y, FEET.z + dz), LAVA)
    }
  }
  const mixedState = perceive(envBot({ blocks: mixed }))
  check(
    '(b) fire under the body + lava around it carries both facts and names the fire',
    mixedState.self.envHazard?.kinds.join('+') === 'fire+adjacent_lava' &&
      mixedState.self.envHazard.adjacentLava === true &&
      envHazardDamageSource(mixedState.self.envHazard.kinds) === 'fire' &&
      envHazardEscapeSpots(mixedState).length === 0,
    `kinds=${mixedState.self.envHazard?.kinds.join('+')} exits=${envHazardEscapeSpots(mixedState).length}`,
  )
  // Adjacency alone must never attribute damage: standing next to lava hurts
  // nobody.
  check(
    '(b) adjacent_lava alone attributes nothing',
    envHazardDamageSource(['adjacent_lava']) === null && envHazardDamageSource(['fire']) === 'fire',
    `adjacent=${String(envHazardDamageSource(['adjacent_lava']))} fire=${String(envHazardDamageSource(['fire']))}`,
  )
}

// ---------------------------------------------------------------------------
// (c) no hazard -> byte-identical behaviour, no cells, no markers
// ---------------------------------------------------------------------------
{
  const plain = perceive(envBot({ blocks: pocket() }))
  check(
    '(c) a body in no hazard carries an inactive hazard state and no cells',
    plain.self.envHazard?.active === false &&
      plain.self.envHazard?.kinds.length === 0 &&
      plain.envHazardCells === undefined,
    `hazard=${JSON.stringify(plain.self.envHazard)} cells=${plain.envHazardCells === undefined ? 'absent' : String(plain.envHazardCells.length)}`,
  )
  const withoutFact: WorldState = { ...plain, self: { ...plain.self, envHazard: undefined } }
  const base = generateCandidates(plain, OPTIONS).map((candidate) => candidate.id)
  const legacy = generateCandidates(withoutFact, OPTIONS).map((candidate) => candidate.id)
  check(
    '(c) the offer is byte-identical to a state that never carried the fact',
    base.length === legacy.length && base.every((id, index) => id === legacy[index]) && !base.some((id) => id.startsWith('MOVE:env:')),
    `generated=${base.length} legacy=${legacy.length} envCandidates=${base.filter((id) => id.startsWith('MOVE:env:')).length}`,
  )
  const set: Candidate[] = [
    { id: 'MINE:b11_60_5', kind: 'MINE', target: { x: 11, y: 60, z: 5 }, meta: {} },
    { id: 'WAIT', kind: 'WAIT', target: null, meta: {} },
  ] as unknown as Candidate[]
  const unchanged = restrictCandidatesDuringEnvHazard(plain, set)
  check(
    '(c) the hazard restriction is a no-op and no reflex fires',
    unchanged.length === set.length &&
      unchanged.every((candidate, index) => candidate.id === set[index]?.id) &&
      envHazardReflexAction(plain, set) === null &&
      envHazardEscapeSpots(plain).length === 0,
    `kept=[${unchanged.map((candidate) => candidate.id).join(' ')}]`,
  )
  const tracker = new EnvHazardTracker()
  const evidence = tracker.note({ atMs: NOW, hazard: plain.self.envHazard ?? null })
  check(
    '(c) an inactive hazard emits no state marker and no clearance line',
    evidence.active === false && tracker.takeCleared() === null && tracker.evidence().damage === 0,
    `active=${evidence.active} cleared=${String(tracker.takeCleared())}`,
  )
}

// ---------------------------------------------------------------------------
// (d) burning beside water -> the water is preferred
// ---------------------------------------------------------------------------
{
  const map = pocket()
  map.set(key(FEET.x + 1, FEET.y, FEET.z), WATER)
  // Mineflayer's own on-fire flag: shared_flags bit 0x01.
  const state = perceive(envBot({ blocks: map, metadata: [0x01] }))
  const hazard = state.self.envHazard
  const exits = envHazardEscapeSpots(state)
  const candidates = envHazardEscapeCandidates(state)
  const water = candidates.find((candidate) => candidate.meta.envHazardWater === true)
  check(
    '(d) a burning body beside water offers the water as the ONLY exit, and reflexes it',
    hazard?.onFire === true &&
      hazard.inFire === false &&
      hazard.kinds.join('+') === 'burning' &&
      exits.length === 1 &&
      exits[0]?.water === true &&
      water !== undefined &&
      candidates.length === 1 &&
      candidates[0]?.id === water.id &&
      water.target?.x === FEET.x + 1 &&
      // the water step is the unique grounded stabilisation, so it is a reflex
      envHazardReflexAction(state, candidates)?.candidate.id === water.id,
    `kinds=${hazard?.kinds.join('+')} exits=${exits.map((escape) => `${escape.water ? 'water' : 'dry'}@${escape.spot.x},${escape.spot.y},${escape.spot.z}`).join(' ')} first=${candidates[0]?.id ?? 'none'}`,
  )
  // The same burning body with NO reachable water: no exit is invented, the work
  // offer is NOT collapsed (walking around while on fire stabilises nothing), and
  // the marker still names the burning so the damage attribution stays honest.
  const dry = perceive(envBot({ blocks: pocket(), metadata: [0x01] }))
  const drySet: Candidate[] = [
    { id: 'MINE:b11_60_5', kind: 'MINE', target: { x: 11, y: 60, z: 5 }, meta: {} },
    { id: 'WAIT', kind: 'WAIT', target: null, meta: {} },
  ] as unknown as Candidate[]
  const dryKept = restrictCandidatesDuringEnvHazard(dry, drySet)
  const dryTracker = new EnvHazardTracker()
  const dryEvidence = dryTracker.note({ atMs: NOW, hazard: dry.self.envHazard ?? null })
  const dryGap = formatEnvHazardNoExit('objective:blaze_rod:7', dryEvidence, dry.envHazardCells?.length ?? 0)
  check(
    '(d) burning with no reachable water invents no exit and says so with the typed reason',
    envHazardEscapeCandidates(dry).length === 0 &&
      envHazardReflexAction(dry, drySet) === null &&
      dryKept.length === drySet.length &&
      envHazardDamageSource(dry.self.envHazard?.kinds ?? []) === 'fire' &&
      dryGap.includes('reason=no_reachable_water'),
    `escapes=${envHazardEscapeCandidates(dry).length} kept=${dryKept.length} gap="${dryGap.slice(0, 150)}"`,
  )
  const tracker = new EnvHazardTracker()
  const evidence = tracker.note({ atMs: NOW, hazard: hazard ?? null })
  const line = formatEnvHazard('objective:blaze_rod:7', evidence, exits)
  check(
    '(d) the marker names the water exit',
    line.includes('kind=burning') && line.includes('onFire=true') && line.includes('waterExit=true'),
    `"${line}"`,
  )
  // The tracker reports the hazard ending exactly once.
  const clearedSample = tracker.note({ atMs: NOW + 500, hazard: null })
  const cleared = tracker.takeCleared()
  const clearLine = cleared === null ? '' : formatEnvHazardClear(cleared)
  check(
    '(d) leaving the hazard emits ENV_HAZARD_CLEAR once',
    clearedSample.active === false &&
      cleared !== null &&
      clearLine.startsWith(ENV_HAZARD_CLEAR) &&
      clearLine.includes('lastKind=burning') &&
      tracker.takeCleared() === null,
    `"${clearLine}"`,
  )
}

// ---------------------------------------------------------------------------
// (e) DEATH_CAUSE gains killer=fire/lava/drowning only with real evidence
// ---------------------------------------------------------------------------
{
  const base = {
    dimension: 'minecraft:the_nether',
    position: { x: 34, y: 30, z: -19 },
    health: 0,
    food: 17,
    hostCause: null,
    threat: null,
    hostiles: [],
    weapon: weaponFacts('cobblestone'),
    wornArmorCount: 0,
    damageAgeMs: 112,
  }
  const unattributed = formatDeathCause({ ...base, lastDamage: null, envHazard: null })
  const fire = formatDeathCause({
    ...base,
    lastDamage: null,
    envHazard: envHazardDamageSource(['fire']),
  })
  const lava = formatDeathCause({
    ...base,
    lastDamage: null,
    envHazard: envHazardDamageSource(['lava']),
  })
  const drowning = formatDeathCause({
    ...base,
    lastDamage: null,
    envHazard: envHazardDamageSource(['drowning']),
  })
  const attributed = formatDeathCause({
    ...base,
    lastDamage: { atMs: NOW - 112, health: 0, sourceId: 6313, sourceName: 'magma_cube' },
    envHazard: envHazardDamageSource(['lava']),
  })
  check(
    '(e) DEATH_CAUSE names fire/lava/drowning with evidence, and stays unattributed with none',
    unattributed.includes('killer=unattributed') &&
      unattributed.includes('killerEvidence=none') &&
      fire.includes('killer=fire') &&
      fire.includes('killerEvidence=environment') &&
      lava.includes('killer=lava') &&
      drowning.includes('killer=drowning'),
    `none="${unattributed.slice(0, 120)}" fire="${fire.slice(0, 120)}"`,
  )
  check(
    '(e) a real Mineflayer attribution always wins over the environmental one',
    attributed.includes('killer=magma_cube') &&
      attributed.includes('killerEvidence=mineflayer') &&
      attributed.includes('killerId=6313'),
    `"${attributed.slice(0, 140)}"`,
  )
  // The host's `DEATH ... cause=` line is separate; this only asserts the
  // generation half.
  check(
    "(e) the body's own hazard facts still name the damage-dealing cause only",
    envHazardDamageSource([]) === null && envHazardDamageSource(['adjacent_lava']) === null,
    `empty=${String(envHazardDamageSource([]))} adjacent=${String(envHazardDamageSource(['adjacent_lava']))}`,
  )
}

// ---------------------------------------------------------------------------
// (f) the drowning geometry is served by the same state
// ---------------------------------------------------------------------------
{
  const map = new Map<string, BlockSpec>()
  floor(map, 1, FEET.y - 1)
  // A water column: the body is submerged, the head cell is water, the cell
  // above the head is water too (not air).
  for (let dy = 0; dy <= 3; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        map.set(key(FEET.x + dx, FEET.y + dy, FEET.z + dz), WATER)
      }
    }
  }
  const deep = perceive(envBot({ blocks: map, oxygenLevel: 4 }))
  const deepHazard = deep.self.envHazard
  check(
    '(f) out of air under water is typed drowning, with water at the head and no air above',
    deepHazard?.drowning === true &&
      deepHazard.kinds.join('+') === 'drowning' &&
      deepHazard.headInWater === true &&
      deepHazard.airAbove === false &&
      deepHazard.escapeRequired === false,
    `hazard=${JSON.stringify(deepHazard)}`,
  )
  // One cell of water above the head and then air: "verified air immediately
  // above" is the geometry the rise reflex needs, and the state carries it.
  // Air exactly where the body's head lands after rising ONE block
  // (feet.y + 2): the "verified air immediately above" geometry.
  const shallowMap = new Map(map)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      shallowMap.set(key(FEET.x + dx, FEET.y + 2, FEET.z + dz), AIR)
    }
  }
  const shallow = perceive(envBot({ blocks: shallowMap, oxygenLevel: 4 }))
  check(
    '(f) rising one cell reaches air: the sensor carries airAbove=true',
    shallow.self.envHazard?.drowning === true && shallow.self.envHazard.airAbove === true,
    `hazard=${JSON.stringify(shallow.self.envHazard)}`,
  )
  // The drowning escape belongs to the existing submersion machinery (one
  // owner): this layer adds no escape candidate for it, and the restriction is a
  // no-op so `ASCEND:surface` stays Jev's.
  const drowningCandidates = envHazardEscapeCandidates(deep)
  const set: Candidate[] = [
    { id: 'ASCEND:surface:p10_64_5', kind: 'MOVE', target: { x: 10, y: 64, z: 5 }, meta: { surfaceAscent: true } },
    { id: 'MINE:b12_60_5', kind: 'MINE', target: { x: 12, y: 60, z: 5 }, meta: {} },
  ] as unknown as Candidate[]
  const restricted = restrictCandidatesDuringEnvHazard(deep, set)
  check(
    '(f) drowning adds no escape candidate and does not fight the submersion restriction',
    drowningCandidates.length === 0 &&
      restricted.length === set.length &&
      envHazardReflexAction(deep, set) === null,
    `candidates=${drowningCandidates.length} kept=[${restricted.map((candidate) => candidate.id).join(' ')}]`,
  )
  // The state's damage attribution serves a drowning body too.
  check(
    '(f) a drowning body with a verified rise above reflexes the surface route alone',
    envHazardReflexAction(shallow, [set[0] as Candidate]) !== null,
    `reflex=${envHazardReflexAction(shallow, [set[0] as Candidate])?.candidate.id ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (h) issue #436 §8 boundary: stabilise only, never choose a destination
//
//   (a) a unique IMMEDIATE safe escape -> the reflex executes, bounded, and
//       control returns (one step, no long escape, no new objective);
//   (b) TWO different safe escapes -> code does NOT choose: both stay offered
//       and the boundary names the alternatives;
//   (c) a unique but NON-immediate route out (a keep-distance RETREAT, a local
//       dig) -> no reflex at all: that is semantic gameplay policy, Jev's WHICH;
//   (d) the §17 evidence layers separate HARD_SAFETY_REFLEX from a mechanical
//       continuation and record the interrupt boundary.
// ---------------------------------------------------------------------------
{
  // (a) one-cell slot, exactly one adjacent escape.
  const slot = pocket()
  slot.set(key(FEET.x, FEET.y, FEET.z), FIRE)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue
      const solid = !(dx === 1 && dz === 0)
      slot.set(key(FEET.x + dx, FEET.y, FEET.z + dz), solid ? STONE : AIR)
      slot.set(key(FEET.x + dx, FEET.y + 1, FEET.z + dz), solid ? STONE : AIR)
    }
  }
  const unique = perceive(envBot({ blocks: slot }))
  const uniqueCandidates = envHazardEscapeCandidates(unique)
  const uniqueReflex = envHazardReflexAction(unique, uniqueCandidates)
  const step = uniqueReflex?.candidate
  check(
    '(h/a) a unique immediate escape reflexes EXACTLY one adjacent step (bounded)',
    uniqueReflex !== null &&
      step?.kind === 'MOVE' &&
      step.meta.envHazardEscape === 'fire' &&
      step.target !== null &&
      Math.hypot(step.target.x - FEET.x, step.target.z - FEET.z) <= 1.5,
    `reflex=${step?.id ?? 'none'} target=${JSON.stringify(step?.target ?? null)}`,
  )
  // (b) the same hazard with two open neighbours: both offered, code abstains.
  const twin = pocket()
  twin.set(key(FEET.x, FEET.y, FEET.z), FIRE)
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue
      const open = (dx === 1 && dz === 0) || (dx === 0 && dz === 1)
      twin.set(key(FEET.x + dx, FEET.y, FEET.z + dz), open ? AIR : STONE)
      twin.set(key(FEET.x + dx, FEET.y + 1, FEET.z + dz), open ? AIR : STONE)
    }
  }
  const twoWay = perceive(envBot({ blocks: twin }))
  const twoWayCandidates = envHazardEscapeCandidates(twoWay)
  const twoWayReflex = envHazardReflexAction(twoWay, twoWayCandidates)
  check(
    '(h/b) two safe escapes are Jev\'s WHICH: code chooses neither, both offered',
    envHazardEscapeSpots(twoWay).length === 2 &&
      twoWayCandidates.length === 2 &&
      twoWayReflex === null,
    `offered=[${twoWayCandidates.map((candidate) => candidate.id).join(' ')}] reflex=${twoWayReflex?.candidate.id ?? 'none'}`,
  )
  // (c) the unique route out is a keep-distance RETREAT (3+ m away): semantic
  // policy, so code must NOT take it even though it is the only grounded route.
  const far = { x: FEET.x + 4, y: FEET.y, z: FEET.z }
  const retreat = {
    ...(uniqueCandidates[0] as Candidate),
    id: `RETREAT:${blockId('p', far)}`,
    kind: 'RETREAT' as const,
    target: far,
  }
  const retreatOnly = envHazardReflexAction(unique, [retreat])
  check(
    '(h/c) a unique LONG retreat is not a stabilisation: no reflex, the choice stays with Jev',
    envHazardEscapeRoutes(unique, [retreat]).length === 1 && retreatOnly === null,
    `routes=${envHazardEscapeRoutes(unique, [retreat]).map((candidate) => candidate.id).join(' ')} reflex=${retreatOnly?.candidate.id ?? 'none'}`,
  )
  // A unique LOCAL dig (DESCEND) is the same: a new destination, not a
  // stabilisation.
  const dig = {
    ...(uniqueCandidates[0] as Candidate),
    id: 'DESCEND:down:E:b11_59_5',
    kind: 'DESCEND' as const,
    target: { x: FEET.x + 1, y: FEET.y - 1, z: FEET.z },
  }
  check(
    '(h/c) a unique local dig is not a stabilisation either',
    envHazardReflexAction(unique, [dig]) === null,
    `reflex=${envHazardReflexAction(unique, [dig])?.candidate.id ?? 'none'}`,
  )
  // (d) §17 evidence: the authority layer is explicit and the boundary carries
  // the alternatives; a mechanical continuation never borrows this label.
  const ownerSkill = 'MOVE:known:blaze_rod:b39_59_-20'
  const stepLine = formatSkillStep(
    ownerSkill,
    'env_hazard_stabilize',
    formatSkillStepAuthority('HARD_SAFETY_REFLEX', 'kind=fire block=fire@10,60,5', 'stabilize_one_step', { budget: 1 }),
  )
  const refusedLine = formatSkillStep(
    ownerSkill,
    'env_hazard_stabilize',
    formatSkillStepAuthority('HARD_SAFETY_REFLEX', 'kind=lava', 'none', { budget: 1, failure: 'guard_LAVA_RISK' }),
  )
  const boundaryLine = formatSkillPolicyBoundary({
    skill: ownerSkill,
    reason: 'multiple_grounded_escapes',
    alternatives: twoWayCandidates.map((candidate) => candidate.id),
  })
  const interruptBoundary = formatSkillPolicyBoundary({
    skill: ownerSkill,
    reason: 'hard_safety_interrupt',
    alternatives: [],
  })
  const mechanical = formatSkillStep('ENTER_PORTAL(portalSite)', 'walk_in', 'cell=1,2,3')
  check(
    '(d) §17 evidence separates HARD_SAFETY_REFLEX from a mechanical continuation',
    stepLine.startsWith(SKILL_STEP) &&
      stepLine.includes('authority=HARD_SAFETY_REFLEX') &&
      stepLine.includes('budget=1') &&
      boundaryLine.startsWith(SKILL_POLICY_BOUNDARY) &&
      boundaryLine.includes('reason=multiple_grounded_escapes') &&
      boundaryLine.includes('alternatives=[') &&
      interruptBoundary.includes('reason=hard_safety_interrupt') &&
      // a refused stabilisation is a TYPED failure, never a silent no-op
      refusedLine.includes('failure=guard_LAVA_RISK') &&
      refusedLine.includes('budget=1') &&
      mechanical.startsWith(SKILL_STEP) &&
      !mechanical.includes('authority='),
    `step="${stepLine}" boundary="${boundaryLine}"`,
  )
  check(
    '(d) the reflex target is a body change with no objective attached',
    step !== undefined &&
      step.meta.goalDrop === undefined &&
      step.meta.retrieval === undefined &&
      step.meta.foodRoute === undefined &&
      step.targetName === null &&
      step.targetEntityId === null,
    `meta=${JSON.stringify(step?.meta ?? {})}`,
  )
}

// ---------------------------------------------------------------------------
// (i) §8 "immediately unsafe only": a neighbourhood fact and an already-handled
//     burning are NOT stabilisation cases
// ---------------------------------------------------------------------------
{
  // Burning WHILE IN WATER: the water is already putting the fire out. The fact
  // is still reported, but there is nothing to stabilise and no route out of the
  // water is offered.
  const wet = pocket()
  wet.set(key(FEET.x, FEET.y, FEET.z), WATER)
  const wetState = perceive(envBot({ blocks: wet, metadata: [0x01] }))
  check(
    '(i) burning in water is reported but needs no escape (the water is the fix)',
    wetState.self.envHazard?.onFire === true &&
      wetState.self.envHazard.inWaterWhileBurning === true &&
      wetState.self.envHazard.escapeRequired === false &&
      envHazardEscapeCandidates(wetState).length === 0 &&
      envHazardReflexAction(wetState, []) === null,
    `hazard=${JSON.stringify(wetState.self.envHazard)}`,
  )
  // Lava NEXT TO the body with no immediate damage: a neighbourhood fact. The
  // state names it, the offer is untouched (no envelope, no reflex), and the
  // existing LAVA_RISK guard keeps owning "do not step into it".
  const beside = pocket()
  beside.set(key(FEET.x + 1, FEET.y, FEET.z), LAVA)
  const besideState = perceive(envBot({ blocks: beside }))
  const set: Candidate[] = [
    { id: 'MINE:b11_60_5', kind: 'MINE', target: { x: 11, y: 60, z: 5 }, meta: {} },
    { id: 'WAIT', kind: 'WAIT', target: null, meta: {} },
  ] as unknown as Candidate[]
  const unchanged = restrictCandidatesDuringEnvHazard(besideState, set)
  check(
    '(i) adjacent lava is a fact, not an immediate-damage state: no envelope, no reflex',
    besideState.self.envHazard?.adjacentLava === true &&
      besideState.self.envHazard.escapeRequired === false &&
      envHazardEscapeCandidates(besideState).length === 0 &&
      unchanged.length === set.length &&
      envHazardReflexAction(besideState, set) === null,
    `hazard=${JSON.stringify(besideState.self.envHazard)} kept=${unchanged.length}`,
  )
}

// ---------------------------------------------------------------------------
// (g) the pure state builder refuses to guess
// ---------------------------------------------------------------------------
{
  const unknown = buildEnvHazardState({
    self: FEET,
    feetBlock: null,
    headBlock: null,
    supportBlock: null,
    onFire: null,
    outOfAir: false,
    inWater: false,
    headInWater: false,
    airAbove: false,
    cells: [],
  })
  check(
    '(g) an unloaded/unknown cell and an unexposed on-fire flag are never a hazard',
    unknown.active === false && unknown.onFire === null && unknown.kinds.length === 0 && unknown.cell === null,
    `state=${JSON.stringify(unknown)}`,
  )
  const cells: EnvHazardCell[] = [
    { position: { x: 11, y: 60, z: 5 }, standable: true, hazard: null, hazardBlock: null, water: false },
    { position: { x: 11, y: 60, z: 6 }, standable: true, hazard: null, hazardBlock: null, water: false },
    { position: { x: 11, y: 60, z: 7 }, standable: true, hazard: null, hazardBlock: null, water: false },
    { position: { x: 12, y: 60, z: 5 }, standable: true, hazard: null, hazardBlock: null, water: false },
  ]
  const fireState: EnvHazardState = {
    active: true,
    inFire: true,
    inLava: false,
    onFire: false,
    drowning: false,
    headInWater: false,
    airAbove: false,
    adjacentLava: false,
    inWaterWhileBurning: false,
    kinds: ['fire'],
    cell: { x: 10, y: 60, z: 5 },
    block: 'fire',
    escapeRequired: true,
  }
  const capped = selectEnvHazardEscapes({ self: FEET, hazard: fireState, cells, max: 2 })
  check(
    '(g) the exit offer is bounded and nearest-first, never directional',
    capped.length === 2 &&
      capped[0]?.spot.z === 5 &&
      capped[1]?.spot.z === 6 &&
      capped.every((escape, index) => index === 0 || escape.distance >= (capped[index - 1]?.distance ?? 0)),
    `escapes=${capped.map((escape) => `${escape.spot.x},${escape.spot.y},${escape.spot.z}`).join(' ')}`,
  )
  // Lava-class adjacency disqualifies a destination; a hazard-free destination
  // beside fire does not.
  const withLava = selectEnvHazardEscapes({
    self: FEET,
    hazard: fireState,
    cells,
    hazardBlocks: [{ name: 'lava', position: { x: 11, y: 60, z: 5 } }],
    max: 10,
  })
  const withFire = selectEnvHazardEscapes({
    self: FEET,
    hazard: fireState,
    cells,
    hazardBlocks: [{ name: 'fire', position: { x: 10, y: 60, z: 5 } }],
    max: 10,
  })
  check(
    '(g) a lava-class neighbour is refused, fire adjacency alone is not',
    // The lava cell and both of its neighbours are refused (the shared 1.5 m
    // margin); the fire the body stands in refuses nothing.
    withLava.length === 1 &&
      withLava[0]?.spot.z === 7 &&
      withFire.length === 4,
    `lava=[${withLava.map((escape) => `${escape.spot.x},${escape.spot.z}`).join(' ')}] fire=${withFire.length}`,
  )
  check(
    '(g) the survival facts needed by the marker are the code-owned ones',
    bodySurvivalFacts({ health: 3, food: 17 }).food === 17,
    `food=${bodySurvivalFacts({ health: 3, food: 17 }).food}`,
  )
}

process.stdout.write('------------------------------------------------------------------------\n')
process.stdout.write(`env hazard cases: ${failures === 0 ? 'all passed' : `${failures} failed`}\n`)
if (failures > 0) process.exit(1)
