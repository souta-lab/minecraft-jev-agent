#!/usr/bin/env node
// variants/C patch-minecraft-data.mjs
//
// Mineflayer PR #4128 gates its tick_end sending on a minecraft-data feature
// flag named `clientTickEndPacket`, which is added by the still-open
// PrismarineJS/minecraft-data#1304 (branch pc-26.3-support). minecraft-data
// 3.116.0 already ships an equivalent flag named `sendsClientTickEndPacket`
// (versions 1.21.2 -> latest) and already has the `tick_end` packet in the
// 26.1 / protocol-775 protocol.json, but PR #4128 calls the new name.
//
// This script applies the #1304 flag directly to VARIANT C'S OWN
// minecraft-data copy so unmodified PR #4128 code resolves and sends tick_end.
//
// Usage (must pass a path inside the variant, never the shared mcbot tree):
//   node ../patch-minecraft-data.mjs ./node_modules/minecraft-data
import fs from 'node:fs'
import path from 'node:path'

const arg = process.argv[2]
if (!arg) {
  console.error('usage: node patch-minecraft-data.mjs <path-to-variant>/node_modules/minecraft-data')
  process.exit(2)
}
const mcdDir = path.resolve(arg)
const featuresPath = path.join(mcdDir, 'minecraft-data/data/pc/common/features.json')
if (!fs.existsSync(featuresPath)) {
  console.error(`not found: ${featuresPath}`)
  process.exit(2)
}
if (featuresPath.includes(`${path.sep}mc-ai${path.sep}mcbot${path.sep}node_modules${path.sep}`)) {
  console.error('refusing to patch the shared mcbot/node_modules tree')
  process.exit(3)
}

const features = JSON.parse(fs.readFileSync(featuresPath, 'utf8'))
if (features.some((f) => f.name === 'clientTickEndPacket')) {
  console.log('clientTickEndPacket already present')
  process.exit(0)
}

const flag = {
  name: 'clientTickEndPacket',
  description: 'client sends a tick_end packet at the end of every tick',
  versions: ['1.21.3', 'latest'],
}
const anchor = features.findIndex((f) => f.name === 'sendsClientTickEndPacket')
if (anchor === -1) throw new Error('anchor feature sendsClientTickEndPacket not found')
features.splice(anchor, 0, flag)

fs.writeFileSync(featuresPath, JSON.stringify(features, null, 2) + '\n')
console.log(`patched ${featuresPath} (equivalent to PrismarineJS/minecraft-data#1304)`)
