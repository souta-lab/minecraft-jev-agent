// kernel-shadow-session.ts - V4.1.2 kernel authority session (shadow + authority modes).
//
// The host owns this session and drives the V4.1.2 executable kernel
// (`applyKernelCommand`) against observed production mutation dispatches and
// the Reach Transition lifecycle.
//
// Mode 'shadow' (default): OBSERVER ONLY. No result reaches production code;
// kernel denials and unmapped/unauthorized mutations are journaled migration
// blockers, not gates.
//
// Mode 'authority': the session also exposes `authority`, a KernelReachAuthority
// gate the production runtime MUST consult before actuation. The same kernel
// command path runs causally BEFORE the gated act (admit -> activate -> issue
// -> dispatch -> settle -> terminalize) and a denied verdict is journaled and
// returned so production fails closed; a denial never triggers a legacy
// fallback because the legacy path is disabled by the same mode flag.
//
// The session holds kernel-internal trusted capabilities because buddy-driver
// is the host/wiring layer; production semantic code must never import this
// module or `architecture/v4.1/kernel-internal/*` — it sees only the narrow
// `KernelShadowSink`/`KernelReachAuthority` surfaces.
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
  type KernelCommand,
  type KernelResult,
  type KernelState,
  type ResourceLease,
  type WorldIdentity,
} from '../architecture/v4.1/kernel.ts'
import type { TrustedCapability } from '../architecture/v4.1/kernel-internal/authority-secret.ts'
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
} from '../architecture/v4.1/kernel-internal/trusted-adapter.ts'
import {
  mapMutationSurface,
  reachContractToKernelSpec,
  SHADOW_REGISTRY,
  type KernelAuthorityMode,
  type KernelGateVerdict,
  type KernelReachAuthority,
  type KernelShadowInput,
  type KernelWorldObservation,
  type ShadowMutationContext,
} from '../jev-agent/src/vtr/kernel-shadow-map.ts'
import type { ReachTransitionContract, ReachWitness } from '../jev-agent/src/vtr/reach.ts'

export type ShadowBlockerKind =
  | 'unmapped-mutation-surface'
  | 'unguarded-mutation-surface'
  | 'mutation-without-transition-authority'
  | 'mutation-exceeds-transition-leases'
  | 'kernel-command-denied'
  | 'contract-mapping-failed'
  | 'verify-proof-not-observed'
  | 'shadow-projection-limitation'
  | 'observer-error'

export interface ShadowBlocker {
  readonly kind: ShadowBlockerKind
  readonly atMonoMs: number
  readonly detail: string
  readonly surface?: string
  readonly transitionId?: string | null
}

export interface ShadowSessionConfig {
  readonly world: WorldIdentity
  readonly generationId: string
  /** Append-only JSONL destination for shadow records; null disables file IO. */
  readonly journalPath: string | null
  readonly now?: () => number
  /**
   * 'shadow' (default): observer only; denials are journaled migration
   * blockers. 'authority': the session exposes `authority`, a verdict-
   * returning gate the production runtime must consult before actuation;
   * kernel denials gate production and remain journaled as hard evidence.
   */
  readonly authorityMode?: KernelAuthorityMode
}

export interface ShadowCoverageSummary {
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
   * Reach terminal kinds with no command-reachable kernel outcome. Each is a
   * named 'shadow-projection-limitation' blocker and a cutover blocker; the
   * kernel-side lifecycle is closed with an explicit CANCELED stand-in whose
   * reason preserves the Reach outcome kind.
   */
  readonly projectionLimitations: number
  readonly projectionLimitationKinds: readonly string[]
  readonly blockers: readonly ShadowBlocker[]
  /** True only when every observed mutation mapped and carried authority. */
  readonly coverageComplete: boolean
  /** 'shadow' = observer only; 'authority' = kernel gates Reach actuation. */
  readonly authorityMode: KernelAuthorityMode
  /** Gate calls the kernel refused under authority mode (also journaled). */
  readonly gateDenials: readonly { readonly gate: string; readonly reason: string }[]
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

interface OpenEffect {
  readonly commitId: string
  readonly stepId: string
  readonly transitionId: string
}

export interface KernelShadowSession {
  /** Sink for semantic lifecycle/step inputs (ReachMissionRuntime). */
  readonly observe: (input: KernelShadowInput) => void
  /** Sink for the mutation boundary (withActuationLease/createActuationPort). */
  readonly observeMutation: (record: {
    readonly surface: string
    readonly guarded: boolean
    readonly leaseOutcome: 'granted' | 'denied'
    readonly argsSignature: readonly string[]
    readonly instanceHint?: string | null
  }) => void
  /** Late-bind the actuation-context resolver (executor.current projection). */
  bindActuationContext(resolve: () => ShadowMutationContext | null): void
  /**
   * V4.1.2 production-authority gate; non-null only when the session was
   * created with `authorityMode: 'authority'`. Production code holds this via
   * the narrow `KernelReachAuthority` interface (no capability access).
   */
  readonly authority: KernelReachAuthority | null
  readonly summary: () => ShadowCoverageSummary
  readonly blockers: () => readonly ShadowBlocker[]
  readonly state: () => KernelState
}

export function createKernelShadowSession(config: ShadowSessionConfig): KernelShadowSession {
  const authorityMode: KernelAuthorityMode = config.authorityMode ?? 'shadow'
  const now = config.now ?? (() => Date.now())
  const t0 = now()
  let state: KernelState = createKernelState({
    world: config.world,
    generationId: config.generationId,
    missionPredicates: [],
    verifierRegistry: [SHADOW_REGISTRY.verifier],
    progressRegistry: [SHADOW_REGISTRY.progress],
    contractCompilerRegistry: [SHADOW_REGISTRY.compiler],
    missionAuthority: SHADOW_REGISTRY.missionAuthority,
  })
  const caps = {
    compiler: trustedContractCompiler(SHADOW_REGISTRY.compiler.id),
    scheduler: trustedScheduler(),
    dispatcher: trustedDispatcher(),
    verifier: trustedVerifier(SHADOW_REGISTRY.verifier.id),
    mission: trustedMissionAuthority(SHADOW_REGISTRY.missionAuthority.id),
    witness: trustedWitnessValidator(SHADOW_REGISTRY.witness.id),
    progress: trustedProgressEvaluator(SHADOW_REGISTRY.progress.id),
    worldAdapter: trustedWorldAdapter('world'),
    runtimeAdapter: trustedWorldAdapter('runtime'),
    clock: trustedWorldAdapter('clock'),
    journal: trustedJournalRecovery(),
  }
  const controllerCaps = new Map<string, TrustedCapability>()
  const openEffects = new Map<string, OpenEffect>()
  const witnessRevisions = new Map<string, number>()
  const witnessByTransition = new Map<string, ReachWitness>()
  const blockers: ShadowBlocker[] = []
  let resolveContext: (() => ShadowMutationContext | null) | null = null
  let lastFactSignature = ''
  // The most recent verified world observation, cached so commit/step commands
  // can re-establish proof freshness after mission/registry revisions.
  let lastPredicates: Readonly<Record<string, { readonly truth: 'true' | 'false' | 'unknown'; readonly evidenceId: string | null }>> = {}
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
        // Shadow journaling is best-effort: never fail production over it.
      }
    }
  }

  const block = (kind: ShadowBlockerKind, detail: string, extra: Record<string, unknown> = {}): void => {
    const blocker: ShadowBlocker = { kind, atMonoMs: mono(), detail, ...extra }
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
      verifier: SHADOW_REGISTRY.verifier,
      facts,
      materialChange: signature !== lastFactSignature,
      observedAtMonoMs: at,
      capability: caps.verifier,
    }), via, transitionId)
    lastFactSignature = signature
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

  /** REGISTER_TRANSITION + mission authorization + ADMIT_TRANSITION. */
  const admitTransition = (contract: ReachTransitionContract, via: string): KernelGateVerdict => {
    const mapped = reachContractToKernelSpec(contract, config.world)
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
      type: 'shadow-contract',
      transitionId: contract.transitionId,
      reachContractHash: contract.contractHash,
      kernelContractHash: canonical.contractHash,
      desiredPredicate: canonical.desiredPredicate,
    })
    const registered = apply({
      kind: 'REGISTER_TRANSITION',
      contract: canonical,
      compiler: SHADOW_REGISTRY.compiler,
      capability: caps.compiler,
    }, via, contract.transitionId)
    if (!registered.ok) return deny('admitTransition', registered.reason)
    if (state.transitions[contract.transitionId] === undefined) return deny('admitTransition', 'transition-not-registered')
    if (!state.missionPredicates.includes(canonical.desiredPredicate)) {
      const mission = apply({
        kind: 'UPDATE_MISSION',
        predicates: [...state.missionPredicates, canonical.desiredPredicate],
        authority: SHADOW_REGISTRY.missionAuthority,
        capability: caps.mission,
      }, via, contract.transitionId)
      if (!mission.ok) return deny('admitTransition', mission.reason)
    }
    const admitted = apply({ kind: 'ADMIT_TRANSITION', transitionId: contract.transitionId, capability: caps.scheduler }, via, contract.transitionId)
    if (!admitted.ok) return deny('admitTransition', admitted.reason)
    return { ok: true }
  }

  /**
   * Re-establish proof + witness freshness after registration changed the
   * RuntimeBinding, then acquire the declared resource bundle -> ACTIVE.
   * `acquire: false` leaves the transition RUNNABLE (shadow replay of a
   * contract that committed directly to terminal).
   */
  const activateTransition = (transitionId: string, witness: ReachWitness | null, acquire: boolean, via: string): KernelGateVerdict => {
    // RuntimeBinding covers factRevision/registryRevision/missionRevision, so
    // every command above just invalidated the freshness of earlier proofs and
    // witnesses. Re-establish them NOW, in order, before activation: the same
    // verified observation the production commit consumed, then the witness.
    feedSnapshot(lastPredicates, via, undefined, transitionId)
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
        validator: SHADOW_REGISTRY.witness,
        capability: caps.witness,
      }, via, transitionId)
      if (!accepted.ok) return deny('activateTransition', accepted.reason)
    }
    if (!acquire) return { ok: true }
    const granted = apply({ kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId, capability: caps.scheduler }, via, transitionId)
    if (!granted.ok) return deny('activateTransition', granted.reason)
    return { ok: true }
  }

  const commitTransition = (contract: ReachTransitionContract, witness: ReachWitness | null, lifecycle: 'active' | 'terminal'): void => {
    const admitted = admitTransition(contract, 'transition-committed')
    if (!admitted.ok || state.transitions[contract.transitionId] === undefined) return
    activateTransition(contract.transitionId, witness, lifecycle === 'active', 'transition-committed')
  }

  const terminalTransition = (input: Extract<KernelShadowInput, { type: 'transition-terminal' }>, authoritative = false): KernelGateVerdict => {
    const transition = state.transitions[input.transitionId]
    if (transition === undefined) {
      block('kernel-command-denied', `terminal for unregistered transition ${input.transitionId}`, { transitionId: input.transitionId })
      return deny('terminalize', `unregistered-transition:${input.transitionId}`)
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
        // was not observed 'true', the kernel MUST refuse and the miss is a
        // hard blocker, not a synthesized proof.
        feedSnapshot(lastPredicates, 'transition-terminal', undefined, input.transitionId)
        const missing = [...contract.ensures, ...contract.invariants].filter(
          (predicateId) => lastPredicates[predicateId]?.truth !== 'true')
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
        verifier: SHADOW_REGISTRY.verifier,
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
          verifier: SHADOW_REGISTRY.verifier,
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
          if (authoritative) {
            // In authority mode the kind-preserving CANCELED stand-in IS the
            // designed kernel closure for Reach outcomes the kernel cannot
            // type; the record is evidence, not a migration blocker.
            journal({ type: 'terminal-projection-limitation', transitionId: input.transitionId, reachOutcomeKind: kind, detail: limitation })
          } else {
            block('shadow-projection-limitation', `${kind}: ${limitation}`, { transitionId: input.transitionId })
          }
        }
        // The kernel cannot express this Reach terminal kind; CANCELED is the
        // mechanical stand-in that closes the shadow lifecycle. The reason
        // preserves the Reach kind and the projection-limitation blocker
        // above marks it as a cutover blocker — never a semantic cancel.
        apply({
          kind: 'REQUEST_CANCEL',
          transitionId: input.transitionId,
          reason: authoritative ? `authority-terminal:${kind}` : `shadow-terminal:${kind}`,
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
    if (!authoritative) return { ok: true }
    if (input.outcome.kind === 'SUCCESS' && successVerified !== true) {
      return deny('terminalize', `kernel-verify-success-denied:${input.transitionId}`)
    }
    const closed = state.transitions[input.transitionId]
    if (closed === undefined || closed.lifecycle !== 'TERMINAL') {
      return deny('terminalize', `kernel-transition-not-terminal:${input.transitionId}`)
    }
    return { ok: true }
  }

  const stepIssued = (input: Extract<KernelShadowInput, { type: 'mechanical-step-issued' }>, authoritative = false): KernelGateVerdict => {
    if (input.effectKind !== 'locomotion') {
      block('unmapped-mutation-surface', `step effect kind ${input.effectKind} is not in the Reach map`, { transitionId: input.transitionId })
      return authoritative ? deny('issueStepEffect', `unmapped-effect-kind:${input.effectKind}`) : { ok: true }
    }
    if (openEffects.has(input.stepId)) {
      block('kernel-command-denied', `duplicate dispatch for mechanical step ${input.stepId}`, { transitionId: input.transitionId })
      return authoritative ? deny('issueStepEffect', `duplicate-step-dispatch:${input.stepId}`) : { ok: true }
    }
    // ISSUE_EFFECT re-checks activationPreconditions against the CURRENT
    // RuntimeBinding: any snapshot/registry/mission revision since activation
    // stales the proofs and witness. Re-establish both before issuing, mirroring
    // the commit-time freshness fence the production controller already passed.
    feedSnapshot(lastPredicates, 'mechanical-step-issued', undefined, input.transitionId)
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
        validator: SHADOW_REGISTRY.witness,
        capability: caps.witness,
      }, 'mechanical-step-issued', input.transitionId)
    }
    const issued = apply({
      kind: 'ISSUE_EFFECT',
      transitionId: input.transitionId,
      effect: 'MOVE',
      scope: 'reach:leg',
      ttlMs: 30_000,
      capability: controllerCap(input.transitionId),
    }, 'mechanical-step-issued', input.transitionId)
    if (!issued.ok) return authoritative ? deny('issueStepEffect', issued.reason) : { ok: true }
    const commitId = (issued.events[0]?.data.commitId as string | undefined) ?? null
    if (commitId === null) {
      block('observer-error', 'ISSUE_EFFECT succeeded without a commitId event')
      return authoritative ? deny('issueStepEffect', 'missing-commit-id') : { ok: true }
    }
    const dispatched = apply({
      kind: 'BEGIN_EFFECT_DISPATCH',
      commitId,
      capability: caps.dispatcher,
    }, 'mechanical-step-issued', input.transitionId)
    if (!dispatched.ok) return authoritative ? deny('issueStepEffect', dispatched.reason) : { ok: true }
    openEffects.set(input.stepId, { commitId, stepId: input.stepId, transitionId: input.transitionId })
    journal({ type: 'effect-dispatch', transitionId: input.transitionId, stepId: input.stepId, commitId, authority: authoritative })
    return { ok: true }
  }

  const stepSettled = (input: Extract<KernelShadowInput, { type: 'mechanical-step-settled' }>): void => {
    const open = openEffects.get(input.stepId)
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
    if (open === null || open === undefined) {
      block('observer-error', `settled step ${input.stepId} had no open kernel effect commit`, { transitionId: input.transitionId })
      return
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
        verifier: SHADOW_REGISTRY.verifier,
        capability: caps.verifier,
      }, 'mechanical-step-settled', input.transitionId)
    } else {
      apply({
        kind: 'RECONCILE_EFFECT',
        commitId: open.commitId,
        observation: 'UNKNOWN',
        factIds: [],
        verifier: SHADOW_REGISTRY.verifier,
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
      const transitionId = context?.authority === 'vtr-reach' ? context.transitionId ?? null : null
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
        block('mutation-without-transition-authority', `surface ${record.surface} fired outside a VTR transition context`, {
          surface: record.surface,
          transitionId: context?.transitionId ?? null,
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

  const observe = (input: KernelShadowInput): void => {
    try {
      switch (input.type) {
        case 'world-observation':
          lastPredicates = input.predicates
          feedSnapshot(input.predicates, 'world-observation')
          return
        case 'transition-committed':
          commitTransition(input.contract, input.witness, input.lifecycle)
          return
        case 'transition-terminal':
          terminalTransition(input)
          return
        case 'mechanical-step-issued':
          stepIssued(input)
          return
        case 'mechanical-step-settled':
          stepSettled(input)
          return
        case 'mutation':
          observeMutation(input)
          return
      }
    } catch (error) {
      block('observer-error', `input ${input.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const authorityGate: KernelReachAuthority | null = authorityMode === 'authority'
    ? {
        mode: 'authority',
        feedObservation(input: KernelWorldObservation): void {
          observe({ type: 'world-observation', ...input })
        },
        admitTransition(contract: ReachTransitionContract): KernelGateVerdict {
          return admitTransition(contract, 'gate-admit')
        },
        activateTransition(transitionId: string, witness: ReachWitness | null): KernelGateVerdict {
          return activateTransition(transitionId, witness, true, 'gate-activate')
        },
        issueStepEffect(input: {
          readonly transitionId: string
          readonly intentId: string
          readonly stepId: string
          readonly effectKind: string
        }): KernelGateVerdict {
          return stepIssued({ type: 'mechanical-step-issued', ...input }, true)
        },
        settleStepEffect(input: {
          readonly transitionId: string
          readonly intentId: string
          readonly stepId: string
          readonly status: string
          readonly verified: boolean
          readonly progressed: boolean
        }): void {
          stepSettled({ type: 'mechanical-step-settled', ...input })
        },
        terminalize(input: {
          readonly transitionId: string
          readonly contractHash: string
          readonly outcome: { readonly kind: string } & Readonly<Record<string, unknown>>
        }): KernelGateVerdict {
          return terminalTransition({ type: 'transition-terminal', ...input } as Extract<KernelShadowInput, { type: 'transition-terminal' }>, true)
        },
      }
    : null

  return {
    observe,
    observeMutation,
    bindActuationContext(resolve: () => ShadowMutationContext | null): void {
      resolveContext = resolve
    },
    authority: authorityGate,
    summary(): ShadowCoverageSummary {
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
        authorityMode,
        gateDenials: [...gateDenials],
      }
    },
    blockers: () => [...blockers],
    state: () => state,
  }
}
