// #11/#56: normal execution must materialise first-class Options.
import assert from 'node:assert/strict'
import { resolveOptionCompilerEnabled } from './src/optionSpec.ts'

assert.equal(resolveOptionCompilerEnabled({}), true, 'Option compiler must be ON when unset')
for (const value of ['1', 'true', 'on', 'yes']) {
  assert.equal(resolveOptionCompilerEnabled({ BUDDY_OPTION_COMPILER: value }), true, `${value} enables Options`)
}
for (const value of ['0', 'false', 'off', 'no']) {
  assert.equal(resolveOptionCompilerEnabled({ BUDDY_OPTION_COMPILER: value }), false, `${value} is explicit rollback`)
}
assert.throws(
  () => resolveOptionCompilerEnabled({ BUDDY_OPTION_COMPILER: 'auto' }),
  /invalid BUDDY_OPTION_COMPILER/,
  'ambiguous auto mode must not silently change semantic architecture',
)

process.stdout.write('#11 first-class Option default: PASS\n')
