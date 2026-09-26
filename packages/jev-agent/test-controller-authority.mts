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
const legacy =
  source('./src/controller.ts') +
  source('./src/system2-plane.ts') +
  source('./src/abandon-lifecycle.ts').replace(/\bhost\./g, 'this.')
const candidates = source('./src/candidates.ts')

assert.match(facade, /export class JevController/)
assert.match(facade, /semantic authority=jev_pi/)
assert.match(facade, /return \[\.\.\.candidates\]/)
assert.match(facade, /authority=jev_pi_beta/)
// #360 §11: semantic termination still has one owner. The controller may adopt
// beta's vote, or a code-owned state-recurrence exhaustion proof; it must not
// introduce any other termination source (attempt counts, protection ladder,
// deterministic ranking). The exhaustion proof itself is read from the
// code-owned evidence block, never recomputed here.
assert.match(facade, /const semanticExhausted = this\.signals\.strategicNonProgress\?\.exhausted === true/)
assert.match(facade, /const adopt = \(abandonRequested\(decision\) \|\| semanticExhausted\) && boundary\.adopt/)
assert.match(facade, /if \(optionId === null\) return baseline/)
assert.match(facade, /betaTerminationBoundary/)
assert.match(facade, /BETA_DEFERRED option=/)
// No shadow/authority fork may survive: the beta vote gate is the only
// prerequisite-protection site, so a queue-level replan veto (and the
// realJevPolicy/betaAuthority switches that armed it) must be gone.
for (const forbidden of ['betaAuthoritative(', 'realJevPolicy(', 'protectedReplanSuppressed', 'options.betaAuthority', 'resolveBetaAuthority', 'BUDDY_BETA_AUTHORITY', 'BUDDY_PREREQ_RANK_POLICY', 'prereqRankPolicy']) {
  assert.ok(!facade.includes(forbidden) && !legacy.includes(forbidden), `pre-V4.1.2 semantic selector survived: ${forbidden}`)
}

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

// The deterministic mechanics that remain must still be on the decision path:
// prerequisite enumeration, selection over the abandoned set, stall evidence,
// and the unproductive-abandon classifier.
assert.ok(legacy.includes('planPrereqOptions(input)'))
assert.ok(legacy.includes('selectPrereqPath(decision, abandoned)'))
assert.ok(legacy.includes('evaluatePrereqStall({'))
assert.ok(legacy.includes('classifyAbandonRequest({'))

// Candidate generation itself must enumerate every feasible prerequisite path;
// the Jev facade can only be authoritative if those alternatives survive to pi.
assert.ok(candidates.includes('for (const option of decision.options)'))
assert.ok(candidates.includes('if (!option.feasible) continue'))
assert.ok(candidates.includes('prereqPath: option.path'))

process.stdout.write('#11 controller authority boundary: PASS\n')
