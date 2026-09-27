// kernel-authority-map.ts - V4.1.2 kernel authority mapping.
//
// This module is the CANONICAL map from observed production mutation surfaces
// to V4.1.2 kernel authority concepts (resource bundle + effect permit), built
// from `docs/architecture/v4.1/RESOURCE-AUTHORITY-INVENTORY.md`. It is pure: it
// imports only the public kernel types and performs no side effects, so both
// the host-side kernel session and tests can depend on it without minting
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
export interface KernelResourceRequirement {
  readonly domain: ResourceDomain
  readonly path: readonly string[]
  /** 'arg' scopes the instance to the mutation argument (coordinate/entity). */
  readonly instance: string | 'arg' | null
  readonly mode: LeaseMode
}

export interface MappedMutationSurface {
  readonly surface: string
  readonly resources: readonly KernelResourceRequirement[]
  readonly effect: EffectKind
  readonly scope: string
  /** True when the surface's physical side effect bypasses the guarded bot proxy. */
  readonly bypassesGuardedProxy: boolean
}

const ew = (domain: ResourceDomain, path: readonly string[] = [], instance: KernelResourceRequirement['instance'] = null): KernelResourceRequirement =>
  ({ domain, path, instance, mode: 'EXCLUSIVE_WRITE' })
const locomotion: KernelResourceRequirement = ew('body', ['locomotion'])
const orientation: KernelResourceRequirement = ew('body', ['orientation'])
const pose: KernelResourceRequirement = ew('body', ['pose'])
const interaction: KernelResourceRequirement = ew('interaction')
const inventory: KernelResourceRequirement = ew('inventory')
const equipment: KernelResourceRequirement = ew('equipment')
const windowResource: KernelResourceRequirement = ew('window')
const containerAtArg: KernelResourceRequirement = ew('container', [], 'arg')
const stationAtArg: KernelResourceRequirement = ew('station', [], 'arg')
const entityAtArg: KernelResourceRequirement = ew('entity', [], 'arg')
const worldBlockAtArg: KernelResourceRequirement = ew('world', ['blocks'], 'arg')
const commandChannel: KernelResourceRequirement = ew('command')

/**
 * Every bot.* / nested surface reachable from production code. Surfaces that
 * are not generation-guarded today (`attack`, `openFurnace`, `stopDigging`,
 * ...) are still listed: the session must see and map them BEFORE authority is
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
  // Mineflayer's private look-free placement primitive (pillar steps).
  'bot._placeBlockWithOptions': { surface: 'bot._placeBlockWithOptions', resources: [worldBlockAtArg, interaction, orientation, inventory], effect: 'PLACE', scope: 'place-block', bypassesGuardedProxy: false },
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
  // Direct physics-state writes (pillar take-off impulse, portal hop).
  'entity.velocity.write': { surface: 'entity.velocity.write', resources: [locomotion], effect: 'MOVE', scope: 'velocity-write', bypassesGuardedProxy: false },
  'bot.physicsEnabled': { surface: 'bot.physicsEnabled', resources: [locomotion], effect: 'MOVE', scope: 'physics-toggle', bypassesGuardedProxy: false },

  // --- window transfers (guarded window proxy returned by bot.open*) --------
  'window.putInput': { surface: 'window.putInput', resources: [windowResource, inventory, stationAtArg], effect: 'STATION_MUTATION', scope: 'furnace-put-input', bypassesGuardedProxy: false },
  'window.putFuel': { surface: 'window.putFuel', resources: [windowResource, inventory, stationAtArg], effect: 'STATION_MUTATION', scope: 'furnace-put-fuel', bypassesGuardedProxy: false },
  'window.takeInput': { surface: 'window.takeInput', resources: [windowResource, inventory, stationAtArg], effect: 'STATION_MUTATION', scope: 'furnace-take-input', bypassesGuardedProxy: false },
  'window.takeFuel': { surface: 'window.takeFuel', resources: [windowResource, inventory, stationAtArg], effect: 'STATION_MUTATION', scope: 'furnace-take-fuel', bypassesGuardedProxy: false },
  'window.takeOutput': { surface: 'window.takeOutput', resources: [windowResource, inventory, stationAtArg], effect: 'STATION_MUTATION', scope: 'furnace-take-output', bypassesGuardedProxy: false },
  'window.close': { surface: 'window.close', resources: [windowResource], effect: 'INTERACT', scope: 'close-window', bypassesGuardedProxy: false },

  // --- container transfers ----------------------------------------------------
  // Observed on the guarded window proxy (executor container path) and at the
  // ActuationPort dispatch boundary (whose raw window write the bot proxy
  // cannot see - hence `bypassesGuardedProxy`).
  'window.withdraw': { surface: 'window.withdraw', resources: [windowResource, inventory, containerAtArg], effect: 'INVENTORY_MUTATION', scope: 'window-withdraw', bypassesGuardedProxy: true },
  'window.deposit': { surface: 'window.deposit', resources: [windowResource, inventory, containerAtArg], effect: 'INVENTORY_MUTATION', scope: 'window-deposit', bypassesGuardedProxy: true },
}

/** Protocol packet-name map for the `_client.write` surface. */
const PACKET_BUNDLES: Readonly<Record<string, readonly KernelResourceRequirement[]>> = {
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
  if (surface.startsWith('entity.velocity.')) {
    const base = MUTATION_SURFACE_MAP['entity.velocity.write']
    if (base === undefined) return null
    return {
      surface: 'entity.velocity.write',
      resources: base.resources.map((r) => toResourceId(r, null)),
      effect: base.effect,
      scope: base.scope,
      bypassesGuardedProxy: base.bypassesGuardedProxy,
    }
  }
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

function toResourceId(requirement: KernelResourceRequirement, instance: string | null): ResourceId {
  return resourceId(requirement.domain, requirement.path, requirement.instance === 'arg' ? instance : requirement.instance)
}

// ---------------------------------------------------------------------------
// Reach contract -> kernel contract
// ---------------------------------------------------------------------------

const REACH_COMPILER = { id: 'vtr-reach-compiler', version: 'vtr-reach/v4' } as const
const REACH_VERIFIER = { id: 'vtr-deterministic-verify', version: 'vtr-verify/v1' } as const
const REACH_PROGRESS = { id: 'vtr-reach-progress', version: 'predicate_distance/v1' } as const
const REACH_CONTROLLER = { id: 'vtr-reach-controller', version: 'vtr-reach/v4' } as const
const REACH_TERMINAL = { id: 'vtr-reach-terminal', version: 'vtr-reach/v1' } as const
const REACH_WITNESS = { id: 'vtr-reach-witness', version: 'vtr-witness/v1' } as const
const REACH_MISSION_AUTHORITY = { id: 'host-mission-authority', version: 'v1' } as const

export const REACH_AUTHORITY_REGISTRY = {
  compiler: REACH_COMPILER,
  verifier: REACH_VERIFIER,
  progress: REACH_PROGRESS,
  controller: REACH_CONTROLLER,
  terminal: REACH_TERMINAL,
  witness: REACH_WITNESS,
  missionAuthority: REACH_MISSION_AUTHORITY,
} as const

const CONTROLLER_COMPILER = { id: 'vtr-controller-compiler', version: 'vtr-controller/v4' } as const
const CONTROLLER_PROGRESS = { id: 'vtr-controller-progress', version: 'mechanical_outcome/v1' } as const
const CONTROLLER_DEF = { id: 'vtr-controller', version: 'vtr-controller/v4' } as const
const CONTROLLER_TERMINAL = { id: 'vtr-controller-terminal', version: 'vtr-controller/v1' } as const

export const CONTROLLER_AUTHORITY_REGISTRY = {
  compiler: CONTROLLER_COMPILER,
  progress: CONTROLLER_PROGRESS,
  controller: CONTROLLER_DEF,
  terminal: CONTROLLER_TERMINAL,
} as const

/**
 * Reach admissible-effect kind -> kernel (claims, effect permit). The Reach
 * contract declares `locomotion` today; the table is explicit so a new effect
 * kind fails closed at session registration instead of silently mapping.
 */
const REACH_EFFECT_MAP: Readonly<Record<string, {
  readonly claims: readonly KernelResourceRequirement[]
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
  const claims: KernelResourceRequirement[] = []
  const effects: Array<{ kind: EffectKind; scope: string; irreversible: boolean; maxCount: number; requiredResources: readonly KernelResourceRequirement[] }> = []
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
      progressDefinition: REACH_PROGRESS,
      controllerDefinition: REACH_CONTROLLER,
      verificationDefinition: REACH_VERIFIER,
      terminalPolicy: REACH_TERMINAL,
      witnessValidation: REACH_WITNESS,
    },
  }
}

// ---------------------------------------------------------------------------
// Kernel session input contract (emitted by semantic code and the mutation
// boundary; consumed only by the host-side kernel session)
// ---------------------------------------------------------------------------

/** Executor action context at the moment a mutation dispatch was observed. */
export interface MutationAuthorityContext {
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

// ---------------------------------------------------------------------------
// V4.1.2 kernel authority gate
// ---------------------------------------------------------------------------

export type KernelGateVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * One verified world observation fed into the kernel fact store. The authority
 * gate consumes these unconditionally: they are the only facts VERIFY reads.
 */
export interface KernelWorldObservation {
  readonly observedAtMs: number
  readonly predicates: Readonly<Record<string, { readonly truth: 'true' | 'false' | 'unknown'; readonly evidenceId: string | null }>>
}

/**
 * Host-owned kernel gate: the only runtime authority for transition lifecycle,
 * resources, effects and SUCCESS.
 *
 * Every call returns the real kernel verdict and the caller MUST honor a denial by not performing the
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
export interface KernelTransitionAuthority {
  /** Feed a verified world observation into the kernel fact store (no verdict). */
  feedObservation(input: KernelWorldObservation): void
  /** Contract legality + mission authorization + admission gate before production commit. */
  admitTransition(contract: ReachTransitionContract): KernelGateVerdict
  /**
   * Kernel-spec admission for non-Reach transition families (controller
   * transitions). The caller compiles the spec; the gate performs legality,
   * mission authorization and admission exactly as `admitTransition`.
   */
  admitContract(spec: TransitionContractSpec): { readonly ok: true; readonly contractHash: string } | { readonly ok: false; readonly reason: string }
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

// ---------------------------------------------------------------------------
// Controller transition -> kernel contract
// ---------------------------------------------------------------------------

/**
 * Mutation surfaces a committed mechanical skill may emit. The envelope is
 * declared per committed SkillKind so a controller transition holds exactly the
 * resource leases its own mechanics need - no more, no less. An observed
 * mutation outside the envelope is a hard session blocker, never silently
 * attributed.
 */
const BODY_SURFACES: readonly string[] = [
  'bot.setControlState',
  'bot.clearControlStates',
  'bot.look',
  'bot.lookAt',
  'bot.swingArm',
  'bot.mount',
  'bot.dismount',
  'pathfinder.setGoal',
  'pathfinder.setMovements',
  'pathfinder.goto',
  'pathfinder.stop',
  'collectBlock.collect',
  'entity.position.write',
  'entity.yaw',
  'entity.pitch',
  'entity.onGround',
  'entity.velocity.write',
  'bot.physicsEnabled',
]
const WORLD_SURFACES: readonly string[] = [
  'bot.dig',
  'bot.stopDigging',
  'bot.placeBlock',
  'bot._placeBlockWithOptions',
  'bot.useOn',
  'bot.updateSign',
  'bot.activateBlock',
]
const INVENTORY_SURFACES: readonly string[] = [
  'bot.equip',
  'bot.unequip',
  'bot.toss',
  'bot.tossStack',
  'bot.setQuickBarSlot',
  'bot.clickWindow',
  'bot.transfer',
  'bot.withdraw',
  'bot.deposit',
  'bot.putSelectedItemRange',
  'window.withdraw',
  'window.deposit',
]
const WINDOW_SURFACES: readonly string[] = [
  'bot.openBlock',
  'bot.openContainer',
  'bot.openFurnace',
  'bot.openEnchantmentTable',
  'bot.openVillager',
  'bot.openAnvil',
  'bot.closeWindow',
  'window.putInput',
  'window.putFuel',
  'window.takeInput',
  'window.takeFuel',
  'window.takeOutput',
  'window.close',
]
const ITEM_SURFACES: readonly string[] = ['bot.activateItem', 'bot.deactivateItem', 'bot.consume']
/**
 * The equip operation itself plus the hotbar plumbing mineflayer may emit while
 * fulfilling it. Locomotion families declare this envelope because approach,
 * staircase and pillar recovery can equip a harvest tool or a placeable block
 * mid-leg (executor `cutApproachStep` / `pillarUp`); without it every such
 * effect is refused as `effect-not-permitted` and the body deadlocks.
 */
const EQUIP_SURFACES: readonly string[] = [
  'bot.equip',
  'bot.unequip',
  'bot.setQuickBarSlot',
  'bot.putSelectedItemRange',
]

export const CONTROLLER_TRANSITION_SURFACES: Readonly<Record<string, readonly string[]>> = {
  walk_to: [...BODY_SURFACES, ...WORLD_SURFACES, ...EQUIP_SURFACES],
  retreat: [...BODY_SURFACES, ...WORLD_SURFACES, ...EQUIP_SURFACES],
  enter_portal: [...BODY_SURFACES, ...WORLD_SURFACES, ...EQUIP_SURFACES],
  descend: [...BODY_SURFACES, ...WORLD_SURFACES, ...EQUIP_SURFACES],
  step: [...BODY_SURFACES, ...WORLD_SURFACES, ...EQUIP_SURFACES],
  retrieve: [...BODY_SURFACES, ...WORLD_SURFACES, ...EQUIP_SURFACES],
  mine: [...BODY_SURFACES, ...WORLD_SURFACES, ...INVENTORY_SURFACES, ...ITEM_SURFACES],
  place: [...BODY_SURFACES, ...WORLD_SURFACES, ...INVENTORY_SURFACES, ...ITEM_SURFACES],
  craft: [...BODY_SURFACES, ...WORLD_SURFACES, ...INVENTORY_SURFACES, ...WINDOW_SURFACES, 'bot.craft'],
  smelt: [...BODY_SURFACES, ...WORLD_SURFACES, ...INVENTORY_SURFACES, ...WINDOW_SURFACES],
  withdraw: [...BODY_SURFACES, ...WORLD_SURFACES, ...INVENTORY_SURFACES, ...WINDOW_SURFACES],
  ignite: [...BODY_SURFACES, ...WORLD_SURFACES, ...INVENTORY_SURFACES, ...ITEM_SURFACES],
  kill: [...BODY_SURFACES, ...INVENTORY_SURFACES, 'bot.attack'],
  hunt_drop: [...BODY_SURFACES, ...INVENTORY_SURFACES, 'bot.attack'],
  hold_item: INVENTORY_SURFACES,
  equip_item: INVENTORY_SURFACES,
  eat: [...INVENTORY_SURFACES, ...ITEM_SURFACES],
  wait: [],
  escalate: [],
}

export interface ControllerTransitionSpecInput {
  readonly transitionId: string
  /** Committed mechanical skill family (the transition family). */
  readonly family: string
  /** Kernel predicate identity of the skill's declared postcondition. */
  readonly desiredPredicate: string
  readonly world: WorldIdentity
  readonly maxMechanicalSteps: number
  readonly maxActiveMs: number
}

/**
 * Effects the body can undo without changing world/inventory truth. Every other
 * kind (dig, place, craft, consume, attack, container/station/inventory
 * mutation, interact, command) is declared irreversible so the kernel's
 * crash-ambiguity rules treat an unreconciled dispatch as possibly happened.
 */
const REVERSIBLE_EFFECT_KINDS: ReadonlySet<EffectKind> = new Set<EffectKind>(['MOVE', 'LOOK', 'EQUIP'])

/**
 * Compile a controller transition (a production-dispatched mechanical skill
 * commitment) into a V4.1.2 TransitionContractSpec. The contract's resource
 * claims are the union of every mutation surface the committed skill family
 * may emit; each declared effect permit carries its own required resources so
 * an effect can never execute outside the lease it names. `requires` and
 * `invariants` are empty by construction: controller transitions fence
 * actuation, they do not re-verify the scheduler's grounding (the guard and
 * the deterministic VERIFY remain the truth boundary for precondition truth).
 */
export function controllerTransitionToKernelSpec(
  input: ControllerTransitionSpecInput,
): ReachKernelContractResult {
  const surfaces = CONTROLLER_TRANSITION_SURFACES[input.family]
  if (surfaces === undefined) {
    return { ok: false, reason: `unmapped controller transition family ${input.family}` }
  }
  const claims: KernelResourceRequirement[] = []
  const effects: Array<{ kind: EffectKind; scope: string; irreversible: boolean; maxCount: number; requiredResources: readonly KernelResourceRequirement[] }> = []
  for (const surface of surfaces) {
    const mapped = MUTATION_SURFACE_MAP[surface]
    if (mapped === undefined) return { ok: false, reason: `unmapped mutation surface ${surface}` }
    for (const resource of mapped.resources) {
      const dedupeKey = `${resource.domain}|${resource.path.join('/')}|${resource.instance}`
      if (!claims.some((existing) => `${existing.domain}|${existing.path.join('/')}|${existing.instance}` === dedupeKey)) claims.push(resource)
    }
    if (!effects.some((existing) => existing.kind === mapped.effect)) {
      effects.push({
        kind: mapped.effect,
        scope: `controller:${mapped.scope}`,
        irreversible: !REVERSIBLE_EFFECT_KINDS.has(mapped.effect),
        maxCount: input.maxMechanicalSteps,
        requiredResources: mapped.resources,
      })
    }
  }
  return {
    ok: true,
    spec: {
      transitionId: input.transitionId,
      family: input.family,
      class: 'MISSION',
      urgency: 0,
      world: input.world,
      desiredPredicate: input.desiredPredicate,
      requires: [],
      ensures: [input.desiredPredicate],
      invariants: [],
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
        maxActiveMs: input.maxActiveMs,
        deadlineAtMonoMs: null,
        maxMechanicalSteps: input.maxMechanicalSteps,
        resources: {},
        risk: {},
      },
      progressDefinition: CONTROLLER_PROGRESS,
      controllerDefinition: CONTROLLER_DEF,
      verificationDefinition: REACH_VERIFIER,
      terminalPolicy: CONTROLLER_TERMINAL,
      witnessValidation: null,
    },
  }
}
