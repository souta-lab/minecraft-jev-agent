// planner.ts - MODEL-AUTHORITATIVE System 2 kernel.
//
// The previous resident planner accumulated two different responsibilities in
// one 100kB file: (1) deterministic capability/recipe mechanics and (2) semantic
// plan authority.  Keep (1) as a compatibility library in planner-legacy.ts,
// but do not execute its semantic plan() path in live/model mode.
//
// Authority contract:
//   System2 model = WHAT high-level grounded plan comes next
//   Jev           = WHICH grounded local action / WHETHER option ends
//   Code          = CAN / TRUE / SAFE / DONE + execution + verification
//
// Deterministic planning still exists, but ONLY as an explicit offline/baseline
// mode. Credentials never choose authority. Model errors fail loudly; code never
// answers them with a deterministic semantic choice.

export * from './planner-legacy.ts'

import { experimental_evaluate as evaluate } from 'ai'
import type { Experimental_EvaluationQuestion } from 'ai'
import type { Bot } from 'mineflayer'
import type { System2Brain, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { DEFAULT_JEV_MODEL, resolveJevApiKey } from '../jev-agent/src/jev.ts'
import type { KeyResolution } from '../jev-agent/src/jev.ts'
import { FatalModelError, describeFailure, failLoud, withModelRetries } from '../jev-agent/src/modelFailure.ts'
import { parseCapabilityGap } from '../jev-agent/src/replanThrottle.ts'
import type { KnownStation, ResidentWorldMemory } from './resident-types.ts'
import type { MercurySystem2, MercuryTriggerReason } from './mercury-system2.ts'
import { bodyStarving, countSensedPortalFrameBlocks, formatBodyStarvingFact } from '../jev-agent/src/state.ts'
import { defaultCandidateOptions } from '../jev-agent/src/candidates.ts'
import {
  PlannerBrain as LegacyPlannerBrain,
  buildPlanOptions,
  buildUpperAccessRecoveryOption,
  inventoryCounts,
  resolveRungSourceOfTruth,
  upperAccessRecoveryApplies,
} from './planner-legacy.ts'
import type { PlanOption, PlannerOptions as LegacyPlannerOptions } from './planner-legacy.ts'

export type PlannerMode = 'llm' | 'deterministic' | 'local-mercury'

type ModelPlannerOptions = Omit<LegacyPlannerOptions, 'mode'> & { mode?: PlannerMode }

/**
 * Model authority is the resident default. Deterministic planning is an
 * explicit baseline/offline selection only. A typo is configuration corruption,
 * not permission to silently seize semantic authority.
 */
export function resolvePlannerMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlannerMode {
  const raw = (env.BUDDY_PLANNER ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'auto' || raw === 'llm' || raw === 'jev' || raw === 'on' || raw === 'model') return 'llm'
  if (raw === 'deterministic' || raw === 'off' || raw === 'fallback' || raw === 'none') return 'deterministic'
  if (raw === 'local-mercury' || raw === 'local_mercury' || raw === 'local') return 'local-mercury'
  throw new Error(`invalid BUDDY_PLANNER=${JSON.stringify(env.BUDDY_PLANNER)}; expected llm|auto|deterministic|off|local-mercury`)
}

/** Backoff between bounded model retries (see withModelRetries call below). */
const PLANNER_RETRY_BASE_MS = Number(process.env.BUDDY_PLANNER_RETRY_BASE_MS ?? 1000)
const PLANNER_RETRY_MAX_MS = Number(process.env.BUDDY_PLANNER_RETRY_MAX_MS ?? 15000)

const SYSTEM2_INSTRUCTIONS =
  'You are System 2 for an autonomous Minecraft agent. Choose exactly ONE grounded plan id from the supplied list: ' +
  'the high-level intent/Option sequence the agent should pursue next. Every listed plan was generated from executable ' +
  'capabilities and current deterministic world facts. Choose from the full current situation and long-horizon objective. ' +
  'Costs, failures, distance, readiness, and capability-gap facts are evidence, not fixed ranking rules. Do not invent an id.'

function readChoice(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const choice = (answer as Record<string, unknown>).choice
  return typeof choice === 'string' ? choice : null
}

function uniqueOptions(options: readonly PlanOption[]): PlanOption[] {
  const seen = new Set<string>()
  const out: PlanOption[] = []
  for (const option of options) {
    if (seen.has(option.id)) continue
    seen.add(option.id)
    out.push(option)
  }
  return out
}

/**
 * System2 grounding must use current server truth for nearby stations, not only
 * the durable station memory. A remembered station can be invalidated as stale
 * while the same live block is already loaded near the bot; using memory alone
 * then invents a false `crafting_table`/`furnace` prerequisite and changes the
 * semantic option set. This helper only augments CAN/TRUE facts; it does not
 * choose, rank, or synthesize a semantic goal.
 */
function liveStationFacts(bot: Bot, names: ReadonlySet<string>, maxDistance: number, count: number): KnownStation[] {
  try {
    const positions = bot.findBlocks({
      matching: (block) => names.has(block.name),
      maxDistance,
      count,
    })
    return positions.map((position) => ({ x: position.x, y: position.y, z: position.z }))
  } catch {
    return []
  }
}

export function augmentPlannerWorldWithLiveStations(bot: Bot, world: ResidentWorldMemory): ResidentWorldMemory {
  const tables = liveStationFacts(bot, new Set(['crafting_table']), 48, 64)
  const furnaces = liveStationFacts(bot, new Set(['furnace', 'blast_furnace', 'smoker']), 48, 32)
  const merge = (remembered: readonly KnownStation[], sensed: readonly KnownStation[]): KnownStation[] => {
    const out = [...remembered]
    const seen = new Set(out.map((station) => `${station.x},${station.y},${station.z}`))
    for (const station of sensed) {
      const key = `${station.x},${station.y},${station.z}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(station)
    }
    return out
  }
  return {
    ...world,
    craftingTables: merge(world.craftingTables, tables),
    furnaces: merge(world.furnaces, furnaces),
  }
}

/** The gateway System2 model is the sparse WHAT-NEXT repair path; Jev remains the normal grounded selector. */
/** At most one drained-queue semantic consultation per interval (budget guard). */
const EMPTY_QUEUE_CONSULT_INTERVAL_MS = 5 * 60_000

const MERCURY_INTENT_TTL_MS = 10 * 60_000
const MERCURY_INTENT_MAX_USES = 3

function mercuryTriggerFor(request: System2PlanRequest, mercury?: MercurySystem2): MercuryTriggerReason | null {
  // nekomario28 extension: a pending post-death recovery is itself a semantic
  // moment, so route it to Mercury without waiting for a WAIT streak. This is
  // checked before the drained-queue/stall branches so death never loses to them.
  if (mercury?.postDeathRecoveryPending === true) return 'post_death'

  let waitStreak = 0
  for (let i = request.recentOutcomes.length - 1; i >= 0; i -= 1) {
    const outcome = request.recentOutcomes[i]
    if (outcome === undefined || outcome.actionId !== 'WAIT') break
    waitStreak += 1
  }
  // A drained queue is the more informative moment: it must not be shadowed by the
  // WAIT-streak branch, whose counter-shaped trigger is then silenced by the durable
  // stall gate (measured live #359: reason=queue_empty arrived, waitStreak >= 3 turned
  // it into wait_limit, the gate suppressed it, and the ladder menu answered instead).
  // `System2PlanRequest.reason` is typed as the stall reasons only; the drained-queue
  // summon carries `queue_empty` at runtime (observed in the decision log), so compare
  // through a widened value instead of narrowing to a union that excludes it.
  if (String(request.reason) === 'queue_empty') return 'no_candidate'
  if (waitStreak >= 3) return 'wait_limit'
  // A drained queue is exactly the moment the next WHAT is decided. Without this
  // the summon was answered only from the ladder's fixed rung menu, so goals the
  // menu cannot express ("find obsidian where lava meets water", "stock food
  // before the Nether", "build the return portal") were never proposed, and the
  // frontier flapped between menu entries (live #359). Asking the semantic layer
  // here opens the WHAT space; the durable stall gate below keeps the rate bounded.
  if (request.reason === 'queue_empty') return 'no_candidate'
  if (request.reason === 'action_impossible') return 'action_impossible'
  if (request.reason === 'no_progress' || request.reason === 'need_llm' || request.reason === 'unknown_situation') {
    return 'no_progress'
  }
  return null
}

/**
 * Stable identity of the stalled semantic Option/objective, NOT the WAIT counter
 * that keeps incrementing. The durable `wait_limit` backoff is keyed on this, so
 * a genuine Option change (or progress, via the request authority epoch) re-arms
 * immediately while the same stall cannot re-ask once per WAIT.
 */
function waitLimitStallKey(request: System2PlanRequest): string {
  const current = request.goalQueueState.current
  const identity =
    current?.semanticOptionInstanceId ??
    current?.optionInstanceId ??
    current?.semanticOptionTemplateId ??
    current?.optionTemplateId ??
    current?.id ??
    current?.description ??
    `${request.objective.targetItem}:${request.objective.requiredCount}`
  return `${identity}|objective:${request.objective.targetItem}:${request.objective.requiredCount}`
}

/**
 * The code-owned starvation fact, as the ONE typed line the Jev side also
 * emits (`formatBodyStarving`). Null for a fed body, so nothing changes when the
 * body is healthy. The measured live failure (run-muc0l5fp-158ak) was a body
 * pinned at the server's 1 HP starvation floor: the deterministic candidate
 * layer restricted its own offer, but the OPTION layer (this planner/System2
 * request) only carried the raw numbers `health: 1, food: 0`, so nothing in the
 * plan surface said "this body is taking starvation damage and needs a route
 * that ends it". This is a typed fact, not a ranking: it never reorders or
 * removes an Option.
 */
export function starvationFact(bot: Pick<Bot, 'food' | 'health'>): string | null {
  const food = bot.food
  const health = bot.health
  if (typeof food !== 'number' || typeof health !== 'number') return null
  if (!bodyStarving({ food, health })) return null
  return formatBodyStarvingFact({ food, health })
}

function compactPlan(option: PlanOption): Record<string, unknown> {
  return {
    id: option.id,
    title: option.title,
    strategy: option.strategy ?? null,
    goals: option.goals.map((goal) => ({
      kind: goal.kind,
      description: goal.description,
      targetItem: goal.targetItem ?? null,
      requiredCount: goal.requiredCount ?? 1,
      targetY: goal.targetY ?? null,
      dimension: goal.dimension ?? null,
      core: goal.core === true,
    })),
  }
}

function compactSystem2State(
  bot: Bot,
  world: ResidentWorldMemory,
  request: System2PlanRequest,
  counts: Record<string, number>,
  options: readonly PlanOption[],
): Record<string, unknown> {
  const inventory: Record<string, number> = {}
  for (const [name, count] of Object.entries(counts)) if (count > 0) inventory[name] = count
  const starvation = starvationFact(bot)
  return {
    reason: request.reason,
    detail: request.detail,
    tick: request.tick,
    objective: request.objective,
    goalQueue: request.goalQueueState,
    self: {
      position: bot.entity === undefined ? null : {
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z,
      },
      dimension: bot.game?.dimension ?? null,
      health: bot.health ?? null,
      food: bot.food ?? null,
    },
    inventory,
    world: {
      craftingTables: world.craftingTables.length,
      furnaces: world.furnaces.length,
      discoveredOres: [...world.discoveredOres].sort(),
    },
    recentEvents: request.recentEvents.slice(-24),
    recentOutcomes: request.recentOutcomes.slice(-16),
    groundedPlans: options.map(compactPlan),
    // Typed survival fact, present only while the body is actually starving at
    // the critical-health floor. The model already sees the raw `health`/`food`
    // numbers; this names the STATE so a plan can prefer a route that ends it.
    ...(starvation === null ? {} : { survival: starvation }),
  }
}

/**
 * Public PlannerBrain is now a strangler facade. The old planner is instantiated
 * only for explicit deterministic mode; llm mode never calls legacy.plan().
 */
export class PlannerBrain implements System2Brain {
  readonly mode: PlannerMode
  readonly model: string

  private readonly bot: Bot
  private readonly world: ResidentWorldMemory
  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly maxCalls: number
  private readonly resolveKey: () => KeyResolution | null
  private readonly terminate: (() => never) | undefined
  private readonly refreshLiveFacts: (() => void) | undefined
  /** last semantic plan, continued across a drained queue (#359) */
  private lastMercuryPlan: System2Plan | null = null
  private lastMercuryPlanAtMs = 0
  private lastMercuryPlanUses = 0
  /**
   * The semantic layer's last natural-language WHAT that could not be grounded.
   * Carried into the typed choice over grounded options so the model's own words
   * still steer the structured decision; bounded by MERCURY_INTENT_TTL_MS.
   */
  private lastMercuryIntent: string | null = null
  private lastMercuryIntentAtMs = 0
  /** last drained-queue semantic consultation (EMPTY_QUEUE_CONSULT_INTERVAL_MS) */
  private lastEmptyQueueConsultAtMs = 0
  /** dedupe for the SYSTEM2_PLAN_REQUEST_REASON diagnosis (#359) */
  private lastLoggedPlanReason: string | null = null
  private readonly legacy: LegacyPlannerBrain
  private readonly mercury: MercurySystem2 | undefined
  private lastAuthorityProvider: string
  private lastAuthorityModel: string
  private calls = 0

  constructor(options: ModelPlannerOptions) {
    this.mode = options.mode ?? resolvePlannerMode()
    this.bot = options.bot
    this.world = options.world
    this.log = options.log
    this.timeoutMs = options.timeoutMs ?? Number(process.env.BUDDY_PLANNER_TIMEOUT_MS ?? 9000)
    this.maxAttempts = options.maxAttempts ?? Number(process.env.BUDDY_PLANNER_MAX_ATTEMPTS ?? 5)
    this.maxCalls = options.maxCalls ?? Number(process.env.BUDDY_PLANNER_MAX_CALLS ?? 200)
    this.resolveKey = options.resolveKey ?? resolveJevApiKey
    this.terminate = options.terminate
    this.refreshLiveFacts = options.refreshLiveFacts
    // The normal planner authority uses experimental_evaluate and therefore
    // keeps the evaluation-capable Jev default. Language-generation System2 is
    // owned by MercurySystem2; local-mercury intentionally reports that model.

    this.mercury = options.mercury
    const configuredPlannerModel = options.model ?? process.env.BUDDY_PLANNER_MODEL ?? process.env.AI_GATEWAY_MODEL ?? DEFAULT_JEV_MODEL
    this.model = this.mode === 'local-mercury' && this.mercury !== undefined ? this.mercury.model : configuredPlannerModel
    if (this.mode === 'local-mercury' && this.mercury === undefined) {
      throw new Error('BUDDY_PLANNER=local-mercury requires Mercury (set BUDDY_SYSTEM2=mercury)')
    }
    this.lastAuthorityProvider = this.mode === 'deterministic' ? 'deterministic' : 'none'
    this.lastAuthorityModel = this.mode === 'deterministic' ? this.model : 'none'

    // Baseline is intentionally hermetic: no Advisor/Mercury/model exception path
    // may run when the owner explicitly selected deterministic mode.
    this.legacy = new LegacyPlannerBrain({
      ...options,
      mode: 'deterministic',
      advisor: undefined,
      mercury: undefined,
      postDeathRecovery: false,
    })
  }

  /** Provider and model that actually own the current System2 semantic choice. */
  get provider(): string {
    return this.lastAuthorityProvider
  }

  get authorityModel(): string {
    return this.lastAuthorityModel
  }

  get authorityStack(): { provider: string; model: string } {
    if (this.mode === 'deterministic') return { provider: 'deterministic', model: this.model }
    if (this.mode === 'local-mercury') {
      return { provider: 'local-mercury', model: `deterministic|mercury:${this.mercury!.model}` }
    }
    if (this.mercury === undefined) return { provider: 'typesafe-ai', model: this.model }
    return { provider: 'hybrid', model: `typesafe-ai:${this.model}|${this.mercury.provider}:${this.mercury.model}` }
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    this.refreshLiveFacts?.()
    if (this.mode === 'deterministic') return this.legacy.plan(request)
    if (this.mode === 'local-mercury') return this.planWithLocalMercury(request)
    return this.planWithModelAuthority(request)
  }

  private groundedOptions(request: System2PlanRequest): PlanOption[] {
    const counts = inventoryCounts(this.bot)
    const planningWorld = augmentPlannerWorldWithLiveStations(this.bot, this.world)
    const rung = resolveRungSourceOfTruth(counts, planningWorld, this.log)
    const portalFrameBlocks = this.bot.entity === undefined ? 0 : countSensedPortalFrameBlocks(this.bot)
    this.log('PORTAL_FRAME_PROGRESS', { blocks: portalFrameBlocks, source: 'system2-grounding' })
    const options = buildPlanOptions(counts, planningWorld, {
      placedFurnacesNear: this.placedFurnacesNear(),
      knownFurnaces: planningWorld.furnaces.length,
      resumeRungIndex: rung.adoptedRungIndex,
      portalFrameBlocks,
      // Hunger is live server truth the rung predicates cannot see; pass it so
      // the survival `food` option is offered only when it is actually needed.
      foodLevel: this.bot.food ?? null,
      eatBelowFood: defaultCandidateOptions.eatBelowFood,
      botY: this.bot.entity === undefined ? null : this.bot.entity.position.y,
      log: this.log,
    })

    // A capability-gap recovery is an OPTION, never an automatic decision.
    const y = this.bot.entity?.position.y ?? null
    const gap = parseCapabilityGap(request.recentEvents)
    if (y !== null && (gap !== null || upperAccessRecoveryApplies(this.world, y))) {
      options.push(buildUpperAccessRecoveryOption(this.world, y))
    }
    // Typed survival fact on the ONE Option whose route can end starvation. This
    // names the state (and the reason that Option is the survivable one) for the
    // model; it never adds, removes, reorders or pre-selects an Option, so the
    // semantic WHAT stays with System2.
    const starvation = starvationFact(this.bot)
    if (starvation !== null) {
      const food = options.find((option) => option.id === 'food')
      if (food !== undefined && !food.title.includes(starvation)) {
        food.title = `${food.title} [${starvation}]`
      }
    }
    return uniqueOptions(options)
  }

  private async planWithLocalMercury(request: System2PlanRequest): Promise<System2Plan> {
    const mercuryTrigger = mercuryTriggerFor(request, this.mercury)
    if (mercuryTrigger !== null) return this.planWithMercuryAuthority(request, mercuryTrigger)

    this.lastAuthorityProvider = 'deterministic'
    this.lastAuthorityModel = 'deterministic-ladder'
    this.log('SYSTEM2_AUTHORITY_INPUT', {
      provider: this.provider,
      model: this.authorityModel,
      source: 'local-mercury-floor',
      reason: request.reason,
    })
    const plan = await this.legacy.plan(request)
    this.log('SYSTEM2_AUTHORITY_DECISION', {
      provider: this.provider,
      model: this.authorityModel,
      source: 'local-mercury-floor',
      reason: request.reason,
      op: plan.op,
      goals: plan.goals.map((goal) => goal.description),
    })
    return plan
  }

  private async planWithMercuryAuthority(
    request: System2PlanRequest,
    mercuryTrigger: MercuryTriggerReason,
  ): Promise<System2Plan> {
    if (this.mercury === undefined) return this.fatal('mercury-unavailable', `no Mercury configured for trigger=${mercuryTrigger}`)
    this.lastAuthorityProvider = this.mode === 'local-mercury' ? 'mercury' : this.mercury.provider
    this.lastAuthorityModel = this.mercury.model
    this.log('SYSTEM2_AUTHORITY_INPUT', {
      provider: this.provider,
      model: this.authorityModel,
      source: this.provider,
      trigger: mercuryTrigger,
      reason: request.reason,
    })
    const repair = await this.mercury.tryRepair(request, mercuryTrigger)
    if (repair === null) {
      // Fail loud. `tryRepair` returns null ONLY for provider/transport/budget/key
      // failure (5xx, timeout, missing key); a shape-invalid answer is the typed
      // `ungrounded` outcome handled inside MercurySystem2. Per the operator there is
      // no fallback: a drained queue must not be degraded into the deterministic option
      // path, and a provider outage is fail-loud. The one exception is a generation that
      // is no longer current, where the fork's lifecycle hardening discards the stale
      // result instead of terminating the replacement generation.
      if (!this.mercury.generationCurrent) {
        this.log('SYSTEM2_STALE_DISCARD', {
          provider: this.provider,
          model: this.authorityModel,
          trigger: mercuryTrigger,
          reason: request.reason,
        })
        return { op: 'continue', goals: [], note: `stale Mercury result discarded (${mercuryTrigger})` }
      }
      return this.fatal('mercury-unavailable', `no repair for trigger=${mercuryTrigger}`)
    }
    // #359: keep the semantic layer's intent so a drained queue continues the
    // thread instead of immediately re-drawing the ladder menu. Bounded by TTL
    // and reuse count so a stale plan cannot loop.
    this.lastMercuryPlan = repair.plan
    this.lastMercuryPlanAtMs = Date.now()
    this.lastMercuryPlanUses = 0
    this.log('SYSTEM2_AUTHORITY_DECISION', {
      provider: this.provider,
      model: this.authorityModel,
      source: this.provider,
      trigger: mercuryTrigger,
      op: repair.op,
      strategy: repair.strategy,
      goals: repair.goals.map((goal) => goal.description),
    })
    return repair.plan
  }

  private async planWithModelAuthority(request: System2PlanRequest): Promise<System2Plan> {
    // One-line diagnosis for #359: the decision line reports `reason=queue_empty`,
    // but the request's own field is what the trigger reads (and `trigger=no_candidate`
    // never fired), so record the value actually carried here. Deduped by value to
    // keep the log readable.
    const reasonValue = String((request as { reason?: unknown }).reason ?? 'undefined')
    if (this.lastLoggedPlanReason !== reasonValue) {
      this.lastLoggedPlanReason = reasonValue
      this.log('SYSTEM2_PLAN_REQUEST_REASON', { reason: reasonValue })
    }
    let mercuryTrigger = mercuryTriggerFor(request, this.mercury)
    if (this.mercury !== undefined && mercuryTrigger === 'no_candidate') {
      // A drained queue is a fresh planning moment, not a repeated stall. Keying it
      // on the wait-limit stall identity silenced it entirely: the same-stall rule
      // read every empty queue as one stall, so the semantic layer was asked once
      // and then muted while the ladder menu refilled the queue (measured live
      // #359: reason=queue_empty present, trigger=no_candidate never consulted).
      // Bound it by a plain interval instead, chosen to stay far under the hourly
      // semantic budget.
      const now = Date.now()
      if (now - this.lastEmptyQueueConsultAtMs < EMPTY_QUEUE_CONSULT_INTERVAL_MS) {
        mercuryTrigger = null
      } else {
        this.lastEmptyQueueConsultAtMs = now
      }
    }
    if (this.mercury !== undefined && mercuryTrigger === 'wait_limit') {
      const gate = this.mercury.evaluateWaitLimitTrigger({
        request,
        stallKey: waitLimitStallKey(request),
        authorityEpoch: request.requestContext?.authorityEpoch ?? null,
      })
      if (!gate.allow) mercuryTrigger = null
    }
    if (this.mercury !== undefined && mercuryTrigger !== null) {
      // One call path for both the gateway (llm) and local-endpoint Mercury
      // transports; the transport is an endpoint/config decision inside
      // MercurySystem2, not a second fork of this authority path.
      return this.planWithMercuryAuthority(request, mercuryTrigger)
    }
    // #359: a drained queue right after a semantic proposal continues that proposal
    // (up to the TTL and reuse bound) rather than replacing the thread with a fresh
    // menu draw - the live M3 stall showed Mercury's `explore_cave` being executed and
    // then discarded, so exploration never accumulated into the mission road.
    if (
      request.reason === 'queue_empty' &&
      this.lastMercuryPlan !== null &&
      this.lastMercuryPlanUses < MERCURY_INTENT_MAX_USES &&
      Date.now() - this.lastMercuryPlanAtMs < MERCURY_INTENT_TTL_MS
    ) {
      this.lastMercuryPlanUses += 1
      this.log('MERCURY_INTENT_CONTINUED', {
        ageMs: Date.now() - this.lastMercuryPlanAtMs,
        uses: this.lastMercuryPlanUses,
        goals: this.lastMercuryPlan.goals.map((goal) => goal.description),
      })
      return this.lastMercuryPlan
    }
    this.lastAuthorityProvider = 'typesafe-ai'
    this.lastAuthorityModel = this.model
    const options = this.groundedOptions(request)
    if (options.length === 0) return this.fatal('planner-no-grounded-options', 'System2 has no grounded semantic options')
    if (this.calls >= this.maxCalls) return this.fatal('planner-budget', `model call budget exhausted (${this.maxCalls})`)

    const key = this.resolveKey()
    if (key === null) return this.fatal('planner-key', 'no gateway key resolved')
    process.env.AI_GATEWAY_API_KEY = key.key

    const counts = inventoryCounts(this.bot)
    const state = compactSystem2State(this.bot, this.world, request, counts, options) as Parameters<typeof evaluate>[0]["state"]
    const criteria: Record<string, string> = {}
    for (const option of options) criteria[option.id] = `${option.title} :: ${option.goals.map((goal) => goal.description).join(' -> ')}`
    // The semantic layer's ungrounded natural-language WHAT is fed into this typed
    // question over grounded options: state + intent -> which grounded goal/option.
    // Consumption is bounded by the same TTL as the continued-plan thread, so a
    // stale sentence cannot steer later decisions.
    const intentUseful =
      this.lastMercuryIntent !== null &&
      this.lastMercuryIntent.length > 0 &&
      Date.now() - this.lastMercuryIntentAtMs < MERCURY_INTENT_TTL_MS
    const semanticIntent = intentUseful ? this.lastMercuryIntent ?? '' : ''
    if (intentUseful) {
      this.lastMercuryIntent = null
      this.lastMercuryIntentAtMs = 0
      this.log('MERCURY_INTENT_MAPPING', {
        provider: this.provider,
        model: this.authorityModel,
        reason: request.reason,
        optionIds: options.map((option) => option.id),
        intent: semanticIntent.slice(0, 240),
      })
    }
    const questions = {
      horizon: {
        type: 'choice',
        instructions:
          semanticIntent.length === 0
            ? SYSTEM2_INSTRUCTIONS
            : `${SYSTEM2_INSTRUCTIONS}\n\nThe semantic planner answered with this natural-language intent; choose the grounded option that best realises it:\n"${semanticIntent.slice(0, 400)}"`,
        criteria,
      },
    } satisfies Record<string, Experimental_EvaluationQuestion>

    this.log('SYSTEM2_AUTHORITY_INPUT', {
      provider: this.provider,
      model: this.authorityModel,
      reason: request.reason,
      // #359: record the trigger decision on this already-visible line. Newly invented
      // marker names are dropped by the log path's filter, so the drained-queue
      // question ("did mercuryTriggerFor map it, and did the guard suppress it?") could
      // not be answered from the logs at all.
      mercuryTrigger: String(mercuryTrigger ?? 'none'),
      optionIds: options.map((option) => option.id),
      capabilityGap: parseCapabilityGap(request.recentEvents),
    })

    try {
      const selected = await withModelRetries(
        'planner-authority',
        this.maxAttempts,
        async () => {
          const response = await evaluate({
            model: this.model,
            state,
            questions,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(this.timeoutMs),
          })
          const id = readChoice((response.answers as Record<string, unknown>).horizon)
          if (id === null) throw new Error('malformed System2 horizon choice')
          const option = options.find((entry) => entry.id === id)
          if (option === undefined) throw new Error(`System2 invented unknown plan id ${JSON.stringify(id)}`)
          return option
        },
        {
          onRetry: ({ attempt, nextAttempt, error }) => {
            this.log('SYSTEM2_AUTHORITY_RETRY', { attempt, nextAttempt, error: describeFailure(error) })
          },
          // #226 asks for bounded retries WITH backoff on retryable transport
          // errors. The Vercel AI Gateway returns bursts of
          // "GatewayInternalServerError: Service temporarily unavailable", and
          // immediate retries burned every attempt inside one burst and then
          // terminated the resident (observed 6x in 20 minutes, each time
          // disconnecting AI_Buddy). The bound and the fail-loud exit are
          // unchanged; only the spacing between attempts is.
          delayMs: (attempt) => Math.min(PLANNER_RETRY_BASE_MS * 2 ** (attempt - 1), PLANNER_RETRY_MAX_MS),
        },
      )
      this.calls += 1
      this.log('SYSTEM2_AUTHORITY_DECISION', {
        provider: this.provider,
        model: this.authorityModel,
        reason: request.reason,
        chosen: selected.id,
        goals: selected.goals.map((goal) => goal.description),
      })

      // Deliberately no readiness reorder, body-change substitution, ladder
      // fallback, advisor override, queue_empty override, or stall override.
      // Mechanical compilation/guards may reject a goal later; WHAT remains the
      // model's exact grounded choice.
      const semanticOptionTemplateId = selected.id
      const semanticOptionInstanceId = `system2:${selected.id}`
      return {
        op: 'replace',
        goals: selected.goals.map((goal) => ({
          ...goal,
          semanticOptionInstanceId,
          semanticOptionTemplateId,
          semanticOptionIntent: selected.title,
        })),
        note: `model-authoritative System2 chose ${selected.id}`,
      }
    } catch (error) {
      const fatal = error instanceof FatalModelError
        ? error
        : new FatalModelError('planner-authority', this.maxAttempts, describeFailure(error))
      return failLoud(fatal, this.log, this.terminate)
    }
  }

  private fatal(context: string, reason: string): never {
    return failLoud(new FatalModelError(context, this.maxAttempts, reason), this.log, this.terminate)
  }

  private placedFurnacesNear(): number {
    const ids: number[] = []
    for (const name of ['furnace', 'blast_furnace', 'smoker']) {
      const block = this.bot.registry.blocksByName[name]
      if (block !== undefined) ids.push(block.id)
    }
    if (ids.length === 0) return 0
    try {
      return this.bot.findBlocks({ matching: ids, maxDistance: 48, count: 8 }).length
    } catch {
      return 0
    }
  }
}
