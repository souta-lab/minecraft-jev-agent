'use strict'

const { randomUUID } = require('crypto')
const bedrock = require('bedrock-protocol')

const DIMENSIONS = { 0: 'overworld', 1: 'nether', 2: 'the_end' }
const DEFAULT_LOG_SIZE = 200

/** Turn a rawtext JSON message (1.26.45 `text` packets) into plain text. */
function plainFromRawtext (message) {
  try {
    const parsed = JSON.parse(message)
    const walk = (node) => {
      if (node == null) return ''
      if (typeof node === 'string') return node
      if (Array.isArray(node)) return node.map(walk).join('')
      if (node.text !== undefined) return String(node.text)
      if (node.translate !== undefined) {
        const withNodes = node.with === undefined ? [] : Array.isArray(node.with) ? node.with : [node.with]
        const args = withNodes.map(walk).join(' ')
        return args ? `${node.translate} ${args}` : String(node.translate)
      }
      if (node.rawtext !== undefined) return walk(node.rawtext)
      return ''
    }
    return walk(parsed).trim()
  } catch {
    return message
  }
}

function formatTextPacket (packet) {
  if (packet.type === 'chat' || packet.type === 'whisper' || packet.type === 'announcement') {
    return `${packet.source_name || '?'}: ${packet.message}`
  }
  if (packet.type === 'json' || packet.type === 'json_whisper' || packet.type === 'json_announcement') {
    return plainFromRawtext(packet.message) || packet.message
  }
  return packet.message || ''
}

/** Build the human-readable response from a deserialized command_output packet. */
function formatCommandOutput (output) {
  return (output || []).map((entry) => {
    const params = entry.parameters && entry.parameters.length ? ' ' + entry.parameters.join(' ') : ''
    return `${entry.success ? '' : 'ERROR: '}${entry.message_id}${params}`
  }).join('\n')
}

class McBot {
  /**
   * @param {object} [options]
   * @param {string} [options.host] BDS host, default 127.0.0.1
   * @param {number} [options.port] BDS UDP port, default 19132
   * @param {string} [options.username] offline profile name, default AI_Bot
   * @param {string} [options.version] protocol version, default 1.26.45
   * @param {number} [options.commandTimeoutMs] default timeout for runCommand, default 5000
   * @param {number} [options.connectTimeoutMs] how long connect() waits for spawn, default 20000
   * @param {number} [options.logSize] ring buffer size, default 200
   */
  constructor (options = {}) {
    this.host = options.host || '127.0.0.1'
    this.port = options.port || 19132
    this.username = options.username || 'AI_Bot'
    this.version = options.version || '1.26.45'
    this.commandTimeoutMs = options.commandTimeoutMs || 5000
    this.connectTimeoutMs = options.connectTimeoutMs || 20000
    this.logSize = options.logSize || DEFAULT_LOG_SIZE

    this.client = null
    this.state = 'idle' // idle | connecting | joined | spawned | disconnected
    this.entityId = null // bigint runtime id of our own player
    this.position = { x: 0, y: 0, z: 0 }
    this.rotation = { pitch: 0, yaw: 0 }
    this.health = null
    this.gamemode = null
    this.dimension = null
    this.playerList = new Map() // uuid -> username
    this.messages = [] // ring buffer of { time, kind, text }
    this.world = null // { name, levelId, gameVersion }

    this._spawnWaiters = []
    this._reconnectTimer = null
    this._reconnectAttempts = 0
    this._manualClose = false
  }

  // ---------- connection ----------

  /** Connect (offline, no account) and resolve once the bot has spawned. */
  async connect () {
    if (this.state === 'spawned' || this.state === 'joined') return
    if (this.client) return this.waitForSpawn(this.connectTimeoutMs)

    this._manualClose = false
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this.state = 'connecting'
    this._push('system', `connecting to ${this.host}:${this.port} as ${this.username}`)

    const client = bedrock.createClient({
      host: this.host,
      port: this.port,
      username: this.username,
      offline: true, // no Microsoft/Xbox account
      version: this.version,
      conLog: null,
    })
    this.client = client
    this._wire(client)

    return this.waitForSpawn(this.connectTimeoutMs)
  }

  /**
   * Best-effort connect + spawn wait: resolve true when spawned, false when the
   * timeout expires (connection attempt keeps running in the background).
   */
  ensureConnected (timeoutMs = this.commandTimeoutMs) {
    const spawned = this.connect().then(() => true, () => false)
    const timeout = new Promise((resolve) => {
      setTimeout(resolve, timeoutMs, false).unref() // don't keep the process alive
    })
    return Promise.race([spawned, timeout])
  }

  /** Resolve once spawned; reject on timeout, close, or kick. */
  waitForSpawn (timeoutMs = this.connectTimeoutMs) {
    if (this.state === 'spawned') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      waiter.timer = setTimeout(() => {
        this._dropWaiter(waiter)
        reject(new Error(`Bot did not spawn within ${timeoutMs}ms (state: ${this.state})`))
      }, timeoutMs)
      this._spawnWaiters.push(waiter)
    })
  }

  _dropWaiter (waiter) {
    clearTimeout(waiter.timer)
    const i = this._spawnWaiters.indexOf(waiter)
    if (i !== -1) this._spawnWaiters.splice(i, 1)
  }

  _settleSpawnWaiters (error) {
    const waiters = this._spawnWaiters
    this._spawnWaiters = []
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      if (error) waiter.reject(error)
      else waiter.resolve()
    }
  }

  _wire (client) {
    client.on('join', () => {
      this.state = 'joined'
      this._push('system', 'logged in (offline mode, no account)')
    })

    client.on('start_game', (p) => {
      this.entityId = p.runtime_entity_id // varint64 -> bigint
      this.position = { x: p.player_position.x, y: p.player_position.y, z: p.player_position.z }
      this.gamemode = p.player_gamemode !== 'fallback' ? p.player_gamemode : p.world_gamemode
      this.dimension = typeof p.dimension === 'number' ? DIMENSIONS[p.dimension] || `dimension_${p.dimension}` : p.dimension
      this.world = { name: p.world_name, levelId: p.level_id, gameVersion: p.game_version }
    })

    client.on('play_status', (p) => {
      if (p.status === 'player_spawn') {
        this.state = 'spawned'
        this._reconnectAttempts = 0
        this._push('system', `spawned in ${this.world ? this.world.name : 'world'} at ${this._pos()}`)
        this._settleSpawnWaiters(null)
      }
    })

    // Server-authoritative corrections/teleports for our own player.
    client.on('move_player', (p) => {
      if (!this._isSelf(p.runtime_id)) return
      this.position = { x: p.position.x, y: p.position.y, z: p.position.z }
      this.rotation = { pitch: p.pitch, yaw: p.yaw }
    })

    client.on('respawn', (p) => {
      this.position = { x: p.position.x, y: p.position.y, z: p.position.z }
    })

    client.on('change_dimension', (p) => {
      this.dimension = DIMENSIONS[p.dimension] || `dimension_${p.dimension}`
      this.position = { x: p.position.x, y: p.position.y, z: p.position.z }
    })

    client.on('set_health', (p) => {
      this.health = p.health
    })

    client.on('update_attributes', (p) => {
      if (!this._isSelf(p.runtime_entity_id)) return
      const health = (p.attributes || []).find((a) => a.name === 'minecraft:health')
      if (health) this.health = health.current
    })

    client.on('set_entity_data', (p) => {
      if (!this._isSelf(p.runtime_entity_id)) return
      const health = (p.metadata || []).find((m) => m.key === 'health')
      if (health) this.health = health.value
    })

    client.on('set_player_game_type', (p) => {
      this.gamemode = p.gamemode
    })

    client.on('player_list', (p) => {
      for (const record of p.records || []) {
        if (record.type === 'add') this.playerList.set(record.uuid, record.username)
        else if (record.type === 'remove') this.playerList.delete(record.uuid)
      }
    })

    client.on('text', (p) => {
      const text = formatTextPacket(p)
      if (text) this._push('chat', text)
    })

    client.on('kick', (p) => {
      if (this.client !== client) return
      this._push('system', `kicked: ${p.message}`)
      this.state = 'disconnected'
      this._settleSpawnWaiters(new Error(`Bot was kicked: ${p.message}`))
    })

    client.on('error', (error) => {
      // Without a listener bedrock-protocol re-throws deserialization errors.
      this._push('error', error.message)
    })

    client.on('close', () => {
      if (this.client !== client) return
      this._push('system', 'connection closed')
      this.state = 'disconnected'
      this.client = null
      this._settleSpawnWaiters(new Error('Connection closed before spawn'))
      if (!this._manualClose) this._scheduleReconnect()
    })
  }

  _scheduleReconnect () {
    if (this._reconnectTimer) return
    const delay = Math.min(30000, 1000 * 2 ** this._reconnectAttempts)
    this._reconnectAttempts++
    this._push('system', `reconnecting in ${delay}ms`)
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this.connect().catch((error) => this._push('error', `reconnect failed: ${error.message}`))
    }, delay)
  }

  /** Gracefully disconnect and stop auto-reconnecting. */
  close () {
    this._manualClose = true
    clearTimeout(this._reconnectTimer)
    this._reconnectTimer = null
    this._settleSpawnWaiters(new Error('Bot closed'))
    this.state = 'disconnected'
    if (this.client) {
      try {
        this.client.disconnect('AI_Bot signing off')
      } catch (error) {
        this._push('error', `disconnect failed: ${error.message}`)
      }
      this.client = null
    }
  }

  // ---------- state ----------

  _isSelf (runtimeId) {
    if (this.entityId == null) return false
    try {
      return BigInt(runtimeId) === this.entityId
    } catch {
      return false
    }
  }

  _pos () {
    return `${this.position.x.toFixed(1)}, ${this.position.y.toFixed(1)}, ${this.position.z.toFixed(1)}`
  }

  _push (kind, text) {
    this.messages.push({ time: new Date().toISOString(), kind, text })
    while (this.messages.length > this.logSize) this.messages.shift()
  }

  /** Last n entries of the server message ring buffer. */
  log (n = 20) {
    return this.messages.slice(-Math.max(0, n))
  }

  /** Online players known from the server player_list packet. */
  players () {
    return [...this.playerList.values()]
  }

  /** Full state snapshot, safe for JSON serialization. */
  snapshot () {
    const connected = this.state === 'spawned'
    return {
      connected,
      state: this.state,
      server: `${this.host}:${this.port}`,
      version: this.version,
      username: this.username,
      entityId: this.entityId == null ? null : String(this.entityId),
      position: {
        x: Number(this.position.x.toFixed(2)),
        y: Number(this.position.y.toFixed(2)),
        z: Number(this.position.z.toFixed(2)),
      },
      rotation: { pitch: Number(this.rotation.pitch.toFixed(1)), yaw: Number(this.rotation.yaw.toFixed(1)) },
      health: this.health,
      gamemode: this.gamemode,
      dimension: this.dimension,
      world: this.world,
      players: this.players(),
    }
  }

  // ---------- actions ----------

  /**
   * Send a command as the bot and resolve with the server's response text.
   * Rejects on timeout with a clear error (some commands, like /say, send no command_output).
   */
  runCommand (command, timeoutMs = this.commandTimeoutMs) {
    const cmd = String(command).replace(/^\//, '')
    return this.ensureConnected(timeoutMs).then((connected) => {
      if (!connected) throw new Error(`Bot not connected after ${timeoutMs}ms (state: ${this.state})`)
      return this._sendCommand(cmd, timeoutMs)
    })
  }

  /** Send a command_request and resolve with the matching command_output text. */
  _sendCommand (cmd, timeoutMs) {
    return new Promise((resolve, reject) => {
      const client = this.client
      if (!client) return reject(new Error('Not connected to the server'))
      const uuid = randomUUID()
      const output = []
      let debounce = null
      const done = () => {
        clearTimeout(timer)
        clearTimeout(debounce)
        client.off('command_output', onOutput)
        const text = formatCommandOutput(output)
        if (text) resolve(text)
        else reject(new Error(`Command "${cmd}" returned no output`))
      }
      const onOutput = (packet) => {
        if (!packet.origin || packet.origin.uuid !== uuid) return
        output.push(...(packet.output || []))
        // 'alloutput' is the complete response; otherwise collect briefly in case more parts follow.
        if (packet.output_type === 'alloutput' || packet.output_type === 'all') done()
        else {
          clearTimeout(debounce)
          debounce = setTimeout(done, 150)
        }
      }
      const timer = setTimeout(() => {
        clearTimeout(debounce)
        client.off('command_output', onOutput)
        reject(new Error(`Command timed out after ${timeoutMs}ms with no response: ${cmd}`))
      }, timeoutMs)
      client.on('command_output', onOutput)
      client.queue('command_request', {
        command: cmd,
        origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n },
        internal: false,
        version: 'latest',
      })
    })
  }

  /** Send a plain chat message to players. */
  chat (message) {
    return this.ensureConnected(this.commandTimeoutMs).then((connected) => {
      if (!connected || !this.client) throw new Error(`Bot not connected (state: ${this.state})`)
      this.client.queue('text', {
        type: 'chat',
        category: 'authored',
        needs_translation: false,
        source_name: this.username,
        message: String(message),
        xuid: '',
        platform_chat_id: '',
        has_filtered_message: false,
      })
      this._push('chat', `${this.username}: ${message}`)
    })
  }

  /** Teleport (defaults to self) and wait until the destination area is usable. */
  async tp (x, y, z, player) {
    const wasSelf = !player || player === '@s' || player === this.username
    const response = await this.runCommand(`tp ${player || '@s'} ${num(x)} ${num(y)} ${num(z)}`)
    if (wasSelf) {
      await this._waitForPositionMove(1000)
      await this._waitForAreaLoaded(this.position.x, this.position.y - 1, this.position.z, 3000)
    }
    return response
  }

  /** BDS rejects setblock/fill in areas with no loaded chunk ("outOfWorld"): retry until loaded. */
  async _buildCommand (cmd) {
    for (let attempt = 0; ; attempt++) {
      const response = await this.runCommand(cmd)
      if (!/outOfWorld/.test(response)) return response
      if (attempt >= 4) throw new Error(`${response.trim()} - no loaded chunk at the target (teleport the bot near the build site first)`)
      await delay(600)
    }
  }

  setblock (x, y, z, block) {
    return this._buildCommand(`setblock ${num(x)} ${num(y)} ${num(z)} ${block}`)
  }

  fill (x1, y1, z1, x2, y2, z2, block) {
    return this._buildCommand(`fill ${num(x1)} ${num(y1)} ${num(z1)} ${num(x2)} ${num(y2)} ${num(z2)} ${block}`)
  }

  give (item, count = 1, player) {
    return this.runCommand(`give ${player || '@s'} ${item} ${num(count)}`)
  }

  /** Best-effort wait: resolve early on any own move_player, or after timeout. */
  _waitForPositionMove (timeoutMs) {
    return new Promise((resolve) => {
      const before = this.position
      const deadline = setTimeout(() => {
        clearInterval(poll)
        resolve()
      }, timeoutMs)
      const poll = setInterval(() => {
        if (this.position !== before) {
          clearInterval(poll)
          clearTimeout(deadline)
          resolve()
        }
      }, 25)
    })
  }

  /** Poll "execute if block" until the chunk at the position is loaded (or timeout). */
  async _waitForAreaLoaded (x, y, z, timeoutMs) {
    const bx = Math.floor(x)
    const by = Math.floor(y)
    const bz = Math.floor(z)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const response = await this.runCommand(`execute if block ${bx} ${by} ${bz} air`)
      if (!/outRangedDetectPosition/.test(response)) return true
      await delay(250)
    }
    return false
  }
}

function delay (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function num (value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? String(parsed) : String(value)
}

module.exports = { McBot, formatCommandOutput, plainFromRawtext }
