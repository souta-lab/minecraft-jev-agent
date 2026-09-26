// test-kernel-authority.mts - V4.1.2 Phase-2 production-authority gate.
//
// Pure: no bot connection, no socket, no network, journalPath=null. Proves the
// authority-mode kernel session gates Reach production acts through the real
// V4.1.2 kernel command path, causally BEFORE the gated act:
//   1. the gate exists only in authority mode and returns real verdicts;
//   2. the happy path admit -> activate -> issue -> dispatch -> settle ->
//      VERIFY_SUCCESS -> terminalize runs with zero denials and zero blockers;
//   3. every ordering violation (issue before activation, issue after
//      terminal, duplicate dispatch, wrong-world contract, SUCCESS without
//      observed ensures facts) is denied and journaled — never silently
//      accepted, never a legacy fallback.
import { createKernelShadowSession } from './kernel-shadow-session.ts'
import type { KernelShadowSession } from './kernel-shadow-session.ts'
import { createInventoryReachTransition } from '../jev-agent/src/vtr/reach-scheduler.ts'
import type { ReachIdentity, ReachTransitionContract, ReachWitness } from '../jev-agent/src/vtr/reach.ts'
import type { KernelReachAuthority } from '../jev-agent/src/vtr/kernel-shadow-map.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const WORLD = { serverId: 'srv', dimension: 'overworld', worldEpoch: 7 }
const IDENTITY: ReachIdentity = {
  worldKey: 'srv|overworld|7',
  dimension: 'overworld',
  worldEpoch: 7,
  generationId: 'gen-1',
  leaseId: 'lease-1',
}

function makeContract(transitionId: string, identity: ReachIdentity = IDENTITY): ReachTransitionContract {
  return createInventoryReachTransition({
    mission: { id: 'm:oak_log:1', kind: 'inventory_at_least', item: 'oak_log', count: 1 },
    interactionReach: 5,
    sourceNames: ['oak_log'],
    identity,
    transitionId,
  }).contract
}

function makeWitness(contract: ReachTransitionContract, identity: ReachIdentity = IDENTITY): ReachWitness {
  return {
    witnessId: 'oak_log@1,64,2',
    target: { x: 1, y: 64, z: 2 },
    desiredPredicateIdentity: contract.desiredPredicateIdentity,
    evidenceId: 'sensor:block:0:oak_log@1,64,2',
    observedIdentity: identity,
    observedAtMs: 1000,
  }
}

const COMMIT_PREDICATES = {
  'mission.unsatisfied': { truth: 'true' as const, evidenceId: 'inventory:0:oak_log=0/1' },
  'reach.source-grounded': { truth: 'true' as const, evidenceId: 'grounding:0:r1' },
  'body.alive': { truth: 'true' as const, evidenceId: 'body:0:health=20' },
  'reach.resource-source': { truth: 'false' as const, evidenceId: 'verify:0:no-interaction-reach-source' },
}

const VERIFIED_PREDICATES = {
  ...COMMIT_PREDICATES,
  'reach.resource-source': { truth: 'true' as const, evidenceId: 'verify:0:in-reach' },
}

const vtrContext = {
  actionId: 'a1',
  epoch: 1,
  authority: 'vtr-reach',
  transitionId: 't-1',
  transitionContractHash: null,
}

function makeAuthoritySession(): { session: KernelShadowSession; gate: KernelReachAuthority } {
  const session = createKernelShadowSession({
    world: WORLD,
    generationId: 'gen-1',
    journalPath: null,
    now: () => 1_000,
    authorityMode: 'authority',
  })
  session.bindActuationContext(() => vtrContext)
  if (session.authority === null) throw new Error('authority mode must expose the gate')
  return { session, gate: session.authority }
}

function feedCommitPredicates(session: KernelShadowSession): void {
  session.observe({ type: 'world-observation', observedAtMs: 1000, predicates: COMMIT_PREDICATES })
}

function admitAndActivate(gate: KernelReachAuthority, session: KernelShadowSession, transitionId: string): ReachTransitionContract {
  feedCommitPredicates(session)
  const contract = makeContract(transitionId)
  const admitted = gate.admitTransition(contract)
  if (!admitted.ok) throw new Error(`admit unexpectedly denied: ${admitted.reason}`)
  const activated = gate.activateTransition(transitionId, makeWitness(contract))
  if (!activated.ok) throw new Error(`activate unexpectedly denied: ${activated.reason}`)
  return contract
}

// --------------------------------------------------------------------------
// 1. Mode exposure and summary record
// --------------------------------------------------------------------------

addCase('authority mode exposes the gate; shadow mode does not', () => {
  const shadow = createKernelShadowSession({ world: WORLD, generationId: 'gen-1', journalPath: null })
  const { session } = makeAuthoritySession()
  const pass = shadow.authority === null && session.authority !== null &&
    shadow.summary().authorityMode === 'shadow' && session.summary().authorityMode === 'authority'
  return { pass, detail: `shadowGate=${shadow.authority !== null} authorityGate=${session.authority !== null} modes=${shadow.summary().authorityMode}/${session.summary().authorityMode}` }
})

// --------------------------------------------------------------------------
// 2. Happy path: every gated act through the kernel, zero denials
// --------------------------------------------------------------------------

addCase('authority happy path: admit->activate->issue->dispatch->settle->VERIFY_SUCCESS->terminal', () => {
  const { session, gate } = makeAuthoritySession()
  const contract = admitAndActivate(gate, session, 't-1')
  const activeOk = session.state().transitions['t-1']?.lifecycle === 'ACTIVE'
  const issued = gate.issueStepEffect({ transitionId: 't-1', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  // Physical leg mutates only after the dispatch verdict; the mutation
  // boundary still reports what it observed, attributed to this transition.
  session.observeMutation({ surface: 'pathfinder.setGoal', guarded: true, leaseOutcome: 'granted', argsSignature: ['vec3(1,64,2)'], instanceHint: null })
  session.observeMutation({ surface: 'pathfinder.goto', guarded: true, leaseOutcome: 'granted', argsSignature: ['object'], instanceHint: null })
  gate.settleStepEffect({ transitionId: 't-1', intentId: 'i-1', stepId: 's-1', status: 'active', verified: false, progressed: true })
  session.observe({ type: 'world-observation', observedAtMs: 1100, predicates: VERIFIED_PREDICATES })
  const terminal = gate.terminalize({ transitionId: 't-1', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const state = session.state().transitions['t-1']
  const summary = session.summary()
  const pass =
    activeOk &&
    issued.ok &&
    terminal.ok &&
    state?.lifecycle === 'TERMINAL' &&
    state.terminalOutcome?.kind === 'SUCCESS' &&
    summary.mutationsAttributedToTransition === 2 &&
    summary.mutationsUnguarded === 0 &&
    summary.mutationsDeniedByLease === 0 &&
    summary.kernelDenied === 0 &&
    summary.gateDenials.length === 0 &&
    summary.verifyFactIds.length > 0 &&
    summary.typedTerminals === 1 &&
    summary.coverageComplete &&
    summary.blockers.length === 0
  return {
    pass,
    detail: `issued=${issued.ok} terminal=${terminal.ok} outcome=${state?.terminalOutcome?.kind} attributed=${summary.mutationsAttributedToTransition} kernelDenied=${summary.kernelDenied} gateDenials=${summary.gateDenials.length} blockers=${summary.blockers.map((b) => `${b.kind}:${b.detail}`).join('|') || 'none'}`,
  }
})

// --------------------------------------------------------------------------
// 3. Ordering and freshness denials — each is journaled, never a fallback
// --------------------------------------------------------------------------

addCase('issueStepEffect before activation is denied (transition not ACTIVE)', () => {
  const { session, gate } = makeAuthoritySession()
  feedCommitPredicates(session)
  const contract = makeContract('t-early')
  const admitted = gate.admitTransition(contract)
  const issued = gate.issueStepEffect({ transitionId: 't-early', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  const summary = session.summary()
  const denials = summary.gateDenials
  const pass = admitted.ok && !issued.ok && denials.length === 1 && denials[0]!.gate === 'issueStepEffect' &&
    session.state().transitions['t-early']?.lifecycle === 'RUNNABLE'
  return { pass, detail: `issued=${issued.ok} reason=${!issued.ok ? issued.reason : 'none'} lifecycle=${session.state().transitions['t-early']?.lifecycle}` }
})

addCase('issueStepEffect after terminalize is denied (terminal transition is not effect-eligible)', () => {
  const { session, gate } = makeAuthoritySession()
  const contract = admitAndActivate(gate, session, 't-dead')
  session.observe({ type: 'world-observation', observedAtMs: 1100, predicates: VERIFIED_PREDICATES })
  const terminal = gate.terminalize({ transitionId: 't-dead', contractHash: contract.contractHash, outcome: { kind: 'PROVEN_INFEASIBLE', reason: 'no-path' } })
  const issued = gate.issueStepEffect({ transitionId: 't-dead', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  const pass = terminal.ok && !issued.ok && session.summary().gateDenials.some((d) => d.gate === 'issueStepEffect')
  return { pass, detail: `terminal=${terminal.ok} issued=${issued.ok} reason=${!issued.ok ? issued.reason : 'none'}` }
})

addCase('duplicate mechanical step dispatch is denied (no double actuation)', () => {
  const { session, gate } = makeAuthoritySession()
  admitAndActivate(gate, session, 't-dup')
  const first = gate.issueStepEffect({ transitionId: 't-dup', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  const replay = gate.issueStepEffect({ transitionId: 't-dup', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  const denial = session.summary().gateDenials.find((d) => d.gate === 'issueStepEffect')
  const pass = first.ok && !replay.ok && denial?.reason === 'duplicate-step-dispatch:s-1'
  return { pass, detail: `first=${first.ok} replay=${replay.ok} reason=${denial?.reason ?? 'none'}` }
})

addCase('admitTransition denies a contract whose world identity disagrees with the kernel', () => {
  const { session, gate } = makeAuthoritySession()
  feedCommitPredicates(session)
  const foreign = makeContract('t-foreign', { ...IDENTITY, worldKey: 'other|overworld|7' })
  const admitted = gate.admitTransition(foreign)
  const summary = session.summary()
  const pass = !admitted.ok &&
    summary.gateDenials.length === 1 &&
    summary.gateDenials[0]!.gate === 'admitTransition' &&
    summary.blockers.some((b) => b.kind === 'contract-mapping-failed') &&
    session.state().transitions['t-foreign'] === undefined
  return { pass, detail: `admitted=${admitted.ok} reason=${!admitted.ok ? admitted.reason : 'none'}` }
})

addCase('terminalize SUCCESS without observed ensures facts is denied and never mints SUCCESS', () => {
  const { session, gate } = makeAuthoritySession()
  const contract = admitAndActivate(gate, session, 't-noverify')
  // The last world-observation still has reach.resource-source=false: the
  // kernel must refuse VERIFY_SUCCESS and close the transition without it.
  const terminal = gate.terminalize({ transitionId: 't-noverify', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const state = session.state().transitions['t-noverify']
  const summary = session.summary()
  const pass =
    !terminal.ok &&
    summary.gateDenials.some((d) => d.gate === 'terminalize') &&
    summary.kernelDenied > 0 &&
    summary.blockers.some((b) => b.kind === 'verify-proof-not-observed') &&
    state?.lifecycle === 'TERMINAL' &&
    state.terminalOutcome?.kind !== 'SUCCESS'
  return {
    pass,
    detail: `terminal=${terminal.ok} outcome=${state?.terminalOutcome?.kind ?? 'none'} kernelDenied=${summary.kernelDenied} blockers=${summary.blockers.map((b) => b.kind).join(',') || 'none'}`,
  }
})

addCase('non-SUCCESS terminal kind-preserving closure is not a blocker in authority mode', () => {
  const { session, gate } = makeAuthoritySession()
  const contract = admitAndActivate(gate, session, 't-infeasible')
  const terminal = gate.terminalize({
    transitionId: 't-infeasible',
    contractHash: contract.contractHash,
    outcome: { kind: 'PROVEN_INFEASIBLE', reason: 'witness falsified', evidenceId: 'falsify:1' },
  })
  const state = session.state().transitions['t-infeasible']
  const summary = session.summary()
  const pass = terminal.ok &&
    state?.lifecycle === 'TERMINAL' &&
    !summary.blockers.some((b) => b.kind === 'shadow-projection-limitation')
  return { pass, detail: `terminal=${terminal.ok} outcome=${state?.terminalOutcome?.kind ?? 'none'} limitations=${summary.projectionLimitationKinds.join(',') || 'none'}` }
})

addCase('gate-denied rows are journaled in order for audit', () => {
  const { session, gate } = makeAuthoritySession()
  const foreign = makeContract('t-x', { ...IDENTITY, worldEpoch: 99, worldKey: 'srv|overworld|99' })
  gate.admitTransition(foreign)
  feedCommitPredicates(session)
  gate.admitTransition(makeContract('t-x'))
  gate.issueStepEffect({ transitionId: 't-x', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  const denials = session.summary().gateDenials
  const pass = denials.length === 2 && denials[0]!.gate === 'admitTransition' && denials[1]!.gate === 'issueStepEffect'
  return { pass, detail: `denials=${denials.map((d) => `${d.gate}:${d.reason}`).join('|') || 'none'}` }
})

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

let failures = 0
for (const testCase of cases) {
  try {
    const result = testCase.run()
    if (result.pass) {
      console.log(`PASS ${testCase.name} — ${result.detail}`)
    } else {
      failures += 1
      console.log(`FAIL ${testCase.name} — ${result.detail}`)
    }
  } catch (error) {
    failures += 1
    console.log(`FAIL ${testCase.name} — threw ${error instanceof Error ? error.message : String(error)}`)
  }
}
console.log(`${cases.length - failures} pass / ${failures} fail / ${cases.length} cases`)
if (failures > 0) process.exit(1)
