// test-place-reference.mts - interactive-block place-reference ordering.
//
// Measured live defect (portal-p23, gen-mutlkyij-h4alup, 2026-10-04T09:15:56-
// 09:16:03Z): after the first crafting_table was placed at (4,79,22), six
// consecutive PLACE attempts for the second table failed `place_refused` into
// cells around it. A placement solver that only checks `boundingBox ===
// 'block'` happily picks the just-placed station as the reference face for an
// adjacent cell; a plain use-on click on an interactive block activates it
// (GUI/ scripted use) instead of placing, so the destination stays air and the
// server answers "the block is still air".
//
// The fix has two mechanical halves, both pinned here:
//   1. `placeReferenceChoice` prefers a non-interactive solid neighbour in the
//      old direction order and keeps the first interactive one as fallback -
//      the same cell that refused now places against real ground.
//   2. When the only solid neighbour IS interactive, the fallback reference is
//      still returned, and `placeBlockAgainst` sneak-clicks (vanilla places
//      instead of activating). The set membership is pinned for the blocks the
//      campaign actually places near.
//
// Run: bun test-place-reference.mts
import {
  INTERACTIVE_PLACE_REFERENCE_BLOCKS,
  placeReferenceChoice,
} from './src/executor.ts'
import type { Vec3Json } from './src/state.ts'

let failures = 0
function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${label}\n      ${detail}\n`)
  if (!ok) failures += 1
}

interface FakeBlock {
  name: string
  boundingBox: string
}
const air: FakeBlock | null = null
const solid = (name: string): FakeBlock => ({ name, boundingBox: 'block' })
const partial = (name: string): FakeBlock => ({ name, boundingBox: 'empty' })

const DIRECTIONS = [
  { offset: { x: 0, y: -1, z: 0 }, face: { x: 0, y: 1, z: 0 } },
  { offset: { x: 1, y: 0, z: 0 }, face: { x: -1, y: 0, z: 0 } },
  { offset: { x: -1, y: 0, z: 0 }, face: { x: 1, y: 0, z: 0 } },
  { offset: { x: 0, y: 0, z: 1 }, face: { x: 0, y: 0, z: -1 } },
  { offset: { x: 0, y: 0, z: -1 }, face: { x: 0, y: 0, z: 1 } },
  { offset: { x: 0, y: 1, z: 0 }, face: { x: 0, y: -1, z: 0 } },
] as const

function neighbors(blocks: (FakeBlock | null)[]) {
  return blocks.map((block, i) => ({ block, direction: DIRECTIONS[i]! }))
}

// 1. Old behaviour preserved: first solid neighbour wins (below first).
{
  const picked = placeReferenceChoice(neighbors([solid('dirt'), solid('stone'), air, air, air, air]))
  check(
    'first-solid-first-order',
    picked !== null && picked.block.name === 'dirt' && picked.face.y === 1,
    `picked=${picked?.block.name ?? 'null'} face=${JSON.stringify(picked?.face ?? null)}`,
  )
}

// 2. An interactive neighbour earlier in the order loses to a later plain
//    solid face - the measured crafting_table-adjacent shape.
{
  const picked = placeReferenceChoice(
    neighbors([solid('crafting_table'), solid('grass_block'), air, air, air, air]),
  )
  check(
    'interactive-skipped-for-plain-solid',
    picked !== null && picked.block.name === 'grass_block',
    `picked=${picked?.block.name ?? 'null'} (want grass_block, not crafting_table)`,
  )
}

// 3. When the ONLY solid neighbour is interactive it is still returned, so the
//    sneak-click actuator can place against it rather than reporting
//    no_support.
{
  const picked = placeReferenceChoice(neighbors([solid('furnace'), air, air, air, air, air]))
  check(
    'interactive-only-fallback',
    picked !== null && picked.block.name === 'furnace' && picked.face.y === 1,
    `picked=${picked?.block.name ?? 'null'} (want furnace fallback)`,
  )
}

// 4. Nothing solid -> null (old `no supporting block adjacent` path).
{
  const picked = placeReferenceChoice(neighbors([air, partial('tall_grass'), air, air, air, air]))
  check('nothing-solid-null', picked === null, `picked=${JSON.stringify(picked)}`)
}

// 5. The exact measured ordering: placed table lateral, solid ground below ->
//    below wins, so the next place does not need the sneak path at all.
{
  const picked = placeReferenceChoice(
    neighbors([solid('dirt'), air, air, air, solid('crafting_table'), air]),
  )
  check(
    'measured-shape-below-wins',
    picked !== null && picked.block.name === 'dirt' && picked.face.y === 1,
    `picked=${picked?.block.name ?? 'null'} face=${JSON.stringify(picked?.face ?? null)}`,
  )
}

// 6. The interactive set covers the blocks the frontier actually places next
//    to - station chain + containers + common GUI blocks - and excludes plain
//    building blocks so normal placement keeps the old path.
{
  const want = [
    'crafting_table',
    'furnace',
    'blast_furnace',
    'smoker',
    'chest',
    'barrel',
    'shulker_box',
    'dispenser',
    'dropper',
    'hopper',
    'enchanting_table',
    'anvil',
    'smithing_table',
    'stonecutter',
    'loom',
    'grindstone',
    'cartography_table',
    'fletching_table',
    'lectern',
    'jukebox',
    'note_block',
    'beacon',
    'chiseled_bookshelf',
    'decorated_pot',
    'crafter',
    'respawn_anchor',
    'command_block',
    'structure_block',
    'jigsaw_block',
    'dragon_egg',
    'cake',
    'bee_nest',
    'beehive',
  ]
  const missing = want.filter((name) => !INTERACTIVE_PLACE_REFERENCE_BLOCKS.has(name))
  check(
    'interactive-set-frontier-coverage',
    missing.length === 0,
    `missing=[${missing.join(', ')}]`,
  )
  const leaked = ['dirt', 'stone', 'grass_block', 'oak_log', 'cobblestone', 'obsidian', 'netherrack', 'glass']
    .filter((name) => INTERACTIVE_PLACE_REFERENCE_BLOCKS.has(name))
  check(
    'interactive-set-no-plain-blocks',
    leaked.length === 0,
    `leaked=[${leaked.join(', ')}]`,
  )
}

if (failures > 0) {
  process.stdout.write(`${failures} failure(s)\n`)
  process.exit(1)
}
process.stdout.write('all place-reference checks passed\n')
