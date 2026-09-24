import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Vec3 } from 'vec3'
import type { Bot } from 'mineflayer'
import { JevController } from './src/controller-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import { Executor, defaultExecutorOptions } from './src/executor.ts'
import type { CurrentAction } from './src/executor.ts'
import type { EventLogger } from './src/jev.ts'
import { EventLogger as JsonLogger, JsonlWriter } from './src/jev.ts'
import {
  ReachController,
  type ReachRoute,
  type ReachRuntimeSnapshot,
} from './src/vtr/reach-controller.ts'
import {
  createReachTransitionContract,
  type ReachIdentity,
  type ReachTerminalOutcome,
  type ReachTransitionState,
  type ReachTransitionContract,
} from './src/vtr/reach.ts'

const require = createRequire(import.meta.url)
const registry = require('minecraft-data')('1.21.11')

const identity: ReachIdentity = {
  worldKey: 'authority-test-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
  generationId: 'authority-test-generation',
  leaseId: 'authority-test-lease',
}

const mission = { id: 'mission-reach-log', item: 'oak_log', count: 1 }
const desiredPredicate = {
  id: 'reach.resource-source',
  proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log' },
  expected: true,
}

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
    },
    stop(): void {
      pathStops += 1
    },
    getPathTo: () => ({ status: 'noPath', path: [] }),
  }

  const bot = {
    registry,
    game: { dimension: identity.dimension },
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
    inventory: { items: () => [], count: () => 0 },
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

function makeContract(): ReachTransitionContract {
  return createReachTransitionContract({
    transitionId: 'transition-reach-progress-terminal',
    desiredPredicate,
    requires: [{ id: 'mission.unsatisfied', proposition: { kind: 'inventory-below', item: 'oak_log' }, expected: true }],
    ensures: [desiredPredicate],
    invariants: [{ id: 'body.alive', proposition: { kind: 'health-above-zero' }, expected: true }],
    admissibleEffects: [{ kind: 'locomotion', maxUses: null }],
    budget: { maxMechanicalSteps: 8, maxElapsedMs: 30_000, resources: {}, risk: { damage: 2 } },
    controller: {
      allowedTactics: ['walk', 'path_replan'],
      allowTemporaryWaypointChanges: true,
      allowWitnessSubstitution: true,
    },
    identity,
  })
}

function makeRoute(contract: ReachTransitionContract, atMs: number): ReachRoute {
  const evidenceId = `route-grounding:${atMs}`
  return {
    routeId: 'MOVE:reach-authority-fixture',
    groundingPredicateId: 'route.resource-source-grounded',
    waypointGroundingPredicateId: null,
    witness: {
      witnessId: 'oak-log-source:12,64,4',
      target: { x: 12, y: 64, z: 4 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: identity,
      observedAtMs: atMs,
    },
    waypoint: null,
    tactic: 'walk',
    effectKind: 'locomotion',
    estimatedDistance: 12,
    resources: {},
    risk: {},
  }
}

function makeSnapshot(contract: ReachTransitionContract, atMs: number, predicateDistance: number): ReachRuntimeSnapshot {
  const route = makeRoute(contract, atMs)
  return {
    observation: {
      identity,
      observedAtMs: atMs,
      predicates: {
        'mission.unsatisfied': { truth: 'true', evidenceId: `mission:oak_log:0/1:${atMs}` },
        'body.alive': { truth: 'true', evidenceId: `body:health:20:${atMs}` },
        'reach.resource-source': { truth: 'false', evidenceId: `reach:outside-interaction-range:${atMs}` },
        [route.groundingPredicateId]: { truth: 'true', evidenceId: route.witness.evidenceId },
      },
    },
    routes: [route],
    progress: {
      predicateDistance,
      reachability: 'reachable',
      frontierId: route.routeId,
      evidenceId: `progress:${atMs}`,
    },
  }
}

function moveCandidate(target: { x: number; y: number; z: number }): Candidate {
  return {
    id: 'MOVE:reach-authority-fixture',
    kind: 'MOVE',
    label: `move to ${target.x},${target.y},${target.z}`,
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

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${message}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
}

test('typed Reach terminal revokes its real Executor lease before scheduler handoff', async () => {
  const contract = makeContract()
  const controller = new ReachController()
  const startAtMs = Date.now()
  const initial = await controller.commit(contract, makeSnapshot(contract, startAtMs, 12))
  expect(initial.status).toBe('active')
  expect(initial.status === 'active' ? initial.phase : '').toBe('actuate')
  if (initial.status !== 'active' || initial.intent === undefined) throw new Error('expected committed VTR intent')
  const intent = initial.intent

  const authorization = controller.authorizeMechanicalStep(intent.intentId, identity, {
    stepId: `${intent.intentId}:leg:1`,
    effectKind: intent.effectKind,
    resources: {},
    risk: {},
    nowMs: startAtMs + 1,
  })
  expect(authorization.status).toBe('authorized')

  const fixture = makeBot()
  const logDir = mkdtempSync(join(tmpdir(), 'vtr-reach-authority-'))
  const logger = new JsonLogger(new JsonlWriter(join(logDir, 'executor.jsonl')), false) as EventLogger
  const executor = new Executor(fixture.bot, logger, {
    ...defaultExecutorOptions,
    actuation: 'pathfinder',
    pathTimeoutMs: 10_000,
  })

  try {
    const claim = executor.claim(moveCandidate(intent.target as { x: number; y: number; z: number }), {
      authority: 'vtr-reach',
      transitionId: intent.transitionId,
    })
    await waitFor(() => fixture.goalStarts() === 1, 'the authorized Reach MOVE to reach pathfinder')
    const currentAction: CurrentAction | null = executor.current
    expect(currentAction).not.toBeNull()
    expect(currentAction?.status).toBe('running')
    expect(currentAction?.authority).toBe('vtr-reach')
    expect(currentAction?.transitionId).toBe(intent.transitionId)

    // Infinity is rejected as typed progress evidence while the ensures remain
    // false. The route/contract stay valid; only recordReachProgress terminalizes.
    const typedTerminal = await controller.tick(makeSnapshot(contract, startAtMs + 2, Number.POSITIVE_INFINITY))
    expect(typedTerminal.status).toBe('terminal')
    if (typedTerminal.status !== 'terminal') throw new Error('expected typed Reach terminal')
    expect(typedTerminal.outcome.kind).toBe('CONTRACT_VIOLATION')
    expect(typedTerminal.cancelIntentId).toBe(intent.intentId)
    expect(controller.current).toBeNull()
    expect(executor.current).toBe(currentAction)

    let schedulerHandoff = 0
    const adapter = Object.create(JevController.prototype) as JevController
    Object.assign(adapter as unknown as Record<string, unknown>, {
      reachRunMetadata: {
        mission,
        transitionId: contract.transitionId,
        contractHash: contract.contractHash,
        identity,
        jevCallsAtStart: 0,
        system2CallsAtStart: 0,
        authorityConflictsAtStart: executor.authorityConflictCount,
        duplicateAuthorityObserved: false,
      },
      reachTerminalHandoff: null,
      reachController: controller,
      executor,
      jevCalls: 0,
      runtimeLlmCalls: 0,
      planCalls: 0,
      tickCounter: 7,
      lastReachActionFailure: null,
      logger: { info: () => undefined },
      requestDecision: (_trigger: string, detail: Record<string, unknown>) => {
        expect(detail).toMatchObject({ typedOutcome: 'CONTRACT_VIOLATION', schedulerHandoff: true })
        expect(currentAction?.status).toBe('cancelled')
        expect(executor.current).toBeNull()
        expect(controller.currentOutcome).toBeNull()
        schedulerHandoff += 1
      },
    })
    const closeReachTransition = (JevController.prototype as unknown as {
      closeReachTransition(
        this: JevController,
        outcome: ReachTerminalOutcome,
        state: ReachTransitionState,
        boundary: string,
        cancelIntentId: string | null,
      ): void
    }).closeReachTransition
    closeReachTransition.call(adapter, typedTerminal.outcome, typedTerminal.state, 'typed-terminal', typedTerminal.cancelIntentId)

    expect(schedulerHandoff).toBe(1)
    const execution = await claim.completion
    expect(execution.status).toBe('cancelled')
    expect(currentAction?.status).toBe('cancelled')
    expect(executor.current).toBeNull()
    expect(fixture.goalClears()).toBe(1)
    expect(fixture.pathStops()).toBe(1)
  } finally {
    executor.cancelCurrent('fixture teardown')
    rmSync(logDir, { recursive: true, force: true })
  }
})
