// test-smelt-charcoal-abandon.mts - live boundary: the charcoal smelt was
// abandoned every tick but the abandon was never enforced, so SMELT_DONE never
// fired.
//
// Measured live (run-mu88gxwt-r6vt, main 36ecb42):
//   [guard] REJECTED SMELT:charcoal code=NO_PATH :: no canDig=false path to
//           (23,69,24) (GoalBlock probe)
//   JEV_HEADS action=SMELT:charcoal abandon=1 decision=continue
//             abandonRequested=true betaAuthority=false betaShadowed=true
//             abandonEnforced=false abandonSuppressed=true attempts=0
//   SMELT_INPUT_PREREQ item=charcoal input=oak_log present=true action=none
// state.furnaces = [{23,69,24,sensed}, {8,65,24,remembered}, {37,30,37,remembered}]
//
// Two facts held the loop open:
//   1. `smeltCandidates` picked the FIRST sensed furnace; when it was
//      path-unreachable the guard rejected the SMELT NO_PATH every tick and the
//      acquisition ladder was never generated.
//   2. A guard-rejected candidate never reaches `onActionComplete`, so the
//      unproductive attempt counter stayed at 0 and the abandon was suppressed
//      as "speculative" forever (`abandonEnforced=false`).
//
// This suite locks the two bounded outcomes:
//   (a) input+fuel held and a REACHABLE sensed furnace completes, and the done
//       path emits SMELT_DONE only on real production (an output gain OR the
//       consumed input+fuel of `isSmeltPostconditionMet`, never a no-op);
//   (b) a smelt that cannot complete retires the station/option with a typed
//       reason instead of oscillating with `abandonEnforced=false`.
//
// Pure: no bot, no network, no model.
import { readFileSync } from 'node:fs'
import { defaultCandidateOptions, generateGroundedCandidates } from './src/candidates.ts'
import type { Candidate } from './src/candidates.ts'
import { guardCandidate, guardRejectionChargesOption } from './src/policy.ts'
import { guardMoveFailureReason } from './src/controller.ts'
import { executeFurnaceSmelt, formatSmeltLog } from './src/executor.ts'
import type { SmeltFurnaceWindow } from './src/executor.ts'
import { isSmeltPostconditionMet } from './src/actionPostcondition.ts'
import {
  classifyAbandonRequest,
  formatAbandonEnforced,
  OptionAttemptTracker,
  UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT,
} from './src/abandonPolicy.ts'
import { filterBlacklistedMoves, MoveFailMemory, moveFailureKey } from './src/moveFailMemory.ts'
import { knownStationKey } from './src/prereqOption.ts'
import { emptyGoalQueueState } from './src/goalQueue.ts'
import type { GoalQueueState, QueuedGoal } from './src/goalQueue.ts'
import type { AgentSignals, GoalState, InventoryState, StationEntry, Vec3Json, WorldState } from './src/state.ts'

let failures = 0
async function check(label: string, ok: boolean, detail: string): Promise<void> {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const source = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8')

// --- world state builders (mirror test-reachability) ---------------------------

function self(position: Vec3Json): WorldState['self'] {
  return {
    username: 'AI_SMELT',
    position,
    eyePosition: { x: position.x, y: position.y + 1.62, z: position.z },
    yaw: 0,
    pitch: 0,
    onGround: true,
    health: 20,
    food: 20,
    gameMode: 'survival',
    dimension: 'overworld',
    isDay: true,
    heldItem: null,
  }
}

function inventory(counts: Record<string, number>): InventoryState {
  const slots = Object.entries(counts).map(([name, count], slot) => ({ name, count, slot }))
  return { slots, counts, totalItems: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

function signals(overrides: Partial<AgentSignals> = {}): AgentSignals {
  return {
    consecutiveFailures: 0,
    lastFailureCode: null,
    lastPathStatus: 'idle',
    stalledMs: 0,
    lastPolicyConfidence: null,
    maxConcurrentActions: 0,
    escalationRecommended: false,
    failedCandidates: {},
    knownResources: [],
    ...overrides,
  }
}

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: 'smelt:charcoal',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    progress: 0,
    complete: false,
    startedAtMs: 0,
    ...overrides,
  }
}

function queuedGoal(overrides: Partial<QueuedGoal> = {}): QueuedGoal {
  return {
    id: 'g-smelt',
    kind: 'smelt',
    description: 'smelt 1 x charcoal',
    targetItem: 'charcoal',
    requiredCount: 1,
    startCount: 0,
    haveCount: 0,
    status: 'active',
    origin: 'llm',
    createdAt: 0,
    updatedAt: 0,
    detail: null,
    ...overrides,
  }
}

function queueWith(current: QueuedGoal | null): GoalQueueState {
  if (current === null) return emptyGoalQueueState()
  return { depth: 1, current, empty: false, hasImpossible: false, done: 0, goals: [current] }
}

function worldState(overrides: {
  position: Vec3Json
  inventory?: InventoryState
  signals?: AgentSignals
  furnaces?: StationEntry[]
  goal?: GoalState
  goalQueue?: GoalQueueState
}): WorldState {
  return {
    schemaVersion: 1,
    tick: 7,
    timestampMs: 1_700_000_000_000,
    self: self(overrides.position),
    inventory: overrides.inventory ?? inventory({}),
    entities: [],
    blocks: [],
    terrain: { standable: [overrides.position] },
    craftingTables: [],
    furnaces: overrides.furnaces ?? [],
    placementSpots: [],
    descent: [],
    stepCuts: [],
    headroomCuts: [],
    goal: overrides.goal ?? goal(),
    goalQueue: overrides.goalQueue ?? queueWith(queuedGoal()),
    recentEvents: [],
    signals: overrides.signals ?? signals(),
  }
}

// --- executor fixture: a real furnace window, no bot ---------------------------

interface CharcoalSmeltFixture {
  outcome: Awaited<ReturnType<typeof executeFurnaceSmelt>>
  stash: Record<string, number>
  lines: string[]
}

async function runCharcoalSmelt(options: { produce: boolean; consumeSlots: boolean; timeoutMs: number }): Promise<CharcoalSmeltFixture> {
  const stash: Record<string, number> = { oak_log: 1, birch_planks: 1, charcoal: 0 }
  const placed = { input: 0, fuel: 0 }
  let pending = 0
  const window: SmeltFurnaceWindow = {
    putInput: async (_type, _meta, count) => {
      pending = options.produce ? count : 0
      placed.input = count
      stash.oak_log = (stash.oak_log ?? 0) - count
    },
    putFuel: async (_type, _meta, count) => {
      placed.fuel = count
      stash.birch_planks = (stash.birch_planks ?? 0) - count
    },
    outputItem: () => (pending > 0 ? { count: 1 } : null),
    takeOutput: async () => {
      pending -= 1
      stash.charcoal = (stash.charcoal ?? 0) + 1
    },
    inputItem: () => (options.consumeSlots ? null : { count: placed.input }),
    fuelItem: () => (options.consumeSlots ? null : { count: placed.fuel }),
    close: () => undefined,
  }
  const lines: string[] = []
  const outcome = await executeFurnaceSmelt(
    {
      openFurnace: async () => window,
      inventoryItems: () => Object.entries(stash).map(([name, count], index) => ({ name, type: index, count })),
      countItem: (name) => stash[name] ?? 0,
      wait: async () => undefined,
      ensureOwned: () => undefined,
      timeoutMs: options.timeoutMs,
      log: (event, detail) => lines.push(formatSmeltLog(event, detail)),
    },
    { inputItem: 'oak_log', fuelItem: 'birch_planks', outputItem: 'charcoal', inputCount: 1, fuelCount: 1 },
  )
  return { outcome, stash, lines }
}

// --- executor fixture: the live open-window inventory race --------------------
//
// Live run-mu89hsqv-rcy0: the furnace consumed oak_log + birch_planks and the
// charcoal landed, but `SMELT_UNPRODUCED item=charcoal gained=0 placedInput=1
// placedFuel=1 consumedInput=true consumedFuel=true` was logged; `charcoal:1`
// was in the inventory 2 ms later. Mineflayer keeps an open container window's
// player-inventory slots out of `bot.inventory` until `close()` (copyInventory
// is called only from closeWindow), so a count taken while the furnace window
// is open cannot see an output that has already been taken from the window.

interface WindowRaceFixtureOptions {
  /** the output slot already holds the product when the run starts */
  outputInWindowAtStart: boolean
  /** poll iterations after which the output slot holds the product (null = never) */
  outputAfterPolls: number | null
  /** the input/fuel slots report an empty (consumed) stack */
  consumeSlots: boolean
  timeoutMs: number
}

async function runWindowRaceSmelt(options: WindowRaceFixtureOptions): Promise<CharcoalSmeltFixture> {
  const stash: Record<string, number> = { oak_log: 1, birch_planks: 1, charcoal: 0 }
  let open = false
  let frozen = 0
  let polls = 0
  let pending = options.outputInWindowAtStart ? 1 : 0
  const window: SmeltFurnaceWindow = {
    putInput: async () => {
      stash.oak_log = 0
    },
    putFuel: async () => {
      stash.birch_planks = 0
    },
    outputItem: () => (pending > 0 ? { count: 1 } : null),
    takeOutput: async () => {
      pending -= 1
      stash.charcoal = (stash.charcoal ?? 0) + 1
    },
    inputItem: () => (options.consumeSlots ? null : { count: 1 }),
    fuelItem: () => (options.consumeSlots ? null : { count: 1 }),
    close: () => {
      open = false
    },
  }
  const lines: string[] = []
  const outcome = await executeFurnaceSmelt(
    {
      openFurnace: async () => {
        open = true
        frozen = stash.charcoal ?? 0
        return window
      },
      inventoryItems: () => Object.entries(stash).map(([name, count], index) => ({ name, type: index, count })),
      // Mirrors mineflayer: while the furnace window is open the bot-inventory
      // count is frozen at its pre-open value; close() folds the window's
      // player-inventory slots back in.
      countItem: (name) => (open ? frozen : (stash[name] ?? 0)),
      wait: async () => {
        polls += 1
        if (options.outputAfterPolls !== null && polls >= options.outputAfterPolls) pending = 1
        await new Promise((resolve) => setTimeout(resolve, 1))
      },
      ensureOwned: () => undefined,
      timeoutMs: options.timeoutMs,
      log: (event, detail) => lines.push(formatSmeltLog(event, detail)),
    },
    { inputItem: 'oak_log', fuelItem: 'birch_planks', outputItem: 'charcoal', inputCount: 1, fuelCount: 1 },
  )
  return { outcome, stash, lines }
}

// ----------------------------------------------------------------------------

const LIVE_FEET: Vec3Json = { x: 29.5, y: 65, z: 34.5 }
const UNREACHABLE_FURNACE: StationEntry = { x: 23, y: 69, z: 24, source: 'sensed' }
const REACHABLE_FURNACE: StationEntry = { x: 35, y: 65, z: 34, source: 'sensed' }
const UNREACHABLE_KEY = knownStationKey({ name: 'furnace', position: { x: UNREACHABLE_FURNACE.x, y: UNREACHABLE_FURNACE.y, z: UNREACHABLE_FURNACE.z } })

const REMEMBERED_NEAR_FURNACE: StationEntry = { x: 8, y: 65, z: 24, source: 'remembered' }
const REMEMBERED_FAR_FURNACE: StationEntry = { x: 16, y: 64, z: 11, source: 'remembered' }

/** The live guard probe: the placed furnace cell cannot be pathed to. */
const livePathProbe = (position: Vec3Json): boolean =>
  !(position.x === UNREACHABLE_FURNACE.x && position.y === UNREACHABLE_FURNACE.y && position.z === UNREACHABLE_FURNACE.z)

function smeltState(furnaces: StationEntry[]): WorldState {
  return worldState({
    position: LIVE_FEET,
    inventory: inventory({ oak_log: 1, birch_planks: 1 }),
    furnaces,
    goal: goal(),
    goalQueue: queueWith(queuedGoal()),
  })
}

function smeltOptions(unreachable: ReadonlySet<string>): typeof defaultCandidateOptions {
  return { ...defaultCandidateOptions, unreachableStations: unreachable, reachability: { memory: null } }
}

async function main(): Promise<void> {
  process.stdout.write('smelt charcoal abandon boundary: complete when reachable, retire when not\n')
  process.stdout.write('-'.repeat(78) + '\n')

  // A remembered station projection is deliberately kept in `state.furnaces`
  // for Jev perception even after the controller filters an unreachable
  // resource out of `signals.knownResources`. Candidate generation must not
  // re-introduce that filtered coordinate: the guard and the generator must
  // agree on the same durable truth source.
  {
    const state = worldState({
      position: LIVE_FEET,
      inventory: inventory({ oak_log: 1, birch_planks: 1 }),
      furnaces: [REMEMBERED_NEAR_FURNACE, REMEMBERED_FAR_FURNACE],
      signals: signals({
        knownResources: [
          { name: 'furnace', kind: 'station', position: { x: REMEMBERED_FAR_FURNACE.x, y: REMEMBERED_FAR_FURNACE.y, z: REMEMBERED_FAR_FURNACE.z } },
        ],
      }),
    })
    const grounded = generateGroundedCandidates(state, {
      ...defaultCandidateOptions,
      unreachableStations: new Set([knownStationKey({ name: 'furnace', position: REMEMBERED_NEAR_FURNACE })]),
      reachability: { memory: null },
    })
    const retrieve = grounded.candidates.find((entry) => entry.kind === 'RETRIEVE')
    await check(
      '(truth) a filtered remembered furnace is not re-injected from state.furnaces',
      retrieve !== undefined &&
        retrieve.target !== null &&
        retrieve.target.x === REMEMBERED_FAR_FURNACE.x &&
        retrieve.target.y === REMEMBERED_FAR_FURNACE.y &&
        retrieve.target.z === REMEMBERED_FAR_FURNACE.z &&
        !grounded.candidates.some((entry) => entry.id === 'RETRIEVE:known:station:furnace:b8_65_24'),
      `ids=[${grounded.candidates.map((entry) => entry.id).join(',')}]`,
    )
  }

  // (a) a reachable sensed furnace is selected, clears the guard, and the done
  // path emits SMELT_DONE only on a real gain. Pre-fix `smeltCandidates` picked
  // the FIRST sensed furnace (23,69,24), so this target assertion fails.
  {
    const state = smeltState([UNREACHABLE_FURNACE, REACHABLE_FURNACE])
    const options = smeltOptions(new Set([UNREACHABLE_KEY]))
    const grounded = generateGroundedCandidates(state, options)
    const candidate = grounded.candidates.find((entry) => entry.id === 'SMELT:charcoal')
    const guarded =
      candidate === undefined
        ? null
        : guardCandidate(candidate, state, {
            phase: 'decision',
            candidateIds: new Set(grounded.candidates.map((entry) => entry.id)),
            inFlight: null,
            reach: options.reach,
            maxCandidateAgeTicks: 20,
            canComputePath: livePathProbe,
          })
    await check(
      '(a1) a held input+fuel targets the reachable sensed furnace, not the first (unreachable) one',
      candidate !== undefined &&
        candidate.target !== null &&
        candidate.target.x === REACHABLE_FURNACE.x &&
        candidate.target.y === REACHABLE_FURNACE.y &&
        candidate.target.z === REACHABLE_FURNACE.z,
      `target=${candidate?.target === null || candidate?.target === undefined ? 'none' : `${candidate.target.x},${candidate.target.y},${candidate.target.z}`} ids=[${grounded.candidates.map((entry) => entry.id).join(',')}]`,
    )
    await check(
      '(a2) the reachable-furnace SMELT clears the mechanical guard (only the unreachable cell has no path)',
      guarded !== null && guarded.ok === true,
      guarded === null ? 'no candidate' : guarded.ok ? `ok ${guarded.candidate.id}` : `code=${guarded.code} :: ${guarded.reason}`,
    )

    const done = await runCharcoalSmelt({ produce: true, consumeSlots: false, timeoutMs: 5000 })
    const doneLine = done.lines.find((line) => line.startsWith('SMELT_DONE')) ?? ''
    await check(
      '(a3) the executor done path emits SMELT_DONE with a real inventory gain',
      done.outcome.gained === 1 &&
        done.stash.charcoal === 1 &&
        isSmeltPostconditionMet(done.outcome) === true &&
        doneLine.includes('gained=1') &&
        doneLine.includes('item=charcoal'),
      doneLine === '' ? 'no SMELT_DONE line' : doneLine,
    )

    const unproduced = await runCharcoalSmelt({ produce: false, consumeSlots: false, timeoutMs: 0 })
    const unproducedDone = unproduced.lines.find((line) => line.startsWith('SMELT_DONE'))
    await check(
      '(a4) SMELT_DONE semantics are intact: no output gain never emits SMELT_DONE',
      unproduced.outcome.gained === 0 &&
        unproducedDone === undefined &&
        isSmeltPostconditionMet(unproduced.outcome) === false,
      `gained=${unproduced.outcome.gained} lines=[${unproduced.lines.join(' | ')}]`,
    )
  }

  // (c) the live open-window inventory race: production in the furnace window is
  // invisible to bot.inventory until close(), so the old count-based detection
  // read gained=0 and logged SMELT_UNPRODUCED for a smelt that actually produced.
  {
    // (c1) output taken from the window during the poll (stale bot.inventory).
    const inLoop = await runWindowRaceSmelt({
      outputInWindowAtStart: true,
      outputAfterPolls: null,
      consumeSlots: true,
      timeoutMs: 25,
    })
    const inLoopDone = inLoop.lines.find((line) => line.startsWith('SMELT_DONE')) ?? ''
    await check(
      '(c1) an output harvested from the open window reports produced and emits SMELT_DONE with the true gain',
      inLoop.outcome.gained === 1 &&
        inLoop.stash.charcoal === 1 &&
        inLoopDone.includes('gained=1') &&
        inLoopDone.includes('item=charcoal') &&
        !inLoop.lines.some((line) => line.startsWith('SMELT_UNPRODUCED')),
      inLoopDone === '' ? `no SMELT_DONE line [${inLoop.lines.join(' | ')}]` : inLoopDone,
    )

    // (c2) output already in the output slot at/after the last poll (the poll
    // window closes before the count can see it: commit evidence at capture).
    const atCapture = await runWindowRaceSmelt({
      outputInWindowAtStart: true,
      outputAfterPolls: null,
      consumeSlots: true,
      timeoutMs: 0,
    })
    const atCaptureDone = atCapture.lines.find((line) => line.startsWith('SMELT_DONE')) ?? ''
    await check(
      '(c2) an output sitting in the window at capture is swept and emits SMELT_DONE with the true gain',
      atCapture.outcome.gained === 1 &&
        atCapture.stash.charcoal === 1 &&
        atCaptureDone.includes('gained=1') &&
        !atCapture.lines.some((line) => line.startsWith('SMELT_UNPRODUCED')),
      atCaptureDone === '' ? `no SMELT_DONE line [${atCapture.lines.join(' | ')}]` : atCaptureDone,
    )

    // (c3) genuine no-op: nothing gained, nothing consumed -> never SMELT_DONE.
    const noop = await runWindowRaceSmelt({
      outputInWindowAtStart: false,
      outputAfterPolls: null,
      consumeSlots: false,
      timeoutMs: 25,
    })
    const noopDone = noop.lines.find((line) => line.startsWith('SMELT_DONE'))
    await check(
      '(c3) a no-op (no output, no consumed input+fuel) still reports unproduced',
      noop.outcome.gained === 0 &&
        noop.outcome.consumedInput === false &&
        noop.outcome.consumedFuel === false &&
        noopDone === undefined &&
        isSmeltPostconditionMet(noop.outcome) === false,
      `gained=${noop.outcome.gained} lines=[${noop.lines.join(' | ')}]`,
    )

    // (c4) consumed input+fuel is real production even before the output is
    // countable: the OR clause of isSmeltPostconditionMet earns SMELT_DONE.
    const consumed = await runWindowRaceSmelt({
      outputInWindowAtStart: false,
      outputAfterPolls: null,
      consumeSlots: true,
      timeoutMs: 25,
    })
    const consumedDone = consumed.lines.find((line) => line.startsWith('SMELT_DONE')) ?? ''
    await check(
      '(c4) consumed input+fuel emits SMELT_DONE (the OR production predicate) with the measured gain',
      consumed.outcome.gained === 0 &&
        consumed.outcome.consumedInput === true &&
        consumed.outcome.consumedFuel === true &&
        isSmeltPostconditionMet(consumed.outcome) === true &&
        consumedDone.includes('gained=0'),
      consumedDone === '' ? `no SMELT_DONE line [${consumed.lines.join(' | ')}]` : consumedDone,
    )
  }

  // (b) a furnace that cannot be pathed to is retired with a typed reason
  // instead of the `abandonEnforced=false` oscillation. Pre-fix a SMELT NO_PATH
  // is not a tracked target failure, so it never retires and the option counter
  // stays at 0 (suppressed as speculative).
  {
    const stationFailure = guardMoveFailureReason({ kind: 'SMELT' }, 'NO_PATH')
    await check(
      '(b1) a SMELT guard NO_PATH is a tracked station failure with the typed reason unreachable',
      stationFailure === 'unreachable',
      `reason=${stationFailure ?? 'null'}`,
    )

    const memory = new MoveFailMemory({ failureLimit: 3, cooldownMs: 10_000, now: () => 1_000 })
    for (let attempt = 0; attempt < 3; attempt += 1) {
      memory.record('overworld', UNREACHABLE_FURNACE, 'unreachable')
    }
    const blacklisted = memory.isBlacklisted('overworld', UNREACHABLE_FURNACE)
    await check(
      '(b2) the unreachable furnace cell is blacklisted after the bounded limit',
      blacklisted && moveFailureKey('overworld', UNREACHABLE_FURNACE) === 'overworld:23,69,24',
      `blacklisted=${blacklisted} key=${moveFailureKey('overworld', UNREACHABLE_FURNACE)}`,
    )

    // Once blacklisted, the station is in the explicit unreachable set and the
    // direct SMELT for it is no longer offered; the acquisition ladder gets a turn.
    const state = smeltState([UNREACHABLE_FURNACE])
    const options = smeltOptions(new Set([UNREACHABLE_KEY]))
    const grounded = generateGroundedCandidates(state, options)
    const stillOffersUnreachable = grounded.candidates.some(
      (entry: Candidate) => entry.kind === 'SMELT' && entry.target?.x === UNREACHABLE_FURNACE.x,
    )
    const filtered = filterBlacklistedMoves(
      [{ kind: 'SMELT', target: UNREACHABLE_FURNACE }],
      memory,
      'overworld',
    )
    await check(
      '(b3) an unreachable-only sensed furnace is not re-offered as a direct SMELT',
      stillOffersUnreachable === false && filtered.kept.length === 0 && filtered.skipped.length === 1,
      `offered=${stillOffersUnreachable} candidates=[${grounded.candidates.map((entry) => entry.id).join(',')}] filtered=${filtered.skipped.length}`,
    )

    const optionId = 'smelt:charcoal'
    const planId = 'g-live:smelt:charcoal'
    const limit = UNPRODUCTIVE_ATTEMPT_LIMIT_DEFAULT
    const tracker = new OptionAttemptTracker()
    for (let attempt = 0; attempt < limit; attempt += 1) {
      tracker.noteOutcome({ optionId, planId, verified: false, progressDelta: 0 }, 1_000 + attempt)
    }
    const enforced = classifyAbandonRequest({
      abandonRequested: true,
      betaAuthority: false,
      attempts: tracker.attemptsFor(optionId, planId),
      lastVerified: false,
      lastProgressDelta: 0,
      attemptLimit: limit,
      alreadyAbandoned: false,
    })
    const enforcedLine = formatAbandonEnforced({
      optionId,
      attempts: enforced.attempts,
      verified: false,
      progressDelta: 0,
      betaAuthority: false,
      betaShadowed: true,
      abandonRequested: true,
    })
    await check(
      '(b4) after the bounded attempts the abandon is ENFORCED (not the endless speculative suppression)',
      enforced.action === 'abandon' &&
        enforced.enforced === true &&
        enforced.reason === 'unproductive' &&
        enforcedLine.includes('action=abandon') &&
        enforcedLine.includes('reason=unproductive'),
      enforcedLine,
    )

    const suppressed = classifyAbandonRequest({
      abandonRequested: true,
      betaAuthority: false,
      attempts: 0,
      lastVerified: false,
      lastProgressDelta: 0,
      attemptLimit: limit,
      alreadyAbandoned: false,
    })
    await check(
      '(b5) control: with no charged attempts the request stays speculative/abandonEnforced=false (the old oscillation)',
      suppressed.action === 'continue' && suppressed.enforced === false && suppressed.reason === 'speculative',
      `action=${suppressed.action} enforced=${suppressed.enforced} reason=${suppressed.reason}`,
    )

    const codeTable = {
      noPath: guardRejectionChargesOption('NO_PATH'),
      noSupport: guardRejectionChargesOption('NO_SUPPORT'),
      lava: guardRejectionChargesOption('LAVA_RISK'),
      conflict: guardRejectionChargesOption('CONFLICT_IN_FLIGHT'),
      stale: guardRejectionChargesOption('STALE_COORDS'),
      done: guardRejectionChargesOption('ALREADY_DONE'),
    }
    await check(
      '(b6) the charge table counts only hard unreachability failures, never deferrals',
      codeTable.noPath &&
        codeTable.noSupport &&
        codeTable.lava &&
        !codeTable.conflict &&
        !codeTable.stale &&
        !codeTable.done,
      JSON.stringify(codeTable),
    )
  }

  // The wiring: the controller charges the option on a mechanical rejection and
  // the generator skips a proven-unreachable sensed furnace.
  {
    const controller = `${source('./src/controller.ts')}\n${source('./src/controller-legacy.ts')}`
    const policy = source('./src/policy.ts')
    const candidates = source('./src/candidates.ts')
    const moveFail = source('./src/moveFailMemory.ts')
    const wired =
      controller.includes('chargeGuardRejection(') &&
      controller.includes('guardRejectionChargesOption(') &&
      policy.includes('export function guardRejectionChargesOption') &&
      candidates.includes('function reachableSensedFurnace') &&
      moveFail.includes("'SMELT'")
    await check(
      '(b7) the guard-rejection charge and the sensed-furnace reachability skip are wired',
      wired,
      `controllerCharge=${controller.includes('chargeGuardRejection(')} helper=${policy.includes('export function guardRejectionChargesOption')} smeltTracked=${moveFail.includes("'SMELT'")} reachableSensed=${candidates.includes('function reachableSensedFurnace')}`,
    )
  }

  process.stdout.write('-'.repeat(78) + '\n')
  process.stdout.write(`smelt-charcoal-abandon: ${failures === 0 ? 'OK' : `${failures} FAILURE(S)`}\n`)
  if (failures > 0) process.exit(1)
}

await main()
