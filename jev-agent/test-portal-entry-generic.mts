// test-portal-entry-generic.mts - the portal entry is GENERIC locomotion, not a
// bespoke approach planner.
//
// Proves, offline:
//   (A) the generic standability rule (`isStandable`) admits a NON-PORTAL,
//       non-solid cell over solid support - it is a general body-occupancy rule,
//       not a portal special case;
//   (B) on the exact live portal geometry (frame origin (25,66,9), plane z=9,
//       interior x 26..27 y 67..69, front ground one row below at (26,66,8)) the
//       only standable interior cells are the LOWEST row (26,67,9)/(27,67,9);
//       the row above is NOT standable because its block below is the portal
//       itself, so entering that row would be a 1-block step up from the front
//       ground - the generic mover's job;
//   (C) `planPortalEntry` picks that standable interior cell as `enterCell` and
//       keeps the typed `portal_not_lit` / `no_safe_approach` /
//       `already_in_dimension` refusals.
//
// Run: bun test ./test-portal-entry-generic.mts
import type { Bot } from 'mineflayer'
import {
  NETHER,
  NETHER_PORTAL,
  OVERWORLD,
  planPortalEntry,
  portalFrameLayout,
} from './src/netherPortalPlan.ts'
import type { PortalBlockPosition, PortalEntryPlan, PortalFrameSite } from './src/netherPortalPlan.ts'
import { isStandable } from './src/state.ts'
import type { Vec3Json } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

const key = (p: Vec3Json): string => `${p.x},${p.y},${p.z}`

// ---------------------------------------------------------------------------
// a minimal fake bot: isStandable only needs entity.position.clone().set and
// blockAt, so the generic rule can be exercised with no server and no world.
// ---------------------------------------------------------------------------
class P {
  x: number
  y: number
  z: number
  constructor(x = 0, y = 0, z = 0) {
    this.x = x
    this.y = y
    this.z = z
  }
  clone(): P {
    return new P(this.x, this.y, this.z)
  }
  set(x: number, y: number, z: number): P {
    this.x = x
    this.y = y
    this.z = z
    return this
  }
}

interface GridBlock {
  name: string
  boundingBox: string
}

function fakeBot(grid: Map<string, GridBlock>): Bot {
  const position = new P()
  return {
    entity: { position },
    blockAt: (v: { x: number; y: number; z: number }) => {
      const cell = grid.get(`${Math.floor(v.x)},${Math.floor(v.y)},${Math.floor(v.z)}`)
      if (cell === undefined) return null
      return { name: cell.name, boundingBox: cell.boundingBox, position: new P(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)) }
    },
  } as unknown as Bot
}

function standableAt(grid: Map<string, GridBlock>, cell: Vec3Json): boolean {
  return isStandable(fakeBot(grid), cell)
}

// ---------------------------------------------------------------------------
// (A) generality: a non-portal, non-solid cell over solid support is standable
// ---------------------------------------------------------------------------
{
  const grid = new Map<string, GridBlock>()
  // `short_grass` is a decoration with no collision (boundingBox 'empty') - the
  // same physical class as a nether_portal block: passable, not support.
  grid.set('0,10,0', { name: 'short_grass', boundingBox: 'empty' })
  grid.set('0,11,0', { name: 'air', boundingBox: 'empty' })
  grid.set('0,9,0', { name: 'stone', boundingBox: 'block' })
  const ok = standableAt(grid, { x: 0, y: 10, z: 0 }) === true && standableAt(grid, { x: 0, y: 11, z: 0 }) === false
  check(
    '(A) the generic standability rule admits a non-portal non-solid cell over solid support',
    ok,
    `short_grass@(0,10,0)=${standableAt(grid, { x: 0, y: 10, z: 0 })} air-above-support@(0,11,0)=${standableAt(grid, { x: 0, y: 11, z: 0 })}`,
  )
}

// ---------------------------------------------------------------------------
// the exact live geometry measured by the read-only probe (source f13aac2):
// frame origin (25,66,9) widthAxis x, plane z=9, interior x 26..27 y 67..69,
// front ground (leaf_litter over grass) at feet y=66 in front of the frame.
// ---------------------------------------------------------------------------
const LIVE_ORIGIN: PortalBlockPosition = { x: 25, y: 66, z: 9 }
const LIVE_LAYOUT = portalFrameLayout(LIVE_ORIGIN, 'x')
const LIVE_ENTER: Vec3Json = { x: 26, y: 67, z: 9 }
const LIVE_FRONT_STAND: Vec3Json = { x: 26, y: 66, z: 8 }

function liveGrid(lit: boolean, floorSolid: boolean): Map<string, GridBlock> {
  const grid = new Map<string, GridBlock>()
  const set = (x: number, y: number, z: number, name: string, boundingBox: string): void => {
    grid.set(`${x},${y},${z}`, { name, boundingBox })
  }
  // frame ring at z=9 (the corners were cobblestone live; both are solid)
  for (const cell of LIVE_LAYOUT.frame) set(cell.x, cell.y, cell.z, 'obsidian', 'block')
  for (const cell of LIVE_LAYOUT.corners) set(cell.x, cell.y, cell.z, 'cobblestone', 'block')
  // interior: lit -> nether_portal (empty), unlit -> air
  for (const cell of LIVE_LAYOUT.interior) set(cell.x, cell.y, cell.z, lit ? NETHER_PORTAL : 'air', 'empty')
  // the frame's solid bottom row is the floor of the lowest interior row
  if (!floorSolid) for (const x of [26, 27]) set(x, LIVE_ORIGIN.y, 9, 'air', 'empty')
  // front of the frame (z=8): leaf_litter/empty at y=66 over grass/block at y=65
  for (const x of [25, 26, 27, 28, 29, 30]) set(x, 66, 8, 'leaf_litter', 'empty')
  for (const x of [25, 26, 27, 28, 29, 30]) set(x, 65, 8, 'grass_block', 'block')
  set(26, 67, 8, 'air', 'empty')
  set(26, 68, 8, 'air', 'empty')
  return grid
}

const liveGridLit = liveGrid(true, true)
const LIVE_SITE: PortalFrameSite = { origin: LIVE_ORIGIN, widthAxis: 'x', safe: true, reachable: true, existingFrame: LIVE_LAYOUT.frame }
const liveBlockAt = (cell: Vec3Json): string | null => liveGridLit.get(key(cell))?.name ?? null
const liveIsStandable = (cell: PortalBlockPosition): boolean => standableAt(liveGridLit, cell)

// ---------------------------------------------------------------------------
// (B) on the live geometry only the lowest interior row is standable, and the
//     front ground is one row below it (the step up the generic mover must own)
// ---------------------------------------------------------------------------
{
  const feetLower = { x: 26, y: 67, z: 9 }
  const feetMiddle = { x: 26, y: 68, z: 9 }
  const feetFront = { ...LIVE_FRONT_STAND }
  const frontGround = { x: 26, y: 65, z: 8 }
  const ok =
    standableAt(liveGridLit, feetLower) === true &&
    standableAt(liveGridLit, feetMiddle) === false &&
    standableAt(liveGridLit, feetFront) === true &&
    // the front stand's floor is one row BELOW the entry cell's floor: the only
    // route into the portal is a generic 1-block step up.
    feetFront.y === feetLower.y - 1 &&
    liveGridLit.get(key(frontGround))?.name === 'grass_block'
  check(
    '(B) live geometry: the lowest interior row is the standable entry; the row above is not',
    ok,
    `enter(26,67,9)=${standableAt(liveGridLit, feetLower)} row-above(26,68,9)=${standableAt(liveGridLit, feetMiddle)} frontStand(26,66,8)=${standableAt(liveGridLit, feetFront)} frontFloor=${liveGridLit.get(key(frontGround))?.name}`,
  )
}

// ---------------------------------------------------------------------------
// (C) planPortalEntry picks the standable interior cell and keeps the refusals
// ---------------------------------------------------------------------------
{
  // Even standing nearest the middle row, the chosen cell is the standable
  // lowest row - not a higher interior row.
  const plan: PortalEntryPlan = planPortalEntry({
    site: LIVE_SITE,
    self: { x: 26, y: 69, z: 8 },
    blockAt: liveBlockAt,
    isStandable: liveIsStandable,
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  const grounded = plan.ok && key(plan.candidate.enterCell) === key(LIVE_ENTER) && plan.candidate.enterCell.y === 67
  const detail = plan.ok ? `enterCell=${key(plan.candidate.enterCell)}` : `refused=${plan.line}`

  const unlit = planPortalEntry({
    site: LIVE_SITE,
    self: LIVE_FRONT_STAND,
    blockAt: (cell) => (liveGrid(false, true).get(key(cell))?.name ?? null),
    isStandable: (cell) => standableAt(liveGrid(false, true), cell),
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  const noFloor = planPortalEntry({
    site: LIVE_SITE,
    self: LIVE_FRONT_STAND,
    blockAt: (cell) => (liveGrid(true, false).get(key(cell))?.name ?? null),
    isStandable: (cell) => standableAt(liveGrid(true, false), cell),
    fromDimension: OVERWORLD,
    dimension: NETHER,
  })
  const already = planPortalEntry({
    site: LIVE_SITE,
    self: LIVE_FRONT_STAND,
    blockAt: liveBlockAt,
    isStandable: liveIsStandable,
    fromDimension: NETHER,
    dimension: NETHER,
  })
  const ok =
    grounded &&
    !unlit.ok &&
    unlit.reason === 'portal_not_lit' &&
    unlit.line === 'PRECONDITION_MISSING portal=lit' &&
    !noFloor.ok &&
    noFloor.reason === 'no_safe_approach' &&
    noFloor.line === 'PRECONDITION_MISSING approach=safe_stand' &&
    !already.ok &&
    already.reason === 'already_in_dimension'
  check(
    '(C) planPortalEntry chooses the standable interior cell and keeps the typed refusals',
    ok,
    `${detail} unlit=[${unlit.ok ? 'ok' : unlit.line}] noFloor=[${noFloor.ok ? 'ok' : noFloor.line}] already=[${already.ok ? 'ok' : already.line}]`,
  )
}

process.stdout.write(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`)
if (failures > 0) process.exit(1)
