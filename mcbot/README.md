# Minecraft 26.1.2 sandbox — Leaf server + stock offline Mineflayer bot

Headless **Leaf** (Paper fork) **26.1.2** server in offline mode plus a minimal
**stock** Mineflayer bot on the same machine. No Microsoft/Xbox account is used
anywhere: the server runs `online-mode=false` and the bot connects with
`auth: 'offline'`. Nothing is patched — the published
`mineflayer` / `minecraft-protocol` / `minecraft-data` stack supports
MC 26.1.2 (protocol **775**) out of the box.

| Thing | Value |
| --- | --- |
| Server dir | `/home/s0u7a/mc-server` |
| Server jar | `leaf-26.1.2-3.jar` (Leaf build **3**, sha256 `0aa133631e6e45bd22f1da1910005168ee7ebc34fcc6f39c3c6077845cf5af97`) |
| Server version | Leaf `26.1.2-3-ver/26.1.2@3c591d7` for Minecraft **26.1.2** (protocol 775) |
| Listen address | `0.0.0.0:25565` (TCP) |
| Java | Temurin JRE **25.0.2** (GA), `JAVA` env override supported |
| Bot dir | `/home/s0u7a/mc-ai/mcbot` |
| Bot name | `AI_Bot` |

> **EULA:** `/home/s0u7a/mc-server/eula.txt` contains `eula=true`. Writing this
> accepts Mojang's Minecraft EULA (https://aka.ms/MinecraftEULA) on the user's
> behalf, which is required for the server to start.

## Start / stop the server

Start it in the background (detached, survives the shell):

```bash
cd /home/s0u7a/mc-server
setsid --fork ./start.sh </dev/null >>server.log 2>&1 &
```

Check it is up and listening:

```bash
grep 'Done (' /home/s0u7a/mc-server/server.log | tail -1   # "Done (...)! For help, type "help""
ss -ltnp | grep 25565                                      # TCP listener, java pid
tail -f /home/s0u7a/mc-server/server.log                   # live console output
```

Stop it (Leaf saves the world and exits on SIGTERM):

```bash
kill "$(pgrep -f leaf-26.1.2-3.jar)"
```

**Java note:** `leaf-26.1.2-3.jar` is compiled for class-file version 69.0
(Java 25). Java 21 fails with `UnsupportedClassVersionError`, and the Debian
OpenJDK 25 in `/usr/lib/jvm` is an early-access build (`25.0.5-ea`) that
Paper/Leaf refuse to run. `start.sh` therefore uses the Temurin **25.0.2 GA**
JRE (`~/.local/share/PrismLauncher/java/eclipse_temurin_jre25.0.2+10`). Override
with `JAVA=/path/to/java ./start.sh`.

`server.properties` highlights: `online-mode=false`, `enforce-secure-profile=false`,
`difficulty=peaceful`, `spawn-protection=0`, `view-distance=8`,
`simulation-distance=8`, `max-players=10`, `motd=AI Sandbox 26.1.2 (Leaf)`,
`server-port=25565`.

## Run the bot

Dependencies are plain published packages (no patches, no `postinstall`):

```bash
cd /home/s0u7a/mc-ai/mcbot
npm install mineflayer
```

Then:

```bash
node bot.mjs --seconds 20     # connect, report, chat, disconnect after 20s
node bot.mjs                  # stay connected until Ctrl+C
node bot.mjs --username Steve --seconds 5
node bot.mjs --help
```

Options: `--host` (default `127.0.0.1`), `--port` (`25565`), `--username`
(`AI_Bot`), `--version` (default: auto-detect from the server's ping),
`--seconds` (0 = stay connected).

It prints the negotiated MC version + protocol, spawn position,
dimension/gamemode/difficulty, health/food, and sends `hello from AI_Bot` in
chat. Example output:

```
[bot] logged in as AI_Bot -> MC 26.1.2 (protocol 775)
[bot] connected to 127.0.0.1:25565 as AI_Bot (auth=offline)
[bot] version: MC 26.1.2, protocol 775
[bot] spawn position: x=-15.50 y=71.00 z=8.50
[bot] dimension=minecraft:overworld gamemode=survival
[chat] <AI_Bot> hello from AI_Bot
[bot] position after 1s: -15.50, 71.00, 8.50
[bot] health=20 food=20 alive=true
```

## Join with a human client

Any vanilla (or client-modded) Minecraft **26.1.2** client works:

**Server address: `localhost:25565`** (or `127.0.0.1:25565`).

The server accepts offline/unauthenticated clients because `online-mode=false`
and `enforce-secure-profile=false`. Client-side mods are entirely the player's
choice — nothing is required server-side.

## Troubleshooting

- **`UnsupportedClassVersionError` / `Unsupported Java detected`** — use the
  Temurin 25 GA JRE (default in `start.sh`).
- **`Server version '26.1.2' is not supported`** — should not happen with the
  published packages; check `npm ls mineflayer minecraft-protocol minecraft-data`.
- **Port 25565 already in use** — stop the old server
  (`kill "$(pgrep -f leaf-26.1.2-3.jar)"`) or change `server-port`.
- **World files** — live in `/home/s0u7a/mc-server/world`. The previous
  Minecraft 26.2 world was moved to `world-26.2-backup` because 26.1.2 cannot
  load a newer-version world.
