// test-jev-prompt-authority.mts - #226 prompt-boundary regression.
//
// Failure history and System2 state are facts for Jev. The prompt must not turn
// them into hand-authored semantic ranking rules, and it must not steer on heads
// that are no longer sent to the model.
import assert from 'node:assert/strict'
import { PRIMARY_INSTRUCTIONS, SHADOW_QUESTION_NAMES, QUESTION_NAMES } from '../jev-agent/src/jev.ts'

const prompt = PRIMARY_INSTRUCTIONS.toLowerCase()

assert.ok(
  !prompt.includes('prefer an id with no recorded failures'),
  'failure history must be presented as evidence, not a universal prefer-no-failures ranking',
)
assert.ok(
  !prompt.includes('while plan_still_valid is high'),
  'prompt must not steer on plan_still_valid after that head was demoted to shadow-only',
)
assert.ok(SHADOW_QUESTION_NAMES.includes('plan_still_valid'))
assert.ok(!QUESTION_NAMES.includes('plan_still_valid' as never))
assert.match(prompt, /choose exactly one id/)
assert.match(prompt, /never invent an id/)

process.stdout.write('jev prompt authority: PASS\n')
