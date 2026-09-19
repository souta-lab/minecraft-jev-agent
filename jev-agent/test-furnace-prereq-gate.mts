// Regression tests for the furnace prerequisite candidate envelope.
//
// The active smelt Option must retain the selected furnace route and the
// safety/control escape hatch, but it must not admit an untagged semantic
// candidate such as CRAFT:stick.  Run with:
//   npx tsx test-furnace-prereq-gate.mts
import { FURNACE_PREREQUISITE_ROLE } from './src/candidates.ts'
import { filterFurnacePrerequisiteCandidates } from './src/controller.ts'
import type { Candidate, CandidateKind } from './src/candidates.ts'
import type { PrereqPath } from './src/prereqOption.ts'

let failures = 0

function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

function candidate(
  id: string,
  kind: CandidateKind,
  meta: Record<string, string | number | boolean> = {},
): Candidate {
  return {
    id,
    kind,
    label: id,
    targetName: null,
    target: null,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { tick: 1, ...meta },
  }
}

const routeCandidates: Candidate[] = [
  candidate('RETRIEVE:known:station:crafting_table', 'RETRIEVE', {
    prereqPath: 'craft_and_place',
    prerequisiteRole: FURNACE_PREREQUISITE_ROLE,
  }),
  candidate('MINE:headroom', 'MINE', {
    prereqPath: 'craft_and_place',
    prerequisiteRole: FURNACE_PREREQUISITE_ROLE,
    capabilityAcquisition: true,
  }),
  candidate('CRAFT:stick', 'CRAFT'),
  candidate('MINE:unrelated-stone', 'MINE'),
  candidate('MOVE:unrelated', 'MOVE'),
  candidate('RETRIEVE:known:station:furnace', 'RETRIEVE', {
    prereqPath: 'use_known_station',
    prerequisiteRole: FURNACE_PREREQUISITE_ROLE,
  }),
  candidate('ATTACK:e1', 'ATTACK'),
  candidate('EAT:bread', 'EAT'),
  candidate('RETREAT:p0_0_0', 'RETREAT'),
  candidate('WAIT', 'WAIT'),
  candidate('ESCALATE', 'ESCALATE'),
]

const selected = filterFurnacePrerequisiteCandidates(routeCandidates, 'craft_and_place')
check(
  'selected furnace path keeps only its route plus safety/control',
  selected.map((entry) => entry.id).join('|') ===
    [
      'RETRIEVE:known:station:crafting_table',
      'MINE:headroom',
      'ATTACK:e1',
      'EAT:bread',
      'RETREAT:p0_0_0',
      'WAIT',
      'ESCALATE',
    ].join('|'),
  `kept=${selected.map((entry) => entry.id).join(',')}`,
)

const switched = filterFurnacePrerequisiteCandidates(routeCandidates, 'use_known_station')
check(
  'path switch drops the previous route and unrelated productive actions',
  switched.map((entry) => entry.id).join('|') ===
    ['RETRIEVE:known:station:furnace', 'ATTACK:e1', 'EAT:bread', 'RETREAT:p0_0_0', 'WAIT', 'ESCALATE'].join('|'),
  `kept=${switched.map((entry) => entry.id).join(',')}`,
)

const noPath = filterFurnacePrerequisiteCandidates(routeCandidates, null)
check(
  'no feasible path keeps only safety/control',
  noPath.map((entry) => entry.id).join('|') === ['ATTACK:e1', 'EAT:bread', 'RETREAT:p0_0_0', 'WAIT', 'ESCALATE'].join('|'),
  `kept=${noPath.map((entry) => entry.id).join(',')}`,
)

const wrongRole = filterFurnacePrerequisiteCandidates(
  [candidate('MINE:wrong-role', 'MINE', { prereqPath: 'craft_and_place' as PrereqPath, prerequisiteRole: 'other_option' })],
  'craft_and_place',
)
check('a candidate with a different typed prerequisite role is excluded', wrongRole.length === 0, `kept=${wrongRole.map((entry) => entry.id).join(',')}`)

const missingRole = filterFurnacePrerequisiteCandidates(
  [candidate('MINE:missing-role', 'MINE', { prereqPath: 'craft_and_place' as PrereqPath })],
  'craft_and_place',
)
check('an untyped productive candidate is excluded even if its path text matches', missingRole.length === 0, `kept=${missingRole.map((entry) => entry.id).join(',')}`)

if (failures > 0) process.exitCode = 1
