// jev-harness/semanticProjection.ts - the versioned semantic projection contract
// (#438 section 5, #437 state hygiene).
//
// Every head declares ONE `stateProjection` id and the harness refuses a request
// whose projection belongs to a different contract. This module is the concrete
// contract behind those ids:
//
//   * a schema DECLARES the semantic fields a projection may carry. Anything
//     else - raw position/velocity/health churn, tick counters, live object
//     references, hand-authored preference fields - is a loud code bug
//     (`UndeclaredProjectionFieldError`), not something silently dropped;
//   * a declared field that the caller did not supply becomes an explicit
//     `unknown` epistemic entry, so absence can never masquerade as
//     `false`/`0`/`[]` (section 6 / I12);
//   * the payload is canonicalized (sorted keys, `undefined` members dropped)
//     before hashing, so the same semantic state yields the same
//     `projectionHash` regardless of member insertion order (#25.12);
//   * `version` is owned by the schema, not by the caller: a projection id can
//     only be built at its declared version, so a semantics change is a NEW
//     projection id/version rather than an in-place mutation of an old one.

import type { Epistemic, ProjectionId, SemanticProjection } from './contract.ts'
import { UNKNOWN } from './contract.ts'
import { assertPlainData, deepFreeze, epistemicEntry } from './canonical.ts'
import {
  LANDED_437_PROJECTION_ID,
  LANDED_437_PROJECTION_MODEL_FIELDS,
  LANDED_437_PROJECTION_VERSION,
} from './links437.ts'

// Projection ids referenced by the head registry (#438 section 4). Exported so
// the registry and this schema list cannot drift apart.
export const AUTHORITY_STATE_PROJECTION: ProjectionId = 'authority_state_v1'
export const LEGACY_EVAL_STATE_PROJECTION: ProjectionId = 'jev_eval_state_v1'
export const ADVISOR_STATE_PROJECTION: ProjectionId = 'advisor_state_v1'
export const SYSTEM2_PLANNER_STATE_PROJECTION: ProjectionId = 'system2_planner_state_v1'
export const SYSTEM2_COMPACT_STATE_PROJECTION: ProjectionId = 'system2_compact_state_v2'

export interface ProjectionSchema {
  readonly projectionId: ProjectionId
  readonly version: number
  /** Authority owner of the concrete payload (#437 owns the state hygiene). */
  readonly owner: string
  readonly description: string
  /**
   * The ONLY top-level semantic fields this projection may carry, in canonical
   * serialization order. Declared fields are always present on a built payload
   * (missing -> explicit `unknown`).
   */
  readonly fields: readonly string[]
}

/** The §5 `PolicyStateV5` sketch, which is what jev-authority.ts/jev-legacy.ts ask about today. */
const POLICY_STATE_FIELDS: readonly string[] = [
  'option',
  'target',
  'previousDecision',
  'previousOutcome',
  'meaningfulProgress',
  'relevantInventory',
  'safety',
  'worldFacts',
  'failureMemory',
]

export const PROJECTION_SCHEMAS: readonly ProjectionSchema[] = [
  {
    projectionId: AUTHORITY_STATE_PROJECTION,
    version: 1,
    owner: 'jev-agent/src/jev-authority.ts',
    description: 'Model-authoritative pi/beta/danger/retreat state (authorityState()).',
    fields: POLICY_STATE_FIELDS,
  },
  {
    projectionId: LEGACY_EVAL_STATE_PROJECTION,
    version: 1,
    owner: 'jev-agent/src/jev-legacy.ts',
    description: 'Legacy TypeSafeJevPolicy evaluation state (buildQuestions()).',
    fields: POLICY_STATE_FIELDS,
  },
  {
    projectionId: ADVISOR_STATE_PROJECTION,
    version: 1,
    owner: 'buddy-driver/advisor.ts',
    description: 'Advisor mining-strategy state; the strategy set is declared, so no candidate list is projected.',
    fields: ['objective', 'meaningfulProgress', 'relevantInventory', 'knownResources', 'worldFacts', 'failureMemory'],
  },
  {
    projectionId: SYSTEM2_PLANNER_STATE_PROJECTION,
    version: 1,
    owner: 'buddy-driver/planner-legacy.ts',
    description: 'Legacy System2 horizon/plan-fit/strategy-change state (askLlm()).',
    fields: ['objective', 'missionFacts', 'capabilities', 'inventoryFacts', 'locationFacts', 'recentFailures'],
  },
  {
    projectionId: SYSTEM2_COMPACT_STATE_PROJECTION,
    version: 2,
    owner: 'buddy-driver/planner.ts',
    description: 'PlannerBrain compact System2 state (compactSystem2State()).',
    fields: ['objective', 'missionFacts', 'frontier', 'capabilities', 'inventoryFacts', 'recentFailures'],
  },
  {
    // The #437 projection that is now on main. It is registered here so the
    // harness can carry it VERBATIM (`projectionModelView(buildJevSemanticProjection(...))`)
    // with a declared, closed field set, instead of a second parallel contract.
    // The field list is drift-tested against jev-agent/src/jevSemanticProjection.ts.
    projectionId: LANDED_437_PROJECTION_ID,
    version: LANDED_437_PROJECTION_VERSION,
    owner: 'jev-agent/src/jevSemanticProjection.ts',
    description:
      '#437 jev-semantic-projection/v2 model view: banded/compacted semantic facts only, `counts` excluded as evidence.',
    fields: LANDED_437_PROJECTION_MODEL_FIELDS,
  },
]

const SCHEMA_INDEX: ReadonlyMap<string, ProjectionSchema> = new Map(
  PROJECTION_SCHEMAS.map((schema) => [schema.projectionId, schema]),
)

export class ProjectionSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectionSchemaError'
  }
}

/**
 * A caller tried to put a field the projection contract does not declare into the
 * model-visible state. This is the executable form of "irrelevant body jitter and
 * hidden preference fields never reach Jev" (#438 sections 5/20, #25.13).
 */
export class UndeclaredProjectionFieldError extends ProjectionSchemaError {
  constructor(
    readonly projectionId: ProjectionId,
    readonly field: string,
    readonly declared: readonly string[],
  ) {
    super(
      `projection ${projectionId} does not declare field ${JSON.stringify(field)}: model-visible state is a closed ` +
        `semantic contract (declared: ${declared.join(', ')})`,
    )
    this.name = 'UndeclaredProjectionFieldError'
  }
}

export function lookupProjectionSchema(projectionId: ProjectionId): ProjectionSchema | null {
  return SCHEMA_INDEX.get(projectionId) ?? null
}

export function requireProjectionSchema(projectionId: ProjectionId): ProjectionSchema {
  const schema = lookupProjectionSchema(projectionId)
  if (schema === null) {
    throw new ProjectionSchemaError(
      `unregistered semantic projection ${JSON.stringify(projectionId)}: every model-visible projection must be a ` +
        'declared, versioned contract (#438 section 5)',
    )
  }
  return schema
}

export function declaredProjectionFields(projectionId: ProjectionId): readonly string[] {
  return requireProjectionSchema(projectionId).fields
}

export interface ProjectionInput {
  readonly projectionId: ProjectionId
  /**
   * Semantic field values. A field may be a plain value or an `Epistemic` fact;
   * an `undefined` member is treated as absent (canonical `undefined` dropping),
   * and an absent declared field becomes an explicit `unknown` fact.
   */
  readonly fields: Readonly<Record<string, unknown>>
  /** Overrides the schema owner in the error/record trail (tests/tools only). */
  readonly provenance?: string
}

/**
 * Build a schema-validated, deep-frozen, canonically-keyed projection. The ONLY
 * supported way to construct a projection whose fields are known to be semantic:
 * everything the harness hashes is exactly what this contract declares.
 */
export function buildProjection(input: ProjectionInput): SemanticProjection {
  const schema = requireProjectionSchema(input.projectionId)
  const supplied = new Map<string, unknown>()
  for (const [field, value] of Object.entries(input.fields)) {
    // `undefined` means "not supplied": canonicalJson drops undefined members, so
    // accepting it here keeps `{ position: undefined }` and `{}` identical.
    if (value === undefined) continue
    if (!schema.fields.includes(field)) {
      throw new UndeclaredProjectionFieldError(schema.projectionId, field, schema.fields)
    }
    assertPlainData(value, `${schema.projectionId}.${field}`)
    supplied.set(field, value)
  }
  const payload: Record<string, unknown> = {}
  for (const field of schema.fields) {
    if (supplied.has(field)) payload[field] = epistemicEntryIfFact(supplied.get(field))
    else payload[field] = epistemicEntry(UNKNOWN)
  }
  return deepFreeze({ projectionId: schema.projectionId, version: schema.version, payload })
}

/**
 * `Epistemic` facts serialize through `epistemicEntry`, keeping `unknown` /
 * `not_observed` / `sensor_error` distinct from `false`/`0`. Plain values pass
 * through untouched.
 */
function epistemicEntryIfFact(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && 'state' in (value as Record<string, unknown>)) {
    const state = (value as { state?: unknown }).state
    if (state === 'known' || state === 'unknown' || state === 'not_observed' || state === 'sensor_error') {
      return epistemicEntry(value as Epistemic<unknown>)
    }
  }
  return value
}
