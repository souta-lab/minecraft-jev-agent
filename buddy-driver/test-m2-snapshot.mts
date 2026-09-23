// test-m2-snapshot.mts - run-scoped M2 evidence captured by the resident at
// marker time. Pure: no bot, no network, no live host.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  M2_LEGACY_MARKERS,
  M2SnapshotRecorder,
  m2SnapshotFileName,
  orderedM2Chain,
  parseM2Snapshot,
  readM2SnapshotFile,
} from './m2-snapshot.ts'
import type { Counts } from './planner.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const RUN_A = 'run-aaaa'
const RUN_B = 'run-bbbb'

function recorders(
  dir: string,
  runId: string,
  inventory: () => Counts,
  generationId = 'gen-one',
  initialInventory?: Counts,
) {
  let clock = Date.parse('2026-09-19T18:21:50.000Z')
  const recorder = new M2SnapshotRecorder({
    runId,
    generationId,
    bootSourceSha: 'a'.repeat(40),
    buildHash: 'buildhash0001',
    worldEpoch: 3,
    worldKey: '127.0.0.1:25565|minecraft:overworld|3',
    dir,
    readInventory: inventory,
    ...(initialInventory === undefined ? {} : { initialInventory }),
    now: () => (clock += 1000),
  })
  return recorder
}

function withTempDir(run: (dir: string) => { pass: boolean; detail: string }): { pass: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'm2-snapshot-'))
  try {
    return run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

addCase('a marker writes one run-scoped file, atomically, with no temp residue', () =>
  withTempDir((dir) => {
    const recorder = recorders(dir, RUN_A, () => ({ charcoal: 1 }))
    recorder.recordMarker('SMELT_DONE')
    const path = join(dir, m2SnapshotFileName(RUN_A))
    const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'))
    return {
      pass: existsSync(path) && leftovers.length === 0,
      detail: `path=${existsSync(path)} tempResidue=${JSON.stringify(leftovers)}`,
    }
  }),
)

addCase('the ordered chain PREREQ_OPTION -> FURNACE_READY -> SMELT_DONE is VALID', () =>
  withTempDir((dir) => {
    const recorder = recorders(dir, RUN_A, () => ({ charcoal: 1, iron_ingot: 3, iron_pickaxe: 1 }))
    recorder.recordMarker('PREREQ_OPTION')
    recorder.recordMarker('FURNACE_READY')
    recorder.recordMarker('SMELT_DONE')
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    const names = snapshot?.markers.map((marker) => marker.name) ?? []
    return {
      pass:
        snapshot?.legacyChain.status === 'VALID' &&
        names.join(',') === 'PREREQ_OPTION,FURNACE_READY,SMELT_DONE' &&
        typeof snapshot.markers[0]?.at === 'string',
      detail: `legacyChain=${snapshot?.legacyChain.status} markers=${names.join(',')} at=${snapshot?.markers[0]?.at}`,
    }
  }),
)

addCase('out-of-order markers are never promoted to VALID', () =>
  withTempDir((dir) => {
    const recorder = recorders(dir, RUN_A, () => ({}))
    recorder.recordMarker('FURNACE_READY')
    recorder.recordMarker('SMELT_DONE')
    recorder.recordMarker('PREREQ_OPTION')
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    return {
      pass: snapshot?.legacyChain.status === 'INCOMPLETE',
      detail: `legacyChain=${snapshot?.legacyChain.status} sequence=${JSON.stringify(snapshot?.sequence)}`,
    }
  }),
)

addCase('the FULL live inventory is read at the marker instant, not cached', () =>
  withTempDir((dir) => {
    const live: Counts = { charcoal: 1, iron_ingot: 2 }
    const recorder = recorders(dir, RUN_A, () => ({ ...live }))
    recorder.recordMarker('FURNACE_READY')
    const before = readM2SnapshotFile(RUN_A, dir)
    live.iron_ingot = 3
    live.iron_pickaxe = 1
    recorder.recordMarker('SMELT_DONE')
    const after = readM2SnapshotFile(RUN_A, dir)
    return {
      pass: before?.inventory.iron_ingot === 2 && after?.inventory.iron_pickaxe === 1 && after?.markers.length === 2,
      detail: `beforeIngot=${before?.inventory.iron_ingot} after=${JSON.stringify(after?.inventory)}`,
    }
  }),
)

addCase('a snapshot for run A can never be loaded for run B', () =>
  withTempDir((dir) => {
    const a = recorders(dir, RUN_A, () => ({ charcoal: 1 }))
    a.recordMarker('PREREQ_OPTION')
    const loadedAsB = readM2SnapshotFile(RUN_B, dir)
    const bRecorder = recorders(dir, RUN_B, () => ({ charcoal: 9 }))
    bRecorder.recordMarker('PREREQ_OPTION')
    const b = readM2SnapshotFile(RUN_B, dir)
    const aAgain = readM2SnapshotFile(RUN_A, dir)
    return {
      pass:
        loadedAsB === null &&
        b?.markers[0]?.inventory.charcoal === 9 &&
        aAgain?.markers[0]?.inventory.charcoal === 1 &&
        aAgain?.runId === RUN_A,
      detail: `loadedAsB=${loadedAsB === null} bCharcoal=${b?.markers[0]?.inventory.charcoal} aCharcoal=${aAgain?.markers[0]?.inventory.charcoal}`,
    }
  }),
)

addCase('the chain survives a generation hot reload within the same run', () =>
  withTempDir((dir) => {
    const first = recorders(dir, RUN_A, () => ({ charcoal: 1, iron_ingot: 3 }), 'gen-one')
    first.recordMarker('PREREQ_OPTION')
    first.recordMarker('FURNACE_READY')
    const second = recorders(dir, RUN_A, () => ({ charcoal: 1, iron_ingot: 3, iron_pickaxe: 1 }), 'gen-two')
    second.recordMarker('SMELT_DONE')
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    return {
      pass:
        snapshot?.legacyChain.status === 'VALID' &&
        snapshot?.markers.length === 3 &&
        snapshot?.generationId === 'gen-two' &&
        snapshot?.runId === RUN_A,
      detail: `legacyChain=${snapshot?.legacyChain.status} markers=${snapshot?.markers.length} gen=${snapshot?.generationId}`,
    }
  }),
)

addCase('a non-M2 event is ignored and never writes or advances the chain', () =>
  withTempDir((dir) => {
    const recorder = recorders(dir, RUN_A, () => ({}))
    const ignored = recorder.recordMarker('HEARTBEAT')
    return {
      pass: ignored === null && readM2SnapshotFile(RUN_A, dir) === null,
      detail: `ignored=${ignored} fileWritten=${readM2SnapshotFile(RUN_A, dir) !== null}`,
    }
  }),
)

addCase('an unreadable inventory at the marker instant keeps the marker and the last counts', () =>
  withTempDir((dir) => {
    let calls = 0
    const recorder = recorders(dir, RUN_A, () => {
      calls += 1
      if (calls === 2) throw new Error('disconnected')
      return { charcoal: 1 }
    })
    recorder.recordMarker('PREREQ_OPTION')
    recorder.recordMarker('FURNACE_READY')
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    return {
      pass: snapshot?.markers.length === 2 && snapshot?.inventory.charcoal === 1 && calls === 2,
      detail: `markers=${snapshot?.markers.length} inventory=${JSON.stringify(snapshot?.inventory)}`,
    }
  }),
)

addCase('malformed snapshot bodies are rejected', () => {
  const bad = [
    null,
    { record: 'm2-snapshot' },
    { record: 'other', runId: RUN_A, atMs: 1, at: 'x', markers: [], sequence: [], inventory: {} },
    { record: 'm2-snapshot', runId: RUN_A, atMs: 1, at: 'x', markers: [{ name: 'SMELT_DONE' }], sequence: [], inventory: {} },
    { record: 'm2-snapshot', runId: RUN_A, atMs: 1, at: 'x', markers: [], sequence: [], inventory: 'nope' },
  ]
  const ok = bad.every((value) => parseM2Snapshot(value) === null)
  return { pass: ok, detail: `rejected=${bad.length}` }
})

addCase('orderedM2Chain matches m2-watch first-after semantics', () => {
  const L = M2_LEGACY_MARKERS
  const valid = orderedM2Chain(['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'], L).status
  const extra = orderedM2Chain(['PREREQ_OPTION', 'PREREQ_OPTION', 'FURNACE_READY', 'FURNACE_READY', 'SMELT_DONE'], L).status
  const selfHeal = orderedM2Chain(['FURNACE_READY', 'PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE'], L).status
  const premature = orderedM2Chain(['SMELT_DONE', 'PREREQ_OPTION', 'FURNACE_READY'], L).status
  return {
    pass: valid === 'VALID' && extra === 'VALID' && selfHeal === 'VALID' && premature === 'INCOMPLETE',
    detail: `valid=${valid} extra=${extra} selfHeal=${selfHeal} premature=${premature}`,
  }
})

addCase('the snapshot records run/build/world provenance fields', () =>
  withTempDir((dir) => {
    const recorder = recorders(dir, RUN_A, () => ({}))
    recorder.recordMarker('PREREQ_OPTION')
    const raw = JSON.parse(readFileSync(join(dir, m2SnapshotFileName(RUN_A)), 'utf8')) as Record<string, unknown>
    const snapshot = parseM2Snapshot(raw)
    return {
      pass:
        snapshot?.runId === RUN_A &&
        snapshot?.buildHash === 'buildhash0001' &&
        snapshot?.bootSourceSha === 'a'.repeat(40) &&
        snapshot?.worldEpoch === 3 &&
        typeof snapshot?.atMs === 'number' &&
        typeof snapshot?.at === 'string',
      detail: `runId=${snapshot?.runId} build=${snapshot?.buildHash} source=${snapshot?.bootSourceSha?.slice(0, 4)} epoch=${snapshot?.worldEpoch}`,
    }
  }),
)

addCase('the valid chain keeps the first FURNACE_READY sample when a repeat consumes charcoal', () =>
  withTempDir((dir) => {
    const live: Counts = { raw_iron: 3, cobblestone: 28 }
    const recorder = recorders(dir, RUN_A, () => ({ ...live }))
    recorder.recordMarker('PREREQ_OPTION')
    live.charcoal = 1
    recorder.recordMarker('FURNACE_READY')
    live.charcoal = 0
    live.iron_ingot = 3
    recorder.recordMarker('SMELT_DONE')
    // A later repeat must not replace the chain-selected FURNACE_READY sample.
    recorder.recordMarker('FURNACE_READY')
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    const furnace = snapshot?.markers.find((marker) => marker.name === 'FURNACE_READY')
    const smelt = snapshot?.markers.find((marker) => marker.name === 'SMELT_DONE')
    return {
      pass:
        snapshot?.legacyChain.status === 'VALID' &&
        furnace?.inventory.charcoal === 1 &&
        smelt?.inventory.iron_ingot === 3,
      detail: `legacyChain=${snapshot?.legacyChain.status} furnaceCharcoal=${furnace?.inventory.charcoal} smeltIngot=${smelt?.inventory.iron_ingot}`,
    }
  }),
)

addCase('the current diamond-to-Nether portal chain keeps typed marker details and initial inventory', () =>
  withTempDir((dir) => {
    const recorder = recorders(
      dir,
      RUN_A,
      () => ({ flint_and_steel: 1 }),
      'gen-portal',
      { diamond: 3, diamond_pickaxe: 1, flint_and_steel: 1, obsidian: 10 },
    )
    recorder.recordMarker('PORTAL_BLOCK_PLACED', { target: { x: 7, y: 68, z: 5 } })
    recorder.recordMarker('PORTAL_FRAME_READY', { at: '7,72,5', blocks: 10, shape: 'ok' })
    recorder.recordMarker('PORTAL_LIT', {
      target: { x: 7, y: 69, z: 5 },
      dimension: 'minecraft:overworld',
    })
    recorder.recordMarker('PORTAL_VERIFIED', { verified: true, dimension: 'minecraft:overworld' })
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    const frame = snapshot?.markers.find((marker) => marker.name === 'PORTAL_FRAME_READY')
    const lit = snapshot?.markers.find((marker) => marker.name === 'PORTAL_LIT')
    const verified = snapshot?.markers.find((marker) => marker.name === 'PORTAL_VERIFIED')
    return {
      pass:
        snapshot?.initialInventory?.obsidian === 10 &&
        snapshot?.markers.length === 4 &&
        frame?.blocks === 10 &&
        frame.shape === 'ok' &&
        lit?.dimension === 'minecraft:overworld' &&
        verified?.verified === true,
      detail: `initial=${JSON.stringify(snapshot?.initialInventory)} frame=${JSON.stringify(frame)} lit=${JSON.stringify(lit)} verified=${JSON.stringify(verified)}`,
    }
  }),
)

addCase('a verified iron-pickaxe craft records run-scoped terminal inventory after the M2 chain', () =>
  withTempDir((dir) => {
    let clock = Date.parse('2026-09-19T18:21:50.000Z')
    const live: Counts = { charcoal: 1, raw_iron: 3 }
    const recorder = new M2SnapshotRecorder({
      runId: RUN_A,
      generationId: 'gen-one',
      bootSourceSha: 'a'.repeat(40),
      buildHash: 'buildhash0001',
      worldEpoch: 3,
      worldKey: '127.0.0.1:25565|minecraft:overworld|3',
      dir,
      readInventory: () => ({ ...live }),
      now: () => (clock += 1000),
    })
    recorder.recordMarker('PREREQ_OPTION')
    recorder.recordMarker('FURNACE_READY')
    live.charcoal = 0
    live.raw_iron = 0
    live.iron_ingot = 3
    recorder.recordMarker('SMELT_DONE')
    live.iron_ingot = 0
    live.iron_pickaxe = 1
    recorder.recordTerminal('CRAFT:iron_pickaxe', { verified: true, status: 'done' })
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    return {
      pass:
        snapshot?.legacyChain.status === 'VALID' &&
        snapshot?.terminal?.actionId === 'CRAFT:iron_pickaxe' &&
        snapshot?.terminal?.inventory.iron_pickaxe === 1 &&
        (snapshot?.terminal?.atMs ?? 0) > (snapshot?.markers.find((marker) => marker.name === 'SMELT_DONE')?.atMs ?? 0),
      detail: `legacyChain=${snapshot?.legacyChain.status} terminal=${snapshot?.terminal?.actionId} pickaxe=${snapshot?.terminal?.inventory.iron_pickaxe}`,
    }
  }),
)

addCase('an unverified or pre-chain iron-pickaxe craft never creates terminal evidence', () =>
  withTempDir((dir) => {
    const recorder = recorders(dir, RUN_A, () => ({ iron_pickaxe: 1 }))
    const beforeChain = recorder.recordTerminal('CRAFT:iron_pickaxe', { verified: true, status: 'done' })
    recorder.recordMarker('PREREQ_OPTION')
    recorder.recordMarker('FURNACE_READY')
    recorder.recordMarker('SMELT_DONE')
    const unverified = recorder.recordTerminal('CRAFT:iron_pickaxe', { verified: false, status: 'done' })
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    return {
      pass: beforeChain === null && unverified === null && snapshot?.terminal === null,
      detail: `beforeChain=${beforeChain} unverified=${unverified} terminal=${snapshot?.terminal}`,
    }
  }),
)

let failures = 0
process.stdout.write('run-scoped M2 snapshot recorder\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} m2-snapshot cases passed\n`)
if (failures > 0) process.exit(1)

addCase('the chain the snapshot reports is the PORTAL chain the M2 premise and the gate use', () =>
  withTempDir((dir) => {
    const recorder = recorders(dir, 'run-portal-chain', () => ({}))
    recorder.recordMarker('PORTAL_BLOCK_PLACED')
    recorder.recordMarker('PORTAL_BLOCK_PLACED')
    recorder.recordMarker('PORTAL_FRAME_READY')
    recorder.recordMarker('PORTAL_LIT')
    const beforeVerify = readM2SnapshotFile('run-portal-chain', dir)
    recorder.recordMarker('PORTAL_VERIFIED')
    const afterVerify = readM2SnapshotFile('run-portal-chain', dir)
    return {
      pass:
        beforeVerify?.chain.status === 'INCOMPLETE' &&
        beforeVerify?.chain.required.join(',') === 'PORTAL_BLOCK_PLACED,PORTAL_FRAME_READY,PORTAL_LIT,PORTAL_VERIFIED' &&
        afterVerify?.chain.status === 'VALID' &&
        afterVerify?.chain.observed.join(',') === 'PORTAL_BLOCK_PLACED,PORTAL_FRAME_READY,PORTAL_LIT,PORTAL_VERIFIED' &&
        // the legacy iron chain is still evaluated from the same sequence, so a historical
        // reader loses nothing when `chain` became the portal chain.
        afterVerify?.legacyChain.status === 'INCOMPLETE',
      detail: `chain=${afterVerify?.chain.status} required=${afterVerify?.chain.required.join(',')} legacy=${afterVerify?.legacyChain.status}`,
    }
  }),
)
