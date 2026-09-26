// kernel-authority-session.ts - the V4.1.2 kernel authority session.
//
// The host owns this session and drives the executable kernel
// (`applyKernelCommand`). It exposes exactly one runtime authority surface,
// `authority` (KernelTransitionAuthority), which production MUST consult
// before actuation. The kernel command path runs causally BEFORE every gated
// act (admit -> activate -> issue -> dispatch -> settle -> terminalize); a
// denied verdict is journaled and returned so production fails closed. There
// is no observer-only mode and no alternative lifecycle input path.
//
// `observeMutation` is the evidence half: every leased mutation dispatch is
// attributed to the kernel transition that owns the body (or a declared host
// scope) and unattributed/unmapped/lease-uncovered dispatches are journaled as
// hard blockers.
//
// The session holds kernel-internal trusted capabilities because buddy-driver
// is the host/wiring layer; production semantic code must never import this
// module or `packages/kernel/kernel-internal/*` — it sees only the narrow
// `KernelTransitionAuthority` surface.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import {
  applyKernelCommand,
  createKernelState,
  createTransitionContract,
  resourceKey,
  resourcesOverlap,
  type CanonicalTransitionContract,
  type EffectKind,
  type KernelCommand,
  type KernelResult,
  type TransitionContractSpec,
  type KernelState,
  type ResourceLease,
  type WorldIdentity,
} from '../kernel/kernel.ts'
import type { TrustedCapability } from '../kernel/kernel-internal/authority-secret.ts'
import {
  trustedContractCompiler,
  trustedController,
  trustedDispatcher,
  trustedJournalRecovery,
  trustedMissionAuthority,
  trustedProgressEvaluator,
  trustedScheduler,
  trustedVerifier,
  trustedWitnessValidator,
  trustedWorldAdapter,
} from '../kernel/kernel-internal/trusted-adapter.ts'
import {
  mapMutationSurface,
  reachContractToKernelSpec,
  CONTROLLER_AUTHORITY_REGISTRY,
  REACH_AUTHORITY_REGISTRY,
  type KernelGateVerdict,
  type KernelTransitionAuthority,
  type KernelWorldObservation,
  type MutationAuthorityContext,
} from '../jev-agent/src/reach/kernel-authority-map.ts'
import type { ReachTransitionContract, ReachWitness } from '../jev-agent/src/reach/transition.ts'

export type KernelSessionBlockerKind =
  | 'unmapped-mutation-surface'
  | 'unguarded-mutation-surface'
  | 'mutation-without-transition-authority'
  | 'mutation-exceeds-transition-leases'
  | 'kernel-command-denied'
  | 'contract-mapping-failed'
  | 'verify-proof-not-observed'
  | 'observer-error'

interface TerminalInput {
  readonly transitionId: string
  readonly contractHash: string
  readonly outcome: { readonly kind: string } & Readonly<Record<string, unknown>>
}

interface StepIssuedInput {
  readonly transitionId: string
  readonly intentId: string
  readonly stepId: string
  readonly effectKind: string
}

interface StepSettledInput {
  readonly transitionId: string
  readonly intentId: string
  readonly stepId: string
  readonly status: string
  readonly verified: boolean
  readonly progressed: boolean
}

export interface KernelSessionBlocker {
  readonly kind: KernelSessionBlockerKind
  readonly atMonoMs: number
  readonly detail: string
  readonly surface?: string
  readonly transitionId?: string | null
}

export interface KernelAuthoritySessionConfig {
  readonly world: WorldIdentity
  readonly generationId: string
  /** Append-only JSONL destination for session records; null disables file IO. */
  readonly journalPath: string | null
  readonly now?: () => number
}

export interface KernelSessionSummary {
  readonly mutationsObserved: number
  readonly mutationsMapped: number
  readonly mutationsDeniedByLease: number
  readonly mutationsAttributedToTransition: number
  /**
   * Mutations declared under a typed host control-plane / adapter-lifecycle
   * scope (for example the bootstrap movement pin). Counted on a separate
   * denominator from transition-attributed mutations.
   */
  readonly mutationsHostScoped: number
  readonly mutationsUnguarded: number
  readonly lifecycleCommands: number
  readonly kernelDenied: number
  /** Fact ids the kernel actually consumed for the last VERIFY_SUCCESS. */
  readonly verifyFactIds: readonly string[]
  /** Reach terminals projected onto an exact typed kernel outcome. */
  readonly typedTerminals: number
  /**
   * Terminal kinds with no command-reachable kernel outcome. The kernel-side
   * lifecycle is closed with an explicit CANCELED stand-in whose reason
   * preserves the terminal kind; each occurrence is journaled as evidence.
   */
  readonly projectionLimitations: number
  readonly projectionLimitationKinds: readonly string[]
  readonly blockers: readonly KernelSessionBlocker[]
  /** True only when every observed mutation mapped and carried authority. */
  readonly coverageComplete: boolean
  /** Evidence constant: the kernel gates every actuation (there is no other mode). */
  readonly authorityMode: 'authority'
  /** Gate calls the kernel refused (also journaled). */
  readonly gateDenials: readonly { readonly gate: string; readonly reason: string }[]
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/**
 * Upper bound on how old a cached verified observation may be when it is
 * re-attested for a new RuntimeBinding. Production feeds observations every
 * decision tick (heartbeat <= 3 s), so this only ever withholds truth that is
 * genuinely stale.
 */
export const MAX_REATTEST_AGE_MS = 30_000

/**
 * The host world key spells dimensions with the `minecraft:` namespace while
 * runtime observations use the bare spelling. A namespace-only difference is
 * the same world; the spec is rebound to the kernel's spelling. A real
 * mismatch (another dimension/server/epoch) is left intact and the kernel
 * refuses it with CONTRACT_WORLD_MISMATCH.
 */
function canonicalWorldSpelling(spec: TransitionContractSpec, world: WorldIdentity): TransitionContractSpec {
  const bare = (dimension: string): string => dimension.replace(/^minecraft:/, '')
  const sameWorld =
    spec.world.serverId === world.serverId &&
    spec.world.worldEpoch === world.worldEpoch &&
    bare(spec.world.dimension) === bare(world.dimension)
  return sameWorld && spec.world.dimension !== world.dimension ? { ...spec, world: { ...world } } : spec
}

interface OpenEffect {
  readonly commitId: string
  readonly stepId: string
  readonly transitionId: string
}

export interface KernelAuthoritySession {
  /** Sink for the mutation boundary (withActuationLease/createActuationPort). */
  readonly observeMutation: (record: {
    readonly surface: string
    readonly guarded: boolean
    readonly leaseOutcome: 'granted' | 'denied'
    readonly argsSignature: readonly string[]
    readonly instanceHint?: string | null
  }) => void
  /** Late-bind the actuation-context resolver (executor.current projection). */
  bindActuationContext(resolve: () => MutationAuthorityContext | null): void
  /**
   * The V4.1.2 runtime authority gate. Production code holds this via the
   * narrow `KernelTransitionAuthority` interface (no capability access).
   */
  readonly authority: KernelTransitionAuthority
  readonly summary: () => KernelSessionSummary
  readonly blockers: () => readonly KernelSessionBlocker[]
  readonly state: () => KernelState
}

export function createKernelAuthoritySession(config: KernelAuthoritySessionConfig): KernelAuthoritySession {
  const now = config.now ?? (() => Date.now())
  const t0 = now()
  let state: KernelState = createKernelState({
    world: config.world,
    generationId: config.generationId,
    missionPredicates: [],
    verifierRegistry: [REACH_AUTHORITY_REGISTRY.verifier],
    progressRegistry: [REACH_AUTHORITY_REGISTRY.progress],
    contractCompilerRegistry: [REACH_AUTHORITY_REGISTRY.compiler, CONTROLLER_AUTHORITY_REGISTRY.compiler],
    missionAuthority: REACH_AUTHORITY_REGISTRY.missionAuthority,
  })
  const caps = {
    compiler: trustedContractCompiler(REACH_AUTHORITY_REGISTRY.compiler.id),
    controllerCompiler: trustedContractCompiler(CONTROLLER_AUTHORITY_REGISTRY.compiler.id),
    scheduler: trustedScheduler(),
    dispatcher: trustedDispatcher(),
    verifier: trustedVerifier(REACH_AUTHORITY_REGISTRY.verifier.id),
    mission: trustedMissionAuthority(REACH_AUTHORITY_REGISTRY.missionAuthority.id),
    witness: trustedWitnessValidator(REACH_AUTHORITY_REGISTRY.witness.id),
    progress: trustedProgressEvaluator(REACH_AUTHORITY_REGISTRY.progress.id),
    worldAdapter: trustedWorldAdapter('world'),
    runtimeAdapter: trustedWorldAdapter('runtime'),
    clock: trustedWorldAdapter('clock'),
    journal: trustedJournalRecovery(),
  }
  const controllerCaps = new Map<string, TrustedCapability>()
  const openEffects = new Map<string, OpenEffect>()
  const witnessRevisions = new Map<string, number>()
  const witnessByTransition = new Map<string, ReachWitness>()
  // The caller-facing contract hash each admitted transition is bound to (the
  // Reach contract hash for Reach, the canonical kernel hash for admitContract).
  // Mutation attribution and terminalization must present exactly this hash.
  const boundContractHashes = new Map<string, string>()
  const blockers: KernelSessionBlocker[] = []
  let resolveContext: (() => MutationAuthorityContext | null) | null = null
  let lastFactSignature = ''
  // The most recent verified world observation, cached so commit/step commands
  // can re-establish proof freshness after mission/registry revisions. It is
  // re-attested only while younger than MAX_REATTEST_AGE_MS and is discarded
  // on any world/generation change: stale truth never becomes fresh proof.
  let lastPredicates: Readonly<Record<string, { readonly truth: 'true' | 'false' | 'unknown'; readonly evidenceId: string | null }>> = {}
  let lastObservedMono: number | null = null
  let seq = 0
  let mutationsObserved = 0
  let mutationsMapped = 0
  let mutationsDeniedByLease = 0
  let mutationsAttributed = 0
  let mutationsHostScoped = 0
  let mutationsUnguarded = 0
  let lifecycleCommands = 0
  let kernelDenied = 0
  let verifyFactIds: readonly string[] = []
  let typedTerminals = 0
  const projectionLimitationKinds: string[] = []
  const gateDenials: { readonly gate: string; readonly reason: string }[] = []

  const mono = (): number => Math.max(0, now() - t0)

  const journal = (record: Record<string, unknown>): void => {
    seq += 1
    const line = JSON.stringify({ seq, monoMs: mono(), generationId: config.generationId, ...record })
    if (config.journalPath !== null) {
      try {
        mkdirSync(dirname(config.journalPath), { recursive: true })
        appendFileSync(config.journalPath, `${line}\n`)
      } catch {
        // Journal writes are best-effort: never fail production over it.
      }
    }
  }

  const block = (kind: KernelSessionBlockerKind, detail: string, extra: Record<string, unknown> = {}): void => {
    const blocker: KernelSessionBlocker = { kind, atMonoMs: mono(), detail, ...extra }
    blockers.push(blocker)
    journal({ type: 'blocker', ...blocker })
  }

  /**
   * Advance kernel time and apply one command. `build` may be a thunk so
   * `atMonoMs`/`observedAtMonoMs` fields bind to the post-advance
   * `state.monotonicMs` (the kernel rejects STALE_YIELD_ACK / future or
   * regressed observation times otherwise). Every result is journaled; a
   * kernel refusal is a migration blocker (production did something the kernel
   * would not authorize), never a production failure.
   */
  const apply = (build: KernelCommand | ((atMonoMs: number) => KernelCommand), via: string, transitionId?: string): KernelResult => {
    try {
      const advance: KernelResult = applyKernelCommand(state, {
        kind: 'ADVANCE_TIME',
        toMonoMs: mono(),
        capability: caps.clock,
      })
      if (advance.ok) state = advance.state
      const command = typeof build === 'function' ? build(state.monotonicMs) : build
      lifecycleCommands += 1
      const result = applyKernelCommand(state, command)
      journal({
        type: 'kernel-command',
        via,
        command: command.kind,
        // Transition-scoped rows bind the gated command path to the exact
        // contract instance; world/generation commands have no such scope.
        ...(transitionId === undefined ? {} : { transitionId }),
        ok: result.ok,
        ...(result.ok ? {} : { reason: result.reason }),
        events: result.ok ? result.events.map((event) => event.kind) : [],
      })
      if (result.ok) {
        state = result.state
      } else {
        kernelDenied += 1
        block('kernel-command-denied', `${via}:${command.kind}:${result.reason}`, {})
      }
      return result
    } catch (error) {
      block('observer-error', `${via}:${typeof build === 'function' ? 'thunk' : build.kind}:${error instanceof Error ? error.message : String(error)}`)
      return { ok: false, state, reason: 'observer-error', events: [] }
    }
  }

  const controllerCap = (transitionId: string): TrustedCapability => {
    const hash = state.transitionContracts[transitionId] ?? 'unregistered'
    const key = `${transitionId}|${hash}|${state.generationId}`
    const existing = controllerCaps.get(key)
    if (existing !== undefined) return existing
    const cap = trustedController(transitionId, hash, state.generationId)
    controllerCaps.set(key, cap)
    return cap
  }

  const feedSnapshot = (
    predicates: Readonly<Record<string, { readonly truth: 'true' | 'false' | 'unknown'; readonly evidenceId: string | null }>>,
    via: string,
    effectCommitId?: string,
    transitionId?: string,
  ): void => {
    const facts = Object.entries(predicates).map(([predicateId, evidence]) => ({
      predicateId,
      truth: evidence.truth,
      valueHash: sha({ predicateId, evidenceId: evidence.evidenceId }),
      ...(effectCommitId === undefined ? {} : { effectCommitId }),
    }))
    if (facts.length === 0) return
    const signature = sha(facts.map((fact) => [fact.predicateId, fact.truth]))
    apply((at) => ({
      kind: 'ACCEPT_VERIFIED_SNAPSHOT',
      verifier: REACH_AUTHORITY_REGISTRY.verifier,
      facts,
      materialChange: signature !== lastFactSignature,
      observedAtMonoMs: at,
      capability: caps.verifier,
    }), via, transitionId)
    lastFactSignature = signature
  }

  /**
   * Re-attest the cached observation for a new RuntimeBinding (registry /
   * mission revisions stale proofs without changing the observed world). Only
   * an observation younger than MAX_REATTEST_AGE_MS may be re-attested; an
   * older one is withheld so the kernel denies for lack of fresh proof.
   */
  const reattestLastObservation = (via: string, transitionId?: string): void => {
    if (lastObservedMono === null) return
    const age = mono() - lastObservedMono
    if (age > MAX_REATTEST_AGE_MS) {
      journal({ type: 'stale-observation-not-reattested', via, ageMs: age, ...(transitionId === undefined ? {} : { transitionId }) })
      return
    }
    feedSnapshot(lastPredicates, via, undefined, transitionId)
  }

  /** Observed world truth and witnesses never survive a world/generation boundary. */
  const forgetObservedWorld = (): void => {
    lastPredicates = {}
    lastObservedMono = null
    lastFactSignature = ''
    witnessByTransition.clear()
    witnessRevisions.clear()
  }

  const deny = (gate: string, reason: string): KernelGateVerdict => {
    gateDenials.push({ gate, reason })
    journal({ type: 'gate-denied', gate, reason })
    return { ok: false, reason }
  }

  const transitionRegistered = (transitionId: string): CanonicalTransitionContract | null => {
    const hash = state.transitionContracts[transitionId]
    return hash === undefined ? null : state.contracts[hash] ?? null
  }

  /** REGISTER_TRANSITION + mission authorization + ADMIT_TRANSITION on a canonical contract. */
  const admitCanonical = (canonical: CanonicalTransitionContract, via: string): KernelGateVerdict => {
    const registered = apply({
      kind: 'REGISTER_TRANSITION',
      contract: canonical,
      compiler: canonical.family === 'vtr-reach' ? REACH_AUTHORITY_REGISTRY.compiler : CONTROLLER_AUTHORITY_REGISTRY.compiler,
      capability: canonical.family === 'vtr-reach' ? caps.compiler : caps.controllerCompiler,
    }, via, canonical.transitionId)
    if (!registered.ok) return deny('admitContract', registered.reason)
    if (state.transitions[canonical.transitionId] === undefined) return deny('admitContract', 'transition-not-registered')
    if (!state.missionPredicates.includes(canonical.desiredPredicate)) {
      const mission = apply({
        kind: 'UPDATE_MISSION',
        predicates: [...state.missionPredicates, canonical.desiredPredicate],
        authority: REACH_AUTHORITY_REGISTRY.missionAuthority,
        capability: caps.mission,
      }, via, canonical.transitionId)
      if (!mission.ok) return deny('admitContract', mission.reason)
    }
    const admitted = apply({ kind: 'ADMIT_TRANSITION', transitionId: canonical.transitionId, capability: caps.scheduler }, via, canonical.transitionId)
    if (!admitted.ok) return deny('admitContract', admitted.reason)
    return { ok: true }
  }

  /** REGISTER_TRANSITION + mission authorization + ADMIT_TRANSITION. */
  const admitTransition = (contract: ReachTransitionContract, via: string): KernelGateVerdict => {
    const mapped = reachContractToKernelSpec(contract, state.world)
    if (!mapped.ok) {
      block('contract-mapping-failed', `${contract.transitionId}: ${mapped.reason}`, { transitionId: contract.transitionId })
      return deny('admitTransition', mapped.reason)
    }
    let canonical: CanonicalTransitionContract
    try {
      canonical = createTransitionContract(mapped.spec)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      block('contract-mapping-failed', `${contract.transitionId}: ${reason}`, { transitionId: contract.transitionId })
      return deny('admitTransition', reason)
    }
    journal({
      type: 'admitted-contract',
      transitionId: contract.transitionId,
      reachContractHash: contract.contractHash,
      kernelContractHash: canonical.contractHash,
      desiredPredicate: canonical.desiredPredicate,
    })
    const admitted = admitCanonical(canonical, via)
    if (admitted.ok) boundContractHashes.set(contract.transitionId, contract.contractHash)
    return admitted
  }

  /**
   * Re-establish proof + witness freshness after registration changed the
   * RuntimeBinding, then acquire the declared resource bundle -> ACTIVE.
   * `acquire: false` leaves the transition RUNNABLE (replay of a
   * contract that committed directly to terminal).
   */
  const activateTransition = (transitionId: string, witness: ReachWitness | null, acquire: boolean, via: string): KernelGateVerdict => {
    // RuntimeBinding covers factRevision/registryRevision/missionRevision, so
    // every command above just invalidated the freshness of earlier proofs and
    // witnesses. Re-establish them NOW, in order, before activation: the same
    // verified observation the production commit consumed, then the witness.
    reattestLastObservation(via, transitionId)
    if (witness !== null) {
      witnessByTransition.set(transitionId, witness)
      const revision = Math.max(1, witnessRevisions.get(transitionId) ?? 0)
      witnessRevisions.set(transitionId, revision)
      const accepted = apply({
        kind: 'ACCEPT_WITNESS_PROOF',
        transitionId,
        witnessRevision: revision,
        witnessRefHash: sha({ witnessId: witness.witnessId, evidenceId: witness.evidenceId }),
        relationId: 'reach-route-witness',
        validator: REACH_AUTHORITY_REGISTRY.witness,
        capability: caps.witness,
      }, via, transitionId)
      if (!accepted.ok) return deny('activateTransition', accepted.reason)
    }
    if (!acquire) return { ok: true }
    const granted = apply({ kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId, capability: caps.scheduler }, via, transitionId)
    if (!granted.ok) return deny('activateTransition', granted.reason)
    return { ok: true }
  }

  const terminalTransition = (input: TerminalInput): KernelGateVerdict => {
    const transition = state.transitions[input.transitionId]
    if (transition === undefined) {
      block('kernel-command-denied', `terminal for unregistered transition ${input.transitionId}`, { transitionId: input.transitionId })
      return deny('terminalize', `unregistered-transition:${input.transitionId}`)
    }
    const boundHash = boundContractHashes.get(input.transitionId)
    if (boundHash !== undefined && boundHash !== input.contractHash) {
      block('kernel-command-denied', `terminal for ${input.transitionId} presents contract ${input.contractHash} but it is bound to ${boundHash}`, { transitionId: input.transitionId })
      return deny('terminalize', `contract-hash-mismatch:${input.transitionId}`)
    }
    if (transition.lifecycle === 'TERMINAL') return { ok: true }
    let successVerified: boolean | null = null
    if (input.outcome.kind === 'SUCCESS') {
      const contract = transitionRegistered(input.transitionId)
      if (contract !== null) {
        // Independent VERIFY: feed only the facts the runtime actually
        // observed (the last verified world-observation, which is the
        // observation the production verifier consumed for this outcome).
        // SUCCESS must never mint truth: if an ensures/invariants predicate
        // was not observed 'true' in a still-fresh observation, the kernel
        // MUST refuse and the miss is a hard blocker, not a synthesized proof.
        reattestLastObservation('transition-terminal', input.transitionId)
        const fresh = lastObservedMono !== null && mono() - lastObservedMono <= MAX_REATTEST_AGE_MS ? lastPredicates : {}
        const missing = [...contract.ensures, ...contract.invariants].filter(
          (predicateId) => fresh[predicateId]?.truth !== 'true')
        journal({
          type: 'verify-attempt',
          transitionId: input.transitionId,
          ensures: [...contract.ensures],
          invariants: [...contract.invariants],
          missingObservedProof: missing,
          observedPredicateCount: Object.keys(lastPredicates).length,
        })
        if (missing.length > 0) {
          block('verify-proof-not-observed', `ensures/invariants lack observed 'true' facts: ${missing.join(',')}`, {
            transitionId: input.transitionId,
          })
        }
      }
      const verified = apply({
        kind: 'VERIFY_SUCCESS',
        transitionId: input.transitionId,
        causalCredit: 'self',
        verifier: REACH_AUTHORITY_REGISTRY.verifier,
        capability: caps.verifier,
      }, 'transition-terminal', input.transitionId)
      successVerified = verified.ok
      if (verified.ok) {
        verifyFactIds = verified.events.flatMap((event) =>
          event.kind === 'TRANSITION_VERIFIED_SUCCESS' ? ((event.data.factIds as readonly string[] | undefined) ?? []) : [])
        typedTerminals += 1
        journal({
          type: 'verify-provenance',
          transitionId: input.transitionId,
          verifier: REACH_AUTHORITY_REGISTRY.verifier,
          factIds: verifyFactIds,
        })
      }
    }
    const afterVerify = state.transitions[input.transitionId]
    if (afterVerify !== undefined && afterVerify.lifecycle === 'ACTIVE' && afterVerify.pendingTerminalOutcome !== null) {
      apply((at) => ({
        kind: 'ACK_TERMINAL_YIELD',
        transitionId: input.transitionId,
        atMonoMs: at,
        capability: controllerCap(input.transitionId),
      }), 'transition-terminal', input.transitionId)
    }
    const stillLive = state.transitions[input.transitionId]
    if (stillLive !== undefined && stillLive.lifecycle !== 'TERMINAL' && stillLive.terminalOutcome === null && stillLive.pendingTerminalOutcome === null) {
      const kind = input.outcome.kind
      let limitation: string | null = null
      if (kind === 'WORLD_CHANGED' && typeof input.outcome.observed !== 'undefined') {
        // Exact typed outcome: CHANGE_WORLD terminalizes with WORLD_CHANGED.
        const observed: WorldIdentity =
          input.outcome.field === 'dimension'
            ? { ...state.world, dimension: String(input.outcome.observed) }
            : input.outcome.field === 'worldEpoch'
              ? { ...state.world, worldEpoch: Number(input.outcome.observed) }
              : { ...state.world, serverId: String(input.outcome.observed) }
        apply({ kind: 'CHANGE_WORLD', world: observed, capability: caps.worldAdapter }, 'transition-terminal', input.transitionId)
        forgetObservedWorld()
        typedTerminals += 1
        journal({ type: 'terminal-projection', transitionId: input.transitionId, reachOutcomeKind: kind, kernelOutcome: 'WORLD_CHANGED', derived: true })
      } else if (kind === 'GENERATION_CHANGED' && typeof input.outcome.observed !== 'undefined') {
        // Honest kernel command for the real event; the kernel suspends for
        // rebind rather than terminalizing, so the Reach GENERATION_CHANGED
        // terminal itself remains a projection limitation.
        apply({
          kind: 'CHANGE_GENERATION',
          generationId: String(input.outcome.observed),
          capability: caps.runtimeAdapter,
        }, 'transition-terminal', input.transitionId)
        forgetObservedWorld()
        limitation = 'kernel suspends for generation rebind; no GENERATION_CHANGED terminal outcome'
      } else if (kind === 'BUDGET_EXHAUSTED') {
        // Honest typed derivation: the kernel's own budget sweep in
        // ADVANCE_TIME terminalizes when kernel-side accounting crosses the
        // canonical contract budget. If it does not reproduce the breach,
        // that divergence is the projection limitation — the outcome is
        // never fabricated.
        apply((at) => ({ kind: 'ADVANCE_TIME', toMonoMs: at, capability: caps.clock }), 'transition-terminal', input.transitionId)
        const derived = state.transitions[input.transitionId]
        const derivedOutcome = derived?.terminalOutcome ?? derived?.pendingTerminalOutcome ?? null
        if (derivedOutcome !== null) {
          typedTerminals += 1
          journal({ type: 'terminal-projection', transitionId: input.transitionId, reachOutcomeKind: kind, kernelOutcome: derivedOutcome.kind, derived: true })
        } else {
          limitation = `kernel budget sweep did not reproduce ${kind}:${String(input.outcome.budget ?? 'unknown')}`
        }
      } else if (kind !== 'SUCCESS') {
        limitation = `kernel has no command-reachable typed outcome for ${kind}`
      }
      const afterTyped = state.transitions[input.transitionId]
      if (afterTyped !== undefined && afterTyped.lifecycle === 'ACTIVE' && afterTyped.pendingTerminalOutcome !== null) {
        apply((at) => ({
          kind: 'ACK_TERMINAL_YIELD',
          transitionId: input.transitionId,
          atMonoMs: at,
          capability: controllerCap(input.transitionId),
        }), 'transition-terminal')
      }
      const needsStandIn = state.transitions[input.transitionId]
      if (
        needsStandIn !== undefined &&
        needsStandIn.lifecycle !== 'TERMINAL' &&
        needsStandIn.terminalOutcome === null &&
        needsStandIn.pendingTerminalOutcome === null
      ) {
        if (limitation !== null) {
          projectionLimitationKinds.push(kind)
          // The kind-preserving CANCELED stand-in IS the designed kernel
          // closure for terminal kinds the kernel cannot type; the record is
          // evidence, not a blocker.
          journal({ type: 'terminal-projection-limitation', transitionId: input.transitionId, reachOutcomeKind: kind, detail: limitation })
        }
        // CANCELED is the mechanical stand-in that closes the lifecycle; the
        // reason preserves the terminal kind — never a semantic cancel.
        apply({
          kind: 'REQUEST_CANCEL',
          transitionId: input.transitionId,
          reason: `authority-terminal:${kind}`,
          capability: caps.scheduler,
        }, 'transition-terminal', input.transitionId)
        const pending = state.transitions[input.transitionId]
        if (pending !== undefined && pending.cancelRequested) {
          apply((at) => ({
            kind: 'ACK_CANCEL_YIELD',
            transitionId: input.transitionId,
            atMonoMs: at,
            capability: controllerCap(input.transitionId),
          }), 'transition-terminal')
        }
        journal({ type: 'terminal-projection', transitionId: input.transitionId, reachOutcomeKind: kind, kernelOutcome: 'CANCELED', derived: false, standIn: true })
      }
    }
    for (const [commitId, open] of openEffects) {
      if (open.transitionId === input.transitionId) openEffects.delete(commitId)
    }
    retireControllerMissionPredicate(input.transitionId)
    if (input.outcome.kind === 'SUCCESS' && successVerified !== true) {
      return deny('terminalize', `kernel-verify-success-denied:${input.transitionId}`)
    }
    const closed = state.transitions[input.transitionId]
    if (closed === undefined || closed.lifecycle !== 'TERMINAL') {
      return deny('terminalize', `kernel-transition-not-terminal:${input.transitionId}`)
    }
    return { ok: true }
  }

  /**
   * A controller transition's desired predicate is scoped to that dispatch.
   * Once no live transition desires it, it leaves the kernel Mission so the
   * predicate set tracks live intent instead of growing for the whole run.
   * Reach predicates are Mission-owned and are never retired here.
   */
  const retireControllerMissionPredicate = (transitionId: string): void => {
    const contract = transitionRegistered(transitionId)
    if (contract === null || contract.family === 'vtr-reach') return
    if (state.transitions[transitionId]?.lifecycle !== 'TERMINAL') return
    const predicate = contract.desiredPredicate
    if (!state.missionPredicates.includes(predicate)) return
    const stillDesired = Object.values(state.transitions).some((other) =>
      other.transitionId !== transitionId &&
      other.lifecycle !== 'TERMINAL' &&
      transitionRegistered(other.transitionId)?.desiredPredicate === predicate)
    if (stillDesired) return
    apply({
      kind: 'UPDATE_MISSION',
      predicates: state.missionPredicates.filter((existing) => existing !== predicate),
      authority: REACH_AUTHORITY_REGISTRY.missionAuthority,
      capability: caps.mission,
    }, 'transition-terminal', transitionId)
  }

  const KERNEL_EFFECT_KINDS: readonly EffectKind[] = [
    'MOVE', 'LOOK', 'INTERACT', 'ATTACK', 'INVENTORY_MUTATION', 'EQUIP',
    'DIG', 'PLACE', 'CONSUME', 'CRAFT', 'STATION_MUTATION', 'COMMAND',
  ]
  const stepIssued = (input: StepIssuedInput): KernelGateVerdict => {
    // The gate-level effectKind resolves to one kernel EffectKind; the exact
    // permit scope is read from the transition's own declared contract so an
    // issued effect can never exceed the envelope the kernel admitted.
    const resolvedKind = input.effectKind === 'locomotion'
      ? 'MOVE'
      : (KERNEL_EFFECT_KINDS as readonly string[]).includes(input.effectKind)
        ? input.effectKind as EffectKind
        : null
    if (resolvedKind === null) {
      block('unmapped-mutation-surface', `step effect kind ${input.effectKind} is not in the kernel effect map`, { transitionId: input.transitionId })
      return deny('issueStepEffect', `unmapped-effect-kind:${input.effectKind}`)
    }
    const liveContract = transitionRegistered(input.transitionId)
    const permit = liveContract?.effects.find((p) => p.kind === resolvedKind)
    if (permit === undefined) {
      block('unmapped-mutation-surface', `transition ${input.transitionId} declares no ${resolvedKind} effect permit`, { transitionId: input.transitionId })
      return deny('issueStepEffect', `effect-not-permitted:${resolvedKind}`)
    }
    if (openEffects.has(input.stepId)) {
      block('kernel-command-denied', `duplicate dispatch for mechanical step ${input.stepId}`, { transitionId: input.transitionId })
      return deny('issueStepEffect', `duplicate-step-dispatch:${input.stepId}`)
    }
    // ISSUE_EFFECT re-checks activationPreconditions against the CURRENT
    // RuntimeBinding: any snapshot/registry/mission revision since activation
    // stales the proofs and witness. Re-establish both before issuing, mirroring
    // the commit-time freshness fence the production controller already passed.
    reattestLastObservation('mechanical-step-issued', input.transitionId)
    const witness = witnessByTransition.get(input.transitionId)
    const live = state.transitions[input.transitionId]
    if (witness !== undefined && live !== undefined) {
      const revision = witnessRevisions.get(input.transitionId) ?? live.witnessRevision
      apply({
        kind: 'ACCEPT_WITNESS_PROOF',
        transitionId: input.transitionId,
        witnessRevision: Math.max(1, revision),
        witnessRefHash: sha({ witnessId: witness.witnessId, evidenceId: witness.evidenceId }),
        relationId: 'reach-route-witness',
        validator: REACH_AUTHORITY_REGISTRY.witness,
        capability: caps.witness,
      }, 'mechanical-step-issued', input.transitionId)
    }
    const issued = apply({
      kind: 'ISSUE_EFFECT',
      transitionId: input.transitionId,
      effect: permit.kind,
      scope: permit.scope,
      ttlMs: 30_000,
      capability: controllerCap(input.transitionId),
    }, 'mechanical-step-issued', input.transitionId)
    if (!issued.ok) return deny('issueStepEffect', issued.reason)
    const commitId = (issued.events[0]?.data.commitId as string | undefined) ?? null
    if (commitId === null) {
      block('observer-error', 'ISSUE_EFFECT succeeded without a commitId event')
      return deny('issueStepEffect', 'missing-commit-id')
    }
    const dispatched = apply({
      kind: 'BEGIN_EFFECT_DISPATCH',
      commitId,
      capability: caps.dispatcher,
    }, 'mechanical-step-issued', input.transitionId)
    if (!dispatched.ok) return deny('issueStepEffect', dispatched.reason)
    openEffects.set(input.stepId, { commitId, stepId: input.stepId, transitionId: input.transitionId })
    journal({ type: 'effect-dispatch', transitionId: input.transitionId, stepId: input.stepId, commitId, authority: true })
    return { ok: true }
  }

  const stepSettled = (input: StepSettledInput): void => {
    const open = openEffects.get(input.stepId)
    if (open === undefined || open.transitionId !== input.transitionId) {
      // Never debit or reconcile a step the kernel did not issue for this
      // transition (double settle, settle after terminal, foreign step id).
      block('observer-error', `settled step ${input.stepId} had no open kernel effect commit for ${input.transitionId}`, { transitionId: input.transitionId })
      return
    }
    openEffects.delete(input.stepId)
    if (state.transitions[input.transitionId]?.lifecycle === 'ACTIVE') {
      apply({
        kind: 'DEBIT_USAGE',
        actorTransitionId: input.transitionId,
        targetTransitionId: input.transitionId,
        mechanicalSteps: 1,
        capability: controllerCap(input.transitionId),
      }, 'mechanical-step-settled', input.transitionId)
    }
    if (input.status === 'continuing' || input.status === 'active' || (input.status === 'terminal' && input.verified)) {
      feedSnapshot({
        'reach.mechanical-step': { truth: 'true', evidenceId: `step:${input.stepId}` },
      }, 'mechanical-step-settled', open.commitId, input.transitionId)
      const factId = Object.entries(state.facts)
        .filter(([, fact]) => fact.effectCommitId === open.commitId)
        .sort(([a], [b]) => a.localeCompare(b))
        .at(-1)?.[0]
      apply({
        kind: 'RECONCILE_EFFECT',
        commitId: open.commitId,
        observation: factId === undefined ? 'UNKNOWN' : 'OCCURRED',
        factIds: factId === undefined ? [] : [factId],
        verifier: REACH_AUTHORITY_REGISTRY.verifier,
        capability: caps.verifier,
      }, 'mechanical-step-settled', input.transitionId)
    } else {
      apply({
        kind: 'RECONCILE_EFFECT',
        commitId: open.commitId,
        observation: 'UNKNOWN',
        factIds: [],
        verifier: REACH_AUTHORITY_REGISTRY.verifier,
        capability: caps.verifier,
      }, 'mechanical-step-settled', input.transitionId)
    }
  }

  const observeMutation = (record: {
    readonly surface: string
    readonly guarded: boolean
    readonly leaseOutcome: 'granted' | 'denied'
    readonly argsSignature: readonly string[]
    readonly instanceHint?: string | null
  }): void => {
    try {
      mutationsObserved += 1
      const context = resolveContext?.() ?? null
      const instanceHint = record.instanceHint ?? null
      const mapped = mapMutationSurface(record.surface, instanceHint)
      if (record.leaseOutcome === 'denied') mutationsDeniedByLease += 1
      if (!record.guarded) mutationsUnguarded += 1
      if (mapped === null) {
        block('unmapped-mutation-surface', `surface ${record.surface} has no canonical resource bundle`, {
          surface: record.surface,
          transitionId: context?.transitionId ?? null,
        })
      }
      if (!record.guarded) {
        block('unguarded-mutation-surface', `surface ${record.surface} mutates without the generation lease guard`, {
          surface: record.surface,
          transitionId: context?.transitionId ?? null,
        })
      }
      // Attribution keys on kernel transition identity (id + canonical contract
      // hash), never on a provenance label: every executor claim carries the
      // identity the kernel admitted.
      const transitionId = context?.transitionId ?? null
      const hostScope = context?.hostScope ?? null
      let authorityState: string
      if (mapped === null) {
        authorityState = 'unmapped'
      } else if (transitionId === null && hostScope !== null) {
        // Declared host control-plane / adapter-lifecycle mutation: typed
        // authority category, counted on its own denominator, never a blocker.
        authorityState = 'host-scoped'
        mutationsHostScoped += 1
      } else if (transitionId === null) {
        authorityState = 'unattributed'
        block('mutation-without-transition-authority', `surface ${record.surface} fired outside a kernel transition context`, {
          surface: record.surface,
          transitionId: null,
        })
      } else {
        mutationsAttributed += 1
        const transition = state.transitions[transitionId]
        const contract = transitionRegistered(transitionId)
        if (transition === undefined || contract === null || transition.lifecycle !== 'ACTIVE') {
          authorityState = 'transition-not-active'
          block('mutation-without-transition-authority', `surface ${record.surface} attributed to ${transitionId} which is not ACTIVE in the kernel`, {
            surface: record.surface,
            transitionId,
          })
        } else if (context?.transitionContractHash !== boundContractHashes.get(transitionId)) {
          authorityState = 'contract-mismatch'
          block('mutation-without-transition-authority', `surface ${record.surface} carries contract ${context?.transitionContractHash ?? 'none'} but ${transitionId} is bound to ${boundContractHashes.get(transitionId) ?? 'none'}`, {
            surface: record.surface,
            transitionId,
          })
        } else {
          const leases = Object.values(state.leases).filter((lease) => lease.owner === transitionId)
          const uncovered = mapped.resources.filter((required) =>
            !leases.some((lease: ResourceLease) => resourcesOverlap(lease.resource, required) && lease.mode === 'EXCLUSIVE_WRITE'))
          const openCommit = [...openEffects.values()].find((effect) => effect.transitionId === transitionId) ?? null
          if (uncovered.length > 0) {
            authorityState = 'lease-uncovered'
            block('mutation-exceeds-transition-leases', `surface ${record.surface} requires ${uncovered.map(resourceKey).join(',')} beyond ${transitionId} leases`, {
              surface: record.surface,
              transitionId,
            })
          } else {
            authorityState = openCommit === null ? 'authorized-outside-open-dispatch' : 'authorized-in-dispatch'
          }
        }
      }
      journal({
        type: 'mutation',
        surface: record.surface,
        mapped: mapped !== null,
        guarded: record.guarded,
        leaseOutcome: record.leaseOutcome,
        argsSignature: record.argsSignature,
        instanceHint,
        context,
        ...(hostScope === null ? {} : { hostScope }),
        authorityState,
        ...(mapped === null ? {} : {
          resources: mapped.resources.map(resourceKey),
          effect: mapped.effect,
          scope: mapped.scope,
          bypassesGuardedProxy: mapped.bypassesGuardedProxy,
        }),
      })
      if (mapped !== null) mutationsMapped += 1
    } catch (error) {
      block('observer-error', `mutation ${record.surface}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const observeWorld = (input: KernelWorldObservation): void => {
    try {
      lastPredicates = input.predicates
      lastObservedMono = mono()
      feedSnapshot(input.predicates, 'world-observation')
    } catch (error) {
      block('observer-error', `world-observation: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const authorityGate: KernelTransitionAuthority = {
    feedObservation(input: KernelWorldObservation): void {
      observeWorld(input)
    },
    admitTransition(contract: ReachTransitionContract): KernelGateVerdict {
      return admitTransition(contract, 'gate-admit')
    },
    admitContract(spec: TransitionContractSpec): { readonly ok: true; readonly contractHash: string } | { readonly ok: false; readonly reason: string } {
      let canonical: CanonicalTransitionContract
      try {
        canonical = createTransitionContract(canonicalWorldSpelling(spec, state.world))
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        block('contract-mapping-failed', `${spec.transitionId}: ${reason}`, { transitionId: spec.transitionId })
        return { ok: false, reason }
      }
      journal({
        type: 'admitted-contract',
        transitionId: canonical.transitionId,
        kernelContractHash: canonical.contractHash,
        desiredPredicate: canonical.desiredPredicate,
        family: canonical.family,
      })
      const admitted = admitCanonical(canonical, 'gate-admit-contract')
      if (admitted.ok) boundContractHashes.set(canonical.transitionId, canonical.contractHash)
      return admitted.ok ? { ok: true, contractHash: canonical.contractHash } : { ok: false, reason: admitted.reason }
    },
    activateTransition(transitionId: string, witness: ReachWitness | null): KernelGateVerdict {
      return activateTransition(transitionId, witness, true, 'gate-activate')
    },
    issueStepEffect(input: StepIssuedInput): KernelGateVerdict {
      return stepIssued(input)
    },
    settleStepEffect(input: StepSettledInput): void {
      stepSettled(input)
    },
    terminalize(input: TerminalInput): KernelGateVerdict {
      return terminalTransition(input)
    },
  }

  return {
    observeMutation,
    bindActuationContext(resolve: () => MutationAuthorityContext | null): void {
      resolveContext = resolve
    },
    authority: authorityGate,
    summary(): KernelSessionSummary {
      const hardBlockers = blockers.filter((b) =>
        b.kind === 'unmapped-mutation-surface' ||
        b.kind === 'mutation-without-transition-authority' ||
        b.kind === 'mutation-exceeds-transition-leases' ||
        b.kind === 'unguarded-mutation-surface')
      return {
        mutationsObserved,
        mutationsMapped,
        mutationsDeniedByLease,
        mutationsAttributedToTransition: mutationsAttributed,
        mutationsHostScoped,
        mutationsUnguarded,
        lifecycleCommands,
        kernelDenied,
        verifyFactIds,
        typedTerminals,
        projectionLimitations: projectionLimitationKinds.length,
        projectionLimitationKinds: [...projectionLimitationKinds],
        blockers: [...blockers],
        coverageComplete: mutationsObserved > 0 && hardBlockers.length === 0,
        authorityMode: 'authority',
        gateDenials: [...gateDenials],
      }
    },
    blockers: () => [...blockers],
    state: () => state,
  }
}
