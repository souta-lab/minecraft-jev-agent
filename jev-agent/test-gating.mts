// test-gating.mts - proof that `score` answers are treated as (value x certainty).
//
// Run: npm run gating-test
//
// The head-line case is the exact sample observed from the real model:
//   danger.score = 0.91 with providerMetadata.typesafe.confidence.danger = 0.09
// A 0.91 danger score sounds alarming, but its certainty is far below the named
// threshold, so the code must keep the current safe action unchanged.
import {
  DANGER_CONFIDENCE_THRESHOLD,
  applyDangerGate,
  gateDanger,
} from './src/gating.ts'
import type { JevAnswer } from './src/jev.ts'

function dangerAnswer(value: number | null, confidence: number | null): JevAnswer {
  return {
    name: 'danger',
    type: 'score',
    value: value ?? 0,
    probability: null,
    confidence,
    probabilities: {},
    legend: ['safe', 'minor risk', 'dangerous', 'lethal'],
    note: null,
  }
}

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []

function addCase(name: string, run: Case['run']): void {
  cases.push({ name, run })
}

addCase('documented sample: score 0.91 @ confidence 0.09 keeps the current action', () => {
  const gate = gateDanger(dangerAnswer(0.91, 0.09))
  const decision = applyDangerGate('MINE:b6_63_-67', gate, 'RETREAT:p5_64_-61')
  const pass =
    gate.actionable === false &&
    decision.outcome === 'preserved' &&
    decision.overridden === false &&
    decision.chosenId === 'MINE:b6_63_-67'
  return {
    pass,
    detail: `actionable=${gate.actionable} conf=${gate.confidence} < ${gate.threshold} outcome=${decision.outcome} chosen=${decision.chosenId} (unchanged)`,
  }
})

addCase('confident severe danger (score 3 @ 0.9) overrides with the safe action', () => {
  const gate = gateDanger(dangerAnswer(3, 0.9))
  const decision = applyDangerGate('MINE:b6_63_-67', gate, 'RETREAT:p5_64_-61')
  const pass = gate.actionable === true && decision.outcome === 'override' && decision.chosenId === 'RETREAT:p5_64_-61'
  return {
    pass,
    detail: `actionable=${gate.actionable} outcome=${decision.outcome} chosen=${decision.chosenId}`,
  }
})

addCase('confident mild danger (score 0.2 @ 0.8) leaves the action alone', () => {
  const gate = gateDanger(dangerAnswer(0.2, 0.8))
  const decision = applyDangerGate('MINE:b6_63_-67', gate, 'RETREAT:p5_64_-61')
  const pass = gate.actionable === true && decision.outcome === 'ignored' && decision.chosenId === 'MINE:b6_63_-67'
  return {
    pass,
    detail: `actionable=${gate.actionable} outcome=${decision.outcome} chosen=${decision.chosenId}`,
  }
})

addCase('missing confidence is never actionable', () => {
  const gate = gateDanger(dangerAnswer(3, null))
  const decision = applyDangerGate('MINE:b6_63_-67', gate, 'RETREAT:p5_64_-61')
  const pass = gate.actionable === false && decision.outcome === 'preserved'
  return { pass, detail: `actionable=${gate.actionable} reason="${gate.reason}"` }
})

addCase('missing score answer is never actionable', () => {
  const gate = gateDanger(undefined)
  const decision = applyDangerGate('WAIT', gate, null)
  const pass = gate.actionable === false && decision.outcome === 'preserved' && decision.chosenId === 'WAIT'
  return { pass, detail: `actionable=${gate.actionable} reason="${gate.reason}"` }
})

addCase('threshold boundary: exactly the threshold is actionable', () => {
  const gate = gateDanger(dangerAnswer(1, DANGER_CONFIDENCE_THRESHOLD))
  const pass = gate.actionable === true
  return { pass, detail: `confidence=${DANGER_CONFIDENCE_THRESHOLD} actionable=${gate.actionable}` }
})

let failures = 0
process.stdout.write('score answers are (value x certainty)\n')
process.stdout.write(`DANGER_CONFIDENCE_THRESHOLD = ${DANGER_CONFIDENCE_THRESHOLD}\n`)
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} gating cases passed\n`)

if (failures > 0) {
  process.exit(1)
}
