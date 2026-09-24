export interface RegularFileIdentity {
  path: string
  realpath: string
  sha256: string
}

export interface JavaRuntimeIdentity extends RegularFileIdentity {
  version: string
  versionOutput: { stdout: string; stderr: string }
  versionOutputSha256: string
}

export interface LeafLaunchIdentity {
  java: JavaRuntimeIdentity
  paperIgnoreJavaVersion: true
  serverJar: RegularFileIdentity
}

export function assertExactLeafArgv(actual: unknown, expected: string[], label?: string): void
export function expectedLeafLaunchIdentity(descriptor: unknown, container?: string | null): LeafLaunchIdentity
export function expectedLeafServerArgs(descriptor: unknown, propertiesPath: string, container?: string | null): string[]
export function parseServerProperties(text: string): Record<string, string>
export function compareRuntimeServerProperties(descriptor: unknown, parsed: Record<string, unknown>): {
  expected: Record<string, string | null>
  observed: Record<string, string | null>
  missing: string[]
  mismatches: string[]
  agrees: boolean
}
