// test-leg-travel.mts - #352 EXECUTOR far-navigation committed-leg regression.
//
// Live defect (issue #352, resident m3-live): the M2 obsidian goal had a
// remembered cell ~167-169m west. The direct path to that exact cell is refused
// (`no_path`), the coordinate is blacklisted by the move-failure memory after a
// few attempts, and the body then only paced locally:
//
//   ACTION id=RETRIEVE:known:obsidian:b28_68_9 kind=RETRIEVE phase=approaching
//   MOVE_TARGET_SKIPPED actionId=RETRIEVE:known:obsidian:b28_68_9
//     key=overworld:28,68,9 attempts=3 then 6
//   CANDIDATE_STARVATION presented=2 productive=0 blockedBy=no_productive_action
//
// There was no multi-leg journey: nothing walked a leg toward a far target and
// re-planned from the new position. A leg trades the (possibly unreachable)
// exact destination for the target's reachable NEIGHBOURHOOD
// (`GoalNear(target, LEG_TRAVEL_RADIUS)`), measures the remaining feet-distance
// from the BODY, and reports it as progress - never as arrival. A leg that
// closes less than `LEG_TRAVEL_MIN_PROGRESS` keeps the original typed failure so
// the move-failure memory bounds the target (no infinite leg loop).
//
// This fixture drives the REAL executor for a ~167m MOVE whose direct GoalBlock
// path is refused. Before the leg mechanism the MOVE failed outright and the
// body never moved; after it, one committed leg closes >100m.
//
// UPDATED 2026-09-23 (issue #436 / OPERATOR DIRECTIVE, `walkSkill.ts`): the leg is
// now the FIRST mechanical leg of ONE committed walk owned by the harness layer,
// so the settled result is the COMMITMENT's, not the leg's:
//
//   * the leg mechanism itself is unchanged (same GoalNear leg, same LEG_TRAVEL /
//     LEG_PROGRESS evidence, same physical path);
//   * a commitment whose declared budget is spent after that leg settles with the
//     TYPED `path_timeout`/BUDGET_EXHAUSTED end and still reports the durable body
//     progress it made (`progressed`/`distanceClosed`), instead of the old
//     `done/phase=leg` shape that could not be told apart from an arrival;
//   * `verified` stays FALSE: only `classifyMoveArrival` verifies the committed
//     target, so a leg is never reported as arrival.
//
// The budget is the commitment's own `pathTimeoutMs` (#436 section 15), which is
// why the fixture's tiny 1 ms value is raised to a realistic bounded value.
//
// Run: bun test-leg-travel.mts
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Bot } from 'mineflayer'
import { Executor, EventLogger, defaultExecutorOptions } from './src/index.ts'
import * as executorModule from './src/executor.ts'
import type { JsonlWriter } from './src/jev/client.ts'
import type { Candidate, Vec3Json } from './src/index.ts'

/**
 * Namespace access (never a named import) so this fixture also RUNS on the
 * pre-leg baseline and reports behavioral failures instead of crashing at
 * module load. The numbers fall back to the documented constants.
 */
const classifyLeg = executorModule.classifyTravelLeg
const LEG_MIN_PROGRESS = executorModule.LEG_TRAVEL_MIN_PROGRESS ?? 4
const LEG_MIN_DISTANCE = executorModule.LEG_TRAVEL_MIN_DISTANCE ?? 24

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')
const pathfinderModule = require('mineflayer-pathfinder')
const { goals } = pathfinderModule

interface Case {
  name: string
  run: () => { pass: boolean; detail: string } | Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

/** Live body cell and remembered obsidian cell from the issue's measured trace. */
const START: Vec3Json = { x: 195.5, y: 67, z: -14.5 }
const TARGET: Vec3Json = { x: 28, y: 68, z: 9 }
const FLOOR_Y = 66

/** Minimal structural vec3 the executor touches on the fake bot. */
class P {
  x: number
  y: number
  z: number
  constructor(x: number, y: number, z: number) {
    this.x = x
    this.y = y
    this.z = z
  }
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  set(x: number, y: number, z: number): P {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
  offset(x: number, y: number, z: number): P {
    return new P(this.x + x, this.y + y, this.z + z)
  }
  distanceTo(other: { x: number; y: number; z: number }): number {
    return Math.hypot(this.x - other.x, this.y - other.y, this.z - other.z)
  }
}

type LegMode = 'leg-closes' | 'leg-no-progress'

interface LegFixture {
  bot: Bot
  /** goal class names the executor set, in order */
  goalsSet: string[]
  position: P
  logs: string[]
}

/**
 * A structural bot for the real Executor:
 *   - `GoalBlock`/`GoalGetToBlock` (the direct path) is always refused with
 *     `path_update status=noPath`;
 *   - `GoalNear` (the committed leg) either closes 60% of the remaining
 *     horizontal distance and reports `goal_reached`, or refuses without moving.
 * `getPathTo` always reports noPath so the control/packet fallbacks cannot
 * silently walk the body themselves.
 */
function makeLegBot(mode: LegMode): LegFixture {
  const position = new P(START.x, START.y, START.z)
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const logs: string[] = []
  const goalsSet: string[] = []

  const emit = (event: string, payload?: unknown): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(payload)
  }

  const bot = {
    registry,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      isCollidedHorizontally: false,
      width: 0.6,
      height: 1.8,
      offset: (x: number, y: number, z: number): P => position.offset(x, y, z),
      clone: (): P => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }): number => position.distanceTo(other),
    },
    _client: { write: (): boolean => true },
    physicsEnabled: true,
    entities: {},
    inventory: {
      items: (): Array<{ name: string; count: number; slot: number }> => [],
      count: (): number => 0,
    },
    blockAt: (v: { x: number; y: number; z: number }): { name: string; boundingBox: string } => {
      const y = Math.floor(v.y)
      if (y <= FLOOR_Y) return { name: 'stone', boundingBox: 'block' }
      return { name: 'air', boundingBox: 'empty' }
    },
    on: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      set.push(handler)
      listeners.set(event, set)
      return bot
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void): unknown => {
      const set = listeners.get(event) ?? []
      listeners.set(
        event,
        set.filter((entry) => entry !== handler),
      )
      return bot
    },
    setControlState: (): void => undefined,
    lookAt: async (): Promise<void> => undefined,
    stopDigging: (): void => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown): void => {
        bot.pathfinder.movements = movements
      },
      setGoal: (goal: { constructor?: { name?: string } } | null): void => {
        if (goal === null) return
        goalsSet.push(goal.constructor?.name ?? 'unknown')
        if (goal instanceof goals.GoalNear) {
          if (mode === 'leg-closes') {
            position.set(
              position.x + (TARGET.x - position.x) * 0.6,
              position.y,
              position.z + (TARGET.z - position.z) * 0.6,
            )
          }
          // `leg-no-progress`: the stock GoalNear leg REPORTS success without the
          // body moving, so the leg must never be charged as progress.
          emit('goal_reached')
          return
        }
        // The direct GoalBlock/GoalGetToBlock path to the exact far cell is refused.
        emit('path_update', { status: 'noPath' })
      },
      stop: (): void => undefined,
      getPathTo: (): { status: string; path: unknown[] } => ({ status: 'noPath', path: [] }),
    },
  }

  return { bot: bot as unknown as Bot, goalsSet, position, logs }
}

function moveCandidate(target: Vec3Json): Candidate {
  return {
    id: `MOVE:p${target.x}_${target.y}_${target.z}`,
    kind: 'MOVE',
    label: `move to (${target.x},${target.y},${target.z})`,
    targetName: null,
    target,
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {},
  }
}

function makeLogger(logs: string[]): EventLogger {
  const writer = {
    write: (record: { message?: string }): void => {
      if (typeof record.message === 'string') logs.push(record.message)
    },
  } as unknown as JsonlWriter
  return new EventLogger(writer, false)
}

async function runMove(mode: LegMode) {
  const fixture = makeLegBot(mode)
  const executor = new Executor(fixture.bot, makeLogger(fixture.logs), {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    // The stock path reads the synchronous fake events; the control-walk fallback
    // spends a bounded stage of this window, and it is also the COMMITMENT's
    // declared budget (the first stage is capped at half when a travel leg is the
    // designed next stage, so the travel leg still runs inside the same budget).
    // Kept small so this fixture costs ~0.4 s per case instead of seconds.
    pathTimeoutMs: 400,
    pickupPathTimeoutMs: 1,
    packetStepMs: 0,
    maxStepsPerWaypoint: 1,
  })
  const target = moveCandidate(TARGET)
  const distanceBefore = fixture.position.distanceTo(TARGET)
  const result = await executor.claim(target).completion
  return { result, fixture, distanceBefore, distanceAfter: fixture.position.distanceTo(TARGET) }
}

const has = (logs: readonly string[], marker: string): boolean => logs.some((line) => line.includes(marker))

// --- pure leg classifier ----------------------------------------------------

addCase('a leg that closes >= LEG_TRAVEL_MIN_PROGRESS is positional progress but never arrival', () => {
  if (typeof classifyLeg !== 'function') return { pass: false, detail: 'classifyTravelLeg is not exported' }
  const decision = classifyLeg({ remainingBefore: 167, remainingAfter: 67 })
  const pass =
    decision.warranted &&
    decision.progressed &&
    decision.delta === 100 &&
    decision.remaining === 67
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a leg that closes less than LEG_TRAVEL_MIN_PROGRESS is NOT progress', () => {
  if (typeof classifyLeg !== 'function') return { pass: false, detail: 'classifyTravelLeg is not exported' }
  const decision = classifyLeg({ remainingBefore: 167, remainingAfter: 167 - (LEG_MIN_PROGRESS - 1) })
  const pass = decision.warranted && !decision.progressed && decision.delta < LEG_MIN_PROGRESS
  return { pass, detail: JSON.stringify(decision) }
})

addCase('a target within LEG_TRAVEL_MIN_DISTANCE warrants no leg at all', () => {
  if (typeof classifyLeg !== 'function') return { pass: false, detail: 'classifyTravelLeg is not exported' }
  const decision = classifyLeg({ remainingBefore: LEG_MIN_DISTANCE, remainingAfter: 5 })
  const pass = !decision.warranted && !decision.progressed
  return { pass, detail: JSON.stringify(decision) }
})

// --- real executor: far MOVE, direct path refused ---------------------------

addCase('a ~167m MOVE whose direct GoalBlock path is refused walks one committed GoalNear leg and closes distance', async () => {
  const { result, fixture, distanceBefore, distanceAfter } = await runMove('leg-closes')
  const pass =
    result.status === 'failed' &&
    result.failure === 'path_timeout' &&
    result.verified === false &&
    result.progressed === true &&
    result.distanceClosed === true &&
    distanceAfter < distanceBefore - LEG_MIN_PROGRESS &&
    fixture.goalsSet.some((name) => name === 'GoalNear') &&
    has(fixture.logs, 'LEG_TRAVEL') &&
    has(fixture.logs, 'LEG_PROGRESS') &&
    fixture.logs.filter((line) => line.startsWith('SKILL_START')).length === 1 &&
    fixture.logs.some((line) => line.startsWith('SKILL_END') && line.includes('outcome=BUDGET_EXHAUSTED'))
  return {
    pass,
    detail:
      `status=${result.status} failure=${result.failure} verified=${result.verified} progressed=${result.progressed} ` +
      `dist=${distanceBefore.toFixed(1)}->${distanceAfter.toFixed(1)} goals=${fixture.goalsSet.join(',')} detail=${result.detail}`,
  }
})

addCase('a walked leg is reported as progress, NEVER as arrival at the final target', async () => {
  const { result, fixture } = await runMove('leg-closes')
  // The controller's own MOVE-arrival predicate requires the executor `verified`
  // flag; a leg must leave it false so the committed target stays open for the
  // next decision. `phase` names the typed stop, so a spent budget can never be
  // read as an arrival.
  const pass =
    result.verified === false &&
    result.progressed === true &&
    result.phase === 'walk_budget_exhausted' &&
    result.failure === 'path_timeout'
  return { pass, detail: `status=${result.status} verified=${result.verified} phase=${result.phase} failure=${result.failure} detail=${result.detail}` }
})

addCase('a leg that makes no positional progress fails typed and is never reported as progress', async () => {
  const { result, fixture, distanceBefore, distanceAfter } = await runMove('leg-no-progress')
  const pass =
    result.status === 'failed' &&
    (result.failure === 'path_stuck' || result.failure === 'path_timeout') &&
    result.progressed === false &&
    result.verified === false &&
    distanceAfter > distanceBefore - LEG_MIN_PROGRESS &&
    has(fixture.logs, 'LEG_NO_PROGRESS') &&
    !has(fixture.logs, 'LEG_PROGRESS')
  return {
    pass,
    detail:
      `status=${result.status} failure=${result.failure} progressed=${result.progressed} ` +
      `dist=${distanceBefore.toFixed(1)}->${distanceAfter.toFixed(1)} marker=${has(fixture.logs, 'LEG_NO_PROGRESS')}`,
  }
})

// --- wiring: the RETRIEVE arrival path uses the same leg, arrival stays owned -

addCase('runRetrieve drives the same committed leg and keeps "target reached" separate from "leg walked"', () => {
  const source = readFileSync(fileURLToPath(new URL('./src/executor.ts', import.meta.url)), 'utf8')
  const retrieveLeg = /if \(approachError !== null\) \{\s*const leg = await this\.runTravelLeg\(/.test(source)
  // A VTR waypoint segment supersedes the leg path; the committed leg still
  // owns far-MOVE progress when no waypoint is available.
  const moveLeg = /if \(pathError !== null && waypoint === null\) \{\s*const leg = await this\.runTravelLeg\(/.test(source)
  const helper = source.includes('private async runTravelLeg(')
  const goalNearLeg = /await this\.pathToNear\(target, LEG_TRAVEL_RADIUS, epoch, signal/.test(source)
  // The RETRIEVE arrival post-condition is still owned by classifyRetrieveApproach
  // (distance <= RETRIEVE_ARRIVAL_RADIUS), not by the leg.
  const arrivalStillOwned = source.includes('const approach = classifyRetrieveApproach({')
  const pass = retrieveLeg && moveLeg && helper && goalNearLeg && arrivalStillOwned
  return {
    pass,
    detail: `retrieveLeg=${retrieveLeg} moveLeg=${moveLeg} helper=${helper} goalNearLeg=${goalNearLeg} arrivalStillOwned=${arrivalStillOwned}`,
  }
})

let failures = 0
process.stdout.write('EXECUTOR far-navigation committed legs (#352)\n')
process.stdout.write('-'.repeat(78) + '\n')
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(78) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} leg-travel cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
