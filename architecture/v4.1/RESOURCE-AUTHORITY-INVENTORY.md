# V4.1.2 Production Resource / Mutation Inventory

This inventory is derived from the live repository surfaces, not only from the architecture document. Its purpose is to define the resource/effect authority that Phase 1 must shadow before any VTR kernel authority reaches production. Candidate resources below are hypotheses to validate at the adapter boundary, not claims that Mineflayer aliases are already proven.

## Audited source surfaces

- `jev-agent/src/actuationPort.ts`: explicit generation-side allowlist capability and its 16 operations.
- `buddy-driver/resident-safety.ts`: `MUTATING_BOT_METHODS`, nested `pathfinder`, `_client`, `collectBlock`, mutable `entity`/Vec3 guards, and `createActuationPort`.
- `jev-agent/src/executor.ts`: direct production calls to pathfinder/control state, dig/place, equip/consume, look/attack, craft, container/furnace, activateBlock, collectblock, and direct pose mutation.

The resident proxy provides generation-level containment for many nested calls. V4.1.2 additionally needs transition/contract/resource/effect authority at the exact mutation boundary.

## 1. Canonical resource families

| Canonical resource | Typical children / instances | Mutation meaning |
| --- | --- | --- |
| `body` | `body.locomotion`, `body.orientation`, `body.pose` | physical player motion/pose |
| `interaction` | block/entity interaction channel | right-click/use/open interaction |
| `attack` | `attack.entity#<id>` | melee attack dispatch |
| `inventory` | slot/window/player inventory | item count/slot mutation |
| `equipment` | hand/offhand/armor destination | equipped-item mutation |
| `world.blocks` | block coordinate / region | dig/place/world block mutation |
| `entity` | `entity#<id>` | target entity-affecting operation |
| `station` | furnace/crafting-table instance | workstation process mutation |
| `container` | chest/barrel/etc instance | remote inventory mutation |
| `window` | current Mineflayer window/session | click/transfer session ownership |
| `observation` | passive world/entity reads | read-only sensing |
| `memory.worldModel` | append-safe records | deterministic APPEND only |
| `command` | chat/command channel | server command/chat side effects |

Resource aliases must be canonicalized before lease comparison. A method name is not a resource identity; several methods below mutate the same physical authority.
## 2. Existing ActuationPort coverage

| ActuationPort operation | Required resource authority | Effect permit | Notes |
| --- | --- | --- | --- |
| `pathTo`, `stopPath`, `setControls`, `clearControls` | `body.locomotion:EXCLUSIVE_WRITE` | `MOVE` | pathfinder/control-state share one body owner |
| `lookAt` | `body.orientation:EXCLUSIVE_WRITE` | `LOOK` | may be implicitly invoked by other Mineflayer operations |
| `dig` | `body.orientation` + `world.blocks#coord` | `DIG` | `forceLook='ignore'` changes orientation requirement only when adapter proves no implicit look |
| `placeBlock` | `body.orientation` + `interaction` + `world.blocks#coord` + inventory consumption | `PLACE` | Mineflayer generic placement may call `lookAt` internally |
| `activateItem` | `interaction` + relevant `equipment` | `INTERACT`/`CONSUME` | offhand/hand identity matters |
| `activateBlock` | `interaction` + block/station instance | `INTERACT` | block-specific alias required |
| `equip` | `inventory` + `equipment#destination` | `EQUIP` | hand/equipment are aliases of inventory slot mutation |
| `collect` | `body.locomotion` + `entity#id` + eventual `inventory` | `MOVE`/acquisition | collectblock drives pathfinder internally |
| `craft` | `inventory` + optional `station#crafting-table` + `window` | `CRAFT` | table crafting may open/use a window |
| `openContainer` | `interaction` + `container#coord` + `window` | `INTERACT` | opening alone does not authorize transfer |
| `withdrawFromContainer` | `container#coord` + `window` + `inventory` | `INVENTORY_MUTATION` | nested `window.withdraw -> clickWindow -> _client.write` |
| `writeMovementPacket` | `body.locomotion` + possibly `body.orientation` | `MOVE` | raw protocol actuator; packet schema determines exact subresources |
| `setPose` | `body.pose`; orientation if yaw/pitch set | `MOVE`/`LOOK` | direct shared entity state mutation |

The current port is generation-lease protected, but V4.1.2 additionally requires a transition/effect capability tied to the exact contract, live binding, lease bundle, and effect permit.
## 3. Production mutation surfaces not fully represented by ActuationPort

The executor currently reaches several mutators directly. These are migration blockers until they are either added to the allowlist adapter or removed from production paths.

| Surface observed in production code | Existing generation guard | V4.1.2 status | Required fix |
| --- | --- | --- | --- |
| `bot.attack(entity)` | no explicit top-level `MUTATING_BOT_METHODS` entry; nested calls may still hit guarded surfaces | **BLOCKER** | add an explicit attack adapter/port operation so transition authority is checked at the semantic dispatch boundary; exact body/orientation/entity aliases require live proof |
| `bot.openFurnace(block)` | no explicit top-level `MUTATING_BOT_METHODS` entry and no ActuationPort method; implementation may delegate to other guarded calls | **BLOCKER** | add an explicit furnace/station adapter; candidate authority is `interaction + station instance + window`, to be verified live |
| `bot.consume()` | generation proxy guards `consume`, but ActuationPort has no `consume` method | BLOCKER for VTR adapter | expose explicit consume operation bound to inventory/equipment/interaction and `CONSUME` permit |
| `bot.pathfinder.setMovements(...)` | nested pathfinder proxy guards it, ActuationPort does not expose it | BLOCKER for complete capability accounting | model as locomotion-controller configuration under `body.locomotion`, not as free mutation |
| direct `pathfinder.setGoal/stop` | nested proxy guards; port covers normal pathTo/stopPath | migrate | all production callers must go through adapter so transition lease is checked, not just generation lease |
| direct `bot.setControlState(...)` | generation proxy guards | migrate | route through transition-scoped locomotion adapter |
| direct `bot.lookAt(...)` | generation proxy guards | migrate | route through orientation adapter/effect capability |
| direct `bot.equip(...)` | generation proxy guards | migrate | route through inventory/equipment adapter |
| direct `bot.placeBlock(...)` / `bot.dig(...)` | generation proxy guards | migrate | route through world-block effect adapter |
| direct `_client.write` / `entity.position.set` | nested generation guard exists | high-risk migrate | retain only behind narrowly typed movement adapter; never expose raw object |
| `collectBlock.collect(...)` | nested generation guard exists | high-risk migrate | adapter must claim locomotion + target entity and account for resulting inventory change |

A generation lease is necessary but insufficient: V4.1.2 requires *both* current generation ownership and current transition/resource/effect authority. Absence from the explicit top-level set is not treated here as proof that every nested implementation path is unguarded; it is evidence that V4.1.2 cannot rely on one auditable semantic dispatch capability yet.
## 4. Required alias / hidden-resource rules

1. `body` overlaps all `body.*`; locomotion and orientation are siblings and may coexist only when the underlying Mineflayer primitive does not couple them.
2. A primitive that implicitly calls `lookAt` must claim `body.orientation` even if its public method name is `placeBlock`, `dig`, `openBlock`, or another interaction.
3. Pathfinder goal, movement configuration, control-state writes, packet stepping, and direct pose movement all alias `body.locomotion`.
4. Yaw/pitch writes and explicit look methods alias `body.orientation`; a combined movement packet can require both locomotion and orientation.
5. Player inventory slots, hotbar selection, equipment destinations, crafting grids, and window transfers share inventory authority; narrower child resources are allowed only after adapter-level evidence proves disjoint mutation.
6. Container/furnace/crafting windows require a `window` session resource in addition to the semantic station/container instance. A stale window must never survive generation/world boundary.
7. `world.blocks#coord` should be coordinate-instance scoped for direct dig/place, while pathfinder must not inherit general block mutation authority unless digging/placing is explicitly enabled by the contract.
8. `entity#id` scopes attack/collect/interact target authority; entity identity must be revalidated after suspension or world/generation changes.
9. `APPEND` is legal only for resources registered as deterministic/idempotent append stores; it is never a generic substitute for shared writes.
10. Raw `_client`, raw Bot, plugin objects, currentWindow, and mutable entity objects are implementation details, never semantic resources or exported capabilities.

## 5. Phase 1 shadow-wiring gate

Before production authority is enabled, a runtime audit must show: every mutation path maps to one canonical resource bundle; every irreversible operation maps to an effect permit; every adapter validates current world/generation/transition/contract/lease/effect capability; hidden Mineflayer mutation is represented in aliases; and no production path can reach an uncovered mutator.

Required automated checks: static mutation-surface scan, ActuationPort surface lock test, resident nested-capability test, transition/effect-capability adapter test, resource alias overlap fixtures, and a live shadow log comparing observed mutation calls against the kernel-declared bundle. Any unmapped mutation is fail-closed for migration.