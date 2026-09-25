// test-walk-skill.mts - the WALK_TO family as ONE harness-layer Skill (issue #436).
//
// OPERATOR DIRECTIVE (issued while watching the live body move):
//
//   "動き始めて壁にぶつかってジャンプすることはできるんだけどそれまでが長い。
//    やはりここはハーネス層にやらせるべきだ"
//   = "once it starts moving it CAN bump into a wall and jump it, but getting to
//      that point takes too long; this part should be done by the harness layer."
//
// BEFORE (measured, tools/skill-closure-metrics.mjs --run run-muaxgjed-15kew):
//   jevDecisions 37 / actions 10  -> actionsPerDecision 0.27
//   every MOVE settles `verified=true status=done` in 0.4-1.2 s and the controller
//   asks Jev again for the next leg (controller-legacy.ts:5574).
//
// This fixture pins the AFTER contract at the harness layer:
//   one decision -> one commitment -> MANY mechanical legs -> one verified arrival.
//
// Cases (charter (i)-(vii)):
//   (i)   a committed walk across a flat run with an intermediate blocked cell:
//         ONE decision, several mechanical legs, arrival, ONE SKILL_END, and
//         `actionsPerDecision` > 1 BY CONSTRUCTION (legs / SKILL_START);
//   (ii)  a wall the ordinary bump-and-jump clears: one commitment clears it (the
//         operator's exact case) with no new decision and no dig/place authority;
//   (iii) a lethal step (the waypoint guard's measured shape): the loop STOPS with
//         the typed reason, the body does not step, and policy gets control back;
//   (iv)  the world/epoch or the lease changes mid-walk: the commitment ends with
//         the typed reason and NO further mechanical leg;
//   (v)   the continuation would need a remedy class the commitment was not granted
//         (dig / place): the loop stops with SKILL_POLICY_BOUNDARY and performs
//         NEITHER - no code choice, no envelope violation;
//   (vi)  budget exhaustion (wall clock): a typed end, never a silent stop;
//   (vii) an abort mid-walk (the env-hazard reflex path) wins within one mechanical
//         step, and the loop never swallows it;
//   plus the pure boundary table, the budget/step caps, the "portal entry and STEP
//   are NOT absorbed into the walk loop" contract, and the latency report.
//
// Run: bun test ./test-walk-skill.mts

import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import type { Candidate, CandidateKind } from './src/candidates.ts'
import { ExecutionAuthorityConflict, Executor, defaultExecutorOptions } from './src/executor.ts'
import type { ExecutionResult } from './src/executor.ts'
import { EventLogger, JsonlWriter } from './src/jev.ts'
import {
  MOVE_LEG_STOPPED,
} from './src/stepLanding.ts'
import {
  SKILL_END,
  SKILL_POLICY_BOUNDARY,
  SKILL_START,
  SKILL_STEP,
} from './src/netherPortalPlan.ts'
import {
  WALK_LEG_CONTINUABLE,
  WALK_SKILL_MS_CAP,
  WALK_SKILL_STALL_CAP,
  WALK_SKILL_STEP_CAP,
  isWalkSkillKind,
  walkBoundaryAfterLeg,
  walkSkillBudget,
  walkSkillIdFor,
} from './src/walkSkill.ts'
import type { WalkStop } from './src/walkSkill.ts'
import type { Vec3Json } from './src/state.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}
const num = (value: number): string => String(Math.round(value * 100) / 100)

// ---------------------------------------------------------------------------
// the pure boundary table: no bot, no world
// ---------------------------------------------------------------------------
{
  const budget = walkSkillBudget(10_000)
  type BoundaryInput = Parameters<typeof walkBoundaryAfterLeg>[0]
  const base: BoundaryInput = {
    legs: 1,
    stalledLegs: 0,
    elapsedMs: 10,
    budget,
    arrived: false,
    failure: null,
    invalidated: null,
  }
  const stopOf = (input: Partial<BoundaryInput>): WalkStop | null => {
    const verdict = walkBoundaryAfterLeg({ ...base, ...input })
    return verdict.stop ? verdict : null
  }
  check(
    '(rule) budget is bounded in BOTH steps and wall clock',
    budget.ms === 10_000 && budget.steps === WALK_SKILL_STEP_CAP && budget.stall === WALK_SKILL_STALL_CAP,
    `ms=${budget.ms} steps=${budget.steps} stall=${budget.stall}`,
  )
  check(
    '(rule) an unbounded declaration falls back to the module wall-clock cap',
    walkSkillBudget(null).ms === WALK_SKILL_MS_CAP && walkSkillBudget(Number.NaN).ms === WALK_SKILL_MS_CAP,
    `null=${walkSkillBudget(null).ms} NaN=${walkSkillBudget(Number.NaN).ms}`,
  )
  check(
    '(rule) arrival is the only SUCCESS stop and it is NOT a policy boundary',
    stopOf({ arrived: true })?.outcome === 'SUCCESS' && stopOf({ arrived: true })?.policyBoundary === false,
    `outcome=${stopOf({ arrived: true })?.outcome}`,
  )
  check(
    '(rule) a hazard refusal (SAFETY_INTERRUPT) stops the loop immediately as a typed INTERRUPT',
    stopOf({ failure: { code: 'hazard_between', outcome: 'SAFETY_INTERRUPT' } })?.reason === 'safety' &&
      stopOf({ failure: { code: 'hazard_between', outcome: 'SAFETY_INTERRUPT' } })?.outcome === 'SAFETY_INTERRUPT' &&
      stopOf({ failure: { code: 'hazard_between', outcome: 'SAFETY_INTERRUPT' } })?.policyBoundary === false &&
      stopOf({ failure: { code: 'unsafe_landing', outcome: 'SAFETY_INTERRUPT' } })?.failureCode === 'unsafe_landing',
    `hazard=${stopOf({ failure: { code: 'hazard_between', outcome: 'SAFETY_INTERRUPT' } })?.reason} boundary=${stopOf({ failure: { code: 'hazard_between', outcome: 'SAFETY_INTERRUPT' } })?.policyBoundary}`,
  )
  check(
    '(rule) a step budget stop is BUDGET_EXHAUSTED with a typed code, never a silent stop',
    stopOf({ legs: WALK_SKILL_STEP_CAP })?.outcome === 'BUDGET_EXHAUSTED' &&
      stopOf({ legs: WALK_SKILL_STEP_CAP })?.failureCode === 'path_timeout',
    `outcome=${stopOf({ legs: WALK_SKILL_STEP_CAP })?.outcome} code=${stopOf({ legs: WALK_SKILL_STEP_CAP })?.failureCode}`,
  )
  check(
    '(rule) a spent wall clock is BUDGET_EXHAUSTED even with legs left',
    stopOf({ elapsedMs: 10_001 })?.outcome === 'BUDGET_EXHAUSTED',
    `outcome=${stopOf({ elapsedMs: 10_001 })?.outcome}`,
  )
  check(
    '(rule) only the ordinary mechanical locomotion codes may be continued',
    WALK_LEG_CONTINUABLE.has('path_stuck') &&
      WALK_LEG_CONTINUABLE.has('path_no_path') &&
      !WALK_LEG_CONTINUABLE.has('effect_envelope_violation') &&
      !WALK_LEG_CONTINUABLE.has('tunnel_entry_refused') &&
      !WALK_LEG_CONTINUABLE.has('unknown_event'),
    `set=[${[...WALK_LEG_CONTINUABLE].join(',')}]`,
  )
  check(
    '(rule) a continuation after a mechanical failure is allowed; a deterministic refusal is not',
    stopOf({ failure: { code: 'path_stuck', outcome: 'MECHANICALLY_BLOCKED' } }) === null &&
      stopOf({ failure: { code: 'effect_envelope_violation', outcome: 'MECHANICALLY_BLOCKED' } })?.reason === 'remedy_required',
    `path_stuck=${stopOf({ failure: { code: 'path_stuck', outcome: 'MECHANICALLY_BLOCKED' } })?.reason ?? 'continue'} envelope=${stopOf({ failure: { code: 'effect_envelope_violation', outcome: 'MECHANICALLY_BLOCKED' } })?.reason}`,
  )
  check(
    '(rule) a stalled commitment stops mechanically and asks policy (remedy_required/stalled boundary)',
    stopOf({ stalledLegs: WALK_SKILL_STALL_CAP })?.outcome === 'MECHANICALLY_BLOCKED' &&
      stopOf({ stalledLegs: WALK_SKILL_STALL_CAP })?.policyBoundary === true,
    `reason=${stopOf({ stalledLegs: WALK_SKILL_STALL_CAP })?.reason}`,
  )
  check(
    '(rule) an invalidated world stops without a policy boundary (the typed end owns it)',
    stopOf({ invalidated: 'WORLD_CHANGED' })?.outcome === 'WORLD_CHANGED' &&
      stopOf({ invalidated: 'WORLD_CHANGED' })?.policyBoundary === false,
    `outcome=${stopOf({ invalidated: 'WORLD_CHANGED' })?.outcome}`,
  )
  check(
    '(contract) the walk loop owns MOVE/RETREAT/RETRIEVE only - portal entry and STEP are NOT absorbed',
    isWalkSkillKind('MOVE') &&
      isWalkSkillKind('RETREAT') &&
      isWalkSkillKind('RETRIEVE') &&
      !isWalkSkillKind('ENTER_PORTAL') &&
      !isWalkSkillKind('STEP') &&
      !isWalkSkillKind('DESCEND') &&
      !isWalkSkillKind('MINE'),
    `move=${isWalkSkillKind('MOVE')} portal=${isWalkSkillKind('ENTER_PORTAL')} step=${isWalkSkillKind('STEP')}`,
  )
  check(
    '(contract) the two committed walk skills keep distinct ids for the evidence',
    walkSkillIdFor('MOVE') === 'WALK_TO(destination)' && walkSkillIdFor('RETRIEVE') === 'RETRIEVE_TO(resource)',
    `move=${walkSkillIdFor('MOVE')} retrieve=${walkSkillIdFor('RETRIEVE')}`,
  )
}

// ---------------------------------------------------------------------------
// a grid + control-state bot (the same fixture shape the waypoint hazard guard
// uses, so the walk loop is exercised against the REAL runner code paths)
// ---------------------------------------------------------------------------
interface GridCell {
  name: string
  boundingBox: string
}
type Grid = Map<string, GridCell>

function solid(name: string): GridCell {
  return {
    name,
    boundingBox: name === 'air' || name === 'lava' || name === 'fire' || name === 'water' ? 'empty' : 'block',
  }
}
function fill(grid: Grid, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, name: string): void {
  for (let x = x0; x <= x1; x += 1) {
    for (let y = y0; y <= y1; y += 1) {
      for (let z = z0; z <= z1; z += 1) grid.set(`${x},${y},${z}`, solid(name))
    }
  }
}
function dig(grid: Grid, x: number, y: number, z: number): void {
  grid.set(`${x},${y},${z}`, solid('air'))
}
function at(grid: Grid, x: number, y: number, z: number): GridCell {
  return grid.get(`${x},${y},${z}`) ?? solid('air')
}

interface WalkFixture {
  bot: Bot
  position: Vec3
  trace: string[]
  grid: Grid
  pathCalls: () => number
  writes: () => number
  /** filled by `runWalk` right after the Executor exists, so a hook can cancel it */
  executorRef: { current: Executor | null }
}

const STEP = 0.25

/**
 * `hook` runs on every actuation (a control push or a packet write), which is how
 * the mid-walk world/lease changes below are injected at a deterministic point.
 */
function makeBot(
  feet: Vec3Json,
  grid: Grid,
  hook?: (writes: number, bot: Bot, executor: Executor | null) => void,
): WalkFixture {
  const position = new Vec3(feet.x + 0.5, feet.y, feet.z + 0.5)
  const trace: string[] = []
  const executorRef: { current: Executor | null } = { current: null }
  let pathCalls = 0
  let writes = 0
  let heading = { x: 0, z: 0 }
  const listeners = new Map<string, Set<(arg?: unknown) => void>>()
  const emit = (event: string, arg?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(arg)
  }
  const blockAt = (v: { x: number; y: number; z: number }) => {
    const found = grid.get(`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`)
    if (found === undefined) return null
    return {
      name: found.name,
      boundingBox: found.boundingBox,
      diggable: true,
      position: new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)),
    }
  }
  const open = (x: number, y: number, z: number): boolean => at(grid, x, y, z).boundingBox === 'empty'
  const bot = {
    registry,
    game: { dimension: 'minecraft:overworld' as string },
    physicsEnabled: true,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      velocity: new Vec3(0, 0, 0),
      offset: (x: number, y: number, z: number) => position.offset(x, y, z),
      clone: () => position.clone(),
      distanceTo: (other: { x: number; y: number; z: number }) => position.distanceTo(other as Vec3),
    },
    _client: {
      write: () => {
        writes += 1
        hook?.(writes, bot as unknown as Bot, executorRef.current)
        return true
      },
    },
    entities: {},
    inventory: { items: () => [], count: () => 0 },
    heldItem: null,
    blockAt,
    on: (event: string, listener: (arg?: unknown) => void) => {
      const set = listeners.get(event) ?? new Set<(arg?: unknown) => void>()
      set.add(listener)
      listeners.set(event, set)
    },
    removeListener: (event: string, listener: (arg?: unknown) => void) => {
      listeners.get(event)?.delete(listener)
    },
    setControlState: (control: string, value: boolean) => {
      if (!value) return
      trace.push(control)
      writes += 1
      hook?.(writes, bot as unknown as Bot, executorRef.current)
      const feetY = Math.floor(position.y + 0.1)
      if (control === 'jump') {
        // a vanilla 1-block step-up: the body lands on top of the rise in front
        const cx = Math.floor(position.x + heading.x)
        const cz = Math.floor(position.z + heading.z)
        const ahead = at(grid, cx, feetY, cz)
        if (ahead.boundingBox !== 'empty' && open(cx, feetY + 1, cz) && open(cx, feetY + 2, cz)) {
          position.y = feetY + 1
        }
        return
      }
      if (control !== 'forward' && control !== 'back') return
      const sign = control === 'forward' ? 1 : -1
      const nx = position.x + heading.x * STEP * sign
      const nz = position.z + heading.z * STEP * sign
      const cx = Math.floor(nx)
      const cz = Math.floor(nz)
      const ahead = at(grid, cx, feetY, cz)
      if (control === 'forward') {
        if (
          ahead.boundingBox !== 'empty' &&
          open(cx, feetY + 1, cz) &&
          open(cx, feetY + 2, cz)
        ) {
          position.y = feetY + 1
        } else if (open(cx, feetY, cz) && open(cx, feetY - 1, cz)) {
          const floor = at(grid, cx, feetY - 2, cz)
          if (floor.boundingBox !== 'empty') position.y = feetY - 1
        }
      }
      position.x = nx
      position.z = nz
    },
    clearControlStates: () => undefined,
    canDigBlock: () => true,
    lookAt: async (point: { x: number; z: number }) => {
      const dx = point.x - position.x
      const dz = point.z - position.z
      const length = Math.hypot(dx, dz) || 1
      heading = { x: dx / length, z: dz / length }
    },
    digTime: () => 50,
    dig: async (block: { position: { x: number; y: number; z: number } }) => {
      dig(grid, block.position.x, block.position.y, block.position.z)
    },
    stopDigging: () => undefined,
    equip: async () => undefined,
    pathfinder: {
      movements: null as unknown,
      setMovements: (movements: unknown) => {
        bot.pathfinder.movements = movements
      },
      setGoal: () => {
        // the measured stock pathfinder's own refusal: canDig=false has no route,
        // which is what hands the leg to the control walker
        emit('path_update', { status: 'noPath' })
      },
      stop: () => undefined,
      getPathTo: () => {
        pathCalls += 1
        return { status: 'noPath', path: [] }
      },
    },
    emit,
  }
  return {
    bot: bot as unknown as Bot,
    position,
    trace,
    grid,
    pathCalls: () => pathCalls,
    writes: () => writes,
    executorRef,
  }
}

function moveCandidate(target: Vec3Json): Candidate {
  return {
    id: `MOVE:${target.x}_${target.y}_${target.z}`,
    kind: 'MOVE' as CandidateKind,
    label: `walk to (${target.x},${target.y},${target.z})`,
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

function retrieveCandidate(target: Vec3Json): Candidate {
  return {
    id: `RETRIEVE:known:blaze_rod:b${target.x}_${target.y}_${target.z}`,
    kind: 'RETRIEVE' as CandidateKind,
    label: `retrieve the remembered blaze rod at (${target.x},${target.y},${target.z})`,
    targetName: 'blaze_rod',
    target,
    targetEntityId: null,
    itemName: 'blaze_rod',
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {},
  }
}

interface WalkRun {
  result: ExecutionResult
  selectedBy: string | null
  position: Vec3
  trace: string[]
  messages: string[]
  starts: string[]
  legs: string[]
  ends: string[]
  boundaries: string[]
  stops: string[]
  elapsedMs: number
  pathCalls: number
  grid: Grid
  mechanicalReservations: MechanicalOwnershipObservation[]
  mechanicalOutcomes: MechanicalOwnershipObservation[]
}

interface MechanicalOwnershipObservation {
  stepId: string
  leg: number
  effectKind: 'locomotion'
  actionId: string | null
  authority: string | null
  transitionId: string | null
  commitmentId: string | null
  decisionEpoch: number | null
}

interface RunOptions {
  actuation?: 'pathfinder' | 'packet'
  maxStepsPerWaypoint?: number
  packetStepMs?: number
  pathTimeoutMs?: number
  claimContext?: Parameters<Executor['claim']>[1]
  hook?: (writes: number, bot: Bot, executor: Executor | null) => void
}

async function runWalk(
  feet: Vec3Json,
  grid: Grid,
  candidate: Candidate,
  options: RunOptions = {},
): Promise<WalkRun> {
  const dir = mkdtempSync(join(tmpdir(), 'walk-skill-'))
  const fixture = makeBot(feet, grid, options.hook)
  const logger = new EventLogger(new JsonlWriter(join(dir, 'agent.jsonl')), false)
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: options.actuation ?? 'packet',
    packetStepMs: options.packetStepMs ?? 1,
    maxStepsPerWaypoint: options.maxStepsPerWaypoint ?? defaultExecutorOptions.maxStepsPerWaypoint,
    pathTimeoutMs: options.pathTimeoutMs ?? defaultExecutorOptions.pathTimeoutMs,
  })
  fixture.executorRef.current = executor
  const startedAt = Date.now()
  const mechanicalReservations: MechanicalOwnershipObservation[] = []
  const mechanicalOutcomes: MechanicalOwnershipObservation[] = []
  const originalClaimContext = options.claimContext
  const observeOwnership = (
    step: { stepId: string; leg: number; effectKind: 'locomotion' },
  ): MechanicalOwnershipObservation => {
    const current = executor.current
    return {
      ...step,
      actionId: current?.id ?? null,
      authority: current?.authority ?? null,
      transitionId: current?.transitionId ?? null,
      commitmentId: current?.commitment?.commitmentId ?? null,
      decisionEpoch: current?.commitment?.decisionEpoch ?? null,
    }
  }
  const claimContext = originalClaimContext === undefined
    ? undefined
    : {
        ...originalClaimContext,
        beforeMechanicalStep: (step: { stepId: string; leg: number; effectKind: 'locomotion' }) => {
          mechanicalReservations.push(observeOwnership(step))
          return originalClaimContext.beforeMechanicalStep?.(step) ?? true
        },
        afterMechanicalStep: (step: { stepId: string; leg: number; effectKind: 'locomotion' }) => {
          mechanicalOutcomes.push(observeOwnership(step))
          return originalClaimContext.afterMechanicalStep?.(step) ?? true
        },
      }
  const claim = executor.claim(candidate, claimContext)
  const selectedBy = executor.current?.commitment?.selectedBy ?? null
  const result = await claim.completion
  const elapsedMs = Date.now() - startedAt
  const messages = (await Bun.file(join(dir, 'agent.jsonl')).text())
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as { message?: string }).message ?? '')
  const pick = (prefix: string, contains?: string): string[] =>
    messages.filter((line) => line.startsWith(prefix) && (contains === undefined || line.includes(contains)))
  return {
    result,
    selectedBy,
    position: fixture.position,
    trace: fixture.trace,
    messages,
    starts: pick(SKILL_START),
    legs: pick(SKILL_STEP, 'step=walk_leg'),
    ends: pick(SKILL_END),
    boundaries: pick(SKILL_POLICY_BOUNDARY),
    stops: pick(MOVE_LEG_STOPPED),
    elapsedMs,
    pathCalls: fixture.pathCalls(),
    grid,
    mechanicalReservations,
    mechanicalOutcomes,
  }
}

// ---------------------------------------------------------------------------
// VTR/legacy authority exclusion and VTR walk reservation seam
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 16, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 16, 64, 68, -1, 1, 'air')
  const dir = mkdtempSync(join(tmpdir(), 'walk-vtr-authority-'))
  const fixture = makeBot({ x: 0, y: 64, z: 0 }, grid)
  const logger = new EventLogger(new JsonlWriter(join(dir, 'agent.jsonl')), false)
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'packet',
    packetStepMs: 1,
  })
  fixture.executorRef.current = executor
  const candidate = moveCandidate({ x: 12, y: 64, z: 0 })
  const vtr = executor.claim(candidate, {
    authority: 'vtr-reach',
    transitionId: 'transition:reach-test',
    beforeMechanicalStep: () => true,
  })
  check(
    '(vtr) one active executor lease records the VTR transition owner',
    executor.current?.authority === 'vtr-reach' && executor.current.transitionId === 'transition:reach-test',
    `authority=${executor.current?.authority ?? 'none'} transition=${executor.current?.transitionId ?? 'none'}`,
  )
  let sameCandidateRejected = false
  try {
    executor.claim(candidate, { authority: 'legacy' })
  } catch (error) {
    sameCandidateRejected = error instanceof ExecutionAuthorityConflict
  }
  let competingActionRejected = false
  try {
    executor.claim(moveCandidate({ x: 8, y: 64, z: 0 }), { authority: 'legacy' })
  } catch (error) {
    competingActionRejected = error instanceof ExecutionAuthorityConflict
  }
  check(
    '(vtr) neither same-id adoption nor a new legacy claim can steal an active VTR body lease',
    sameCandidateRejected && competingActionRejected && executor.current?.authority === 'vtr-reach',
    `sameIdRejected=${sameCandidateRejected} competingRejected=${competingActionRejected} still=${executor.current?.authority ?? 'none'}`,
  )
  const sameTransition = executor.claim(candidate, {
    authority: 'vtr-reach',
    transitionId: 'transition:reach-test',
  })
  check(
    '(vtr) the same transition can reattach to its already-running mechanical action',
    sameTransition.kept && sameTransition.epoch === vtr.epoch,
    `kept=${sameTransition.kept} epoch=${sameTransition.epoch}/${vtr.epoch}`,
  )
  executor.cancelCurrent('authority fixture complete')
  await vtr.completion
}

{
  const grid: Grid = new Map()
  fill(grid, 0, 20, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 20, 64, 68, -1, 1, 'air')
  fill(grid, 8, 9, 64, 64, -1, 1, 'stone')
  fill(grid, 8, 9, 65, 68, -1, 1, 'air')
  let reservations = 0
  let outcomes = 0
  const run = await runWalk({ x: 0, y: 64, z: 0 }, grid, moveCandidate({ x: 16, y: 64, z: 0 }), {
    maxStepsPerWaypoint: 12,
    claimContext: {
      authority: 'vtr-reach',
      transitionId: 'transition:reach-walk-fixture',
      beforeMechanicalStep: () => {
        reservations += 1
        return true
      },
      afterMechanicalStep: () => {
        outcomes += 1
        return true
      },
    },
  })
  const start = run.starts[0] ?? ''
  const commitmentId = /(?:^|\s)commitmentId=([^\s]+)/.exec(start)?.[1] ?? null
  const decisionEpoch = /(?:^|\s)decisionEpoch=([^\s]+)/.exec(start)?.[1] ?? null
  const markerValue = (line: string, key: string): string | null =>
    new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(line)?.[1] ?? null
  const reservationKeys = run.mechanicalReservations.map(({ stepId, leg }) => `${leg}:${stepId}`)
  const outcomeKeys = run.mechanicalOutcomes.map(({ stepId, leg }) => `${leg}:${stepId}`)
  const expectedStepKeys = run.legs.map((_, index) => `${index + 1}:MOVE:16_64_0#${run.result.epoch}:walk-leg-${index + 1}`)
  const sameMechanicalOwner = (rows: readonly MechanicalOwnershipObservation[]): boolean =>
    rows.length >= 3 && rows.every((row) =>
      row.actionId === 'MOVE:16_64_0' &&
      row.authority === 'vtr-reach' &&
      row.transitionId === 'transition:reach-walk-fixture' &&
      row.commitmentId === commitmentId &&
      row.decisionEpoch === Number(decisionEpoch),
    )
  const legsHaveSameCommitment = commitmentId !== null && decisionEpoch !== null && run.legs.every((line, index) =>
    markerValue(line, 'commitmentId') === commitmentId &&
    markerValue(line, 'decisionEpoch') === decisionEpoch &&
    markerValue(line, 'authority') === 'MECHANICAL_CONTINUATION' &&
    markerValue(line, 'count') === String(index + 1),
  )
  check(
    '(vtr) walkSkill preserves VTR provenance and reserves every leg before movement',
    run.result.status === 'done' && reservations >= 3 && reservations === run.legs.length && outcomes === run.legs.length &&
      run.selectedBy === 'vtr_transition',
    `status=${run.result.status} selectedBy=${run.selectedBy} reservations=${reservations} outcomes=${outcomes} legs=${run.legs.length}`,
  )
  check(
    '(vtr) one VTR-selected SKILL_START/commitment/Transition owns every reserved mechanical leg through verified SUCCESS',
    run.starts.length === 1 &&
      start.includes('selectedBy=vtr-transition') &&
      commitmentId !== null && decisionEpoch !== null &&
      run.legs.length >= 3 && legsHaveSameCommitment &&
      sameMechanicalOwner(run.mechanicalReservations) && sameMechanicalOwner(run.mechanicalOutcomes) &&
      reservationKeys.length === run.legs.length && outcomeKeys.length === run.legs.length &&
      reservationKeys.every((key, index) => key === outcomeKeys[index] && key === expectedStepKeys[index]) &&
      run.ends.length === 1 &&
      run.ends[0]?.includes('outcome=SUCCESS') === true &&
      run.ends[0]?.includes(`commitmentId=${commitmentId}`) === true &&
      run.ends[0]?.includes(`decisionEpoch=${decisionEpoch}`) === true &&
      markerValue(start, 'candidateId') === 'MOVE:16_64_0' &&
      run.result.status === 'done' && run.result.verified,
    `starts=${run.starts.length} selected=${start.includes('selectedBy=vtr-transition')} commitment=${commitmentId ?? 'missing'} ` +
      `reservations=${run.mechanicalReservations.length} outcomes=${run.mechanicalOutcomes.length} legs=${run.legs.length} ` +
      `sameOwner=${sameMechanicalOwner(run.mechanicalReservations) && sameMechanicalOwner(run.mechanicalOutcomes)} ` +
      `stepJoin=${reservationKeys.every((key, index) => key === outcomeKeys[index] && key === expectedStepKeys[index])} ` +
      `verified=${run.result.verified} end=${run.ends[0] ?? 'missing'}`,
  )
}

const cell = (p: Vec3Json): string => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`

// ---------------------------------------------------------------------------
// (i) flat run with an intermediate blocked cell: ONE decision, many legs
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 24, 63, 63, -1, 1, 'stone') // floor: feet at y=64
  fill(grid, 0, 24, 64, 68, -1, 1, 'air')
  // the intermediate blocked cell: a one-block rise the walk must clear itself
  fill(grid, 8, 9, 64, 64, -1, 1, 'stone')
  fill(grid, 8, 9, 65, 68, -1, 1, 'air')
  const start: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 20, y: 64, z: 0 }
  const run = await runWalk(start, grid, moveCandidate(target), { maxStepsPerWaypoint: 12 })
  const arrived = cell(run.position) === cell(target)
  const actionsPerDecision = run.starts.length === 0 ? 0 : run.legs.length / run.starts.length
  check(
    '(i) ONE decision (one SKILL_START) buys the WHOLE traversal',
    run.starts.length === 1 && arrived,
    `starts=${run.starts.length} arrived=${arrived} end=(${run.position.x},${run.position.y},${run.position.z})`,
  )
  check(
    '(i) several mechanical legs run under that one commitment',
    run.legs.length >= 3,
    `legs=${run.legs.length} legLines=${JSON.stringify(run.legs.slice(0, 2))}`,
  )
  check(
    '(i) actionsPerDecision > 1 BY CONSTRUCTION (many steps, one decision)',
    actionsPerDecision > 1,
    `legs=${run.legs.length} decisions=${run.starts.length} actionsPerDecision=${num(actionsPerDecision)}`,
  )
  check(
    '(i) every leg is MECHANICAL_CONTINUATION evidence carrying the commitment id',
    run.legs.every((line) => line.includes('authority=MECHANICAL_CONTINUATION') && line.includes('commitmentId=')),
    `first=${run.legs[0] ?? 'none'}`,
  )
  check(
    '(i) exactly ONE SKILL_END, with the verified SUCCESS outcome',
    run.ends.length === 1 && run.ends[0]?.includes('outcome=SUCCESS') === true,
    `ends=${run.ends.length} line=${run.ends[0] ?? 'none'}`,
  )
  check(
    '(i) the intermediate blocked cell is cleared by locomotion only - no dig, no place, no guard refusal',
    run.stops.length === 0 &&
      run.boundaries.length === 0 &&
      !run.messages.some((line) => line.includes('MINE ') || line.includes('DIG_FAILED')) &&
      run.trace.filter((entry) => entry === 'jump').length === 0,
    `stops=${run.stops.length} boundaries=${run.boundaries.length} trace=${[...new Set(run.trace)].join(',')}`,
  )
  // LATENCY (the operator's other half): the whole traversal costs the mechanical
  // time of its legs, with no per-leg decision cycle in between.
  const msPerLeg = run.legs.length === 0 ? Number.NaN : run.elapsedMs / run.legs.length
  check(
    '(i) the traversal wall clock is the mechanical bound, not a per-leg decision cycle',
    run.elapsedMs < 4000 && msPerLeg < 1000,
    `elapsedMs=${run.elapsedMs} legs=${run.legs.length} msPerLeg=${num(msPerLeg)} (mechanical: ${num(12 * 1)}ms/leg of packet stepping)`,
  )
  process.stdout.write(
    `      (i) METRIC: decisions=${run.starts.length} mechanicalLegs=${run.legs.length} actionsPerDecision=${num(
      actionsPerDecision,
    )} commitmentMs=${run.elapsedMs}\n`,
  )
}

// ---------------------------------------------------------------------------
// (ii) the operator's exact case: a wall the bump-and-jump clears
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 16, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 16, 64, 68, -1, 1, 'air')
  fill(grid, 6, 6, 64, 64, -1, 1, 'stone') // a one-block wall across the run
  fill(grid, 6, 6, 65, 68, -1, 1, 'air')
  const start: Vec3Json = { x: 4, y: 64, z: 0 }
  const target: Vec3Json = { x: 12, y: 64, z: 0 }
  const run = await runWalk(start, grid, moveCandidate(target), {
    actuation: 'pathfinder',
    // the ordinary bump-and-jump recipe needs a few bounded hop windows; the
    // declared budget is the commitment's own (15 s in the live runner)
    pathTimeoutMs: 8000,
  })
  const arrived = cell(run.position) === cell(target)
  const jumped = run.trace.includes('jump')
  if (process.env.DEBUG_WALK !== undefined) process.stdout.write(`DEBUG(ii) pos=${run.position.x},${run.position.y},${run.position.z}\n${run.messages.join('\n')}\n`)
  check(
    '(ii) ONE commitment clears the wall with the ordinary bump-and-jump (no new decision)',
    run.starts.length === 1 && arrived && jumped,
    `starts=${run.starts.length} arrived=${arrived} jumped=${jumped} trace=${[...new Set(run.trace)].join(',')}`,
  )
  check(
    '(ii) the committed walk never gained dig/place authority from the wall',
    run.boundaries.length === 0 && !run.messages.some((line) => line.includes('SKILL_ENVELOPE_VIOLATION')),
    `boundaries=${run.boundaries.length} envelopeViolations=${run.messages.filter((l) => l.includes('SKILL_ENVELOPE_VIOLATION')).length}`,
  )
}

// ---------------------------------------------------------------------------
// (iii) a lethal step: the waypoint guard must END the commitment, typed
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  // THE MEASURED SHAPE (test-waypoint-hazard-guard.mts i-a): the fortress walkway
  // edge above the lava lake, 5 blocks below the lip.
  fill(grid, 26, 30, 54, 54, -21, -19, 'stone')
  fill(grid, 26, 30, 55, 58, -21, -19, 'air')
  fill(grid, 31, 40, 46, 50, -21, -19, 'lava')
  fill(grid, 31, 40, 51, 58, -21, -19, 'air')
  const start: Vec3Json = { x: 30, y: 55, z: -20 }
  const target: Vec3Json = { x: 38, y: 55, z: -20 }
  // the guard's MEASURED shape is a committed RETRIEVE approach leg
  // (test-waypoint-hazard-guard.mts i-a), so use that candidate kind here
  const run = await runWalk(start, grid, retrieveCandidate(target), { maxStepsPerWaypoint: 4 })
  const legsAfterStop = run.legs.length
  check(
    '(iii) the lethal step is refused BEFORE the body steps, with the typed guard reason',
    run.stops.length >= 1 &&
      (run.stops[0]?.includes('reason=hazard_between') === true || run.stops[0]?.includes('reason=unsafe_landing') === true),
    `stops=${run.stops.length} first=${run.stops[0] ?? 'none'}`,
  )
  check(
    '(iii) the commitment ENDS with the typed SAFETY_INTERRUPT outcome (control returns to policy)',
    run.ends.length === 1 &&
      run.ends[0]?.includes('outcome=SAFETY_INTERRUPT') === true &&
      run.ends[0]?.includes('failureCode=hazard_between') === true,
    `ends=${run.ends.length} line=${run.ends[0] ?? 'none'}`,
  )
  check(
    '(iii) the loop does NOT continue mechanically after the refusal',
    legsAfterStop <= 1 && run.boundaries.length === 0,
    `legs=${legsAfterStop} boundaries=${run.boundaries.length}`,
  )
}

// ---------------------------------------------------------------------------
// (iv) the world / the lease changes mid-walk: typed end, no further leg
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 24, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 24, 64, 68, -1, 1, 'air')
  const start: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 20, y: 64, z: 0 }
  const run = await runWalk(start, grid, moveCandidate(target), {
    maxStepsPerWaypoint: 6,
    hook: (writes, bot) => {
      // after the first leg's mechanical work, the body is in another world
      if (writes > 6) (bot.game as { dimension: string }).dimension = 'minecraft:the_nether'
    },
  })
  check(
    '(iv) a world/dimension change between legs ends the commitment WORLD_CHANGED',
    run.result.failure === 'world_changed' && run.ends[0]?.includes('outcome=WORLD_CHANGED') === true,
    `failure=${run.result.failure ?? 'none'} end=${run.ends[0] ?? 'none'}`,
  )
  check(
    '(iv) no further mechanical leg runs after the world change',
    run.legs.length <= 2 && run.position.x < target.x,
    `legs=${run.legs.length} x=${num(run.position.x)} target=${target.x}`,
  )
}
// ---------------------------------------------------------------------------
// (iv-b) the lease is revoked / a new decision supersedes the walk mid-flight
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 24, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 24, 64, 68, -1, 1, 'air')
  const start: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 20, y: 64, z: 0 }
  let cancelledAtStep = -1
  const run = await runWalk(start, grid, moveCandidate(target), {
    maxStepsPerWaypoint: 8,
    hook: (writes, _bot, executor) => {
      // the env-hazard reflex / a new decision cancels the in-flight commitment
      // within the tick (controller-legacy.ts#cancelInvalidCommitment ->
      // executor.cancelCurrent)
      if (writes === 10 && cancelledAtStep === -1) {
        cancelledAtStep = writes
        executor?.cancelCurrent('env hazard reflex: fire under the body')
      }
    },
  })
  check(
    '(iv-b) a revoked/superseded lease settles the walk as CANCELLED, typed',
    run.result.status === 'cancelled' &&
      (run.ends[0]?.includes('outcome=LEASE_REVOKED') === true || run.ends[0]?.includes('failureCode=cancelled') === true),
    `status=${run.result.status} failure=${run.result.failure ?? 'none'} end=${run.ends[0] ?? 'none'}`,
  )
  check(
    '(iv-b) the loop never swallows the abort: the walk stops at the first check, not at the target',
    run.position.x < target.x - 1,
    `x=${num(run.position.x)} target=${target.x} cancelAtWrite=${cancelledAtStep} legs=${run.legs.length}`,
  )
}

// ---------------------------------------------------------------------------
// (v) a remedy class the commitment was NOT granted: SKILL_POLICY_BOUNDARY,
//     and code performs NEITHER remedy
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 24, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 24, 64, 68, -1, 1, 'air')
  // a 2-block wall: not jumpable (vanilla apex 1.25), not steppable, and the
  // packet stepper's 1-level climb cannot clear it either. Both non-equivalent
  // remedy classes (dig the stone / bridge over it with a held block) exist in
  // the world and NEITHER is granted to this commitment.
  fill(grid, 6, 6, 64, 65, -1, 1, 'stone')
  const start: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 20, y: 64, z: 0 }
  const before = JSON.stringify([...grid.entries()])
  const run = await runWalk(start, grid, moveCandidate(target), { maxStepsPerWaypoint: 8 })
  const after = JSON.stringify([...run.grid.entries()])
  check(
    '(v) with only non-granted remedies left, the loop STOPS and states the policy boundary',
    run.boundaries.length >= 1 &&
      run.boundaries[0]?.startsWith(SKILL_POLICY_BOUNDARY) === true &&
      run.boundaries[0]?.includes('alternatives=[]') === true,
    `boundaries=${run.boundaries.length} first=${run.boundaries[0] ?? 'none'}`,
  )
  check(
    '(v) code chose NOTHING: no dig, no place, no envelope violation, and the world is unchanged',
    before === after && !run.messages.some((line) => line.includes('SKILL_ENVELOPE_VIOLATION')),
    `worldUnchanged=${before === after} envelopeViolations=${run.messages.filter((l) => l.includes('SKILL_ENVELOPE_VIOLATION')).length}`,
  )
  check(
    '(v) the commitment ends MECHANICALLY_BLOCKED so policy owns the replacement target/remedy',
    run.ends.length === 1 && run.ends[0]?.includes('outcome=MECHANICALLY_BLOCKED') === true,
    `end=${run.ends[0] ?? 'none'}`,
  )
}

// ---------------------------------------------------------------------------
// (vi) wall-clock budget exhaustion: a typed end, never a silent stop
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 60, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 60, 64, 68, -1, 1, 'air')
  const start: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 58, y: 64, z: 0 }
  const run = await runWalk(start, grid, moveCandidate(target), {
    maxStepsPerWaypoint: 20,
    packetStepMs: 3,
    pathTimeoutMs: 120,
  })
  check(
    '(vi) a spent budget ends the commitment BUDGET_EXHAUSTED (typed, not a silent stop)',
    run.ends[0]?.includes('outcome=BUDGET_EXHAUSTED') === true && run.result.failure === 'path_timeout',
    `failure=${run.result.failure ?? 'none'} end=${run.ends[0] ?? 'none'} elapsedMs=${run.elapsedMs}`,
  )
  check(
    '(vi) the budget is enforced in wall clock, not only in legs',
    run.elapsedMs < 2000 && run.position.x < target.x,
    `elapsedMs=${run.elapsedMs} legs=${run.legs.length} x=${num(run.position.x)}`,
  )
}

// ---------------------------------------------------------------------------
// (vii) an abort mid-walk (the env-hazard reflex path) wins within one step
// ---------------------------------------------------------------------------
{
  const grid: Grid = new Map()
  fill(grid, 0, 40, 63, 63, -1, 1, 'stone')
  fill(grid, 0, 40, 64, 68, -1, 1, 'air')
  const start: Vec3Json = { x: 0, y: 64, z: 0 }
  const target: Vec3Json = { x: 38, y: 64, z: 0 }
  let writesAtAbort = 0
  const run = await runWalk(start, grid, moveCandidate(target), {
    maxStepsPerWaypoint: 40,
    packetStepMs: 1,
    hook: (writes, _bot, executor) => {
      // the hazard appears under the body: the reflex preempts the commitment
      if (writesAtAbort === 0 && writes >= 8) {
        writesAtAbort = writes
        executor?.cancelCurrent('env hazard reflex: fire under the body')
      }
    },
  })
  check(
    '(vii) the abort wins within the in-flight walk (the loop is interruptible per step)',
    run.result.status === 'cancelled' && run.position.x < target.x / 2,
    `status=${run.result.status} x=${num(run.position.x)} writesAtAbort=${writesAtAbort} target=${target.x}`,
  )
  check(
    '(vii) the interrupted walk emitted a typed interrupt/end and no boundary it did not reach',
    run.ends.length === 1 && run.boundaries.length === 0,
    `end=${run.ends[0] ?? 'none'} boundaries=${run.boundaries.length}`,
  )
}

// ---------------------------------------------------------------------------
// structural bounds: the loop adds no planner and no fallback
// ---------------------------------------------------------------------------
{
  const source = await Bun.file(join(import.meta.dir, 'src', 'walkSkill.ts')).text()
  const executorSource = await Bun.file(join(import.meta.dir, 'src', 'executor.ts')).text()
  const loopStart = executorSource.indexOf('private async runWalkSkill(')
  const loopEnd = executorSource.indexOf('\n  private ', loopStart + 1)
  const loopBody = executorSource
    .slice(loopStart, loopEnd === -1 ? loopStart + 6000 : loopEnd)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
  check(
    '(bound) the walk-skill loop contains no route/remedy choice: no A* plan, no dig, no place, no pillar, no bridge',
    !/getPathTo|setGoal|digBlock|placeBlock|runBridge|pillar|verticalPlan|digRoute/.test(loopBody),
    `astarInLoop=${/getPathTo|setGoal/.test(loopBody)} digInLoop=${/digBlock/.test(loopBody)} placeInLoop=${/placeBlock/.test(loopBody)}`,
  )
  check(
    '(bound) the pure module re-declares no evidence marker and no target/effect contract',
    !/const SKILL_(START|STEP|END|POLICY_BOUNDARY)\s*=/.test(source) &&
      !/CausalTargetIdentity|mayDigGroundedRoute:\s*true|mayPlaceGroundedRoute:\s*true/.test(source),
    `markersRedeclared=${/const SKILL_(START|STEP|END|POLICY_BOUNDARY)\s*=/.test(source)}`,
  )
  check(
    '(bound) the portal-entry runner is untouched by the walk loop',
    executorSource.includes("case 'ENTER_PORTAL':") &&
      executorSource.includes('private async runEnterPortal(') &&
      !/runEnterPortal[\s\S]{0,200}runWalkSkill/.test(executorSource),
    `runEnterPortalPresent=${executorSource.includes('private async runEnterPortal(')}`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'WALK_SKILL_FIXTURES PASS' : `WALK_SKILL_FIXTURES FAIL (${failures})`}\n`)
process.exit(failures === 0 ? 0 : 1)
