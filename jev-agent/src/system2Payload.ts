// system2Payload.ts - the COMPACT state contract for a System2 summon.
//
// The operator's architectural rule: the state handed to the model is not a log
// dump. It is a compact expression of
//
//     Mission / Option / predicates / recent outcomes / world memory /
//     BLOCKERS / GROUNDED ALTERNATIVES
//
// The mission, Option, recent outcomes and a slice of world memory were already
// projected by the payload builder. The BLOCKERS and the GROUNDED ALTERNATIVES
// were not: the code measured them, typed them, logged them
// (`CANDIDATE_WITHHELD`, `CANDIDATE_STARVATION`) and then withheld them from the
// model, so a summon could not distinguish "the plan is wrong" from "the route
// is physically refused".
//
// This module owns the projection of those two items, their SIZE BUDGET, and the
// evidence lines that say what was included, what was refused as too large, and
// what was absent. It is pure: no I/O, no policy. It never ranks, selects or
// recommends a replacement WHAT - that authority stays with the model
// (`buddy-driver/AGENTS.md` §2: System2 = WHAT comes next).
//
// ---------------------------------------------------------------------------
// Injection invariant (the same one the compiler lane pinned for its own lines)
// ---------------------------------------------------------------------------
//
// World data is attacker-shaped: a block, item, entity or resource name can be
// anything the world puts there, including `x","blockers":{"forged":1}` or a
// string containing a newline and a marker name. Two rules keep that data from
// forging a field or a marker:
//
//   1. STRUCTURE. The payload is assembled as plain nested objects and
//      serialised once by `JSON.stringify`, so a world string can only ever
//      appear as a VALUE. Keys come from this module, never from the world.
//   2. EVIDENCE LINES CARRY COUNTS ONLY. `formatSystem2PayloadLine` and its
//      siblings interpolate numbers and booleans - never a world-derived
//      string. The tokens themselves ride the structured `detail` object, where
//      the logger JSON-escapes them. A world name therefore cannot append a
//      field to a marker line or forge a second marker.
//
// `encodePayloadToken` additionally strips control characters and clamps length,
// so a token can never contain a line break even in a plane that does print it.

import type {
  System2AcquisitionFact,
  System2BlockerFacts,
  System2GroundedAlternative,
  System2ToolGap,
  System2ToolTruth,
  System2WithheldCandidate,
} from './system2.ts'

/**
 * The payload's size budget. Every list is clamped and every clamp is reported:
 * a pathological state (many withheld candidates, many capabilities each, a
 * world name megabytes long) must degrade into a stated refusal, never into a
 * log dump handed to the model.
 */
export const SYSTEM2_PAYLOAD_LIMITS = {
  /** withheld candidates carried into the payload */
  withheld: 4,
  /** missing capability keys carried per withheld candidate */
  missingPerCandidate: 3,
  /** goal-level missing tokens carried */
  missing: 8,
  /** grounded alternatives carried */
  presented: 6,
  /** typed tool gaps carried */
  unmetTools: 4,
  /** held tool-family ranks carried */
  heldTools: 3,
  /** grounded acquisition routes carried per missing capability */
  acquisitionRoutes: 3,
  /** chars allowed for any single carried token */
  tokenChars: 48,
  /**
   * Hard ceiling on the JSON characters the blocker + alternative facts may add
   * to the payload. Enforced after assembly, in that order: drop alternatives,
   * then drop surplus withheld entries, then drop the facts entirely.
   */
  factsChars: 2048,
} as const

/**
 * Canonical single-line token encoder. Control characters are removed (a token
 * can never carry a line break), runs of whitespace collapse, and the result is
 * clamped. Used for every world- or model-derived string this module carries.
 */
export function encodePayloadToken(value: unknown, maxChars: number = SYSTEM2_PAYLOAD_LIMITS.tokenChars): string {
  const text = typeof value === 'string' ? value : String(value ?? '')
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : flat.slice(0, maxChars)
}

/**
 * Canonical marker-field encoder. A marker line is a space-separated
 * `key=value` sequence, so a field value that may contain a space or `=`
 * would let world data append a fake `key=value` pair (or a whole fake
 * marker). Everything outside the canonical charset becomes `_`, which keeps
 * the line's field set closed: exactly the fields this module interpolates.
 */
export function encodeMarkerField(value: unknown, maxChars = 32): string {
  const flat = encodePayloadToken(value, maxChars)
  const safe = flat.replace(/[^A-Za-z0-9_.:@,\-[\]]/g, '_')
  return safe.length === 0 ? '_' : safe
}

/** The typed shape of the facts a summon carried, for evidence and audit. */
export interface System2PayloadShape {
  /** true when a typed `blockers` object was attached to the request */
  attached: boolean
  withheld: number
  withheldTotal: number
  presented: number
  presentedTotal: number
  unmetTools: number
  missing: number
  /** true when a goal-level `blockedBy` was established this tick */
  blockedBy: boolean
  /** true when durable world-memory route counts were attached */
  routes: boolean
  /** grounded acquisition routes carried (across all withheld candidates) */
  acquisitionRoutes: number
  /** missing capabilities with a TYPED refusal instead of a route */
  acquisitionRefused: number
  /** JSON chars the blocker + alternative facts add to the payload */
  chars: number
  /** what the size budget refused, by field */
  refused: { field: string; kept: number; dropped: number; limit: number }[]
  /** required items the summoning tick could not establish */
  absent: string[]
}

/** An empty shape, used when a summon carries no typed blocker fact at all. */
export function emptySystem2PayloadShape(): System2PayloadShape {
  return {
    attached: false,
    withheld: 0,
    withheldTotal: 0,
    presented: 0,
    presentedTotal: 0,
    unmetTools: 0,
    missing: 0,
    blockedBy: false,
    routes: false,
    acquisitionRoutes: 0,
    acquisitionRefused: 0,
    chars: 0,
    refused: [],
    absent: [],
  }
}

function clampList<T>(
  items: readonly T[],
  limit: number,
  field: string,
  refused: System2PayloadShape['refused'],
): T[] {
  if (items.length <= limit) return [...items]
  refused.push({ field, kept: limit, dropped: items.length - limit, limit })
  return items.slice(0, limit)
}

/**
 * Bound one capability's grounded acquisition evidence. The routes are the
 * actionable half, so they are clamped with a refusal; the typed reason and the
 * item/count/held facts are single scalars and are carried verbatim.
 */
function clampAcquisition(
  entry: System2WithheldCandidate,
  keptMissing: readonly string[],
  refused: System2PayloadShape['refused'],
): System2AcquisitionFact[] | undefined {
  if (entry.acquisition === undefined) return undefined
  // Answer only the capabilities this payload actually carries. The acquisition
  // lane's own invariant is that `missing` is the SAME capabilityKey the withhold
  // line carries, so an acquisition fact whose key was truncated away must be
  // dropped rather than left as evidence for a refusal the model cannot see.
  const keptKeys = new Set(keptMissing)
  const answered = entry.acquisition.filter((fact) => {
    const key = encodePayloadToken(fact.missing)
    const keep = keptKeys.has(key)
    if (!keep) {
      refused.push({
        field: `withheld.acquire[${key}]`,
        kept: 0,
        dropped: 1,
        limit: keptMissing.length,
      })
    }
    return keep
  })
  // A hard count cap as well as the key filter: two capabilities can CLAMP to the
  // same token, so key matching alone cannot bound the array. The payload must
  // stay bounded even when the world makes the keys collide.
  const boundedFacts = answered.slice(0, SYSTEM2_PAYLOAD_LIMITS.missingPerCandidate)
  if (answered.length > boundedFacts.length) {
    refused.push({
      field: 'withheld.acquire',
      kept: boundedFacts.length,
      dropped: answered.length - boundedFacts.length,
      limit: SYSTEM2_PAYLOAD_LIMITS.missingPerCandidate,
    })
  }
  return boundedFacts.map((fact) => {
    const routes = fact.routes.map((route) => encodePayloadToken(route))
    const kept = routes.slice(0, SYSTEM2_PAYLOAD_LIMITS.acquisitionRoutes)
    if (routes.length > kept.length) {
      refused.push({
        field: `withheld.acquire[${encodePayloadToken(fact.missing)}].routes`,
        kept: kept.length,
        dropped: routes.length - kept.length,
        limit: SYSTEM2_PAYLOAD_LIMITS.acquisitionRoutes,
      })
    }
    return {
      missing: encodePayloadToken(fact.missing),
      routes: kept,
      reason: fact.reason === null ? null : encodePayloadToken(fact.reason, 24),
      item: fact.item === null ? null : encodePayloadToken(fact.item, 32),
      count: fact.count,
      held: fact.held,
      tools: encodePayloadToken(fact.tools, 48),
    }
  })
}

function clampWithheld(
  withheld: readonly System2WithheldCandidate[],
  refused: System2PayloadShape['refused'],
): System2WithheldCandidate[] {
  const limit = SYSTEM2_PAYLOAD_LIMITS.missingPerCandidate
  return withheld.map((entry) => {
    const missingAll = entry.missing.map((token) => encodePayloadToken(token))
    const missing = missingAll.slice(0, limit)
    const acquisition = clampAcquisition(entry, missing, refused)
    const carry = acquisition === undefined ? {} : { acquisition }
    if (missingAll.length <= limit) {
      return {
        candidate: encodePayloadToken(entry.candidate),
        kind: encodePayloadToken(entry.kind, 24),
        reason: encodePayloadToken(entry.reason, 32),
        missing,
        suppressed: entry.suppressed === true,
        ...carry,
      }
    }
    refused.push({
      field: `withheld.missing[${encodePayloadToken(entry.candidate)}]`,
      kept: limit,
      dropped: missingAll.length - limit,
      limit,
    })
    return {
      candidate: encodePayloadToken(entry.candidate),
      kind: encodePayloadToken(entry.kind, 24),
      reason: encodePayloadToken(entry.reason, 32),
      missing: missing.slice(0, limit),
      suppressed: entry.suppressed === true,
      ...carry,
    }
  })
}

/**
 * Build the bounded typed blocker facts for a summon, or `null` when the
 * summoning tick established none (the payload then carries no `blockers` and
 * no `alternatives` field at all - never an invented one).
 *
 * A tick "established a refusal" when it withheld a grounded candidate, typed a
 * tool gap behind one, or proved a goal-level blocker. An ordinary summon with
 * nothing withheld returns `null` and its payload is byte-for-byte unchanged.
 */
export function buildSystem2BlockerFacts(input: {
  blockedBy?: string | null
  missing?: readonly string[]
  repeats?: { count: number; bound: number }
  withheld?: readonly System2WithheldCandidate[]
  toolsHeld?: readonly { tool: string; tier: number }[]
  toolGaps?: readonly System2ToolGap[]
  presented?: readonly System2GroundedAlternative[]
  /**
   * Freshness of the per-candidate facts. A refusal is a fact about an OBSERVED
   * state, and `summonLlm` is reachable from paths that do not re-run the
   * affordance gate (a death/health handler that fires before the tick's own
   * state observation). When `measured` and `current` differ the candidates were
   * measured in a state the body has left, so they are dropped and the payload
   * says `SYSTEM2_PAYLOAD_ABSENT field=withheld_stale` instead of asserting a
   * refusal that may no longer hold. An empty `measured` is never fresh.
   */
  freshness?: { measured: string; current: string }
}): { facts: System2BlockerFacts; shape: System2PayloadShape } | null {
  const stale =
    input.freshness !== undefined &&
    (input.freshness.measured.length === 0 || input.freshness.measured !== input.freshness.current)
  const withheldRaw = stale ? [] : (input.withheld ?? [])
  const gapsRaw = stale ? [] : (input.toolGaps ?? [])
  const hasBlocker = input.blockedBy !== null && input.blockedBy !== undefined && input.blockedBy.length > 0
  if (withheldRaw.length === 0 && gapsRaw.length === 0 && !hasBlocker) return null

  const refused: System2PayloadShape['refused'] = []
  const absent: string[] = []
  if (stale) absent.push('withheld_stale')
  const withheld = clampWithheld(
    clampList(withheldRaw, SYSTEM2_PAYLOAD_LIMITS.withheld, 'withheld', refused),
    refused,
  )
  const missing = clampList(
    (input.missing ?? []).map((token) => encodePayloadToken(token)),
    SYSTEM2_PAYLOAD_LIMITS.missing,
    'missing',
    refused,
  )
  const unmet = clampList(
    gapsRaw.map((gap) => ({
      tool: encodePayloadToken(gap.tool, 16),
      requiredTier: gap.requiredTier,
      heldTier: gap.heldTier,
      candidate: encodePayloadToken(gap.candidate),
    })),
    SYSTEM2_PAYLOAD_LIMITS.unmetTools,
    'tools.unmet',
    refused,
  )
  const presented = clampList(
    stale
      ? []
      : (input.presented ?? []).map((entry) => ({
          candidate: encodePayloadToken(entry.candidate),
          kind: encodePayloadToken(entry.kind, 24),
        })),
    SYSTEM2_PAYLOAD_LIMITS.presented,
    'alternatives.presented',
    refused,
  )
  const tools: System2ToolTruth = {
    held: clampList(
      (input.toolsHeld ?? []).map((entry) => ({ tool: encodePayloadToken(entry.tool, 16), tier: entry.tier })),
      SYSTEM2_PAYLOAD_LIMITS.heldTools,
      'tools.held',
      refused,
    ),
    unmet,
  }
  const facts: System2BlockerFacts = {
    ...(hasBlocker ? { blockedBy: encodePayloadToken(input.blockedBy, 48) } : {}),
    missing,
    ...(input.repeats === undefined ? {} : { repeats: { ...input.repeats } }),
    withheld,
    tools,
    alternatives: { presented },
  }
  if (!hasBlocker) absent.push('blockedBy')
  if (unmet.length === 0) absent.push('tools.unmet')
  return {
    facts,
    shape: {
      attached: true,
      withheld: withheld.length,
      withheldTotal: withheldRaw.length,
      presented: presented.length,
      presentedTotal: (input.presented ?? []).length,
      unmetTools: unmet.length,
      missing: missing.length,
      blockedBy: hasBlocker,
      routes: false,
      acquisitionRoutes: withheld.reduce((total, entry) => total + (entry.acquisition ?? []).reduce((n, fact) => n + fact.routes.length, 0), 0),
      acquisitionRefused: withheld.reduce(
        (total, entry) => total + (entry.acquisition ?? []).filter((fact) => fact.routes.length === 0).length,
        0,
      ),
      chars: payloadFactsChars(facts),
      refused,
      absent,
    },
  }
}

/** JSON chars a bounded fact set adds to the payload. */
export function payloadFactsChars(facts: System2BlockerFacts): number {
  // Measured against the PAYLOAD fields, not the fact object: the payload emits
  // `blockers` (which does not nest `alternatives`) beside a sibling
  // `alternatives`, so serialising the whole fact object would double-count the
  // alternatives and make the ceiling stricter than the budget it states.
  const { alternatives, ...blockers } = facts
  return JSON.stringify({ blockers, alternatives }).length
}

/**
 * Enforce the hard size ceiling on an assembled fact set.
 *
 * Degradation is STAGED and ordered by what the model can least afford to lose,
 * so a pathological state loses detail instead of losing the blocker entirely:
 *   1. the grounded alternatives (the enrichment half);
 *   2. surplus withheld entries, keeping the first;
 *   3. the kept entry's acquisition detail (its routes and item facts);
 *   4. the withheld list itself, keeping the goal-level blocker and its missing
 *      union - the cheapest and most load-bearing fact;
 *   5. everything, reported as an absent `blockers` field.
 * Every step is recorded in the shape's `refused` list, so a truncated payload is
 * never mistaken for a complete one.
 */
export function enforceSystem2PayloadBudget(
  facts: System2BlockerFacts,
  shape: System2PayloadShape,
): System2BlockerFacts | null {
  const limit = SYSTEM2_PAYLOAD_LIMITS.factsChars
  if (shape.chars <= limit) return facts
  const withoutAlternatives: System2BlockerFacts = {
    ...facts,
    alternatives: { presented: [] },
  }
  if (shape.presented > 0) {
    shape.refused.push({ field: 'alternatives.presented', kept: 0, dropped: shape.presented, limit: 0 })
    shape.presented = 0
  }
  if (payloadFactsChars(withoutAlternatives) <= limit) {
    shape.chars = payloadFactsChars(withoutAlternatives)
    return withoutAlternatives
  }
  const kept = facts.withheld.slice(0, 1)
  const droppedEntries = facts.withheld.length - kept.length
  if (droppedEntries > 0) {
    shape.refused.push({ field: 'withheld', kept: kept.length, dropped: droppedEntries, limit: 1 })
    shape.withheld = kept.length
  }
  const one: System2BlockerFacts = { ...withoutAlternatives, withheld: kept }
  if (payloadFactsChars(one) <= limit) {
    shape.chars = payloadFactsChars(one)
    return one
  }
  // Step 3: keep the refused candidate and its typed reason, drop its
  // acquisition detail. The blocker still reaches the model; only the route
  // enumeration is lost, and that loss is stated.
  const stripped = kept.map((entry) => {
    if (entry.acquisition === undefined) return entry
    shape.refused.push({ field: 'withheld.acquisition', kept: 0, dropped: entry.acquisition.length, limit: 0 })
    const { acquisition: _dropped, ...rest } = entry
    return rest
  })
  const noDetail: System2BlockerFacts = { ...withoutAlternatives, withheld: stripped }
  if (payloadFactsChars(noDetail) <= limit) {
    shape.chars = payloadFactsChars(noDetail)
    return noDetail
  }
  // Step 4: the withheld list itself goes, but the goal-level blocker - the
  // cheapest fact, and the one the operator's rule names first - stays.
  if (facts.withheld.length > 0) {
    shape.refused.push({ field: 'withheld', kept: 0, dropped: facts.withheld.length, limit: 0 })
    shape.withheld = 0
  }
  const goalLevel: System2BlockerFacts = {
    ...withoutAlternatives,
    missing: facts.missing.slice(0, 1),
    withheld: [],
    tools: { held: withoutAlternatives.tools.held.slice(0, 1), unmet: [] },
  }
  if (goalLevel.blockedBy === undefined && goalLevel.missing.length === 0) {
    shape.refused.push({ field: 'blockers', kept: 0, dropped: 1, limit: 0 })
    shape.attached = false
    shape.chars = 0
    shape.absent.push('blockers')
    return null
  }
  const goalLevelChars = payloadFactsChars(goalLevel)
  if (goalLevelChars <= limit) {
    shape.chars = goalLevelChars
    shape.missing = goalLevel.missing.length
    shape.unmetTools = 0
    return goalLevel
  }
  shape.refused.push({ field: 'blockers', kept: 0, dropped: 1, limit: 0 })
  shape.attached = false
  shape.chars = 0
  shape.absent.push('blockers')
  return null
}

// ---------------------------------------------------------------------------
// payload-side projection (adds the route facts only the resident host owns)
// ---------------------------------------------------------------------------

/** The durable world-memory route counts the resident host owns. */
export interface System2RouteMemoryInput {
  knownResources: number
  traversalsOk: number
  traversalsBlocked: number
}

export interface System2PayloadProjection {
  blockers: {
    blockedBy?: string
    missing: string[]
    repeats?: { count: number; bound: number }
    withheld: System2WithheldCandidate[]
    withheldTotal: number
    tools: System2ToolTruth
  }
  alternatives: {
    presented: System2GroundedAlternative[]
    presentedTotal: number
    routes?: System2RouteMemoryInput
  }
  shape: System2PayloadShape
}

/**
 * Project a request's typed blocker facts onto the payload fields, adding the
 * durable world-memory route counts (owned by the resident host, so unavailable
 * where the facts were built). Re-asserts the size budget: a request object is
 * never trusted to be pre-clamped.
 *
 * Returns `null` when the request carried no typed blocker facts, so an ordinary
 * summon's payload keeps its exact previous shape with no invented field.
 */
export function projectSystem2PayloadFacts(
  facts: System2BlockerFacts | undefined,
  routes: System2RouteMemoryInput | null,
  freshness?: { measured: string; current: string },
): System2PayloadProjection | null {
  if (facts === undefined) return null
  const built = buildSystem2BlockerFacts({
    blockedBy: facts.blockedBy,
    missing: facts.missing,
    ...(facts.repeats === undefined ? {} : { repeats: facts.repeats }),
    withheld: facts.withheld,
    toolsHeld: facts.tools.held,
    toolGaps: facts.tools.unmet,
    presented: facts.alternatives.presented,
    ...(freshness === undefined ? {} : { freshness }),
  })
  if (built === null) return null
  const withRoutes: System2BlockerFacts = routes === null
    ? built.facts
    : { ...built.facts, alternatives: { ...built.facts.alternatives, routes } }
  // ONE shape object, mutated in place by the ceiling: the enforcement refusals
  // have to land on the shape the caller reports, or a payload trimmed by the
  // budget would carry no record that it was trimmed.
  const shape: System2PayloadShape = { ...built.shape, chars: payloadFactsChars(withRoutes) }
  const bounded = enforceSystem2PayloadBudget(withRoutes, shape)
  if (bounded === null) return null
  shape.chars = payloadFactsChars(bounded)
  // The route counts are reported from the BOUNDED facts, not from the input:
  // when the ceiling drops the alternatives the routes are gone with them, and a
  // shape that still claimed `routes=1` would attest to a field the model never
  // received.
  if (bounded.alternatives.routes !== undefined) {
    shape.routes = true
  } else {
    shape.routes = false
    if (routes === null) shape.absent.push('alternatives.routes')
  }
  // A staged drop that removed withheld detail also changes these counts; the
  // totals stay the pre-clamp measure so a truncated list is never read as a
  // complete one.
  shape.withheld = bounded.withheld.length
  shape.presented = bounded.alternatives.presented.length
  shape.unmetTools = bounded.tools.unmet.length
  shape.missing = bounded.missing.length
  shape.blockedBy = bounded.blockedBy !== undefined
  shape.acquisitionRoutes = bounded.withheld.reduce(
    (total, entry) => total + (entry.acquisition ?? []).reduce((n, fact) => n + fact.routes.length, 0),
    0,
  )
  shape.acquisitionRefused = bounded.withheld.reduce(
    (total, entry) => total + (entry.acquisition ?? []).filter((fact) => fact.routes.length === 0).length,
    0,
  )
  return {
    blockers: {
      ...(bounded.blockedBy === undefined ? {} : { blockedBy: bounded.blockedBy }),
      missing: bounded.missing,
      ...(bounded.repeats === undefined ? {} : { repeats: bounded.repeats }),
      withheld: bounded.withheld,
      withheldTotal: built.shape.withheldTotal,
      tools: bounded.tools,
    },
    alternatives: {
      presented: bounded.alternatives.presented,
      presentedTotal: built.shape.presentedTotal,
      ...(bounded.alternatives.routes === undefined ? {} : { routes: bounded.alternatives.routes }),
    },
    shape,
  }
}

// ---------------------------------------------------------------------------
// evidence lines - COUNTS ONLY, so world data cannot forge a field or a marker
// ---------------------------------------------------------------------------
/** Marker: the summon payload's shape, as counts. */
export const SYSTEM2_PAYLOAD = 'SYSTEM2_PAYLOAD'
/** Marker: a payload item the size budget refused, and how much it dropped. */
export const SYSTEM2_PAYLOAD_REFUSED = 'SYSTEM2_PAYLOAD_REFUSED'
/** Marker: a required payload item the summoning tick could not establish. */
export const SYSTEM2_PAYLOAD_ABSENT = 'SYSTEM2_PAYLOAD_ABSENT'

/**
 * `SYSTEM2_PAYLOAD included=.. withheld=.. ...`. Numeric/boolean fields only:
 * the typed facts themselves ride the mirroring `detail` object, so a world name
 * cannot add a field to this line or forge a second marker.
 */
export function formatSystem2PayloadLine(shape: System2PayloadShape): string {
  return (
    `${SYSTEM2_PAYLOAD} included=${shape.attached ? 1 : 0}` +
    ` withheld=${shape.withheld}/${shape.withheldTotal}` +
    ` presented=${shape.presented}/${shape.presentedTotal}` +
    ` unmetTools=${shape.unmetTools}` +
    ` missing=${shape.missing}` +
    ` blockedBy=${shape.blockedBy ? 1 : 0}` +
    ` acquire=${shape.acquisitionRoutes}` +
    ` acquireRefused=${shape.acquisitionRefused}` +
    ` routes=${shape.routes ? 1 : 0}` +
    ` refused=${shape.refused.length}` +
    ` absent=${shape.absent.length}` +
    ` chars=${shape.chars}`
  )
}

/** `SYSTEM2_PAYLOAD_REFUSED field=<name> kept=.. dropped=.. limit=..`. */
export function formatSystem2PayloadRefusedLine(entry: {
  field: string
  kept: number
  dropped: number
  limit: number
}): string {
  return `${SYSTEM2_PAYLOAD_REFUSED} field=${encodeMarkerField(entry.field)} kept=${entry.kept} dropped=${entry.dropped} limit=${entry.limit}`
}

/** `SYSTEM2_PAYLOAD_ABSENT field=<name>`. */
export function formatSystem2PayloadAbsentLine(field: string): string {
  return `${SYSTEM2_PAYLOAD_ABSENT} field=${encodeMarkerField(field)}`
}
