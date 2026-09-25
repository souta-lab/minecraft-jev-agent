// kernel-shadow-session.ts - V4.1.2 Phase-1 SHADOW authority observer.
//
// The host owns this session. It replays observed production mutation dispatches
// and the Reach Transition lifecycle through the V4.1.2 executable kernel
// (`applyKernelCommand`) as an OBSERVER ONLY: no result is returned to
// production code and no mutation is blocked by the shadow. The session holds
// kernel-internal trusted capabilities because buddy-driver is the host/wiring
// layer; production semantic code must never import this module or
// `architecture/v4.1/kernel-internal/*`.
//
// A mutation that does not map to a canonical resource bundle, is not
// attributable to a committed Transition on the migrated path, or would be
// denied by the kernel is recorded as a migration blocker in the shadow journal.
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
  type KernelShadowInput,
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
}

export interface ShadowCoverageSummary {
  readonly mutationsObserved: number
  readonly mutationsMapped: number
  readonly mutationsDeniedByLease: number
  readonly mutationsAttributedToTransition: number
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
  readonly summary: () => ShadowCoverageSummary
  readonly blockers: () => readonly ShadowBlocker[]
  readonly state: () => KernelState
}

export function createKernelShadowSession(config: ShadowSessionConfig): KernelShadowSession {
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
  let mutationsUnguarded = 0
  let lifecycleCommands = 0
  let kernelDenied = 0
  let verifyFactIds: readonly string[] = []
  let typedTerminals = 0
  const projectionLimitationKinds: string[] = []

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
  const apply = (build: KernelCommand | ((atMonoMs: number) => KernelCommand), via: string): KernelResult => {
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
    }), via)
    lastFactSignature = signature
  }

  const transitionRegistered = (transitionId: string): CanonicalTransitionContract | null => {
    const hash = state.transitionContracts[transitionId]
    return hash === undefined ? null : state.contracts[hash] ?? null
  }

  const commitTransition = (contract: ReachTransitionContract, witness: ReachWitness | null, lifecycle: 'active' | 'terminal'): void => {
    const mapped = reachContractToKernelSpec(contract, config.world)
    if (!mapped.ok) {
      block('contract-mapping-failed', `${contract.transitionId}: ${mapped.reason}`, { transitionId: contract.transitionId })
      return
    }
    let canonical: CanonicalTransitionContract
    try {
      canonical = createTransitionContract(mapped.spec)
    } catch (error) {
      block('contract-mapping-failed', `${contract.transitionId}: ${error instanceof Error ? error.message : String(error)}`, { transitionId: contract.transitionId })
      return
    }
    journal({
      type: 'shadow-contract',
      transitionId: contract.transitionId,
      reachContractHash: contract.contractHash,
      kernelContractHash: canonical.contractHash,
      desiredPredicate: canonical.desiredPredicate,
    })
    apply({
      kind: 'REGISTER_TRANSITION',
      contract: canonical,
      compiler: SHADOW_REGISTRY.compiler,
      capability: caps.compiler,
    }, 'transition-committed')
    if (state.transitions[contract.transitionId] === undefined) return
    if (!state.missionPredicates.includes(canonical.desiredPredicate)) {
      apply({
        kind: 'UPDATE_MISSION',
        predicates: [...state.missionPredicates, canonical.desiredPredicate],
        authority: SHADOW_REGISTRY.missionAuthority,
        capability: caps.mission,
      }, 'transition-committed')
    }
    apply({ kind: 'ADMIT_TRANSITION', transitionId: contract.transitionId, capability: caps.scheduler }, 'transition-committed')
    // RuntimeBinding covers factRevision/registryRevision/missionRevision, so
    // every command above just invalidated the freshness of earlier proofs and
    // witnesses. Re-establish them NOW, in order, before activation: the same
    // verified observation the production commit consumed, then the witness.
    feedSnapshot(lastPredicates, 'transition-committed')
    if (witness !== null) {
      witnessByTransition.set(contract.transitionId, witness)
      const revision = Math.max(1, witnessRevisions.get(contract.transitionId) ?? 0)
      witnessRevisions.set(contract.transitionId, revision)
      apply({
        kind: 'ACCEPT_WITNESS_PROOF',
        transitionId: contract.transitionId,
        witnessRevision: revision,
        witnessRefHash: sha({ witnessId: witness.witnessId, evidenceId: witness.evidenceId }),
        relationId: 'reach-route-witness',
        validator: SHADOW_REGISTRY.witness,
        capability: caps.witness,
      }, 'transition-committed')
    }
    if (lifecycle === 'active') {
      apply({ kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: contract.transitionId, capability: caps.scheduler }, 'transition-committed')
    }
  }

  const terminalTransition = (input: Extract<KernelShadowInput, { type: 'transition-terminal' }>): void => {
    const transition = state.transitions[input.transitionId]
    if (transition === undefined) {
      block('kernel-command-denied', `terminal for unregistered transition ${input.transitionId}`, { transitionId: input.transitionId })
      return
    }
    if (transition.lifecycle === 'TERMINAL') return
    if (input.outcome.kind === 'SUCCESS') {
      const contract = transitionRegistered(input.transitionId)
      if (contract !== null) {
        // Independent VERIFY: feed only the facts the runtime actually
        // observed (the last verified world-observation, which is the
        // observation the production verifier consumed for this outcome).
        // SUCCESS must never mint truth: if an ensures/invariants predicate
        // was not observed 'true', the kernel MUST refuse and the miss is a
        // hard blocker, not a synthesized proof.
        feedSnapshot(lastPredicates, 'transition-terminal')
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
      }, 'transition-terminal')
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
      }), 'transition-terminal')
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
        apply({ kind: 'CHANGE_WORLD', world: observed, capability: caps.worldAdapter }, 'transition-terminal')
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
        }, 'transition-terminal')
        limitation = 'kernel suspends for generation rebind; no GENERATION_CHANGED terminal outcome'
      } else if (kind === 'BUDGET_EXHAUSTED') {
        // Honest typed derivation: the kernel's own budget sweep in
        // ADVANCE_TIME terminalizes when kernel-side accounting crosses the
        // canonical contract budget. If it does not reproduce the breach,
        // that divergence is the projection limitation — the outcome is
        // never fabricated.
        apply((at) => ({ kind: 'ADVANCE_TIME', toMonoMs: at, capability: caps.clock }), 'transition-terminal')
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
          block('shadow-projection-limitation', `${kind}: ${limitation}`, { transitionId: input.transitionId })
        }
        // The kernel cannot express this Reach terminal kind; CANCELED is the
        // mechanical stand-in that closes the shadow lifecycle. The reason
        // preserves the Reach kind and the projection-limitation blocker
        // above marks it as a cutover blocker — never a semantic cancel.
        apply({
          kind: 'REQUEST_CANCEL',
          transitionId: input.transitionId,
          reason: `shadow-terminal:${kind}`,
          capability: caps.scheduler,
        }, 'transition-terminal')
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
  }

  const stepIssued = (input: Extract<KernelShadowInput, { type: 'mechanical-step-issued' }>): void => {
    if (input.effectKind !== 'locomotion') {
      block('unmapped-mutation-surface', `step effect kind ${input.effectKind} is not in the Reach map`, { transitionId: input.transitionId })
      return
    }
    // ISSUE_EFFECT re-checks activationPreconditions against the CURRENT
    // RuntimeBinding: any snapshot/registry/mission revision since activation
    // stales the proofs and witness. Re-establish both before issuing, mirroring
    // the commit-time freshness fence the production controller already passed.
    feedSnapshot(lastPredicates, 'mechanical-step-issued')
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
      }, 'mechanical-step-issued')
    }
    const issued = apply({
      kind: 'ISSUE_EFFECT',
      transitionId: input.transitionId,
      effect: 'MOVE',
      scope: 'reach:leg',
      ttlMs: 30_000,
      capability: controllerCap(input.transitionId),
    }, 'mechanical-step-issued')
    if (!issued.ok) return
    const commitId = (issued.events[0]?.data.commitId as string | undefined) ?? null
    if (commitId === null) {
      block('observer-error', 'ISSUE_EFFECT succeeded without a commitId event')
      return
    }
    const dispatched = apply({
      kind: 'BEGIN_EFFECT_DISPATCH',
      commitId,
      capability: caps.dispatcher,
    }, 'mechanical-step-issued')
    if (dispatched.ok) {
      openEffects.set(input.stepId, { commitId, stepId: input.stepId, transitionId: input.transitionId })
    }
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
      }, 'mechanical-step-settled')
    }
    if (open === null || open === undefined) {
      block('observer-error', `settled step ${input.stepId} had no open kernel effect commit`, { transitionId: input.transitionId })
      return
    }
    if (input.status === 'continuing' || input.status === 'active' || (input.status === 'terminal' && input.verified)) {
      feedSnapshot({
        'reach.mechanical-step': { truth: 'true', evidenceId: `step:${input.stepId}` },
      }, 'mechanical-step-settled', open.commitId)
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
      }, 'mechanical-step-settled')
    } else {
      apply({
        kind: 'RECONCILE_EFFECT',
        commitId: open.commitId,
        observation: 'UNKNOWN',
        factIds: [],
        verifier: SHADOW_REGISTRY.verifier,
        capability: caps.verifier,
      }, 'mechanical-step-settled')
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
      let authorityState: string
      if (mapped === null) {
        authorityState = 'unmapped'
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

  return {
    observe,
    observeMutation,
    bindActuationContext(resolve: () => ShadowMutationContext | null): void {
      resolveContext = resolve
    },
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
        mutationsUnguarded,
        lifecycleCommands,
        kernelDenied,
        verifyFactIds,
        typedTerminals,
        projectionLimitations: projectionLimitationKinds.length,
        projectionLimitationKinds: [...projectionLimitationKinds],
        blockers: [...blockers],
        coverageComplete: mutationsObserved > 0 && hardBlockers.length === 0,
      }
    },
    blockers: () => [...blockers],
    state: () => state,
  }
}
