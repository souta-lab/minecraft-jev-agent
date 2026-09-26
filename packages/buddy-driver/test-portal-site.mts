// test-portal-site.mts - issue #80: a verified nether-portal site must be
// durable and routable WITHOUT making the `portalVerified` verdict durable.
//
// The lifecycle under test (pure: no bot, no network, no live host):
//   record-once
//   -> survives a simulated generation/world-memory rebuild with the same worldKey
//   -> the durable site is present as a CAN-only known-resource route and as a
//      remembered `PortalFrameSite` the sensor projects into `portalFrameSites`
//   -> a live re-check that finds nothing at the recorded site (while the bot is
//      there) evicts it
//   -> a world-epoch / dimension change drops it
//
// Before the #80 change `syncKnownPortalSites`/`portalSiteKnownResources` and
// `ResidentWorldMemory.knownPortalSites` did not exist, so this fixture could not
// even build; it fails before and passes after by construction.
import type { KnownPortalSiteJson, ResidentWorldMemory } from './resident-types.ts'
import { emptyWorldMemory, normalizeWorldMemory } from './resident-types.ts'
import {
  PORTAL_SITE_PROOF_DISTANCE,
  portalSiteKnownResources,
  syncKnownPortalSites,
} from './generation-entry.ts'
import { rememberedPortalFrameSites } from '../jev-agent/src/state.ts'
import type { KnownResource } from '../jev-agent/src/state.ts'
import { portalFrameLayout } from '../jev-agent/src/netherPortalPlan.ts'

interface Case {
  name: string
  run: () => { pass: boolean; detail: string }
}

const cases: Case[] = []
const addCase = (name: string, run: Case['run']): void => {
  cases.push({ name, run })
}

const WORLD_KEY = { serverId: '127.0.0.1:25565', dimension: 'minecraft:overworld', worldEpoch: 3 }
const ORIGIN = { x: 40, y: 64, z: -12 }
const LAYOUT = portalFrameLayout(ORIGIN, 'z')
const SITE: KnownPortalSiteJson = {
  x: ORIGIN.x,
  y: ORIGIN.y,
  z: ORIGIN.z,
  widthAxis: 'z',
  dimension: WORLD_KEY.dimension,
  worldEpoch: WORLD_KEY.worldEpoch,
  lastVerifiedAt: 1000,
  frame: LAYOUT.frame.map((cell) => ({ ...cell })),
  interior: LAYOUT.interior.map((cell) => ({ ...cell })),
}

/** A live-verified portal at SITE, in the shape the sensor detector returns. */
const LIVE_VERIFIED = [
  {
    origin: ORIGIN,
    widthAxis: 'z' as const,
    frame: LAYOUT.frame.map((cell) => ({ ...cell })),
    interior: LAYOUT.interior.map((cell) => ({ ...cell })),
  },
]
/** The bot far from the site: absence there proves nothing (#14 proof distance). */
const FAR = { x: 0, y: 64, z: 0 }
/** The bot standing at the site: a failing live re-check is proof. */
const AT_SITE = { x: ORIGIN.x + 2, y: ORIGIN.y, z: ORIGIN.z }

/** Exact live world truth for the recorded cells: frame obsidian, interior lit. */
function litProbe(cell: { x: number; y: number; z: number }): string | null {
  if (LAYOUT.interior.some((entry) => entry.x === cell.x && entry.y === cell.y && entry.z === cell.z)) return 'nether_portal'
  if (LAYOUT.frame.some((entry) => entry.x === cell.x && entry.y === cell.y && entry.z === cell.z)) return 'obsidian'
  return 'air'
}
/** Every recorded cell read back as air: the frame the record was minted from is gone. */
const goneProbe = (): string | null => 'air'
/** The frame still stands but its interior is no longer lit. */
function unlitProbe(cell: { x: number; y: number; z: number }): string | null {
  if (LAYOUT.frame.some((entry) => entry.x === cell.x && entry.y === cell.y && entry.z === cell.z)) return 'obsidian'
  return 'air'
}

function sync(overrides: {
  known: readonly KnownPortalSiteJson[]
  liveVerified?: readonly {
    origin: { x: number; y: number; z: number }
    widthAxis: 'x' | 'z'
    frame?: readonly { x: number; y: number; z: number }[]
    interior?: readonly { x: number; y: number; z: number }[]
  }[]
  worldKey?: { dimension: string; worldEpoch: number }
  position?: { x: number; y: number; z: number }
  probe?: (cell: { x: number; y: number; z: number }) => string | null
  now?: number
}): ReturnType<typeof syncKnownPortalSites> {
  return syncKnownPortalSites({
    known: overrides.known,
    liveVerified: overrides.liveVerified ?? [],
    worldKey: overrides.worldKey ?? WORLD_KEY,
    position: overrides.position ?? FAR,
    ...(overrides.probe === undefined ? {} : { probe: overrides.probe }),
    now: overrides.now ?? 5000,
  })
}

addCase('#80 record-once: a live-verified portal site is recorded exactly once', () => {
  const first = sync({ known: [], liveVerified: LIVE_VERIFIED })
  const second = sync({ known: first.known, liveVerified: LIVE_VERIFIED })
  const site = second.known[0]
  const pass =
    first.added.length === 1 &&
    first.removed.length === 0 &&
    first.known.length === 1 &&
    second.added.length === 0 &&
    second.known.length === 1 &&
    site?.x === ORIGIN.x &&
    site?.y === ORIGIN.y &&
    site?.z === ORIGIN.z &&
    site?.widthAxis === 'z' &&
    site?.dimension === WORLD_KEY.dimension &&
    site?.worldEpoch === WORLD_KEY.worldEpoch &&
    site?.lastVerifiedAt === 5000 &&
    site?.frame?.length === LAYOUT.frame.length &&
    site?.interior?.length === LAYOUT.interior.length
  return { pass, detail: `firstAdded=${first.added.length} secondAdded=${second.added.length} known=${JSON.stringify(second.known.map((s) => ({ ...s, frame: s.frame?.length, interior: s.interior?.length })))}` }
})

addCase('#80 durable: the recorded site survives a generation rebuild with the same worldKey', () => {
  const recorded = sync({ known: [], liveVerified: LIVE_VERIFIED })
  // Simulate the host write + a new generation loading durable memory: the
  // record crosses the boundary as plain JSON and is normalized on read.
  const durable: ResidentWorldMemory = { ...emptyWorldMemory(), knownPortalSites: recorded.known.map((site) => ({ ...site })) }
  const reloaded = normalizeWorldMemory(JSON.parse(JSON.stringify(durable)) as ResidentWorldMemory)
  // The new generation is far from the site (after a respawn) and senses nothing.
  const afterRebuild = sync({ known: reloaded.knownPortalSites, liveVerified: [], position: FAR })
  const pass =
    Array.isArray(reloaded.knownPortalSites) &&
    reloaded.knownPortalSites.length === 1 &&
    afterRebuild.removed.length === 0 &&
    afterRebuild.known.length === 1 &&
    afterRebuild.known[0]?.x === ORIGIN.x &&
    afterRebuild.known[0]?.widthAxis === 'z'
  return { pass, detail: `reloaded=${JSON.stringify(reloaded.knownPortalSites)} afterRebuild=${JSON.stringify(afterRebuild.known)}` }
})

addCase('#80 route: the durable site is present as a CAN-only known-resource route and a remembered frame site', () => {
  const routes = portalSiteKnownResources([SITE])
  const frameSites = rememberedPortalFrameSites(routes as unknown as readonly KnownResource[])
  const route = routes[0]
  const frame = frameSites[0]
  const pass =
    routes.length === 1 &&
    route?.name === 'nether_portal' &&
    route?.kind === 'portal' &&
    route?.position.x === ORIGIN.x &&
    route?.position.y === ORIGIN.y &&
    route?.position.z === ORIGIN.z &&
    route?.widthAxis === 'z' &&
    frameSites.length === 1 &&
    frame?.origin.x === ORIGIN.x &&
    frame?.origin.y === ORIGIN.y &&
    frame?.origin.z === ORIGIN.z &&
    frame?.widthAxis === 'z' &&
    frame?.safe === true &&
    // The recorded frame geometry is re-projected, so the existing portal
    // grounding can route to the site; the lit verdict is never stored.
    frame?.existingFrame?.length === LAYOUT.frame.length
  return { pass, detail: `route=${JSON.stringify({ ...route, frameCells: route?.frameCells?.length })} frameSites=${frameSites.length} existingFrame=${frame?.existingFrame?.length}` }
})

addCase('#80 evict: the record is dropped only when world truth PROVES the portal gone', () => {
  // A failed live re-check is not proof: the frame may simply be outside the
  // body-relative sensor window, so the same "nothing sensed" input must keep the
  // record (see the regression case below). Revocation needs the record's own
  // cells to be READ and disproved.
  const gone = sync({ known: [SITE], liveVerified: [], position: AT_SITE, probe: goneProbe })
  const unlit = sync({ known: [SITE], liveVerified: [], position: AT_SITE, probe: unlitProbe })
  const pass =
    gone.removed.length === 1 &&
    gone.removed[0]?.x === ORIGIN.x &&
    gone.known.length === 0 &&
    gone.removalReasons[0]?.reason === 'frame_broken' &&
    unlit.removed.length === 1 &&
    unlit.removalReasons[0]?.reason === 'observed_unlit' &&
    unlit.known.length === 0
  return {
    pass,
    detail: `gone=${JSON.stringify(gone.removalReasons.map((entry) => entry.reason))} unlit=${JSON.stringify(unlit.removalReasons.map((entry) => entry.reason))}`,
  }
})

addCase('#80 regression: a blind sensor tick NEVER drops a verified record (body outside the window)', () => {
  // Measured live (run-mubhx20x-pie2, 17:28:25Z): the body descended to y=61.9
  // beside the frame at y=66..70, the sensor searched dy -4..+4 around the body
  // and returned nothing, and the old "not sensed while within proof distance"
  // rule dropped the record. The standing, lit, already-verified gate then
  // stopped satisfying the nether_portal rung and the next inventory-shaped
  // resume re-queued its own construction rows.
  const blind = sync({ known: [SITE], liveVerified: [], position: AT_SITE })
  const unreadable = sync({
    known: [SITE],
    liveVerified: [],
    position: AT_SITE,
    // Unloaded chunks read as null: UNKNOWN, never "gone".
    probe: () => null,
  })
  const pass =
    blind.removed.length === 0 &&
    blind.known.length === 1 &&
    unreadable.removed.length === 0 &&
    unreadable.known.length === 1
  return { pass, detail: `blindKnown=${blind.known.length} unreadableKnown=${unreadable.known.length}` }
})

addCase('#80 recheck: the record coordinates let a distant body re-confirm the lit portal', () => {
  // The body is 30+ blocks away (or below): the sensor sees nothing, but the
  // record's own cells read back as a valid lit portal, so this tick observes
  // the outcome and reports it as `confirmed` (the caller projects that into the
  // live portal verdict + this run's own verification).
  const far = { x: ORIGIN.x, y: ORIGIN.y - 34, z: ORIGIN.z + 3 }
  const result = sync({ known: [{ ...SITE, lastVerifiedAt: 1 }], liveVerified: [], position: far, probe: litProbe, now: 4242 })
  const pass =
    result.removed.length === 0 &&
    result.known.length === 1 &&
    result.confirmed.length === 1 &&
    result.confirmed[0]?.x === ORIGIN.x &&
    result.confirmed[0]?.lastVerifiedAt === 4242
  return { pass, detail: `confirmed=${JSON.stringify(result.confirmed.map((site) => `${site.x},${site.y},${site.z}@${site.lastVerifiedAt}`))}` }
})

addCase('#80 proof distance: absence far from the site is not proof and keeps the entry', () => {
  const distance = Math.hypot(SITE.x - FAR.x, SITE.y - FAR.y, SITE.z - FAR.z)
  const result = sync({ known: [SITE], liveVerified: [], position: FAR })
  const pass = distance > PORTAL_SITE_PROOF_DISTANCE && result.removed.length === 0 && result.known.length === 1
  return { pass, detail: `distance=${distance.toFixed(1)} proof=${PORTAL_SITE_PROOF_DISTANCE} known=${result.known.length}` }
})

addCase('#80 refresh: a site re-verified live at close range stays and is refreshed', () => {
  const stale = { ...SITE, lastVerifiedAt: 1 }
  const result = sync({ known: [stale], liveVerified: LIVE_VERIFIED, position: AT_SITE, now: 9000 })
  const pass =
    result.removed.length === 0 &&
    result.known.length === 1 &&
    result.known[0]?.lastVerifiedAt === 9000
  return { pass, detail: `known=${JSON.stringify(result.known)}` }
})

addCase('#80 epoch: a world-epoch change drops the recorded site', () => {
  const result = sync({ known: [SITE], liveVerified: [], worldKey: { ...WORLD_KEY, worldEpoch: WORLD_KEY.worldEpoch + 1 }, position: FAR })
  const pass = result.removed.length === 1 && result.removed[0]?.x === ORIGIN.x && result.known.length === 0
  return { pass, detail: `removed=${JSON.stringify(result.removed)} known=${result.known.length}` }
})

addCase('#80 dimension: a same-epoch entry from another dimension is dropped', () => {
  const result = sync({
    known: [SITE],
    liveVerified: [],
    worldKey: { ...WORLD_KEY, dimension: 'minecraft:the_nether' },
    position: FAR,
  })
  const pass = result.removed.length === 1 && result.known.length === 0
  return { pass, detail: `removed=${JSON.stringify(result.removed)} known=${result.known.length}` }
})

addCase('#80 portalVerified stays live-only: the durable record never carries a verdict field into the route', () => {
  const routes = portalSiteKnownResources([SITE]) as unknown as Array<Record<string, unknown>>
  const hasVerdict = routes.some((route) => 'portalVerified' in route || 'verified' in route)
  const pass = routes.length === 1 && !hasVerdict
  return { pass, detail: `routeKeys=${JSON.stringify(Object.keys(routes[0] ?? {}))}` }
})

let failures = 0
process.stdout.write('durable verified-portal site (#80)\n')
process.stdout.write('-'.repeat(72) + '\n')
for (const testCase of cases) {
  const observed = testCase.run()
  if (!observed.pass) failures += 1
  process.stdout.write(`${observed.pass ? 'PASS' : 'FAIL'}  ${testCase.name}\n`)
  process.stdout.write(`      ${observed.detail}\n`)
}
process.stdout.write('-'.repeat(72) + '\n')
process.stdout.write(`${cases.length - failures}/${cases.length} portal-site cases passed\n`)
if (failures > 0) process.exit(1)
