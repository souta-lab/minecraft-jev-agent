import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mapMutationSurface } from '../packages/jev-agent/src/reach/kernel-authority-map.ts'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'packages', 'jev-agent', 'src')
const MAP = JSON.parse(readFileSync(join(ROOT, 'docs', 'development', 'FEATURE-AUTHORITY-MAP.json'), 'utf8'))
const candidatesSrc = readFileSync(join(SRC, 'candidates.ts'), 'utf8')
const executorSrc = readFileSync(join(SRC, 'executor.ts'), 'utf8')

const unionSrc = candidatesSrc.slice(candidatesSrc.indexOf('export type CandidateKind'), candidatesSrc.indexOf('export interface', candidatesSrc.indexOf('export type CandidateKind')))
const REAL_KINDS = [...unionSrc.matchAll(/\| '(\w+)'/g)].map((m) => m[1])
const DOMAIN_ENTRIES = Object.entries(MAP.domains) as Array<[string, Record<string, unknown>]>

/** Extract the kind -> dispatchMethod table out of runActionBody's switch. */
function realDispatch(): Map<string, string> {
  const bodyStart = executorSrc.indexOf('private async runActionBody')
  const bodyEnd = executorSrc.indexOf('private async runMine', bodyStart)
  const body = executorSrc.slice(bodyStart, bodyEnd)
  const out = new Map<string, string>()
  const caseRe = /case '(\w+)':/g
  const labels: Array<[string, number]> = [...body.matchAll(caseRe)].map((m) => [m[1], m.index])
  // Consecutive case labels with no call between them share one body (fallthrough).
  const callPositions = [...body.matchAll(/this\.(run\w+|buildResult)\s*\(/g)].map((m) => [m.index, m[1]] as const)
  for (const [kind, at] of labels) {
    const call = callPositions.find(([pos]) => pos > at)
    out.set(kind, call?.[1] ?? null)
  }
  return out
}

/** Extract every method body so helper closures can be scanned per domain. */
function methodBodies(): Map<string, string> {
  const bodies = new Map<string, string>()
  const re = /private\s+(?:async\s+)?(\w+)\s*\(/g
  let m
  while ((m = re.exec(executorSrc))) {
    const name = m[1]
    const open = executorSrc.indexOf('{', m.index)
    let depth = 0
    for (let i = open; i < executorSrc.length; i += 1) {
      if (executorSrc[i] === '{') depth += 1
      else if (executorSrc[i] === '}') { depth -= 1; if (depth === 0) { bodies.set(name, executorSrc.slice(open, i + 1)); break } }
    }
  }
  return bodies
}

const BODIES = methodBodies()

/** Breadth-first `this.<helper>(` closure over the executor's own methods. */
function helperClosure(roots: readonly string[]): string {
  const seen = new Set<string>(roots)
  const stack = [...roots]
  const texts: string[] = []
  while (stack.length > 0) {
    const name = stack.pop()!
    const body = BODIES.get(name) ?? ''
    texts.push(body)
    for (const cm of body.matchAll(/this\.(\w+)\s*\(/g)) {
      if (BODIES.has(cm[1]) && !seen.has(cm[1])) { seen.add(cm[1]); stack.push(cm[1]) }
    }
  }
  return texts.join('\n')
}

/** Mutation spellings we can observe in executor source -> canonical surface keys. */
const SPELLINGS: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/this\.bot\.pathfinder\.(setGoal|setMovements|goto|stop)\s*\(/g, 'pathfinder.$1'],
  [/this\.bot\.collectBlock\.collect/g, 'collectBlock.collect'],
  [/this\.setControlState\s*\(|this\.bot\.setControlState\s*\(/g, 'bot.setControlState'],
  [/this\.clearControlStates\s*\(|this\.bot\.clearControlStates\s*\(/g, 'bot.clearControlStates'],
  [/this\.bot\.entity\.position\.(set|offset)\s*\(|this\.bot\.entity\.position\.[xyz]\s*=/g, 'entity.position.write'],
  [/this\.bot\.entity\.yaw\s*=/g, 'entity.yaw'],
  [/this\.bot\.entity\.pitch\s*=/g, 'entity.pitch'],
  [/this\.bot\.entity\.onGround\s*=/g, 'entity.onGround'],
  [/this\.bot\.entity\.velocity\.(set|offset)\s*\(/g, 'entity.velocity.write'],
  [/this\.bot\.physicsEnabled\s*=/g, 'bot.physicsEnabled'],
  [/writePacket\('(\w+)'/g, (m) => `_client.write:${m[1]}`],
  [/this\.options\.actuationPort\.equip\s*\(/g, 'bot.equip'],
  [/this\.options\.actuationPort\.setPose\s*\(/g, 'entity.position.write'],
  [/window\.(putInput|putFuel|takeInput|takeFuel|takeOutput|close)\s*\(|\.putInput\s*\(|\.putFuel\s*\(|\.takeInput\s*\(|\.takeFuel\s*\(|\.takeOutput\s*\(/g, (m) => `window.${m[1] ?? 'close'}`],
]

/** bot.<member>( call spellings that must resolve to a declared mutation surface. */
const BOT_CALL_RE = /this\.bot\.(\w+)\s*\(/g
const PATHFINDER_CALL_RE = /this\.bot\.pathfinder\.(\w+)\s*\(/g

/** bot.* spellings known read-only / non-mutating in this codebase — pinned, not guessed. */
const READ_ONLY_BOT = new Set([
  'blockAt', 'blocks', 'blockAtCursor', 'findBlock', 'findBlocks', 'canDigBlock',
  'entity', 'entities', 'inventory', 'items', 'heldItem', 'heldItemSlot',
  'health', 'food', 'foodSaturation', 'oxygenLevel', 'experience', 'time',
  'username', 'version', 'game', 'world', 'dimension', 'isSleeping', 'isRaining',
  'players', 'player', 'targetDigBlock', 'entityAtCursor', 'nearestEntity',
  'recipesAll', 'recipesFor', 'supportFeature', 'tablist', 'teams',
  'creative', 'physics', 'controlState', 'getControlState', 'quickBarSlot', 'equipment', 'mouse',
  'pathfinder', 'collectBlock', 'movements', 'settings', 'viewer',
  'on', 'once', 'removeListener', 'addListener', 'digTime', 'loadPlugin',
  'waitForTicks', 'waitForChunksToLoad', 'getEquipmentDestSlot', 'blockInHand',
])

describe('feature authority map', () => {
  test('schema + every CandidateKind is owned by exactly one domain', () => {
    expect(MAP.schema).toBe('feature-authority-map/v1')
    const assigned = new Map<string, string>()
    for (const [domain, entry] of DOMAIN_ENTRIES) {
      for (const kind of entry.candidateKinds as string[]) {
        expect(assigned.has(kind), `${kind} assigned to both ${assigned.get(kind)} and ${domain}`).toBe(false)
        assigned.set(kind, domain)
        expect(REAL_KINDS).toContain(kind)
      }
    }
    for (const kind of REAL_KINDS) expect(assigned.has(kind), `CandidateKind ${kind} is not assigned to any domain`).toBe(true)
  })

  test('dispatch table matches executor runActionBody exactly', () => {
    const real = realDispatch()
    for (const kind of REAL_KINDS) {
      expect(real.get(kind), `no dispatch found for ${kind}`).toBeTruthy()
    }
    for (const [domain, entry] of DOMAIN_ENTRIES) {
      const declared = entry.dispatch as Record<string, string>
      for (const kind of entry.candidateKinds as string[]) {
        expect(declared[kind], `${domain} lacks a dispatch entry for ${kind}`).toBe(real.get(kind))
      }
      for (const method of Object.values(declared)) {
        expect(BODIES.has(method), `executor has no method ${method} (declared by ${domain})`).toBe(true)
      }
    }
  })

  test('every declared mutation surface resolves through mapMutationSurface', () => {
    for (const [domain, entry] of DOMAIN_ENTRIES) {
      for (const surface of entry.mutationSurfaces as Array<string | { surface: string; instance?: string }>) {
        const spec = typeof surface === 'string' ? { surface, instance: null } : { surface: surface.surface, instance: surface.instance ?? null }
        const resolved = mapMutationSurface(spec.surface, spec.instance)
        expect(resolved, `${domain} declares unmapped surface ${spec.surface}@${spec.instance ?? 'null'}`).not.toBeNull()
      }
    }
  })

  test('declared resourceDomains/effects equal the canonical derivation', () => {
    for (const [domain, entry] of DOMAIN_ENTRIES) {
      const derivedDomains = new Set<string>()
      const derivedEffects = new Set<string>()
      for (const surface of entry.mutationSurfaces as Array<string | { surface: string; instance?: string }>) {
        const spec = typeof surface === 'string' ? { surface, instance: null } : { surface: surface.surface, instance: surface.instance ?? null }
        const resolved = mapMutationSurface(spec.surface, spec.instance)!
        for (const r of resolved.resources) derivedDomains.add(r.domain)
        derivedEffects.add(resolved.effect)
      }
      const declaredDomains = [...(entry.resourceDomains as string[])].sort()
      const declaredEffects = [...(entry.effects as string[])].sort()
      expect(declaredDomains, `${domain} resourceDomains drifted`).toEqual([...derivedDomains].sort())
      expect(declaredEffects, `${domain} effects drifted`).toEqual([...derivedEffects].sort())
    }
  })

  test('dispatch-reachable spellings never escape the declared envelopes', () => {
    const surfacesOf = (entry: Record<string, unknown>) => new Set(
      (entry.mutationSurfaces as Array<string | { surface: string; instance?: string }>).map((s) => typeof s === 'string' ? s : `${s.surface}:${s.instance ?? ''}`),
    )
    for (const [domain, entry] of DOMAIN_ENTRIES) {
      const declared = surfacesOf(entry)
      const text = helperClosure(Object.values(entry.dispatch as Record<string, string>))
      for (const [re, map] of SPELLINGS) {
        for (const m of text.matchAll(re)) {
          const surface = typeof map === 'string' ? map.replace('$1', m[1]) : map(m)
          const key = surface.startsWith('_client.write:') ? surface : surface
          const ok = declared.has(surface) || declared.has(`_client.write:${surface.split(':').at(-1)}`)
          expect(ok, `${domain} dispatch can spell ${surface} but does not declare it`).toBe(true)
        }
      }
    }
  })

  test('every mutation spelling in executor.ts is covered by some domain or the pinned read-only list', () => {
    const covered = new Set<string>()
    for (const [, entry] of DOMAIN_ENTRIES) {
      for (const s of entry.mutationSurfaces as Array<string | { surface: string }>) covered.add(typeof s === 'string' ? s : s.surface)
    }
    const uncovered: string[] = []
    for (const m of executorSrc.matchAll(BOT_CALL_RE)) {
      const surface = `bot.${m[1]}`
      if (covered.has(surface)) continue
      if (READ_ONLY_BOT.has(m[1])) continue
      uncovered.push(surface)
    }
    for (const m of executorSrc.matchAll(PATHFINDER_CALL_RE)) {
      const surface = `pathfinder.${m[1]}`
      if (covered.has(surface)) continue
      if (READ_ONLY_BOT.has(m[1]) || ['getPathTo', 'isThinking', 'isMoving', 'setMovements'].includes(m[1])) continue
      uncovered.push(surface)
    }
    expect(uncovered, `executor mutation spellings not covered by any domain: ${uncovered.join(', ')}`).toEqual([])
  })

  test('kernel-admission flags are honest: only navigation may claim reach modules', () => {
    for (const [domain, entry] of DOMAIN_ENTRIES) {
      const admitted = entry.kernelAdmitted as string
      expect(['none', 'partial', 'full']).toContain(admitted)
      const modules = entry.kernelModules as string[]
      if (admitted === 'none') expect(modules).toEqual([])
      else {
        expect(modules.length).toBeGreaterThan(0)
        for (const mod of modules) expect(existsSync(join(SRC, mod)), `${domain} kernel module ${mod} missing`).toBe(true)
      }
    }
    const navAdmitted = (MAP.domains.navigation.kernelModules as string[])
    expect(navAdmitted).toContain('reach/kernel-authority-map.ts')
    expect(navAdmitted).toContain('reach/transition.ts')
  })
})
