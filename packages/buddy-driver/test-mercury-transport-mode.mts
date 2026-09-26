// test-mercury-transport-mode.mts - regression for the model-id normalization
// that decides the Mercury transport.
//
// Live defect: `MUSE_SPARK_MODEL` was compared with `===`, but the gateway model
// id carries its provider prefix (`meta/muse-spark-1.3-contributor`). The
// comparison failed, so muse was sent down the forced tool-choice path, which it
// rejects:
//   GatewayInternalServerError: only "auto" is supported for tool_choice
// Every Mercury consultation then failed 3/3 and the resident terminated
// fail-loud (18x `context=mercury:action_impossible`, 6x `mercury:wait_limit`
// in one hour, plus the budget exhaustion that followed).
//
//   bun ./test-mercury-transport-mode.mts
import assert from 'node:assert/strict'
import { MUSE_SPARK_MODEL, isMuseSparkModel, mercuryTransportMode } from './mercury-system2.ts'

let failures = 0
const check = (name: string, run: () => boolean, detail: () => string): void => {
  let pass = false
  let info = ''
  try {
    pass = run()
    info = detail()
  } catch (error) {
    info = `threw ${String(error)}`
  }
  if (!pass) failures += 1
  process.stdout.write(`${pass ? 'PASS' : 'FAIL'}  ${name}\n      ${info}\n`)
}

check(
  'a bare muse id selects the json-text transport',
  () => mercuryTransportMode(MUSE_SPARK_MODEL) === 'json-text' && isMuseSparkModel(MUSE_SPARK_MODEL),
  () => `mode=${mercuryTransportMode(MUSE_SPARK_MODEL)}`,
)

check(
  'the PROVIDER-PREFIXED muse id also selects json-text (the live config form)',
  () =>
    mercuryTransportMode(`meta/${MUSE_SPARK_MODEL}`) === 'json-text' &&
    isMuseSparkModel(`meta/${MUSE_SPARK_MODEL}`),
  () => `mode=${mercuryTransportMode(`meta/${MUSE_SPARK_MODEL}`)}`,
)

check(
  'other models keep the provider-enforced tool-call transport',
  () =>
    mercuryTransportMode('inception/mercury-2.5') === 'tool-call' &&
    mercuryTransportMode('typesafe-ai/jev') === 'tool-call' &&
    !isMuseSparkModel('typesafe-ai/jev'),
  () => `mercury=${mercuryTransportMode('inception/mercury-2.5')} jev=${mercuryTransportMode('typesafe-ai/jev')}`,
)

check(
  'a lookalike id that merely contains the name is not treated as muse',
  () => mercuryTransportMode('other/muse-spark-1.3-contributor-extra') === 'tool-call',
  () => `mode=${mercuryTransportMode('other/muse-spark-1.3-contributor-extra')}`,
)

process.stdout.write(`${'-'.repeat(72)}\n${4 - failures}/4 mercury-transport-mode cases passed\n`)
if (failures > 0) process.exit(1)
