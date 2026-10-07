// test-controller-transitions.mts - controller dispatch runs under the REAL
// V4.1.2 kernel session (not a permissive stub).
//
// Adversarial regressions for the controller-transition lifecycle:
//   1. supersession closes the incumbent BEFORE the replacement is admitted,
//      so the replacement acquires its lease bundle (without the ordering the
//      kernel refuses the replacement with a resource conflict);
//   2. a claim that never started closes its freshly admitted transition;
//   3. SUCCESS is requested only from the truthful outcome - the executor's
//      lenient `verified` flag alone never becomes a kernel VERIFY_SUCCESS;
//   4. a truthfully verified completion is VERIFY_SUCCESS from an observed
//      fact and releases every lease;
//   5. a namespaced host world admits the bare runtime dimension spelling.
import { createKernelAuthoritySession } from '../buddy-driver/kernel-authority-session.ts'
import type { KernelAuthoritySession } from '../buddy-driver/kernel-authority-session.ts'
import type { Candidate } from './src/candidates.ts'
import type { InternalEffectReservation } from './src/executor.ts'
import { ControllerTransitions } from './src/controller-transitions.ts'
import type { ControllerTransitionExecutor } from './src/controller-transitions.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}
const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const WORLD = { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 3 }

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

function tableCraftCandidate(): Candidate {
  return {
    id: 'CRAFT:iron_pickaxe',
    kind: 'CRAFT',
    label: 'craft 1 x iron_pickaxe at the local table',
    targetName: null,
    target: { x: 1, y: 64, z: 0 },
    targetEntityId: null,
    itemName: 'iron_pickaxe',
    requiresTool: false,
    toolName: null,
    inReach: true,
    hasStandableAdjacent: true,
    meta: { requiresTable: true },
  }
}

class FakeExecutor implements ControllerTransitionExecutor {
  current: {
    id: string
    status: string
    authorityLabel?: string
    transitionId?: string
    transitionContractHash?: string
  } | null = null
  readonly cancelled: string[] = []
  cancelCurrent(reason: string): void {
    if (this.current !== null) this.cancelled.push(`${this.current.id}:${reason}`)
    this.current = null
  }
}

function setup(): { session: KernelAuthoritySession; executor: FakeExecutor; transitions: ControllerTransitions; logs: string[] } {
  const session = createKernelAuthoritySession({ world: WORLD, generationId: 'gen-ct', journalPath: null, now: () => 5_000 })
  const executor = new FakeExecutor()
  const logs: string[] = []
  const transitions = new ControllerTransitions({
    authority: session.authority,
    executor,
    world: () => ({ serverId: WORLD.serverId, worldEpoch: WORLD.worldEpoch }),
    log: (level, message) => logs.push(`${level}:${message}`),
  })
  return { session, executor, transitions, logs }
}

const DONE = { status: 'done' as const, kind: 'MOVE' as const, epoch: 1, itemsGained: 0, blockRemoved: false, failure: null }

addCase('without supersession the kernel refuses a second dispatch that needs the same body lease', () => {
  const { session, executor, transitions } = setup()
  const first = transitions.admit(moveCandidate('A', 5), 'overworld')
  if (first !== null) executor.current = { id: 'A', status: 'running', authorityLabel: 'controller:walk_to', transitionId: first.transitionId, transitionContractHash: first.contractHash }
  // Deliberately skip supersedeRunning: the replacement must not steal A's lease.
  const second = transitions.admit(moveCandidate('B', 9), 'overworld')
  const denials = session.summary().gateDenials
  const pass = first !== null && second === null && denials.some((d) => d.gate === 'activateTransition')
  return { pass, detail: `first=${first?.transitionId ?? 'denied'} second=${second?.transitionId ?? 'denied'} denials=${denials.map((d) => `${d.gate}:${d.reason}`).join('|')}` }
})

addCase('supersession closes the incumbent before the replacement acquires the body lease', () => {
  const { session, executor, transitions } = setup()
  const first = transitions.admit(moveCandidate('A', 5), 'overworld')
  if (first === null) return { pass: false, detail: 'first admission denied' }
  executor.current = { id: 'A', status: 'running', authorityLabel: 'controller:walk_to', transitionId: first.transitionId, transitionContractHash: first.contractHash }
  transitions.supersedeRunning('B', 'superseded by B')
  const second = transitions.admit(moveCandidate('B', 9), 'overworld')
  const state = session.state()
  const incumbent = state.transitions[first.transitionId]
  const replacement = second === null ? undefined : state.transitions[second.transitionId]
  const pass =
    executor.cancelled.length === 1 &&
    incumbent?.lifecycle === 'TERMINAL' &&
    replacement?.lifecycle === 'ACTIVE' &&
    session.summary().gateDenials.length === 0
  return { pass, detail: `cancelled=${executor.cancelled.join(',')} incumbent=${incumbent?.lifecycle}/${incumbent?.terminalOutcome?.kind} replacement=${replacement?.lifecycle} denials=${session.summary().gateDenials.length}` }
})

addCase('a Reach-owned running action is never superseded by the controller', () => {
  const { executor, transitions } = setup()
  executor.current = { id: 'reach-action', status: 'running', authorityLabel: 'vtr-reach', transitionId: 'reach:1', transitionContractHash: 'h' }
  transitions.supersedeRunning('B', 'superseded by B')
  return { pass: executor.cancelled.length === 0 && executor.current?.id === 'reach-action', detail: `cancelled=${executor.cancelled.length}` }
})

addCase('closing a claim that never started releases the freshly admitted transition', () => {
  const { session, transitions } = setup()
  const admission = transitions.admit(moveCandidate('A', 5), 'overworld')
  if (admission === null) return { pass: false, detail: 'admission denied' }
  transitions.close(admission, 'ACTION_FAILED', 'claim-failed:ensureMovements threw')
  const state = session.state()
  const pass = state.transitions[admission.transitionId]?.lifecycle === 'TERMINAL' && Object.keys(state.leases).length === 0
  return { pass, detail: `lifecycle=${state.transitions[admission.transitionId]?.lifecycle} leases=${Object.keys(state.leases).length}` }
})

addCase('the executor\'s lenient verified flag alone never becomes kernel SUCCESS', () => {
  const { session, transitions } = setup()
  const admission = transitions.admit(moveCandidate('A', 5), 'overworld')
  if (admission === null) return { pass: false, detail: 'admission denied' }
  // Raw executor claimed done/verified (a sub-metre nudge); the truth layer downgraded it.
  transitions.terminalize(admission, DONE, { verified: false, status: 'zero_progress' })
  const closed = session.state().transitions[admission.transitionId]
  const factMinted = Object.values(session.state().facts).some((fact) => fact.predicateId === admission.predicateId && fact.truth === 'true')
  const pass = closed?.lifecycle === 'TERMINAL' && closed.terminalOutcome?.kind !== 'SUCCESS' && !factMinted
  return { pass, detail: `outcome=${closed?.terminalOutcome?.kind} factMinted=${factMinted}` }
})

addCase('a truthfully verified completion is VERIFY_SUCCESS from an observed fact and releases every lease', () => {
  const { session, transitions } = setup()
  const admission = transitions.admit(moveCandidate('A', 5), 'overworld')
  if (admission === null) return { pass: false, detail: 'admission denied' }
  transitions.terminalize(admission, DONE, { verified: true, status: 'done' })
  const state = session.state()
  const closed = state.transitions[admission.transitionId]
  const summary = session.summary()
  const pass =
    closed?.terminalOutcome?.kind === 'SUCCESS' &&
    summary.verifyFactIds.length > 0 &&
    Object.keys(state.leases).length === 0 &&
    !state.missionPredicates.includes(admission.predicateId)
  return { pass, detail: `outcome=${closed?.terminalOutcome?.kind} factIds=${summary.verifyFactIds.length} leases=${Object.keys(state.leases).length} missionRetained=${state.missionPredicates.includes(admission.predicateId)}` }
})

addCase('re-dispatching the running candidate reuses its admitted transition', () => {
  const { executor, transitions } = setup()
  const first = transitions.admit(moveCandidate('A', 5), 'overworld')
  if (first === null) return { pass: false, detail: 'admission denied' }
  executor.current = { id: 'A', status: 'running', authorityLabel: 'controller:walk_to', transitionId: first.transitionId, transitionContractHash: first.contractHash }
  const again = transitions.admit(moveCandidate('A', 5), 'overworld')
  const pass = again !== null && again.reused && again.transitionId === first.transitionId
  return { pass, detail: `reused=${again?.reused} same=${again?.transitionId === first.transitionId}` }
})

addCase('table crafting reservation issues the Kernel CRAFT effect before bot.openBlock mutation', () => {
  const { session, transitions } = setup()
  const candidate = tableCraftCandidate()
  const admission = transitions.admit(candidate, 'overworld')
  if (admission === null) return { pass: false, detail: 'craft admission denied' }
  const context = {
    actionId: candidate.id,
    epoch: 1,
    authority: 'controller:craft',
    transitionId: admission.transitionId,
    transitionContractHash: admission.contractHash,
  }
  session.bindActuationContext(() => context)
  const callbacks = transitions.claimProvenance(admission).internalEffectCallbacks
  if (callbacks === undefined) return { pass: false, detail: 'controller claim omitted effect callbacks' }
  const reservation: InternalEffectReservation = {
    actionId: candidate.id,
    actionEpoch: 1,
    transitionId: admission.transitionId,
    effectId: `${candidate.id}:effect:table-craft`,
    kernelEffectKind: 'CRAFT',
    effect: { type: 'station', station: 'crafting_table' },
  }
  const contract = session.state().contracts[admission.contractHash]
  const hasCraftPermit = contract?.effects.some((effect) => effect.kind === 'CRAFT') === true
  const issuedBeforeOpen = callbacks.before(reservation)
  const dispatching = Object.values(session.state().effects).some((effect) =>
    effect.transitionId === admission.transitionId && effect.effect === 'CRAFT' && effect.status === 'DISPATCHING')
  session.observeMutation({
    surface: 'bot.openBlock',
    guarded: true,
    leaseOutcome: 'granted',
    argsSignature: ['block:crafting_table@1,64,0'],
    instanceHint: '1,64,0',
  })
  callbacks.after({ ...reservation, outcome: { status: 'actuator-returned' } })
  const summary = session.summary()
  const pass = hasCraftPermit && issuedBeforeOpen && dispatching &&
    summary.mutationsObserved === 1 && summary.mutationsMapped === 1 &&
    summary.mutationsAttributedToTransition === 1 && summary.mutationsDeniedByLease === 0 &&
    summary.gateDenials.length === 0 && summary.blockers.length === 0
  return {
    pass,
    detail: `craftPermit=${hasCraftPermit} issuedBeforeOpen=${issuedBeforeOpen} dispatching=${dispatching} attributed=${summary.mutationsAttributedToTransition} blockers=${summary.blockers.length}`,
  }
})

let failures = 0
process.stdout.write('controller transitions under the real kernel session\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n      ${observed.detail}\n`)
}
process.stdout.write(`${cases.length - failures}/${cases.length} controller-transition cases passed\n`)
if (failures > 0) process.exit(1)
