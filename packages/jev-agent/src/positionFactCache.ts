/** Cache an expensive destination fact once per exact destination coordinate. */
export interface PositionLike {
  x: number
  y: number
  z: number
}

export function createPositionFactCache<T>(compute: (position: PositionLike) => T): (position: PositionLike) => T {
  const cache = new Map<string, T>()
  return (position) => {
    const key = `${position.x},${position.y},${position.z}`
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const fact = compute(position)
    cache.set(key, fact)
    return fact
  }
}
