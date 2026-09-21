# Minecraft launcher for the Fabulously Optimized instance

Standalone Bun ESM script that launches the PrismLauncher instance
`Fabulously Optimized` (Minecraft 26.2 + Fabric Loader 0.19.5) **without using
PrismLauncher's launch pipeline**. It resolves the full classpath itself,
reuses the Prism caches when files are present, downloads whatever is missing,
and starts Fabric's `KnotClient` with an **offline account** (no Microsoft/Xbox
login). Nothing in the PrismLauncher config is modified.

## Run it

```bash
bun /home/s0u7a/mc-ai/launch/launch.mjs
```

Useful flags:

```bash
bun launch.mjs --dry-run              # print the java command, do not launch
bun launch.mjs --username Notch       # offline player name (default: s0u7a)
bun launch.mjs --uuid <uuid>          # override the derived offline UUID
bun launch.mjs --memory 6G            # -Xmx (default: 4G)
bun launch.mjs --kill-after 300       # stop the game automatically after 300 s
bun launch.mjs --download-assets      # fetch asset objects missing from the cache
bun launch.mjs --assets-dir DIR       # assets root (default: PrismLauncher cache)
bun launch.mjs --java /path/to/java   # java executable override
bun launch.mjs --help
```

The offline UUID is derived the standard way: MD5 of `OfflinePlayer:<name>`
with the version/variant bits set, so it is stable across runs.

## What it does

1. **Metadata** – downloads `version_manifest_v2.json`, the `26.2` version JSON
   and the Fabric profile
   (`meta.fabricmc.net/v2/versions/loader/26.2/0.19.5/profile/json`) into
   `data/meta/` on first run, reuses them afterwards.
2. **Libraries** – walks the version JSON libraries (OS rules applied) plus the
   Fabric profile libraries (ASM, sponge-mixin, fabric-loader, intermediary).
   For every artifact it tries, in order:
   `data/libraries/<maven path>` → PrismLauncher `libraries/` cache → download
   (Mojang `libraries.minecraft.net`, Fabric `maven.fabricmc.net`).
3. **Client jar** – reuses Prism's cached
   `libraries/com/mojang/minecraft/26.2/minecraft-26.2-client.jar` (SHA1-verified
   against the Mojang manifest), otherwise downloads the 39 MB client jar.
4. **Natives** – extracts the 12 `natives-linux` LWJGL/JTracy jars into
   `data/natives/` (marker file skips re-extraction when unchanged) and passes
   `-Djava.library.path=data/natives`.
5. **Assets** – uses the PrismLauncher assets cache (index `32`); all 5057
   objects were already present. Missing objects are only downloaded when
   `--download-assets` is passed, otherwise a warning is printed.
6. **Launch** – Java 25 (bundled Temurin JRE 25.0.2 under
   `~/.local/share/PrismLauncher/java/`, fallback
   `/usr/lib/jvm/java-25-openjdk-amd64/bin/java`) with the vanilla JVM/game
   argument templates from the version JSON and
   `--username … --uuid … --accessToken 0 --userType legacy --version 26.2
   --gameDir <instance>/minecraft --assetsDir … --assetIndex 32`.

Logs go to stdout and to `data/logs/launch-<timestamp>.log`. The game's own log
is `<instance>/minecraft/logs/latest.log`.

## Adding / removing mods

Fabric loads every `*.jar` in
`/home/s0u7a/.local/share/PrismLauncher/instances/Fabulously Optimized/minecraft/mods/`.
Just drop mod jars there — no launcher change needed. The script reports the
number of jars it sees before launching.

Extra mods installed for MC 26.2 / Fabric (newest version with
`game_versions` ⊇ `26.2` and `loaders` ⊇ `fabric` from the Modrinth v2 API,
`https://api.modrinth.com/v2/project/<slug>/version`):

| Slug | Version | File |
| --- | --- | --- |
| c2me-fabric | 0.4.2-alpha.0.52+26.2 | `c2me-fabric-mc26.2-0.4.2-alpha.0.52.jar` |
| scalablelux | 0.3.0-alpha.0.3+26.2 | `ScalableLux-fabric-0.3.0-alpha.0.3-all.jar` |
| zfastnoise | 1.1.0-beta.6+26.2 | `zfastnoise-1.1.0-beta.6+26.2.jar` |
| badoptimizations | 2.4.1 | `BadOptimizations-2.4.1-26.2-fabric.jar` |
| servercore | 1.5.19+26.2 | `servercore-fabric-1.5.19+26.2.jar` |
| zconfig (dependency of zfastnoise) | 1.0.0+26.x | `zconfig-1.0.0+26.x.jar` |

`zfastnoise` has a hard dependency on `zconfig`, so `zconfig` was added as
well; without it Fabric refuses to start ("Mod resolution failed").

## Verified

- Fabric log: `Loading Minecraft 26.2 with Fabric Loader 0.19.5`,
  `Loading 183 mods:` (55 jars), no `Mixin apply failed` /
  `Incompatible mod set` errors.
- Main menu reached; screenshots taken while running (game closed afterwards).
- Offline account restrictions (expected, harmless): HTTP 401 "Failed to fetch
  user properties", Realms feature flags and profile key pair are unavailable
  because `--accessToken 0` is not a real session.

## Troubleshooting

- **Fabric refuses to start** – it opens a dialog window titled
  `Fabric Loader 0.19.5` describing the missing/incompatible mod. Close the
  dialog to let the process exit, fix `mods/`, retry.
- **Wrong Java** – check the `Java:` line printed at startup; use `--java` to
  point at a Java 25 binary (MC 26.2 declares `javaVersion.majorVersion = 25`).
- **Missing libraries/assets** – delete the offending file under
  `data/` (or pass `--download-assets`) and run again; downloads report the URL
  and HTTP status on failure.

## Launching other versions (vanilla, no Fabric)

The same script can launch any vanilla version, e.g. the Minecraft **1.21.11**
client matching the local Leaf 1.21.11 server. Use a separate `--data-dir` and
`--game-dir` so a run never touches another version's natives/cache. For a
1.21.11 vanilla client with the offline account `s0u7a` joining
`localhost:25565`:

```bash
bun /home/s0u7a/mc-ai/launch/launch.mjs \
  --mc-version 1.21.11 --vanilla \
  --game-dir /home/s0u7a/mc-ai/launch/game-1.21.11 \
  --data-dir /home/s0u7a/mc-ai/launch/data-1.21.11 \
  --assets-dir /home/s0u7a/.local/share/PrismLauncher/assets \
  --server localhost:25565 --username s0u7a --memory 3G
```

Dry-run (verified working, downloads meta/libraries/client but launches nothing):

```bash
bun /home/s0u7a/mc-ai/launch/launch.mjs --mc-version 1.21.11 --vanilla \
  --server localhost:25565 --username s0u7a --dry-run
```

- `--mc-version V` – any version id from the Mojang `version_manifest_v2.json`.
- `--vanilla` – skip Fabric; starts `net.minecraft.client.main.Main` directly.
- `--data-dir DIR` – launcher cache (meta/libraries/client/natives/logs) for
  this target; defaults to `data/` (the Fabric instance).
- `--game-dir DIR` – game directory (worlds, options.txt, logs).
- `--server HOST:PORT` – appends `--quickPlayMultiplayer`, so the client boots
  straight into the server instead of the main menu.
- Missing libraries/assets are downloaded on demand; `--download-assets` also
  fills in asset objects missing from the reused PrismLauncher cache.
- 1.21.11 declares `javaVersion.majorVersion = 21`; the launcher picks the
  bundled Temurin JRE 25 (which runs 1.21.11 fine) — pass
  `--java /usr/lib/jvm/java-21-openjdk-amd64/bin/java` to force Java 21.
