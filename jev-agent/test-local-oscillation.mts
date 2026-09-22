// test-local-oscillation.mts - the durable LOCAL MOTION oscillation boundary.
//
// Live defect (`run-mucqgrdo-21plr`, 2026-09-23): the body sat at
// `(24.6,53,-10.1)` in the Nether beside the portal while the decisions cycled
// `MOVE:p25_54_-9` / `WAIT` / `MOVE:p24_53_-9` / `MOVE:p25_54_-10` / `MOVE:p25_54_-9`
// and every MOVE failed `reason=stuck`. `MOVE_FAILMEM attempts=6` and `7` on the
// same coordinate proved the 30 s coordinate blacklist had already expired twice.
// `LOCAL_PROGRESS_STALL stalledMs=91744 boundary=local_recovery` printed and
// nothing acted, because every counter that watches the stall keys on something
// the loop itself changes (the rounded position, the action id, the chosen WAIT,
// the queue head) or demands a phenotype a starved tick does not have.
//
// These cases pin the replacement facts:
//   (i)   the measured shape trips a typed boundary, and the record survives a
//         simulated generation change (the durable half);
//   (ii)  a productive walk through the same cells never trips;
//   (iii) a mining/bridging body that IS changing the world / covering new ground
//         never trips;
//   (iv)  a genuine turn-around after the boundary clears the record;
//   (v)   ordinary motion is byte-identical (no line, nothing persisted);
//   plus the measured reason the pair detector cannot see a 3-cell cycle.
//
//   bun ./test-local-oscillation.mts
import { readFileSync } from 'node:fs'
import { evaluateOscillation } from './src/oscillation.ts'
import {
  isNotableLocalOscillation,
  LOCAL_OSCILLATION_BOUNDARY_MARKER,
  LOCAL_OSCILLATION_RECENT_CELLS_DEFAULT,
  LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT,
  localOscillationCell,
  localOscillationSpan,
  observeLocalOscillation,
  requiredLocalOscillationReturns,
  restoreLocalOscillationRecord,
} from './src/localOscillation.ts'
import type { LocalOscillationRecordJson } from './src/localOscillation.ts'
import { evaluateLocalMotionBoundary } from './src/system2Escalation.ts'

let failures = 0
let cases = 0
const check = (name: string, run: () => boolean, detail: () => string): void => {
  cases += 1
  let pass = false
  let info = ''
  try {
    pass = run()
    info = detail()
  } catch (error) {
    info = `threw ${String(error)}`
  }
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${info}\n`)
}

// ---------------------------------------------------------------------------
// the measured shape
// ---------------------------------------------------------------------------
const DIMENSION = 'minecraft:the_nether'
const GOAL = 'descend:raw_iron:1'
/** the body never left this cell: `reason=stuck` on every MOVE */
const BODY_POSITION = { x: 24.6, y: 53, z: -10.1 }
const BODY_CELL = localOscillationCell(DIMENSION, BODY_POSITION)
const ATTEMPT_POSITIONS = [
  { x: 25, y: 54, z: -9 },
  { x: 24, y: 53, z: -9 },
  { x: 25, y: 54, z: -10 },
]
const ATTEMPT_CELLS = ATTEMPT_POSITIONS.map((position) => localOscillationCell(DIMENSION, position))
/** named cells (the repo typechecks tests with `noUncheckedIndexedAccess`) */
const CELL_TARGET_0 = ATTEMPT_CELLS[0] as string
const CELL_TARGET_1 = ATTEMPT_CELLS[1] as string
const CELL_TARGET_2 = ATTEMPT_CELLS[2] as string

interface Step {
  /** the cell the body stands in when the decision settles */
  body: string
  /** the destination cell of a MOVEMENT decision, or null for a control (WAIT) decision */
  attempt: string | null
  /** the body's own cell changed during this decision */
  cellChanged: boolean
  semanticProgress: boolean
  inventoryChanged: boolean
  distanceClosed: boolean
}

/** The literal measured decision cycle, minus the parts that never happened. */
function measuredSteps(count: number): Step[] {
  const shape: Array<number | null> = [0, null, 1, 2, 0, null]
  const steps: Step[] = []
  for (let index = 0; index < count; index += 1) {
    const slot = shape[index % shape.length] ?? null
    steps.push({
      body: BODY_CELL,
      attempt: slot === null ? null : (ATTEMPT_CELLS[slot] as string),
      cellChanged: false,
      semanticProgress: false,
      inventoryChanged: false,
      distanceClosed: false,
    })
  }
  return steps
}

interface RunResult {
  trips: Array<{ index: number; line: string; record: LocalOscillationRecordJson }>
  record: LocalOscillationRecordJson | null
  /** records a generation would have handed to the HOST */
  persisted: Array<LocalOscillationRecordJson | null>
  /** every line the controller would have logged */
  lines: string[]
  clearReasons: string[]
}

/**
 * Drive the tracker over a step list.
 *
 * `reloadAt` simulates a generation change: the only thing that crosses it is the
 * JSON the HOST persisted, exactly like `ResidentWorldMemory.localOscillation`
 * -> `localOscillationRecord`. `dropAt` simulates the pre-fix behaviour of a
 * controller-scoped counter, whose whole state is discarded there.
 */
function run(steps: readonly Step[], reloadAt = -1, dropAt = -1): RunResult {
  let record: LocalOscillationRecordJson | null = null
  const trips: RunResult['trips'] = []
  const persisted: RunResult['persisted'] = []
  const lines: string[] = []
  const clearReasons: string[] = []
  let persistedJson = 'null'
  const persist = (value: LocalOscillationRecordJson | null): void => {
    const json = value === null ? 'null' : JSON.stringify(value)
    if (json === persistedJson) return
    persistedJson = json
    persisted.push(value === null ? null : (JSON.parse(json) as LocalOscillationRecordJson))
  }
  for (let index = 0; index < steps.length; index += 1) {
    if (index === reloadAt) {
      // nothing controller-scoped survives; only the durable JSON does
      record = restoreLocalOscillationRecord(JSON.parse(JSON.stringify(record)))
    }
    if (index === dropAt) record = null
    const step = steps[index] as Step
    const previous = record
    const decision = observeLocalOscillation(previous, {
      bodyCell: step.body,
      attemptCell: step.attempt,
      dimension: DIMENSION,
      goal: GOAL,
      cellChanged: step.cellChanged,
      semanticProgress: step.semanticProgress,
      inventoryChanged: step.inventoryChanged,
      distanceClosed: step.distanceClosed,
      now: 1_000 + index * 1_350,
    })
    record = decision.record
    if (decision.cleared !== null) {
      clearReasons.push(decision.cleared)
      if (isNotableLocalOscillation(previous)) persist(null)
    } else if (isNotableLocalOscillation(decision.record)) {
      persist(decision.record)
    }
    if (decision.exhausted && decision.line !== null) {
      lines.push(decision.line)
      trips.push({ index, line: decision.line, record: decision.record as LocalOscillationRecordJson })
    }
  }
  return { trips, record, persisted, lines, clearReasons }
}

// ---------------------------------------------------------------------------
// (i) the measured shape
// ---------------------------------------------------------------------------
check(
  '(i) the measured 3-cell stuck loop trips the typed boundary once',
  () => {
    const result = run(measuredSteps(60))
    const first = result.trips[0]
    return (
      result.trips.length >= 1 &&
      first !== undefined &&
      first.line.startsWith(`${LOCAL_OSCILLATION_BOUNDARY_MARKER} `) &&
      first.record.returns === LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT &&
      first.record.trips === 1
    )
  },
  () => JSON.stringify({ trips: run(measuredSteps(60)).trips.map((trip) => trip.index) }),
)

check(
  '(i) the boundary line names the cells, the span, the elapsed time and what was unchanged',
  () => {
    const line = run(measuredSteps(60)).trips[0]?.line ?? ''
    const cells = ['24,53,-11', '25,54,-9', '24,53,-9', '25,54,-10'] as const
    return (
      cells.every((cell) => line.includes(cell)) &&
      line.includes(`count=${cells.length}/${LOCAL_OSCILLATION_RECENT_CELLS_DEFAULT}`) &&
      / returns=\d+\/\d+ /.test(line) &&
      / span=\d+(\.\d+)?m /.test(line) &&
      / elapsedMs=\d+ /.test(line) &&
      line.includes(' cellChanges=0 ') &&
      line.includes(`goal="${GOAL}"`) &&
      line.includes('unchanged=inventory,blocks,cell_set') &&
      line.endsWith('-> wake System2')
    )
  },
  () => run(measuredSteps(60)).trips[0]?.line ?? 'no trip',
)

check(
  '(i) the trip is bounded, not a per-tick repeat (the return window grows per trip)',
  () => {
    const result = run(measuredSteps(60))
    const bumps: number[] = []
    for (const trip of result.trips) bumps.push(trip.record.returns)
    return (
      result.trips.length <= 3 &&
      bumps.every((returns, index) => returns === LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT * 2 ** index)
    )
  },
  () => JSON.stringify(run(measuredSteps(60)).trips.map((trip) => trip.record.returns)),
)

check(
  '(i) COMPLEMENT: a successful-hop pacing loop trips even though a productive MOVE is offered every tick',
  () => {
    // The durable queue-head bound counts only decisions that present NO
    // productive candidate (`actionable === 0`). This body always has a real MOVE
    // and still makes no progress, so no head-scoped counter can see it: the
    // BODY's cell envelope is the only place the loop exists.
    const steps: Step[] = []
    for (let index = 0; index < 40; index += 1) {
      const cell = index % 2 === 0 ? CELL_TARGET_0 : CELL_TARGET_1
      steps.push({
        body: cell,
        attempt: cell,
        cellChanged: true,
        semanticProgress: false,
        inventoryChanged: false,
        distanceClosed: false,
      })
    }
    const result = run(steps)
    const first = result.trips[0]
    return first !== undefined && first.record.returns === LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT && first.record.cellChanges >= 8
  },
  () => JSON.stringify(run(Array.from({ length: 40 }, (_, index) => ({ body: index % 2 === 0 ? CELL_TARGET_0 : CELL_TARGET_1, attempt: index % 2 === 0 ? CELL_TARGET_0 : CELL_TARGET_1, cellChanged: true, semanticProgress: false, inventoryChanged: false, distanceClosed: false }))).trips),
)

check(
  '(i) DURABLE HALF: a generation change does not move the trip point',
  () => {
    const without = run(measuredSteps(40))
    const withReload = run(measuredSteps(40), 6)
    return (
      without.trips.length >= 1 &&
      withReload.trips.length >= 1 &&
      withReload.trips[0]?.index === without.trips[0]?.index &&
      withReload.trips[0]?.record.returns === without.trips[0]?.record.returns &&
      JSON.stringify(withReload.trips[0]?.record.cells) === JSON.stringify(without.trips[0]?.record.cells)
    )
  },
  () => {
    const without = run(measuredSteps(40))
    const withReload = run(measuredSteps(40), 6)
    return JSON.stringify({
      without: without.trips[0]?.index ?? -1,
      withReload: withReload.trips[0]?.index ?? -1,
      persisted: withReload.persisted.length,
    })
  },
)

check(
  '(i) DURABLE HALF: a reload seven steps before the trip still trips at the same return count',
  () => {
    const without = run(measuredSteps(40))
    const withReload = run(measuredSteps(40), (without.trips[0]?.index ?? 0) - 7)
    const first = withReload.trips[0]
    return (
      first !== undefined &&
      first.index === without.trips[0]?.index &&
      withReload.persisted.some((entry) => entry !== null && entry.returns > 0)
    )
  },
  () => JSON.stringify(run(measuredSteps(40), (run(measuredSteps(40)).trips[0]?.index ?? 0) - 7).trips[0] ?? null),
)

check(
  '(i) CONTRAST: the same generation change with no durable record delays the trip',
  () => {
    const without = run(measuredSteps(40))
    const dropped = run(measuredSteps(40), -1, 6)
    const first = without.trips[0]
    const afterDrop = dropped.trips[0]
    return (
      first !== undefined &&
      afterDrop !== undefined &&
      afterDrop.index > first.index &&
      dropped.persisted.length < without.persisted.length
    )
  },
  () => {
    const without = run(measuredSteps(40))
    const dropped = run(measuredSteps(40), -1, 6)
    return JSON.stringify({ without: without.trips[0]?.index ?? -1, dropped: dropped.trips[0]?.index ?? -1 })
  },
)

// ---------------------------------------------------------------------------
// (ii) a productive walk through the same cells
// ---------------------------------------------------------------------------
check(
  '(ii) an inventory delta while walking the same cells never trips',
  () => {
    const steps = measuredSteps(60).map((step, index) => ({
      ...step,
      inventoryChanged: index % 4 === 3,
    }))
    const result = run(steps)
    return result.trips.length === 0 && result.clearReasons.includes('inventory_delta')
  },
  () => JSON.stringify(run(measuredSteps(60).map((step, index) => ({ ...step, inventoryChanged: index % 4 === 3 }))).clearReasons.slice(0, 6)),
)

check(
  '(ii) a closed distance while walking the same cells never trips',
  () => {
    const steps = measuredSteps(60).map((step, index) => ({
      ...step,
      distanceClosed: index % 4 === 3,
    }))
    const result = run(steps)
    return result.trips.length === 0 && result.clearReasons.includes('distance_closed')
  },
  () => JSON.stringify(run(measuredSteps(60).map((step, index) => ({ ...step, distanceClosed: index % 4 === 3 }))).clearReasons.slice(0, 6)),
)

// ---------------------------------------------------------------------------
// (iii) a body that IS changing the world / covering new ground
// ---------------------------------------------------------------------------
check(
  '(iii) a mining body in one place that removes blocks never trips',
  () => {
    const steps: Step[] = []
    for (let index = 0; index < 60; index += 1) {
      steps.push({
        body: BODY_CELL,
        attempt: null,
        cellChanged: false,
        semanticProgress: index % 3 === 0, // a MINE that removed a block -> `search`
        inventoryChanged: index % 5 === 0,
        distanceClosed: false,
      })
    }
    const result = run(steps)
    return result.trips.length === 0 && result.persisted.length === 0
  },
  () => {
    const steps: Step[] = []
    for (let index = 0; index < 60; index += 1) {
      steps.push({ body: BODY_CELL, attempt: null, cellChanged: false, semanticProgress: index % 3 === 0, inventoryChanged: index % 5 === 0, distanceClosed: false })
    }
    const result = run(steps)
    return JSON.stringify({ trips: result.trips.length, persisted: result.persisted.length })
  },
)

/** A successful MOVE to the next cell: the body settles ON its own target. */
function walkingSteps(from: { x: number; y: number; z: number }, count: number, axis: 'x' | 'z' = 'x'): Step[] {
  const steps: Step[] = []
  for (let index = 0; index < count; index += 1) {
    const destination = { ...from, [axis]: (axis === 'x' ? from.x : from.z) + index }
    const cell = localOscillationCell(DIMENSION, destination)
    steps.push({
      body: cell,
      attempt: cell,
      cellChanged: true,
      semanticProgress: false,
      inventoryChanged: false,
      distanceClosed: false,
    })
  }
  return steps
}

check(
  '(iii) a bridging body covering new ground never trips (a full envelope of new cells ends the episode)',
  () => {
    const result = run(walkingSteps({ x: 30, y: 40, z: 0 }, 24))
    return result.trips.length === 0 && result.clearReasons.includes('left_pocket')
  },
  () => JSON.stringify(run(walkingSteps({ x: 30, y: 40, z: 0 }, 24)).clearReasons.slice(0, 4)),
)

// ---------------------------------------------------------------------------
// (iv) a genuine turn-around clears the record
// ---------------------------------------------------------------------------
check(
  '(iv) leaving the pocket after the boundary clears the durable record',
  () => {
    const result = run([...measuredSteps(24), ...walkingSteps({ x: 40, y: 30, z: 20 }, 8, 'z')])
    // The old episode is gone (the trailing cells open a fresh, return-free one)
    // and the clear was handed to the HOST as `null`.
    return (
      result.trips.length >= 1 &&
      result.clearReasons.includes('left_pocket') &&
      (result.record === null || result.record.returns === 0) &&
      result.persisted.some((entry) => entry === null)
    )
  },
  () => {
    const result = run([...measuredSteps(24), ...walkingSteps({ x: 40, y: 30, z: 20 }, 8, 'z')])
    return JSON.stringify({ trips: result.trips.length, returns: result.record?.returns ?? null, reasons: result.clearReasons.slice(-2), cleared: result.persisted.filter((entry) => entry === null).length })
  },
)

check(
  '(iv) semantic progress after the boundary clears the durable record',
  () => {
    const steps = measuredSteps(20)
    steps.push({ body: BODY_CELL, attempt: null, cellChanged: false, semanticProgress: true, inventoryChanged: false, distanceClosed: false })
    const result = run(steps)
    return result.trips.length >= 1 && result.record === null && result.clearReasons.includes('semantic_progress')
  },
  () => {
    const steps = measuredSteps(20)
    steps.push({ body: BODY_CELL, attempt: null, cellChanged: false, semanticProgress: true, inventoryChanged: false, distanceClosed: false })
    return JSON.stringify(run(steps).clearReasons.slice(-1))
  },
)

// ---------------------------------------------------------------------------
// (v) ordinary motion is byte-identical
// ---------------------------------------------------------------------------
check(
  '(v) ordinary productive motion emits no line and persists nothing',
  () => {
    const steps: Step[] = []
    for (let index = 0; index < 60; index += 1) {
      const cell = localOscillationCell(DIMENSION, { x: 200 + index, y: 64, z: 0 })
      steps.push({
        body: cell,
        attempt: cell,
        cellChanged: true,
        semanticProgress: index % 10 === 0,
        inventoryChanged: index % 10 === 5,
        distanceClosed: false,
      })
    }
    const result = run(steps)
    return result.lines.length === 0 && result.persisted.length === 0 && result.trips.length === 0
  },
  () => {
    const result = run(walkingSteps({ x: 200, y: 64, z: 0 }, 60))
    return JSON.stringify({ lines: result.lines.length, persisted: result.persisted.length, trips: result.trips.length })
  },
)

check(
  '(v) a plain successful walk never produces a notable (persistable) record',
  () => {
    const result = run(walkingSteps({ x: 100, y: 64, z: 5 }, 40))
    return result.persisted.length === 0 && result.lines.length === 0
  },
  () => 'no return was ever observed, so nothing is proposed to the HOST',
)

// ---------------------------------------------------------------------------
// why the existing pair detector cannot see this shape
// ---------------------------------------------------------------------------
check(
  '(why) the existing pair detector never fires on the measured 3-cell cycle',
  () => {
    let state: ReturnType<typeof evaluateOscillation>['state'] | null = null
    let detected = 0
    for (let index = 0; index < 60; index += 1) {
      const decision = evaluateOscillation({
        position: `${index % 3}`,
        signature: 'descend:raw_iron:1|{}',
        previous: state,
        goal: GOAL,
      })
      state = decision.state
      if (decision.detected) detected += 1
    }
    return detected === 0
  },
  () => 'one canonical pair per step: the 3-cell cycle resets `cycles` every time',
)

// ---------------------------------------------------------------------------
// boundary + record hygiene
// ---------------------------------------------------------------------------
check(
  '(boundary) the escalation boundary wakes only on a code-proven exhaustion with an active Option',
  () => {
    const exhausted = evaluateLocalMotionBoundary({ activeOption: true, oscillationExhausted: true })
    const idle = evaluateLocalMotionBoundary({ activeOption: true, oscillationExhausted: false })
    const noOption = evaluateLocalMotionBoundary({ activeOption: false, oscillationExhausted: true })
    return (
      exhausted.wake === true &&
      exhausted.reason === 'semantic_boundary' &&
      idle.wake === false &&
      idle.reason === 'local_recovery' &&
      noOption.wake === false &&
      noOption.reason === 'no_active_option'
    )
  },
  () => JSON.stringify(evaluateLocalMotionBoundary({ activeOption: true, oscillationExhausted: true })),
)

check(
  '(hygiene) a restored record is validated and clamped',
  () => {
    const garbage = restoreLocalOscillationRecord({ dimension: '', cells: ['x'] })
    const notObject = restoreLocalOscillationRecord('nope')
    const emptyCells = restoreLocalOscillationRecord({ dimension: DIMENSION, cells: [] })
    const clamped = restoreLocalOscillationRecord({
      dimension: DIMENSION,
      cells: [ATTEMPT_CELLS[0], ATTEMPT_CELLS[0], ATTEMPT_CELLS[1]],
      returns: -5,
      trips: 2.9,
      firstSeenAt: 10,
      lastSeenAt: 5,
    })
    return (
      garbage === null &&
      notObject === null &&
      emptyCells === null &&
      clamped !== null &&
      clamped.cells.length === 2 &&
      clamped.returns === 0 &&
      clamped.trips === 2 &&
      clamped.lastSeenAt === 5
    )
  },
  () => JSON.stringify(restoreLocalOscillationRecord({ dimension: DIMENSION, cells: [ATTEMPT_CELLS[0], ATTEMPT_CELLS[0]], returns: -5, trips: 2.9 })),
)

check(
  '(hygiene) the backoff is bounded and the span is geometric',
  () => {
    return (
      requiredLocalOscillationReturns(8, 0) === 8 &&
      requiredLocalOscillationReturns(8, 1) === 16 &&
      requiredLocalOscillationReturns(8, 3) === 64 &&
      requiredLocalOscillationReturns(8, 99) === 64 &&
      localOscillationSpan([CELL_TARGET_0]) === 0 &&
      localOscillationSpan([CELL_TARGET_0, CELL_TARGET_2]) === 1
    )
  },
  () =>
    JSON.stringify({
      b0: requiredLocalOscillationReturns(8, 0),
      b3: requiredLocalOscillationReturns(8, 3),
      b99: requiredLocalOscillationReturns(8, 99),
      span: localOscillationSpan([CELL_TARGET_0, CELL_TARGET_2]),
    }),
)

check(
  '(hygiene) a plan change alone does not re-arm the record',
  () => {
    const simulate = (): { tripped: boolean; record: LocalOscillationRecordJson | null } => {
      let record: LocalOscillationRecordJson | null = null
      let tripped = false
      for (let index = 0; index < 12; index += 1) {
        const decision = observeLocalOscillation(record, {
          bodyCell: BODY_CELL,
          attemptCell: [CELL_TARGET_0, CELL_TARGET_1, CELL_TARGET_2][index % 3] as string,
          dimension: DIMENSION,
          // a different plan every 2 decisions must not launder the loop
          goal: index % 4 < 2 ? GOAL : 'collect:food:3',
          cellChanged: false,
          semanticProgress: false,
          inventoryChanged: false,
          distanceClosed: false,
          now: 1_000,
        })
        record = decision.record
        tripped = decision.exhausted || tripped
      }
      return { tripped, record }
    }
    const result = simulate()
    return result.tripped && result.record !== null && result.record.returns >= LOCAL_OSCILLATION_RETURN_LIMIT_DEFAULT
  },
  () => {
    let record: LocalOscillationRecordJson | null = null
    for (let index = 0; index < 12; index += 1) {
      const decision = observeLocalOscillation(record, {
        bodyCell: BODY_CELL,
        attemptCell: [CELL_TARGET_0, CELL_TARGET_1, CELL_TARGET_2][index % 3] as string,
        dimension: DIMENSION,
        goal: index % 4 < 2 ? GOAL : 'collect:food:3',
        cellChanged: false,
        semanticProgress: false,
        inventoryChanged: false,
        distanceClosed: false,
        now: 1_000,
      })
      record = decision.record
    }
    return JSON.stringify({ returns: record?.returns ?? 0, trips: record?.trips ?? 0 })
  },
)

// ---------------------------------------------------------------------------
// wiring: the controller must feed the measured facts into the tracker
// ---------------------------------------------------------------------------
check(
  '(wiring) onActionComplete feeds the BODY cell, the movement ATTEMPT cell and the progress kinds',
  () => {
    const source = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
    const complete = /private onActionComplete\([\s\S]*?\n  private [a-zA-Z]/.exec(source)?.[0] ?? ''
    return (
      complete.includes('this.observeLocalMotion(result, candidate, taxonomy)') &&
      /observeLocalOscillation\(/.test(source) &&
      /isTrackedMoveKind\(result\.kind\) && candidate\.target !== null/.test(source) &&
      /semanticProgress: taxonomy\.progressKinds\.some\(\(kind\) => kind === 'goal' \|\| kind === 'search'\)/.test(source) &&
      /inventoryChanged,/.test(source)
    )
  },
  () => 'the controller passes the cell, attempt, progress and inventory facts',
)

check(
  '(wiring) the exhausted record crosses the typed boundary and is escalated upward, never re-planned locally',
  () => {
    const source = readFileSync(new URL('./src/controller-legacy.ts', import.meta.url), 'utf8')
    const start = source.indexOf('private observeLocalMotion')
    const body = source.slice(start, source.indexOf('private persistLocalOscillation', start))
    return (
      /evaluateLocalMotionBoundary\(\{[\s\S]{0,120}activeOption: this\.queue\.current !== null/.test(source) &&
      /if \(!boundary\.wake\) return\n\s+this\.escalate\(/.test(source) &&
      /'all_candidates_invalid',\n\s+`LOCAL_OSCILLATION_BOUNDARY/.test(source) &&
      // it must not touch candidate selection or ranking
      start >= 0 && body.length > 0 && !/candidates\.(sort|filter|reverse)/.test(body)
    )
  },
  () => 'the boundary asks System2; it never reorders candidates',
)

process.stdout.write(`${'-'.repeat(72)}\n${cases - failures}/${cases} local-oscillation cases passed\n`)
if (failures > 0) process.exit(1)
