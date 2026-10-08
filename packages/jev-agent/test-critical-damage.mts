// test-critical-damage.mts - SAFE: the body keeps losing health at critical
// health and the plan never ends it.
//
// Measured live (`m3-live`, `run-mubj6ucc-si3e`, `logs/jev/run.jsonl`):
//
//   18:20:44.778Z hp_changed {health:13, previousHealth:14, food:0, delta:-1}
//   18:20:48.811Z hp_changed {health:12, previousHealth:13, food:0, delta:-1}
//   18:20:56.780Z hp_changed {health:10, previousHealth:11, food:0, delta:-1}
//   18:21:04.780Z hp_changed {health:8,  previousHealth:9,  food:0, delta:-1}
//   18:21:12.810Z hp_changed {health:6,  previousHealth:7,  food:0, delta:-1}
//   18:21:16.778Z hp_changed {health:5,  previousHealth:6,  food:0, delta:-1}
//   18:20:45.638Z trigger=damage_taken -> action=WAIT kind=WAIT | do nothing for one tick
//
// The 15 s HEARTBEAT sampling aliased those 1 HP starvation ticks into
// "health=14 -> 10 -> 6 -> 2 -> 1". It was NOT a mob (every `mob_appeared` line
// says "outside reaction range"; nearest zombie 29.3 m), NOT suffocation and NOT
// a >3-block fall (the world read is an open y=52..55 pocket under a stone
// ceiling at y=56; the body never left y=51..54.6). `food:0` with an
// unattributed `delta:-1` on every `hp_changed` is starvation.
//
// Nothing owned "critical health + damage still landing + the plan is not
// ending it": every existing bound needs a different fact. This fixture pins the
// three layers that must hold:
//
//   (a) the measured shape: the damage is counted, the offer collapses to the
//       routes that can end it, and the plan escalates ONCE with a typed fact
//       instead of settling into WAIT;
//   (b) a normal healthy body is unchanged (no tracker, no restriction, no
//       gratuitous retreat/fight);
//   (c) critical health with a reachable escape keeps the escape and drops the
//       work that cannot end the damage;
//   (d) critical health with no grounded escape preserves the offer (the missing
//       affordance stays observable) and escalates exactly once, bounded;
//   (e) the hungry hunt routes UP to animal habitat (or refuses typed) instead
//       of hunting underground forever;
//   (f) the CAN layer refuses the work a starving body cannot finish, while
//       still allowing the one attack that IS the route to food.
//
// Run: bun test ./test-critical-damage.mts
import {
  CRITICAL_DAMAGE_MARKER,
  CRITICAL_DAMAGE_EXHAUSTED_MARKER,
  CRITICAL_DAMAGE_HEALTH,
  CriticalDamageTracker,
  criticalDamageRequiredLimit,
  formatCriticalDamageEvidence,
  formatCriticalDamageExhausted,
  sampleHealthTransition,
} from './src/criticalDamage.ts'
import {
  ANIMAL_HABITAT_SEA_LEVEL,
  CRITICAL_DAMAGE_KINDS,
  damageEndingCandidates,
  defaultCandidateOptions,
  foodHabitatAscent,
  foodSourceGap,
  formatFoodHabitatRefused,
  generateCandidates,
  generateGroundedCandidates,
  restrictCandidatesDuringCriticalDamage,
} from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import { guardCandidate, guardRejectionChargesOption } from './src/policy.ts'
import { bodyStarving, BODY_STARVING, formatBodyStarving } from './src/state.ts'
import type {
  AgentSignals,
  EntityState,
  GoalState,
  InventoryState,
  SelfState,
  Vec3Json,
  WorldState,
} from './src/state.ts'
import type { CriticalDamageEvidence } from './src/criticalDamage.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const NOW = 1_700_000_000_000

{
  const seed = sampleHealthTransition(null, 20)
  const unchanged = sampleHealthTransition(20, 20)
  const damage = sampleHealthTransition(20, 5)
  const recovery = sampleHealthTransition(5, 20)
  check(
    '(sample) health fallback observes only real transitions',
    !seed.observe &&
      !unchanged.observe &&
      damage.observe &&
      damage.previousHealth === 20 &&
      damage.delta === -15 &&
      recovery.observe &&
      recovery.delta === 15,
    `seed=${JSON.stringify(seed)} unchanged=${JSON.stringify(unchanged)} damage=${JSON.stringify(damage)} recovery=${JSON.stringify(recovery)}`,
  )
}

// ---------------------------------------------------------------------------
// (a) the measured shape: count -> collapse the offer -> escalate ONCE typed
// ---------------------------------------------------------------------------
{
  const tracker = new CriticalDamageTracker(3)
  const plan = 'g37:collect:food|plan=g37:collect:food'
  const evidence: CriticalDamageEvidence[] = []
  // The critical phase of the live starvation slide: -1 HP per observation at or
  // below the critical floor, food empty, no attacker. Above the floor the body
  // is not yet critical, so the counter deliberately stays at 0 there.
  for (const [health, previousHealth] of [
    [6, 7],
    [5, 6],
    [4, 5],
  ] as const) {
    evidence.push(tracker.note({ health, previousHealth, planKey: plan, food: 0, sourceName: null }))
  }
  const first = evidence[0]
  const exhausted = evidence[2]
  if (exhausted === undefined) throw new Error('fixture: expected a third evidence entry')
  const escalatedOnThird = exhausted.exhausted && exhausted.consecutiveDamage === 3
  const notBefore = !(evidence[1]?.exhausted ?? false)
  const unattributed = exhausted.sourceName === null && exhausted.food === 0
  const line = formatCriticalDamageExhausted('g37:collect:food', exhausted)
  const markerTyped =
    line.startsWith(CRITICAL_DAMAGE_EXHAUSTED_MARKER) && line.includes('food=0') && line.includes('source=environment')
  check(
    '(a) the measured starvation shape is counted and escalates ONCE on the 3rd critical damage observation',
    notBefore && escalatedOnThird && unattributed && markerTyped,
    `counts=${evidence.map((entry) => entry.consecutiveDamage).join(',')} exhausted=${escalatedOnThird} line="${line}"`,
  )
  // The bound: after the escalation the same plan must earn a LONGER run before
  // it can wake the semantic layer again (no "escalate every 3 damage ticks").
  const after = tracker.acknowledgeEscalation()
  const bounded = after.consecutiveDamage === 0 && after.exhaustedRepeats === 1 && after.limit === 6
  const next = []
  for (const [health, previousHealth] of [
    [3, 4],
    [2, 3],
    [1, 2],
    [1, 1],
    [1, 1],
  ] as const) {
    next.push(tracker.note({ health, previousHealth, planKey: plan, food: 0, sourceName: null }).exhausted)
  }
  check(
    '(a) the escalation is bounded: the same plan needs 6 fresh damage observations next',
    bounded && next.filter(Boolean).length === 0,
    `limit=${after.limit} repeats=${after.exhaustedRepeats} nextExhausted=${next.join(',')}`,
  )
  // The sensor-fact line names the body state, and the starving marker is exact.
  const firstLine = formatCriticalDamageEvidence('g37:collect:food', first as CriticalDamageEvidence)
  const starvingLine = formatBodyStarving({ food: 0, health: 5 }, { x: 23, y: 53, z: 9 })
  check(
    '(a) the evidence and body marker are typed and greppable',
    firstLine.startsWith(CRITICAL_DAMAGE_MARKER) &&
      starvingLine.startsWith(BODY_STARVING) &&
      starvingLine.includes('food=0') &&
      bodyStarving({ food: 0, health: 5 }),
    `evidence="${firstLine}" body="${starvingLine}"`,
  )
}

// ---------------------------------------------------------------------------
// (b) a normal healthy body is unchanged
// ---------------------------------------------------------------------------
{
  const tracker = new CriticalDamageTracker(3)
  const healthy = tracker.note({ health: 20, previousHealth: 20, planKey: 'g1', food: 20, sourceName: null })
  const restrictionUnchanged = (food: number, health: number, signals: AgentSignals): boolean => {
    const set: Candidate[] = [
      { id: 'MINE:b1_50_1', kind: 'MINE' },
      { id: 'PLACE:furnace:p1_50_1', kind: 'PLACE' },
      { id: 'WAIT', kind: 'WAIT' },
    ] as unknown as Candidate[]
    const out = restrictCandidatesDuringCriticalDamage(
      { signals, self: { food, health } as unknown as SelfState },
      set,
    )
    return out.length === set.length && out.every((candidate, index) => candidate.id === set[index]?.id)
  }
  check(
    '(b) a normal healthy body arms no tracker and its offer is untouched',
    healthy.active === false &&
      healthy.exhausted === false &&
      healthy.consecutiveDamage === 0 &&
      restrictionUnchanged(20, 20, { criticalDamage: healthy } as AgentSignals),
    `active=${healthy.active} count=${healthy.consecutiveDamage}`,
  )
  // A body at critical health but NOT losing health (already stabilised) is also
  // unchanged: only fresh damage may escalate.
  const stable = tracker.note({ health: 6, previousHealth: 6, planKey: 'g1', food: 12, sourceName: null })
  check(
    '(b) critical health with no fresh damage does not escalate',
    stable.active === false && stable.exhausted === false,
    `health=${stable.health} active=${stable.active} count=${stable.consecutiveDamage}`,
  )
}

// ---------------------------------------------------------------------------
// (c) critical health with a reachable escape -> the escape is the offer
// ---------------------------------------------------------------------------
{
  const self = { food: 0, health: 5 } as unknown as SelfState
  const evidence = {
    planKey: 'p',
    health: 5,
    criticalHealth: CRITICAL_DAMAGE_HEALTH,
    consecutiveDamage: 1,
    limit: 3,
    food: 0,
    sourceName: null,
    active: true,
    exhausted: false,
    exhaustedRepeats: 0,
  } satisfies CriticalDamageEvidence
  const set: Candidate[] = [
    { id: 'RETREAT:p28_55_7', kind: 'RETREAT', meta: {} },
    { id: 'EAT:bread', kind: 'EAT', meta: {} },
    { id: 'ASCEND:habitat:p26_64_9', kind: 'MOVE', meta: { foodHabitat: true } },
    { id: 'ATTACK:e7', kind: 'ATTACK', meta: { foodAnimal: true } },
    { id: 'PLACE:furnace:p26_52_8', kind: 'PLACE', meta: {} },
    { id: 'MINE:b26_52_8', kind: 'MINE', meta: {} },
    { id: 'WAIT', kind: 'WAIT', meta: {} },
  ] as unknown as Candidate[]
  const out = restrictCandidatesDuringCriticalDamage(
    { signals: { criticalDamage: evidence } as AgentSignals, self },
    set,
  )
  const ids = out.map((candidate) => candidate.id)
  const keptEscape = ids.includes('RETREAT:p28_55_7') && ids.includes('ASCEND:habitat:p26_64_9')
  const keptFood = ids.includes('EAT:bread') && ids.includes('ATTACK:e7')
  const droppedWork = !ids.includes('PLACE:furnace:p26_52_8') && !ids.includes('MINE:b26_52_8') && !ids.includes('WAIT')
  check(
    '(c) critical damage keeps the escape + the routes to food and drops the work that cannot end it',
    keptEscape && keptFood && droppedWork,
    `kept=[${ids.join(' ')}]`,
  )
  // The starving sensor fact alone (before any tracker observation) is enough.
  const starvingOnly = restrictCandidatesDuringCriticalDamage(
    { signals: {} as AgentSignals, self },
    set,
  )
  check(
    '(c) the bodyStarving sensor fact alone arms the same restriction',
    starvingOnly.some((candidate) => candidate.id === 'RETREAT:p28_55_7') &&
      !starvingOnly.some((candidate) => candidate.id === 'PLACE:furnace:p26_52_8'),
    `kept=[${starvingOnly.map((candidate) => candidate.id).join(' ')}]`,
  )
  check(
    '(c) the kept set is exactly the damage-ending kinds plus a food hunt',
    CRITICAL_DAMAGE_KINDS.has('RETREAT') && CRITICAL_DAMAGE_KINDS.has('MOVE') && CRITICAL_DAMAGE_KINDS.has('EAT'),
    `kinds=[${[...CRITICAL_DAMAGE_KINDS].join(' ')}]`,
  )

  const mandatoryLocal: Candidate = {
    id: 'CRAFT:iron_pickaxe',
    kind: 'CRAFT',
    meta: { localMandatoryCraftRecovery: true },
  } as unknown as Candidate
  const ordinaryCraft: Candidate = {
    id: 'CRAFT:chest',
    kind: 'CRAFT',
    meta: {},
  } as unknown as Candidate
  const floorOffer = restrictCandidatesDuringCriticalDamage(
    { signals: {} as AgentSignals, self: { food: 0, health: 1 } as unknown as SelfState },
    [set[0]!, mandatoryLocal, ordinaryCraft],
  )
  const aboveFloorOffer = restrictCandidatesDuringCriticalDamage(
    { signals: {} as AgentSignals, self: { food: 0, health: 5 } as unknown as SelfState },
    [set[0]!, mandatoryLocal, ordinaryCraft],
  )
  check(
    '(c2) at the starvation floor only a typed local mandatory craft may coexist with rescue routes',
    floorOffer.some((candidate) => candidate.id === mandatoryLocal.id) &&
      !floorOffer.some((candidate) => candidate.id === ordinaryCraft.id) &&
      !aboveFloorOffer.some((candidate) => candidate.id === mandatoryLocal.id),
    `floor=[${floorOffer.map((candidate) => candidate.id).join(' ')}] above=[${aboveFloorOffer.map((candidate) => candidate.id).join(' ')}]`,
  )
}

// ---------------------------------------------------------------------------
// (d) critical health with no grounded escape -> offer preserved + ONE typed escalation
// ---------------------------------------------------------------------------
{
  const self = { food: 0, health: 1 } as unknown as SelfState
  const evidence = {
    planKey: 'p',
    health: 1,
    criticalHealth: CRITICAL_DAMAGE_HEALTH,
    consecutiveDamage: 3,
    limit: 3,
    food: 0,
    sourceName: null,
    active: true,
    exhausted: true,
    exhaustedRepeats: 0,
  } satisfies CriticalDamageEvidence
  // No RETREAT/EAT/MOVE at all: only work + WAIT. The restriction must NOT erase
  // the set (the missing affordance has to stay observable).
  const set: Candidate[] = [
    { id: 'PLACE:furnace:p26_52_8', kind: 'PLACE', meta: {} },
    { id: 'WAIT', kind: 'WAIT', meta: {} },
  ] as unknown as Candidate[]
  const out = restrictCandidatesDuringCriticalDamage(
    { signals: { criticalDamage: evidence } as AgentSignals, self },
    set,
  )
  check(
    '(d) no grounded escape preserves the offer so the missing affordance stays observable',
    out.length === set.length && out.every((candidate, index) => candidate.id === set[index]?.id),
    `out=[${out.map((candidate) => candidate.id).join(' ')}]`,
  )
  const tracker = new CriticalDamageTracker(3)
  let fired = 0
  let lines: string[] = []
  for (const [health, previousHealth] of [
    [5, 6],
    [4, 5],
    [3, 4],
    [2, 3],
    [1, 2],
  ] as const) {
    const state = tracker.note({ health, previousHealth, planKey: 'p', food: 0, sourceName: null })
    if (!state.exhausted) continue
    fired += 1
    lines.push(formatCriticalDamageExhausted('place:nether_portal:1', state))
    tracker.acknowledgeEscalation() // the controller consumes the evidence here
  }
  const oneTypedEscalation = fired === 1 && lines.length === 1 && lines[0]?.includes(CRITICAL_DAMAGE_EXHAUSTED_MARKER)
  check(
    '(d) an unbroken critical damage slide escalates exactly once, not on every tick',
    oneTypedEscalation === true,
    `fired=${fired} line="${lines[0] ?? ''}"`,
  )
}

// ---------------------------------------------------------------------------
// (e) the hungry hunt routes UP to animal habitat, or refuses typed
// ---------------------------------------------------------------------------
function self(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_CRITDMG',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 1,
    food: 0,
    gameMode: 'survival',
    dimension: 'minecraft:overworld',
    isDay: true,
    heldItem: null,
    ...overrides,
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

function queuedFood(): QueuedGoal {
  return {
    id: 'g37:collect:food',
    kind: 'collect',
    description: 'collect 3 x food (hunt passive animals)',
    targetItem: 'food',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
  }
}

function foodGoal(): GoalState {
  return {
    id: 'g37:collect:food',
    description: 'collect 3 x food (hunt passive animals)',
    targetItem: 'food',
    requiredCount: 3,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

function queueWith(current: QueuedGoal): GoalQueueState {
  return { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] }
}

/** The measured hunting shape: health 1, food 0, underground (y=53), no animal sensed. */
function hungryUndergroundWorld(counts: Record<string, number>, entities: EntityState[] = [], y = 53): WorldState {
  const feet: Vec3Json = { x: 23, y, z: 9 }
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: NOW,
    self: self(feet),
    inventory: inventory(counts),
    entities,
    blocks: [],
    terrain: { standable: [feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: foodGoal(),
    goalQueue: queueWith(queuedFood()),
    recentEvents: [],
    descent: [],
    stepCuts: [],
    signals: signals(),
  }
}

{
  const state = hungryUndergroundWorld({ dirt: 1 })
  const ascent = foodHabitatAscent(state, defaultCandidateOptions)
  const candidate = ascent.candidates[0]
  const routesUp =
    ascent.candidates.length === 1 &&
    candidate?.kind === 'MOVE' &&
    candidate.id.startsWith('ASCEND:habitat:') &&
    candidate.meta.foodHabitat === true &&
    candidate.meta.ascentTargetY === ANIMAL_HABITAT_SEA_LEVEL
  check(
    '(e) a hungry body underground with no sensed animal enumerates a route UP to animal habitat',
    routesUp,
    `id=${candidate?.id ?? 'none'} targetY=${String(candidate?.meta.ascentTargetY)} vertical=${String(candidate?.meta.vertical)}`,
  )
  // And it reaches the full generated offer, not just the pure helper.
  const generated = generateCandidates(state, defaultCandidateOptions)
  check(
    '(e) the habitat route is part of the generated offer',
    generated.some((entry) => entry.id.startsWith('ASCEND:habitat:')),
    `habitat=${generated.filter((entry) => entry.id.startsWith('ASCEND:habitat:')).map((entry) => entry.id).join(',') || 'none'}`,
  )
  // No grounded way up: a typed refusal, never silence.
  const blocked = hungryUndergroundWorld({})
  const grounded = generateGroundedCandidates(blocked, defaultCandidateOptions)
  const refusal = grounded.foodHabitatRefusal
  const typed = refusal !== null && formatFoodHabitatRefused(refusal).startsWith('FOOD_HABITAT_REFUSED')
  check(
    '(e) no grounded route up refuses typed instead of hunting underground forever',
    typed,
    refusal === null ? 'refusal=null' : `"${formatFoodHabitatRefused(refusal)}"`,
  )
  // A grounded contact route makes the habitat ascent redundant. Merely
  // sensing an animal is not the proof; this nearby cow is actually offered.
  const cow: EntityState = {
    id: 7,
    name: 'cow',
    kind: 'animal',
    username: null,
    position: { x: 25, y: 53, z: 9 },
    distance: 2,
    hostile: false,
    lineOfSight: true,
    heldItem: null,
    attackedSelf: false,
  }
  const withAnimal = generateGroundedCandidates(hungryUndergroundWorld({ dirt: 1 }, [cow]), defaultCandidateOptions)
  const animalRoute = withAnimal.candidates.some((candidate) => candidate.meta.foodRoute === 'animal')
  const habitatRoute = withAnimal.candidates.some((candidate) => candidate.meta.foodHabitat === true)
  check(
    '(e) a grounded animal route keeps the redundant habitat ascent out of the offer',
    animalRoute && !habitatRoute,
    `animalRoute=${animalRoute} habitatRoute=${habitatRoute}`,
  )
}

// p27.32 measured a stale explore:cave head at health=1/food=0 after the
// habitat ascent became grounded. d1:free saw `ASCEND:habitat` beside generic
// explore MOVEs and chose the latter twice because the starvation damage-ending
// classifier recognized direct foodRoute/foodAnimal facts but not the existing
// `foodHabitat` route fact. The model still chooses WHICH action within the
// deterministic survival offer; this only removes non-food exploration while a
// grounded route toward food exists.
{
  const state = hungryUndergroundWorld({ dirt: 1 })
  const queued: QueuedGoal = {
    ...queuedFood(),
    id: 'g9:explore',
    kind: 'explore',
    description: 'explore cave terrain',
    targetItem: 'explore',
    requiredCount: 1,
    optionInstanceId: 'explore:cave',
    optionTemplateId: 'explore:cave',
  }
  state.goal = {
    ...foodGoal(),
    id: 'g9:explore',
    description: 'explore cave terrain',
    targetItem: 'explore',
    requiredCount: 1,
  }
  state.goalQueue = queueWith(queued)
  const habitat = foodHabitatAscent(state, defaultCandidateOptions).candidates[0]
  const genericExplore: Candidate = {
    id: 'MOVE:generic-explore',
    kind: 'MOVE',
    meta: { explore: true },
  } as unknown as Candidate
  const starvingOffer = habitat === undefined
    ? []
    : restrictCandidatesDuringCriticalDamage(state, [habitat, genericExplore])
  const fed = {
    ...state,
    self: { ...state.self, health: 20, food: 20 },
  }
  const fedOffer = habitat === undefined
    ? []
    : restrictCandidatesDuringCriticalDamage(fed, [habitat, genericExplore])
  const attributedDamage: CriticalDamageEvidence = {
    planKey: 'g9:explore|g9:explore',
    health: 1,
    criticalHealth: 6,
    consecutiveDamage: 1,
    limit: 3,
    food: 0,
    sourceName: 'zombie',
    active: true,
    exhausted: false,
    exhaustedRepeats: 0,
  }
  const damagedByMob = {
    ...state,
    signals: { ...state.signals, criticalDamage: attributedDamage },
  }
  const attributedDamageOffer = habitat === undefined
    ? []
    : restrictCandidatesDuringCriticalDamage(damagedByMob, [habitat, genericExplore])
  check(
    '(e2) starvation-only retains the grounded food-habitat ascent and removes generic exploration; fed and attributed-damage controls stay broad',
    habitat?.meta.foodHabitat === true &&
      starvingOffer.length === 1 && starvingOffer[0]?.id === habitat.id &&
      fedOffer.length === 2 && fedOffer[0]?.id === habitat.id && fedOffer[1]?.id === genericExplore.id &&
      attributedDamageOffer.length === 2 && attributedDamageOffer[0]?.id === habitat.id && attributedDamageOffer[1]?.id === genericExplore.id,
    `habitat=${habitat?.id ?? 'none'} starving=[${starvingOffer.map((candidate) => candidate.id).join(' ')}] fed=[${fedOffer.map((candidate) => candidate.id).join(' ')}] attributedDamage=[${attributedDamageOffer.map((candidate) => candidate.id).join(' ')}]`,
  )
}

// The direct-source gap and the independent habitat route can coexist. The
// body remains starving and no food is claimed while verified ascent evidence
// narrows the route's height gap over successive fresh states.
{
  const sensedButUnroutableZombie: EntityState = {
    id: 99,
    name: 'zombie',
    kind: 'hostile',
    username: null,
    position: { x: 31, y: 17, z: 9 },
    distance: 8,
    hostile: true,
    lineOfSight: false,
    heldItem: null,
    attackedSelf: false,
  }
  const observations = [17, 18, 19, 20].map((y) => {
    const state = hungryUndergroundWorld({ dirt: 8, iron_pickaxe: 1 }, [sensedButUnroutableZombie], y)
    state.self = {
      ...state.self,
      position: { x: 23.5, y, z: 9.5 },
      eyePosition: { x: 23.5, y: y + 1.62, z: 9.5 },
    }
    const ascent = foodHabitatAscent(state, defaultCandidateOptions)
    const route = ascent.candidates.find((candidate) => candidate.meta.foodHabitat === true)
    const gap = foodSourceGap(state, defaultCandidateOptions, ascent.candidates)
    return { y, remainingHeight: ANIMAL_HABITAT_SEA_LEVEL - y, route, gap, state }
  })
  const measuredProgress = observations.every((sample, index) => {
    if (index === 0) return sample.remainingHeight === ANIMAL_HABITAT_SEA_LEVEL - 17
    const previous = observations[index - 1]
    return previous !== undefined && sample.y > previous.y && sample.remainingHeight < previous.remainingHeight
  })
  const preservesDistinctTruth = observations.every(({ y, route, gap, state }) =>
    state.self.health === 1 && state.self.food === 0 &&
    route?.meta.ascentTargetY === ANIMAL_HABITAT_SEA_LEVEL && route.meta.foodHabitat === true &&
    route.meta.foodRoute === undefined &&
    gap?.reason === 'source_withheld' && gap.missingLink === 'no_route_to_sensed_source' &&
    gap.sensedFoodMob === true && gap.offered.length === 0 && y < ANIMAL_HABITAT_SEA_LEVEL,
  )
  check(
    '(e4) an underground starving ascent can make multi-step route progress while the direct food-source gap stays truthful',
    observations.length === 4 && measuredProgress && preservesDistinctTruth,
    `heights=[${observations.map(({ y, remainingHeight }) => `${y}->${remainingHeight}`).join(' ')}] routes=[${observations.map(({ route }) => route?.id ?? 'none').join(' ')}] gaps=[${observations.map(({ gap }) => `${gap?.reason ?? 'none'}/${gap?.missingLink ?? 'none'}`).join(' ')}]`,
  )
}

// p27.37: the exact step-overhead MINE is the first leg of the grounded food
// habitat route. Its typed identity must keep that purpose and destination
// through starvation-only filtering and cell-level clearance realizations.
{
  const state = hungryUndergroundWorld({ cobblestone: 64, iron_pickaxe: 1 })
  const queued: QueuedGoal = {
    ...queuedFood(),
    id: 'g9:explore',
    kind: 'explore',
    description: 'explore cave terrain',
    targetItem: 'explore',
    requiredCount: 1,
    optionInstanceId: 'explore:cave',
    optionTemplateId: 'explore:cave',
  }
  state.goal = {
    ...foodGoal(),
    id: 'g9:explore',
    description: 'explore cave terrain',
    targetItem: 'explore',
    requiredCount: 1,
  }
  state.goalQueue = queueWith(queued)
  state.stepCuts = [
    {
      dir: 'E',
      dx: 1,
      dz: 0,
      cut: { x: 24, y: 54, z: 9 },
      step: { x: 24, y: 54, z: 9 },
      name: 'stone',
      safe: false,
      reason: 'no headroom above the new step',
      blockedBy: { pos: { x: 24, y: 55, z: 9 }, name: 'stone' },
    },
  ]
  const ascent = foodHabitatAscent(state, defaultCandidateOptions)
  const clearance = ascent.candidates.find((candidate) => candidate.id === 'MINE:b24_55_9')
  const genericExplore: Candidate = {
    id: 'MOVE:generic-search',
    kind: 'MOVE',
    label: 'continue unrelated cave exploration',
    target: { x: 22, y: 53, z: 9 },
    targetName: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    toolTier: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: state.tick, explore: true },
  } as unknown as Candidate
  const starvingOffer = clearance === undefined
    ? []
    : restrictCandidatesDuringCriticalDamage(state, [clearance, genericExplore])
  check(
    '(e3) p27.37 step-overhead clearance keeps food-habitat identity through starvation filtering under a stale cave-explore head',
    ascent.refusal?.reason === 'step_overhead' &&
      clearance?.target?.x === 24 && clearance.target.y === 55 && clearance.target.z === 9 &&
      clearance.meta.clearance === true && clearance.meta.stepOverhead === true &&
      clearance.meta.foodHabitat === true && clearance.meta.foodHabitatGoalId === 'g9:explore' &&
      clearance.meta.ascentTargetY === ANIMAL_HABITAT_SEA_LEVEL &&
      clearance.meta.approachLeg === 'food_habitat_clearance' &&
      clearance.meta.approachTarget === 'animal-habitat:y>=63' &&
      clearance.label.includes('food-habitat ascent') &&
      starvingOffer.length === 1 && starvingOffer[0]?.id === clearance.id,
    `refusal=${ascent.refusal?.reason ?? 'none'} clearance=${clearance?.id ?? 'none'} foodHabitat=${String(clearance?.meta.foodHabitat)} goal=${String(clearance?.meta.foodHabitatGoalId)} offer=[${starvingOffer.map((candidate) => candidate.id).join(' ')}]`,
  )
}

// ---------------------------------------------------------------------------
// (f) the CAN layer refuses work a starving body cannot finish, but keeps food
// ---------------------------------------------------------------------------
{
  const cow: EntityState = {
    id: 7,
    name: 'cow',
    kind: 'animal',
    username: null,
    position: { x: 24, y: 53, z: 9 },
    distance: 1,
    hostile: false,
    lineOfSight: true,
    heldItem: null,
    attackedSelf: false,
  }
  const zombie: EntityState = {
    id: 9,
    name: 'zombie',
    kind: 'hostile',
    username: null,
    position: { x: 24, y: 53, z: 9 },
    distance: 1,
    hostile: true,
    lineOfSight: true,
    heldItem: null,
    attackedSelf: true,
  }
  const world = (entities: EntityState[]): WorldState => ({
    ...hungryUndergroundWorld({}, entities),
    terrain: { standable: [{ x: 23, y: 53, z: 9 }] },
  })
  const context = {
    phase: 'decision' as const,
    candidateIds: new Set(['ATTACK:e7', 'ATTACK:e9', 'EAT:bread']),
    inFlight: null,
    reach: 4,
    maxCandidateAgeTicks: 100,
  }
  const attack = (id: string, meta: Record<string, string | number | boolean>): Candidate =>
    ({
      id,
      kind: 'ATTACK',
      label: 'attack',
      targetName: null,
      target: { x: 24, y: 53, z: 9 },
      targetEntityId: Number(id.slice('ATTACK:e'.length)),
      itemName: null,
      requiresTool: false,
      toolName: null,
      inReach: true,
      hasStandableAdjacent: true,
      meta: { tick: 7, ...meta },
    }) as unknown as Candidate
  const starvingWorld = world([cow, zombie])
  const plainAttack = guardCandidate(attack('ATTACK:e9', {}), starvingWorld, context)
  const foodAttack = guardCandidate(attack('ATTACK:e7', { foodAnimal: true }), starvingWorld, context)
  check(
    '(f) a starving critical body is refused a non-food attack typed STARVING, food hunt allowed',
    plainAttack.ok === false &&
      plainAttack.code === 'STARVING' &&
      foodAttack.ok === true &&
      guardRejectionChargesOption('STARVING') === false,
    `plain=${plainAttack.ok ? 'ok' : plainAttack.code} food=${foodAttack.ok ? 'ok' : foodAttack.code}`,
  )
  // A healthy body is never refused by this precondition.
  const healthyWorld = world([cow, zombie])
  healthyWorld.self = self({ x: 23, y: 53, z: 9 }, { health: 20, food: 20 })
  const healthyAttack = guardCandidate(attack('ATTACK:e9', {}), healthyWorld, context)
  check(
    '(f) the STARVING precondition does not touch a healthy body',
    healthyAttack.ok === true,
    `healthy=${healthyAttack.ok ? 'ok' : healthyAttack.code}`,
  )
}

// ---------------------------------------------------------------------------
// (g) the durable STARVING state arms the same bounded escalation WITHOUT a
//     damage event - the measured live plateau (health 1, food 0)
//
// Live mechanism (run-mubobiq6-12onv, source 1a72fe2): the body held no edible
// item, `FOOD_LOW food=0 heldFood=null`, its gameplay offer grounded no
// damage-ending route, and starvation floors at 1 HP so no `hp_changed` event
// ever arrived. The event-only tracker therefore stayed `active:false` forever
// (the log carries exactly two `BODY_STARVING` lines and zero `CRITICAL_DAMAGE`)
// while the body idled at health 1. The fix feeds the code-owned starving STATE
// on every decision, so the same bounded boundary fires.
// ---------------------------------------------------------------------------
{
  const plan = 'g60:collect:raw_iron|g60:collect:raw_iron'
  const tracker = new CriticalDamageTracker(3)
  const observed: CriticalDamageEvidence[] = []
  for (let decision = 0; decision < 3; decision += 1) {
    observed.push(tracker.noteStarving({ planKey: plan, health: 1, food: 0, starving: true }))
  }
  const third = observed[2]
  let fired = 0
  let line = ''
  if (third !== undefined && third.exhausted) {
    fired += 1
    line = formatCriticalDamageExhausted('g60:collect:raw_iron', third)
    tracker.acknowledgeEscalation()
  }
  check(
    '(g1) a plateaud starving body arms the escalation with NO damage event (health 1, food 0)',
    observed.every((entry) => entry.active === true) &&
      fired === 1 &&
      line.startsWith(CRITICAL_DAMAGE_EXHAUSTED_MARKER) &&
      line.includes('food=0'),
    `active=${observed.map((entry) => entry.active).join(',')} fired=${fired} line="${line}"`,
  )
  // Bounded: exactly as the damage path, the same plan now needs a LONGER run
  // before the next wake, so a persistent starving state cannot hot-loop System2.
  const after = tracker.evidence()
  const next = Array.from({ length: 5 }, () =>
    tracker.noteStarving({ planKey: plan, health: 1, food: 0, starving: true }).exhausted,
  )
  const sixth = tracker.noteStarving({ planKey: plan, health: 1, food: 0, starving: true }).exhausted
  check(
    '(g1) the starvation escalation is bounded - the next wake needs 6 fresh decisions',
    after.exhaustedRepeats === 1 && after.limit === 6 && next.every((value) => value === false) && sixth === true,
    `repeats=${after.exhaustedRepeats} limit=${after.limit} next=${next.join(',')} sixth=${sixth}`,
  )
  const recovered = tracker.noteStarving({ planKey: plan, health: 6, food: 4, starving: false })
  check(
    '(g1) a grounded recovery clears the durable starvation state (no escalation on progress)',
    recovered.active === false && recovered.starvingDecisions === 0,
    `active=${recovered.active} starvingDecisions=${String(recovered.starvingDecisions)}`,
  )
}

function queuedRawIron(): QueuedGoal {
  return {
    id: 'g60:collect:raw_iron',
    kind: 'collect',
    description: 'collect 1 x raw_iron',
    targetItem: 'raw_iron',
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

function rawIronGoal(): GoalState {
  return {
    id: 'g60:collect:raw_iron',
    description: 'collect 1 x raw_iron',
    targetItem: 'raw_iron',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
  }
}

/**
 * The measured live shape: an underground body on a raw_iron goal with a
 * remembered (or far sensed) iron cell, no edible item and no animal. `known`
 * null means "no remembered cell"; otherwise the durable memory knows this one
 * ore cell, exactly like the live `raw_iron:21` world model.
 */
function oreWorld(opts: {
  health: number
  food: number
  counts: Record<string, number>
  known: Vec3Json | null
  standable?: Vec3Json[]
  blocks?: WorldState['blocks']
}): WorldState {
  const feet: Vec3Json = { x: 3, y: 67, z: 22 }
  const current = queuedRawIron()
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: NOW,
    self: self(feet, { health: opts.health, food: opts.food }),
    inventory: inventory(opts.counts),
    entities: [],
    blocks: opts.blocks ?? [],
    terrain: { standable: opts.standable ?? [feet] },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: rawIronGoal(),
    goalQueue: { ...emptyGoalQueueState(), depth: 1, current, empty: false, goals: [current] },
    recentEvents: [],
    descent: [],
    stepCuts: [],
    signals: signals({
      knownResources: opts.known === null ? [] : [{ name: 'iron_ore', kind: 'ore', dimension: 'minecraft:overworld', position: opts.known }],
    }),
  }
}

// (a) health 1 + no food + a remembered ore cell, and a sensed far ore block
//     whose interaction stand does not exist: the offer grounds NO
//     damage-ending route, the remembered ore route is on offer, and the
//     dig-access MOVE is withheld exactly like the live `ACCESS:b-23_69_43`.
//     The durable starvation state must therefore escalate ONCE - never a bare
//     WAIT, and never an invented eat/hunt/ascent.
{
  const far: Vec3Json = { x: -23, y: 69, z: 43 }
  const state = oreWorld({
    health: 1,
    food: 0,
    counts: { stone_pickaxe: 1, charcoal: 1 },
    known: far,
    blocks: [
      {
        name: 'iron_ore',
        kind: 'ore',
        position: far,
        distance: 33.7,
        diggable: true,
        inReach: false,
        visible: true,
        harvestTool: 'pickaxe',
        harvestTier: 1,
        hasAdjacentStandable: false,
        adjacentStandable: null,
      },
    ],
  })
  const grounded = generateGroundedCandidates(state, {
    ...defaultCandidateOptions,
    reachability: { digApproach: () => ({ approach: null, path: null }) },
  })
  const withheldAccess = grounded.withheld.find((entry) => entry.candidate.id === 'ACCESS:b-23_69_43')
  const evidence = new CriticalDamageTracker(3)
  let exhausted = false
  for (let decision = 0; decision < 3; decision += 1) {
    exhausted = evidence.noteStarving({
      planKey: 'g60:collect:raw_iron|g60:collect:raw_iron',
      health: 1,
      food: 0,
      starving: bodyStarving({ food: 0, health: 1 }),
    }).exhausted
  }
  const restricted = restrictCandidatesDuringCriticalDamage(
    { signals: { criticalDamage: evidence.evidence() } as AgentSignals, self: state.self },
    grounded.candidates,
  )
  const rescue = damageEndingCandidates(restricted)
  const productive = restricted.some((candidate) => candidate.kind !== 'WAIT')
  const noInventedFood = restricted.every(
    (candidate) => candidate.kind !== 'EAT' && !(candidate.kind === 'ATTACK' && candidate.meta.foodAnimal === true) && !candidate.id.startsWith('ASCEND:habitat:'),
  )
  check(
    '(g2/a) health 1 + no food + a withheld remembered ore: one typed escalation, never a bare WAIT',
    exhausted === true && rescue.length === 0 && productive === true && noInventedFood === true,
    `escalated=${exhausted} rescue=[${rescue.map((candidate) => candidate.id).join(' ')}] offered=[${restricted.map((candidate) => candidate.id).join(' ')}]`,
  )
  check(
    '(g2/a) the far dig-access MOVE is withheld exactly like the live ACCESS candidate',
    withheldAccess !== undefined && withheldAccess.result.reason === 'no_standable_approach',
    withheldAccess === undefined
      ? 'withheld=[]'
      : `withheld=${withheldAccess.candidate.id} reason=${withheldAccess.result.reason}`,
  )
}

// (b) a reachable remembered ore cell: the ore route is presented and a healthy
//     body's restriction is a no-op.
{
  const target: Vec3Json = { x: 3, y: 66, z: 30 }
  const state = oreWorld({
    health: 20,
    food: 20,
    counts: { stone_pickaxe: 1 },
    known: target,
    standable: [{ x: 3, y: 67, z: 22 }, { x: 3, y: 66, z: 30 }],
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const offered = grounded.candidates
  const restricted = restrictCandidatesDuringCriticalDamage(
    { signals: {} as AgentSignals, self: state.self },
    offered,
  )
  const oreRoute = offered.some((candidate) => candidate.id.startsWith('RETRIEVE:known:raw_iron:'))
  const unchanged =
    restricted.length === offered.length && restricted.every((candidate, index) => candidate.id === offered[index]?.id)
  check(
    '(g3/b) a reachable remembered ore keeps its ore route and a healthy body is unchanged',
    oreRoute && unchanged,
    `oreRoute=${oreRoute} unchanged=${unchanged} offered=[${offered.map((candidate) => candidate.id).join(' ')}]`,
  )
}

// (c) health 20 + remembered cell: the starving restriction never engages, so
//     the existing explore/nearer-target behaviour is untouched.
{
  const state = oreWorld({
    health: 20,
    food: 20,
    counts: { stone_pickaxe: 1 },
    known: { x: -23, y: 69, z: 43 },
  })
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const offeredIds = grounded.candidates.map((candidate) => candidate.id)
  const restricted = restrictCandidatesDuringCriticalDamage(
    { signals: { criticalDamage: { active: false } } as unknown as AgentSignals, self: state.self },
    grounded.candidates,
  )
  const unchanged =
    restricted.length === grounded.candidates.length &&
    restricted.every((candidate, index) => candidate.id === grounded.candidates[index]?.id)
  check(
    '(g4/c) health 20 + a remembered cell leaves the offer unchanged (no starvation restriction)',
    unchanged && offeredIds.length > 0,
    `unchanged=${unchanged} offered=[${offeredIds.join(' ')}]`,
  )
}

// (d) genuine no-route + no-food: exactly ONE escalation per bounded window.
{
  const tracker = new CriticalDamageTracker(3)
  const plan = 'g60:collect:raw_iron|g60:collect:raw_iron'
  const fireAt: number[] = []
  for (let decision = 0; decision < 20; decision += 1) {
    const state = tracker.noteStarving({ planKey: plan, health: 1, food: 0, starving: true })
    if (!state.exhausted) continue
    fireAt.push(decision)
    tracker.acknowledgeEscalation()
  }
  check(
    '(g5/d) a genuine no-route-no-food state escalates once per bounded window, never per tick',
    fireAt.length === 2 && fireAt[0] === 2 && fireAt[1] === 8,
    `fireAt=[${fireAt.join(',')}] (limit=3, next window 6)`,
  )
}

process.stdout.write('------------------------------------------------------------------------\n')
process.stdout.write(`critical damage cases: ${failures === 0 ? 'all passed' : `${failures} failed`}\n`)
if (failures > 0) process.exit(1)
