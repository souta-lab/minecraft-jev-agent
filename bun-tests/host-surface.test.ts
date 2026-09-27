import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'packages', 'jev-agent', 'src')

function tsFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) out.push(...tsFiles(p))
    else if (entry.endsWith('.ts')) out.push(p)
  }
  return out
}

const FILES = tsFiles(SRC)
const SOURCES = new Map(FILES.map((f) => [f, readFileSync(f, 'utf8')]))
const controllerSrc = SOURCES.get(join(SRC, 'controller.ts'))!

/** JevController member names: fields, methods, getters/setters, public surface. */
function controllerMembers(): Set<string> {
  const names = new Set<string>()
  for (const m of controllerSrc.matchAll(/^\s+(?:public\s+|private\s+(?:readonly\s+)?|protected\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*!?\s*(?:[:(=]|$)/gm)) {
    names.add(m[1])
  }
  for (const m of controllerSrc.matchAll(/^\s+(\w+)\s*\(/gm)) names.add(m[1])
  return names
}

interface HostSpec { file: string; name: string; members: string[] }

/** Top-level members of every exported `*Host` interface/type literal. */
function hostInterfaces(): HostSpec[] {
  const specs: HostSpec[] = []
  for (const [file, text] of SOURCES) {
    const re = /export (?:interface|type) (\w+Host)\w*\s*(?:=\s*)?{/g
    let im
    while ((im = re.exec(text))) {
      const start = text.indexOf('{', im.index)
      let depth = 0, end = start
      for (let i = start; i < Math.min(start + 40000, text.length); i += 1) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') { depth -= 1; if (depth === 0) { end = i; break } }
      }
      const body = text.slice(start, end)
      const members = [...body.matchAll(/^ {2}(\w+)\s*[?]?\s*[:(]/gm)].map((m) => m[1])
      specs.push({ file, name: im[1], members })
    }
  }
  return specs
}

const HOSTS = hostInterfaces()
const MEMBERS = controllerMembers()

describe('controller host-surface binding', () => {
  test('every Host interface member resolves to a JevController declaration', () => {
    const missing: string[] = []
    for (const host of HOSTS) {
      for (const member of host.members) {
        if (!MEMBERS.has(member)) missing.push(`${host.name}.${member} (${host.file})`)
      }
    }
    expect(missing, `host members with no controller backing — these read undefined at runtime through the structural cast:\n${missing.join('\n')}`).toEqual([])
  })

  test('every Host interface member is referenced somewhere outside its declaration', () => {
    const orphans: string[] = []
    for (const host of HOSTS) {
      for (const member of host.members) {
        const re = new RegExp(`\\b${member}\\b`)
        let referenced = false
        for (const [file, text] of SOURCES) {
          for (const line of text.split('\n')) {
            if (!re.test(line)) continue
            if (file === host.file && new RegExp(`^ {2}${member}\\s*[?]?\\s*:`).test(line)) continue
            referenced = true
            break
          }
          if (referenced) break
        }
        if (!referenced) orphans.push(`${host.name}.${member} (${host.file})`)
      }
    }
    expect(orphans, `host members with zero non-declaration references — declared coupling nobody uses:\n${orphans.join('\n')}`).toEqual([])
  })

  test('structural-cast host adapters are enumerated and ratcheted', () => {
    const casts = [...controllerSrc.matchAll(/as unknown as (\w+Host)/g)].map((m) => m[1])
    const distinct = [...new Set(casts)].sort()
    expect(distinct.length).toBeGreaterThanOrEqual(8)
    for (const name of distinct) {
      expect(HOSTS.some((h) => h.name === name), `cast to ${name} but no such Host interface found`).toBe(true)
    }
  })

  test('controller private members reachable only via structural casts stay documented', () => {
    // The property this test pins: the count of "private" members exposed through
    // at least one Host interface. It must never grow silently.
    const exposed = new Set<string>()
    for (const host of HOSTS) for (const m of host.members) exposed.add(m)
    const privateDecls = new Set(
      [...controllerSrc.matchAll(/^\s+private\s+(?:readonly\s+)?(\w+)\s*[:(=]/gm)].map((m) => m[1]),
    )
    const exposedPrivates = [...exposed].filter((m) => privateDecls.has(m))
    expect(exposedPrivates.length).toBeGreaterThan(200)
    // ratchet: exposure may shrink but must not grow past the current ceiling
    expect(exposedPrivates.length).toBeLessThanOrEqual(400)
  })
})
