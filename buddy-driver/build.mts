// build.mts - bundle the RELOADABLE layer (generation-entry.ts + everything it
// imports from ../jev-agent/src/**) into ONE hash-stamped ESM file.
//
// Why bundling matters: importing `controller.ts?v=hash` alone resolves its
// static imports (executor.ts, candidates.ts, ...) to the generation-0 URL, so a
// new controller gets wired to stale siblings. Bundling makes the generation a
// single file == a single URL == an atomic swap.
//
// `packages: 'external'` keeps mineflayer / pathfinder / prismarine shared, so
// `new Movements(bot)` inside the generation is the SAME class the host loaded.
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTDIR = join(HERE, 'data', 'resident')
const KEEP_GENERATIONS = 8

export interface BuildResult {
  outfile: string
  hash: string
  bytes: number
  ms: number
}

export async function buildGeneration(): Promise<BuildResult> {
  const started = Date.now()
  await mkdir(OUTDIR, { recursive: true })
  const result = await Bun.build({
    entrypoints: [join(HERE, 'generation-entry.ts')],
    format: 'esm',
    target: 'bun',
    packages: 'external',
    sourcemap: 'inline',
  })
  if (!result.success) {
    const details = result.logs.map((log) => log.message).join('\n')
    throw new Error(`Bun.build failed${details === '' ? '' : `: ${details}`}`)
  }
  const output = result.outputs[0]
  if (output === undefined) throw new Error('Bun.build produced no output')
  const contents = new Uint8Array(await output.arrayBuffer())
  const hash = createHash('sha256').update(contents).digest('hex').slice(0, 12)
  const outfile = join(OUTDIR, `gen-${hash}.mjs`)
  const existing = await readFile(outfile).catch(() => null)
  if (existing === null) {
    const tmp = `${outfile}.${process.pid}.tmp`
    await writeFile(tmp, contents)
    await rename(tmp, outfile)
  }
  await pruneOld(outfile)
  return { outfile, hash, bytes: contents.byteLength, ms: Date.now() - started }
}

async function pruneOld(justWritten: string): Promise<void> {
  const names = (await readdir(OUTDIR).catch(() => [] as string[])).filter(
    (name) => name.startsWith('gen-') && name.endsWith('.mjs'),
  )
  const withTime = await Promise.all(
    names.map(async (name) => {
      const full = join(OUTDIR, name)
      const info = await stat(full).catch(() => null)
      return { name, mtimeMs: info?.mtimeMs ?? 0 }
    }),
  )
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const keep = new Set(withTime.slice(0, KEEP_GENERATIONS).map((entry) => entry.name))
  keep.add(justWritten.split('/').pop() ?? '')
  for (const entry of withTime) {
    if (keep.has(entry.name)) continue
    await rm(join(OUTDIR, entry.name), { force: true }).catch(() => undefined)
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  buildGeneration()
    .then((result) => {
      process.stdout.write(`[build] ${result.outfile} hash=${result.hash} bytes=${result.bytes} ms=${result.ms}\n`)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`[build] FAILED: ${message}\n`)
      process.exit(1)
    })
}
