// Narrow normalization for the legacy Reach comparison boundary. A human
// `collect <exact Minecraft item> <count>` request is mapped to the typed
// inventory predicate only when raw run evidence observes that same item as
// the selected resource witness. Generic aliases such as `log` are not
// expanded into a species-specific resource.

export function normalizeLegacyCollectMissionCommand(command, witnessBlock) {
  if (typeof command !== 'string' || typeof witnessBlock !== 'string') return null
  const match = /^agent\s+\S+\s+collect\s+(minecraft:)?([a-z0-9_]+)\s+(\d+)$/i.exec(command.trim())
  if (!match) return null
  const item = `${match[1] ? 'minecraft:' : ''}${match[2]}`.toLowerCase().replace(/^minecraft:/, '')
  const witness = witnessBlock.toLowerCase().replace(/^minecraft:/, '')
  const count = Number(match[3])
  if (item !== witness || !Number.isSafeInteger(count) || count < 1) return null
  return {
    mission: { kind: 'inventory_at_least', item, count },
    provenance: {
      source: 'runner/human-task-input.jsonl',
      command: command.trim(),
      normalization: 'exact collect item/count + same raw MOVE/MINE witness => inventory_at_least',
      witnessBlock: witness,
    },
  }
}

export function positionVector(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['x', 'y', 'z'].every((axis) => Number.isFinite(value[axis]))) return null
  return { x: value.x, y: value.y, z: value.z }
}

export function samePosition(left, right) {
  const a = positionVector(left)
  const b = positionVector(right)
  return a !== null && b !== null && ['x', 'y', 'z'].every((axis) => a[axis] === b[axis])
}

export function relativeBlockOffset(target, start) {
  const to = positionVector(target)
  const from = positionVector(start)
  if (to === null || from === null) return null
  return {
    x: to.x - Math.floor(from.x),
    y: to.y - Math.floor(from.y),
    z: to.z - Math.floor(from.z),
  }
}
