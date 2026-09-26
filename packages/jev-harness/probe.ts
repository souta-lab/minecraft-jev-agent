// jev-harness/probe.ts - workspace-resolution smoke probe (#438 section 23).
//
// `bun run probe` loads the head registry, the projection contract and the
// provider adapter in one process. Loading providers/typesafe.ts executes its
// real `import { experimental_evaluate } from 'ai'`, so a green probe proves the
// workspace entry in the root package.json + bun.lock actually resolves the
// provider SDK the adapter needs - the dependency the harness exists to seal.
//
// It performs NO provider call and needs NO key.
import { JEV_HEADS } from './heads.ts'
import { createJevHarness } from './harness.ts'
import { TYPESAFE_ADAPTER_MODULE } from './providers/typesafe.ts'
import { PROJECTION_SCHEMAS } from './semanticProjection.ts'

if (JEV_HEADS.length === 0) throw new Error('JEV_HARNESS_PROBE failed: empty head registry')
if (PROJECTION_SCHEMAS.length === 0) throw new Error('JEV_HARNESS_PROBE failed: empty projection contract')

console.log(
  `JEV_HARNESS_PROBE ok=true heads=${JEV_HEADS.length} projections=${PROJECTION_SCHEMAS.length} ` +
    `createHarness=${typeof createJevHarness} adapter=${TYPESAFE_ADAPTER_MODULE}`,
)
