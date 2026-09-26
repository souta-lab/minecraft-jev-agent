// actuationPort.ts - Issue #38: the ALLOWLIST actuation capability.
//
// Before #38 the reload contract passed a live `Bot` (wrapped by a *denylist*
// proxy) to the generation. A denylist over a huge mutable object graph is
// bypassable: `bot._client.write`, `bot.collectBlock.collect` and direct
// `bot.entity.position.set` never matched the top-level mutator list.
//
// This module defines the explicit allowlist the generation may actuate
// through: a small capability object whose every method asserts the HOST-owned
// actuation lease immediately before delegating to Mineflayer. Raw `Bot`
// property access is NOT part of this contract.
//
// The interface lives in jev-agent (the lower layer) so the Executor can depend
// on the type without importing the resident host. The implementation lives in
// `buddy-driver/resident-safety.ts` (the host/generation boundary), next to
// `withActuationLease` which enforces the same lease at the proxy level.
//
// This module is dependency-free: consumers import the interface with
// `import type`, and the operation list is a small frozen runtime value.
import type { Block } from 'prismarine-block'
import type { Entity } from 'prismarine-entity'
import type { Item } from 'prismarine-item'
import type { Vec3 } from 'vec3'

/** A single pose write applied to the live bot entity during packet stepping. */
export interface ActuationPose {
  x: number
  y: number
  z: number
  yaw?: number
  pitch?: number
  onGround?: boolean
}

/**
 * The allowlisted actuation surface. Every method MUST assert the lease (via
 * `assertLease`/the implementation's own assert) before the side effect. There
 * is deliberately no `bot`/`_client`/`collectBlock`/`entity` escape hatch here.
 */
export interface ActuationPort {
  /** the generation id this port leases for (read-only) */
  readonly generationId: string
  /** assert the lease now; throws ACTUATION_LEASE_DENIED when this generation is not the active owner */
  assertLease(what: string): void
  // move / path
  pathTo(goal: unknown): void
  stopPath(): void
  setControls(controls: Record<string, boolean>): void
  clearControls(): void
  lookAt(point: Vec3, force?: boolean): Promise<void>
  // dig / place
  dig(block: Block, forceLook?: 'ignore'): Promise<void>
  placeBlock(refBlock: Block, face: Vec3): Promise<void>
  // use item / equip
  activateItem(offhand?: boolean): Promise<void>
  activateBlock(block: Block, face?: Vec3): Promise<void>
  equip(item: Item, destination?: string | string[]): Promise<void>
  // collect
  collect(entity: Entity, options?: unknown): Promise<unknown>
  // craft
  craft(recipe: unknown, count?: number, craftingTable?: Block): Promise<void>
  // container / smelt window
  /**
   * Open a container block (chest / trapped_chest / barrel / ender_chest /
   * shulker box) and resolve with the live window. `face` is the `block_place`
   * direction the body's own stand derives (`deriveInteractionFace`): a wrong
   * face makes the server reject the interaction and the open only surfaces 20s
   * later as mineflayer's `windowOpen` timeout, so it is part of the contract.
   */
  openContainer(block: Block, face?: Vec3): Promise<unknown>
  /**
   * Move `count` items out of the CURRENTLY OPEN container window into the
   * inventory, asserting the lease at the transfer itself. Mineflayer's window
   * object writes its slot clicks on the raw client (`window.withdraw` ->
   * `clickWindow` -> `bot._client.write`), so without this method a transfer
   * would be a nested actuation bypass (#38); every container transfer goes
   * through here when the resident provides a port.
   */
  withdrawFromContainer(itemName: string, count: number): Promise<unknown>
  // raw movement packet + entity pose mutation (the two #38 bypasses)
  writeMovementPacket(name: string, payload: Record<string, unknown>): void
  setPose(pose: ActuationPose): void
}

/**
 * The allowlisted operation names. Exported so the generation can log exactly
 * what it was granted (`ACTUATION_PORT_READY`) and so an audit test can assert
 * the surface did not silently grow or shrink.
 */
export const ACTUATION_PORT_OPERATIONS = [
  'pathTo',
  'stopPath',
  'setControls',
  'clearControls',
  'lookAt',
  'dig',
  'placeBlock',
  'activateItem',
  'activateBlock',
  'equip',
  'collect',
  'craft',
  'openContainer',
  'withdrawFromContainer',
  'writeMovementPacket',
  'setPose',
] as const

export type ActuationOperation = (typeof ACTUATION_PORT_OPERATIONS)[number]
