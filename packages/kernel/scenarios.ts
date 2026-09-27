import type { EffectPermitSpec, ResourceClaimSpec, ResourceId, TransitionContractSpec, WorldIdentity } from './kernel.ts'

// Declarative kernel scenario definitions for the deterministic scenario lab.
// Each definition is pure data: a weaker-model contributor can add a scenario
// by copying a row, without touching reducer or interpreter code. Rows are
// seeded from real historical failures (see `origin`); a scenario that only
// documents characterized-but-accepted semantics says so in `hypothesis`.
//
// The interpreter in kernel.scenarios.test.ts executes every trace against
// the real applyKernelCommand reducer and asserts the declared expectations:
// terminal outcomes, lifecycles, effect-token statuses, and forbidden events.

export type CapabilityRole =
  | 'scheduler' | 'dispatcher' | 'compiler' | 'missionAuthority' | 'progress' | 'verifier' | 'witness' | 'clock' | 'runtime' | 'world'

export interface KernelScenarioStep {
  /** Convenience verbs map to the shared harness ops; 'command' is raw passthrough. */
  readonly do: 'registerAdmit' | 'activate' | 'acceptFacts' | 'advanceTime' | 'issue' | 'begin' | 'reconcile' | 'command'
  /** Index into the scenario's contracts array for verbs that take a contract. */
  readonly ref?: number
  /** For 'issue'/'begin': effect kind/scope/ttl; for 'reconcile': observation and factIds. */
  readonly effect?: { readonly kind: EffectPermitSpec['kind']; readonly scope: string; readonly ttlMs?: number }
  readonly commitId?: string
  readonly observation?: 'OCCURRED' | 'NOT_OCCURRED' | 'UNKNOWN'
  readonly factIds?: readonly string[]
  readonly facts?: readonly { readonly predicateId: string; readonly truth?: 'true' | 'false' | 'unknown'; readonly valueHash?: string; readonly effectCommitId?: string | null }[]
  readonly to?: number
  /** Raw command body (without capability) for 'command'. */
  readonly command?: Record<string, unknown>
  /** Capability role that signs the command; controller commands derive the binding from transitionId. */
  readonly as?: CapabilityRole | `controller:${string}`
  /** Expected failure reason when the step must be rejected. */
  readonly expectFail?: string
  readonly note?: string
}

export interface KernelScenarioExpect {
  /** transitionId -> expected terminalOutcome.kind. */
  readonly terminalOutcomes?: Readonly<Record<string, string>>
  /** transitionId -> expected lifecycle. */
  readonly lifecycles?: Readonly<Record<string, string>>
  /** commitId -> expected effect-token status. */
  readonly effectStatuses?: Readonly<Record<string, string>>
  /** Event kinds that must never appear in the emitted journal. */
  readonly forbiddenEvents?: readonly string[]
  /** Rejection reasons that must never be produced by any step (e.g. a precondition regression). */
  readonly forbiddenRejections?: readonly string[]
}

export interface KernelScenarioDef {
  readonly id: string
  /** Historical failure reference: commit, incident doc, or finding id. */
  readonly origin: string
  /** What the scenario proves; for characterizations, what semantics it pins. */
  readonly hypothesis: string
  readonly world: WorldIdentity
  readonly generationId: string
  readonly missionPredicates: readonly string[]
  readonly contracts: readonly TransitionContractSpec[]
  readonly trace: readonly KernelScenarioStep[]
  readonly expect: KernelScenarioExpect
}

const world: WorldIdentity = { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 7 }
const locomotion: ResourceId = { domain: 'body', path: ['locomotion'], instance: null }
const blocks: ResourceId = { domain: 'world', path: ['blocks'], instance: null }
const inventory: ResourceId = { domain: 'inventory', path: [], instance: null }

const progress = { id: 'progress:generic', version: '1' } as const
const verifier = { id: 'verifier:world', version: '1' } as const
const controllerDefinition = { id: 'controller:generic', version: '1' } as const
const terminalPolicy = { id: 'terminal:generic', version: '1' } as const

function claim(resource: ResourceId = locomotion, extras: Partial<ResourceClaimSpec> = {}): ResourceClaimSpec {
  return { resource, mode: 'EXCLUSIVE_WRITE', preemptible: true, resumable: true, maxNonPreemptibleMs: null, ...extras }
}
function critical(resource: ResourceId): ResourceClaimSpec {
  return claim(resource, { preemptible: false, resumable: true, maxNonPreemptibleMs: 500 })
}
function effect(kind: EffectPermitSpec['kind'], scope: string, required: ResourceId, maxCount = 1): EffectPermitSpec {
  return { kind, scope, irreversible: true, maxCount, requiredResources: [{ resource: required, mode: 'EXCLUSIVE_WRITE' }] }
}
function spec(id: string, claims: readonly ResourceClaimSpec[], effects: readonly EffectPermitSpec[] = [], patch: Partial<TransitionContractSpec> = {}): TransitionContractSpec {
  const desiredPredicate = patch.desiredPredicate ?? `goal:${id}`
  return {
    transitionId: id, family: id.split(':')[0] ?? id, class: patch.class ?? 'MISSION', urgency: patch.urgency ?? 0, world,
    desiredPredicate, requires: patch.requires ?? [], ensures: patch.ensures ?? [desiredPredicate], invariants: patch.invariants ?? [],
    claims, effects,
    budget: patch.budget ?? { maxActiveMs: 1_000, deadlineAtMonoMs: 10_000, maxMechanicalSteps: 100, resources: { items: 10 }, risk: { damage: 10 } },
    progressDefinition: patch.progressDefinition ?? progress, controllerDefinition: patch.controllerDefinition ?? controllerDefinition,
    verificationDefinition: patch.verificationDefinition ?? verifier, terminalPolicy: patch.terminalPolicy ?? terminalPolicy,
    witnessValidation: patch.witnessValidation ?? null,
  }
}

export const KERNEL_SCENARIOS: readonly KernelScenarioDef[] = [
  {
    id: 'sc-k-quiesce-generation',
    origin: 'commit 4747029e — real bug: a generation change during a quiescing transition dropped the pending terminal',
    hypothesis: 'a cancel-pending critical section is terminalized with its requested outcome when the generation changes; it must not be suspended with pending control state',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:mission:critical'],
    contracts: [spec('mission:critical', [critical(blocks)])],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'command', command: { kind: 'REQUEST_CANCEL', transitionId: 'mission:critical', reason: 'supersede' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'CHANGE_GENERATION', generationId: 'gen-b' }, as: 'runtime' },
    ],
    expect: {
      terminalOutcomes: { 'mission:critical': 'CANCELED' },
      forbiddenEvents: [],
    },
  },
  {
    id: 'sc-k-reordered-completion',
    origin: 'stale/reordered completion class — effect completion arriving before dispatch linearization',
    hypothesis: 'a reconcile that precedes BEGIN_EFFECT_DISPATCH is rejected; a commit can never dispatch twice',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:mission:dig'],
    contracts: [spec('mission:dig', [claim(blocks)], [effect('DIG', 'scope:dig', blocks, 1)])],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'issue', ref: 0, effect: { kind: 'DIG', scope: 'scope:dig' }, note: 'commitId commit:1' },
      { do: 'command', command: { kind: 'RECONCILE_EFFECT', commitId: 'commit:1', observation: 'UNKNOWN', factIds: [] }, as: 'verifier', expectFail: 'EFFECT_NOT_RECONCILABLE' },
      { do: 'begin', commitId: 'commit:1' },
      { do: 'begin', commitId: 'commit:1', expectFail: 'EFFECT_COMMIT_NOT_ISSUED' },
    ],
    expect: { effectStatuses: { 'commit:1': 'DISPATCHING' } },
  },
  {
    id: 'sc-k-duplicate-irreversible',
    origin: 'duplicate irreversible effect class — a dispatched commit must be single-use even when the world effect failed',
    hypothesis: 'dispatch linearization is the irreversible act; a NOT_OCCURRED reconcile still consumes the permit and a replacement issue is refused',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:mission:dig'],
    contracts: [spec('mission:dig', [claim(blocks)], [effect('DIG', 'scope:dig', blocks, 1)])],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'issue', ref: 0, effect: { kind: 'DIG', scope: 'scope:dig' } },
      { do: 'begin', commitId: 'commit:1' },
      { do: 'acceptFacts', facts: [{ predicateId: 'observed:dig-result', effectCommitId: 'commit:1' }] },
      { do: 'reconcile', commitId: 'commit:1', observation: 'NOT_OCCURRED', factIds: ['fact:1'] },
      { do: 'issue', ref: 0, effect: { kind: 'DIG', scope: 'scope:dig' }, expectFail: 'EFFECT_MAX_COUNT_EXHAUSTED' },
    ],
    expect: { effectStatuses: { 'commit:1': 'OBSERVED' } },
  },
  {
    id: 'sc-k-orphan-zombie',
    origin: 'orphan transition class — a superseded mission predicate must not leave a resumable authority shell',
    hypothesis: 'a superseded-then-restored predicate cannot resurrect the terminalized transition; frontier re-derivation requires a fresh transition',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:mission:walk', 'goal:mission:other'],
    contracts: [spec('mission:walk', [claim()]), spec('mission:other', [claim(inventory)])],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'registerAdmit', ref: 1 },
      { do: 'command', command: { kind: 'UPDATE_MISSION', predicates: ['goal:mission:other'] }, as: 'missionAuthority' },
      { do: 'command', command: { kind: 'UPDATE_MISSION', predicates: ['goal:mission:walk', 'goal:mission:other'] }, as: 'missionAuthority' },
      { do: 'command', command: { kind: 'ADMIT_TRANSITION', transitionId: 'mission:walk' }, as: 'scheduler', expectFail: 'ILLEGAL_LIFECYCLE_EDGE' },
      { do: 'command', command: { kind: 'RESUME_TRANSITION', transitionId: 'mission:walk' }, as: 'scheduler', expectFail: 'ILLEGAL_LIFECYCLE_EDGE' },
    ],
    expect: {
      terminalOutcomes: { 'mission:walk': 'MISSION_SUPERSEDED' },
      lifecycles: { 'mission:other': 'RUNNABLE' },
    },
  },
  {
    id: 'sc-k-preempt-wedge',
    origin: 'finding F-K3 — cooperative safe-yield bound is observational, not enforced',
    hypothesis: 'CHARACTERIZATION: a preemptible victim that never yields wedges a higher-priority preemptor past the yield deadline; the only kernel recourse is victim terminalization',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:victim:walk', 'goal:requester:urgent'],
    contracts: [spec('victim:walk', [claim()]), spec('requester:urgent', [claim()], [], { urgency: 100 })],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'registerAdmit', ref: 1 },
      { do: 'command', command: { kind: 'START_PREEMPTION', requesterId: 'requester:urgent' }, as: 'scheduler' },
      { do: 'advanceTime', to: 1_000, note: 'past the 50ms preemptible yield budget' },
      { do: 'command', command: { kind: 'COMMIT_PREEMPTION', transactionId: 'preempt:1' }, as: 'scheduler', expectFail: 'PREEMPTION_NOT_READY' },
      { do: 'command', command: { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: 'requester:urgent' }, as: 'scheduler', expectFail: 'RESOURCE_CONFLICT' },
      { do: 'command', command: { kind: 'REQUEST_CANCEL', transitionId: 'victim:walk', reason: 'preemption wedge' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: 'requester:urgent' }, as: 'scheduler' },
    ],
    expect: {
      terminalOutcomes: { 'victim:walk': 'CANCELED' },
      lifecycles: { 'requester:urgent': 'ACTIVE' },
    },
  },
  {
    id: 'sc-k-ready-abort',
    origin: 'finding F-K4 — PAUSE_ACTIVE/ACK_PAUSE_YIELD do not gate on preemptionYielded',
    hypothesis: 'CHARACTERIZATION: an acknowledged victim can be paused out of a READY transaction, releasing leases outside the atomic commit and leaving an unresolvable STALE plan',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:victim:walk', 'goal:requester:urgent'],
    contracts: [spec('victim:walk', [claim()]), spec('requester:urgent', [claim()], [], { urgency: 100 })],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'registerAdmit', ref: 1 },
      { do: 'command', command: { kind: 'START_PREEMPTION', requesterId: 'requester:urgent' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'ACK_PREEMPTION_YIELD', transactionId: 'preempt:1', victimId: 'victim:walk', safeYield: true, atMonoMs: 0 }, as: 'controller:victim:walk' },
      { do: 'command', command: { kind: 'PAUSE_ACTIVE', transitionId: 'victim:walk', to: 'OBSERVING', reason: 'pause' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'COMMIT_PREEMPTION', transactionId: 'preempt:1' }, as: 'scheduler', expectFail: 'STALE_PREEMPTION' },
    ],
    expect: { lifecycles: { 'victim:walk': 'OBSERVING' } },
  },
  {
    id: 'sc-k-world-discards-success',
    origin: 'finding F-K8 — world change vs generation change asymmetry for pending verified outcomes',
    hypothesis: 'CHARACTERIZATION: a world change discards a pending verified SUCCESS and records WORLD_CHANGED, while a generation change would honor it — old-world verify cannot certify the new world',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:mission:critical'],
    contracts: [spec('mission:critical', [critical(blocks)])],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'acceptFacts', facts: [{ predicateId: 'goal:mission:critical' }] },
      { do: 'command', command: { kind: 'VERIFY_SUCCESS', transitionId: 'mission:critical', causalCredit: 'self' }, as: 'verifier' },
      { do: 'command', command: { kind: 'CHANGE_WORLD', world: { serverId: 'local', dimension: 'minecraft:overworld', worldEpoch: 8 } }, as: 'world' },
    ],
    expect: { terminalOutcomes: { 'mission:critical': 'WORLD_CHANGED' } },
  },
  {
    id: 'sc-k-gen-rebind',
    origin: 'generation rebind during an acknowledged preemption — mechanical authority must not survive the rebind',
    hypothesis: 'a generation change mid-READY-preemption stales the plan, suspends both parties, and requires fresh lease identities to reactivate',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:victim:walk', 'goal:requester:urgent'],
    contracts: [spec('victim:walk', [claim()]), spec('requester:urgent', [claim()], [], { urgency: 100 })],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'registerAdmit', ref: 1 },
      { do: 'command', command: { kind: 'START_PREEMPTION', requesterId: 'requester:urgent' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'ACK_PREEMPTION_YIELD', transactionId: 'preempt:1', victimId: 'victim:walk', safeYield: true, atMonoMs: 0 }, as: 'controller:victim:walk' },
      { do: 'command', command: { kind: 'CHANGE_GENERATION', generationId: 'gen-b' }, as: 'runtime' },
      { do: 'command', command: { kind: 'COMMIT_PREEMPTION', transactionId: 'preempt:1' }, as: 'scheduler', expectFail: 'STALE_PREEMPTION' },
      { do: 'command', command: { kind: 'RESUME_TRANSITION', transitionId: 'victim:walk' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'ACQUIRE_DECLARED_RESOURCES', transitionId: 'victim:walk' }, as: 'scheduler' },
    ],
    expect: { lifecycles: { 'victim:walk': 'ACTIVE', 'requester:urgent': 'SUSPENDED' } },
  },
  {
    id: 'sc-k-stale-acks',
    origin: 'stale completion class — yield acknowledgements must be bound to the current monotonic instant',
    hypothesis: 'every quiescing edge rejects an acknowledgement recorded for an older instant',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:mission:critical', 'goal:victim:walk', 'goal:requester:urgent'],
    contracts: [
      spec('mission:critical', [critical(blocks)]),
      spec('victim:walk', [claim()]),
      spec('requester:urgent', [claim()], [], { urgency: 100 }),
    ],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'activate', ref: 1 },
      { do: 'registerAdmit', ref: 2 },
      { do: 'advanceTime', to: 100 },
      { do: 'command', command: { kind: 'ACK_PAUSE_YIELD', transitionId: 'mission:critical', to: 'OBSERVING', reason: 'pause', atMonoMs: 50 }, as: 'controller:mission:critical', expectFail: 'STALE_YIELD_ACK' },
      { do: 'command', command: { kind: 'START_PREEMPTION', requesterId: 'requester:urgent' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'ACK_PREEMPTION_YIELD', transactionId: 'preempt:1', victimId: 'victim:walk', safeYield: true, atMonoMs: 50 }, as: 'controller:victim:walk', expectFail: 'STALE_YIELD_ACK' },
      { do: 'command', command: { kind: 'REQUEST_CANCEL', transitionId: 'mission:critical', reason: 'cancel' }, as: 'scheduler' },
      { do: 'command', command: { kind: 'ACK_CANCEL_YIELD', transitionId: 'mission:critical', atMonoMs: 50 }, as: 'controller:mission:critical', expectFail: 'STALE_YIELD_ACK' },
    ],
    expect: { lifecycles: { 'mission:critical': 'ACTIVE' } },
  },
  {
    id: 'sc-k-crash-replay',
    origin: 'crash/replay class — the journaled protocol must reproduce exactly after a mid-protocol crash',
    hypothesis: 'a journal cut after a dispatch and a preemption plan replays to the identical semantic state and continues the protocol under trusted recovery',
    world, generationId: 'gen-a',
    missionPredicates: ['goal:victim:walk', 'goal:requester:urgent'],
    contracts: [spec('victim:walk', [claim()], [effect('MOVE', 'scope:v', locomotion)]), spec('requester:urgent', [claim()], [], { urgency: 100 })],
    trace: [
      { do: 'activate', ref: 0 },
      { do: 'registerAdmit', ref: 1 },
      { do: 'issue', ref: 0, effect: { kind: 'MOVE', scope: 'scope:v' } },
      { do: 'begin', commitId: 'commit:1' },
      { do: 'command', command: { kind: 'START_PREEMPTION', requesterId: 'requester:urgent' }, as: 'scheduler' },
      { do: 'reconcile', commitId: 'commit:1', observation: 'UNKNOWN', factIds: [] },
      { do: 'command', command: { kind: 'ACK_PREEMPTION_YIELD', transactionId: 'preempt:1', victimId: 'victim:walk', safeYield: true, atMonoMs: 0 }, as: 'controller:victim:walk' },
    ],
    expect: {
      effectStatuses: { 'commit:1': 'UNKNOWN' },
      lifecycles: { 'victim:walk': 'ACTIVE' },
    },
  },
]
