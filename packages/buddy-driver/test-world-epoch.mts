import { acceptsWorldMemoryProposal, resetWorldEpoch, sameWorldKey, worldCacheNamespace, type WorldEpochGeneration } from './world-epoch.ts'
import type { WorldKey } from './resident-types.ts'

interface Case {
  readonly name: string
  readonly run: () => Promise<{ pass: boolean; detail: string }>
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const oldKey: WorldKey = { serverId: 'server:25565', dimension: 'minecraft:overworld', worldEpoch: 4 }
const newKey: WorldKey = { ...oldKey, worldEpoch: 5 }

addCase('#25 old world keys are rejected while the new epoch remains valid', async () => {
  const pass = !sameWorldKey(oldKey, newKey) && !acceptsWorldMemoryProposal(oldKey, newKey) && acceptsWorldMemoryProposal(newKey, { ...newKey })
  return { pass, detail: `oldAccepted=${acceptsWorldMemoryProposal(oldKey, newKey)} newAccepted=${acceptsWorldMemoryProposal(newKey, { ...newKey })}` }
})

addCase('#25 reset quiesces before revoking and epoch commit, then starts fresh', async () => {
  const events: string[] = []
  const generation: WorldEpochGeneration = {
    id: 'gen-old',
    quiesce: async () => { events.push('quiesce') },
    dispose: () => { events.push('dispose') },
  }
  let epoch = oldKey.worldEpoch
  let active: WorldEpochGeneration | null = generation
  let started = false
  const result = await resetWorldEpoch({
    getActive: () => active,
    detachActive: () => { active = null; events.push('detach') },
    revokeLease: (reason) => events.push(`revoke:${reason}`),
    disposeActive: (old) => { old.dispose() },
    incrementEpoch: () => { epoch += 1; events.push(`epoch:${epoch}`); return epoch },
    initializeMemory: () => events.push('memory:new-epoch'),
    persist: () => events.push('persist'),
    startGeneration: async () => { started = true; events.push(`start:${epoch}`); return true },
  })
  const expected = ['detach', 'quiesce', 'revoke:worldreset', 'dispose', 'epoch:5', 'memory:new-epoch', 'persist', 'start:5']
  const pass = result.epoch === 5 && result.started && started && events.join('|') === expected.join('|')
  return { pass, detail: `events=${events.join('|')} result=${JSON.stringify(result)}` }
})

addCase('#25 recovery reset retains lease until an in-flight safety quiesce reaches its boundary', async () => {
  const events: string[] = []
  let finishQuiesce: () => void = () => {}
  const quiesced = new Promise<void>((resolve) => { finishQuiesce = resolve })
  let finished = false
  const reset = resetWorldEpoch({
    getActive: () => ({
      id: 'gen-recovery',
      quiesce: async () => { events.push('quiesce:start'); await quiesced; finished = true; events.push('quiesce:terminal') },
      dispose: () => { events.push('dispose') },
    }),
    detachActive: () => events.push('detach'),
    revokeLease: (reason) => events.push(`revoke:${reason}`),
    disposeActive: () => events.push('dispose'),
    incrementEpoch: () => { events.push('epoch'); return 2 },
    initializeMemory: () => events.push('memory'),
    persist: () => events.push('persist'),
    startGeneration: async () => { events.push('start'); return true },
  })
  await Promise.resolve()
  const held = !finished && !events.includes('revoke:worldreset') && !events.includes('dispose')
  finishQuiesce()
  await reset
  const pass = held && finished && events.indexOf('quiesce:terminal') < events.indexOf('revoke:worldreset')
  return { pass, detail: `held=${held} events=${events.join('|')}` }
})

addCase('#25 cache namespace changes with world epoch and preserves full key identity', async () => {
  const oldNamespace = worldCacheNamespace(oldKey)
  const newNamespace = worldCacheNamespace(newKey)
  const pass = oldNamespace !== newNamespace && oldNamespace.includes('server_25565') && newNamespace.endsWith('5')
  return { pass, detail: `old=${oldNamespace} new=${newNamespace}` }
})

let failures = 0
process.stdout.write('world epoch lifecycle (#25)\n')
process.stdout.write(`${'-'.repeat(72)}\n`)
for (const testCase of cases) {
  const observed = await testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write(`${'-'.repeat(72)}\n`)
process.stdout.write(`${cases.length - failures}/${cases.length} world-epoch cases passed\n`)
if (failures > 0) process.exit(1)
