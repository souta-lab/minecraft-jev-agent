# TypeScript Package Architecture

## Packages by Feature for TypeScript

### With selective Go-inspired package-design heuristics

Status: **Normative repository structure guideline**

This document defines how TypeScript source in `minecraft-jev-agent` should be organized, named, imported, and migrated.

The primary model is **TypeScript/JavaScript Packages by Feature**. Code is grouped by the capability/domain it implements, not by technical file type or historical layer.

Where TypeScript/JavaScript ecosystem guidance is weak or non-prescriptive about package boundaries, this document selectively borrows useful package-design heuristics from Go: small cohesive packages, plain names, explicit dependency direction, narrow public surfaces, and avoidance of generic dumping grounds.

**Go is a secondary reference, not the architectural source of truth.** If a strong TypeScript/JavaScript convention conflicts with a Go-derived heuristic, prefer the TypeScript/JavaScript convention unless doing so violates the V4.1.2 authority constitution. Do not imitate Go syntax, repository layout, visibility rules, or naming mechanically.

## 1. Authority and precedence

This document governs **source organization**, not runtime authority semantics.

When rules conflict, precedence is:

1. `AGENTS.md` V4.1.2 authority constitution.
2. Canonical V4.1.2 architecture and executable kernel invariants.
3. This package-architecture guideline.
4. Historical structure, filenames, tests, compatibility shims, and legacy conventions.

A package refactor must never change authority merely to obtain a cleaner directory tree.
## 2. What “package” means in this TypeScript repository

TypeScript has no Go-style compiler-enforced package boundary. In this repository, a **package** is a directory that owns one coherent capability and exposes a deliberately small import surface.

A package boundary is established by:

- directory ownership;
- import direction;
- exported symbols;
- dependency-boundary tests/static checks;
- documentation of what the package owns and does not own.

A package is **not** merely a folder containing related filenames.

A good package answers all of these quickly:

- What capability does this package provide?
- What state or policy does it own?
- What may callers ask it to do?
- What dependencies may it use?
- What dependencies must it never use?
- Which details are private implementation details?

If those answers are unclear, the package boundary is not yet good enough.

## 3. Primary rule: package by feature

Organize code first by **domain capability / reason to change**.

Prefer `reach/`, `mining/`, `crafting/`, `inventory/`, `survival/`, `navigation/`, and `goals/` over horizontal buckets such as `controllers/`, `services/`, `models/`, `helpers/`, or `adapters/` at the repository top level.
Technical layers may exist **inside** a feature when they clarify that feature, but they should not become global dumping grounds.

Example:

```text
reach/
  controller.ts
  mission.ts
  runtime.ts
  policy.ts
  safety.ts
  ports.ts
```

is preferred over:

```text
controllers/reach.ts
runtimes/reach.ts
policies/reach.ts
ports/reach.ts
safety/reach.ts
```

The first layout keeps code that changes for the same product capability physically close.

## 4. Exceptions: true cross-feature mechanisms

Not everything is a product feature. Some packages are architectural mechanisms used by many features and should remain independent:

- `vtr/` — authority kernel, lifecycle, resources, effects, verification primitives;
- `jev/` — semantic/tactical decision policy infrastructure;
- `system2/` — sparse synthesis/repair/decomposition infrastructure;
- `minecraft/` — backend-specific runtime implementation boundary;
- `app/` — composition/bootstrap/orchestration wiring.

These are valid top-level packages because they have coherent responsibilities independent of any single feature.
## 5. TypeScript naming and package design

The rules below are TypeScript-first. Some are reinforced by Go package-design practice where the TypeScript ecosystem has no equally strong structural convention.

Use the general module-design principle that **the package path contributes context to the symbol name**. Go articulates this particularly well, so it is used here as a supporting reference rather than as the primary standard.

Directory/package names should be:

- short;
- lower-case;
- concrete and evocative;
- usually one word when that remains clear;
- stable enough to describe the capability rather than an implementation phase.

Prefer:

```text
reach
mining
crafting
survival
navigation
verification
```

Avoid new top-level packages named:

```text
util
utils
common
shared
misc
api
types
interfaces
helpers
services
managers
```

Those names describe neither ownership nor capability and tend to accumulate unrelated dependencies.
A name such as `shared` is allowed only when it is genuinely the domain name of a coherent concept, not as a miscellaneous holding area. That should be rare.

### 5.1 Avoid package/symbol stutter

Do not blindly repeat the feature name in every exported symbol.

Prefer context-aware APIs such as:

```ts
import * as reach from './reach/index.ts'

const runtime: reach.Runtime = ...
const controller = new reach.Controller(...)
```

over names that read like `reach.ReachRuntime` or `reach.ReachController`.

However, TypeScript has a flatter local identifier namespace than Go. When direct named imports are clearer, descriptive exported names such as `ReachRuntime` are acceptable. **Do not rename stable symbols only to imitate Go.** Apply the anti-stutter rule when it improves call-site clarity.

### 5.2 File names

For new files, prefer lower-case kebab-case for multiword filenames:

```text
controller-plane.ts
mission-runtime.ts
route-policy.ts
world-model.ts
```

Do not churn existing filenames solely for casing consistency. Rename when moving into the canonical package or when the old name misstates ownership.

### 5.3 Interfaces

Do not create global `interfaces/` or `types/` packages.

Place an interface near the code that **consumes the capability**, not automatically next to the implementation.
For example, if Reach needs movement/observation capabilities:

```text
reach/ports.ts                # Reach's required contract
minecraft/reach/actuation.ts  # Mineflayer-backed implementation
```

The implementation may depend on the consumer contract. The consumer must not depend on the concrete Mineflayer implementation.

Do not prefix interfaces with `I` merely to mark them as interfaces. Name them by the capability they represent.

## 6. Dependency direction

The directory tree must express the architecture, not fight it.

The default dependency direction is:

```text
app
 ├─> feature packages
 ├─> jev / system2
 ├─> vtr
 └─> minecraft implementations

feature packages
 ├─> vtr public authority contracts
 ├─> jev/system2 public decision contracts when appropriate
 └─> feature-local ports

minecraft implementations
 ├─> feature-local ports
 └─> raw Mineflayer / backend APIs

vtr
 └─> no feature-specific package
```

The composition root connects these pieces. Dependency injection is preferred over a feature importing its backend implementation.
### 6.1 Hard architectural import rules

The following are prohibited unless the architecture constitution explicitly changes:

- `vtr/` importing `reach/`, `mining/`, `crafting/`, or another feature package;
- VTR core, Jev core, System2 core, Mission/domain feature logic, or verified world-model logic importing a raw Mineflayer `Bot`;
- a new feature package importing `controller-legacy.ts`;
- a new package importing a legacy compatibility implementation to gain authority;
- backend-specific code being smuggled through a generic `utils`/`shared` package;
- circular package imports used to make a move/refactor compile.

During migration, `legacy/` may depend on new canonical packages. The reverse dependency is forbidden:

```text
legacy -> canonical    allowed temporarily
canonical -> legacy    forbidden
```

This makes legacy deletion monotonic.

### 6.2 Cycles are design failures by default

Do not solve a cycle with a barrel file, dynamic import, global singleton, or dependency injection container merely to hide it.

When a cycle appears, first ask:

1. Is state owned by the wrong package?
2. Is an interface located beside the provider instead of the consumer?
3. Did two packages that change together get split too early?
4. Is orchestration leaking into a domain package?
5. Is a cross-feature mechanism actually a core capability?

Only keep a cycle if there is an exceptional, documented reason and a structural test cannot reasonably remove it.
## 7. Canonical top-level shape

The intended long-term shape is shallow and feature-oriented:

```text
packages/jev-agent/src/
  app/
  reach/
  navigation/
  mining/
  crafting/
  inventory/
  survival/
  goals/
  decision/
  jev/
  system2/
  vtr/
  minecraft/
  legacy/
  index.ts
```

This is a direction, not a mandate to create empty folders or move every file at once.

Create a package only when there is real code with a coherent ownership boundary.

Prefer a shallow tree. Avoid Java-style directory taxonomies such as:

```text
features/reach/domain/services/impl/internal/...
```

unless each level represents a real dependency boundary that materially improves clarity.
## 8. `legacy/` is quarantine, not an architecture layer

`legacy/` is allowed as a temporary migration boundary only.

A file belongs in `legacy/` when:

- it still contains behavior that cannot safely move yet;
- its canonical feature owner is known or being discovered;
- new canonical packages do not depend on it;
- it has an explicit extraction or deletion condition.

Do not place code in `legacy/` merely because it was written a long time ago.

Whenever practical, keep historical status in documentation rather than directory ownership:

```text
survival/threat-observers.ts
navigation/portal/evidence.ts
decision/diagnostics.ts
```

is preferable to permanently keeping:

```text
legacy/threat-observers.ts
legacy/portal-evidence.ts
legacy/candidate-diagnostics.ts
```

The end state should contain little or no `legacy/` code. Compatibility shims must point from old locations toward canonical packages, never the reverse.
## 9. Package public surfaces

A package should expose the smallest useful API that lets callers use the capability without reaching into implementation details.

### 9.1 `index.ts` is optional and thin

Use `index.ts` only when it defines a deliberate package surface.

Good:

```ts
export { Controller } from './controller.ts'
export type { Mission, RuntimePort } from './mission.ts'
```

Bad:

```ts
export * from './controller.ts'
export * from './runtime.ts'
export * from './internal-state.ts'
export * from './test-fixtures.ts'
```

Do not build large barrel graphs. Barrels can hide cycles, make ownership unclear, and accidentally publish internals.

Direct imports from stable public files are acceptable. Do not force every import through `index.ts`.

### 9.2 Internal implementation

A symbol should stay file/package-private unless another package has a real need for it.

Do not export a symbol only because a test cannot otherwise reach it. Prefer testing through the package contract, or place focused white-box tests next to the package when necessary.

Avoid "public by accident" APIs that freeze migration internals.

## 10. Documentation architecture

Repository documentation follows the same ownership principle as source code: a reader should be able to tell why a document exists, who owns it, whether it is current, and where related material lives.

Do not treat the repository root as a permanent documentation bucket.

Keep only documents that genuinely function as repository entrypoints or top-level constitutions at the root, such as:

```text
README.md
AGENTS.md
```

Other documents should normally live under `docs/` according to purpose and ownership.

Documentation is organized first by **role**, then by feature where appropriate. Unlike source code, documentation should not use Packages by Feature exclusively because architecture rules, runbooks, status, and historical evidence have different lifecycles.

### 10.1 Document classes

Every durable document should fit one primary class:

- **Normative** — current rules and architecture. Examples: authority constitution, canonical architecture, package architecture.
- **Operational** — procedures for running, validating, deploying, probing, or recovering the system.
- **Status** — current progress, milestones, TODOs, active blockers, and short-lived coordination state.
- **Historical / evidence** — superseded architecture, completed milestone reports, prior investigations, and preserved rationale.

Do not mix these classes in one directory merely because every file is Markdown.

A historical document must not look equally authoritative to a current normative document. Superseded material should be clearly marked and physically separated when practical.

A status document should not silently become architecture. Promote durable conclusions into a normative document instead of making future readers reconstruct policy from old status notes.

### 10.2 Canonical documentation shape

The intended long-term documentation tree is:

```text
docs/
  architecture/
  development/
  operations/
  status/
  milestones/
  features/
  history/
```

Use these as semantic categories, not as mandatory empty directories. Create them only when real documents belong there.

Typical ownership:

- `docs/architecture/` — current cross-cutting architecture and structural rules;
- `docs/development/` — development method, definition of done, testing and regression guidance;
- `docs/operations/` — runbooks, acceptance procedures, runtime operations, recovery and evidence procedures;
- `docs/status/` — current project status, active milestones and TODOs;
- `docs/milestones/` — milestone-specific plans and acceptance material that is still operationally relevant;
- `docs/features/` — feature-owned architecture, migration and acceptance material;
- `docs/history/` — clearly superseded material retained for provenance or rationale.

### 10.3 Feature documentation follows feature ownership

When documentation is specific to one capability, keep it under that capability's documentation namespace rather than scattering it by document type.

Example:

```text
docs/features/reach/
  architecture.md
  migration.md
  acceptance.md
```

This should correspond conceptually to:

```text
packages/jev-agent/src/reach/
```

The source and documentation trees do not need identical directory structures, but they should agree on ownership vocabulary. If code calls a capability `reach`, its durable feature documentation should not be split across unrelated names such as `movement-v2`, `locomotion-runtime`, and `phase0` without a strong reason.

### 10.4 Historical material is classified, not dumped

Avoid generic documentation dumping grounds such as:

```text
docs/misc/
docs/notes/
docs/other/
docs/archive/
```

If historical material must be retained, classify what history it represents:

```text
docs/history/architecture/
docs/history/milestones/
docs/history/incidents/
docs/history/investigations/
```

Historical documents should preserve original evidence and rationale, but should not remain in a location that implies they are current instructions.

Where multiple architecture versions exist, provide an obvious canonical pointer such as `docs/architecture/README.md` stating the current version. Older versions belong under a clearly historical/versioned location.

### 10.5 Documentation naming and linking

Prefer stable names that describe purpose, not temporary chronology.

Prefer:

```text
package-architecture.md
reach/acceptance.md
operations/clean-run.md
```

over names whose authority depends on readers guessing chronology, such as repeated `NEW-*`, `FINAL-*`, or `LATEST-*` prefixes.

Version numbers are appropriate when the version itself is meaningful architecture history, but the canonical/current document must still be obvious.

When a document moves, update inbound links in the same change. Avoid leaving duplicate authoritative copies at old and new paths. If a compatibility stub is temporarily necessary, it must point to the canonical document and have an explicit deletion condition.

Documentation refactors must preserve provenance: do not rewrite historical evidence merely to make the tree prettier.

### 10.6 Repository-specific migration map

The repository root originally contained documents from several classes. They have been migrated into `docs/` under role-based homes, keeping their original filenames for link stability:

```text
NEW-ARCHITECTURE-V4.1.2.md -> docs/architecture/NEW-ARCHITECTURE-V4.1.2.md
DEVELOPMENT-METHOD.md      -> docs/development/DEVELOPMENT-METHOD.md
DEFINITION-OF-DONE.md      -> docs/development/DEFINITION-OF-DONE.md
M3-ACCEPTANCE-RUNBOOK.md   -> docs/operations/M3-ACCEPTANCE-RUNBOOK.md
CURRENT-STATUS.md          -> docs/status/CURRENT-STATUS.md
MILESTONES.md              -> docs/status/MILESTONES.md
PRIOR-WORK.md              -> docs/history/investigations/PRIOR-WORK.md
```

`docs/README.md` records the full area map. Before moving a document, inspect inbound links, authority references, scripts, tooling, and whether the document is truly current or historical.

`AGENTS.md` remains at the repository root because it is an agent-facing constitutional entrypoint. `README.md` remains at the root because it is the repository-facing entrypoint.

Do not perform a documentation big-bang move merely to satisfy this tree. Migrate in coherent slices with link validation.
## 11. PBF migration and refactor workflow

Packages by Feature is not a cosmetic directory migration. The goal is to make physical location, dependency direction, state ownership, and runtime responsibility agree.

A migration may therefore include both package relocation and refactoring in the same overall phase, but **different kinds of change must remain reviewable and reversible**.

Use this default sequence for each coherent slice:

```text
1. stabilize the current extraction
2. move it to its canonical feature package
3. repair and tighten dependency direction
4. refactor responsibility/state ownership inside that package
5. delete obsolete compatibility/dead code
6. prove behavior and authority invariants again
```

Do not begin a package move while the slice is already half-broken or has unresolved test failures from an earlier extraction.

The canonical package destination should be chosen before deeper refactoring, so newly extracted code does not accumulate in temporary horizontal buckets such as `vtr/reach-*`, `runtime-adapters/*`, or `legacy/*`.
### 11.1 Separate change classes in commits

Within the same migration phase, prefer separate commits for these change classes:

1. **Structural move** — file/directory relocation, import rewrites, deliberate compatibility re-exports if temporarily required. Preserve behavior.
2. **Dependency cleanup** — remove cycles, invert dependencies through consumer-owned ports, narrow public surfaces, remove illegal cross-package imports. Preserve runtime semantics.
3. **Internal refactor** — split oversized modules, clarify state ownership, remove wrappers, reduce accidental exports, rename misleading internals. Preserve externally observable behavior unless a separate semantic change is explicitly intended.
4. **Semantic change** — behavior, policy, authority, lifecycle, verification, scheduling, or mutation semantics. This is a separate change class and must not be hidden inside a PBF migration.

A single tiny commit may combine categories only when the separation would be artificial and the diff remains obviously auditable. For authority-sensitive code, default to stricter separation.

Never use a directory move as cover for an authority change.

For V4.1.2 Reach in particular, package migration must preserve the already-proven invariants: one Kernel-owned mutation path, one Kernel terminalization path, and SUCCESS only through Kernel `VERIFY_SUCCESS` from verified evidence.
### 11.2 Refactor after the address is correct

PBF migration is incomplete if it merely turns one monolith into several badly owned files.

After a slice reaches its canonical package, continue refactoring until the package boundary is understandable:

- orchestration is distinct from state ownership and backend mutation;
- feature policy is distinct from VTR authority;
- consumer contracts are distinct from backend implementations;
- package-private details are not exported accidentally;
- one file does not become a renamed replacement monolith;
- tests exercise package contracts rather than depending unnecessarily on private class layout.

Do not chase arbitrary LOC targets. A large file is a problem when it combines unrelated reasons to change, hides authority/state ownership, or makes dependencies difficult to understand.

Likewise, do not split cohesive code merely to produce many small files. Package cohesion is more important than file count.

### 11.3 Proof cadence

After each structural/dependency slice, run the narrowest relevant typecheck and regression tests before continuing. At stable checkpoints, run the broader package/repository suites.

If a refactor touches an authority-sensitive runtime path, complete the required static authority checks and live evidence appropriate to that migration milestone before declaring the phase complete.
