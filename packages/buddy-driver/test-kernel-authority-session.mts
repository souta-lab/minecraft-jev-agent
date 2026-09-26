// test-kernel-authority-session.mts - V4.1.2 kernel authority session coverage.
//
// Pure: no bot connection, no socket, no network, journalPath=null unless a
// case explicitly writes to a tmp file. Proves:
//   1. every mutation surface the production guard/observer can emit maps to a
//      canonical V4.1.2 resource bundle + effect permit (the inventory gate);
//   2. a well-formed lifecycle runs through the authority gate (REGISTER ->
//      ADMIT -> proofs -> witness -> ACQUIRE -> ISSUE -> DISPATCH -> RECONCILE
//      -> VERIFY) with zero blockers, and adversarial inputs (forged hashes,
//      unissued settles, stale or cross-world truth) fail closed;
//   3. unmapped / unguarded / transition-unattributed mutations are recorded
//      as hard blockers, never silently accepted.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKernelAuthoritySession, MAX_REATTEST_AGE_MS } from './kernel-authority-session.ts'
import type { KernelAuthoritySession, KernelSessionBlocker } from './kernel-authority-session.ts'
import {
  MUTATING_BOT_METHODS,
  OBSERVED_UNGUARDED_BOT_METHODS,
} from './resident-safety.ts'
import { controllerTransitionToKernelSpec, mapMutationSurface } from '../jev-agent/src/reach/kernel-authority-map.ts'
import type { MutationAuthorityContext } from '../jev-agent/src/reach/kernel-authority-map.ts'
import { createInventoryReachTransition } from '../jev-agent/src/reach/scheduler.ts'
import type { ReachIdentity, ReachTransitionContract, ReachWitness } from '../jev-agent/src/reach/transition.ts'

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

function makeContract(transitionId: string): ReachTransitionContract {
  return createInventoryReachTransition({
    mission: { id: 'm:oak_log:1', kind: 'inventory_at_least', item: 'oak_log', count: 1 },
    interactionReach: 5,
    sourceNames: ['oak_log'],
    identity: IDENTITY,
    transitionId,
  }).contract
}

function makeWitness(contract: ReachTransitionContract): ReachWitness {
  return {
    witnessId: 'oak_log@1,64,2',
    target: { x: 1, y: 64, z: 2 },
    desiredPredicateIdentity: contract.desiredPredicateIdentity,
    evidenceId: 'sensor:block:0:oak_log@1,64,2',
    observedIdentity: IDENTITY,
    observedAtMs: 1000,
  }
}

/** The predicate set the production projection emits while a commit is legal. */
const COMMIT_PREDICATES = {
  'mission.unsatisfied': { truth: 'true' as const, evidenceId: 'inventory:0:oak_log=0/1' },
  'reach.source-grounded': { truth: 'true' as const, evidenceId: 'grounding:0:r1' },
  'body.alive': { truth: 'true' as const, evidenceId: 'body:0:health=20' },
  'reach.resource-source': { truth: 'false' as const, evidenceId: 'verify:0:no-interaction-reach-source' },
}

function makeSession(context: () => MutationAuthorityContext | null = () => null): {
  session: KernelAuthoritySession
  blockers: () => readonly KernelSessionBlocker[]
} {
  const session = createKernelAuthoritySession({
    world: WORLD,
    generationId: 'gen-1',
    journalPath: null,
    now: () => 1_000,
  })
  session.bindActuationContext(context)
  return { session, blockers: session.blockers }
}

const vtrContext: MutationAuthorityContext = {
  actionId: 'a1',
  epoch: 1,
  authority: 'vtr-reach',
  transitionId: 't-1',
  transitionContractHash: null,
}

// --------------------------------------------------------------------------
// 1. Static surface-coverage gate: everything the observer can emit must map.
// --------------------------------------------------------------------------

addCase('every guarded bot mutator maps to a canonical resource bundle', () => {
  const unmapped = [...MUTATING_BOT_METHODS].filter((method) => mapMutationSurface(`bot.${method}`, null) === null)
  return { pass: unmapped.length === 0, detail: `unmapped=${unmapped.join(',') || 'none'} (${MUTATING_BOT_METHODS.size} guarded)` }
})

addCase('every observation-only unguarded bot mutator maps', () => {
  const unmapped = [...OBSERVED_UNGUARDED_BOT_METHODS].filter((method) => mapMutationSurface(`bot.${method}`, null) === null)
  return { pass: unmapped.length === 0, detail: `unmapped=${unmapped.join(',') || 'none'} (${OBSERVED_UNGUARDED_BOT_METHODS.size} unguarded)` }
})

addCase('nested guarded capabilities map (pathfinder/collectBlock/entity/window)', () => {
  const surfaces = [
    ['pathfinder.setGoal', null],
    ['pathfinder.setMovements', null],
    ['pathfinder.goto', null],
    ['pathfinder.stop', null],
    ['collectBlock.collect', '77'],
    ['entity.position.set', null],
    ['entity.position.add', null],
    ['entity.yaw', null],
    ['entity.pitch', null],
    ['entity.onGround', null],
    ['window.withdraw', '5,64,5'],
    ['window.deposit', '5,64,5'],
  ] as const
  const unmapped = surfaces.filter(([surface, hint]) => mapMutationSurface(surface, hint) === null)
  return { pass: unmapped.length === 0, detail: `unmapped=${unmapped.map(([s]) => s).join(',') || 'none'}` }
})

addCase('_client.write maps locomotion/orientation/command packets and rejects unknown ones', () => {
  const mapped = ['position', 'position_look', 'look', 'flying', 'vehicle_move', 'arm_animation', 'entity_action', 'block_dig', 'block_place', 'window_click', 'held_item_slot', 'chat', 'client_command', 'settings', 'client_information']
  const unmapped = mapped.filter((packet) => mapMutationSurface('_client.write', packet) === null)
  const unknownRejected = mapMutationSurface('_client.write', 'not_a_real_packet') === null
  return { pass: unmapped.length === 0 && unknownRejected, detail: `unmapped=${unmapped.join(',') || 'none'} unknownRejected=${unknownRejected}` }
})

addCase('a wholly unknown surface resolves to null (fail-closed)', () => {
  const pass = mapMutationSurface('bot.teleport', null) === null && mapMutationSurface('rumor.hasIt', null) === null
  return { pass, detail: 'unmapped surfaces return null' }
})

/**
 * Static mutation-surface scan: extract every `bot.<mutator>(` / nested
 * capability call site in production sources and prove each emits an observed,
 * mapped authority surface. Anything missing here is a coverage hole the live
 * observer cannot see.
 */
addCase('static scan: every production mutation call site is an observed mapped surface', () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const sources: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.(ts|mts)$/.test(entry.name) && !entry.name.startsWith('test-') && !entry.name.includes('kernel-authority-map')) sources.push(path)
    }
  }
  walk(join(root, 'jev-agent', 'src'))
  walk(join(root, 'buddy-driver'))
  const observed = new Set<string>()
  const missing: string[] = []
  for (const file of sources) {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/\bbot\.([A-Za-z]+)\s*\(/g)) {
      const method = match[1]!
      if (!MUTATING_BOT_METHODS.has(method) && !OBSERVED_UNGUARDED_BOT_METHODS.has(method)) continue
      const surface = `bot.${method}`
      if (mapMutationSurface(surface, null) === null) missing.push(`${file.replace(root, '')}:${surface}`)
      observed.add(surface)
    }
    for (const match of text.matchAll(/\.pathfinder\.(setGoal|setMovements|stop|goto)\s*\(/g)) {
      const surface = `pathfinder.${match[1]!}`
      if (mapMutationSurface(surface, null) === null) missing.push(`${file.replace(root, '')}:${surface}`)
      observed.add(surface)
    }
    for (const match of text.matchAll(/entity\.(yaw|pitch|onGround)\s*=/g)) {
      const surface = `entity.${match[1]!}`
      if (mapMutationSurface(surface, null) === null) missing.push(`${file.replace(root, '')}:${surface}`)
      observed.add(surface)
    }
    for (const match of text.matchAll(/entity\.position\.(set|add|translate|sub|substract|subtract|multiply|divide|norm|normalize|floor|offset)\s*\(/g)) {
      const surface = `entity.position.${match[1]!}`
      if (mapMutationSurface(surface, null) === null) missing.push(`${file.replace(root, '')}:${surface}`)
      observed.add(surface)
    }
    if (/\bcollectBlock\.collect\s*\(/.test(text)) {
      if (mapMutationSurface('collectBlock.collect', null) === null) missing.push(`${file.replace(root, '')}:collectBlock.collect`)
      observed.add('collectBlock.collect')
    }
    if (/\b_client\.write\s*\(/.test(text)) {
      observed.add('_client.write')
      // Packet names are dynamic at call sites; the map's packet table is the
      // gate - unknown packet names fail closed at observation time.
    }
  }
  return {
    pass: missing.length === 0 && observed.size >= 20,
    detail: `files=${sources.length} surfaces=${observed.size} missing=${missing.join(',') || 'none'}`,
  }
})

// --------------------------------------------------------------------------
// 2. Full lifecycle through the authority gate (the only lifecycle path).
// --------------------------------------------------------------------------

const RESOURCE_IN_REACH = { ...COMMIT_PREDICATES, 'reach.resource-source': { truth: 'true' as const, evidenceId: 'verify:0:in-reach' } }

function controllerSpec(transitionId: string, dimension = 'overworld') {
  const compiled = controllerTransitionToKernelSpec({
    transitionId,
    family: 'walk_to',
    desiredPredicate: `controller:walk_to:${transitionId}`,
    world: { serverId: WORLD.serverId, dimension, worldEpoch: WORLD.worldEpoch },
    maxMechanicalSteps: 8,
    maxActiveMs: 60_000,
  })
  if (!compiled.ok) throw new Error(compiled.reason)
  return compiled.spec
}

addCase('Reach transition runs admit/activate/issue/settle/terminalize through the gate with zero blockers', () => {
  const contract = makeContract('t-1')
  const { session, blockers } = makeSession(() => ({ ...vtrContext, transitionContractHash: contract.contractHash }))
  const gate = session.authority
  gate.feedObservation({ observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  const admitted = gate.admitTransition(contract)
  const activated = gate.activateTransition('t-1', makeWitness(contract))
  const activeOk = session.state().transitions['t-1']?.lifecycle === 'ACTIVE'
  const issued = gate.issueStepEffect({ transitionId: 't-1', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  session.observeMutation({ surface: 'pathfinder.setGoal', guarded: true, leaseOutcome: 'granted', argsSignature: ['vec3(1,64,2)'], instanceHint: null })
  session.observeMutation({ surface: 'pathfinder.goto', guarded: true, leaseOutcome: 'granted', argsSignature: ['object'], instanceHint: null })
  gate.settleStepEffect({ transitionId: 't-1', intentId: 'i-1', stepId: 's-1', status: 'active', verified: false, progressed: true })
  // VERIFY consumes only the verification-time observation - never the
  // SUCCESS signal itself.
  gate.feedObservation({ observedAtMs: 1100, predicates: RESOURCE_IN_REACH })
  const terminal = gate.terminalize({ transitionId: 't-1', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const closed = session.state().transitions['t-1']
  const summary = session.summary()
  const pass =
    admitted.ok && activated.ok && issued.ok && terminal.ok && activeOk &&
    closed?.lifecycle === 'TERMINAL' &&
    closed.terminalOutcome?.kind === 'SUCCESS' &&
    summary.mutationsObserved === 2 &&
    summary.mutationsAttributedToTransition === 2 &&
    summary.coverageComplete &&
    summary.verifyFactIds.length > 0 &&
    summary.authorityMode === 'authority' &&
    blockers().length === 0
  return {
    pass,
    detail: `terminal=${closed?.lifecycle}/${closed?.terminalOutcome?.kind} attributed=${summary.mutationsAttributedToTransition}/${summary.mutationsObserved} factIds=${summary.verifyFactIds.length} blockers=${blockers().map((b) => b.kind).join(',') || 'none'}`,
  }
})

addCase('SUCCESS without observed ensures facts is denied and never mints truth', () => {
  const contract = makeContract('t-noverify')
  const { session, blockers } = makeSession(() => vtrContext)
  const gate = session.authority
  gate.feedObservation({ observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  gate.admitTransition(contract)
  gate.activateTransition('t-noverify', makeWitness(contract))
  const verdict = gate.terminalize({ transitionId: 't-noverify', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const closed = session.state().transitions['t-noverify']
  const kinds = blockers().map((b) => b.kind)
  const pass =
    !verdict.ok &&
    closed?.terminalOutcome?.kind !== 'SUCCESS' &&
    kinds.includes('verify-proof-not-observed') &&
    kinds.includes('kernel-command-denied')
  return { pass, detail: `verdict=${JSON.stringify(verdict)} outcome=${closed?.terminalOutcome?.kind} blockers=${kinds.join(',')}` }
})

addCase('admitted-but-never-activated transition verifies SUCCESS only from observed facts', () => {
  const contract = makeContract('t-term')
  const { session, blockers } = makeSession(() => vtrContext)
  const gate = session.authority
  gate.feedObservation({ observedAtMs: 1000, predicates: RESOURCE_IN_REACH })
  gate.admitTransition(contract)
  const verdict = gate.terminalize({ transitionId: 't-term', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const closed = session.state().transitions['t-term']
  const pass = verdict.ok && closed?.lifecycle === 'TERMINAL' && closed.terminalOutcome?.kind === 'SUCCESS' && blockers().length === 0
  return { pass, detail: `lifecycle=${closed?.lifecycle} blockers=${blockers().map((b) => `${b.kind}:${b.detail}`).join('|') || 'none'}` }
})

addCase('namespaced kernel world accepts the bare Reach dimension convention', () => {
  // Live proof regression: the host world identity carries 'minecraft:' while
  // Reach identities are bare. Registration must agree under normalization.
  const session = createKernelAuthoritySession({
    world: { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 7 },
    generationId: 'gen-1',
    journalPath: null,
  })
  session.bindActuationContext(() => vtrContext)
  const contract = makeContract('t-ns')
  session.authority.feedObservation({ observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  const admitted = session.authority.admitTransition(contract)
  const activated = session.authority.activateTransition('t-ns', makeWitness(contract))
  const pass = admitted.ok && activated.ok && session.blockers().length === 0
  return { pass, detail: `admit=${JSON.stringify(admitted)} activate=${JSON.stringify(activated)} blockers=${session.blockers().map((b) => `${b.kind}:${b.detail}`).join('|') || 'none'}` }
})

addCase('controller contract with the bare runtime dimension is admitted by a namespaced host world', () => {
  // Production regression: HOST world keys are namespaced while the sensor's
  // self.dimension is bare. A namespace-only difference is the same world.
  const session = createKernelAuthoritySession({
    world: { serverId: 'srv', dimension: 'minecraft:overworld', worldEpoch: 7 },
    generationId: 'gen-1',
    journalPath: null,
  })
  const admitted = session.authority.admitContract(controllerSpec('controller:c-ns:1', 'overworld'))
  const activated = admitted.ok ? session.authority.activateTransition('controller:c-ns:1', null) : { ok: false as const, reason: 'not-admitted' }
  const otherWorld = session.authority.admitContract(controllerSpec('controller:c-nether:2', 'the_nether'))
  const pass = admitted.ok && activated.ok && !otherWorld.ok && otherWorld.reason === 'CONTRACT_WORLD_MISMATCH'
  return { pass, detail: `admit=${JSON.stringify(admitted)} activate=${JSON.stringify(activated)} nether=${JSON.stringify(otherWorld)}` }
})

addCase('non-success terminal closes via the kind-preserving stand-in as evidence, not a blocker', () => {
  const contract = makeContract('t-fail')
  const { session, blockers } = makeSession(() => vtrContext)
  const gate = session.authority
  gate.feedObservation({ observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  gate.admitTransition(contract)
  gate.activateTransition('t-fail', makeWitness(contract))
  const verdict = gate.terminalize({ transitionId: 't-fail', contractHash: contract.contractHash, outcome: { kind: 'PROVEN_INFEASIBLE', reason: 'no-path' } })
  const closed = session.state().transitions['t-fail']
  const summary = session.summary()
  const pass =
    verdict.ok &&
    closed?.lifecycle === 'TERMINAL' &&
    closed.terminalOutcome?.kind === 'CANCELED' &&
    summary.projectionLimitations === 1 &&
    summary.projectionLimitationKinds.includes('PROVEN_INFEASIBLE') &&
    blockers().length === 0 &&
    Object.keys(session.state().leases).length === 0
  return { pass, detail: `lifecycle=${closed?.lifecycle}/${closed?.terminalOutcome?.kind} limitations=${summary.projectionLimitationKinds.join(',') || 'none'} leases=${Object.keys(session.state().leases).length} blockers=${blockers().map((b) => `${b.kind}:${b.detail}`).join('|') || 'none'}` }
})

// --------------------------------------------------------------------------
// 2b. Adversarial authority cases (real session, not a stub).
// --------------------------------------------------------------------------

addCase('controller-transition mutations are attributed by kernel identity, not by label', () => {
  let hash: string | null = null
  const { session, blockers } = makeSession(() => ({
    actionId: 'a1', epoch: 1, authority: 'controller:walk_to', transitionId: 'controller:c1:1', transitionContractHash: hash,
  }))
  const admitted = session.authority.admitContract(controllerSpec('controller:c1:1'))
  if (admitted.ok) hash = admitted.contractHash
  session.authority.activateTransition('controller:c1:1', null)
  session.observeMutation({ surface: 'pathfinder.setGoal', guarded: true, leaseOutcome: 'granted', argsSignature: ['vec3(1,64,2)'], instanceHint: null })
  const summary = session.summary()
  const pass = admitted.ok && summary.mutationsAttributedToTransition === 1 && blockers().length === 0 && summary.coverageComplete
  return { pass, detail: `attributed=${summary.mutationsAttributedToTransition} blockers=${blockers().map((b) => `${b.kind}:${b.detail}`).join('|') || 'none'}` }
})

addCase('a mutation presenting a foreign contract hash is a hard blocker', () => {
  const { session, blockers } = makeSession(() => ({
    actionId: 'a1', epoch: 1, authority: 'controller:walk_to', transitionId: 'controller:c2:1', transitionContractHash: 'forged-hash',
  }))
  session.authority.admitContract(controllerSpec('controller:c2:1'))
  session.authority.activateTransition('controller:c2:1', null)
  session.observeMutation({ surface: 'pathfinder.setGoal', guarded: true, leaseOutcome: 'granted', argsSignature: ['vec3(1,64,2)'], instanceHint: null })
  const found = blockers().filter((b) => b.kind === 'mutation-without-transition-authority')
  return { pass: found.length === 1 && !session.summary().coverageComplete, detail: `blockers=${blockers().map((b) => `${b.kind}:${b.detail}`).join('|')}` }
})

addCase('terminalize presenting a mismatched contract hash is denied and leaves the transition live', () => {
  const { session } = makeSession()
  const admitted = session.authority.admitContract(controllerSpec('controller:c3:1'))
  session.authority.activateTransition('controller:c3:1', null)
  const verdict = session.authority.terminalize({ transitionId: 'controller:c3:1', contractHash: 'forged-hash', outcome: { kind: 'ACTION_FAILED', reason: 'x' } })
  const live = session.state().transitions['controller:c3:1']
  const pass = admitted.ok && !verdict.ok && verdict.reason.startsWith('contract-hash-mismatch') && live?.lifecycle === 'ACTIVE'
  return { pass, detail: `verdict=${JSON.stringify(verdict)} lifecycle=${live?.lifecycle}` }
})

addCase('a settle for a step the kernel never issued neither debits budget nor reconciles', () => {
  const { session, blockers } = makeSession()
  const admitted = session.authority.admitContract(controllerSpec('controller:c4:1'))
  session.authority.activateTransition('controller:c4:1', null)
  const before = JSON.stringify(session.state().transitions['controller:c4:1']?.usage ?? null)
  session.authority.settleStepEffect({ transitionId: 'controller:c4:1', intentId: 'i', stepId: 'never-issued', status: 'active', verified: true, progressed: true })
  const after = JSON.stringify(session.state().transitions['controller:c4:1']?.usage ?? null)
  const pass = admitted.ok && before === after && blockers().some((b) => b.kind === 'observer-error')
  return { pass, detail: `budgetUnchanged=${before === after} blockers=${blockers().map((b) => b.kind).join(',')}` }
})

addCase('a controller transition\'s mission predicate retires once it is terminal', () => {
  const { session } = makeSession()
  const spec = controllerSpec('controller:c5:1')
  const admitted = session.authority.admitContract(spec)
  session.authority.activateTransition('controller:c5:1', null)
  const whileLive = session.state().missionPredicates.includes(spec.desiredPredicate)
  if (admitted.ok) session.authority.terminalize({ transitionId: 'controller:c5:1', contractHash: admitted.contractHash, outcome: { kind: 'ACTION_FAILED', reason: 'x' } })
  const afterTerminal = session.state().missionPredicates.includes(spec.desiredPredicate)
  return { pass: admitted.ok && whileLive && !afterTerminal, detail: `whileLive=${whileLive} afterTerminal=${afterTerminal}` }
})

addCase('a stale cached observation is never re-attested as fresh SUCCESS proof', () => {
  let clock = 1_000
  const session = createKernelAuthoritySession({ world: WORLD, generationId: 'gen-1', journalPath: null, now: () => clock })
  session.bindActuationContext(() => vtrContext)
  const contract = makeContract('t-stale')
  const gate = session.authority
  gate.feedObservation({ observedAtMs: 1000, predicates: RESOURCE_IN_REACH })
  gate.admitTransition(contract)
  gate.activateTransition('t-stale', makeWitness(contract))
  clock += MAX_REATTEST_AGE_MS + 1
  const verdict = gate.terminalize({ transitionId: 't-stale', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const outcome = session.state().transitions['t-stale']?.terminalOutcome?.kind
  const pass = !verdict.ok && outcome !== 'SUCCESS' && session.blockers().some((b) => b.kind === 'verify-proof-not-observed')
  return { pass, detail: `verdict=${JSON.stringify(verdict)} outcome=${outcome}` }
})

addCase('observed truth does not survive a world change into the next contract', () => {
  const { session } = makeSession(() => vtrContext)
  const gate = session.authority
  const overworld = makeContract('t-ow')
  gate.feedObservation({ observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  gate.admitTransition(overworld)
  gate.activateTransition('t-ow', makeWitness(overworld))
  gate.terminalize({ transitionId: 't-ow', contractHash: overworld.contractHash, outcome: { kind: 'WORLD_CHANGED', field: 'dimension', observed: 'the_nether' } })
  const netherIdentity: ReachIdentity = { ...IDENTITY, worldKey: 'srv|the_nether|7', dimension: 'the_nether' }
  const nether = createInventoryReachTransition({
    mission: { id: 'm:oak_log:1', kind: 'inventory_at_least', item: 'oak_log', count: 1 },
    interactionReach: 5,
    sourceNames: ['oak_log'],
    identity: netherIdentity,
    transitionId: 't-nether',
  }).contract
  const admitted = gate.admitTransition(nether)
  // No post-change observation was fed: the overworld facts must not be
  // re-attested, so activation cannot prove its requires.
  const activated = gate.activateTransition('t-nether', { ...makeWitness(nether), observedIdentity: netherIdentity })
  const pass = session.state().world.dimension === 'the_nether' && admitted.ok && !activated.ok
  return { pass, detail: `world=${session.state().world.dimension} admit=${JSON.stringify(admitted)} activate=${JSON.stringify(activated)}` }
})

// --------------------------------------------------------------------------
// 3. Hard blockers: unmapped / unguarded / unattributed mutations.
// --------------------------------------------------------------------------

addCase('unmapped mutation surface is a hard blocker', () => {
  const { session, blockers } = makeSession(() => vtrContext)
  session.observeMutation({ surface: 'bot.notAMethod', guarded: true, leaseOutcome: 'granted', argsSignature: [], instanceHint: null })
  const found = blockers().filter((b) => b.kind === 'unmapped-mutation-surface')
  return { pass: found.length === 1 && !session.summary().coverageComplete, detail: `blockers=${blockers().map((b) => b.kind).join(',')}` }
})

addCase('unguarded mutation surface is a hard blocker even when mapped', () => {
  const { session, blockers } = makeSession(() => vtrContext)
  session.observeMutation({ surface: 'bot.attack', guarded: false, leaseOutcome: 'granted', argsSignature: ['entity#42'], instanceHint: '42' })
  const found = blockers().filter((b) => b.kind === 'unguarded-mutation-surface')
  const summary = session.summary()
  return { pass: found.length === 1 && summary.mutationsUnguarded === 1 && !summary.coverageComplete, detail: `unguarded=${summary.mutationsUnguarded} blockers=${found.length}` }
})

addCase('a mutation attributed to a transition the kernel never admitted is a hard blocker', () => {
  const { session, blockers } = makeSession(() => ({ ...vtrContext, authority: 'unknown-label' }))
  session.observeMutation({ surface: 'pathfinder.setGoal', guarded: true, leaseOutcome: 'granted', argsSignature: ['vec3(1,64,2)'], instanceHint: null })
  const found = blockers().filter((b) => b.kind === 'mutation-without-transition-authority')
  return { pass: found.length === 1, detail: `blockers=${blockers().map((b) => b.kind).join(',')}` }
})

addCase('mutation with no in-flight action is a hard blocker', () => {
  const { session, blockers } = makeSession()
  session.observeMutation({ surface: 'bot.setControlState', guarded: true, leaseOutcome: 'granted', argsSignature: ['string:forward', 'boolean:true'], instanceHint: null })
  const found = blockers().filter((b) => b.kind === 'mutation-without-transition-authority')
  return { pass: found.length === 1, detail: `blockers=${blockers().map((b) => b.kind).join(',')}` }
})

addCase('declared host adapter-config scope is typed and separately counted', () => {
  const hostScope = { category: 'adapter-config', label: 'bootstrap-movement-pin' }
  const { session, blockers } = makeSession(() => ({
    actionId: null,
    epoch: null,
    authority: 'host-adapter-config',
    transitionId: null,
    transitionContractHash: null,
    hostScope,
  }))
  session.observeMutation({ surface: 'pathfinder.setMovements', guarded: true, leaseOutcome: 'granted', argsSignature: ['object'], instanceHint: null })
  const summary = session.summary()
  const authorityBlockers = blockers().filter((b) => b.kind === 'mutation-without-transition-authority')
  return {
    pass: summary.mutationsObserved === 1 &&
      summary.mutationsHostScoped === 1 &&
      summary.mutationsAttributedToTransition === 0 &&
      summary.mutationsMapped === 1 &&
      authorityBlockers.length === 0 &&
      summary.coverageComplete,
    detail: `observed=${summary.mutationsObserved} hostScoped=${summary.mutationsHostScoped} attributed=${summary.mutationsAttributedToTransition} blockers=${authorityBlockers.length} coverageComplete=${summary.coverageComplete}`,
  }
})

addCase('lease-denied dispatch is counted and still observed', () => {
  const { session } = makeSession()
  session.observeMutation({ surface: 'bot.dig', guarded: true, leaseOutcome: 'denied', argsSignature: ['block:oak_log@1,64,2'], instanceHint: '1,64,2' })
  const summary = session.summary()
  return { pass: summary.mutationsDeniedByLease === 1 && summary.mutationsObserved === 1, detail: `denied=${summary.mutationsDeniedByLease} observed=${summary.mutationsObserved}` }
})

addCase('an observer that throws cannot break the session', () => {
  const session = createKernelAuthoritySession({ world: WORLD, generationId: 'gen-1', journalPath: null, now: () => 1_000 })
  session.bindActuationContext(() => { throw new Error('resolver exploded') })
  session.observeMutation({ surface: 'bot.dig', guarded: true, leaseOutcome: 'granted', argsSignature: [], instanceHint: null })
  const hasObserverError = session.blockers().some((b) => b.kind === 'observer-error')
  return { pass: session.summary().mutationsObserved === 1, detail: `observed=1 observerError=${hasObserverError}` }
})

let failures = 0
process.stdout.write('kernel authority session (V4.1.2) - surface map + gated lifecycle + hard blockers\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} kernel-authority-session cases passed\n`)
if (failures > 0) process.exit(1)
