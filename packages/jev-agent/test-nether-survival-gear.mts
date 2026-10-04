// test-nether-survival-gear.mts - the Nether survival envelope the measured
// deaths name: keep a usable weapon, keep armour on, eat when hurt, and be honest
// about a damage race the body could have escaped or ended.
//
// MEASURED (live log `/home/s0u7a/mc-ai-worktrees/m3-live/buddy-driver/buddy.log`,
// 2026-09-22T10:49:53.584Z - 10:49:59.586Z, the closest fortress approach of the
// run: 16.06 m):
//
//   463026 THREAT_NEARBY threat=magma_cube threatId=45891 distance=2.98 contact=true
//          danger=true entryReason=contact weapon=stone_pickaxe food=20 health=16.704
//   463027 REACHABILITY candidate=ATTACK:e45891 kind=ATTACK reachable=true
//   463054 ACTION_PREEMPT chosenId=RETREAT:p11_59_4      <- Jev chose RETREAT
//   463055 SURVIVAL_REGROUND ... reason=same_threat_keep_distance
//   463066 THREAT_NEARBY ... distance=2.06 contact=true weapon=stone_pickaxe health=8.316
//   463098 SURVIVAL_REGROUND ... reason=same_threat_keep_distance   (again)
//   463109 DEATH ... lostInventory={...,"stone_pickaxe":1,"diamond_sword":1}
//   463121 SPAWN ... respawn=true
//   463123 LADDER_INVENTORY_SETTLE reason=death readings=11 empty=false itemCount=27
//          counts={...,"stone_pickaxe":1,"diamond_sword":1}
//
// The keepInventory correction matters: `DEATH ... lostInventory=` is the
// inventory AT the moment of death (`capturedBeforeDrop=true`), and the settled
// post-respawn read proves the items SURVIVED. A `stone_pickaxe` in hand therefore
// never means "the sword was lost" - it means the sword was never re-equipped.
//
// What is pinned here, in fixture order (the objective's own list):
//   (i)   the measured damage race: a sensed hostile in contact + damage landing
//         -> the response is grounded and typed, and when no escape exists the
//         body says so (`SURVIVAL_ESCAPE_NONE ... outcome=CAPABILITY_LOST`);
//   (ii)  the respawn case: best weapon/armour carried and un-equipped -> the
//         re-equip is OFFERED and Jev chooses (nothing is auto-executed);
//   (iii) a healthy body -> byte-identical behaviour (no new churn): the arm
//         affordance is absent when the hand already holds the best carried
//         weapon and when no fight is on the table;
//   (iv)  eating when hurt and holding food -> offered (and it survives the
//         contact envelope); no food -> the typed `FOOD_SOURCE_NONE` gap, never a
//         silent no-op;
//   (v)   player-inflicted versus mob-inflicted damage separated in the evidence.
//
//   bun jev-agent/test-nether-survival-gear.mts
import { readFileSync } from 'node:fs'
import {
  applyGroundedThreatRestriction,
  CONTACT_THREAT_KINDS,
  defaultCandidateOptions,
  foodSourceGap,
  generateGroundedCandidates,
  weaponArmCandidates,
} from './src/candidates.ts'
import type { Candidate, CandidateOptions } from './src/candidates.ts'
import { FOOD_SOURCE_NONE, formatFoodSourceGap } from './src/foodSources.ts'
import {
  assessSurvivalRace,
  bodySurvivalFacts,
  classifyDamageSource,
  formatSurvivalDamageRace,
  formatSurvivalEscapeNone,
  regroundVanishedSurvivalChoice,
  SURVIVAL_DAMAGE_RACE,
  SURVIVAL_ESCAPE_NONE,
  survivalControlFallback,
  ThreatTracker,
  weaponFacts,
} from './src/threat.ts'
import type { SurvivalChoiceLike } from './src/threat.ts'
import { MIRRORED_MARKERS } from './src/controller.ts'
import { guardDecision } from './src/policy.ts'
import type { AgentSignals, EntityState, InventoryState, LastDamageEvidence, SelfState, Vec3Json, WorldState } from './src/state.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const NOW = 1_700_000_000_000
const NETHER = 'minecraft:the_nether'
const BODY: Vec3Json = { x: 10, y: 59, z: 0 }
/** the measured mob: 2.06 m away, i.e. inside melee reach, `contact=true` */
const CUBE: Vec3Json = { x: 12.06, y: 59, z: 0 }
const CUBE_ID = 45891

function selfState(position: Vec3Json, overrides: Partial<SelfState> = {}): SelfState {
  return {
    username: 'AI_M3SURVIVAL',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: NETHER,
    isDay: false,
    heldItem: null,
    ...overrides,
  }
}

function queuedGoal(): QueuedGoal {
  return {
    id: 'g1:collect:blaze_rod',
    kind: 'collect',
    description: 'collect 7 x blaze_rod',
    targetItem: 'blaze_rod',
    requiredCount: 7,
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
  const goal = queuedGoal()
  return { depth: 1, current: goal, empty: false, hasImpossible: false, done: 0, goals: [goal] }
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
    lastDamage: null,
    ...overrides,
  }
}

function entity(
  id: number,
  name: string,
  position: Vec3Json,
  hostile: boolean,
  overrides: Partial<EntityState> = {},
): EntityState {
  const distance = Math.sqrt(
    (position.x - BODY.x) ** 2 + (position.y - BODY.y) ** 2 + (position.z - BODY.z) ** 2,
  )
  return {
    id,
    name,
    kind: hostile ? 'hostile' : 'passive',
    username: null,
    position,
    distance: Math.round(distance * 100) / 100,
    hostile,
    lineOfSight: true,
    heldItem: null,
    health: 16,
    attackedSelf: true,
    ...overrides,
  }
}

/**
 * The measured situation, as a world state: the body holds the `stone_pickaxe`,
 * carries the `diamond_sword`, has lost 11.7 of its 20 health, is at full food,
 * and a magma_cube is inside melee reach with the last hit 400 ms ago.
 */
function measuredBody(overrides: Partial<WorldState> = {}): WorldState {
  const inventory: InventoryState = {
    slots: [],
    counts: { stone_pickaxe: 1, diamond_sword: 1 },
    totalItems: 2,
  }
  const cube = entity(CUBE_ID, 'magma_cube', CUBE, true)
  const hit: LastDamageEvidence = { atMs: NOW - 400, health: 8.316, sourceId: CUBE_ID, sourceName: 'magma_cube' }
  return {
    schemaVersion: 1,
    tick: 41,
    timestampMs: NOW,
    self: selfState(BODY, { health: 8.316, food: 20, heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 } }),
    inventory,
    entities: [cube],
    blocks: [],
    terrain: {
      // The cells the measured body retreated through: each buys separation from
      // the cube, all of them remain inside its reach at decision time.
      standable: [BODY, { x: 10, y: 59, z: -2 }, { x: 10, y: 59, z: -3 }],
      escapeCells: [{ x: 10, y: 59, z: -2 }, { x: 10, y: 59, z: -3 }],
    },
    craftingTables: [],
    furnaces: [],
    placementSpots: [],
    goal: {
      id: 'collect:blaze_rod',
      description: 'collect 7 x blaze_rod',
      targetItem: 'blaze_rod',
      requiredCount: 7,
      startCount: 0,
      haveCount: 0,
      progress: 0,
      complete: false,
      startedAtMs: 0,
    },
    goalQueue: queue(),
    recentEvents: [],
    signals: signals({ stalledMs: 61_350, lastDamage: hit }),
    ...overrides,
  }
}

/** The tracker observation for a state, so the danger STATE matches the sensor. */
function noteThreat(state: WorldState, atMs = NOW): WorldState {
  return {
    ...state,
    signals: {
      ...state.signals,
      threat: new ThreatTracker().note({ atMs, entities: state.entities, lastDamage: state.signals.lastDamage ?? null }),
    },
  }
}

const ids = (candidates: readonly Candidate[]): string[] => candidates.map((candidate) => candidate.id).sort()

function offerFor(state: WorldState, options: CandidateOptions = defaultCandidateOptions): Candidate[] {
  const grounded = generateGroundedCandidates(state, options)
  return applyGroundedThreatRestriction(state, grounded.candidates, grounded.withheld).candidates
}

/** The race facts the controller mirrors, computed from the restricted offer. */
function raceFacts(state: WorldState, offer: readonly Candidate[]) {
  const evidence = state.signals.threat ?? null
  const escapes = offer
    .filter((candidate) => candidate.kind === 'RETREAT')
    .map((candidate) => ({
      separationGain:
        typeof candidate.meta.separationGain === 'number' && Number.isFinite(candidate.meta.separationGain)
          ? candidate.meta.separationGain
          : 0,
      outsideReach: candidate.meta.outsideReach === true,
    }))
  const lastDamage = state.signals.lastDamage ?? null
  return assessSurvivalRace({
    evidence,
    body: bodySurvivalFacts(state.self),
    weapon: weaponFacts(state.self.heldItem?.name ?? null),
    damage: classifyDamageSource(lastDamage, state.entities),
    escapes,
    damageAgoMs:
      lastDamage === null || !Number.isFinite(lastDamage.atMs) ? null : Math.max(0, state.timestampMs - lastDamage.atMs),
  })
}

// ---------------------------------------------------------------------------
// (i) the measured damage race
// ---------------------------------------------------------------------------

addCase('(i1) the measured magma_cube race keeps a GROUNDED response at contact', () => {
  const state = noteThreat(measuredBody())
  const offer = offerFor(state)
  const evidence = state.signals.threat!
  const kinds = [...new Set(offer.map((candidate) => candidate.kind))].sort()
  const pass =
    evidence.active === true &&
    evidence.inContact === true &&
    evidence.threatId === CUBE_ID &&
    // a real answer survives the contact envelope: the self-care the contact
    // envelope used to erase. Under p23.12's CAN race verdict the ATTACK is a
    // doomed action here (diamond_sword killMs=2250 vs cube deathMs=2000 -
    // this fixture models the measured DEATH state) and the escape cells stay
    // inside the cube's reach, so EQUIP is the one grounded survival answer:
    // the arm the body needed armed BEFORE the fight, exactly the affordance
    // the armament arm exists to keep offered. (i4) owns the no-escape
    // CAPABILITY_LOST path; (iii3) owns the armed-swing label.
    offer.some((candidate) => candidate.id === 'EQUIP:hand:diamond_sword') &&
    offer.every((candidate) => CONTACT_THREAT_KINDS.has(candidate.kind) || candidate.kind === 'MOVE')
  return {
    pass,
    detail: `contact=${evidence.inContact} offered=[${ids(offer).join(',')}] kinds=[${kinds.join(',')}]`,
  }
})

addCase('(i2) the race is TYPED: the escape-versus-damage fact names what the record can prove', () => {
  // The measured geometry: the cells the body retreated through are far enough
  // from the cube to leave its reach at decision time (`RETREAT:p11_59_4` at
  // ~9 m), which is exactly why this marker must NOT claim the body gets away -
  // the cube closed the gap between ticks and contact never broke (2.98 m ->
  // 2.06 m). The fact states the destination and the reason; the honest limit is
  // written down in `assessSurvivalRace`.
  const state = noteThreat(
    measuredBody({
      terrain: {
        standable: [BODY, { x: 11, y: 59, z: 4 }],
        escapeCells: [{ x: 11, y: 59, z: 4 }],
      },
    }),
  )
  const offer = offerFor(state)
  const facts = raceFacts(state, offer)
  const line = formatSurvivalDamageRace(facts)
  const escapes = offer.filter((candidate) => candidate.kind === 'RETREAT')
  const pass =
    escapes.length > 0 &&
    facts.threatName === 'magma_cube' &&
    facts.contact === true &&
    facts.damageAgoMs === 400 &&
    facts.damage.source === 'mob' &&
    facts.damage.evidence === 'sensed_hostile' &&
    facts.body.health === 8.316 &&
    facts.body.food === 20 &&
    facts.body.regenerating === true &&
    facts.weapon.name === 'stone_pickaxe' &&
    // the measured death was armed with a pickaxe: no swing damage is pinned for
    // a tool, and the line must say so instead of inventing one
    facts.weapon.damage === null &&
    facts.escapeCount === escapes.length &&
    facts.bestSeparationGain !== null &&
    line.startsWith(SURVIVAL_DAMAGE_RACE) &&
    line.includes('source=mob') &&
    line.includes('damageAgo=400ms') &&
    line.includes('weapon=stone_pickaxe') &&
    line.includes('swingDamage=1') &&
    line.includes(`escape=${facts.escape}`) &&
    line.includes(`reason=${facts.reason}`)
  return { pass, detail: line }
})

addCase('(i3) a destination outside the reach is reported as such, and cover inside the reach as inside_reach', () => {
  // Branch 1: the only grounded destination is far outside the cube's reach, so
  // the fact says `outside_reach` - not `none`, and not a prediction.
  const state = noteThreat(
    measuredBody({
      terrain: {
        standable: [BODY, { x: 10, y: 59, z: -12 }],
        escapeCells: [{ x: 10, y: 59, z: -12 }],
      },
    }),
  )
  // Branch 2: the only cell that qualifies does so because it is OUT OF THE CUBE'S
  // SIGHT LINE (real block truth), while still inside its reach - the one shape
  // where a grounded escape is offered and `outsideReach` is false.
  const covered = noteThreat(
    measuredBody({
      terrain: {
        standable: [BODY, { x: 10, y: 59, z: -2 }],
        escapeCells: [{ x: 10, y: 59, z: -2 }],
        threatCoverCells: [{ x: 10, y: 59, z: -2 }],
      },
    }),
  )
  const offer = offerFor(state)
  const facts = raceFacts(state, offer)
  const line = formatSurvivalDamageRace(facts)
  const coverFacts = raceFacts(covered, offerFor(covered))
  const coverLine = formatSurvivalDamageRace(coverFacts)
  const pass =
    facts.escapeCount > 0 &&
    facts.escapesOutsideReach > 0 &&
    facts.escape === 'outside_reach' &&
    facts.reason === 'escape_leaves_threat_reach' &&
    line.includes('escape=outside_reach') &&
    coverFacts.escapeCount > 0 &&
    coverFacts.escapesOutsideReach === 0 &&
    coverFacts.escape === 'inside_reach' &&
    coverFacts.reason === 'escape_stays_in_contact' &&
    coverLine.includes('escape=inside_reach')
  return { pass, detail: `${line} || ${coverLine}` }
})

addCase('(i4) NO grounded escape -> the body SAYS SO (typed CAPABILITY_LOST, not a re-offered retreat)', () => {
  // Every cell the solver could use is gone: the cage the measured deaths named
  // (`CAPABILITY_LOST` for RETREAT when every escape cell is no_path/hazard_blocked).
  const state = noteThreat(
    measuredBody({
      terrain: { standable: [BODY], escapeCells: [] },
    }),
  )
  const offer = offerFor(state)
  const retreats = offer.filter((candidate) => candidate.kind === 'RETREAT')
  const facts = raceFacts(state, offer)
  const line = formatSurvivalEscapeNone(facts)
  const pass =
    retreats.length === 0 &&
    facts.escape === 'none' &&
    facts.reason === 'no_grounded_escape' &&
    facts.escapeCount === 0 &&
    facts.bestSeparationGain === null &&
    line.startsWith(SURVIVAL_ESCAPE_NONE) &&
    line.includes('outcome=CAPABILITY_LOST') &&
    line.includes('reason=no_grounded_escape')
  return { pass, detail: `${line} | retreats=${retreats.length}` }
})

addCase('(i5) the race evidence is MIRRORED (both evidence planes must carry it)', () => {
  const pass =
    MIRRORED_MARKERS.has(SURVIVAL_DAMAGE_RACE) &&
    MIRRORED_MARKERS.has(SURVIVAL_ESCAPE_NONE) &&
    MIRRORED_MARKERS.has('EQUIP_WEAPON') &&
    MIRRORED_MARKERS.has('EQUIP_ARMOR') &&
    MIRRORED_MARKERS.has('EQUIP_WEAPON_REFUSED') &&
    MIRRORED_MARKERS.has('EQUIP_ARMOR_REFUSED') &&
    MIRRORED_MARKERS.has('WEAPON_CHOICE_REQUIRED')
  return {
    pass,
    detail:
      `race=${MIRRORED_MARKERS.has(SURVIVAL_DAMAGE_RACE)} escapeNone=${MIRRORED_MARKERS.has(SURVIVAL_ESCAPE_NONE)} ` +
      `equipWeapon=${MIRRORED_MARKERS.has('EQUIP_WEAPON')} equipArmor=${MIRRORED_MARKERS.has('EQUIP_ARMOR')}`,
  }
})

// ---------------------------------------------------------------------------
// (ii) the respawn case: best weapon/armour carried and un-equipped
// ---------------------------------------------------------------------------

addCase('(ii1) the respawned body is OFFERED the re-equip of weapon and armour (Jev chooses)', () => {
  const state = noteThreat(
    measuredBody({
      inventory: {
        slots: [],
        counts: { stone_pickaxe: 1, diamond_sword: 1, diamond_chestplate: 1 },
        totalItems: 3,
      },
    }),
  )
  const offer = offerFor(state)
  const weapon = offer.find((candidate) => candidate.id === 'EQUIP:hand:diamond_sword')
  const armor = offer.find((candidate) => candidate.id === 'EQUIP:torso:diamond_chestplate')
  const pass =
    weapon !== undefined &&
    weapon.kind === 'EQUIP' &&
    weapon.meta.slot === 'hand' &&
    weapon.itemName === 'diamond_sword' &&
    weapon.meta.weaponDamage === 7 &&
    weapon.meta.replaced === 'stone_pickaxe' &&
    armor !== undefined &&
    armor.meta.slot === 'torso' &&
    // it is an OFFER: the generator is pure and executes nothing, so the choice
    // between arming, fighting, eating and retreating stays with Jev
    offer.filter((candidate) => candidate.kind === 'EQUIP').length >= 2
  return {
    pass,
    detail: `weapon=${weapon?.id ?? 'none'} armor=${armor?.id ?? 'none'} weaponDamage=${String(weapon?.meta.weaponDamage)} equipOffers=${offer.filter((c) => c.kind === 'EQUIP').length}`,
  }
})

addCase('(ii2) the arm offer is ONE PER WEAPON CLASS when classes are distinct (code does not rank sword vs axe)', () => {
  const state = noteThreat(
    measuredBody({
      inventory: { slots: [], counts: { cobblestone: 30, diamond_sword: 1, diamond_axe: 1 }, totalItems: 3 },
      self: selfState(BODY, { health: 18, food: 20, heldItem: { name: 'cobblestone', count: 30, slot: 0 } }),
    }),
  )
  const arms = offerFor(state).filter((candidate) => candidate.meta.weaponArm === true)
  const byClass = new Map(arms.map((candidate) => [String(candidate.meta.weaponClass), candidate.id]))
  const pass =
    arms.length === 2 &&
    byClass.get('sword') === 'EQUIP:hand:diamond_sword' &&
    byClass.get('axe') === 'EQUIP:hand:diamond_axe'
  return { pass, detail: `arms=[${arms.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(ii3) hold_alternatives are exposed as the policy boundary, and code emits no ranking', () => {
  const state = noteThreat(measuredBody())
  const arms = weaponArmCandidates(
    {
      ...state,
      inventory: { slots: [], counts: { diamond_sword: 1, iron_axe: 1 }, totalItems: 2 },
      self: selfState(BODY, { health: 18, heldItem: { name: 'cobblestone', count: 1, slot: 0 } }),
    },
    true,
  )
  const pass = arms.length === 2 && arms.every((candidate) => candidate.meta.weaponArm === true)
  return { pass, detail: `arms=[${arms.map((candidate) => candidate.id).join(',')}]` }
})

addCase('(ii4) the GUARD admits the arm candidate on the hand slot and still denies a foreign slot', () => {
  // The candidate cannot bypass the guard: `guardEquip` is the same gate every
  // other equip passes, and it must accept `hand` while refusing an unknown slot.
  const state = noteThreat(measuredBody())
  const arm = offerFor(state).find((candidate) => candidate.id === 'EQUIP:hand:diamond_sword')
  if (arm === undefined) return { pass: false, detail: 'the arm candidate was not offered' }
  const context = {
    phase: 'decision' as const,
    candidateIds: new Set([arm.id]),
    inFlight: null,
    reach: 4,
    maxCandidateAgeTicks: 40,
  }
  const admitted = guardDecision(arm.id, [arm], state, context)
  const foreign = {
    ...arm,
    id: 'EQUIP:back:diamond_sword',
    meta: { ...arm.meta, slot: 'back' },
  }
  const denied = guardDecision(foreign.id, [foreign], state, { ...context, candidateIds: new Set([foreign.id]) })
  const pass =
    admitted.ok === true &&
    denied.ok === false &&
    denied.code === 'TARGET_GONE' &&
    denied.reason.includes('no valid equip slot')
  return {
    pass,
    detail: `admitted=${admitted.ok} foreign=${denied.ok ? 'accepted' : `${denied.code}: ${denied.reason}`}`,
  }
})

// ---------------------------------------------------------------------------
// (iii) a healthy body: byte-identical behaviour, no new churn
// ---------------------------------------------------------------------------

addCase('(iii1) an armed body gets NO arm offer (the no-op is not a choice, and the item never churns)', () => {
  const state = noteThreat(
    measuredBody({
      self: selfState(BODY, { health: 20, food: 20, heldItem: { name: 'diamond_sword', count: 1, slot: 0 } }),
    }),
  )
  const offer = offerFor(state)
  const attack = offer.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    offer.every((candidate) => candidate.meta.weaponArm !== true) &&
    offer.every((candidate) => candidate.id !== 'EQUIP:hand:diamond_sword') &&
    // the ATTACK line is the historical one: the lease changes nothing here, so
    // there is no new swing fact and no new label text
    attack !== undefined &&
    attack.meta.swingItem === undefined &&
    attack.label.includes('with diamond_sword') &&
    !attack.label.includes('armed on attack')
  return { pass, detail: `offered=[${ids(offer).join(',')}] attack=${attack?.label ?? 'none'}` }
})

addCase('(iii2) a body with NO fight on the table gets NO arm offer while it mines with a tool', () => {
  const calm = measuredBody({
    entities: [],
    signals: signals({ lastDamage: null, stalledMs: 0 }),
    self: selfState(BODY, { health: 20, food: 20, heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 } }),
  })
  const state = noteThreat(calm)
  const offer = offerFor(state)
  const pass = state.signals.threat?.active !== true && offer.every((candidate) => candidate.meta.weaponArm !== true)
  return { pass, detail: `threatActive=${state.signals.threat?.active ?? false} offered=[${ids(offer).join(',')}]` }
})

addCase('(iii3) the ATTACK line states the swing the LEASE will run, once a better weapon is carried', () => {
  // The measured body's own fight is legitimately race_lost under p23.12's CAN
  // verdict (killMs 2250 > deathMs 2000 at health 8.3) and is withheld - this
  // case pins the armed-swing LABEL, so it needs a fight the lease can win:
  // health 14 banks 3 cube hits (3000ms) against the 3-swing kill (2250ms).
  // The lastDamage record keeps its measured values; regen explains the gain.
  const state = noteThreat(measuredBody({ self: selfState(BODY, { health: 14, food: 20, heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 } }) }))
  const offer = offerFor(state)
  const attack = offer.find((candidate) => candidate.kind === 'ATTACK')
  const pass =
    attack !== undefined &&
    attack.meta.swingItem === 'diamond_sword' &&
    attack.meta.swingDamage === 7 &&
    attack.meta.armOnAttackFrom === 'stone_pickaxe' &&
    attack.label.includes('with diamond_sword') &&
    attack.label.includes('armed on attack from stone_pickaxe') &&
    // the held-item facts the earlier line carried are unchanged
    attack.meta.weaponItem === 'stone_pickaxe' &&
    attack.meta.weaponKind === 'tool'
  return { pass, detail: attack?.label ?? 'none' }
})

// ---------------------------------------------------------------------------
// (iv) eating when hurt
// ---------------------------------------------------------------------------

addCase('(iv1) hurt + holding food + a hostile in contact -> EAT is offered (it survives the contact envelope)', () => {
  const state = noteThreat(
    measuredBody({
      inventory: { slots: [], counts: { stone_pickaxe: 1, diamond_sword: 1, cooked_beef: 3 }, totalItems: 4 },
      self: selfState(BODY, { health: 6.5, food: 10, heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 } }),
    }),
  )
  const offer = offerFor(state)
  const eat = offer.find((candidate) => candidate.kind === 'EAT')
  const pass = eat !== undefined && eat.id === 'EAT:cooked_beef' && state.signals.threat?.inContact === true
  return { pass, detail: `contact=${state.signals.threat?.inContact} eat=${eat?.id ?? 'none'} offered=[${ids(offer).join(',')}]` }
})

addCase('(iv2) hurt + NO food -> the typed FOOD_SOURCE_NONE gap, never a silent no-op', () => {
  const state = noteThreat(
    measuredBody({
      inventory: { slots: [], counts: { stone_pickaxe: 1, diamond_sword: 1 }, totalItems: 2 },
      self: selfState(BODY, { health: 6.5, food: 0, heldItem: { name: 'stone_pickaxe', count: 1, slot: 0 } }),
    }),
  )
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const gap = foodSourceGap(state, defaultCandidateOptions, grounded.candidates)
  const eat = grounded.candidates.find((candidate) => candidate.kind === 'EAT')
  const line = gap === null ? '' : formatFoodSourceGap(gap)
  const pass =
    eat === undefined &&
    gap !== null &&
    gap.heldEdible === false &&
    gap.hungry === true &&
    gap.offered.length === 0 &&
    line.startsWith(FOOD_SOURCE_NONE) &&
    line.includes('no_edible_held') &&
    state.self.food === 0 &&
    state.self.health < 10
  return { pass, detail: `${line || 'no gap'} | eat=${eat?.id ?? 'none'}` }
})

addCase('(iv3) a FED body never emits the food gap and never churns an EAT it cannot use', () => {
  // food=20 is the measured death state: eating is mechanically refused by the
  // game at a full hunger bar, so offering it would be a false affordance.
  const state = noteThreat(measuredBody())
  const grounded = generateGroundedCandidates(state, defaultCandidateOptions)
  const gap = foodSourceGap(state, defaultCandidateOptions, grounded.candidates)
  const pass = state.self.food === 20 && gap === null && grounded.candidates.every((c) => c.kind !== 'EAT')
  return { pass, detail: `food=${state.self.food} gap=${gap === null ? 'none' : 'present'} eat=${grounded.candidates.some((c) => c.kind === 'EAT')}` }
})

// ---------------------------------------------------------------------------
// (v) player-inflicted versus mob-inflicted, separated in the evidence
// ---------------------------------------------------------------------------

addCase('(v1) damage attribution classifies a SENSED PLAYER, a SENSED MOB, the environment, and an unseen attacker', () => {
  const playerEntity = entity(9001, 's0u7a', CUBE, false, { kind: 'player', username: 's0u7a', hostile: true })
  const mobEntity = entity(CUBE_ID, 'magma_cube', CUBE, true)
  const player = classifyDamageSource({ sourceId: 9001, sourceName: 's0u7a' }, [playerEntity])
  const mob = classifyDamageSource({ sourceId: CUBE_ID, sourceName: 'magma_cube' }, [mobEntity])
  const environment = classifyDamageSource(null, [mobEntity])
  // The operator's bow: a named source the 24 m sensor never witnessed.
  const unseen = classifyDamageSource({ sourceId: 4242, sourceName: 'Hasilan' }, [mobEntity])
  const pass =
    player.source === 'player' &&
    player.evidence === 'sensed_player' &&
    mob.source === 'mob' &&
    mob.evidence === 'sensed_hostile' &&
    environment.source === 'environment' &&
    environment.evidence === 'none' &&
    unseen.source === 'unattributed' &&
    unseen.name === 'Hasilan' &&
    unseen.evidence === 'unattributed'
  return {
    pass,
    detail: `player=${player.source}/${player.evidence} mob=${mob.source}/${mob.evidence} env=${environment.source}/${environment.evidence} unseen=${unseen.source}/${unseen.name}/${unseen.evidence}`,
  }
})

addCase('(v2) the race line carries the separation (a player-inflicted race says source=player)', () => {
  const playerEntity = entity(9001, 's0u7a', CUBE, false, { kind: 'player', username: 's0u7a', hostile: true })
  const state = noteThreat(
    measuredBody({
      entities: [playerEntity],
      signals: signals({
        stalledMs: 61_350,
        lastDamage: { atMs: NOW - 200, health: 8.316, sourceId: 9001, sourceName: 's0u7a' },
      }),
    }),
  )
  const offer = offerFor(state)
  const facts = raceFacts(state, offer)
  const line = formatSurvivalDamageRace(facts)
  const pass =
    facts.damage.source === 'player' &&
    facts.damage.name === 's0u7a' &&
    line.includes('source=player') &&
    line.includes('sourceName=s0u7a') &&
    line.includes('sourceEvidence=sensed_player')
  return { pass, detail: line }
})

addCase('(v3) a mob-inflicted race and a player-inflicted race are distinguishable in one field', () => {
  const mobLine = formatSurvivalDamageRace(raceFacts(noteThreat(measuredBody()), offerFor(noteThreat(measuredBody()))))
  const playerEntity = entity(9001, 'Hasilan', CUBE, false, { kind: 'player', username: 'Hasilan', hostile: true })
  const playerState = noteThreat(
    measuredBody({
      entities: [playerEntity],
      signals: signals({
        stalledMs: 61_350,
        lastDamage: { atMs: NOW - 200, health: 8.316, sourceId: 9001, sourceName: 'Hasilan' },
      }),
    }),
  )
  const playerLine = formatSurvivalDamageRace(raceFacts(playerState, offerFor(playerState)))
  const pass = mobLine.includes('source=mob') && playerLine.includes('source=player') && mobLine !== playerLine
  return { pass, detail: `mob=${mobLine.includes('source=mob')} player=${playerLine.includes('source=player')}` }
})

// ---------------------------------------------------------------------------
// (vii) never an actionless tick with a hostile in contact
//
// Measured and documented in-tree: at contact the envelope keeps only combat
// kinds, so WAIT/ESCALATE were filtered out of the fresh offer - the fallback had
// nothing to execute and the tick returned with NO action while a reachable
// `ATTACK:e23324` sat in the offer ("the tick did nothing and the body was killed
// in the same second"). The code-owned ESCALATE (it mutates nothing and chooses no
// fight/flight) is therefore still executable.
// ---------------------------------------------------------------------------

addCase('(vii1) an unservable survival action at contact falls back to a code-owned control action', () => {
  const chosen: SurvivalChoiceLike = {
    id: 'RETREAT:p23_57_-20',
    kind: 'RETREAT',
    targetEntityId: null,
    meta: { threatEntityId: 15787 },
  }
  // The measured fresh offer: the reachable `ATTACK:e23324` the body could have
  // taken is on offer, the vanished RETREAT has NO equivalent, and the contact
  // envelope removed the CONTROL kinds.
  const fresh = [{ id: 'ATTACK:e23324', kind: 'ATTACK' }]
  const reground = regroundVanishedSurvivalChoice(chosen, fresh)
  const withoutControl = survivalControlFallback({ reground, threatInContact: true, freshCandidates: fresh })
  const codeOwned = { id: 'ESCALATE', kind: 'ESCALATE' }
  const withControl = survivalControlFallback({
    reground,
    threatInContact: true,
    freshCandidates: fresh,
    codeOwnedEscalate: codeOwned,
  })
  const pass =
    reground.candidateId === null &&
    reground.outcome === 'CAPABILITY_LOST' &&
    withoutControl.candidateId === null &&
    withoutControl.reason === 'no_control_action_offered' &&
    withControl.candidateId === 'ESCALATE' &&
    withControl.reason === 'control_action_escalate_code_owned'
  return {
    pass,
    detail: `reground=${reground.outcome} without=${withoutControl.reason} with=${withControl.reason}/${withControl.candidateId ?? 'none'}`,
  }
})

addCase('(vii2) the controller admits the code-owned control action into the guarded offer', () => {
  const text = readFileSync(new URL('./src/controller.ts', import.meta.url), 'utf8')
  const codeOwned = text.indexOf('const codeOwnedEscalate =')
  const passedIn = text.indexOf('{ codeOwnedEscalate }')
  const admit = text.indexOf('freshCandidates.push(codeOwnedEscalate)')
  const guard = text.indexOf('const guarded = guardDecision(')
  return {
    pass:
      codeOwned > 0 &&
      passedIn > codeOwned &&
      admit > codeOwned &&
      guard > admit &&
      text.includes("threatEscalateCandidate('no_survival_action_in_contact'"),
    detail: `codeOwnedAt=${codeOwned} passedInAt=${passedIn} admitAt=${admit} guardAt=${guard}`,
  }
})

// ---------------------------------------------------------------------------
// the marker vocabulary itself
// ---------------------------------------------------------------------------

addCase('(vi) the new markers are real constants and the formatters are stable prefixes', () => {
  const empty = assessSurvivalRace({
    evidence: null,
    body: { health: 20, food: 20, regenerating: true },
    weapon: weaponFacts(null),
    damage: classifyDamageSource(null, []),
    escapes: [],
  })
  const pass =
    SURVIVAL_DAMAGE_RACE === 'SURVIVAL_DAMAGE_RACE' &&
    SURVIVAL_ESCAPE_NONE === 'SURVIVAL_ESCAPE_NONE' &&
    formatSurvivalDamageRace(empty).startsWith(SURVIVAL_DAMAGE_RACE) &&
    formatSurvivalEscapeNone(empty).startsWith(SURVIVAL_ESCAPE_NONE) &&
    empty.escape === 'none'
  return { pass, detail: `race=${SURVIVAL_DAMAGE_RACE} escapeNone=${SURVIVAL_ESCAPE_NONE}` }
})

let failures = 0
process.stdout.write('Nether survival envelope: gear, self-care, and the damage race\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} nether-survival-gear cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
