// kernel-shadow-map.ts - V4.1.2 Phase-1 shadow authority mapping.
//
// This module is the CANONICAL map from observed production mutation surfaces
// to V4.1.2 kernel authority concepts (resource bundle + effect permit), built
// from `docs/architecture/v4.1/RESOURCE-AUTHORITY-INVENTORY.md`. It is pure: it
// imports only the public kernel types and performs no side effects, so both
// the host-side shadow session and tests can depend on it without minting
// trusted capabilities.
//
// Authority semantics: a surface is "mapped" only when it resolves to one
// canonical resource bundle and one effect kind. An observed production
// mutation that does not resolve here is a hard migration blocker - it must
// never be silently accepted.
import type {
  EffectKind,
  LeaseMode,
  ResourceDomain,
  ResourceId,
  TransitionContractSpec,
  WorldIdentity,
} from '../../../kernel/kernel.ts'
import { resourceId, resourceKey } from '../../../kernel/kernel.ts'
import type { ReachTransitionContract, ReachWitness } from '../reach/transition.ts'

/** Canonical resource requirement on one mapped mutation surface. */
export interface ShadowResourceRequirement {
  readonly domain: ResourceDomain
  readonly path: readonly string[]
  /** 'arg' scopes the instance to the mutation argument (coordinate/entity). */
  readonly instance: string | 'arg' | null
  readonly mode: LeaseMode
}

export interface MappedMutationSurface {
  readonly surface: string
  readonly resources: readonly ShadowResourceRequirement[]
  readonly effect: EffectKind
  readonly scope: string
  /** True when the surface's physical side effect bypasses the guarded bot proxy. */
  readonly bypassesGuardedProxy: boolean
}

const ew = (domain: ResourceDomain, path: readonly string[] = [], instance: ShadowResourceRequirement['instance'] = null): ShadowResourceRequirement =>
  ({ domain, path, instance, mode: 'EXCLUSIVE_WRITE' })
const locomotion: ShadowResourceRequirement = ew('body', ['locomotion'])
const orientation: ShadowResourceRequirement = ew('body', ['orientation'])
const pose: ShadowResourceRequirement = ew('body', ['pose'])
const interaction: ShadowResourceRequirement = ew('interaction')
const inventory: ShadowResourceRequirement = ew('inventory')
const equipment: ShadowResourceRequirement = ew('equipment')
const windowResource: ShadowResourceRequirement = ew('window')
const containerAtArg: ShadowResourceRequirement = ew('container', [], 'arg')
const stationAtArg: ShadowResourceRequirement = ew('station', [], 'arg')
const entityAtArg: ShadowResourceRequirement = ew('entity', [], 'arg')
const worldBlockAtArg: ShadowResourceRequirement = ew('world', ['blocks'], 'arg')
const commandChannel: ShadowResourceRequirement = ew('command')

/**
 * Every bot.* / nested surface reachable from production code. Surfaces that
 * are not generation-guarded today (`attack`, `openFurnace`, `stopDigging`,
 * ...) are still listed: the shadow must see and map them BEFORE authority is
 * enabled, and the map is the audit source for the unguarded-wrap list.
 */
export const MUTATION_SURFACE_MAP: Readonly<Record<string, MappedMutationSurface>> = {
  // --- locomotion / orientation / pose -------------------------------------
  'bot.setControlState': { surface: 'bot.setControlState', resources: [locomotion], effect: 'MOVE', scope: 'control-state', bypassesGuardedProxy: false },
  'bot.clearControlStates': { surface: 'bot.clearControlStates', resources: [locomotion], effect: 'MOVE', scope: 'control-state', bypassesGuardedProxy: false },
  'bot.look': { surface: 'bot.look', resources: [orientation], effect: 'LOOK', scope: 'look', bypassesGuardedProxy: false },
  'bot.lookAt': { surface: 'bot.lookAt', resources: [orientation], effect: 'LOOK', scope: 'look-at', bypassesGuardedProxy: false },
  'bot.swingArm': { surface: 'bot.swingArm', resources: [pose, interaction], effect: 'INTERACT', scope: 'swing-arm', bypassesGuardedProxy: false },
  'bot.mount': { surface: 'bot.mount', resources: [locomotion, entityAtArg], effect: 'MOVE', scope: 'mount', bypassesGuardedProxy: false },
  'bot.dismount': { surface: 'bot.dismount', resources: [locomotion, entityAtArg], effect: 'MOVE', scope: 'dismount', bypassesGuardedProxy: false },
  'bot.sleep': { surface: 'bot.sleep', resources: [interaction, worldBlockAtArg], effect: 'INTERACT', scope: 'sleep', bypassesGuardedProxy: false },
  'bot.wake': { surface: 'bot.wake', resources: [interaction, worldBlockAtArg], effect: 'INTERACT', scope: 'wake', bypassesGuardedProxy: false },
  'bot.fish': { surface: 'bot.fish', resources: [interaction, equipment], effect: 'INTERACT', scope: 'fish', bypassesGuardedProxy: false },
  'bot.respawn': { surface: 'bot.respawn', resources: [commandChannel], effect: 'COMMAND', scope: 'respawn', bypassesGuardedProxy: false },
  'bot.setSettings': { surface: 'bot.setSettings', resources: [commandChannel], effect: 'COMMAND', scope: 'client-settings', bypassesGuardedProxy: false },

  // --- world blocks --------------------------------------------------------
  'bot.dig': { surface: 'bot.dig', resources: [worldBlockAtArg, orientation], effect: 'DIG', scope: 'dig', bypassesGuardedProxy: false },
  'bot.stopDigging': { surface: 'bot.stopDigging', resources: [worldBlockAtArg], effect: 'DIG', scope: 'abort-dig', bypassesGuardedProxy: false },
  'bot.placeBlock': { surface: 'bot.placeBlock', resources: [worldBlockAtArg, interaction, orientation, inventory], effect: 'PLACE', scope: 'place-block', bypassesGuardedProxy: false },
  'bot.updateSign': { surface: 'bot.updateSign', resources: [worldBlockAtArg, interaction], effect: 'PLACE', scope: 'update-sign', bypassesGuardedProxy: false },
  'bot.useOn': { surface: 'bot.useOn', resources: [interaction, worldBlockAtArg], effect: 'INTERACT', scope: 'use-on', bypassesGuardedProxy: false },

  // --- interaction / station / container / entity ---------------------------
  'bot.activateBlock': { surface: 'bot.activateBlock', resources: [interaction, worldBlockAtArg], effect: 'INTERACT', scope: 'activate-block', bypassesGuardedProxy: false },
  'bot.activateEntity': { surface: 'bot.activateEntity', resources: [interaction, entityAtArg], effect: 'INTERACT', scope: 'activate-entity', bypassesGuardedProxy: false },
  'bot.activateEntityAt': { surface: 'bot.activateEntityAt', resources: [interaction, entityAtArg], effect: 'INTERACT', scope: 'activate-entity-at', bypassesGuardedProxy: false },
  'bot.placeEntity': { surface: 'bot.placeEntity', resources: [interaction, entityAtArg, inventory], effect: 'PLACE', scope: 'place-entity', bypassesGuardedProxy: false },
  'bot.openBlock': { surface: 'bot.openBlock', resources: [interaction, worldBlockAtArg, windowResource], effect: 'INTERACT', scope: 'open-block', bypassesGuardedProxy: false },
  'bot.openContainer': { surface: 'bot.openContainer', resources: [interaction, containerAtArg, windowResource], effect: 'INTERACT', scope: 'open-container', bypassesGuardedProxy: false },
  'bot.openFurnace': { surface: 'bot.openFurnace', resources: [interaction, stationAtArg, windowResource], effect: 'INTERACT', scope: 'open-furnace', bypassesGuardedProxy: false },
  'bot.openEnchantmentTable': { surface: 'bot.openEnchantmentTable', resources: [interaction, stationAtArg, windowResource], effect: 'INTERACT', scope: 'open-enchantment-table', bypassesGuardedProxy: false },
  'bot.openVillager': { surface: 'bot.openVillager', resources: [interaction, entityAtArg, windowResource], effect: 'INTERACT', scope: 'open-villager', bypassesGuardedProxy: false },
  'bot.openAnvil': { surface: 'bot.openAnvil', resources: [interaction, stationAtArg, windowResource], effect: 'INTERACT', scope: 'open-anvil', bypassesGuardedProxy: false },
  'bot.closeWindow': { surface: 'bot.closeWindow', resources: [windowResource], effect: 'INTERACT', scope: 'close-window', bypassesGuardedProxy: false },
  'bot.attack': { surface: 'bot.attack', resources: [ew('attack', [], 'arg'), entityAtArg, orientation], effect: 'ATTACK', scope: 'attack-entity', bypassesGuardedProxy: false },
  'bot.activateItem': { surface: 'bot.activateItem', resources: [interaction, equipment], effect: 'INTERACT', scope: 'activate-item', bypassesGuardedProxy: false },
  'bot.deactivateItem': { surface: 'bot.deactivateItem', resources: [interaction, equipment], effect: 'INTERACT', scope: 'deactivate-item', bypassesGuardedProxy: false },
  'bot.consume': { surface: 'bot.consume', resources: [inventory, equipment, interaction], effect: 'CONSUME', scope: 'consume', bypassesGuardedProxy: false },
  'bot.chat': { surface: 'bot.chat', resources: [commandChannel], effect: 'COMMAND', scope: 'chat', bypassesGuardedProxy: false },

  // --- inventory / equipment ------------------------------------------------
  'bot.equip': { surface: 'bot.equip', resources: [inventory, equipment], effect: 'EQUIP', scope: 'equip', bypassesGuardedProxy: false },
  'bot.unequip': { surface: 'bot.unequip', resources: [inventory, equipment], effect: 'EQUIP', scope: 'unequip', bypassesGuardedProxy: false },
  'bot.toss': { surface: 'bot.toss', resources: [inventory, equipment], effect: 'INVENTORY_MUTATION', scope: 'toss', bypassesGuardedProxy: false },
  'bot.tossStack': { surface: 'bot.tossStack', resources: [inventory, equipment], effect: 'INVENTORY_MUTATION', scope: 'toss-stack', bypassesGuardedProxy: false },
  'bot.setQuickBarSlot': { surface: 'bot.setQuickBarSlot', resources: [equipment], effect: 'EQUIP', scope: 'select-hotbar', bypassesGuardedProxy: false },
  'bot.putSelectedItemRange': { surface: 'bot.putSelectedItemRange', resources: [inventory, windowResource], effect: 'INVENTORY_MUTATION', scope: 'put-item-range', bypassesGuardedProxy: false },
  'bot.clickWindow': { surface: 'bot.clickWindow', resources: [windowResource, inventory], effect: 'INVENTORY_MUTATION', scope: 'click-window', bypassesGuardedProxy: false },
  'bot.craft': { surface: 'bot.craft', resources: [inventory, stationAtArg, windowResource], effect: 'CRAFT', scope: 'craft', bypassesGuardedProxy: false },
  'bot.transfer': { surface: 'bot.transfer', resources: [windowResource, inventory, containerAtArg], effect: 'INVENTORY_MUTATION', scope: 'window-transfer', bypassesGuardedProxy: false },
  'bot.withdraw': { surface: 'bot.withdraw', resources: [windowResource, inventory, containerAtArg], effect: 'INVENTORY_MUTATION', scope: 'window-withdraw', bypassesGuardedProxy: false },
  'bot.deposit': { surface: 'bot.deposit', resources: [windowResource, inventory, containerAtArg], effect: 'INVENTORY_MUTATION', scope: 'window-deposit', bypassesGuardedProxy: false },

  // --- nested guarded capabilities ------------------------------------------
  'pathfinder.setGoal': { surface: 'pathfinder.setGoal', resources: [locomotion, orientation], effect: 'MOVE', scope: 'pathfinder-goal', bypassesGuardedProxy: false },
  'pathfinder.setMovements': { surface: 'pathfinder.setMovements', resources: [locomotion], effect: 'MOVE', scope: 'pathfinder-movements', bypassesGuardedProxy: false },
  'pathfinder.goto': { surface: 'pathfinder.goto', resources: [locomotion, orientation], effect: 'MOVE', scope: 'pathfinder-goto', bypassesGuardedProxy: false },
  'pathfinder.stop': { surface: 'pathfinder.stop', resources: [locomotion], effect: 'MOVE', scope: 'pathfinder-stop', bypassesGuardedProxy: false },
  'collectBlock.collect': { surface: 'collectBlock.collect', resources: [locomotion, entityAtArg, inventory], effect: 'MOVE', scope: 'collect-entity', bypassesGuardedProxy: false },
  'entity.position.write': { surface: 'entity.position.write', resources: [locomotion], effect: 'MOVE', scope: 'pose-write', bypassesGuardedProxy: false },
  'entity.yaw': { surface: 'entity.yaw', resources: [orientation], effect: 'LOOK', scope: 'pose-write', bypassesGuardedProxy: false },
  'entity.pitch': { surface: 'entity.pitch', resources: [orientation], effect: 'LOOK', scope: 'pose-write', bypassesGuardedProxy: false },
  'entity.onGround': { surface: 'entity.onGround', resources: [locomotion], effect: 'MOVE', scope: 'pose-write', bypassesGuardedProxy: false },

  // --- bypass-level evidence -------------------------------------------------
  // `window.withdraw`/`window.deposit` mutate on the raw client captured inside
  // the Mineflayer window object; they never traverse the guarded bot proxy.
  // The ActuationPort emits these records at the semantic dispatch boundary.
  'window.withdraw': { surface: 'window.withdraw', resources: [windowResource, inventory, containerAtArg], effect: 'INVENTORY_MUTATION', scope: 'window-withdraw', bypassesGuardedProxy: true },
  'window.deposit': { surface: 'window.deposit', resources: [windowResource, inventory, containerAtArg], effect: 'INVENTORY_MUTATION', scope: 'window-deposit', bypassesGuardedProxy: true },
}

/** Protocol packet-name map for the `_client.write` surface. */
const PACKET_BUNDLES: Readonly<Record<string, readonly ShadowResourceRequirement[]>> = {
  position: [locomotion],
  position_look: [locomotion, orientation],
  look: [orientation],
  flying: [locomotion],
  vehicle_move: [locomotion],
  steer_vehicle: [locomotion],
  arm_animation: [pose],
  entity_action: [pose],
  block_dig: [worldBlockAtArg],
  block_place: [interaction, worldBlockAtArg],
  use_item: [interaction, equipment],
  window_click: [windowResource, inventory],
  close_window: [windowResource],
  transaction: [windowResource],
  enchant_item: [windowResource, inventory],
  held_item_slot: [equipment],
  chat: [commandChannel],
  chat_command: [commandChannel],
  client_command: [commandChannel],
  settings: [commandChannel],
  client_information: [commandChannel],
  tab_complete: [commandChannel],
}

const PACKET_EFFECTS: Readonly<Record<string, { effect: EffectKind; scope: string }>> = {
  block_dig: { effect: 'DIG', scope: 'packet:block_dig' },
  block_place: { effect: 'PLACE', scope: 'packet:block_place' },
  use_item: { effect: 'INTERACT', scope: 'packet:use_item' },
  window_click: { effect: 'INVENTORY_MUTATION', scope: 'packet:window_click' },
  close_window: { effect: 'INTERACT', scope: 'packet:close_window' },
  transaction: { effect: 'INVENTORY_MUTATION', scope: 'packet:transaction' },
  enchant_item: { effect: 'INVENTORY_MUTATION', scope: 'packet:enchant_item' },
  held_item_slot: { effect: 'EQUIP', scope: 'packet:held_item_slot' },
  chat: { effect: 'COMMAND', scope: 'packet:chat' },
  chat_command: { effect: 'COMMAND', scope: 'packet:chat_command' },
  client_command: { effect: 'COMMAND', scope: 'packet:client_command' },
  settings: { effect: 'COMMAND', scope: 'packet:settings' },
  client_information: { effect: 'COMMAND', scope: 'packet:client_information' },
  tab_complete: { effect: 'COMMAND', scope: 'packet:tab_complete' },
  arm_animation: { effect: 'INTERACT', scope: 'packet:arm_animation' },
  entity_action: { effect: 'MOVE', scope: 'packet:entity_action' },
}

export interface ResolvedMutationAuthority {
  readonly surface: string
  readonly resources: readonly ResourceId[]
  readonly effect: EffectKind
  readonly scope: string
  readonly bypassesGuardedProxy: boolean
}

/**
 * Resolve one observed mutation surface to the canonical kernel bundle.
 * `instanceHint` carries the coordinate/entity instance extracted at the
 * observation site. Returns null for an unmapped surface/packet: callers must
 * treat null as a hard migration blocker, never as "harmless".
 */
export function mapMutationSurface(surface: string, instanceHint: string | null): ResolvedMutationAuthority | null {
  if (surface.startsWith('entity.position.')) {
    const base = MUTATION_SURFACE_MAP['entity.position.write']
    if (base === undefined) return null
    return {
      surface: 'entity.position.write',
      resources: base.resources.map((r) => toResourceId(r, instanceHint)),
      effect: base.effect,
      scope: base.scope,
      bypassesGuardedProxy: base.bypassesGuardedProxy,
    }
  }
  if (surface === '_client.write') {
    const packet = instanceHint ?? ''
    const resources = PACKET_BUNDLES[packet]
    if (resources === undefined) return null
    const effectSpec = PACKET_EFFECTS[packet] ?? { effect: 'MOVE' as const, scope: `packet:${packet}` }
    return {
      surface: `_client.write:${packet}`,
      resources: resources.map((r) => toResourceId(r, null)),
      effect: effectSpec.effect,
      scope: effectSpec.scope,
      bypassesGuardedProxy: false,
    }
  }
  const spec = MUTATION_SURFACE_MAP[surface]
  if (spec === undefined) return null
  return {
    surface: spec.surface,
    resources: spec.resources.map((r) => toResourceId(r, r.instance === 'arg' ? instanceHint : null)),
    effect: spec.effect,
    scope: spec.scope,
    bypassesGuardedProxy: spec.bypassesGuardedProxy,
  }
}

function toResourceId(requirement: ShadowResourceRequirement, instance: string | null): ResourceId {
  return resourceId(requirement.domain, requirement.path, requirement.instance === 'arg' ? instance : requirement.instance)
}

// ---------------------------------------------------------------------------
// Reach contract -> kernel contract
// ---------------------------------------------------------------------------

const SHADOW_COMPILER = { id: 'vtr-reach-compiler', version: 'vtr-reach/v4' } as const
const SHADOW_VERIFIER = { id: 'vtr-deterministic-verify', version: 'vtr-verify/v1' } as const
const SHADOW_PROGRESS = { id: 'vtr-reach-progress', version: 'predicate_distance/v1' } as const
const SHADOW_CONTROLLER = { id: 'vtr-reach-controller', version: 'vtr-reach/v4' } as const
const SHADOW_TERMINAL = { id: 'vtr-reach-terminal', version: 'vtr-reach/v1' } as const
const SHADOW_WITNESS = { id: 'vtr-reach-witness', version: 'vtr-witness/v1' } as const
const SHADOW_MISSION_AUTHORITY = { id: 'host-mission-authority', version: 'v1' } as const

export const SHADOW_REGISTRY = {
  compiler: SHADOW_COMPILER,
  verifier: SHADOW_VERIFIER,
  progress: SHADOW_PROGRESS,
  controller: SHADOW_CONTROLLER,
  terminal: SHADOW_TERMINAL,
  witness: SHADOW_WITNESS,
  missionAuthority: SHADOW_MISSION_AUTHORITY,
} as const

/**
 * Reach admissible-effect kind -> kernel (claims, effect permit). The Reach
 * contract declares `locomotion` today; the table is explicit so a new effect
 * kind fails closed at shadow registration instead of silently mapping.
 */
const REACH_EFFECT_MAP: Readonly<Record<string, {
  readonly claims: readonly ShadowResourceRequirement[]
  readonly permit: { readonly kind: EffectKind; readonly scope: string; readonly irreversible: boolean }
}>> = {
  locomotion: {
    // Pathfinder couples stepping and facing inside one primitive (inventory
    // rules 1/3/4): the contract claims both siblings EXCLUSIVE_WRITE.
    claims: [locomotion, orientation],
    permit: { kind: 'MOVE', scope: 'reach:leg', irreversible: false },
  },
}

export type ReachKernelContractResult =
  | { readonly ok: true; readonly spec: TransitionContractSpec }
  | { readonly ok: false; readonly reason: string }

/**
 * Compile the production Reach contract into a V4.1.2 TransitionContractSpec.
 * `world` is the session world identity; the Reach identity must agree exactly
 * (worldKey is `serverId|dimension|worldEpoch`).
 */
export function reachContractToKernelSpec(
  contract: ReachTransitionContract,
  world: WorldIdentity,
): ReachKernelContractResult {
  const identity = contract.identity
  // Reach identities use the jev-agent bare-dimension convention ('overworld')
  // while host world keys carry the canonical 'minecraft:' namespace. Compare
  // both sides under the same bare form so a namespaced and a bare spelling of
  // the same dimension agree — real mismatches (e.g. nether vs overworld)
  // still fail closed.
  const bareDimension = (dimension: string): string => dimension.replace(/^minecraft:/, '')
  const worldDim = bareDimension(world.dimension)
  if (bareDimension(identity.dimension) !== worldDim || identity.worldEpoch !== world.worldEpoch) {
    return { ok: false, reason: `contract identity ${identity.dimension}@${identity.worldEpoch} disagrees with kernel world ${world.dimension}@${world.worldEpoch}` }
  }
  const worldKeyParts = identity.worldKey.split('|')
  const worldKeyAgrees =
    worldKeyParts.length === 3 &&
    worldKeyParts[0] === world.serverId &&
    bareDimension(worldKeyParts[1]!) === worldDim &&
    worldKeyParts[2] === String(world.worldEpoch)
  if (!worldKeyAgrees) {
    return { ok: false, reason: `contract worldKey ${identity.worldKey} disagrees with kernel world` }
  }
  if (contract.admissibleEffects.length === 0) {
    return { ok: false, reason: 'contract declares no admissible effects' }
  }
  const claims: ShadowResourceRequirement[] = []
  const effects: Array<{ kind: EffectKind; scope: string; irreversible: boolean; maxCount: number; requiredResources: readonly ShadowResourceRequirement[] }> = []
  for (const effect of contract.admissibleEffects) {
    const mapped = REACH_EFFECT_MAP[effect.kind]
    if (mapped === undefined) return { ok: false, reason: `unmapped admissible effect kind ${effect.kind}` }
    for (const claim of mapped.claims) {
      if (!claims.some((existing) => resourceKey(toResourceId(existing, null)) === resourceKey(toResourceId(claim, null)))) claims.push(claim)
    }
    effects.push({
      ...mapped.permit,
      // The contract-wide mechanical-step budget bounds a null maxUses permit.
      maxCount: effect.maxUses ?? Math.max(1, contract.budget.maxMechanicalSteps),
      requiredResources: mapped.claims,
    })
  }
  return {
    ok: true,
    spec: {
      transitionId: contract.transitionId,
      family: 'vtr-reach',
      class: 'MISSION',
      urgency: 0,
      world,
      desiredPredicate: contract.desiredPredicate.id,
      requires: contract.requires.map((predicate) => predicate.id),
      ensures: contract.ensures.map((predicate) => predicate.id),
      invariants: contract.invariants.map((predicate) => predicate.id),
      claims: claims.map((claim) => ({
        resource: toResourceId(claim, null),
        mode: claim.mode,
        preemptible: true,
        resumable: true,
      })),
      effects: effects.map((effect) => ({
        kind: effect.kind,
        scope: effect.scope,
        irreversible: effect.irreversible,
        maxCount: effect.maxCount,
        requiredResources: effect.requiredResources.map((r) => ({ resource: toResourceId(r, null), mode: r.mode })),
      })),
      budget: {
        maxActiveMs: contract.budget.maxElapsedMs,
        deadlineAtMonoMs: null,
        maxMechanicalSteps: contract.budget.maxMechanicalSteps,
        resources: { ...contract.budget.resources },
        risk: { ...contract.budget.risk },
      },
      progressDefinition: SHADOW_PROGRESS,
      controllerDefinition: SHADOW_CONTROLLER,
      verificationDefinition: SHADOW_VERIFIER,
      terminalPolicy: SHADOW_TERMINAL,
      witnessValidation: SHADOW_WITNESS,
    },
  }
}

// ---------------------------------------------------------------------------
// Shadow observer input contract (emitted by semantic code and the mutation
// boundary; consumed only by the host-side shadow session)
// ---------------------------------------------------------------------------

/** Executor action context at the moment a mutation dispatch was observed. */
export interface ShadowMutationContext {
  readonly actionId: string | null
  readonly epoch: number | null
  readonly authority: string | null
  readonly transitionId: string | null
  readonly transitionContractHash: string | null
  /**
   * Typed host control-plane / adapter-lifecycle scope declared by the caller
   * for mutations that are not transition effects (for example the
   * bootstrap movement-policy pin). Counted separately from
   * transition-attributed mutations; never silently ignored.
   */
  readonly hostScope?: { readonly category: string; readonly label: string }
}

export type KernelShadowInput =
  | {
      readonly type: 'world-observation'
      readonly observedAtMs: number
      readonly predicates: Readonly<Record<string, { readonly truth: 'true' | 'false' | 'unknown'; readonly evidenceId: string | null }>>
    }
  | {
      readonly type: 'transition-committed'
      readonly contract: ReachTransitionContract
      readonly witness: ReachWitness | null
      readonly lifecycle: 'active' | 'terminal'
    }
  | {
      readonly type: 'transition-terminal'
      readonly transitionId: string
      readonly contractHash: string
      readonly outcome: { readonly kind: string } & Readonly<Record<string, unknown>>
    }
  | {
      readonly type: 'mechanical-step-issued'
      readonly transitionId: string
      readonly intentId: string
      readonly stepId: string
      readonly effectKind: string
    }
  | {
      readonly type: 'mechanical-step-settled'
      readonly transitionId: string
      readonly intentId: string
      readonly stepId: string
      readonly status: string
      readonly verified: boolean
      readonly progressed: boolean
    }
  | {
      readonly type: 'mutation'
      readonly surface: string
      readonly guarded: boolean
      readonly leaseOutcome: 'granted' | 'denied'
      readonly argsSignature: readonly string[]
      readonly instanceHint: string | null
      readonly context: ShadowMutationContext | null
    }

/** Narrow sink the semantic runtime may hold; the host owns the implementation. */
export type KernelShadowSink = (input: KernelShadowInput) => void

// ---------------------------------------------------------------------------
// V4.1.2 production-authority gate (Phase-2 cutover)
// ---------------------------------------------------------------------------

export type KernelGateVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

export type KernelAuthorityMode = 'shadow' | 'authority'

/**
 * One verified world observation fed into the kernel fact store. The authority
 * gate consumes these unconditionally (they are what VERIFY reads), so this is
 * the observation half of the same session the verdict gates run on — not a
 * fire-and-forget shadow replay input.
 */
export type KernelWorldObservation = Omit<
  Extract<KernelShadowInput, { type: 'world-observation' }>,
  'type'
>

/**
 * Host-owned kernel gate for V4.1.2 Reach production authority.
 *
 * Unlike the fire-and-forget `KernelShadowSink`, every call here returns the
 * real kernel verdict and the caller MUST honor a denial by not performing the
 * production act it gates. Ordering contract, enforced by call sequence:
 *
 *   admitTransition (REGISTER + mission authorize + ADMIT)
 *     -> production controller commit
 *   activateTransition (fresh proofs + witness + ACQUIRE_DECLARED_RESOURCES)
 *     -> declared resource bundle is held; only now may effects be issued
 *   issueStepEffect (ISSUE_EFFECT + BEGIN_EFFECT_DISPATCH)
 *     -> typed adapter mutation for exactly one physical leg
 *   settleStepEffect (RECONCILE_EFFECT + DEBIT_USAGE)
 *   terminalize (VERIFY_SUCCESS for SUCCESS; typed/stand-in closure otherwise)
 *
 * `feedObservation` is the observation half of the same session: verified world
 * facts the kernel must verify and check freshness against. It returns no
 * verdict, but VERIFY_SUCCESS reads only facts fed here, so production MUST
 * feed every decision-relevant observation or VERIFY denies for lack of
 * observed proof.
 *
 * A denied verdict is terminal for the gated act, never a request to try the
 * same thing through a legacy path.
 */
export interface KernelReachAuthority {
  /** Present only when the session runs in production-authority mode. */
  readonly mode: 'authority'
  /** Feed a verified world observation into the kernel fact store (no verdict). */
  feedObservation(input: KernelWorldObservation): void
  /** Contract legality + mission authorization + admission gate before production commit. */
  admitTransition(contract: ReachTransitionContract): KernelGateVerdict
  /** Proof/witness freshness + declared resource bundle acquisition before first dispatch. */
  activateTransition(transitionId: string, witness: ReachWitness | null): KernelGateVerdict
  /** One effect commit issued and dispatch-linearized before the physical leg runs. */
  issueStepEffect(input: {
    readonly transitionId: string
    readonly intentId: string
    readonly stepId: string
    readonly effectKind: string
  }): KernelGateVerdict
  /** Reconcile the settled leg and debit usage; a denial is a hard blocker, never reversible. */
  settleStepEffect(input: {
    readonly transitionId: string
    readonly intentId: string
    readonly stepId: string
    readonly status: string
    readonly verified: boolean
    readonly progressed: boolean
  }): void
  /**
   * Close the transition. For SUCCESS the kernel performs VERIFY_SUCCESS over
   * observed facts only; a denial means production MUST NOT claim SUCCESS.
   */
  terminalize(input: {
    readonly transitionId: string
    readonly contractHash: string
    readonly outcome: { readonly kind: string } & Readonly<Record<string, unknown>>
  }): KernelGateVerdict
}
