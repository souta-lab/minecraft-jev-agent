// portal-evidence.ts — legacy portal/dimension evidence projection.
//
// Extracted from `controller-legacy.ts`. Portal lit/entered truth reads live
// world state through the raw client (a legacy concern — VTR never sees the
// Bot), turns remembered frame sites into sensor input, and logs/refuses
// entry diagnostics. No authority: predicate truth is still decided by the
// caller; this module only produces evidence rows and typed refusals.

import type { Bot } from 'mineflayer'
import type { PortalEntryRefusal } from '../candidates.ts'
import {
  formatPortalEntryNoKnownSite,
  isPortalIgnitionPostconditionMet,
  NETHER,
  NETHER_PORTAL,
  OVERWORLD,
  planPortalEntry,
  PORTAL_ENTERED_PREDICATE,
  PORTAL_LIT_PREDICATE,
  PORTAL_OBSIDIAN_REQUIRED,
  portalFrameLayout,
} from '../netherPortalPlan.ts'
import type { PortalEntryPlan, PortalFrameSite, PortalFrameValidation } from '../netherPortalPlan.ts'
import type { QueuedGoal } from '../goalQueue.ts'
import { recordedPortalSitesFromKnownResources } from '../goalSuccess.ts'
import type { RecordedPortalSite } from '../goalSuccess.ts'
import type { EventLogger } from '../jev.ts'
import { sensorOptions } from '../controller-shared.ts'
import { isStandable, liveStructureMembersForSites, sensedPortalFrameSites } from '../state.ts'
import type { DimensionProvenance, KnownResource, WorldState } from '../state.ts'
import { ROUTE_ALL_SPENT_REASON } from '../zeroProgressRoute.ts'
import type { EscalationReason } from './escalation.ts'

/** Narrow host surface for the portal-evidence slice. */
export interface PortalEvidenceHost {
  bot: Bot
  logger: EventLogger
  tickCounter: number
  options: {
    readonly knownResources?: readonly KnownResource[]
    readonly dimensionProvenance?: DimensionProvenance | null
    readonly scanRadius: number
    readonly reach: number
  }
  lastEntryUnverifiedKey: string | null
  lastEntryRefusalKey: string | null
  rememberedPortalFrameDimension: string | null
  readonly rememberedPortalFrameSites: Map<string, PortalFrameSite>
  rememberedPortalFrame: PortalFrameValidation | null
  escalate(reason: EscalationReason, detail: string): void
  rememberPortalFrameSites(sites: readonly PortalFrameSite[], dimension: string): void
}

export function portalLitTruth(host: PortalEvidenceHost, goal: QueuedGoal): boolean {
    if (goal.targetPredicate !== PORTAL_LIT_PREDICATE) return false
    const actualDimension = host.bot.game?.dimension ?? null
    const expectedDimension = goal.dimension ?? OVERWORLD
    const normalize = (value: string): string => value.replace(/^minecraft:/, '').toLowerCase()
    if (actualDimension === null || normalize(actualDimension) !== normalize(expectedDimension)) return false
    const sites = sensedPortalFrameSites(host.bot, sensorOptions(host.options))
    const scratch = host.bot.entity?.position?.clone()
    if (scratch === undefined) return false
    const samples: string[] = []
    const lit = sites.some((site) => {
      const blocks = site.existingFrame?.length ?? 0
      if (blocks < PORTAL_OBSIDIAN_REQUIRED) {
        samples.push(`origin=${site.origin.x},${site.origin.y},${site.origin.z} blocks=${blocks} <required`)
        return false
      }
      const layout = portalFrameLayout(site.origin, site.widthAxis)
      const interior = layout.interior.map(
        (cell) => host.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? 'null',
      )
      const ok = isPortalIgnitionPostconditionMet(layout.interior, (cell) => host.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? null, NETHER_PORTAL)
      samples.push(`origin=${site.origin.x},${site.origin.y},${site.origin.z} blocks=${blocks} interior=[${interior.join(',')}] ok=${ok}`)
      return ok
    })
    // Live diagnosis for the M2 hand-off: the portal is `PORTAL_VERIFIED` yet the
    // queue's light row kept re-igniting hundreds of times, so the queue never
    // emptied and the ladder never advanced to `enter_nether`. This records the
    // exact world truth the predicate saw (dimension, sites, interior cells).
    host.logger.info(
      'agent',
      `PORTAL_LIT_TRUTH goal=${goal.id} dimension=${actualDimension} expected=${expectedDimension} sites=${sites.length} lit=${lit} ${samples.join(' | ')}`,
      { actionId: goal.id },
    )
    return lit
  }

  /**
   * Ground the dimension-transfer plan for the active `portal_entered` goal from
   * LIVE world truth only: the interior must currently be `nether_portal` and at
   * least one interior cell must be standable by the GENERIC locomotion rule
   * (the same `isStandable` the terrain sensor and MOVE guard use). Returns null
   * when the active goal does not request entry. Never silent: a requested entry
   * with no lit/standable portal returns the pure module's typed refusal.
   */

export function portalEntryPlan(host: PortalEvidenceHost, state: WorldState): PortalEntryPlan | null {
    const current = state.goalQueue?.current ?? null
    if (current === null) return null
    if (current.kind !== 'place' || current.targetPredicate !== PORTAL_ENTERED_PREDICATE) return null
    const entity = host.bot.entity
    if (entity === undefined) return null
    const scratch = entity.position.clone()
    const blockAt = (cell: { x: number; y: number; z: number }): string | null =>
      host.bot.blockAt(scratch.set(cell.x, cell.y, cell.z))?.name ?? null
    const sites = state.portalFrameSites ?? []
    const dimension = current.dimension ?? NETHER
    const self = {
      x: Math.floor(state.self.position.x),
      y: Math.floor(state.self.position.y),
      z: Math.floor(state.self.position.z),
    }
    let refusal: PortalEntryPlan | null = null
    for (const site of sites) {
      const plan = planPortalEntry({
        site,
        self,
        blockAt,
        isStandable: (cell) => isStandable(host.bot, cell),
        fromDimension: state.self.dimension,
        dimension,
      })
      if (plan.ok) return plan
      if (refusal === null) refusal = plan
    }
    return (
      refusal ?? {
        ok: false,
        refused: true,
        reason: 'no_known_site',
        // With ZERO sites examined there is no observation at all, so claiming
        // `portal_not_lit` would be a fabricated world fact (live
        // run-muc3qbug-18vg3 emitted exactly that while the run's own durable
        // record said the gate was lit and verified). Name what is missing.
        line: formatPortalEntryNoKnownSite(),
      }
    )
  }

  /**
   * The remembered-site approach marker: the entry route targets a portal whose
   * lit interior could not be observed from here, so the walk is offered and the
   * executor re-verifies the `nether_portal` interior at arrival. Distinct from
   * `logEntryRefusal` (which owns the refusals) and deduped by line so a stable
   * unverified route is one run-scoped fact, not a per-tick flood.
   */

export function logEntryUnverified(host: PortalEvidenceHost, plan: PortalEntryPlan | null): void {
    const line = plan !== null && plan.ok && plan.candidate.unverified === true ? plan.candidate.line : null
    if (line === host.lastEntryUnverifiedKey) return
    host.lastEntryUnverifiedKey = line
    if (line === null) return
    host.logger.info('agent', line, { reason: 'site_not_observed', enter: line }, host.tickCounter)
  }

  /**
   * World truth for the dimension-transfer predicate. The row is complete ONLY
   * when the bot's own live dimension equals the goal's target; no inventory
   * count can substitute for it (`nether_portal` is not an item).
   */

export function portalEnteredTruth(host: PortalEvidenceHost, goal: QueuedGoal): boolean {
    if (goal.targetPredicate !== PORTAL_ENTERED_PREDICATE) return false
    const actual = host.bot.game?.dimension ?? null
    if (actual === null) return false
    const normalize = (value: string): string => value.replace(/^minecraft:/, '').toLowerCase()
    return normalize(actual) === normalize(goal.dimension ?? NETHER)
  }


export function logEntryRefusal(host: PortalEvidenceHost, refusal: PortalEntryRefusal | null): void {
    const key = refusal === null ? null : refusal.line
    if (key === host.lastEntryRefusalKey) return
    host.lastEntryRefusalKey = key
    if (refusal === null) return
    host.logger.warn('agent', refusal.line, { reason: refusal.reason }, host.tickCounter)
  }

  /**
   * A route arm that reports `all_routes_spent` has proved a STRUCTURAL
   * capability boundary: every route it can ground from this body cell to the
   * goal's target is spent, and no grounded approach leg changes the stand cell.
   * That is exactly the WHAT-next boundary System2 owns, so it goes through the
   * ordinary bounded escalation (`escalationCooldownMs` / `escalationWindowMs`
   * and the `ESCALATION_TO_SUMMON` mapping) instead of re-offering the dead
   * route. Code still owns the fact (CAN/TRUE); Jev still chooses WHICH among
   * the remaining grounded offers; System2 owns WHAT comes next.
   */

export function noteRouteExhaustion(host: PortalEvidenceHost, refusal: PortalEntryRefusal | null): void {
    if (refusal === null || refusal.reason !== ROUTE_ALL_SPENT_REASON) return
    host.escalate('route_exhausted', refusal.line)
  }


export function recordedPortalSites(host: PortalEvidenceHost): RecordedPortalSite[] {
    return recordedPortalSitesFromKnownResources(host.options.knownResources)
  }

  /**
   * Retire a stale protected prerequisite that world truth has already made
   * unnecessary. This is a world-truth/lifecycle reconciliation, not a semantic
   * preference: every other protected goal keeps the normal #55 reinsertion
   * guarantee.
   */

export function mergeRememberedPortalFrame(host: PortalEvidenceHost, state: WorldState): WorldState {
    const dimension = state.self.dimension
    if (host.rememberedPortalFrameDimension !== dimension) {
      host.rememberedPortalFrameDimension = dimension
      host.rememberedPortalFrameSites.clear()
      host.rememberedPortalFrame = null
    }
    host.rememberPortalFrameSites(state.portalFrameSites ?? [], dimension)
    if (state.portalFrame?.shape === 'ok') host.rememberedPortalFrame = state.portalFrame
    if (host.rememberedPortalFrameSites.size === 0 && host.rememberedPortalFrame === null) return state

    const merged: PortalFrameSite[] = []
    const seen = new Set<string>()
    // LIVE sites win over remembered copies: the live functional-core fact
    // (`coreIntact`) is current world truth, and a remembered geometry-only copy
    // must never shadow it. Memory only fills sites the sensor did not observe
    // this tick, matching `mergePortalFrameSites` in the sensor.
    for (const site of [...(state.portalFrameSites ?? []), ...host.rememberedPortalFrameSites.values()]) {
      const key = `${site.origin.x},${site.origin.y},${site.origin.z}|${site.widthAxis}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(site)
    }
    return {
      ...state,
      portalFrameSites: merged,
      portalFrame: state.portalFrame ?? host.rememberedPortalFrame,
      // Re-derive the source-protection membership from the MERGED sites: the
      // sensor computed it from the sites it saw this tick, and a frame that
      // only this generation's memory still holds must stay protected too.
      liveStructureMembers: liveStructureMembersForSites(merged),
    }
  }


export function rememberPortalFrameSites(host: PortalEvidenceHost, sites: readonly PortalFrameSite[], dimension: string): void {
    if (host.rememberedPortalFrameDimension !== dimension) {
      host.rememberedPortalFrameDimension = dimension
      host.rememberedPortalFrameSites.clear()
      host.rememberedPortalFrame = null
    }
    for (const site of sites) {
      if ((site.existingFrame?.length ?? 0) === 0) continue
      const key = `${site.origin.x},${site.origin.y},${site.origin.z}|${site.widthAxis}`
      // Durable memory keeps geometry only. `coreIntact` is a volatile live-world
      // verdict (the portal's lit interior) and must be re-observed, never
      // replayed, or a destroyed portal's obsidian would stay protected forever.
      host.rememberedPortalFrameSites.set(key, {
        origin: { ...site.origin },
        widthAxis: site.widthAxis,
        safe: site.safe,
        reachable: site.reachable,
        temporarySupportRequired: site.temporarySupportRequired,
        existingFrame: site.existingFrame === undefined ? undefined : site.existingFrame.map((cell) => ({ ...cell })),
      })
    }
  }
