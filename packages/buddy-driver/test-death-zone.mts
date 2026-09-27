// test-death-zone.mts - regression tests for the area-scoped death-zone filter.
//
// Measured portal-p6: 9 deaths spread over ~15 m inside one hostile pocket.
// Every individual death cell merged at count=1, so the old hard-hazard gate
// (`count >= 2` at the exact rounded cell, +-1) never fired and objectives kept
// routing the body back into the lethal area. The zone rule is now area-scoped:
// the summed death count within DEATH_ZONE_RADIUS of a candidate target must
// reach DEATH_ZONE_DEATHS before the target is withheld.
//
// Pure: no bot, no network, no file IO.
import { DEATH_ZONE_DEATHS, DEATH_ZONE_RADIUS, isInDeathZone } from '../jev-agent/src/moveFailMemory.ts'
import { DescendAwarePolicy, pickDescend } from './system-one-policy.ts'
import { applyThreatRestriction, deathZoneEscapeCandidates as zoneEscapes } from '../jev-agent/src/candidates.ts'
import type { Candidate, CandidateOptions } from '../jev-agent/src/candidates.ts'
import type { DeathHazard } from './resident-types.ts'
import type { JevPolicy, JevRequest, JevResult } from '../jev-agent/src/jev.ts'
import type { WorldState } from '../jev-agent/src/state.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const production = (x: number, y: number, z: number, count = 1, dimension?: string): DeathHazard => ({
  x,
  y,
  z,
  dimension,
  reason: 'damage',
  count,
  source: 'production',
  firstSeenAt: 1,
  lastSeenAt: 2,
})

const DIM = 'minecraft:overworld'

function request(candidates: readonly Candidate[], dimension = DIM): JevRequest {
  return {
    stage: 'decide',
    state: {
      self: { dimension },
      goal: { targetItem: null },
    } as unknown as WorldState,
    candidates,
  }
}

function candidate(id: string, kind: Candidate['kind'], target: { x: number; y: number; z: number } | null): Candidate {
  return {
    id,
    kind,
    label: id,
    targetName: target === null ? null : `${target.x},${target.y},${target.z}`,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: false,
    meta: { mode: 'down' },
  }
}

addCase('spread single-death records form a kill zone (portal-p6 shape)', () => {
  // p6 deaths at (3219,63,2812) / (3233,67,2803) / (3225,63,2800) over ~15 m.
  // A collect target at (3225,63,2802) sits inside the pocket: the old exact-cell
  // gate saw count=1 everywhere and allowed it; the zone rule must exclude it.
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const inZone = isInDeathZone(hazards, { x: 3225, y: 63, z: 2802 }, DIM)
  return {
    pass: inZone !== null,
    detail: `radius=${DEATH_ZONE_RADIUS} threshold=${DEATH_ZONE_DEATHS} inZone=${inZone === null ? 'no' : `${inZone.x},${inZone.y},${inZone.z}`}`,
  }
})

addCase('a single death alone is not proof of a kill zone', () => {
  const hazards = [production(3225, 63, 2800, 1, DIM)]
  const inZone = isInDeathZone(hazards, { x: 3225, y: 63, z: 2802 }, DIM)
  return { pass: inZone === null, detail: `inZone=${inZone === null ? 'no' : 'yes'}` }
})

addCase('deaths farther apart than the zone radius do not sum', () => {
  // Two deaths 30 m apart: a target beside only one of them sees total=1.
  const hazards = [production(3200, 64, 2800, 1, DIM), production(3230, 64, 2800, 1, DIM)]
  const nearOne = isInDeathZone(hazards, { x: 3200, y: 64, z: 2802 }, DIM)
  const midpoint = isInDeathZone(hazards, { x: 3215, y: 64, z: 2800 }, DIM)
  return {
    pass: nearOne === null && midpoint === null,
    detail: `near=${nearOne === null ? 'clear' : 'zone'} mid=${midpoint === null ? 'clear' : 'zone'}`,
  }
})

addCase('dimension-scoped hazards only apply in their own dimension', () => {
  const hazards = [production(3219, 63, 2812, 1, 'minecraft:the_nether'), production(3233, 67, 2803, 1, 'minecraft:the_nether')]
  const overworld = isInDeathZone(hazards, { x: 3225, y: 63, z: 2802 }, DIM)
  const nether = isInDeathZone(hazards, { x: 3225, y: 63, z: 2802 }, 'minecraft:the_nether')
  return {
    pass: overworld === null && nether !== null,
    detail: `overworld=${overworld === null ? 'clear' : 'zone'} nether=${nether === null ? 'clear' : 'zone'}`,
  }
})

addCase('dimension-less legacy hazards apply to every dimension (conservative)', () => {
  const hazards = [production(3219, 63, 2812), production(3233, 67, 2803)]
  const overworld = isInDeathZone(hazards, { x: 3225, y: 63, z: 2802 }, DIM)
  const nether = isInDeathZone(hazards, { x: 3225, y: 63, z: 2802 }, 'minecraft:the_nether')
  return {
    pass: overworld !== null && nether !== null,
    detail: `overworld=${overworld === null ? 'clear' : 'zone'} nether=${nether === null ? 'clear' : 'zone'}`,
  }
})

addCase('pickDescend skips a DESCEND target inside the kill zone', () => {
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const inZone = candidate('DESCEND:p3225_60_2802', 'DESCEND', { x: 3225, y: 60, z: 2802 })
  const outside = candidate('DESCEND:p3300_60_2900', 'DESCEND', { x: 3300, y: 60, z: 2900 })
  const picked = pickDescend(request([inZone, outside]), hazards)
  return {
    pass: picked?.id === outside.id,
    detail: `picked=${picked === null ? 'null' : picked.id}`,
  }
})

addCase('pickDescend returns null when every DESCEND target is in-zone (no unsafe pick)', () => {
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const inZone = candidate('DESCEND:p3225_60_2802', 'DESCEND', { x: 3225, y: 60, z: 2802 })
  const picked = pickDescend(request([inZone]), hazards)
  return { pass: picked === null, detail: `picked=${picked === null ? 'null' : picked.id}` }
})

function zoneEscapeFixture(
  selfPos: { x: number; y: number; z: number },
  standable: Array<{ x: number; y: number; z: number }>,
  hazards: readonly DeathHazard[],
  escapeCells: Array<{ x: number; y: number; z: number }> = [],
  exploredCells: ReadonlySet<string> = new Set(),
): { state: WorldState; options: CandidateOptions } {
  const state = {
    self: { position: selfPos, dimension: DIM },
    terrain: { standable, escapeCells },
    signals: { exploredCells },
    tick: 1,
  } as unknown as WorldState
  const options = {
    reach: 4.5,
    blacklistedMoveTargets: (dimension: string, position: { x: number; y: number; z: number }) =>
      isInDeathZone(hazards, position, dimension) !== null,
  } as unknown as CandidateOptions
  return { state, options }
}

addCase('death-zone exits: standing in-zone offers nearest out-of-zone cells', () => {
  // p8 shape: respawn anchor at 3224,64,2809 sits inside the pocket; exits must
  // be the SHORTEST completable legs (nearest first), not max-separation legs.
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const { state, options } = zoneEscapeFixture(
    { x: 3224, y: 64, z: 2809 },
    [
      { x: 3210, y: 64, z: 2815 }, // out of zone, ~16m
      { x: 3230, y: 64, z: 2805 }, // in-zone (between the deaths)
      { x: 3214, y: 64, z: 2818 }, // out of zone, ~13m -> nearest offer
      { x: 3190, y: 64, z: 2830 }, // out of zone, ~40m
    ],
    hazards,
  )
  const offers = zoneEscapes(state, options)
  const targets = offers.map((entry) => `${entry.target?.x},${entry.target?.y},${entry.target?.z}`)
  const allOutside = offers.every(
    (entry) => entry.target !== null && isInDeathZone(hazards, entry.target, DIM) === null,
  )
  return {
    pass: offers.length > 0 && allOutside && targets[0] === '3214,64,2818',
    detail: `offers=[${targets.join(' | ')}] allOutside=${allOutside}`,
  }
})

addCase('death-zone exits: local ring all in-zone, escape ring reaches outside (portal-p9 shape)', () => {
  // p9 measured: the respawn anchor sat inside the pocket, every +-2 m standable
  // cell was still in-zone, and the offer was empty for the whole camp window.
  // The exits must come from the wider stand-verified escape ring.
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const { state, options } = zoneEscapeFixture(
    { x: 3224, y: 64, z: 2809 },
    // the +-2 m ring: every cell still inside the zone
    [
      { x: 3223, y: 64, z: 2808 },
      { x: 3225, y: 64, z: 2810 },
      { x: 3224, y: 64, z: 2807 },
    ],
    hazards,
    // escapeCells: the 16 m ring carrying genuinely out-of-zone cells
    [
      { x: 3208, y: 63, z: 2790 }, // out of zone, ~26m
      { x: 3225, y: 64, z: 2825 }, // out of zone, ~16m -> nearest offer
      { x: 3230, y: 64, z: 2805 }, // in-zone -> withheld
    ],
  )
  const offers = zoneEscapes(state, options)
  const targets = offers.map((entry) => `${entry.target?.x},${entry.target?.y},${entry.target?.z}`)
  const allOutside = offers.every(
    (entry) => entry.target !== null && isInDeathZone(hazards, entry.target, DIM) === null,
  )
  return {
    pass: offers.length === 2 && allOutside && targets[0] === '3225,64,2825',
    detail: `offers=[${targets.join(' | ')}] allOutside=${allOutside}`,
  }
})

addCase('death-zone exits: explored cells are stable proven exits (portal-p10 vanish)', () => {
  // p10 measured: a committed MOVE:dangerzone "vanished between the Jev answer
  // and execution" because escapeCells re-sort with threat motion. Cells the
  // body already occupied are append-only, so their offer cannot churn - and
  // they exist with no live threat, where the escape ring is empty.
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const { state, options } = zoneEscapeFixture(
    { x: 3224, y: 64, z: 2809 },
    [{ x: 3223, y: 64, z: 2808 }], // local ring all in-zone
    hazards,
    [], // no live threat -> escapeCells empty
    new Set(['p3214_64_2818', 'p3230_64_2805', 'p3190_64_2830']),
  )
  const offers = zoneEscapes(state, options)
  const targets = offers.map((entry) => `${entry.target?.x},${entry.target?.y},${entry.target?.z}`)
  const allOutside = offers.every(
    (entry) => entry.target !== null && isInDeathZone(hazards, entry.target, DIM) === null,
  )
  return {
    pass: offers.length === 2 && allOutside && targets[0] === '3214,64,2818',
    detail: `offers=[${targets.join(' | ')}] allOutside=${allOutside}`,
  }
})

addCase('death-zone exits: no offers while the body stands outside the zone', () => {
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const { state, options } = zoneEscapeFixture(
    { x: 3300, y: 64, z: 2900 },
    [{ x: 3305, y: 64, z: 2900 }, { x: 3295, y: 64, z: 2900 }],
    hazards,
  )
  const offers = zoneEscapes(state, options)
  return { pass: offers.length === 0, detail: `offers=${offers.length}` }
})

// Measured portal-p11: the exits emitted and passed reachability, but the
// threat restriction strips every MOVE under contact and the bounded danger
// state - so JEV_CANDIDATE_SET under fire was ATTACK/RETREAT/WAIT and the
// grounded way out of the kill zone never reached Jev. A `MOVE:dangerzone:*`
// is a survival route (same class as RETREAT) and must survive both filters;
// Jev still owns whether to take it over the reflex legs.
function hostileAt(distance: number): { hostile: boolean; distance: number } {
  return { hostile: true, distance }
}

addCase('death-zone exits: the exit survives the contact-range threat offer (portal-p11)', () => {
  const exit = candidate('MOVE:dangerzone:p3214_64_2818', 'MOVE', { x: 3214, y: 64, z: 2818 })
  const attack = candidate('ATTACK:e1', 'ATTACK', null)
  const work = candidate('MINE:b3225_63_2802', 'MINE', { x: 3225, y: 63, z: 2802 })
  const offer = applyThreatRestriction(
    {
      entities: [hostileAt(1.2) as never],
      signals: {} as never,
      timestampMs: 1,
    },
    [exit, attack, work],
  )
  const ids = offer.candidates.map((entry) => entry.id)
  const pass = ids.includes(exit.id) && ids.includes(attack.id) && !ids.includes(work.id) && offer.restricted === true
  return { pass, detail: `offered=[${ids.join(',')}] restricted=${offer.restricted}` }
})

addCase('death-zone exits: the exit survives the bounded danger-state offer (portal-p11)', () => {
  const exit = candidate('MOVE:dangerzone:p3214_64_2818', 'MOVE', { x: 3214, y: 64, z: 2818 })
  const retreat = candidate('RETREAT:p3211_67_2787', 'RETREAT', { x: 3211, y: 67, z: 2787 })
  const work = candidate('MOVE:p3225_63_2802', 'MOVE', { x: 3225, y: 63, z: 2802 })
  const offer = applyThreatRestriction(
    {
      entities: [hostileAt(9) as never], // in the danger radius, out of contact
      signals: { threat: { active: true, threatName: 'zombie' } } as never,
      timestampMs: 1,
    },
    [exit, retreat, work],
  )
  const ids = offer.candidates.map((entry) => entry.id)
  const pass = ids.includes(exit.id) && ids.includes(retreat.id) && !ids.includes(work.id)
  return { pass, detail: `offered=[${ids.join(',')}]` }
})

addCase('DescendAwarePolicy strips in-zone move targets before the inner policy sees them', async () => {
  const hazards = [production(3219, 63, 2812, 1, DIM), production(3233, 67, 2803, 1, DIM)]
  const inZoneMove = candidate('MOVE:p3225_63_2802', 'MOVE', { x: 3225, y: 63, z: 2802 })
  const outsideMove = candidate('MOVE:p3300_64_2900', 'MOVE', { x: 3300, y: 64, z: 2900 })
  const targetless = candidate('WAIT', 'WAIT', null)
  let observed: readonly Candidate[] = []
  const inner: JevPolicy = {
    kind: 'fallback',
    model: 'stub',
    decide(r: JevRequest): Promise<JevResult> {
      observed = r.candidates
      return Promise.resolve({
        callId: 't',
        policy: 'fallback',
        source: 'fallback',
        model: 'stub',
        latencyMs: 0,
        usage: null,
        answers: {
          action: { name: 'action', type: 'choice', value: outsideMove.id, probability: 1, confidence: null, probabilities: null, legend: null, note: null },
        },
      })
    },
  }
  const wrapper = new DescendAwarePolicy(inner, hazards, () => {})
  await wrapper.decide(request([inZoneMove, outsideMove, targetless]))
  const ids = observed.map((entry) => entry.id)
  return {
    pass: !ids.includes(inZoneMove.id) && ids.includes(outsideMove.id) && ids.includes(targetless.id),
    detail: `innerSaw=[${ids.join(' ')}]`,
  }
})

let failures = 0
process.stdout.write('area-scoped death-zone filtering (portal-p6 evidence)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} death-zone cases passed\n`)
if (failures > 0) process.exit(1)
