// test-planner-mode.mts - Issue #4: planner mode is fail-closed.
import { resolvePlannerMode } from './planner.ts'

type PlannerMode = ReturnType<typeof resolvePlannerMode>

interface Case {
  name: string
  planner: string | undefined
  gatewayKey: string | undefined
  expected: PlannerMode
}

const cases: Case[] = [
  { name: 'unset with gateway key', planner: undefined, gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'unset without gateway key', planner: undefined, gatewayKey: undefined, expected: 'deterministic' },
  { name: 'auto with gateway key', planner: 'auto', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'empty with gateway key', planner: '', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'explicit deterministic', planner: 'deterministic', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'off alias', planner: 'off', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'fallback alias', planner: 'fallback', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'none alias', planner: 'none', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'unknown value with gateway key', planner: 'typo', gatewayKey: 'fixture-gateway-key', expected: 'deterministic' },
  { name: 'explicit llm opt-in', planner: 'llm', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'explicit jev opt-in', planner: 'jev', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'explicit on opt-in', planner: 'on', gatewayKey: 'fixture-gateway-key', expected: 'llm' },
  { name: 'trimmed uppercase jev opt-in', planner: ' JEV ', gatewayKey: undefined, expected: 'llm' },
]

const originalPlanner = process.env.BUDDY_PLANNER
const originalGatewayKey = process.env.AI_GATEWAY_API_KEY

function restore(name: 'BUDDY_PLANNER' | 'AI_GATEWAY_API_KEY', value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

let failures = 0
process.stdout.write('planner mode fail-closed fixture (#4)\n')
process.stdout.write('-'.repeat(72) + '\n')
try {
  for (const testCase of cases) {
    if (testCase.planner === undefined) delete process.env.BUDDY_PLANNER
    else process.env.BUDDY_PLANNER = testCase.planner
    if (testCase.gatewayKey === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = testCase.gatewayKey

    const actual = resolvePlannerMode()
    const pass = actual === testCase.expected
    if (!pass) failures += 1
    process.stdout.write((pass ? 'PASS' : 'FAIL') + '  ' + testCase.name + ' -> ' + actual + '\n')
  }
} finally {
  restore('BUDDY_PLANNER', originalPlanner)
  restore('AI_GATEWAY_API_KEY', originalGatewayKey)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write((cases.length - failures) + '/' + cases.length + ' planner-mode cases passed\n')
if (failures > 0) process.exit(1)
