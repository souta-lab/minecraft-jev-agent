// test-ai-authority-overhaul.mts - architectural swap-point invariants.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JsonlWriter,
  PRIMARY_INSTRUCTIONS,
  createJevPolicy,
} from '../jev-agent/src/jev.ts'
import * as jevModule from '../jev-agent/src/jev.ts'
import { FatalModelError } from '../jev-agent/src/modelFailure.ts'
import { resolvePlannerMode } from './planner.ts'

assert.equal(resolvePlannerMode({}), 'llm', 'System2 model authority must be the default')
assert.equal(resolvePlannerMode({ BUDDY_PLANNER: 'auto' }), 'llm')
assert.equal(resolvePlannerMode({ BUDDY_PLANNER: 'deterministic' }), 'deterministic')
assert.equal(resolvePlannerMode({ BUDDY_PLANNER: 'local-mercury' }), 'local-mercury')
assert.throws(() => resolvePlannerMode({ BUDDY_PLANNER: 'typo' }))

// Jev beta owns WHETHER by default; there is no shadow/authority selector.
assert.ok(!('resolveBetaAuthority' in jevModule), 'BUDDY_BETA_AUTHORITY selector must not exist')
assert.ok(
  !readFileSync(new URL('../jev-agent/src/jev.ts', import.meta.url), 'utf8').includes('BUDDY_BETA_AUTHORITY'),
  'jev.ts must not read BUDDY_BETA_AUTHORITY',
)

const prompt = PRIMARY_INSTRUCTIONS.toLowerCase()
assert.ok(!prompt.includes('prefer an id with no recorded failures'))
assert.ok(!prompt.includes('while plan_still_valid is high'))
assert.match(prompt, /evidence/)
assert.match(prompt, /not universal ranking/)

const dir = mkdtempSync(join(tmpdir(), 'ai-authority-overhaul-'))
const writer = new JsonlWriter(join(dir, 'jev.jsonl'))
assert.throws(
  () => createJevPolicy({
    writer,
    model: null,
    timeoutMs: 100,
    maxRetries: 0,
    rateLimitRetries: 0,
    rateLimitBaseDelayMs: 1,
    forceFallback: false,
    resolveKey: () => null,
  }),
  FatalModelError,
  'missing Jev model credentials must fail loudly instead of selecting deterministic policy',
)

const fallback = createJevPolicy({
  writer,
  model: null,
  timeoutMs: 100,
  maxRetries: 0,
  rateLimitRetries: 0,
  rateLimitBaseDelayMs: 1,
  forceFallback: true,
  resolveKey: () => null,
})
assert.equal(fallback.kind, 'fallback', 'deterministic Jev remains explicit-only')

process.stdout.write('AI authority overhaul swap points: PASS\n')
