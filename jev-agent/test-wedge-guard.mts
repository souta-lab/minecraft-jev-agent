// test-wedge-guard.mts - #11 v2 §7: a repeat is only a wedge at an event
// boundary. The live blocker on main 8d4b256 aborted a slow explore/ascend route
// every ~25 ticks because the guard counted raw ticks, so no route could finish.
// These cases pin the three facts that must ALL hold before incrementing, the
// bounded genuine wedge, the live y=11 needs_ascend exploration shape, and the
// mirrored WEDGE_SUPPRESSED marker.
//
// Run: npm run wedge-guard-test
import {
  evaluateWedgeRepeat,
  formatWedgeAbort,
  formatWedgeSuppressed,
  MIRRORED_MARKERS,
} from './src/controller.ts'
import type { WedgeRepeatDecision, WedgeSuppressReason } from './src/controller.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const LIVE_LIMIT = 24

/** The live shape: bot at y=11, remembered logs at y~65, route needs_ascend. */
function liveFingerprint(y: number): string {
  return `fp1|pos=39,${y},32|inv=birch_planks=2,stick=2,cobblestone=170|stations=|furnaces=|goal=collect:log:1`
}

function step(
  state: { id: string | null; fingerprint: string | null; repeats: number },
  tick: { actionId: string; fingerprint: string; inFlight: boolean; progressed?: boolean },
): WedgeRepeatDecision {
  const decision = evaluateWedgeRepeat({
    actionId: tick.actionId,
    previousActionId: state.id,
    fingerprint: tick.fingerprint,
    previousFingerprint: state.fingerprint,
    inFlight: tick.inFlight,
    progressed: tick.progressed ?? false,
    repeats: state.repeats,
  })
  state.id = tick.actionId
  state.fingerprint = tick.fingerprint
  state.repeats = decision.repeats
  return decision
}

addCase('same id + unchanged fingerprint + no flight increments the counter', () => {
  const decision = evaluateWedgeRepeat({
    actionId: 'WAIT',
    previousActionId: 'WAIT',
    fingerprint: liveFingerprint(11),
    previousFingerprint: liveFingerprint(11),
    inFlight: false,
    progressed: false,
    repeats: LIVE_LIMIT,
  })
  const pass = decision.outcome === 'count' && decision.repeats === LIVE_LIMIT + 1 && decision.reason === null
  return { pass, detail: JSON.stringify(decision) }
})

addCase('an in-flight action suppresses the repeat: no increment, no abort', () => {
  const decision = evaluateWedgeRepeat({
    actionId: 'WAIT',
    previousActionId: 'WAIT',
    fingerprint: liveFingerprint(11),
    previousFingerprint: liveFingerprint(11),
    inFlight: true,
    progressed: false,
    repeats: LIVE_LIMIT,
  })
  const pass = decision.outcome === 'suppress' && decision.reason === 'in_flight' && decision.repeats === 0
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a changed semantic fingerprint suppresses the repeat', () => {
  const decision = evaluateWedgeRepeat({
    actionId: 'WAIT',
    previousActionId: 'WAIT',
    fingerprint: liveFingerprint(12),
    previousFingerprint: liveFingerprint(11),
    inFlight: false,
    progressed: false,
    repeats: LIVE_LIMIT,
  })
  const pass = decision.outcome === 'suppress' && decision.reason === 'fingerprint_changed' && decision.repeats === 0
  return { pass, detail: JSON.stringify(decision) }
})

addCase('verified progress suppresses the repeat with reason=progressing', () => {
  const decision = evaluateWedgeRepeat({
    actionId: 'WAIT',
    previousActionId: 'WAIT',
    fingerprint: liveFingerprint(11),
    previousFingerprint: liveFingerprint(11),
    inFlight: false,
    progressed: true,
    repeats: LIVE_LIMIT,
  })
  const pass = decision.outcome === 'suppress' && decision.reason === 'progressing' && decision.repeats === 0
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a different candidate restarts the window at one', () => {
  const decision = evaluateWedgeRepeat({
    actionId: 'MOVE:explore:log:39_12_33',
    previousActionId: 'WAIT',
    fingerprint: liveFingerprint(11),
    previousFingerprint: liveFingerprint(11),
    inFlight: false,
    progressed: false,
    repeats: LIVE_LIMIT,
  })
  const pass =
    decision.outcome === 'count' && decision.restarted === true && decision.repeats === 1 && decision.reason === null
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a genuinely frozen no-op still aborts at the configured limit', () => {
  const state = { id: 'WAIT' as string | null, fingerprint: liveFingerprint(11) as string | null, repeats: 0 }
  let abortAt = -1
  let abortLine = ''
  for (let tick = 1; tick <= 40; tick += 1) {
    const decision = step(state, { actionId: 'WAIT', fingerprint: liveFingerprint(11), inFlight: false })
    if (decision.outcome === 'count' && decision.repeats > LIVE_LIMIT) {
      abortAt = tick
      abortLine = formatWedgeAbort('WAIT', decision.repeats, LIVE_LIMIT)
      break
    }
  }
  const pass = abortAt === LIVE_LIMIT + 1 && abortLine === 'action id WAIT chosen 25x with no verified progress (limit 24)'
  return { pass, detail: `abortAt=${abortAt} line="${abortLine}"` }
})

addCase('the live shape never aborts and mirrors both suppression reasons at the boundary', () => {
  const state = { id: null as string | null, fingerprint: null as string | null, repeats: 0 }
  const suppressed: string[] = []
  let aborts = 0
  for (let tick = 1; tick <= 60; tick += 1) {
    // Remembered log at y~65 needs an ascent. Ticks 1..24: the route is frozen
    // while the guard window fills. Tick 25: the ascent moves the fingerprint.
    // Ticks 26..49: frozen again at the new y. Tick 50: the explore move takes
    // the body while the ascent moves on.
    let y = 11
    let inFlight = false
    if (tick === 25) y = 12
    if (tick >= 26) y = 12
    if (tick === 50) {
      y = 13
      inFlight = true
    }
    if (tick > 50) y = 13 + (tick - 50)
    const previousRepeats = state.repeats
    const decision = step(state, { actionId: 'WAIT', fingerprint: liveFingerprint(y), inFlight })
    if (decision.outcome === 'count' && decision.repeats > LIVE_LIMIT) aborts += 1
    if (decision.outcome === 'suppress' && previousRepeats >= LIVE_LIMIT) {
      const reason: WedgeSuppressReason = decision.reason ?? 'progressing'
      suppressed.push(formatWedgeSuppressed(reason, 'WAIT', previousRepeats))
    }
  }
  const expected = [
    'WEDGE_SUPPRESSED reason=fingerprint_changed candidate=WAIT repeats=24',
    'WEDGE_SUPPRESSED reason=in_flight candidate=WAIT repeats=24',
  ]
  const pass = aborts === 0 && suppressed.length === 2 && suppressed[0] === expected[0] && suppressed[1] === expected[1]
  return {
    pass,
    detail: `aborts=${aborts} suppressed=${JSON.stringify(suppressed)}`,
  }
})

addCase('the mirrored marker names every suppression reason', () => {
  const lines = {
    progressing: formatWedgeSuppressed('progressing', 'WAIT', 24),
    in_flight: formatWedgeSuppressed('in_flight', 'WAIT', 24),
    fingerprint_changed: formatWedgeSuppressed('fingerprint_changed', 'RETRIEVE:known:log:b27_65_19', 24),
  }
  const pass =
    lines.progressing === 'WEDGE_SUPPRESSED reason=progressing candidate=WAIT repeats=24' &&
    lines.in_flight === 'WEDGE_SUPPRESSED reason=in_flight candidate=WAIT repeats=24' &&
    lines.fingerprint_changed ===
      'WEDGE_SUPPRESSED reason=fingerprint_changed candidate=RETRIEVE:known:log:b27_65_19 repeats=24' &&
    MIRRORED_MARKERS.has('WEDGE_SUPPRESSED')
  return { pass, detail: `mirrored=${MIRRORED_MARKERS.has('WEDGE_SUPPRESSED')} ${JSON.stringify(lines)}` }
})

let failures = 0
process.stdout.write('wedge guard - event-boundary semantics (#11 v2 §7)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} wedge guard cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
