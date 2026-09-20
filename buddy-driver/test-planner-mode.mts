// test-planner-mode.mts - authority contract: model planning is the resident default.
//
// Deterministic planning is an explicit baseline/offline choice only. Credential
// availability does not choose authority: a missing key is handled by the
// fail-loud model boundary, not by silently switching PlannerMode.
import { resolvePlannerMode } from './planner.ts'

type PlannerMode = ReturnType<typeof resolvePlannerMode>

interface Case {
  name: string
  planner: string | undefined
  gatewayKey: string | undefined
  expected?: PlannerMode
  throws?: boolean
}

const cases: Case[] = [
  { name: 'unset with gateway key defaults to model', planner: undefined, gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'unset without gateway key still requests model authority', planner: undefined, gatewayKey: undefined, expected: 'llm' },
  { name: 'auto requests model authority', planner: 'auto', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'empty value behaves like unset', planner: '', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'explicit deterministic baseline', planner: 'deterministic', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'off alias is explicit baseline', planner: 'off', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'fallback alias is explicit baseline', planner: 'fallback', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'none alias is explicit baseline', planner: 'none', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'unknown value fails instead of silently selecting deterministic', planner: 'typo', gatewayKey: 'fixture-gateway-key', throws: true },
  { name: 'explicit llm', planner: 'llm', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'explicit jev alias', planner: 'jev', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'explicit on alias', planner: 'on', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'trimmed uppercase jev alias', planner: ' JEV ', gatewayKey: undefined, expected: 'llm' },
]

const originalPlanner = process.env.BUDDY_PLANNER
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY

function restore(name: 'BUDDY_PLANNER' | 'AI_GATEWAY_API_KEY', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

let failures = 0
process.stdout.write('planner authority-mode fixture (#226)\n')
process.stdout.write('-'.repeat(72) + '\n')
try {
  for (const testCase of cases) {
    if (testCase.planner === undefined) delete process.env.BUDDY_PLANNER
    else process.env.BUDDY_PLANNER = testCase.planner
    if (testCase.gatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = testCase.gatewayKey

    let actual: PlannerMode | null = null
    let thrown: unknown = null
    try {
      actual = resolvePlannerMode()
    } catch (error) {
      thrown = error
    }

    const pass = testCase.throws === true ? thrown instanceof Error : thrown === null && actual === testCase.expected
    if (!pass) failures += 1
    const observed = thrown instanceof Error ? `THREW ${thrown.message}` : String(actual)
    process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${testCase.name} -> ${observed}\n`)
  }
} finally {
  restore('BUDDY_PLANNER', originalPlanner)
  restore('AI_GATEWAY_API_KEY', originalGatewayKey)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} planner-mode cases passed\n`)
if (failures > 0) process.exit(1)
