// test-policy-kind.mts - the DescendAwarePolicy wrapper must report the wrapped
// policy's kind instead of a hardcoded 'fallback'. JevController.policyKind is
// read straight off this wrapper (controller.ts:1408), and agent-runner.mts:1573
// selects 'llm' vs 'deterministic' from that value, so a wrong kind silently
// degrades the acceptance mode even while the real typesafe (Jev) policy runs.
// Pure: no bot, no network, no live host.
import type { JevPolicy, JevRequest, JevResult } from '../jev-agent/src/jev.ts'
import { DescendAwarePolicy } from './system-one-policy.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** Minimal inner policy: only `kind`/`model` matter for these assertions. */
function stubPolicy(kind: JevPolicy['kind']): JevPolicy {
  return {
    kind,
    model: `${kind}-stub`,
    decide(_request: JevRequest): Promise<JevResult> {
      return Promise.reject(new Error('stub decide must not be called'))
    },
  }
}

addCase('DescendAwarePolicy.kind delegates to a wrapped typesafe policy', () => {
  const inner = stubPolicy('typesafe')
  const wrapper = new DescendAwarePolicy(inner, [], () => {})
  const pass = wrapper.kind === inner.kind && wrapper.kind === 'typesafe'
  return { pass, detail: `wrapper.kind=${wrapper.kind} inner.kind=${inner.kind}` }
})

addCase('DescendAwarePolicy.kind delegates to a wrapped fallback policy', () => {
  const inner = stubPolicy('fallback')
  const wrapper = new DescendAwarePolicy(inner, [], () => {})
  const pass = wrapper.kind === inner.kind && wrapper.kind === 'fallback'
  return { pass, detail: `wrapper.kind=${wrapper.kind} inner.kind=${inner.kind}` }
})

let failures = 0
process.stdout.write('descend-aware policy kind delegation\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} policy-kind cases passed\n`)
if (failures > 0) process.exit(1)
