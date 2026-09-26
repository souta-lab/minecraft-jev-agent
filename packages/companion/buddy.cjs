'use strict';

/*
 * companion/buddy.cjs
 * Minimal standalone companion bot: joins the local Leaf 1.21.11 server as
 * AI_Buddy and walks to / follows the human player so the AI is visible in-game.
 *
 * Run:
 *   NODE_PATH=/home/s0u7a/mc-ai/jev-agent/node_modules bun buddy.cjs
 */

const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;

const HOST = '127.0.0.1';
const PORT = 25565;
const USERNAME = 'AI_Buddy';
const PREFERRED_TARGET = 's0u7a';
const RUN_MS = 25 * 60 * 1000;      // run up to 25 minutes
const FOLLOW_INTERVAL_MS = 3000;    // re-check target every ~3s
const REPATH_DISTANCE = 5;          // re-path when farther than this (meters)
const STOP_RANGE = 3;               // GoalNear range: stand within ~2-3 blocks
const HEARTBEAT_MS = 10000;         // heartbeat every ~10s
const RECONNECT_MS = 5000;          // reconnect backoff

const startedAt = Date.now();
let bot = null;
let reconnecting = false;
let finished = false;
let followTimer = null;
let heartbeatTimer = null;
let targetName = null;
let desiredName = null;

function ts() {
  return new Date().toISOString();
}

function log(msg) {
  process.stdout.write(`[${ts()}] ${msg}\n`);
}

function fmtPos(pos) {
  if (!pos) return '?';
  return `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`;
}

function isAiName(name) {
  return /^AI[_-]/i.test(name) || /^AI_[A-Za-z0-9]/i.test(name);
}

function isTargetCandidate(name) {
  if (!name) return false;
  if (name === bot.username) return false;
  if (isAiName(name)) return false;
  return true;
}

function pickTarget() {
  if (!bot) return null;
  const players = bot.players || {};
  if (players[PREFERRED_TARGET]) return PREFERRED_TARGET;
  for (const name of Object.keys(players)) {
    if (isTargetCandidate(name)) return name;
  }
  return null;
}

function targetEntity(name) {
  if (!bot || !name) return null;
  const p = bot.players[name];
  return p && p.entity ? p.entity : null;
}

function getMovements() {
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allow1by1towers = false;
  movements.scafoldingBlocks = [];
  return movements;
}

function followTick() {
  if (!bot || finished || !bot.entity) return;

  const name = pickTarget();
  if (!name) {
    if (targetName !== null) {
      log('TARGET lost (no candidate online); waiting idle');
    }
    targetName = null;
    desiredName = null;
    return;
  }

  if (name !== targetName) {
    targetName = name;
    const ent = targetEntity(name);
    log(`TARGET name=${name} pos=${fmtPos(ent && ent.position)}`);
  }

  const ent = targetEntity(name);
  if (!ent || !ent.position) return; // player list exists but entity not loaded yet

  const myPos = bot.entity.position;
  const dist = myPos.distanceTo(ent.position);

  if (dist > REPATH_DISTANCE) {
    try {
      bot.pathfinder.setMovements(getMovements());
      bot.pathfinder.setGoal(
        new GoalNear(ent.position.x, ent.position.y, ent.position.z, STOP_RANGE)
      );
    } catch (err) {
      log(`PATH error: ${err && err.message}`);
    }
  } else {
    try {
      bot.lookAt(ent.position.offset(0, 1.6, 0), true);
    } catch (err) {
      log(`LOOK error: ${err && err.message}`);
    }
  }
}

function heartbeat() {
  if (!bot || finished) return;
  const name = targetName || 'none';
  const ent = targetEntity(targetName);
  let dist = '?';
  if (ent && ent.position && bot.entity) {
    dist = bot.entity.position.distanceTo(ent.position).toFixed(1);
  }
  const pos = bot.entity ? fmtPos(bot.entity.position) : '?';
  log(`HEARTBEAT target=${name} dist=${dist} pos=${pos}`);
}

function clearTimers() {
  if (followTimer) { clearInterval(followTimer); followTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

function attachListeners(b) {
  b.loadPlugin(pathfinder);

  b.once('spawn', () => {
    log(`SPAWN pos=(${fmtPos(b.entity.position)})`);
    log(`version=${b.version}`);
    reconnecting = false;

    // Initial path to the current target if already visible.
    const name = pickTarget();
    if (name) {
      targetName = name;
      const ent = targetEntity(name);
      log(`TARGET name=${name} pos=${fmtPos(ent && ent.position)}`);
    }

    clearTimers();
    followTimer = setInterval(followTick, FOLLOW_INTERVAL_MS);
    heartbeatTimer = setInterval(heartbeat, HEARTBEAT_MS);
  });

  b.on('playerJoined', (player) => {
    if (isTargetCandidate(player.username)) {
      log(`PLAYER joined name=${player.username}`);
    }
  });

  b.on('playerLeft', (player) => {
    if (player.username === targetName) {
      log(`TARGET disconnect name=${player.username}; waiting idle`);
      targetName = null;
      try { b.pathfinder.stop(); } catch (_) {}
    }
  });

  b.on('kicked', (reason) => {
    log(`KICKED reason=${typeof reason === 'string' ? reason : JSON.stringify(reason)}`);
  });

  b.on('error', (err) => {
    log(`ERROR ${err && err.message}`);
  });

  b.on('end', (reason) => {
    log(`END reason=${reason || 'unknown'}`);
    clearTimers();
    if (!finished) scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnecting || finished) return;
  reconnecting = true;
  targetName = null;
  log(`RECONNECT in ${RECONNECT_MS / 1000}s`);
  setTimeout(() => {
    if (finished) return;
    reconnecting = false;
    connect();
  }, RECONNECT_MS);
}

function connect() {
  if (finished) return;
  log(`CONNECT ${HOST}:${PORT} username=${USERNAME}`);
  try {
    bot = mineflayer.createBot({
      host: HOST,
      port: PORT,
      username: USERNAME,
      version: '1.21.11',
      auth: 'offline',
    });
    attachListeners(bot);
  } catch (err) {
    log(`CONNECT error: ${err && err.message}`);
    scheduleReconnect();
  }
}

// Hard deadline: run up to 25 minutes, then quit cleanly with exit code 0.
setTimeout(() => {
  finished = true;
  clearTimers();
  log('RUN COMPLETE (25m)');
  try {
    if (bot) bot.quit('done');
  } catch (_) {}
  setTimeout(() => process.exit(0), 1000);
}, RUN_MS);

process.on('SIGINT', () => {
  finished = true;
  clearTimers();
  try { if (bot) bot.quit('sigint'); } catch (_) {}
  process.exit(0);
});

connect();
