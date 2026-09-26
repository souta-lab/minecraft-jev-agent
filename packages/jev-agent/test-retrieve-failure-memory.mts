// test-retrieve-failure-memory.mts - CONTROLLER-level residual regression.
//
// Live evidence (RC8, run-mu8ue5dg-10amk): a remembered station was re-offered
// forever because a known RETRIEVE that only closed part of the distance (or
// made a bounded vertical chunk) was recorded as a completed success:
//
//   RETRIEVE:known:station:furnace ... done/retrieved progressed
//     targetDistance=21.34m->21.44m
//     targetDistance=21.69m->20.42m
//     targetDistance=20.72m->21.49m
//
// ... no station arrival, yet `MOVE_FAILMEM_RESET` fired and the per-resource
// retirement counter was cleared on every attempt, so the same unreachable
// station was re-offered in a loop.
//
// #224 fixed the EXECUTOR classification (a progressed-only RETRIEVE is now
// `verified:false status:unreached observableProgress:false
// resetsFailureMemory:false`). This suite covers the remaining CONTROLLER path:
// the `onActionComplete` retrieval branch and `retireFailedKnownRetrieve` still
// charged success whenever `truth.observableProgress` / `result.progressed` was
// true, even when `shouldClearActiveRetrieval({ known, arrived:false })` was
// false.
//
// Invariants proven here, all pure (no bot, no network, no model):
//   A. a known RETRIEVE that only closed partial distance (or a vertical chunk)
//      must NOT reset coordinate failure memory;
//   B. it must NOT clear the per-resource retirement counter - it must be
//      CHARGED, and repeated partials must eventually retire the target;
//   C. a real arrival OR an acquired item DOES reset/clear exactly as before.
//
// Run: bun --test test-retrieve-failure-memory.mts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  decideKnownRetrieve,
  decideRetrieveMemory,
  knownRetrieveMadeProgress,
  shouldClearActiveRetrieval,
} from './src/controller.ts'
import { truthfulActionOutcome } from './src/actionPostcondition.ts'
import { MoveFailMemory, moveFailureKey } from './src/moveFailMemory.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const OVERWORLD = 'overworld'
/** A remembered station coordinate, far beyond RETRIEVE_ARRIVAL_RADIUS (2). */
const STATION = { x: 36, y: 56, z: 41 }

interface Result {
  status: 'done' | 'failed'
  verified: boolean
  itemsGained: number
  blockRemoved: boolean
  progressed: boolean
}

/**
 * RC8 `21.69m->20.42m` with `vertical=reuse`: a measured feet-distance closure
 * (so the executor reports `verified=true`) that also reports a durable body
 * change. Still 20.42 m from the station: NOT an arrival.
 */
const RC8_CLOSURE: Result = { status: 'done', verified: true, itemsGained: 0, blockRemoved: false, progressed: true }

/** A pure partial closure with no body-change flag. */
const PARTIAL_CLOSURE: Result = { status: 'done', verified: true, itemsGained: 0, blockRemoved: false, progressed: false }

/** RC8 `21.34m->21.44m` / `20.72m->21.49m`: a bounded vertical chunk, no closure. */
const RC8_CHUNK: Result = { status: 'done', verified: false, itemsGained: 0, blockRemoved: false, progressed: true }

/** A real arrival at the remembered station. */
const ARRIVAL: Result = { status: 'done', verified: true, itemsGained: 0, blockRemoved: false, progressed: true }

/** The item was acquired (the retrieve did its job even before touching the cell). */
const ACQUIRED: Result = { status: 'done', verified: true, itemsGained: 1, blockRemoved: false, progressed: false }

function known(previousAttempts: number, result: Result, completed?: boolean) {
  return decideKnownRetrieve({
    retrieval: 'known',
    target: STATION,
    result,
    previousAttempts,
    ...(completed === undefined ? {} : { completed }),
  })
}

// --- B. the retirement counter must be CHARGED for partial chunks ---------------

addCase('B: a partial closure with a body-change flag does NOT clear the retirement counter', () => {
  const decision = known(0, RC8_CLOSURE, false)
  const legacy = knownRetrieveMadeProgress(RC8_CLOSURE)
  const pass = decision.kind === 'charge' && decision.attempts === 1 && legacy === true
  return { pass, detail: `decision=${decision.kind}${'attempts' in decision ? `:${decision.attempts}` : ''} legacyObservable=${legacy}` }
})

addCase('B: a pure partial closure does NOT clear the retirement counter', () => {
  const decision = known(0, PARTIAL_CLOSURE, false)
  const pass = decision.kind === 'charge' && decision.attempts === 1
  return { pass, detail: `decision=${decision.kind}${'attempts' in decision ? `:${decision.attempts}` : ''}` }
})

addCase('B: RC8 repeated partial closures retire the station instead of looping', () => {
  // Drive the controller boundary exactly as `retireFailedKnownRetrieve` does:
  // every attempt reports `completed=false` (no arrival, no acquisition).
  let attempts = 0
  let retiredOn = -1
  let clears = 0
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const decision = known(attempts, cycle === 2 ? PARTIAL_CLOSURE : RC8_CLOSURE, false)
    if (decision.kind === 'clear') clears += 1
    if (decision.kind === 'charge' || decision.kind === 'retire') attempts = decision.attempts
    if (decision.kind === 'retire') {
      retiredOn = cycle
      break
    }
  }
  const pass = clears === 0 && retiredOn === 2 && attempts === 2
  return { pass, detail: `clears=${clears} retiredOnCycle=${retiredOn > 0 ? retiredOn : 'never'} attempts=${attempts}` }
})

addCase('B: the RC8 chunk (no closure) is charged by the retirement counter', () => {
  const decision = known(0, RC8_CHUNK, false)
  const pass = decision.kind === 'charge' && decision.attempts === 1
  return { pass, detail: `decision=${decision.kind}${'attempts' in decision ? `:${decision.attempts}` : ''}` }
})

// --- A. the coordinate failure memory must NOT reset on a partial chunk ----------

addCase('A: a known retrieve that progressed but did NOT arrive does not reset the coordinate', () => {
  const clear = shouldClearActiveRetrieval({ retrieval: 'known', hasObservableProgress: true, arrived: false })
  const memory = decideRetrieveMemory(RC8_CLOSURE, false)
  const pass = clear === false && memory.reset === false
  return { pass, detail: `shouldClear=${clear} reset=${memory.reset} charge=${memory.charge}` }
})

addCase('A: the truth layer still marks the partial closure resettable, so the controller gate is what must hold', () => {
  const truth = truthfulActionOutcome({
    kind: 'RETRIEVE',
    status: 'done',
    verified: true,
    itemsGained: 0,
    blockRemoved: false,
    progressed: true,
    arrived: false,
    distanceClosed: true,
  })
  const clear = shouldClearActiveRetrieval({ retrieval: 'known', hasObservableProgress: true, arrived: false })
  const pass = truth.resetsFailureMemory === true && clear === false
  return { pass, detail: `resetsFailureMemory=${truth.resetsFailureMemory} shouldClear=${clear}` }
})

addCase('A: repeated partial retrieves never reset a pre-existing coordinate failure', () => {
  let clock = 1_000
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => clock })
  memory.record(OVERWORLD, STATION, 'no_progress')
  const before = memory.check(OVERWORLD, STATION).attempts
  let resets = 0
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const decision = decideRetrieveMemory(attempt === 2 ? PARTIAL_CLOSURE : RC8_CLOSURE, false)
    if (decision.reset) {
      resets += 1
      memory.reset(OVERWORLD, STATION)
    } else if (decision.charge) {
      memory.record(OVERWORLD, STATION, 'no_progress')
    }
    clock += 1
  }
  const after = memory.check(OVERWORLD, STATION)
  const pass = resets === 0 && after.attempts === before && after.known === true
  return { pass, detail: `key=${moveFailureKey(OVERWORLD, STATION)} resets=${resets} before=${before} after=${after.attempts}` }
})

// --- C. a real arrival or an acquired item DOES reset/clear ----------------------

addCase('C: a real arrival clears the retirement counter', () => {
  const decision = known(1, ARRIVAL, true)
  const pass = decision.kind === 'clear'
  return { pass, detail: `decision=${decision.kind}` }
})

addCase('C: an acquired item clears the retirement counter even before arrival', () => {
  const decision = known(1, ACQUIRED, true)
  const pass = decision.kind === 'clear'
  return { pass, detail: `decision=${decision.kind}` }
})

addCase('C: a real arrival resets the coordinate failure memory', () => {
  const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 30_000, maxEntries: 16, now: () => 1_000 })
  memory.record(OVERWORLD, STATION, 'no_progress')
  memory.record(OVERWORLD, STATION, 'no_progress')
  const decision = decideRetrieveMemory(ARRIVAL, true)
  if (decision.reset) memory.reset(OVERWORLD, STATION)
  const check = memory.check(OVERWORLD, STATION)
  const pass = decision.reset === true && check.known === false
  return { pass, detail: `reset=${decision.reset} known=${check.known}` }
})

// --- the wiring: the controller must gate on the same completion decision --------

addCase('wiring: the RETRIEVE branch gates success on the completion decision, not truth.observableProgress', () => {
  // The #11 facade delegates the mechanical VERIFY branch to the legacy loop;
  // inspect both files so the wiring assertion follows the actual runtime path.
  const source =
    readFileSync(fileURLToPath(new URL('./src/controller.ts', import.meta.url)), 'utf8') +
    readFileSync(fileURLToPath(new URL('./src/controller-legacy.ts', import.meta.url)), 'utf8') +
    readFileSync(fileURLToPath(new URL('./src/outcome-accounting.ts', import.meta.url)), 'utf8')
  const usesCompletion = source.includes('retrieveCompleted(')
  const usesMemoryDecision = source.includes('decideRetrieveMemory(result,')
  const stillUnconditional = /if \(truth\.resetsFailureMemory\) \{\s*if \([\s\S]{0,400}?this\.noteCandidateSuccess\(result\.actionId\)/.test(source)
  const pass = usesCompletion && usesMemoryDecision && !stillUnconditional
  return { pass, detail: `usesCompletion=${usesCompletion} usesMemoryDecision=${usesMemoryDecision} unconditionalSuccess=${stillUnconditional}` }
})

let failures = 0
process.stdout.write('known-retrieve failure memory: partial chunks neither reset nor clear\n')
process.stdout.write('-'.repeat(90) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(90) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} retrieve-failure-memory cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
