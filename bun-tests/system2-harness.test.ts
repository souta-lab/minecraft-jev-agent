// Bridges the #439 System2 harness suite into the repository battery.
//
// The #31 executable invariants (S1-S15) and the #32 regression fixtures live
// with the package they test (`system2-harness/bun-tests/`), so the package stays
// self-contained and can be type-checked/tested on its own. This file makes
// `bun run test` (root) cover them too: bun's runner registers the `test()` calls
// of an imported test module in the importing file's run.
//
// Without this bridge the harness could regress while the repository battery
// stayed green, which is exactly the "unit green is not acceptance" failure the
// P0 evidence rules warn about.

import '../system2-harness/bun-tests/shared-shapes-parity.test.ts'
import '../system2-harness/bun-tests/ai-gateway-transport.test.ts'
import '../system2-harness/bun-tests/s1-s15-invariants.test.ts'
import '../system2-harness/bun-tests/f32-fixtures.test.ts'
