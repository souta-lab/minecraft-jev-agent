// test-source-watch.mts - quiescence gate for the hot-reload watcher.
//
// Proves a signature burst cannot schedule a reload mid-edit: the trigger
// fires only after the signature stays stable for the full quiescence window,
// any new delta resets the window, the first observed signature is baseline,
// and a fired gate re-arms on the next delta.

import { initialSourceWatchState, sourceWatchPoll } from './source-watch.ts'

interface Case { name: string; pass: boolean; detail: string }
const cases: Case[] = []
const push = (name: string, pass: boolean, detail: string): void => { cases.push({ name, pass, detail }) }

const Q = 8

{
  const st = initialSourceWatchState()
  const t1 = sourceWatchPoll('aaa', st, Q)
  const t2 = sourceWatchPoll('aaa', st, Q)
  push('first signature is baseline, never a trigger', t1 === null && t2 === null, `t1=${t1} t2=${t2}`)
}

{
  const st = initialSourceWatchState()
  sourceWatchPoll('aaa', st, Q)
  sourceWatchPoll('bbb', st, Q)
  const fired: string[] = []
  for (let i = 0; i < Q - 1; i++) { const t = sourceWatchPoll('bbb', st, Q); if (t !== null) fired.push(t) }
  const tFinal = sourceWatchPoll('bbb', st, Q)
  push('stable signature fires exactly at the quiescence boundary', fired.length === 0 && tFinal === 'source-changed', `early=${fired.length} final=${tFinal}`)
}

{
  const st = initialSourceWatchState()
  sourceWatchPoll('aaa', st, Q)
  sourceWatchPoll('bbb', st, Q)
  for (let i = 0; i < Q - 1; i++) sourceWatchPoll('bbb', st, Q)
  // Mid-window delta: the pending trigger must re-arm, not fire.
  const tDelta = sourceWatchPoll('ccc', st, Q)
  let fired = 0
  for (let i = 0; i < Q - 1; i++) if (sourceWatchPoll('ccc', st, Q) !== null) fired++
  push('mid-window delta re-arms; no early fire', tDelta === null && fired === 0, `tDelta=${tDelta} fired=${fired}`)
}

{
  const st = initialSourceWatchState()
  sourceWatchPoll('aaa', st, Q)
  sourceWatchPoll('bbb', st, Q)
  let t1: string | null = null
  for (let i = 0; i < Q && t1 === null; i++) t1 = sourceWatchPoll('bbb', st, Q)
  // After firing, a stable signature must not re-fire; the next delta re-arms.
  const t2 = sourceWatchPoll('bbb', st, Q)
  sourceWatchPoll('ccc', st, Q)
  let t3: string | null = null
  for (let i = 0; i < Q && t3 === null; i++) t3 = sourceWatchPoll('ccc', st, Q)
  push('fired gate stays quiet until a new delta, then re-arms', t1 === 'source-changed' && t2 === null && t3 === 'source-changed', `t1=${t1} t2=${t2} t3=${t3}`)
}

let failed = 0
for (const c of cases) {
  if (!c.pass) { failed++; console.log(`FAIL ${c.name} (${c.detail})`) } else { console.log(`PASS ${c.name}`) }
}
console.log(`${cases.length - failed}/${cases.length} cases passed`)
process.exit(failed === 0 ? 0 : 1)
