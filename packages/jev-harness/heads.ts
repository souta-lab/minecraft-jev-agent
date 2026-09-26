// jev-harness/heads.ts - the canonical, versioned Jev head registry (#438 section 4).
//
// ONE registry of semantic questions. No anonymous ad-hoc Jev call may exist, and
// every production call must reference a registered head (I2). Live source refs
// track the four remaining direct-provider call sites; retired heads with no
// current caller stay registered for historical artifact decoding.
//
//   packages/jev-agent/src/jev/authority.ts:335   batched: action / abandon_option / danger / should_retreat
//   packages/jev-agent/src/jev/client.ts:997      batched legacy: action / abandon_option / danger / should_retreat
//   packages/buddy-driver/advisor.ts:367          choice: next_strategy over a declared strategy set
//   packages/buddy-driver/planner-legacy.ts:3432  batched: horizon / plan_fit / strategy_change
//   (the former planner.ts choice was retired when System2 became the WHAT authority)
//
// A head is versioned as a whole: bumping the version means a NEW head id, and
// the old entry stays in the registry with `deprecated: true` so replay of older
// artifacts keeps a name to resolve.

import type {
  HeadId,
  HeadStatus,
  HeadVersion,
  JevAuthorityOwner,
  JevPrimitive,
  ProjectionId,
} from './contract.ts'
import {
  ADVISOR_STATE_PROJECTION,
  AUTHORITY_STATE_PROJECTION,
  LEGACY_EVAL_STATE_PROJECTION,
  SYSTEM2_COMPACT_STATE_PROJECTION,
  SYSTEM2_PLANNER_STATE_PROJECTION,
  lookupProjectionSchema,
} from './semanticProjection.ts'

export interface ScoreScaleSpec {
  readonly id: string
  readonly version: number
  readonly min: number
  readonly max: number
  readonly levels: readonly string[]
}

export interface HeadInstructions {
  /**
   * `harness_canonical` text is written for the harness boundary. Porting the
   * exact legacy prompt text is a *semantic* change that Phase C/D/E must
   * validate with replay evidence (#423); this field makes the current state
   * explicit instead of silently changing behaviour.
   */
  readonly status: 'harness_canonical' | 'legacy_ported'
  readonly text: string
}

export interface HeadSourceRef {
  /** Repo-relative path of the production file that asks this question today. */
  readonly file: string
  /** Symbol that owns the question; the symbol (not the line) is the drift anchor. */
  readonly symbol: string
  /** Line hint from the Phase A inventory. Never used as an assertion anchor. */
  readonly lineHint: number
}

export interface CalibrationRef {
  readonly transformId: string
  readonly transformVersion: number
}

export interface JevHead {
  /** Stable, versioned head id, e.g. `pi_action_v3`. */
  readonly id: HeadId
  readonly version: HeadVersion
  readonly primitive: JevPrimitive
  readonly owner: JevAuthorityOwner
  readonly status: HeadStatus
  readonly deprecated: boolean
  /** The exact semantic question, in repo terms. */
  readonly semanticQuestion: string
  readonly instructions: HeadInstructions
  /** Versioned state projection this head is allowed to consume (#438 section 5). */
  readonly stateProjection: ProjectionId
  /** Repo-level result schema name recorded on every artifact. */
  readonly resultSchema: string
  /**
   * `grounded`: the caller supplies the closed candidate set (#438 section 3).
   * `declared`: the head's closed set is fixed in the registry (e.g. the
   * advisor's strategy enum), so it is still closed-world.
   */
  readonly candidateSource: 'grounded' | 'declared' | 'none'
  readonly declaredCandidates?: readonly { readonly id: string; readonly criteria: string }[]
  readonly scale?: ScoreScaleSpec
  readonly calibration: CalibrationRef
  /** Present for choice heads: whether the provider may express "no decision". */
  readonly abstention: 'none' | 'provider'
  /**
   * Heads that share a batch group may be coalesced into ONE provider request
   * (the Phase A batching constraint). The primitive is still per-head.
   */
  readonly batchGroup: string | null
  /** Current modules allowed to consume this head's result; empty only for a retired archive. */
  readonly allowedConsumers: readonly string[]
  /** Current ask sites for the Phase C/D/E migration map; empty only when a retired head has no caller. */
  readonly sourceRefs: readonly HeadSourceRef[]
  /**
   * Where the exact prompt wording lives today, when the harness text is not yet
   * the production text. Phase C/D/E ports the wording into `instructions`.
   */
  readonly legacyPromptRef?: HeadSourceRef
  readonly notes: string
}

/** DANGER_LEVELS from packages/jev-agent/src/jev/client.ts (ordered danger levels). */
export const DANGER_SCALE: ScoreScaleSpec = {
  id: 'danger_levels',
  version: 1,
  min: 0,
  max: 3,
  levels: ['safe', 'minor risk', 'dangerous', 'lethal'],
}

/** PLAN_FIT_LEVELS from packages/buddy-driver/planner-legacy.ts. */
export const PLAN_FIT_SCALE: ScoreScaleSpec = {
  id: 'plan_fit_levels',
  version: 1,
  min: 0,
  max: 4,
  levels: ['poor fit', 'weak fit', 'reasonable fit', 'good fit', 'excellent fit'],
}

/** ADVISOR_STRATEGIES from packages/buddy-driver/advisor.ts. */
export const ADVISOR_STRATEGY_IDS: readonly string[] = [
  'descend_to_y16',
  'explore_cave',
  'branch_mine',
  'return_to_known_ore',
  'smelt_and_craft',
]

const AUTHORITY_STATE = AUTHORITY_STATE_PROJECTION
const LEGACY_EVAL_STATE = LEGACY_EVAL_STATE_PROJECTION
const ADVISOR_STATE = ADVISOR_STATE_PROJECTION
const SYSTEM2_LEGACY_STATE = SYSTEM2_PLANNER_STATE_PROJECTION
const SYSTEM2_BRAIN_STATE = SYSTEM2_COMPACT_STATE_PROJECTION

function legacyEvalRef(symbol: string, lineHint: number): HeadSourceRef {
  return { file: 'packages/jev-agent/src/jev/client.ts', symbol, lineHint }
}

export const JEV_HEADS: readonly JevHead[] = [
  // -------------------------------------------------------------------------
  // jev/authority.ts - the model-authoritative kernel (batched in one request)
  // -------------------------------------------------------------------------
  {
    id: 'pi_action_v3',
    version: 3,
    primitive: 'choice',
    owner: 'jev_pi',
    status: 'production',
    deprecated: false,
    semanticQuestion:
      'Given the grounded candidate set and the projected semantic state, which ONE candidate best advances the current Option?',
    instructions: {
      status: 'harness_canonical',
      text:
        'You are Jev pi, the local policy head of an autonomous Minecraft agent. Choose exactly ONE id from the ' +
        'grounded action list: the action that best advances the CURRENT Option in the CURRENT world state. Every id ' +
        'is executable candidate data supplied by deterministic code; answer with the id verbatim and never invent an ' +
        'id. Candidate cost, distance, failure history and reachability facts are evidence, not universal ranking ' +
        'rules: reason over the whole state and the alternatives. Deterministic code may ground and safety-check the ' +
        'candidate, but it must not choose for you or replace your valid choice with a different semantic action.',
    },
    stateProjection: AUTHORITY_STATE,
    resultSchema: 'pi_result_v1',
    candidateSource: 'grounded',
    calibration: { transformId: 'choice_distribution_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_authority',
    allowedConsumers: ['jev-agent/src/controller.ts', 'packages/jev-agent/src/jev/authority.ts'],
    sourceRefs: [
      { file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'buildAuthorityQuestions', lineHint: 335 },
      { file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'authorityState', lineHint: 230 },
    ],
    legacyPromptRef: { file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'AUTHORITY_PRIMARY_INSTRUCTIONS', lineHint: 27 },
    notes:
      'Model-authoritative pi. Cards: closed grounded candidate set, strict id membership (#438 section 3). Today the ' +
      'prompt is a long free-form constant; porting it verbatim is Phase C work and must be replay-validated.',
  },
  {
    id: 'beta_terminate_v2',
    version: 2,
    primitive: 'boolean',
    owner: 'jev_beta',
    status: 'production',
    deprecated: false,
    semanticQuestion: 'Should the CURRENT Option terminate (be abandoned) now, given its contract and the recent outcomes?',
    instructions: {
      status: 'harness_canonical',
      text:
        'You are Jev beta. Decide whether the CURRENT Option should end now. Use its explicit preconditions/success ' +
        'facts, typed recent outcomes and current grounded alternatives. True means end this Option; false means keep ' +
        'it. Control-plane outcomes (WAIT/ESCALATE) are not productive goal progress, and a single local failure is ' +
        'recovery evidence, not semantic exhaustion. Answer with P(true).',
    },
    stateProjection: AUTHORITY_STATE,
    resultSchema: 'beta_result_v1',
    candidateSource: 'none',
    calibration: { transformId: 'beta_threshold_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_authority',
    allowedConsumers: ['jev-agent/src/controller.ts', 'packages/jev-agent/src/jev/authority.ts'],
    sourceRefs: [{ file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'buildAuthorityQuestions', lineHint: 335 }],
    legacyPromptRef: { file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'BETA_INSTRUCTIONS', lineHint: 42 },
    notes: 'Raw P(abandon=true) is preserved; only the versioned calibration layer may threshold it (#438 section 11).',
  },
  {
    id: 'danger_v1',
    version: 1,
    primitive: 'score',
    owner: 'risk',
    status: 'shadow',
    deprecated: false,
    semanticQuestion: 'How dangerous is the current observed situation for the body, on the ordered danger scale?',
    instructions: {
      status: 'harness_canonical',
      text:
        'Rate immediate physical danger in the current observed state from safe to lethal. This is a safety estimate, ' +
        'not a plan choice.',
    },
    stateProjection: AUTHORITY_STATE,
    resultSchema: 'score_result_v1',
    candidateSource: 'none',
    scale: DANGER_SCALE,
    calibration: { transformId: 'score_level_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_authority',
    allowedConsumers: ['jev-agent/src/controller.ts', 'jev-agent/src/threat.ts'],
    sourceRefs: [{ file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'buildAuthorityQuestions', lineHint: 110 }],
    legacyPromptRef: { file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'DANGER_INSTRUCTIONS', lineHint: 60 },
    notes: 'Shadow/safety estimate: consumed by deterministic safety gates, never as a plan choice (#11).',
  },
  {
    id: 'retreat_v1',
    version: 1,
    primitive: 'boolean',
    owner: 'risk',
    status: 'shadow',
    deprecated: false,
    semanticQuestion: 'Should the body retreat immediately for safety, given observed threats and health?',
    instructions: {
      status: 'harness_canonical',
      text:
        'Should the bot retreat immediately for safety based on the current observed threats, health, and grounded ' +
        'escape actions? Answer with P(true).',
    },
    stateProjection: AUTHORITY_STATE,
    resultSchema: 'beta_result_v1',
    candidateSource: 'none',
    calibration: { transformId: 'boolean_threshold_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_authority',
    allowedConsumers: ['jev-agent/src/controller.ts', 'jev-agent/src/threat.ts'],
    sourceRefs: [{ file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'buildAuthorityQuestions', lineHint: 113 }],
    legacyPromptRef: { file: 'packages/jev-agent/src/jev/authority.ts', symbol: 'RETREAT_INSTRUCTIONS', lineHint: 57 },
    notes: 'Shadow safety estimate. A provider failure must never look like a calibrated continue (#438 section 9).',
  },

  // -------------------------------------------------------------------------
  // jev-legacy.ts - the older one-interface-two-implementations path
  // -------------------------------------------------------------------------
  {
    id: 'pi_action_legacy_v1',
    version: 1,
    primitive: 'choice',
    owner: 'jev_pi',
    status: 'production',
    deprecated: true,
    semanticQuestion:
      'Which grounded macro-action id should execute now? (legacy TypeSafeJevPolicy projection and prompt)',
    instructions: {
      status: 'harness_canonical',
      text:
        'Choose exactly ONE id from the grounded action list that best advances the current goal. Answer with the id ' +
        'verbatim and never invent an id.',
    },
    stateProjection: LEGACY_EVAL_STATE,
    resultSchema: 'pi_result_v1',
    candidateSource: 'grounded',
    calibration: { transformId: 'choice_distribution_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_legacy',
    allowedConsumers: ['jev-agent/src/controller.ts', 'packages/jev-agent/src/jev/client.ts'],
    sourceRefs: [{ file: 'packages/jev-agent/src/jev/client.ts', symbol: 'buildQuestions', lineHint: 997 }],
    legacyPromptRef: legacyEvalRef('PRIMARY_INSTRUCTIONS', 356),
    notes:
      'Deprecated: the authority path (pi_action_v3) is the current production head. Kept registered so legacy ' +
      'artifacts still resolve and so #438 Phase E can delete it deliberately rather than silently.',
  },
  {
    id: 'beta_terminate_legacy_v1',
    version: 1,
    primitive: 'boolean',
    owner: 'jev_beta',
    status: 'production',
    deprecated: true,
    semanticQuestion: 'Should the current Option (subgoal/plan) be abandoned and replanned now? (legacy projection)',
    instructions: {
      status: 'harness_canonical',
      text:
        'Should the current Option (the current subgoal/plan) be abandoned and replanned now, given the live ' +
        'inventory, tool rank and repeated failures? Answer with P(true).',
    },
    stateProjection: LEGACY_EVAL_STATE,
    resultSchema: 'beta_result_v1',
    candidateSource: 'none',
    calibration: { transformId: 'beta_threshold_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_legacy',
    allowedConsumers: ['jev-agent/src/controller.ts', 'packages/jev-agent/src/jev/client.ts'],
    sourceRefs: [{ file: 'packages/jev-agent/src/jev/client.ts', symbol: 'buildQuestions', lineHint: 997 }],
    legacyPromptRef: legacyEvalRef('buildQuestions', 368),
    notes: 'Deprecated legacy beta head.',
  },
  {
    id: 'danger_legacy_v1',
    version: 1,
    primitive: 'score',
    owner: 'risk',
    status: 'diagnostic',
    deprecated: true,
    semanticQuestion: 'How dangerous is the current situation? (legacy projection, ordered danger levels)',
    instructions: {
      status: 'harness_canonical',
      text:
        'How dangerous is the current situation for the bot right now? Use the ordered levels from safe to lethal. ' +
        'Judge only immediate physical danger.',
    },
    stateProjection: LEGACY_EVAL_STATE,
    resultSchema: 'score_result_v1',
    candidateSource: 'none',
    scale: DANGER_SCALE,
    calibration: { transformId: 'score_level_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_legacy',
    allowedConsumers: ['packages/jev-agent/src/jev/client.ts'],
    sourceRefs: [{ file: 'packages/jev-agent/src/jev/client.ts', symbol: 'buildQuestions', lineHint: 382 }],
    legacyPromptRef: legacyEvalRef('buildQuestions', 382),
    notes: 'Diagnostic-only legacy safety score.',
  },
  {
    id: 'retreat_legacy_v1',
    version: 1,
    primitive: 'boolean',
    owner: 'risk',
    status: 'diagnostic',
    deprecated: true,
    semanticQuestion: 'Should the bot break off and move away to safety right now? (legacy projection)',
    instructions: {
      status: 'harness_canonical',
      text:
        'Should the bot break off what it is doing and move away to safety right now? Answer true only for immediate ' +
        'physical danger.',
    },
    stateProjection: LEGACY_EVAL_STATE,
    resultSchema: 'beta_result_v1',
    candidateSource: 'none',
    calibration: { transformId: 'boolean_threshold_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'jev_legacy',
    allowedConsumers: ['packages/jev-agent/src/jev/client.ts'],
    sourceRefs: [{ file: 'packages/jev-agent/src/jev/client.ts', symbol: 'buildQuestions', lineHint: 390 }],
    legacyPromptRef: legacyEvalRef('buildQuestions', 390),
    notes: 'Diagnostic-only legacy retreat vote.',
  },

  // -------------------------------------------------------------------------
  // advisor.ts - strategy choice over a DECLARED, closed strategy set
  // -------------------------------------------------------------------------
  {
    id: 'advisor_strategy_v1',
    version: 1,
    primitive: 'choice',
    owner: 'advisor',
    status: 'production',
    deprecated: false,
    semanticQuestion: 'Which ONE declared strategy best removes the current blocker?',
    instructions: {
      status: 'harness_canonical',
      text:
        'You are the strategy advisor for a Minecraft survival bot that is stalled. Choose exactly ONE next strategy ' +
        'from the criteria. You choose a STRATEGY ONLY - never an action. Prefer the strategy that directly removes ' +
        'the current blocker given the live inventory and tool rank.',
    },
    stateProjection: ADVISOR_STATE,
    resultSchema: 'pi_result_v1',
    candidateSource: 'declared',
    declaredCandidates: [
      { id: 'descend_to_y16', criteria: 'dig a staircase straight down toward y=16 where stone and ores are exposed' },
      { id: 'explore_cave', criteria: 'walk to unexplored terrain / cave openings to find exposed ores' },
      { id: 'branch_mine', criteria: 'dig a horizontal branch tunnel at the current depth to find buried ores' },
      { id: 'return_to_known_ore', criteria: 'navigate back to an ore location already discovered and mine it' },
      { id: 'smelt_and_craft', criteria: 'smelt held raw materials and craft the next tool from the ladder' },
    ],
    calibration: { transformId: 'choice_distribution_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: null,
    allowedConsumers: ['packages/buddy-driver/advisor.ts', 'buddy-driver/planner.ts'],
    sourceRefs: [{ file: 'packages/buddy-driver/advisor.ts', symbol: 'ADVISOR_STRATEGIES', lineHint: 367 }],
    legacyPromptRef: { file: 'packages/buddy-driver/advisor.ts', symbol: 'STRATEGY_CRITERIA', lineHint: 43 },
    notes:
      'The closed set is the declared strategy enum, so the same closed-world rule applies without grounded candidates ' +
      '(#438 section 3).',
  },

  // -------------------------------------------------------------------------
  // planner-legacy.ts - the legacy System2 batched call
  // -------------------------------------------------------------------------
  {
    id: 'system2_horizon_v1',
    version: 1,
    primitive: 'choice',
    owner: 'system2',
    status: 'production',
    deprecated: true,
    semanticQuestion: 'Which ONE grounded plan option should become the next horizon? (legacy planner)',
    instructions: {
      status: 'harness_canonical',
      text:
        'Choose exactly ONE option id from the grounded plan options that best realises the current objective. Answer ' +
        'with the id verbatim and never invent an id.',
    },
    stateProjection: SYSTEM2_LEGACY_STATE,
    resultSchema: 'pi_result_v1',
    candidateSource: 'grounded',
    calibration: { transformId: 'choice_distribution_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'system2_legacy',
    allowedConsumers: ['packages/buddy-driver/planner-legacy.ts'],
    sourceRefs: [{ file: 'packages/buddy-driver/planner-legacy.ts', symbol: 'askLlm', lineHint: 3432 }],
    legacyPromptRef: { file: 'packages/buddy-driver/planner-legacy.ts', symbol: 'HORIZON_INSTRUCTIONS', lineHint: 3411 },
    notes:
      'Legacy System2 WHAT head. Its current call site has a hidden fallback (`match ?? options[0] ?? FRONT_FALLBACK`); ' +
      'the harness refuses that shape (#438 section 9) - Phase C/D must move the fallback decision to an explicit, ' +
      'labelled code-authority path.',
  },
  {
    id: 'system2_plan_fit_v1',
    version: 1,
    primitive: 'score',
    owner: 'system2',
    status: 'shadow',
    deprecated: true,
    semanticQuestion: 'How well does the proposed plan fit the current state? (legacy planner scale)',
    instructions: {
      status: 'harness_canonical',
      text: 'Rate how well the proposed plan fits the current state on the ordered fit scale.',
    },
    stateProjection: SYSTEM2_LEGACY_STATE,
    resultSchema: 'score_result_v1',
    candidateSource: 'none',
    scale: PLAN_FIT_SCALE,
    calibration: { transformId: 'score_level_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'system2_legacy',
    allowedConsumers: ['packages/buddy-driver/planner-legacy.ts'],
    sourceRefs: [{ file: 'packages/buddy-driver/planner-legacy.ts', symbol: 'askLlm', lineHint: 3432 }],
    legacyPromptRef: { file: 'packages/buddy-driver/planner-legacy.ts', symbol: 'PLAN_FIT_LEVELS', lineHint: 2450 },
    notes: 'Shadow metric; the plan choice itself is the horizon head.',
  },
  {
    id: 'system2_strategy_change_v1',
    version: 1,
    primitive: 'boolean',
    owner: 'system2',
    status: 'shadow',
    deprecated: true,
    semanticQuestion: 'Should the current plan change now?',
    instructions: {
      status: 'harness_canonical',
      text: 'Should the current plan change now? Answer with P(true).',
    },
    stateProjection: SYSTEM2_LEGACY_STATE,
    resultSchema: 'beta_result_v1',
    candidateSource: 'none',
    calibration: { transformId: 'strategy_change_threshold_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: 'system2_legacy',
    allowedConsumers: ['packages/buddy-driver/planner-legacy.ts'],
    sourceRefs: [{ file: 'packages/buddy-driver/planner-legacy.ts', symbol: 'askLlm', lineHint: 3435 }],
    legacyPromptRef: { file: 'packages/buddy-driver/planner-legacy.ts', symbol: 'resolveStrategyChangeThreshold', lineHint: 2497 },
    notes: 'Threshold centralisation target: `resolveStrategyChangeThreshold()` becomes a registry calibration parameter.',
  },

  // -------------------------------------------------------------------------
  // planner.ts - PlannerBrain (System2 authority)
  // -------------------------------------------------------------------------
  {
    id: 'system2_horizon_v2',
    version: 2,
    primitive: 'choice',
    owner: 'system2',
    status: 'production',
    deprecated: true,
    semanticQuestion:
      'Which ONE grounded plan option best realises the current objective (or the semantic intent when one is live)?',
    instructions: {
      status: 'harness_canonical',
      text:
        'Choose exactly ONE option id from the grounded plan options that best realises the objective. Answer with ' +
        'the id verbatim and never invent an id.',
    },
    stateProjection: SYSTEM2_BRAIN_STATE,
    resultSchema: 'pi_result_v1',
    candidateSource: 'grounded',
    calibration: { transformId: 'choice_distribution_v1', transformVersion: 1 },
    abstention: 'none',
    batchGroup: null,
    allowedConsumers: [],
    sourceRefs: [],
    notes:
      'Historical Jev choice head retained for old artifact decoding. System2 now owns WHAT via natural-language repair and ' +
      'code-owned grounding; that path is specified by system2-harness, not this Jev head.',
  },
]

// ---------------------------------------------------------------------------
// registry access + validation
// ---------------------------------------------------------------------------

export const HEAD_REGISTRY_VERSION = 1

export class UnknownHeadError extends Error {
  constructor(readonly headId: HeadId) {
    super(`unregistered Jev head ${JSON.stringify(headId)}: every production Jev question must be registered (#438 section 4)`)
    this.name = 'UnknownHeadError'
  }
}

export class HeadRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeadRegistryError'
  }
}

const HEAD_INDEX: ReadonlyMap<HeadId, JevHead> = new Map(JEV_HEADS.map((head) => [head.id, head]))

export function lookupHead(headId: HeadId): JevHead | null {
  return HEAD_INDEX.get(headId) ?? null
}

export function requireHead(headId: HeadId): JevHead {
  const head = lookupHead(headId)
  if (head === null) throw new UnknownHeadError(headId)
  return head
}

export function registeredHeadIds(): readonly HeadId[] {
  return JEV_HEADS.map((head) => head.id)
}

export function activeHeads(): readonly JevHead[] {
  return JEV_HEADS.filter((head) => !head.deprecated)
}

export function headsInBatchGroup(group: string): readonly JevHead[] {
  return JEV_HEADS.filter((head) => head.batchGroup === group)
}

/**
 * Structural self-check. Called by the harness at construction time (fail loud,
 * not fail silently) and asserted by CI.
 */
export function validateHeadRegistry(heads: readonly JevHead[] = JEV_HEADS): void {
  const seen = new Set<HeadId>()
  for (const head of heads) {
    if (seen.has(head.id)) throw new HeadRegistryError(`duplicate head id ${head.id}`)
    seen.add(head.id)
    if (head.version < 1 || !Number.isInteger(head.version)) {
      throw new HeadRegistryError(`head ${head.id}: version must be a positive integer`)
    }
    if (head.semanticQuestion.trim().length === 0) {
      throw new HeadRegistryError(`head ${head.id}: semanticQuestion is required (#438 section 4)`)
    }
    if (head.instructions.text.trim().length === 0) {
      throw new HeadRegistryError(`head ${head.id}: instructions text is required`)
    }
    if (head.allowedConsumers.length === 0 && !head.deprecated) {
      throw new HeadRegistryError(`head ${head.id}: allowedConsumers is required (#438 section 4)`)
    }
    if (head.sourceRefs.length === 0 && !head.deprecated) {
      throw new HeadRegistryError(`head ${head.id}: sourceRefs is required (migration map)`)
    }
    if (head.primitive === 'choice' && head.candidateSource === 'none') {
      throw new HeadRegistryError(`head ${head.id}: a choice head must declare a candidate source`)
    }
    if (head.primitive === 'choice' && head.candidateSource === 'declared') {
      if (head.declaredCandidates === undefined || head.declaredCandidates.length === 0) {
        throw new HeadRegistryError(`head ${head.id}: declared candidate source requires declaredCandidates`)
      }
    }
    if (head.primitive === 'score' && head.scale === undefined) {
      throw new HeadRegistryError(`head ${head.id}: a score head must declare its ordered scale`)
    }
    if (head.primitive === 'score' && head.scale !== undefined) {
      if (head.scale.levels.length === 0) throw new HeadRegistryError(`head ${head.id}: score scale has no levels`)
      if (head.scale.max !== head.scale.levels.length - 1) {
        throw new HeadRegistryError(
          `head ${head.id}: score scale max (${head.scale.max}) must be levels.length - 1 (${head.scale.levels.length - 1})`,
        )
      }
      if (head.scale.min !== 0) throw new HeadRegistryError(`head ${head.id}: score scale min must be 0`)
    }
    if (head.candidateSource === 'declared' && head.declaredCandidates !== undefined) {
      const ids = new Set(head.declaredCandidates.map((entry) => entry.id))
      if (ids.size !== head.declaredCandidates.length) {
        throw new HeadRegistryError(`head ${head.id}: duplicate declared candidate id`)
      }
    }
    // Every head must consume a DECLARED projection contract (#438 section 5):
    // a registry that names an unregistered projection id would make the
    // model-visible state contract unfalsifiable.
    const schema = lookupProjectionSchema(head.stateProjection)
    if (schema === null) {
      throw new HeadRegistryError(
        `head ${head.id}: stateProjection ${JSON.stringify(head.stateProjection)} is not a declared projection contract`,
      )
    }
  }
}

/** Provider-facing question id for a head (the head id is the question id). */
export function providerQuestionId(head: JevHead): string {
  return head.id
}
