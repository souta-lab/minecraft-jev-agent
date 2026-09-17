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
import { build } from 'esbuild'
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
  const result = await build({
    entryPoints: [join(HERE, 'generation-entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    write: false,
    logLevel: 'silent',
    sourcemap: 'inline',
    absWorkingDir: HERE,
  })
  const output = result.outputFiles[0]
  if (output === undefined) throw new Error('esbuild produced no output')
  const hash = createHash('sha256').update(output.contents).digest('hex').slice(0, 12)
  const outfile = join(OUTDIR, `gen-${hash}.mjs`)
  const existing = await readFile(outfile).catch(() => null)
  if (existing === null) {
    const tmp = `${outfile}.${process.pid}.tmp`
    await writeFile(tmp, output.contents)
    await rename(tmp, outfile)
  }
  await pruneOld(outfile)
  return { outfile, hash, bytes: output.contents.byteLength, ms: Date.now() - started }
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
