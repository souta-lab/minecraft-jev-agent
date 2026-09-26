import pathfinderModule from 'mineflayer-pathfinder'
import type { Bot } from 'mineflayer'
import type { Candidate, ReachabilityGateOptions } from '../candidates.ts'
import { guardCandidate } from '../policy.ts'
import type { GuardResult } from '../policy.ts'
import { isDimensionTransferBlock } from '../netherPortalPlan.ts'
import type { CurrentAction, ExecutionResult, Executor } from '../executor.ts'
import type { ContainerObservation } from '../containerAccess.ts'
import { createPositionFactCache } from '../positionFactCache.ts'
import type { StateFingerprintMemory } from '../moveFailMemory.ts'
import { buildWorldState } from '../state.ts'
import type { SensorInput, SensorOptions, Vec3Json, WorldState } from '../state.ts'
import { selectReachMechanicalWaypoint } from '../reach/mechanical-waypoint.ts'
import type {
  ReachActuationRequest,
  ReachActuationResult,
  ReachRuntimeActionSnapshot,
  ReachRuntimePorts,
} from '../reach/ports.ts'

const { goals } = pathfinderModule

/** Bounded synchronous path query used by the existing Reach affordance gate. */
const REACH_PATH_PROBE_TIMEOUT_MS = 750
const REACH_PATH_SEGMENT_TIMEOUT_MS = 750

/**
 * Narrow Mineflayer compatibility adapter for the first production Reach slice.
 * Raw Bot and Executor references terminate here; callers exchange typed sensor,
 * reachability, action-lease, and Transition-intent values only. VTR remains
 * backend independent and owns the active Reach contract/step reservations.
 *
 * Delete this adapter when Reach observation, route sensing, Guard/VERIFY and
 * mechanical dispatch are provided by the canonical Minecraft Runtime Adapter
 * ports and fresh exact-source proof records typed outcomes, identity/lease
 * fencing, deterministic predicate completion, and no-double-authority.
 */
export class MineflayerReachRuntimeAdapter implements ReachRuntimePorts {
  private reachabilityTick: number | null = null
  private reachability: ReachabilityGateOptions | null = null

  constructor(
    private readonly bot: Bot,
    private readonly executor: Executor,
  ) {}

  /** Raw Mineflayer observation is converted immediately to the typed world snapshot. */
  observeWorldState(input: SensorInput, options: SensorOptions): WorldState {
    return buildWorldState(this.bot, input, options)
  }

  /** Plain inventory counts for Mission predicates; Item objects never leave this adapter. */
  inventoryCounts(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const item of this.bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count
    return counts
  }

  /** Plain snapshot of already observed container contents; the Executor cache stays private. */
  containerContents(): readonly ContainerObservation[] {
    return this.executor.containerContents()
  }

  /** Typed readiness fact; the live Entity object stays inside this adapter. */
  bodyAvailable(): boolean {
    return this.bot.entity !== undefined
  }

  /** Plain health sample for safety/event projection; no Mineflayer value escapes. */
  currentHealth(): number {
    return this.bot.health ?? 0
  }

  /** Live identity fact sampled from the Mineflayer client and returned as a string. */
  currentDimension(): string {
    return this.bot.game === undefined ? 'overworld' : this.bot.game.dimension
  }

  /**
   * Typed route-CAN observations for Reach MOVE candidates. Each destination is
   * probed once per controller tick; a successful path also carries the exact
   * route-side portal-crossing fact used by the ordinary candidate gate.
   */
  reachabilityGateOptions(tick: number, memory: StateFingerprintMemory): ReachabilityGateOptions {
    if (this.reachabilityTick === tick && this.reachability !== null) return this.reachability
    const pathFacts = createPositionFactCache((position) => this.computePathFacts(position))
    this.reachability = {
      memory,
      pathProbe: (position) => pathFacts(position).probe,
      dimensionTransferProbe: (position) => pathFacts(position).transfer,
    }
    this.reachabilityTick = tick
    return this.reachability
  }

  /**
   * Typed actuation port: validate the VTR intent against this fresh grounded
   * candidate, apply Guard, then claim one Executor lease with VTR step hooks.
   * This adapter does not decide a route or close the Transition.
   */
  dispatch(request: ReachActuationRequest): ReachActuationResult {
    const { intent, candidate, observation } = request
    if (candidate.id !== intent.routeId) return { status: 'route-refused', reason: 'candidate-missing' }
    if (candidate.target === null || JSON.stringify(candidate.target) !== JSON.stringify(intent.target)) {
      return { status: 'route-refused', reason: 'target-mismatch' }
    }

    const guard = guardCandidate(candidate, observation, {
      phase: 'decision',
      candidateIds: new Set([candidate.id]),
      inFlight: null,
      reach: request.reach,
      maxCandidateAgeTicks: request.maxCandidateAgeTicks,
      canComputePath: (position) => request.reachability.pathProbe?.(position) === 'reachable',
      stationApproach: request.reachability.stationApproach ?? null,
    })
    if (!guard.ok) return { status: 'guard-refused', rejection: guard }

    try {
      const claim = this.executor.claim(guard.candidate, {
        liveStructureMembers: request.liveStructureMembers,
        authority: 'vtr-reach',
        transitionId: intent.transitionId,
        transitionContractHash: intent.contractHash,
        beforeMechanicalStep: request.beforeMechanicalStep,
        afterMechanicalStep: request.afterMechanicalStep,
        resolveVtrReachMechanicalWaypoint: (destination) => this.resolveVtrReachMechanicalWaypoint(destination),
        ...(request.onBeforeRunStart === undefined
          ? {}
          : {
              onBeforeRunStart: (started: { id: string; epoch: number }) =>
                request.onBeforeRunStart!({ ...started, candidate: guard.candidate }),
            }),
      })
      return {
        status: 'claimed',
        candidate: guard.candidate,
        claim,
        actionId: this.executor.current?.id ?? null,
      }
    } catch (error) {
      const active = this.executor.current
      return {
        status: 'claim-refused',
        message: error instanceof Error ? error.message : String(error),
        activeAction: active === null ? null : this.projectAction(active),
      }
    }
  }

  currentAction(): ReachRuntimeActionSnapshot | null {
    const action = this.executor.current
    return action === null ? null : this.projectAction(action)
  }

  cancelCurrent(reason: string): boolean {
    return this.executor.cancelCurrent(reason)
  }

  authorityConflictCount(): number {
    return this.executor.authorityConflictCount
  }

  /** Non-VTR claims that actually started an action (not conflict-rejected attempts). */
  nonVtrActuationCount(): number {
    return this.executor.nonVtrActuationCount
  }

  private projectAction(action: CurrentAction): ReachRuntimeActionSnapshot {
    return {
      id: action.id,
      kind: action.kind,
      epoch: action.epoch,
      status: action.status,
      authority: action.authority,
      transitionId: action.transitionId,
      transitionContractHash: action.transitionContractHash,
      commitment: action.commitment,
    }
  }

  private computePathFacts(position: Vec3Json): {
    readonly probe: 'reachable' | 'no_path'
    readonly transfer: 'crosses' | 'clear' | 'unknown'
  } {
    const pathfinder = this.bot.pathfinder
    if (pathfinder === undefined) return { probe: 'no_path', transfer: 'unknown' }
    try {
      const goal = new goals.GoalBlock(position.x, position.y, position.z)
      const plan = pathfinder.getPathTo(pathfinder.movements, goal, REACH_PATH_PROBE_TIMEOUT_MS)
      if (plan.status !== 'success') return { probe: 'no_path', transfer: 'unknown' }
      return { probe: 'reachable', transfer: this.routeCrossesDimensionTransfer(plan.path) }
    } catch {
      return { probe: 'no_path', transfer: 'unknown' }
    }
  }

  /**
   * Turn a successful, current-dimension Mineflayer path into one short typed
   * checkpoint. The Executor still drives the stock pathfinder; this adapter
   * only supplies the next path node, so intermediate arrival cannot verify the
   * committed Reach predicate.
   */
  private resolveVtrReachMechanicalWaypoint(destination: Vec3Json) {
    const pathfinder = this.bot.pathfinder
    const entity = this.bot.entity
    if (pathfinder === undefined || entity === undefined) return null
    try {
      const goal = new goals.GoalBlock(destination.x, destination.y, destination.z)
      const plan = pathfinder.getPathTo(pathfinder.movements, goal, REACH_PATH_SEGMENT_TIMEOUT_MS)
      if (plan.status !== 'success' || this.routeCrossesDimensionTransfer(plan.path) === 'crosses') return null
      return selectReachMechanicalWaypoint({
        current: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        destination,
        path: plan.path,
      })
    } catch {
      // Segmentation is an optimization for bounded re-observation, never a
      // reason to substitute an ungrounded waypoint or to claim arrival.
      return null
    }
  }

  private routeCrossesDimensionTransfer(path: readonly Vec3Json[]): 'crosses' | 'clear' {
    for (const feet of path) {
      const scratch = this.bot.entity.position.clone()
      const feetBlock = this.bot.blockAt(scratch.set(feet.x, feet.y, feet.z))
      if (isDimensionTransferBlock(feetBlock?.name)) return 'crosses'
      const headBlock = this.bot.blockAt(scratch.set(feet.x, feet.y + 1, feet.z))
      if (isDimensionTransferBlock(headBlock?.name)) return 'crosses'
    }
    return 'clear'
  }
}
