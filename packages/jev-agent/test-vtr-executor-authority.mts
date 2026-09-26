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
import { fixtureClaimContext } from './test-claim-context.mts'

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

test('Executor serializes transition-owned MOVE authority across cancellation and cleanup', async () => {
  const fixture = makeBot()
  const logDir = mkdtempSync(join(tmpdir(), 'vtr-executor-authority-'))
  const logger = new JsonLogger(new JsonlWriter(join(logDir, 'executor.jsonl')), false) as EventLogger
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 10_000,
  })

  try {
    const first = executor.claim(moveCandidate('MOVE:first-transition', 20), fixtureClaimContext(moveCandidate('MOVE:first-transition', 20)))
    await waitFor(() => fixture.goalStarts() === 1, 'the active first MOVE to reach pathfinder')
    const firstAction = executor.current
    assert.ok(firstAction)
    assert.equal(firstAction.status, 'running')

    assert.equal(executor.cancelCurrent('replace first movement with Reach Transition'), true)
    const firstResult = await first.completion
    assert.equal(firstResult.status, 'cancelled')
    assert.equal(firstAction.status, 'cancelled')
    assert.equal(executor.current, null, 'the cancelled first lease is released before a VTR claim')
    assert.equal(fixture.goalClears(), 1)
    assert.equal(fixture.pathStops(), 1)

    const transitionId = 'transition:reach-authority-fixture'
    const vtr = executor.claim(moveCandidate('MOVE:vtr-transition', 30), {
      authorityLabel: 'vtr-reach',
      transitionId,
      transitionContractHash: 'contract:reach-authority-fixture',
    })
    await waitFor(() => fixture.goalStarts() === 2, 'the VTR-owned MOVE to reach pathfinder')
    const vtrAction = currentAction(executor)
    assert.ok(vtrAction)
    assert.equal(vtrAction.authorityLabel, 'vtr-reach')
    assert.equal(vtrAction.transitionId, transitionId)
    assert.equal(vtrAction.status, 'running')

    let unprovenancedRejected = false
    try {
      executor.claim(moveCandidate('MOVE:overlap-no-provenance', 40), {} as never)
    } catch (error) {
      unprovenancedRejected = error instanceof ExecutionAuthorityConflict
    }
    assert.equal(unprovenancedRejected, true, 'a claim without transition provenance is refused')

    let foreignRejected = false
    try {
      executor.claim(moveCandidate('MOVE:overlap-foreign-transition', 40), {
        authorityLabel: 'fixture',
        transitionId: 'transition:foreign',
        transitionContractHash: 'contract:foreign',
      })
    } catch (error) {
      foreignRejected = error instanceof ExecutionAuthorityConflict
    }
    assert.equal(foreignRejected, true, 'a foreign transition cannot start while the Reach lease is active')
    assert.equal(currentAction(executor), vtrAction, 'the VTR action retains body authority after the refused claim')
    assert.equal(vtrAction.status, 'running')
    assert.equal(fixture.goalStarts(), 2, 'a rejected claim never reaches pathfinder')
    assert.equal(executor.authorityConflictCount, 1)
    assert.equal(executor.maxConcurrentActions, 1)

    assert.equal(executor.cancelCurrent('finish VTR authority fixture'), true)
    const vtrResult = await vtr.completion
    assert.equal(vtrResult.status, 'cancelled')
    assert.equal(vtrAction.status, 'cancelled')
    assert.equal(executor.current, null, 'completion observes the released VTR lease')
    assert.equal(fixture.goalClears(), 2)
    assert.equal(fixture.pathStops(), 2)

    // A new transition-owned action may start only after the VTR completion
    // promise has settled and Executor.current reflects that cleanup.
    const afterCleanupCandidate = moveCandidate('MOVE:after-cleanup-transition', 50)
    const afterCleanup = executor.claim(afterCleanupCandidate, fixtureClaimContext(afterCleanupCandidate))
    await waitFor(() => fixture.goalStarts() === 3, 'a post-cleanup MOVE to reach pathfinder')
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
