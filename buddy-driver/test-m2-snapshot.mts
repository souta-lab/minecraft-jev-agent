// test-m2-snapshot.mts - run-scoped M2 evidence captured by the resident at
// marker time. Pure: no bot, no network, no live host.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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

function recorders(dir: string, runId: string, inventory: () => Counts, generationId = 'gen-one') {
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
        snapshot?.chain.status === 'VALID' &&
        names.join(',') === 'PREREQ_OPTION,FURNACE_READY,SMELT_DONE' &&
        typeof snapshot.markers[0]?.at === 'string',
      detail: `chain=${snapshot?.chain.status} markers=${names.join(',')} at=${snapshot?.markers[0]?.at}`,
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
      pass: snapshot?.chain.status === 'INCOMPLETE',
      detail: `chain=${snapshot?.chain.status} sequence=${JSON.stringify(snapshot?.sequence)}`,
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
        snapshot?.chain.status === 'VALID' &&
        snapshot?.markers.length === 3 &&
        snapshot?.generationId === 'gen-two' &&
        snapshot?.runId === RUN_A,
      detail: `chain=${snapshot?.chain.status} markers=${snapshot?.markers.length} gen=${snapshot?.generationId}`,
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
  const valid = orderedM2Chain(['PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE']).status
  const extra = orderedM2Chain(['PREREQ_OPTION', 'PREREQ_OPTION', 'FURNACE_READY', 'FURNACE_READY', 'SMELT_DONE']).status
  const selfHeal = orderedM2Chain(['FURNACE_READY', 'PREREQ_OPTION', 'FURNACE_READY', 'SMELT_DONE']).status
  const premature = orderedM2Chain(['SMELT_DONE', 'PREREQ_OPTION', 'FURNACE_READY']).status
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

addCase('one retained sample per marker is pinned to the chain-advancing occurrence', () =>
  withTempDir((dir) => {
    const live: Counts = { raw_iron: 3, cobblestone: 28 }
    const recorder = recorders(dir, RUN_A, () => ({ ...live }))
    recorder.recordMarker('PREREQ_OPTION')
    // Charcoal (fuel) is live at FURNACE_READY time and is burnt by SMELT_DONE.
    live.charcoal = 1
    recorder.recordMarker('FURNACE_READY')
    // A repeat FURNACE_READY once the fuel is gone must NOT overwrite the
    // chain-advancing sample: that is exactly how charcoal>=1 evidence was lost.
    live.charcoal = 0
    recorder.recordMarker('FURNACE_READY')
    live.iron_ingot = 3
    recorder.recordMarker('SMELT_DONE')
    const snapshot = readM2SnapshotFile(RUN_A, dir)
    const furnace = snapshot?.markers.find((marker) => marker.name === 'FURNACE_READY')
    const smelt = snapshot?.markers.find((marker) => marker.name === 'SMELT_DONE')
    return {
      pass:
        snapshot?.chain.status === 'VALID' &&
        snapshot?.markers.length === 3 &&
        furnace?.inventory.charcoal === 1 &&
        smelt?.inventory.iron_ingot === 3,
      detail: `chain=${snapshot?.chain.status} samples=${snapshot?.markers.length} furnaceCharcoal=${furnace?.inventory.charcoal} smeltIngot=${smelt?.inventory.iron_ingot}`,
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
