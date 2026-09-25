import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { test } from 'bun:test'
import type { Candidate } from './src/candidates.ts'
import { ExecutionAuthorityConflict, Executor, defaultExecutorOptions } from './src/executor.ts'
import type { CurrentAction } from './src/executor.ts'
import type { EventLogger } from './src/jev.ts'
import { EventLogger as JsonLogger, JsonlWriter } from './src/jev.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

interface FakeMovementBot {
  readonly bot: Bot
  readonly goalStarts: () => number
  readonly goalClears: () => number
  readonly pathStops: () => number
}

function makeBot(): FakeMovementBot {
  const events = new EventEmitter()
  const position = new Vec3(0.5, 64, 0.5)
  let goalsStarted = 0
  let goalsCleared = 0
  let pathStops = 0
  const pathfinder = {
    movements: null as { maxDropDown?: number } | null,
    setMovements(movements: { maxDropDown?: number }): void {
      this.movements = movements
    },
    setGoal(goal: unknown | null): void {
      if (goal === null) goalsCleared += 1
      else goalsStarted += 1
      // Deliberately do not emit a path result. The real Executor therefore
      // keeps the MOVE active until the test cancels its actual path wait.
    },
    stop(): void {
      pathStops += 1
    },
    getPathTo: () => ({ status: 'noPath', path: [] }),
  }

  const bot = {
    registry,
    game: { dimension: 'minecraft:overworld' },
    health: 20,
    food: 20,
    heldItem: null,
    entity: {
      position,
      yaw: 0,
      pitch: 0,
      onGround: true,
      width: 0.6,
      height: 1.8,
      velocity: new Vec3(0, 0, 0),
    },
    inventory: {
      items: () => [],
      count: () => 0,
    },
    pathfinder,
    blockAt: () => null,
    stopDigging: () => undefined,
    clearControlStates: () => undefined,
    canDigBlock: () => false,
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
  } as unknown as Bot

  return {
    bot,
    goalStarts: () => goalsStarted,
    goalClears: () => goalsCleared,
    pathStops: () => pathStops,
  }
}

function moveCandidate(id: string, x: number): Candidate {
  return {
    id,
    kind: 'MOVE',
    label: `move to ${x},64,0`,
    targetName: null,
    target: { x, y: 64, z: 0 },
    targetEntityId: null,
    itemName: null,
    requiresTool: false,
    toolName: null,
    inReach: false,
    hasStandableAdjacent: true,
    meta: {},
  }
}

function currentAction(executor: Executor): CurrentAction | null {
  return executor.current
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
}

test('Executor serializes legacy and VTR MOVE authority across cancellation and cleanup', async () => {
  const fixture = makeBot()
  const logDir = mkdtempSync(join(tmpdir(), 'vtr-executor-authority-'))
  const logger = new JsonLogger(new JsonlWriter(join(logDir, 'executor.jsonl')), false) as EventLogger
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 10_000,
  })

  try {
    const legacy = executor.claim(moveCandidate('MOVE:legacy-first', 20), { authority: 'legacy' })
    await waitFor(() => fixture.goalStarts() === 1, 'the active legacy MOVE to reach pathfinder')
    const legacyAction = executor.current
    assert.ok(legacyAction)
    assert.equal(legacyAction.authority, 'legacy')
    assert.equal(legacyAction.status, 'running')

    assert.equal(executor.cancelCurrent('replace legacy movement with Reach Transition'), true)
    const legacyResult = await legacy.completion
    assert.equal(legacyResult.status, 'cancelled')
    assert.equal(legacyAction.status, 'cancelled')
    assert.equal(executor.current, null, 'the cancelled legacy lease is released before a VTR claim')
    assert.equal(fixture.goalClears(), 1)
    assert.equal(fixture.pathStops(), 1)

    const transitionId = 'transition:reach-authority-fixture'
    const vtr = executor.claim(moveCandidate('MOVE:vtr-transition', 30), {
      authority: 'vtr-reach',
      transitionId,
      transitionContractHash: 'contract:reach-authority-fixture',
    })
    await waitFor(() => fixture.goalStarts() === 2, 'the VTR-owned MOVE to reach pathfinder')
    const vtrAction = currentAction(executor)
    assert.ok(vtrAction)
    assert.equal(vtrAction.authority, 'vtr-reach')
    assert.equal(vtrAction.transitionId, transitionId)
    assert.equal(vtrAction.status, 'running')

    let legacyRejected = false
    try {
      executor.claim(moveCandidate('MOVE:legacy-overlap', 40), { authority: 'legacy' })
    } catch (error) {
      legacyRejected = error instanceof ExecutionAuthorityConflict
    }
    assert.equal(legacyRejected, true, 'legacy cannot start while the Reach lease is active')
    assert.equal(currentAction(executor), vtrAction, 'the VTR action retains body authority after the refused claim')
    assert.equal(vtrAction.status, 'running')
    assert.equal(fixture.goalStarts(), 2, 'a rejected legacy claim never reaches pathfinder')
    assert.equal(executor.authorityConflictCount, 1)
    assert.equal(executor.maxConcurrentActions, 1)

    assert.equal(executor.cancelCurrent('finish VTR authority fixture'), true)
    const vtrResult = await vtr.completion
    assert.equal(vtrResult.status, 'cancelled')
    assert.equal(vtrAction.status, 'cancelled')
    assert.equal(executor.current, null, 'completion observes the released VTR lease')
    assert.equal(fixture.goalClears(), 2)
    assert.equal(fixture.pathStops(), 2)

    // A new legacy action may start only after the VTR completion promise has
    // settled and Executor.current reflects that cleanup.
    const afterCleanup = executor.claim(moveCandidate('MOVE:legacy-after-cleanup', 50), { authority: 'legacy' })
    await waitFor(() => fixture.goalStarts() === 3, 'a post-cleanup legacy MOVE to reach pathfinder')
    assert.equal(currentAction(executor)?.authority, 'legacy')
    assert.equal(currentAction(executor)?.status, 'running')
    assert.equal(executor.maxConcurrentActions, 1)
    assert.equal(executor.cancelCurrent('fixture cleanup'), true)
    assert.equal((await afterCleanup.completion).status, 'cancelled')
    assert.equal(executor.current, null)
  } finally {
    executor.cancelCurrent('fixture teardown')
    rmSync(logDir, { recursive: true, force: true })
  }
})
