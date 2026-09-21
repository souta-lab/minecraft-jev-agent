// test-controller-authority.mts - #11 semantic authority boundary regression.
//
// This is intentionally architectural. The live controller facade must expose
// every mechanically-feasible furnace prerequisite alternative to real Jev and
// must not re-introduce a second rank/retry/termination controller at the
// composition root.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

const facade = source('./src/controller.ts')
const legacy = source('./src/controller-legacy.ts')
const candidates = source('./src/candidates.ts')

assert.match(facade, /export class JevController extends LegacyJevController/)
assert.match(facade, /semantic authority=jev_pi/)
assert.match(facade, /return \[\.\.\.candidates\]/)
assert.match(facade, /authority=jev_pi_beta/)
assert.match(facade, /const adopt = abandonRequested\(decision\)/)
assert.match(facade, /if \(!betaIsAuthoritative\(internals\)\) return baseline/)
assert.match(facade, /if \(optionId === null\) return baseline/)
assert.match(facade, /betaTerminationBoundary/)
assert.match(facade, /BETA_DEFERRED option=/)
assert.match(facade, /protectedReplanSuppressed = \(reason\)/)
assert.match(facade, /return false\s*\n\s*}/)

// The public REAL path must not contain the historical semantic selector calls.
for (const forbidden of [
  'planPrereqOptions(',
  'selectPrereqPath(',
  'preferPrereqPath(',
  'evaluatePrereqStall({',
  'nextPrereqPath(',
]) {
  assert.ok(!facade.includes(forbidden), `public controller facade must not own semantic selector ${forbidden}`)
}

// The old behavior is deliberately preserved only as an explicit fallback/A-B
// baseline, not deleted before evidence exists (#11 migration plan).
assert.ok(legacy.includes('planPrereqOptions(input)'))
assert.ok(legacy.includes('selectPrereqPath(decision, abandoned)'))
assert.ok(legacy.includes('evaluatePrereqStall({'))
assert.ok(legacy.includes('classifyAbandonRequest({'))
assert.ok(legacy.includes('protectedReplanSuppressed(reason)'))

// Candidate generation itself must enumerate every feasible prerequisite path;
// the Jev facade can only be authoritative if those alternatives survive to pi.
assert.ok(candidates.includes('for (const option of decision.options)'))
assert.ok(candidates.includes('if (!option.feasible) continue'))
assert.ok(candidates.includes('prereqPath: option.path'))

process.stdout.write('#11 controller authority boundary: PASS\n')
