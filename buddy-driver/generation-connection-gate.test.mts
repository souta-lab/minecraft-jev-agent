import { describe, expect, test } from 'bun:test'
import {
  connectAfterGenerationValidation,
  generationModuleReadinessError,
} from './generation-connection-gate.ts'

const CONTRACT_VERSION = 3
const validModule = { CONTRACT_VERSION, createGeneration: () => ({}) }

describe('generation connection gate', () => {
  test('an import failure such as missing external ai dependency never connects', async () => {
    let connects = 0
    const refusals: string[] = []
    const connected = await connectAfterGenerationValidation({
      load: async () => { throw new Error("Cannot find package 'ai' imported from generation") },
      validate: (module: typeof validModule) => generationModuleReadinessError(module, CONTRACT_VERSION),
      connect: () => { connects += 1 },
      refused: (reason) => refusals.push(reason),
    })

    expect(connected).toBe(false)
    expect(connects).toBe(0)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toContain('Cannot find package')
  })

  test('an unavailable module and invalid controller surface are both fail closed', async () => {
    let connects = 0
    const refusals: string[] = []
    const run = (load: () => Promise<unknown | null>) => connectAfterGenerationValidation({
      load,
      validate: (module) => generationModuleReadinessError(module, CONTRACT_VERSION),
      connect: () => { connects += 1 },
      refused: (reason) => refusals.push(reason),
    })

    expect(await run(async () => null)).toBe(false)
    expect(await run(async () => ({ CONTRACT_VERSION, createGeneration: undefined }))).toBe(false)
    expect(await run(async () => ({ CONTRACT_VERSION: CONTRACT_VERSION + 1, createGeneration: () => ({}) }))).toBe(false)
    expect(connects).toBe(0)
    expect(refusals).toEqual([
      'generation-module-unavailable',
      'missing createGeneration export',
      'CONTRACT_VERSION mismatch: generation=4 host=3',
    ])
  })

  test('a later valid generation permits retry without requiring a live server in the fixture', async () => {
    let connects = 0
    const refusals: string[] = []
    const attempt = (load: () => Promise<typeof validModule | null>) => connectAfterGenerationValidation({
      load,
      validate: (module) => generationModuleReadinessError(module, CONTRACT_VERSION),
      connect: () => { connects += 1 },
      refused: (reason) => refusals.push(reason),
    })

    expect(await attempt(async () => null)).toBe(false)
    expect(await attempt(async () => validModule)).toBe(true)
    expect(connects).toBe(1)
    expect(refusals).toEqual(['generation-module-unavailable'])
  })
})
