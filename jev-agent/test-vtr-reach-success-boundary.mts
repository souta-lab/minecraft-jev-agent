import { expect, test } from 'bun:test'
import { JevController } from './src/controller-legacy.ts'
import type { Candidate } from './src/candidates.ts'
import { createVtrReachTestCells } from './test-vtr-reach-test-cells.mts'

const identity = {
  worldKey: '127.0.0.1:25565|minecraft:overworld|1',
  dimension: 'minecraft:overworld',
  worldEpoch: 1,
  generationId: 'success-boundary-generation',
  leaseId: 'success-boundary-lease',
}
const transitionId = 'transition-success-boundary'
const contractHash = 'contract-success-boundary'
const intentId = 'intent-success-boundary'
const verifiedAtMs = 1_800_000_000_000
const predicate = {
  id: 'reach.resource-source',
  proposition: { kind: 'within-interaction-reach-of-resource-source', item: 'oak_log' },
  expected: true,
}
const outcome = {
  kind: 'SUCCESS' as const,
  contractHash,
  desiredPredicateIdentity: 'desired-predicate-identity',
  verifiedAtMs,
  evidenceIds: ['verify:reach:fixture'],
}
const verificationSnapshot = {
  observation: {
    identity,
    observedAtMs: verifiedAtMs,
    predicates: {
      [predicate.id]: { truth: 'true', evidenceId: outcome.evidenceIds[0] },
    },
  },
}

function fixture() {
  const events: Array<{ line: string; detail: Record<string, unknown> }> = []
  const decisions: Array<{ trigger: string; detail: Record<string, unknown> }> = []
  const terminalState = {
    status: 'terminal',
    contractHash,
    identity,
    usage: { mechanicalSteps: 1, elapsedMs: 1_000, resources: {}, risk: {}, effects: { locomotion: 1 } },
    progress: { latestPredicateDistance: 0, bestPredicateDistance: 0, reachability: 'reachable', frontierId: 'MOVE:oak_log', evidenceId: 'verify:reach:fixture', observationSequence: 2 },
    witness: { witnessId: 'oak_log@4,64,0' },
  }
  const active = {
    contract: { transitionId, contractHash, identity },
    state: { ...terminalState, status: 'active' },
    intent: { intentId, transitionId, contractHash },
  }
  const terminalHandoff = { contractHash, state: terminalState, outcome }
  const reachRuntime = {
    get current() { return active },
    handoff: null as typeof terminalHandoff | null,
    recordMechanicalStepOutcome() {
      this.handoff = terminalHandoff
      return { status: 'terminal', outcome, state: terminalState, cancelIntentId: null }
    },
    async complete() {
      this.handoff = terminalHandoff
      return { status: 'terminal', outcome, state: terminalState, cancelIntentId: null }
    },
    takeTerminalHandoff() {
      const handoff = this.handoff
      this.handoff = null
      return handoff
    },
  }
  const controller = Object.create(JevController.prototype) as JevController
  const fields = controller as unknown as Record<string, any>
  Object.assign(fields, {
    reachVtrCells: createVtrReachTestCells({ tickCounter: 7 }),
    options: {
      decisionProvenance: { runId: 'run-success-boundary', sourceSha: 'source-success-boundary', buildHash: null },
    },
    reachRuntime,
    reachRunMetadata: {
      mission: { id: 'mission-reach-oak', item: 'oak_log', count: 1 },
      transitionId,
      contractHash,
      ensures: [predicate],
      identity,
      jevCallsAtStart: 0,
      system2CallsAtStart: 0,
      authorityConflictsAtStart: 0,
      duplicateAuthorityObserved: false,
      lastHealth: 20,
    },
    reachTerminalHandoff: null,
    lastReachActionFailure: null,
    modelRecoveryReachDrainTransitionId: null,
    tickCounter: 7,
    jevCalls: 0,
    runtimeLlmCalls: 0,
    planCalls: 0,
    executor: { current: null, authorityConflictCount: 0, cancelCurrent: () => true },
    buildReachWorldState: () => ({ timestampMs: verifiedAtMs, tick: 8, self: { health: 20 } }),
    reachIdentity: () => identity,
    liveReachIdentity: () => identity,
    reachCandidates: () => ({ candidates: [] }),
    reachRuntimeSnapshot: () => verificationSnapshot,
    noteCandidateSuccess: () => undefined,
    requestDecision: (trigger: string, detail: Record<string, unknown>) => decisions.push({ trigger, detail }),
    logger: {
      info: (_source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ line, detail }),
      warn: (_source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ line, detail }),
      error: (_source: string, line: string, detail: Record<string, unknown> = {}) => events.push({ line, detail }),
    },
  })
  return { controller, fields, events, decisions, terminalState, reachRuntime }
}

function assertVerifiedBoundary(events: Array<{ line: string; detail: Record<string, unknown> }>): void {
  const terminal = events.find(({ line }) => line.includes(`VTR_TRANSITION_OUTCOME id=${transitionId} outcome=SUCCESS`))
  expect(terminal).toBeDefined()
  expect(terminal?.line).toContain('boundary=verified-terminal')
  expect(terminal?.detail.boundary).toBe('verified-terminal')
  const verifyIndex = events.findIndex(({ line }) => line.includes(`VTR_TRANSITION_VERIFY id=${transitionId}`))
  const outcomeIndex = events.findIndex(({ line }) => line.includes(`VTR_TRANSITION_OUTCOME id=${transitionId} outcome=SUCCESS`))
  expect(verifyIndex).toBeGreaterThanOrEqual(0)
  expect(outcomeIndex).toBeGreaterThan(verifyIndex)
}

test('SUCCESS found at the mechanical-step callback is journaled as verified-terminal', () => {
  const { controller, fields, events, decisions } = fixture()
  const recordMechanicalOutcome = (JevController.prototype as unknown as {
    recordReachMechanicalOutcome(
      this: JevController,
      actionIntentId: string,
      actionIdentity: typeof identity,
      step: { stepId: string; leg: number; effectKind: 'locomotion' },
    ): boolean
  }).recordReachMechanicalOutcome

  expect(recordMechanicalOutcome.call(controller, intentId, identity, {
    stepId: 'MOVE:oak_log#1:walk-leg-1', leg: 1, effectKind: 'locomotion',
  })).toBe(false)

  assertVerifiedBoundary(events)
  expect(decisions[0]?.detail).toMatchObject({ typedOutcome: 'SUCCESS', boundary: 'verified-terminal' })
  expect(fields.reachRunMetadata).toBeNull()
})

test('SUCCESS found at action completion is journaled with the same verified-terminal boundary', async () => {
  const { controller, fields, events, decisions } = fixture()
  const onReachActionComplete = (JevController.prototype as unknown as {
    onReachActionComplete(
      this: JevController,
      result: Record<string, unknown>,
      candidate: Candidate,
      actionTransitionId: string,
      actionIntentId: string,
    ): Promise<void>
  }).onReachActionComplete

  await onReachActionComplete.call(controller, {
    actionId: 'MOVE:oak_log@4,64,0', status: 'done', verified: true,
    failure: null, progressed: true, distanceClosed: true,
  }, { id: 'MOVE:oak_log@4,64,0', kind: 'MOVE', meta: {} } as Candidate, transitionId, intentId)

  assertVerifiedBoundary(events)
  expect(decisions.some(({ detail }) => detail.typedOutcome === 'SUCCESS' && detail.boundary === 'verified-terminal')).toBe(true)
  expect(fields.reachRunMetadata).toBeNull()
})

test('non-success outcomes keep their typed terminal boundary', () => {
  const { controller, events, terminalState, reachRuntime } = fixture()
  const closeReachTransition = (JevController.prototype as unknown as {
    closeReachTransition(
      this: JevController,
      typedOutcome: Record<string, unknown>,
      state: Record<string, unknown>,
      boundary: string,
    ): void
  }).closeReachTransition

  const budgetOutcome = {
    kind: 'BUDGET_EXHAUSTED', contractHash, budget: 'mechanicalSteps', limit: 1, attempted: 2,
  }
  reachRuntime.handoff = { contractHash, state: terminalState, outcome: budgetOutcome as any }
  closeReachTransition.call(controller, budgetOutcome, terminalState, 'typed-terminal')

  const terminal = events.find(({ line }) => line.includes(`VTR_TRANSITION_OUTCOME id=${transitionId} outcome=BUDGET_EXHAUSTED`))
  expect(terminal?.line).toContain('boundary=typed-terminal')
  expect(terminal?.detail.boundary).toBe('typed-terminal')
})
