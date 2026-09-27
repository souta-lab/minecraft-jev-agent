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
import type { DeathHazard } from './resident-types.ts'
import type { Candidate } from '../jev-agent/src/candidates.ts'
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
        source: 'test',
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
