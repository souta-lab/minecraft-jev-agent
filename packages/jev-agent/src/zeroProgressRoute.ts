// zeroProgressRoute.ts - the bounded "a zero-progress action must change
// something before the same target is retried" rule.
//
// Measured live (run-muc3qbug-18vg3, source 376e176, m3-live): 82 causal chains
// in ten minutes carried `observable=false execution=failure`, 75 of them
// `DESCEND:down:<dir>:b...` steps whose dig removed nothing at all
// (`PATH_CALLBACK phase=failed ... outcome=noPath|stuck`), each with a FRESH
// candidate id but the SAME body position and the SAME blocked geometry, so
// every failure sample looked like a new decision to the per-id failure memory.
// The same shape appears on the retrieval arm: a remembered ore is offered with
// a vertical plan that cannot make it observable, and the retry repeats the same
// action from the same stand cell until a stall timer eventually retires it.
//
// The postcondition layer already owns the verdict (a zero-observable-change
// action IS a failure - `actionPostcondition.ts#isZeroProgressOutcome`). This
// module owns only what happens NEXT, which is deterministic CAN/TRUE territory:
//
//   - an attempt is identified by (kind, target cell, stand cell, route
//     signature). "Same action with unchanged preconditions" is exactly a repeat
//     of that tuple, so it is never offered again;
//   - a route signature describes HOW the action was carried out (vertical plan,
//     mode/dir, dig/step cells), so a genuinely different vertical plan or a
//     different stand cell is a grounded route change and stays offerable;
//   - a bounded number of DISTINCT zero-progress routes from the same stand cell
//     exhausts that family at that stand cell, which forces a route change
//     (a different stand cell / different family) or the existing escalation -
//     it never silently samples more cells forever;
//   - the memory is age-bounded and cleared by any real observable progress, so a
//     transient blocked state cannot blacklist a route permanently.
//
// Pure: no bot, no clock, no model. Same facts in -> same verdict out.

import { SPATIAL_GRID } from './failureMemory.ts'

export interface Vec3Json {
  x: number
  y: number
  z: number
}

/**
 * Candidate kinds whose own postcondition is a mechanical world/body change and
 * whose failure can therefore be repeated with identical preconditions.
 *
 * MOVE is included, but ONLY for a MOVE that carries a route declaration (a
 * vertical/pillar ascent, a dig or place route, a bridge, a level scan, a contact
 * ascent) - the caller applies that condition. A plain WALK stays out for the
 * original reason: its failure memory is `moveFailMemory` plus the candidate-failure
 * map, and a leg that closed distance is already progress.
 *
 * Why the addition is needed, measured live: a MOVE-family ascent can settle
 * SUCCESS with `progressDelta=0` (nothing observable changed), so it is not a
 * failure and `moveFailMemory` never records it - and while MOVE was excluded here,
 * no other memory held it either, so the same ascent re-offered forever
 * (`ASCEND:target:p24_102_-4 ... status=done progressDelta=0`, repeatedly, at the
 * same stand cell). RETREAT is still deliberately absent.
 */
export type ZeroProgressRouteKind = 'RETRIEVE' | 'DESCEND' | 'STEP' | 'ENTER_PORTAL' | 'MOVE'

const ZERO_PROGRESS_ROUTE_KINDS: ReadonlySet<string> = new Set<string>([
  'RETRIEVE',
  'DESCEND',
  'STEP',
  'ENTER_PORTAL',
  'MOVE',
])

export function isZeroProgressRouteKind(kind: string): kind is ZeroProgressRouteKind {
  return ZERO_PROGRESS_ROUTE_KINDS.has(kind)
}

/**
 * Distinct zero-progress routes at one stand cell before that family is withheld
 * there. Two: the first failure already proves the specific route dead, so the
 * second only ever legitimately happens after a grounded route change - and a
 * second distinct zero-progress route from the SAME body cell is the mechanical
 * fact "this body position cannot execute this family".
 */
export const ZERO_PROGRESS_STAND_ROUTE_LIMIT = 2

/** Attempts older than this stop gating (a transient blockage must not be permanent). */
export const ZERO_PROGRESS_TTL_MS = 120_000

/** Hard bound on retained attempts; oldest are evicted first. */
export const ZERO_PROGRESS_MAX_ENTRIES = 64

export interface ZeroProgressRouteEntry {
  kind: string
  /** the action's own target cell, floored (`x_y_z`) */
  targetKey: string
  /** the body feet cell when the attempt was issued, floored (`x_y_z`) */
  standKey: string
  /** grounded description of HOW the attempt was carried out */
  routeSig: string
  /** zero-progress attempts recorded for the exact route signature */
  attempts: number
  /** the executor failure that produced the zero-progress verdict, when known */
  lastReason: string
  lastAtMs: number
}

export type ZeroProgressRoutes = Record<string, ZeroProgressRouteEntry>

/** Floored cell identity, shared by the recorder and the candidate generators. */
export function cellKey(position: Vec3Json): string {
  return `${Math.floor(position.x)}_${Math.floor(position.y)}_${Math.floor(position.z)}`
}

export function zeroProgressRouteKey(kind: string, targetKey: string, standKey: string): string {
  return `${kind}|${targetKey}|${standKey}`
}

/**
 * The typed reason a route arm reports when EVERY grounded route for the active
 * goal's target is spent from the current body cell: the dead route was
 * withheld and no grounded approach leg changes the stand cell. That is a
 * structural capability boundary (code can ground no route at all), so it is
 * the one route fact that belongs to System2's WHAT - never an offer of the
 * same failing route again.
 */
export const ROUTE_ALL_SPENT_REASON = 'all_routes_spent'

/** The executor stage a route-shaped action failed at, from its typed failure code. */
export type RouteFailureStage = 'path' | 'move'

/**
 * The executor STAGE a settled failure happened at, from the typed failure code
 * the executor returned: the pathfinder stage (`path_no_path` / `path_stuck`) or
 * the mechanical leg (any other settled failure). Null when the action did not
 * fail, so a `done`-but-unverified outcome keeps the zero-observable-change
 * verdict as its only route evidence.
 *
 * This is what makes a PATH-STAGE failure a spent route: the executor reports
 * `PATH_CALLBACK phase=failed ... outcome=noPath|stuck` and settles `failed`,
 * but a lease that also nudged the body can carry the lenient `progressed`
 * signal - the route still did not complete, and re-offering it from the same
 * stand cell is the same action with unchanged preconditions.
 */
export function routeFailureStage(failure: string | null | undefined): RouteFailureStage | null {
  if (failure === null || failure === undefined || failure.length === 0) return null
  if (failure === 'cancelled') return null
  if (failure === 'path_no_path' || failure === 'path_stuck') return 'path'
  return 'move'
}

function quantize(value: number): number {
  return Math.floor(value / SPATIAL_GRID)
}

/** Coarse (3-block) bucket of a floored `x_y_z` cell key, or null when unparseable. */
export function cellBucket(key: string): string | null {
  const parts = key.split('_')
  if (parts.length !== 3) return null
  const x = Number(parts[0])
  const y = Number(parts[1])
  const z = Number(parts[2])
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return `${quantize(x)},${quantize(y)},${quantize(z)}`
}

/**
 * Coarse-cell proximity, mirroring `failureMemory.ts#spatialNeighborhoodKeys`
 * (#8a): a body that jitters by one or two blocks has not changed its mechanical
 * situation, so its stand cells share one family bucket.
 */
function bucketsNear(a: string, b: string): boolean {
  if (a === b) return true
  const pa = a.split(',').map(Number)
  const pb = b.split(',').map(Number)
  if (pa.length !== 3 || pb.length !== 3) return false
  for (let i = 0; i < 3; i += 1) {
    const da = pa[i]
    const db = pb[i]
    if (da === undefined || db === undefined) return false
    if (Math.abs(da - db) > 1) return false
  }
  return true
}

export interface RouteSignatureInput {
  kind: string
  id: string
  meta: Readonly<Record<string, string | number | boolean | undefined>>
}

function metaCell(meta: RouteSignatureInput['meta'], key: string): string | null {
  const x = meta[`${key}X`]
  const y = meta[`${key}Y`]
  const z = meta[`${key}Z`]
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null
  return `${x},${y},${z}`
}

function metaText(meta: RouteSignatureInput['meta'], key: string): string | null {
  const value = meta[key]
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null
}

/**
 * The grounded identity of a route-shaped action that TRAVELS the body to a
 * target cell (the enter/dimension-transfer family today, any future
 * travel/route kind that carries the same `vertical` plan contract a MOVE
 * candidate carries): the plan that decides HOW the body gets there.
 *
 * The default `${kind}:${id}` signature cannot see a route change at all: a
 * fresh candidate id is minted for every decision, but the mechanical plan is
 * what makes two attempts the same or different. Two attempts with the same
 * signature used the same route from the same stand cell; a different vertical
 * plan, dig/step cell, direction, pillar length or tunnel fallback is a real
 * route change and stays offerable.
 */
export function routePlanSignature(candidate: RouteSignatureInput): string {
  const meta = candidate.meta
  const vertical = metaText(meta, 'vertical') ?? 'none'
  const dir = metaText(meta, 'stairDir') ?? metaText(meta, 'upDir') ?? 'unknown'
  const dig =
    metaCell(meta, 'stairDig') ??
    metaCell(meta, 'upDig') ??
    metaCell(meta, 'tunnel') ??
    metaCell(meta, 'tunnelClear') ??
    'none'
  const step = metaCell(meta, 'stairStep') ?? metaCell(meta, 'upStep') ?? 'none'
  const from = metaText(meta, 'verticalFromY') ?? 'unknown'
  const to = metaText(meta, 'verticalToY') ?? 'unknown'
  const pillar = metaText(meta, 'pillarSteps') ?? '0'
  const fallback = metaText(meta, 'fallbackVertical') ?? 'none'
  return `${candidate.kind}:${vertical}:${dir}:${from}->${to}:dig=${dig}:step=${step}:pillar=${pillar}:fallback=${fallback}`
}

/**
 * The grounded identity of HOW an action was attempted. Two attempts with the
 * same signature target the same cell with the same mechanical plan; two
 * attempts with a different signature differ in a grounded way (a different
 * vertical plan, mode/direction, or dig/step cell) and are therefore a real
 * route change rather than a repeat.
 */
export function routeSignature(candidate: RouteSignatureInput): string {
  const meta = candidate.meta
  switch (candidate.kind) {
    case 'DESCEND':
    case 'STEP': {
      const mode = metaText(meta, 'mode') ?? 'unknown'
      const dir = metaText(meta, 'dir') ?? 'unknown'
      const dig = metaCell(meta, 'dig') ?? 'unknown'
      const step = metaCell(meta, 'step') ?? 'unknown'
      return `${candidate.kind}:${mode}:${dir}:dig=${dig}:step=${step}`
    }
    case 'RETRIEVE': {
      const vertical = metaText(meta, 'vertical') ?? 'none'
      // The cells a vertical leg would dig/stand in are what make two retries
      // mechanically different, so they belong in the signature.
      const leg =
        metaCell(meta, 'stairDig') ??
        metaCell(meta, 'upDig') ??
        metaCell(meta, 'tunnel') ??
        metaCell(meta, 'tunnelClear') ??
        'none'
      const from = metaText(meta, 'verticalFromY') ?? 'unknown'
      const to = metaText(meta, 'verticalToY') ?? 'unknown'
      return `${candidate.kind}:${vertical}:${from}->${to}:leg=${leg}`
    }
    default:
      // A route kind that travels the body to a cell and carries a grounded
      // vertical/dig plan: the plan IS the route, so it belongs in the identity.
      if (isZeroProgressRouteKind(candidate.kind) && typeof meta.vertical === 'string' && meta.vertical !== 'none') {
        return routePlanSignature(candidate)
      }
      return `${candidate.kind}:${candidate.id}`
  }
}

export interface ZeroProgressObservation {
  kind: string
  targetKey: string
  standKey: string
  routeSig: string
  reason: string
  nowMs: number
  /** distinct zero-progress routes at one stand cell before the family is spent */
  standLimit?: number
  ttlMs?: number
  maxEntries?: number
}

export interface ZeroProgressRouteDecision {
  routes: ZeroProgressRoutes
  entry: ZeroProgressRouteEntry
  /** zero-progress attempts for the exact route signature, INCLUDING this one */
  attempts: number
  /**
   * true when this attempt differed from the previous zero-progress attempt for
   * the same target (a different stand cell or a different route signature).
   * false for the first recorded attempt: nothing has changed yet.
   */
  routeChanged: boolean
  /**
   * true when THIS attempt is the one that spends this exact route signature at
   * this stand cell (the first record for it). Subsequent records of the same
   * signature mean the withholding did not happen, which is a defect - they are
   * counted, never silently merged.
   */
  routeSpentNow: boolean
  /** distinct zero-progress routes recorded at this stand cell's bucket, INCLUDING this one */
  familyAttempts: number
  /** true once the family budget at this stand cell is spent */
  familyExhausted: boolean
}

function entryIsFresh(entry: ZeroProgressRouteEntry, nowMs: number, ttlMs: number): boolean {
  return nowMs - entry.lastAtMs < ttlMs
}

function prune(routes: ZeroProgressRoutes, nowMs: number, ttlMs: number, maxEntries: number): ZeroProgressRoutes {
  const kept: ZeroProgressRouteEntry[] = []
  for (const entry of Object.values(routes)) {
    if (entryIsFresh(entry, nowMs, ttlMs)) kept.push(entry)
  }
  kept.sort((a, b) => b.lastAtMs - a.lastAtMs)
  const bounded = kept.slice(0, Math.max(1, maxEntries))
  const out: ZeroProgressRoutes = {}
  for (const entry of bounded) out[zeroProgressRouteKey(entry.kind, entry.targetKey, entry.standKey)] = entry
  return out
}

/**
 * Record one settled zero-observable-change attempt. Returns a NEW ledger (the
 * caller owns publication into the world state) plus the bounded verdicts the
 * controller logs and the candidate layer consumes.
 */
export function observeZeroProgressRoute(
  routes: ZeroProgressRoutes | undefined,
  input: ZeroProgressObservation,
): ZeroProgressRouteDecision {
  const ttlMs = input.ttlMs ?? ZERO_PROGRESS_TTL_MS
  const maxEntries = input.maxEntries ?? ZERO_PROGRESS_MAX_ENTRIES
  const standLimit = Math.max(1, Math.floor(input.standLimit ?? ZERO_PROGRESS_STAND_ROUTE_LIMIT))
  const fresh = prune(routes ?? {}, input.nowMs, ttlMs, maxEntries)
  const key = zeroProgressRouteKey(input.kind, input.targetKey, input.standKey)
  const previous = fresh[key]
  const attempts = (previous?.attempts ?? 0) + 1
  const entry: ZeroProgressRouteEntry = {
    kind: input.kind,
    targetKey: input.targetKey,
    standKey: input.standKey,
    routeSig: input.routeSig,
    attempts,
    lastReason: input.reason,
    lastAtMs: input.nowMs,
  }
  const next: ZeroProgressRoutes = { ...fresh, [key]: entry }
  const previousForTarget = Object.values(fresh).find(
    (candidate) => candidate.kind === input.kind && candidate.targetKey === input.targetKey,
  )
  const routeChanged =
    previousForTarget !== undefined &&
    (previousForTarget.standKey !== input.standKey || previousForTarget.routeSig !== input.routeSig)
  const familyAttempts = familyRouteCount(next, input.kind, input.standKey, input.nowMs, ttlMs)
  return {
    routes: prune(next, input.nowMs, ttlMs, maxEntries),
    entry,
    attempts,
    routeChanged,
    routeSpentNow: previous === undefined || previous.routeSig !== input.routeSig,
    familyAttempts,
    familyExhausted: familyAttempts >= standLimit,
  }
}

/** Distinct recorded routes of one kind whose stand bucket touches `standKey`'s. */
function familyRouteCount(
  routes: ZeroProgressRoutes,
  kind: string,
  standKey: string,
  nowMs: number,
  ttlMs: number,
): number {
  const bucket = cellBucket(standKey)
  if (bucket === null) return 0
  const signatures = new Set<string>()
  for (const entry of Object.values(routes)) {
    if (entry.kind !== kind) continue
    if (!entryIsFresh(entry, nowMs, ttlMs)) continue
    const other = cellBucket(entry.standKey)
    if (other === null || !bucketsNear(bucket, other)) continue
    signatures.add(entry.routeSig)
  }
  return signatures.size
}

/** The recorded zero-progress attempt for a target from a stand cell, when fresh. */
export function zeroProgressRouteEntry(
  routes: ZeroProgressRoutes | undefined,
  input: { kind: string; targetKey: string; standKey: string; nowMs: number; ttlMs?: number },
): ZeroProgressRouteEntry | null {
  const entry = routes?.[zeroProgressRouteKey(input.kind, input.targetKey, input.standKey)]
  if (entry === undefined) return null
  const ttlMs = input.ttlMs ?? ZERO_PROGRESS_TTL_MS
  return entryIsFresh(entry, input.nowMs, ttlMs) ? entry : null
}

/**
 * True when this route already proved zero observable change from this stand
 * cell: the same action with unchanged preconditions. A DIFFERENT stand cell is
 * explicitly a grounded change (the body is somewhere else), so it is not
 * blocked here - the caller re-offers and the existing per-target budgets bound
 * it.
 */
export function isZeroProgressRouteRepeat(
  routes: ZeroProgressRoutes | undefined,
  input: { kind: string; targetKey: string; standKey: string; routeSig: string; nowMs: number; ttlMs?: number },
): boolean {
  const entry = zeroProgressRouteEntry(routes, input)
  return entry !== null && entry.routeSig === input.routeSig
}

/** Distinct zero-progress routes recorded at this stand cell's bucket. */
export function standFamilyRouteCount(
  routes: ZeroProgressRoutes | undefined,
  kind: string,
  standKey: string,
  input: { nowMs: number; ttlMs?: number },
): number {
  return familyRouteCount(routes ?? {}, kind, standKey, input.nowMs, input.ttlMs ?? ZERO_PROGRESS_TTL_MS)
}

/**
 * Distinct spent routes recorded for ONE (kind, target) across stand cells: the
 * goal-level route budget. A route identity is (stand cell, route signature), so
 * a grounded approach leg that moves the body adds a NEW identity instead of
 * re-charging the old one - the goal is only "out of routes" when no stand cell
 * and no plan is left offerable.
 */
export function goalSpentRouteCount(
  routes: ZeroProgressRoutes | undefined,
  input: { kind: string; targetKey: string; nowMs: number; ttlMs?: number },
): number {
  const ttlMs = input.ttlMs ?? ZERO_PROGRESS_TTL_MS
  const identities = new Set<string>()
  for (const entry of Object.values(routes ?? {})) {
    if (entry.kind !== input.kind) continue
    if (entry.targetKey !== input.targetKey) continue
    if (!entryIsFresh(entry, input.nowMs, ttlMs)) continue
    identities.add(`${entry.standKey}|${entry.routeSig}`)
  }
  return identities.size
}

/** True once `limit` distinct zero-progress routes were recorded at this stand cell. */
export function standFamilyExhausted(
  routes: ZeroProgressRoutes | undefined,
  kind: string,
  standKey: string,
  input: { nowMs: number; ttlMs?: number; limit?: number },
): boolean {
  const limit = Math.max(1, Math.floor(input.limit ?? ZERO_PROGRESS_STAND_ROUTE_LIMIT))
  return standFamilyRouteCount(routes, kind, standKey, input) >= limit
}

/**
 * A real observable change at a stand cell retires the zero-progress memory for
 * that cell: whatever was blocked there is no longer proven blocked. Returns the
 * same object when nothing was dropped, so callers can avoid needless copies.
 */
export function clearZeroProgressStand(
  routes: ZeroProgressRoutes | undefined,
  kind: string,
  standKey: string,
): ZeroProgressRoutes {
  if (routes === undefined) return {}
  const bucket = cellBucket(standKey)
  let changed = false
  const out: ZeroProgressRoutes = {}
  for (const [key, entry] of Object.entries(routes)) {
    const other = cellBucket(entry.standKey)
    if (entry.kind === kind && bucket !== null && other !== null && bucketsNear(bucket, other)) {
      changed = true
      continue
    }
    out[key] = entry
  }
  return changed ? out : routes
}

/** A completed retrieval of a target retires every zero-progress entry for it. */
export function clearZeroProgressTarget(
  routes: ZeroProgressRoutes | undefined,
  kind: string,
  targetKey: string,
): ZeroProgressRoutes {
  if (routes === undefined) return {}
  let changed = false
  const out: ZeroProgressRoutes = {}
  for (const [key, entry] of Object.entries(routes)) {
    if (entry.kind === kind && entry.targetKey === targetKey) {
      changed = true
      continue
    }
    out[key] = entry
  }
  return changed ? out : routes
}

/** `ACTION_ZERO_PROGRESS action=<id> target=x,y,z kind=<K> retry=n route_changed=<bool> stand=x,y,z`. */
export function formatActionZeroProgress(input: {
  action: string
  target: Vec3Json
  kind: string
  retry: number
  routeChanged: boolean
  stand: Vec3Json
}): string {
  const target = `${Math.floor(input.target.x)},${Math.floor(input.target.y)},${Math.floor(input.target.z)}`
  const stand = `${Math.floor(input.stand.x)},${Math.floor(input.stand.y)},${Math.floor(input.stand.z)}`
  return (
    `ACTION_ZERO_PROGRESS action=${input.action} target=${target} kind=${input.kind} ` +
    `retry=${input.retry} route_changed=${String(input.routeChanged)} stand=${stand}`
  )
}

/** `RETRIEVE_RETIRED reason=<reason> target=x,y,z attempts=<n>`. */
export function formatRetrieveRetired(reason: string, target: Vec3Json, attempts: number): string {
  return `RETRIEVE_RETIRED reason=${reason} target=${target.x},${target.y},${target.z} attempts=${attempts}`
}

/** `RETRIEVE_ROUTE_BLOCKED reason=<reason> target=x,y,z stand=x,y,z`. */
export function formatRetrieveRouteBlocked(reason: string, target: Vec3Json, stand: Vec3Json): string {
  return (
    `RETRIEVE_ROUTE_BLOCKED reason=${reason} target=${target.x},${target.y},${target.z} ` +
    `stand=${Math.floor(stand.x)},${Math.floor(stand.y)},${Math.floor(stand.z)}`
  )
}

/** `DESCEND_RETIRED reason=<reason> stand=x,y,z routes=<n>`. */
export function formatDescendRetired(reason: string, stand: Vec3Json, routes: number): string {
  return (
    `DESCEND_RETIRED reason=${reason} stand=${Math.floor(stand.x)},${Math.floor(stand.y)},${Math.floor(stand.z)} ` +
    `routes=${routes}`
  )
}

/** `APPROACH_LEG reason=<reason> target=x,y,z` - a travel leg toward an unobservable target. */
export function formatApproachLeg(reason: string, target: Vec3Json): string {
  return `APPROACH_LEG reason=${reason} target=${target.x},${target.y},${target.z}`
}

/** `ROUTE_STAGE_FAILED kind=<K> target=x,y,z stand=x,y,z stage=path|move failure=<code>`. */
export function formatRouteStageFailed(input: {
  kind: string
  target: Vec3Json
  stand: Vec3Json
  stage: string
  failure: string | null
}): string {
  const target = `${Math.floor(input.target.x)},${Math.floor(input.target.y)},${Math.floor(input.target.z)}`
  const stand = `${Math.floor(input.stand.x)},${Math.floor(input.stand.y)},${Math.floor(input.stand.z)}`
  return (
    `ROUTE_STAGE_FAILED kind=${input.kind} target=${target} stand=${stand} ` +
    `stage=${input.stage} failure=${input.failure ?? 'unknown'}`
  )
}

/** `ROUTE_SPENT kind=<K> target=x,y,z attempts=n` - the exact route is now withheld. */
export function formatRouteSpent(kind: string, target: Vec3Json, attempts: number): string {
  const cell = `${Math.floor(target.x)},${Math.floor(target.y)},${Math.floor(target.z)}`
  return `ROUTE_SPENT kind=${kind} target=${cell} attempts=${attempts}`
}

/** `ROUTE_ESCALATE goal=<goal> reason=<reason> routes=n` - every grounded route is spent. */
export function formatRouteEscalate(goal: string, reason: string, routes: number): string {
  return `ROUTE_ESCALATE goal=${goal} reason=${reason} routes=${routes}`
}
