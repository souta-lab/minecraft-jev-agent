// planner.ts - production System2 WHAT authority.
//
// System2 owns semantic intent. It receives the current mission, queue,
// inventory, live world facts and typed execution evidence, then returns a
// grounded goal patch. Code validates and lowers those goals; Jev chooses
// grounded local Skills; deterministic planning is available only as an
// explicitly selected baseline.

export * from './planner-legacy.ts'

import type { Bot } from 'mineflayer'
import type { System2Brain, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { FatalModelError, failLoud } from '../jev-agent/src/modelFailure.ts'
import type { KnownStation, ResidentWorldMemory } from './resident-types.ts'
import type { MercurySystem2, MercuryTriggerReason } from './mercury-system2.ts'
import { bodyStarving, formatBodyStarvingFact } from '../jev-agent/src/state.ts'
import { PlannerBrain as LegacyPlannerBrain } from './planner-legacy.ts'
import type { PlannerOptions as LegacyPlannerOptions } from './planner-legacy.ts'

export type PlannerMode = 'llm' | 'deterministic' | 'local-mercury'

type ModelPlannerOptions = Omit<LegacyPlannerOptions, 'mode'> & {
  mode?: PlannerMode
  generationId?: string | null
  sourceSha?: string | null
  buildHash?: string | null
  /** During same-authority outage recovery, force a fresh provider consultation. */
  requireFreshProviderDecision?: boolean
}

/** Position-free, code-owned hunger truth for compact System2 state. */
export function starvationFact(bot: Pick<Bot, 'food' | 'health'>): string | null {
  const { food, health } = bot
  if (typeof food !== 'number' || typeof health !== 'number') return null
  const self = { food, health }
  return bodyStarving(self) ? formatBodyStarvingFact(self) : null
}

/** Model authority is the resident default; deterministic planning is explicit baseline only. */
export function resolvePlannerMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlannerMode {
  const raw = (env.BUDDY_PLANNER ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'auto' || raw === 'llm' || raw === 'jev' || raw === 'on' || raw === 'model') return 'llm'
  if (raw === 'deterministic' || raw === 'off' || raw === 'fallback' || raw === 'none') return 'deterministic'
  if (raw === 'local-mercury' || raw === 'local_mercury' || raw === 'local') return 'local-mercury'
  throw new Error(`invalid BUDDY_PLANNER=${JSON.stringify(env.BUDDY_PLANNER)}; expected llm|auto|deterministic|off|local-mercury`)
}

/**
 * System2 grounding uses current server truth for nearby stations. This only
 * augments CAN/TRUE facts; it does not choose, rank or synthesize a semantic goal.
 */
function liveStationFacts(bot: Bot, names: ReadonlySet<string>, maxDistance: number, count: number): KnownStation[] {
  try {
    return bot.findBlocks({ matching: (block) => names.has(block.name), maxDistance, count })
      .map((position) => ({ x: position.x, y: position.y, z: position.z }))
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

/** The reason is a typed wake cause, not a semantic strategy. */
export function mercuryTriggerFor(request: System2PlanRequest, mercury?: MercurySystem2): MercuryTriggerReason {
  if (mercury?.postDeathRecoveryPending === true) return 'post_death'

  let waitStreak = 0
  for (let i = request.recentOutcomes.length - 1; i >= 0; i -= 1) {
    const outcome = request.recentOutcomes[i]
    if (outcome === undefined || outcome.actionId !== 'WAIT') break
    waitStreak += 1
  }
  if (String(request.reason) === 'queue_empty') return 'no_candidate'
  if (waitStreak >= 3) return 'wait_limit'
  if (request.reason === 'action_impossible') return 'action_impossible'
  return 'no_progress'
}

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
 * Production semantic authority. No rung list or pre-ranked menu is presented
 * to a model: System2 receives the current request and its factual projection,
 * then its returned intent is validated by Mercury's capability compiler.
 */
export class PlannerBrain implements System2Brain {
  readonly mode: PlannerMode
  readonly model: string

  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  private readonly maxAttempts: number
  private readonly terminate: (() => never) | undefined
  private readonly refreshLiveFacts: (() => void) | undefined
  private readonly legacy: LegacyPlannerBrain | null
  private readonly mercury: MercurySystem2 | undefined
  private readonly generationId: string | null
  private readonly sourceSha: string | null
  private readonly buildHash: string | null
  private readonly requireFreshProviderDecision: boolean
  private lastAuthorityProvider: string
  private lastAuthorityModel: string

  constructor(options: ModelPlannerOptions) {
    this.mode = options.mode ?? resolvePlannerMode()
    this.generationId = options.generationId ?? null
    this.sourceSha = options.sourceSha ?? null
    this.buildHash = options.buildHash ?? null
    this.requireFreshProviderDecision = options.requireFreshProviderDecision === true
    this.log = (event, detail) => options.log(event, {
      ...detail,
      generationId: this.generationId,
      sourceSha: this.sourceSha,
      buildHash: this.buildHash,
    })
    this.maxAttempts = options.maxAttempts ?? Number(process.env.BUDDY_PLANNER_MAX_ATTEMPTS ?? 5)
    this.terminate = options.terminate
    this.refreshLiveFacts = options.refreshLiveFacts
    this.mercury = options.mercury
    this.model = this.mercury?.model ?? options.model ?? 'unavailable'
    if (this.mode === 'local-mercury' && this.mercury === undefined) {
      throw new Error('BUDDY_PLANNER=local-mercury requires Mercury (set BUDDY_SYSTEM2=mercury)')
    }
    this.lastAuthorityProvider = this.mode === 'deterministic' ? 'deterministic' : 'none'
    this.lastAuthorityModel = this.mode === 'deterministic' ? this.model : 'none'

    // Do not even construct the compatibility planner in model mode: its cache
    // fingerprint and plan machinery inspect the ordered capability ladder.
    // That code belongs only to the explicit deterministic baseline.
    this.legacy =
      this.mode === 'deterministic'
        ? new LegacyPlannerBrain({
            ...options,
            mode: 'deterministic',
            advisor: undefined,
            mercury: undefined,
            postDeathRecovery: false,
          })
        : null
  }

  get provider(): string {
    return this.lastAuthorityProvider
  }

  get authorityModel(): string {
    return this.lastAuthorityModel
  }

  get authorityStack(): { provider: string; model: string } {
    if (this.mode === 'deterministic') return { provider: 'deterministic', model: this.model }
    if (this.mercury === undefined) return { provider: 'system2-unavailable', model: 'none' }
    if (this.mode === 'local-mercury') {
      return { provider: 'local-mercury', model: `mercury:${this.mercury.model}` }
    }
    return { provider: this.mercury.provider, model: this.mercury.model }
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    this.refreshLiveFacts?.()
    if (this.mode === 'deterministic') {
      if (this.legacy === null) return this.fatal('deterministic-planner-unavailable', 'explicit baseline planner was not constructed')
      return this.legacy.plan(request)
    }
    return this.planWithModelAuthority(request)
  }

  private async planWithModelAuthority(request: System2PlanRequest): Promise<System2Plan> {
    const trigger = mercuryTriggerFor(request, this.mercury)
    if (trigger === 'wait_limit' && this.mercury !== undefined && !this.requireFreshProviderDecision) {
      const gate = this.mercury.evaluateWaitLimitTrigger({
        request,
        stallKey: waitLimitStallKey(request),
        authorityEpoch: request.requestContext?.authorityEpoch ?? null,
      })
      if (!gate.allow) {
        const configured = this.authorityStack
        this.log('SYSTEM2_WAIT_LIMIT_HELD', {
          provider: this.mercury.provider,
          model: this.mercury.model,
          configuredProvider: configured.provider,
          configuredModel: configured.model,
          reason: gate.reason,
          currentOption: request.goalQueueState.current?.semanticOptionInstanceId ?? request.goalQueueState.current?.id ?? null,
        })
        return {
          op: 'continue',
          goals: [],
          note: `System2 wait-limit consultation deferred: ${gate.reason}`,
          provenance: { intentSource: 'none', noGoalsReason: 'system2_wait_limit_backoff' },
        }
      }
    } else if (trigger === 'wait_limit' && this.requireFreshProviderDecision) {
      // Recovery must not inherit a stale wait-limit cooldown: a fresh decision
      // from the pinned provider/model is the condition for restoring authority.
      // Mercury separately bypasses its cached plan under the same host flag.
      this.log('SYSTEM2_WAIT_LIMIT_BYPASSED', {
        provider: this.authorityStack.provider,
        model: this.authorityStack.model,
        reason: 'same-authority-provider-recovery-requires-fresh-response',
      })
    }
    return this.planWithMercuryAuthority(request, trigger)
  }

  private async planWithMercuryAuthority(
    request: System2PlanRequest,
    trigger: MercuryTriggerReason,
  ): Promise<System2Plan> {
    if (this.mercury === undefined) return this.fatal('system2-unavailable', `no System2 provider configured for trigger=${trigger}`)
    this.lastAuthorityProvider = this.mode === 'local-mercury' ? 'local-mercury' : this.mercury.provider
    this.lastAuthorityModel = this.mercury.model
    const configured = this.authorityStack
    this.log('SYSTEM2_AUTHORITY_INPUT', {
      provider: this.provider,
      model: this.authorityModel,
      configuredProvider: configured.provider,
      configuredModel: configured.model,
      source: this.provider,
      trigger,
      reason: request.reason,
    })
    const repair = await this.mercury.tryRepair(request, trigger)
    if (repair === null) {
      // Fail closed on provider/transport/budget errors. A stale generation has
      // no authority over its replacement and is discarded without a semantic
      // fallback.
      if (!this.mercury.generationCurrent) {
        this.log('SYSTEM2_STALE_DISCARD', {
          provider: this.provider,
          model: this.authorityModel,
          configuredProvider: configured.provider,
          configuredModel: configured.model,
          trigger,
          reason: request.reason,
        })
        return {
          op: 'continue',
          goals: [],
          note: `stale System2 result discarded (${trigger})`,
          provenance: { intentSource: 'none', noGoalsReason: 'stale_generation_discarded' },
        }
      }
      return this.fatal('system2-unavailable', `no System2 repair for trigger=${trigger}`)
    }
    this.log('SYSTEM2_AUTHORITY_DECISION', {
      provider: this.provider,
      model: this.authorityModel,
      configuredProvider: configured.provider,
      configuredModel: configured.model,
      source: this.provider,
      trigger,
      op: repair.op,
      strategy: repair.strategy,
      goals: repair.goals.map((goal) => goal.description),
    })
    return repair.plan
  }

  private fatal(context: string, reason: string): never {
    return failLoud(new FatalModelError(context, this.maxAttempts, reason), this.log, this.terminate)
  }
}
