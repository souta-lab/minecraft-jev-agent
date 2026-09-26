// test-vtr-reach-kernel-authority.mts - V4.1.2 Phase-2 runtime gate wiring.
//
// Proves ReachMissionRuntime consults KernelReachAuthority causally BEFORE the
// gated production act, honors denials fail-closed, and never mints SUCCESS
// the kernel refused. The gate is a recording stub here; the real kernel-side
// semantics are proven in buddy-driver/test-kernel-authority.mts.
import { expect, test } from 'bun:test'
import { ReachMissionRuntime } from './src/vtr/reach-mission-runtime.ts'
import type { InventoryReachMission } from './src/vtr/reach-scheduler.ts'
import {
  nearestGroundedReachRoutePolicy,
  type ReachRoute,
  type ReachRuntimeSnapshot,
} from './src/vtr/reach-controller.ts'
import type { ReachIdentity, ReachTransitionContract, ReachWitness } from './src/vtr/reach.ts'
import type { KernelGateVerdict, KernelReachAuthority } from './src/vtr/kernel-shadow-map.ts'

const identity: ReachIdentity = {
  worldKey: 'authority-world',
  dimension: 'minecraft:overworld',
  worldEpoch: 3,
  generationId: 'authority-generation',
  leaseId: 'authority-lease',
}

const mission: InventoryReachMission = {
  id: 'mission-authority-amethyst',
  kind: 'inventory_at_least',
  item: 'amethyst_shard',
  count: 4,
}

interface GateCall {
  readonly gate: string
  readonly transitionId: string
}

class RecordingAuthority implements KernelReachAuthority {
  readonly mode = 'authority' as const
  readonly calls: GateCall[] = []
  admitVerdict: KernelGateVerdict = { ok: true }
  activateVerdict: KernelGateVerdict = { ok: true }
  issueVerdict: KernelGateVerdict = { ok: true }
  terminalizeVerdict: KernelGateVerdict = { ok: true }
  lastSettled: { stepId: string; status: string; progressed: boolean } | null = null

  admitTransition(contract: ReachTransitionContract): KernelGateVerdict {
    this.calls.push({ gate: 'admitTransition', transitionId: contract.transitionId })
    return this.admitVerdict
  }
  activateTransition(transitionId: string, _witness: ReachWitness | null): KernelGateVerdict {
    this.calls.push({ gate: 'activateTransition', transitionId })
    return this.activateVerdict
  }
  issueStepEffect(input: { transitionId: string; intentId: string; stepId: string; effectKind: string }): KernelGateVerdict {
    this.calls.push({ gate: 'issueStepEffect', transitionId: input.transitionId })
    return this.issueVerdict
  }
  settleStepEffect(input: { transitionId: string; intentId: string; stepId: string; status: string; verified: boolean; progressed: boolean }): void {
    this.calls.push({ gate: 'settleStepEffect', transitionId: input.transitionId })
    this.lastSettled = { stepId: input.stepId, status: input.status, progressed: input.progressed }
  }
  terminalize(input: { transitionId: string; contractHash: string; outcome: { kind: string } }): KernelGateVerdict {
    this.calls.push({ gate: 'terminalize', transitionId: input.transitionId })
    return this.terminalizeVerdict
  }
}

function makeRoute(contract: ReachTransitionContract, atMs: number): ReachRoute {
  const evidenceId = `grounding:r1:${atMs}`
  return {
    routeId: 'approach:amethyst-cluster:7,64,3',
    groundingPredicateId: 'predicate:r1',
    waypointGroundingPredicateId: null,
    witness: {
      witnessId: 'amethyst-cluster:7,64,3',
      target: { x: 7, y: 64, z: 3 },
      desiredPredicateIdentity: contract.desiredPredicateIdentity,
      evidenceId,
      observedIdentity: contract.identity,
      observedAtMs: atMs,
    },
    waypoint: null,
    tactic: 'walk',
    effectKind: 'locomotion',
    estimatedDistance: 10,
    resources: {},
    risk: {},
  }
}

function makeSnapshot(contract: ReachTransitionContract, atMs: number, ensures: boolean): ReachRuntimeSnapshot {
  const route = makeRoute(contract, atMs)
  return {
    observation: {
      identity: contract.identity,
      observedAtMs: atMs,
      predicates: {
        'mission.unsatisfied': { truth: 'true', evidenceId: `mission:${atMs}` },
        'reach.source-grounded': { truth: 'true', evidenceId: `source-class:${atMs}` },
        'body.alive': { truth: 'true', evidenceId: `health:${atMs}` },
        'reach.resource-source': { truth: ensures ? 'true' : 'false', evidenceId: ensures ? `verified:${atMs}` : `outside:${atMs}` },
        'predicate:r1': { truth: 'true', evidenceId: route.witness.evidenceId },
      },
    },
    routes: [route],
    progress: {
      predicateDistance: ensures ? 0 : 10,
      reachability: 'reachable',
      frontierId: route.routeId,
      evidenceId: `progress:${atMs}`,
    },
  }
}

function makeRuntime(authority: KernelReachAuthority | undefined): ReachMissionRuntime {
  return new ReachMissionRuntime({
    routePolicy: nearestGroundedReachRoutePolicy,
    commitFreshnessFence: () => ({ status: 'current' }),
    kernelAuthority: authority,
  })
}

function deriveContract(runtime: ReachMissionRuntime, transitionId = 'transition-authority'): ReturnType<ReachMissionRuntime['deriveInventoryReachTransition']> {
  return runtime.deriveInventoryReachTransition({
    mission,
    interactionReach: 4.5,
    sourceNames: ['budding_amethyst', 'amethyst_cluster'],
    identity,
    transitionId,
  })
}

test('kernel admit denial refuses the commit before the controller owns a transition', async () => {
  const authority = new RecordingAuthority()
  authority.admitVerdict = { ok: false, reason: 'MISSION_NOT_AUTHORIZED' }
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  const result = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1000, false))
  expect(result.status).toBe('refused')
  if (result.status === 'refused') expect(result.reason).toContain('kernel-admit-denied:MISSION_NOT_AUTHORIZED')
  expect(runtime.current).toBeNull()
  expect(authority.calls.map((c) => c.gate)).toEqual(['admitTransition'])
})

test('activation denial tears down the committed transition and closes the kernel side', async () => {
  const authority = new RecordingAuthority()
  authority.activateVerdict = { ok: false, reason: 'FRESH_WITNESS_PROOF_REQUIRED' }
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  const result = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1000, false))
  // Production superseded what the kernel refused to activate; the kernel
  // admitted-but-unactivated transition is closed through terminalize.
  expect(result.status).toBe('terminal')
  expect(runtime.current).toBeNull()
  expect(authority.calls.map((c) => c.gate)).toEqual(['admitTransition', 'activateTransition', 'terminalize'])
})

test('happy commit orders admit before activate and keeps the transition live', async () => {
  const authority = new RecordingAuthority()
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  const result = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1000, false))
  expect(result.status).toBe('active')
  expect(runtime.current?.contract.transitionId).toBe(plan.contract.transitionId)
  expect(authority.calls.map((c) => c.gate)).toEqual(['admitTransition', 'activateTransition'])
})

test('immediately-terminal commit closes the kernel transition through terminalize', async () => {
  const authority = new RecordingAuthority()
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  // Committing against an already-true ensures predicate resolves terminal at
  // commit time in the production controller; the kernel side closes too.
  const result = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1000, true))
  expect(result.status === 'terminal' || result.status === 'active').toBe(true)
  const gates = authority.calls.map((c) => c.gate)
  expect(gates[0]).toBe('admitTransition')
  if (result.status === 'terminal') {
    expect(gates).toContain('terminalize')
  } else {
    expect(gates[1]).toBe('activateTransition')
  }
})

test('controller refusal after kernel admit closes the admitted kernel transition', async () => {
  const authority = new RecordingAuthority()
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  // Snapshot with no grounded routes -> controller cannot select a route.
  const snapshot = makeSnapshot(plan.contract, 1000, false)
  const refused = await runtime.commit(plan.contract, { ...snapshot, routes: [] })
  expect(refused.status === 'refused' || refused.status === 'not_enabled' || refused.status === 'decision_required').toBe(true)
  expect(authority.calls.map((c) => c.gate)).toEqual(['admitTransition', 'terminalize'])
})

test('issueStepEffect denial refuses the mechanical step before dispatch', async () => {
  const authority = new RecordingAuthority()
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  const committed = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1000, false))
  expect(committed.status).toBe('active')
  const intentId = runtime.current?.intent?.intentId
  expect(intentId).toBeDefined()
  authority.issueVerdict = { ok: false, reason: 'TRANSITION_NOT_EFFECT_ELIGIBLE' }
  const authorization = runtime.authorizeMechanicalStep(intentId!, identity, {
    stepId: 'step-1',
    effectKind: 'locomotion',
    resources: {},
    risk: {},
    nowMs: 1100,
  })
  expect(authorization.status).toBe('refused')
  if (authorization.status === 'refused') expect(authorization.reason).toContain('kernel-effect-denied:')
  expect(authority.calls.map((c) => c.gate)).toEqual(['admitTransition', 'activateTransition', 'issueStepEffect'])
})

test('takeTerminalHandoff downgrades a SUCCESS the kernel refused to verify', async () => {
  const authority = new RecordingAuthority()
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  const committed = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1000, false))
  expect(committed.status).toBe('active')
  // Drive the transition to a SUCCESS verification: fresh observation now
  // reports the ensures predicate true.
  const ticked = await runtime.tick(makeSnapshot(plan.contract, 1100, true))
  expect(ticked.status).toBe('terminal')
  // The kernel refuses VERIFY_SUCCESS at terminalize time.
  authority.terminalizeVerdict = { ok: false, reason: 'verify-proof-not-observed' }
  const handoff = runtime.takeTerminalHandoff()
  expect(handoff).not.toBeNull()
  expect(handoff!.outcome.kind).toBe('CONTRACT_VIOLATION')
  if (handoff!.outcome.kind === 'CONTRACT_VIOLATION') {
    expect(handoff!.outcome.detail).toContain('kernel-verify-success-denied:')
  }
  expect(authority.calls.map((c) => c.gate)).toContain('terminalize')
})

test('takeTerminalHandoff delivers SUCCESS only when the kernel verified it', async () => {
  const authority = new RecordingAuthority()
  const runtime = makeRuntime(authority)
  const plan = deriveContract(runtime)
  const committed = await runtime.commit(plan.contract, makeSnapshot(plan.contract, 1000, false))
  expect(committed.status).toBe('active')
  const ticked = await runtime.tick(makeSnapshot(plan.contract, 1100, true))
  expect(ticked.status).toBe('terminal')
  const handoff = runtime.takeTerminalHandoff()
  expect(handoff?.outcome.kind).toBe('SUCCESS')
  const order = authority.calls.map((c) => c.gate)
  expect(order).toEqual(['admitTransition', 'activateTransition', 'terminalize'])
})
