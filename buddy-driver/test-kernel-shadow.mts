// test-kernel-shadow.mts - V4.1.2 Phase-1 shadow observer coverage.
//
// Pure: no bot connection, no socket, no network, journalPath=null unless a
// case explicitly writes to a tmp file. Proves:
//   1. every mutation surface the production guard/observer can emit maps to a
//      canonical V4.1.2 resource bundle + effect permit (the inventory gate);
//   2. a well-formed Reach lifecycle replays through the executable kernel
//      (REGISTER -> ADMIT -> proofs -> witness -> ACQUIRE -> ISSUE -> DISPATCH
//      -> RECONCILE -> VERIFY) with zero blockers;
//   3. unmapped / unguarded / transition-unattributed mutations are recorded
//      as hard migration blockers, never silently accepted.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createKernelShadowSession } from './kernel-shadow-session.ts'
import type { KernelShadowSession, ShadowBlocker } from './kernel-shadow-session.ts'
import {
  MUTATING_BOT_METHODS,
  OBSERVED_UNGUARDED_BOT_METHODS,
} from './resident-safety.ts'
import { mapMutationSurface } from '../jev-agent/src/vtr/kernel-shadow-map.ts'
import type { ShadowMutationContext } from '../jev-agent/src/vtr/kernel-shadow-map.ts'
import { createInventoryReachTransition } from '../jev-agent/src/vtr/reach-scheduler.ts'
import type { ReachIdentity, ReachTransitionContract, ReachWitness } from '../jev-agent/src/vtr/reach.ts'

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

function makeSession(context: () => ShadowMutationContext | null = () => null): {
  session: KernelShadowSession
  blockers: () => readonly ShadowBlocker[]
} {
  const session = createKernelShadowSession({
    world: WORLD,
    generationId: 'gen-1',
    journalPath: null,
    now: () => 1_000,
  })
  session.bindActuationContext(context)
  return { session, blockers: session.blockers }
}

const vtrContext: ShadowMutationContext = {
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
 * mapped shadow surface. Anything missing here is a coverage hole the live
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
      else if (/\.(ts|mts)$/.test(entry.name) && !entry.name.startsWith('test-') && !entry.name.includes('kernel-shadow')) sources.push(path)
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
// 2. Full Reach lifecycle replay through the executable kernel.
// --------------------------------------------------------------------------

addCase('committed Reach transition replays commit/step/terminal with zero blockers', () => {
  const { session, blockers } = makeSession(() => vtrContext)
  const contract = makeContract('t-1')
  session.observe({ type: 'world-observation', observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  session.observe({ type: 'transition-committed', contract, witness: makeWitness(contract), lifecycle: 'active' })
  const registered = session.state().transitions['t-1']
  const activeOk = registered?.lifecycle === 'ACTIVE'
  session.observe({ type: 'mechanical-step-issued', transitionId: 't-1', intentId: 'i-1', stepId: 's-1', effectKind: 'locomotion' })
  session.observeMutation({ surface: 'pathfinder.setGoal', guarded: true, leaseOutcome: 'granted', argsSignature: ['vec3(1,64,2)'], instanceHint: null })
  session.observeMutation({ surface: 'pathfinder.goto', guarded: true, leaseOutcome: 'granted', argsSignature: ['object'], instanceHint: null })
  session.observe({ type: 'mechanical-step-settled', transitionId: 't-1', intentId: 'i-1', stepId: 's-1', status: 'active', verified: false, progressed: true })
  // The verification-time observation: the production verifier saw the
  // ensures predicate true with real evidence; VERIFY replays from those
  // observed facts only — never from the SUCCESS signal itself.
  session.observe({
    type: 'world-observation',
    observedAtMs: 1100,
    predicates: { ...COMMIT_PREDICATES, 'reach.resource-source': { truth: 'true', evidenceId: 'verify:0:in-reach' } },
  })
  session.observe({ type: 'transition-terminal', transitionId: 't-1', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const terminal = session.state().transitions['t-1']
  const summary = session.summary()
  const pass =
    activeOk &&
    terminal?.lifecycle === 'TERMINAL' &&
    terminal.terminalOutcome?.kind === 'SUCCESS' &&
    summary.mutationsObserved === 2 &&
    summary.mutationsMapped === 2 &&
    summary.mutationsAttributedToTransition === 2 &&
    summary.coverageComplete &&
    summary.verifyFactIds.length > 0 &&
    summary.typedTerminals === 1 &&
    blockers().length === 0
  return {
    pass,
    detail: `active=${activeOk} terminal=${terminal?.lifecycle}/${terminal?.terminalOutcome?.kind} mapped=${summary.mutationsMapped}/${summary.mutationsObserved} attributed=${summary.mutationsAttributedToTransition} factIds=${summary.verifyFactIds.length} blockers=${blockers().map((b) => b.kind).join(',') || 'none'}`,
  }
})

addCase('SUCCESS terminal without observed ensures facts refuses to mint truth', () => {
  const { session, blockers } = makeSession(() => vtrContext)
  const contract = makeContract('t-noverify')
  session.observe({ type: 'world-observation', observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  session.observe({ type: 'transition-committed', contract, witness: makeWitness(contract), lifecycle: 'active' })
  // No verification-time observation flips 'reach.resource-source' to true:
  // the kernel must refuse VERIFY_SUCCESS and the shadow must record it.
  session.observe({ type: 'transition-terminal', transitionId: 't-noverify', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const summary = session.summary()
  const blockerKinds = blockers().map((b) => b.kind)
  const pass =
    summary.kernelDenied > 0 &&
    blockerKinds.includes('verify-proof-not-observed') &&
    blockerKinds.includes('kernel-command-denied')
  return {
    pass,
    detail: `kernelDenied=${summary.kernelDenied} blockers=${blockerKinds.join(',') || 'none'}`,
  }
})

addCase('transition committed already-terminal replays VERIFY_SUCCESS without activation', () => {
  const { session, blockers } = makeSession(() => vtrContext)
  const contract = makeContract('t-term')
  session.observe({ type: 'world-observation', observedAtMs: 1000, predicates: { ...COMMIT_PREDICATES, 'reach.resource-source': { truth: 'true', evidenceId: 'verify:0:in-reach' } } })
  session.observe({ type: 'transition-committed', contract, witness: makeWitness(contract), lifecycle: 'terminal' })
  session.observe({ type: 'transition-terminal', transitionId: 't-term', contractHash: contract.contractHash, outcome: { kind: 'SUCCESS' } })
  const terminal = session.state().transitions['t-term']
  const pass = terminal?.lifecycle === 'TERMINAL' && terminal.terminalOutcome?.kind === 'SUCCESS' && blockers().length === 0
  return { pass, detail: `lifecycle=${terminal?.lifecycle} blockers=${blockers().map((b) => `${b.kind}:${b.detail}`).join('|') || 'none'}` }
})

addCase('non-success terminal closes via stand-in and records the projection limitation', () => {
  const { session, blockers } = makeSession(() => vtrContext)
  const contract = makeContract('t-fail')
  session.observe({ type: 'world-observation', observedAtMs: 1000, predicates: COMMIT_PREDICATES })
  session.observe({ type: 'transition-committed', contract, witness: makeWitness(contract), lifecycle: 'active' })
  session.observe({ type: 'transition-terminal', transitionId: 't-fail', contractHash: contract.contractHash, outcome: { kind: 'PROVEN_INFEASIBLE', reason: 'no-path' } })
  const terminal = session.state().transitions['t-fail']
  const summary = session.summary()
  const pass =
    terminal?.lifecycle === 'TERMINAL' &&
    terminal.terminalOutcome?.kind === 'CANCELED' &&
    summary.projectionLimitations === 1 &&
    summary.projectionLimitationKinds.includes('PROVEN_INFEASIBLE') &&
    blockers().some((b) => b.kind === 'shadow-projection-limitation')
  return { pass, detail: `lifecycle=${terminal?.lifecycle}/${terminal?.terminalOutcome?.kind} limitations=${summary.projectionLimitationKinds.join(',') || 'none'} blockers=${blockers().map((b) => `${b.kind}:${b.detail}`).join('|') || 'none'}` }
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

addCase('mutation outside vtr-reach authority is a hard blocker', () => {
  const { session, blockers } = makeSession(() => ({ ...vtrContext, authority: 'legacy' }))
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

addCase('lease-denied dispatch is counted and still observed', () => {
  const { session } = makeSession()
  session.observeMutation({ surface: 'bot.dig', guarded: true, leaseOutcome: 'denied', argsSignature: ['block:oak_log@1,64,2'], instanceHint: '1,64,2' })
  const summary = session.summary()
  return { pass: summary.mutationsDeniedByLease === 1 && summary.mutationsObserved === 1, detail: `denied=${summary.mutationsDeniedByLease} observed=${summary.mutationsObserved}` }
})

addCase('an observer that throws cannot break the session', () => {
  const session = createKernelShadowSession({ world: WORLD, generationId: 'gen-1', journalPath: null, now: () => 1_000 })
  session.bindActuationContext(() => { throw new Error('resolver exploded') })
  session.observeMutation({ surface: 'bot.dig', guarded: true, leaseOutcome: 'granted', argsSignature: [], instanceHint: null })
  const hasObserverError = session.blockers().some((b) => b.kind === 'observer-error')
  return { pass: session.summary().mutationsObserved === 1, detail: `observed=1 observerError=${hasObserverError}` }
})

let failures = 0
process.stdout.write('kernel shadow (V4.1.2 Phase-1) - surface map + lifecycle replay + hard blockers\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} kernel-shadow cases passed\n`)
if (failures > 0) process.exit(1)
