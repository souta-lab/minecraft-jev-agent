// test-state-snapshot.mts - issue #40: schema validation/migration, revision
// commit bookkeeping, and the class-B (server truth) exclusion assertion.
// Pure: no bot, no network, no live host.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentSnapshot } from './resident-types.ts'
import {
  AGENT_SNAPSHOT_SCHEMA_VERSION,
  assertServerTruthNotRestored,
  bumpRevision,
  emptyAgentSnapshot,
  findPersistedServerTruthKeys,
  restoreAgentSnapshot,
  rebindSnapshotServerIdentity,
  validateAgentSnapshot,
} from './state-snapshot.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

interface Captured {
  events: Array<{ event: string; detail: Record<string, unknown> }>
  log: (event: string, detail?: Record<string, unknown>) => void
}

function capture(): Captured {
  const events: Captured['events'] = []
  return {
    events,
    log: (event, detail) => events.push({ event, detail: detail ?? {} }),
  }
}

const goal = {
  id: 'g3:collect:raw_iron',
  kind: 'collect',
  description: 'collect 3 x raw_iron',
  targetItem: 'raw_iron',
  requiredCount: 3,
  targetY: null,
  dimension: null,
  startCount: 0,
  haveCount: 1,
  status: 'active',
  origin: 'llm',
  createdAt: 1,
  updatedAt: 2,
  detail: null,
}

function currentSnapshot(): Record<string, unknown> {
  return {
    schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
    revision: 41,
    worldEpoch: 5,
    generationId: 'gen-abc',
    bot: 'AI_M1S40',
    serverId: '127.0.0.1:25565',
    dimension: 'overworld',
    levelName: 'world',
    firstSeenAt: 100,
    updatedAt: 200,
    milestoneIndex: 7,
    milestone: 'raw_iron',
    ledger: { counter: 3, goals: [goal] },
    worldMemoryByKey: {
      '127.0.0.1:25565|minecraft:overworld|5': {
        craftingTables: [{ x: 1, y: 64, z: 2 }],
        furnaces: [{ x: 3, y: 64, z: 4 }],
        mined: { '1,63,2:stone': 2 },
        discoveredOres: ['iron_ore'],
        knownResources: [{ name: 'iron_ore', kind: 'ore', x: 9, y: 40, z: 9, dimension: 'minecraft:overworld', worldEpoch: 5 }],
        traversalFailures: [],
        moveFailures: [
          {
            key: 'minecraft:overworld:9,40,9',
            dimension: 'minecraft:overworld',
            x: 9,
            y: 40,
            z: 9,
            attempts: 3,
            firstFailedAt: 1,
            lastFailedAt: 2,
            lastReason: 'unreachable',
            blacklistedUntil: 30_000,
          },
        ],
        hazards: [{ x: 5, y: 30, z: 5, reason: 'lava', count: 2, firstSeenAt: 1, lastSeenAt: 2 }],
      },
    },
    generations: 12,
    reloads: 3,
    recoveries: 2,
    lastGenerationId: 'gen-abc',
    actions: 99,
  }
}

addCase('#40: a valid snapshot survives a restart with ledger + worldEpoch intact', () => {
  const result = validateAgentSnapshot(currentSnapshot())
  const snapshot = result.snapshot as AgentSnapshot | null
  const pass =
    result.ok &&
    result.migratedFrom === null &&
    snapshot !== null &&
    snapshot.revision === 41 &&
    snapshot.worldEpoch === 5 &&
    snapshot.dimension === 'minecraft:overworld' &&
    snapshot.ledger !== null &&
    snapshot.ledger.counter === 3 &&
    snapshot.ledger.goals.length === 1 &&
    snapshot.worldMemoryByKey['127.0.0.1:25565|minecraft:overworld|5']?.moveFailures[0]?.attempts === 3 &&
    snapshot.ledger.goals[0]?.targetItem === 'raw_iron'
  return { pass, detail: `ok=${result.ok} rev=${snapshot?.revision} epoch=${snapshot?.worldEpoch} counter=${snapshot?.ledger?.counter}` }
})

addCase('#40: unknown schemaVersion is rejected and the base snapshot is kept', () => {
  const raw = { ...currentSnapshot(), schemaVersion: 999 }
  const cap = capture()
  const base = { ...(validateAgentSnapshot(currentSnapshot()).snapshot as AgentSnapshot) }
  const restored = restoreAgentSnapshot(raw, base, cap.log)
  const rejected = cap.events.find((event) => event.event === 'STATE_REJECTED')
  const pass = restored === base && rejected !== undefined && validateAgentSnapshot(raw).snapshot === null
  return { pass, detail: `log=${JSON.stringify(rejected?.detail ?? null)} snapshot=null keptBase=${restored === base}` }
})

addCase('#40: legacy v2 snapshot is migrated forward and logs STATE_MIGRATED', () => {
  const raw = { ...currentSnapshot(), schemaVersion: 2 }
  const cap = capture()
  const base = { ...(validateAgentSnapshot(currentSnapshot()).snapshot as AgentSnapshot) }
  const restored = restoreAgentSnapshot(raw, base, cap.log)
  const migrated = cap.events.find((event) => event.event === 'STATE_MIGRATED')
  const pass =
    restored !== base &&
    restored.schemaVersion === AGENT_SNAPSHOT_SCHEMA_VERSION &&
    restored.revision === 41 &&
    restored.worldEpoch === 5 &&
    restored.ledger?.counter === 3 &&
    migrated?.detail.from === 2
  return { pass, detail: `log=${JSON.stringify(migrated?.detail ?? null)} rev=${restored.revision} epoch=${restored.worldEpoch}` }
})

addCase('#40: class-B server truth is detected, stripped, and never restored', () => {
  const raw = {
    ...currentSnapshot(),
    position: { x: 1, y: 2, z: 3 },
    health: 20,
    food: 18,
    inventory: { stone: 12 },
  }
  const found = findPersistedServerTruthKeys(raw)
  const cap = capture()
  const base = { ...(validateAgentSnapshot(currentSnapshot()).snapshot as AgentSnapshot) }
  const restored = restoreAgentSnapshot(raw, base, cap.log)
  const logged = cap.events.find((event) => event.event === 'STATE_B_TRUTH_REJECTED')
  const asRecord = restored as unknown as Record<string, unknown>
  const leaked = ['position', 'health', 'food', 'inventory'].filter((key) => Object.prototype.hasOwnProperty.call(asRecord, key))
  let threw = false
  try {
    assertServerTruthNotRestored(raw)
  } catch {
    threw = true
  }
  const pass =
    found.length === 4 &&
    threw &&
    logged !== undefined &&
    logged.detail.restored === false &&
    leaked.length === 0 &&
    restored.worldEpoch === 5
  return { pass, detail: `found=${found.join(',')} assertionThrew=${threw} leaked=${leaked.join(',') || 'none'} log=${JSON.stringify(logged?.detail ?? null)}` }
})

addCase('#40: a malformed ledger is dropped while the rest of class A survives', () => {
  const raw = { ...currentSnapshot(), ledger: { depth: 'nope', goals: 'nope' } }
  const result = validateAgentSnapshot(raw)
  const pass = result.ok && result.snapshot?.ledger === null && result.snapshot?.worldEpoch === 5 && result.snapshot?.revision === 41
  return { pass, detail: `ok=${result.ok} ledger=${result.snapshot?.ledger} epoch=${result.snapshot?.worldEpoch}` }
})

addCase('#40: HOST commit bumps revision monotonically and stamps the schema', () => {
  const snapshot = validateAgentSnapshot(currentSnapshot()).snapshot as AgentSnapshot
  const before = snapshot.revision
  snapshot.schemaVersion = 1
  const first = bumpRevision(snapshot)
  const second = bumpRevision(snapshot)
  const pass = first === before + 1 && second === before + 2 && snapshot.schemaVersion === AGENT_SNAPSHOT_SCHEMA_VERSION
  return { pass, detail: `rev ${before} -> ${first} -> ${second} schema=${snapshot.schemaVersion}` }
})

addCase('#40: legacy singular worldMemory migrates into the epoch-namespaced map', () => {
  const raw = {
    revision: 4,
    worldEpoch: 9,
    serverId: '127.0.0.1:25565',
    dimension: 'overworld',
    worldMemory: { craftingTables: [{ x: 7, y: 65, z: 7 }], furnaces: [], mined: {}, discoveredOres: ['coal_ore'] },
  }
  const result = validateAgentSnapshot(raw)
  const keys = Object.keys(result.snapshot?.worldMemoryByKey ?? {})
  const memory = result.snapshot?.worldMemoryByKey['127.0.0.1:25565|minecraft:overworld|9']
  const pass =
    result.ok &&
    result.migratedFrom === 1 &&
    keys.length === 1 &&
    keys[0] === '127.0.0.1:25565|minecraft:overworld|9' &&
    memory?.discoveredOres.includes('coal_ore') === true &&
    memory?.traversalFailures.length === 0
  return { pass, detail: `migratedFrom=${result.migratedFrom} keys=${keys.join(';')} ores=${memory?.discoveredOres.join(',')}` }
})

addCase('#40: a persisted snapshot survives a simulated restart (file round-trip)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-snapshot-'))
  const path = join(dir, 'buddy-state.json')
  try {
    writeFileSync(path, `${JSON.stringify(currentSnapshot(), null, 2)}\n`)
    const cap = capture()
    const base = { ...(emptyAgentSnapshot({ bot: 'AI_M1S40', serverId: '127.0.0.1:25565' })) }
    const restored = restoreAgentSnapshot(JSON.parse(readFileSync(path, 'utf8')), base, cap.log)
    const okLog = cap.events.find((event) => event.event === 'STATE_LOADED')
    const pass =
      restored.revision === 41 &&
      restored.worldEpoch === 5 &&
      restored.ledger?.counter === 3 &&
      restored.worldMemoryByKey['127.0.0.1:25565|minecraft:overworld|5']?.knownResources.length === 1 &&
      okLog !== undefined
    return { pass, detail: `rev=${restored.revision} epoch=${restored.worldEpoch} counter=${restored.ledger?.counter} log=${JSON.stringify(okLog?.detail ?? null)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

addCase('server identity change fences old world state while retaining archived memory', () => {
  const cap = capture()
  const base = emptyAgentSnapshot({ bot: 'AI_M1S40', serverId: '127.0.0.1:25565' })
  const restored = restoreAgentSnapshot(currentSnapshot(), base, cap.log)
  const result = rebindSnapshotServerIdentity(restored, '127.0.0.1:25568')
  const oldMemoryKey = '127.0.0.1:25565|minecraft:overworld|5'
  const pass =
    result.changed &&
    result.previousServerId === '127.0.0.1:25565' &&
    result.snapshot.serverId === '127.0.0.1:25568' &&
    result.snapshot.worldEpoch === 6 &&
    result.snapshot.generationId === null &&
    result.snapshot.lastGenerationId === 'gen-abc' &&
    result.snapshot.dimension === 'minecraft:overworld' &&
    result.snapshot.levelName === null &&
    result.snapshot.ledger === null &&
    result.snapshot.milestoneIndex === -1 &&
    result.snapshot.milestone === null &&
    result.snapshot.worldMemoryByKey[oldMemoryKey]?.knownResources.length === 1 &&
    result.snapshot.worldMemoryByKey['127.0.0.1:25568|minecraft:overworld|6'] === undefined
  return { pass, detail: `changed=${result.changed} server=${result.snapshot.serverId} epoch=${result.snapshot.worldEpoch} memoryKeys=${Object.keys(result.snapshot.worldMemoryByKey).join(';')}` }
})

addCase('same server identity preserves resumable snapshot unchanged', () => {
  const base = emptyAgentSnapshot({ bot: 'AI_M1S40', serverId: '127.0.0.1:25565' })
  const restored = restoreAgentSnapshot(currentSnapshot(), base, capture().log)
  const result = rebindSnapshotServerIdentity(restored, restored.serverId)
  const pass = !result.changed && result.snapshot === restored && result.snapshot.ledger?.counter === 3 && result.snapshot.worldEpoch === 5
  return { pass, detail: `changed=${result.changed} sameObject=${result.snapshot === restored} epoch=${result.snapshot.worldEpoch}` }
})

addCase('#40: a persisted unknown schemaVersion is rejected on restart and cannot poison state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-snapshot-'))
  const path = join(dir, 'buddy-state.json')
  try {
    writeFileSync(path, `${JSON.stringify({ ...currentSnapshot(), schemaVersion: 7, revision: 500 }, null, 2)}\n`)
    const cap = capture()
    const base = { ...(emptyAgentSnapshot({ bot: 'AI_M1S40', serverId: '127.0.0.1:25565' })) }
    const restored = restoreAgentSnapshot(JSON.parse(readFileSync(path, 'utf8')), base, cap.log)
    const rejected = cap.events.find((event) => event.event === 'STATE_REJECTED')
    const pass = restored.revision === 0 && restored.ledger === null && rejected !== undefined
    return { pass, detail: `restoredRev=${restored.revision} log=${JSON.stringify(rejected?.detail ?? null)}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

let failures = 0
process.stdout.write('agent snapshot schema + class-B exclusion (#40)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} agent-snapshot cases passed\n`)
if (failures > 0) process.exit(1)
