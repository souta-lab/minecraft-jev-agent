// #395: the acceptance artifact must name the run's source identity, not the live
// checkout. This pins the pure decision behind `writeAcceptance`.
import { acceptanceProvenance } from './acceptance-provenance.ts'

const cases: Array<{ name: string; pass: boolean; detail: string }> = []
const addCase = (name: string, run: () => { pass: boolean; detail: string }): void => {
  try {
    cases.push({ name, ...run() })
  } catch (error) {
    cases.push({ name, pass: false, detail: `threw ${String(error).slice(0, 120)}` })
  }
}

addCase('(a) a captured boot commit wins over a moved checkout', () => {
  const p = acceptanceProvenance('boot-commit', 'checkout-moved-on')
  return {
    pass: p.gitCommit === 'boot-commit' && p.checkoutHead === 'checkout-moved-on',
    detail: `gitCommit=${p.gitCommit} checkoutHead=${p.checkoutHead}`,
  }
})

addCase('(b) without a boot identity the checkout is used and labelled', () => {
  const p = acceptanceProvenance(null, 'checkout-only')
  return {
    pass: p.gitCommit === 'checkout-only' && p.checkoutHead === 'checkout-only',
    detail: `gitCommit=${p.gitCommit} checkoutHead=${p.checkoutHead}`,
  }
})

addCase('(c) an empty boot string never masquerades as a source', () => {
  const p = acceptanceProvenance('', 'checkout-fallback')
  return {
    pass: p.gitCommit === 'checkout-fallback' && p.checkoutHead === 'checkout-fallback',
    detail: `gitCommit=${p.gitCommit}`,
  }
})

addCase('(d) the two facts stay distinguishable when they differ', () => {
  const p = acceptanceProvenance('aaaaaaaa', 'bbbbbbbb')
  return {
    pass: p.gitCommit !== p.checkoutHead && p.gitCommit === 'aaaaaaaa',
    detail: `source=${p.gitCommit} checkout=${p.checkoutHead}`,
  }
})

let failed = 0
for (const testCase of cases) {
  if (!testCase.pass) failed += 1
  console.log(`${testCase.pass ? 'PASS' : 'FAIL'} ${testCase.name} :: ${testCase.detail}`)
}
console.log(`\n${cases.length - failed}/${cases.length} acceptance-provenance cases passed`)
if (failed > 0) process.exit(1)
