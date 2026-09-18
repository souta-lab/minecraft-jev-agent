// option-brain.ts - opt-in adapter that compiles PlannerBrain goals into
// grounded Options before they are applied to the GoalQueue (#21).
//
// The GoalQueue remains the EXECUTION LEDGER: this wrapper only transforms the
// planned goal list on its way in. It is a transparent pass-through unless
// `BUDDY_OPTION_COMPILER` is enabled, so the current behavior (and the
// `llm.called == false` deterministic guarantee) is unchanged by default.
import type { Bot } from 'mineflayer'
import { applyCompiledPlan, emitBlockedOptionLogs, resolveOptionCompilerEnabled, snapshotFromResident, stableOptionInstanceId } from '../jev-agent/src/optionSpec.ts'
import type { OptionSpec, OptionSpecSource, OptionWorldSnapshot } from '../jev-agent/src/optionSpec.ts'
import type { System2Brain, System2Plan, System2PlanRequest } from '../jev-agent/src/system2.ts'
import { bestPickaxeRank, inventoryCounts } from './planner.ts'
import type { ResidentWorldMemory } from './resident-types.ts'

export interface OptionBrainOptions {
  /** structured host log (`ctx.log`) */
  log: (event: string, detail?: Record<string, unknown>) => void
  /** live snapshot factory, read once per plan call (never cached across calls) */
  snapshot: () => OptionWorldSnapshot
  /** override the env flag (tests / explicit wiring) */
  enabled?: boolean
  /** cap on dependency recursion (tests); defaults to MAX_DEPENDENCY_DEPTH */
  maxDepth?: number
}

/**
 * Wrap a `System2Brain` so its bounded goal list is compiled into Options with
 * dependency expansion. Disabled by default: `plan()` then delegates verbatim.
 */
export class OptionCompilingSystem2 implements System2Brain, OptionSpecSource {
  private readonly inner: System2Brain
  private readonly log: (event: string, detail?: Record<string, unknown>) => void
  private readonly snapshot: () => OptionWorldSnapshot
  private readonly maxDepth: number | undefined
  readonly enabled: boolean
  /** #56: the compiled Options of the most recent plan (empty while disabled). */
  private lastSpecs: readonly OptionSpec[] = []

  constructor(inner: System2Brain, options: OptionBrainOptions) {
    this.inner = inner
    this.log = options.log
    this.snapshot = options.snapshot
    this.enabled = options.enabled ?? resolveOptionCompilerEnabled()
    this.maxDepth = options.maxDepth
  }

  get model(): string {
    return this.inner.model
  }

  /**
   * #56: the controller reads this right after `plan()` to hold the exact
   * compiled Option identity/semantics for the GoalQueue head. The queue rows
   * carry `optionInstanceId`, so the join is by data, not by re-derivation.
   */
  compiledOptionSpecs(): readonly OptionSpec[] {
    return this.lastSpecs
  }

  async plan(request: System2PlanRequest): Promise<System2Plan> {
    const plan = await this.inner.plan(request)
    if (!this.enabled || plan.goals.length === 0) {
      this.lastSpecs = []
      return plan
    }
    const result = applyCompiledPlan(plan.goals, this.snapshot(), {
      enabled: true,
      maxDepth: this.maxDepth,
      onDedupe: (record) => this.log('OPTION_DEDUPED', { id: record.id, instances: record.instances }),
    })
    this.lastSpecs = result.specs
    this.log('OPTION_COMPILE', {
      enabled: true,
      planned: plan.goals.map((goal) => goal.description),
      compiled: result.goals.map((goal) => goal.description),
      specs: result.specs.map((spec) => spec.id),
      instanceIds: result.specs.map((spec) => stableOptionInstanceId(spec)),
      added: result.added,
      blocked: result.blocked,
      blockedOptions: result.blockedOptions,
      rejected: result.rejected,
      deduped: result.deduped,
    })
    emitBlockedOptionLogs(result.blockedOptions, this.log)
    if (result.rejected.length > 0) {
      this.log('OPTION_COMPILE_REJECTED', { rejected: result.rejected })
    }
    return { ...plan, goals: result.goals }
  }
}

/** Build an Option snapshot from the live bot + the generation's world memory. */
export function optionSnapshotFromBot(bot: Bot, world: ResidentWorldMemory, dimension: string | null): OptionWorldSnapshot {
  const counts = inventoryCounts(bot)
  const position = bot.entity === undefined ? null : { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }
  return snapshotFromResident({
    inventory: counts,
    dimension,
    position,
    health: bot.health ?? null,
    toolRank: bestPickaxeRank(counts),
    craftingTables: world.craftingTables,
    furnaces: world.furnaces,
    discoveredOres: world.discoveredOres,
  })
}
