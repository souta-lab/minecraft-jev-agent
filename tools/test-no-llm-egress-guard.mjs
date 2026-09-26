#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testPath = fileURLToPath(import.meta.url);
const root = join(testPath, '..');
const launcherPath = join(root, 'with-no-llm-egress-guard.mjs');

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 15000, ...options });
}

const namespaceMarker = '--_inside-vtr-egress-test-netns';
if (!process.argv.includes(namespaceMarker)) {
  const env = { ...process.env, VTR_EGRESS_TEST_PARENT_NETNS: readlinkSync('/proc/self/ns/net') };
  const isolated = run('unshare', ['--user', '--map-root-user', '--net', process.execPath, testPath, namespaceMarker], { env, timeout: 60000, stdio: 'inherit' });
  if (isolated.error) {
    process.stderr.write(`egress-guard-test: user/network namespace unavailable: ${isolated.error.message}\n`);
    process.exit(2);
  }
  process.exit(isolated.status ?? 2);
}

assert.ok(process.env.VTR_EGRESS_TEST_PARENT_NETNS, 'test-only network namespace parent marker is missing');
assert.notEqual(readlinkSync('/proc/self/ns/net'), process.env.VTR_EGRESS_TEST_PARENT_NETNS, 'tests must run in a fresh network namespace');

const loopback = run('ip', ['link', 'set', 'lo', 'up']);
assert.equal(loopback.status, 0, `could not enable test-only namespace loopback: ${loopback.stderr}`);
const links = run('ip', ['-brief', 'link']);
assert.equal(links.status, 0, `could not inspect test network namespace links: ${links.stderr}`);
assert.deepEqual(links.stdout.trim().split('\n').map((line) => line.trim().split(/\s+/)[0]), ['lo'], 'test network namespace must contain only loopback');
const ipv4Routes = run('ip', ['route', 'show']);
const ipv6Routes = run('ip', ['-6', 'route', 'show']);
assert.equal(ipv4Routes.status, 0);
assert.equal(ipv6Routes.status, 0);
assert.equal(ipv4Routes.stdout.trim(), '', 'test network namespace must have no IPv4 route');
assert.equal(ipv6Routes.stdout.trim(), '', 'test network namespace must have no IPv6 route');

const tempRoot = mkdtempSync(join(os.tmpdir(), 'vtr-egress-guard-test-'));
const fixturePath = join(tempRoot, 'egress-fixture');
const fixtureSource = `
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static int blocked_connect(void) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 11;
  struct sockaddr_in dest = { .sin_family = AF_INET, .sin_port = htons(80) };
  if (inet_pton(AF_INET, "203.0.113.7", &dest.sin_addr) != 1) return 12;
  errno = 0;
  int rc = connect(fd, (struct sockaddr *)&dest, sizeof(dest));
  int ok = rc == -1 && errno == EACCES;
  close(fd);
  return ok ? 0 : 13;
}

static int blocked_sendto(void) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return 21;
  struct sockaddr_in dest = { .sin_family = AF_INET, .sin_port = htons(53) };
  if (inet_pton(AF_INET, "198.51.100.9", &dest.sin_addr) != 1) return 22;
  errno = 0;
  ssize_t rc = sendto(fd, "x", 1, 0, (struct sockaddr *)&dest, sizeof(dest));
  int ok = rc == -1 && errno == EACCES;
  close(fd);
  return ok ? 0 : 23;
}

static int blocked_sendmsg(void) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return 31;
  struct sockaddr_in dest = { .sin_family = AF_INET, .sin_port = htons(443) };
  if (inet_pton(AF_INET, "192.0.2.17", &dest.sin_addr) != 1) return 32;
  char byte = 'x';
  struct iovec iov = { .iov_base = &byte, .iov_len = 1 };
  struct msghdr msg = { .msg_name = &dest, .msg_namelen = sizeof(dest), .msg_iov = &iov, .msg_iovlen = 1 };
  errno = 0;
  ssize_t rc = sendmsg(fd, &msg, 0);
  int ok = rc == -1 && errno == EACCES;
  close(fd);
  return ok ? 0 : 33;
}

static int allowed_loopback(unsigned port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return 41;
  struct sockaddr_in dest = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
  dest.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(fd, (struct sockaddr *)&dest, sizeof(dest)) != 0) { close(fd); return 42; }
  if (send(fd, "x", 1, 0) != 1) { close(fd); return 43; }
  close(fd);
  return 0;
}

static int allowed_unix(const char *path) {
  int fd = socket(AF_UNIX, SOCK_STREAM, 0);
  if (fd < 0) return 51;
  struct sockaddr_un dest = { .sun_family = AF_UNIX };
  if (strlen(path) >= sizeof(dest.sun_path)) return 52;
  strcpy(dest.sun_path, path);
  if (connect(fd, (struct sockaddr *)&dest, sizeof(dest)) != 0) { close(fd); return 53; }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  int result = blocked_connect(); if (result) return result;
  result = blocked_sendto(); if (result) return result;
  result = blocked_sendmsg(); if (result) return result;
  result = allowed_loopback((unsigned)strtoul(argv[1], NULL, 10)); if (result) return result;
  result = allowed_unix(argv[2]); if (result) return result;
  puts("connect/sendto/sendmsg blocked; IPv4 loopback and AF_UNIX allowed");
  return 0;
}
`;

function sanitizedEnv() {
  const env = { ...process.env };
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']) delete env[key];
  return env;
}

function startTcpServer(host = '127.0.0.1') {
  const server = http.createServer((request, response) => response.end('vtr-egress-ok'));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve({ server, port: server.address().port }));
  });
}

function startUnixServer(socketPath) {
  const server = net.createServer((socket) => socket.destroy());
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(server));
  });
}

function guarded(auditPath, command, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [launcherPath, '--audit', auditPath, '--', command, ...args], {
      env: sanitizedEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 500).unref();
    }, 12000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolve({ status: null, signal: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function auditRows(auditPath) {
  return readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function assertAudit(auditPath, expectedDenials) {
  const rows = auditRows(auditPath);
  const loaded = rows.filter((row) => row.event === 'guard_loaded');
  const closed = rows.find((row) => row.event === 'guard_wrapper_closed');
  assert.ok(loaded.length > 0, 'preload constructor did not produce a loaded record');
  assert.ok(closed?.preloadVerified, 'wrapper did not verify the target PID preload');
  const rootLoaded = loaded.filter((row) => row.pid === closed.childPid);
  assert.equal(rootLoaded.length, 1, 'root target must have exactly one guard_loaded record');
  assert.equal(new Set(loaded.map((row) => `${row.pid}:${row.processStartTicks}`)).size, loaded.length,
    'each observed process start identity must have exactly one guard_loaded record');
  for (const row of loaded) {
    assert.ok(Number.isInteger(row.pid) && row.pid > 0, 'guard_loaded row has invalid process identity');
    assert.ok(Number.isSafeInteger(row.processStartTicks) && row.processStartTicks > 0, 'guard_loaded row has no stable process start identity');
    assert.equal(row.processGroupId, closed.childPid, 'guarded process escaped the owned process group');
    assert.equal(row.reason, 'preload-active');
    for (const key of ['toolSha256', 'sourceSha256', 'librarySha256', 'policySha256']) {
      assert.match(row[key], /^[a-f0-9]{64}$/);
      assert.equal(closed[key], row[key]);
    }
  }
  assert.equal(closed.coverageStatus, 'USERSPACE_ONLY_CLOSED');
  assert.equal(closed.auditPathIdentityVerified, true, 'wrapper did not retain the original audit file identity');
  assert.match(closed.auditDevice, /^\d+$/u);
  assert.match(closed.auditInode, /^\d+$/u);
  assert.equal(closed.processGroupGone, true);
  assert.equal(rows.at(-1), closed, 'wrapper close record must be the final raw audit row');
  const monotonic = rows.filter((row) => row.event !== 'guard_wrapper_closed').map((row) => BigInt(row.monotonicNs));
  assert.ok(monotonic.every((value, index) => index === 0 || value >= monotonic[index - 1]), 'audit rows must be monotonic-clock ordered');
  assert.equal(closed.guardLoadedRows, loaded.length, 'wrapper close must count every root and descendant preload event');
  const denied = rows.filter((row) => row.event === 'blocked_egress');
  assert.equal(denied.length, expectedDenials.length);
  assert.deepEqual(denied.map((row) => row.operation), expectedDenials);
  for (const row of denied) {
    assert.match(row.utc, /^\d{4}-\d\d-\d\dT.*Z$/);
    assert.match(row.monotonicNs, /^\d+$/);
    assert.ok(Number.isInteger(row.pid));
    assert.ok(loaded.some((entry) => entry.pid === row.pid), 'blocked egress came from a process without guard_loaded');
    for (const key of ['toolSha256', 'sourceSha256', 'librarySha256', 'policySha256']) assert.equal(row[key], closed[key]);
    assert.ok(row.endpoint.length > 0);
  }
  return rows;
}

writeFileSync(fixturePath + '.c', fixtureSource);
const fixtureCompile = run(process.env.CC || 'cc', ['-O0', '-fno-builtin', '-Wall', '-Wextra', '-Werror', fixturePath + '.c', '-o', fixturePath]);
assert.equal(fixtureCompile.status, 0, `fixture compile failed: ${fixtureCompile.stderr}`);

const ipv4 = await startTcpServer('127.0.0.1');
const unixPath = join(tempRoot, 'test.sock');
const unixServer = await startUnixServer(unixPath);
try {
  const fixtureAudit = join(tempRoot, 'fixture.jsonl');
  const fixture = await guarded(fixtureAudit, fixturePath, [String(ipv4.port), unixPath]);
  assert.equal(fixture.status, 0, `fixture failed: ${fixture.stderr || fixture.stdout}`);
  assert.doesNotMatch(fixture.stderr, /audit write failed/u);
  assert.match(fixture.stdout, /connect\/sendto\/sendmsg blocked; IPv4 loopback and AF_UNIX allowed/);
  const fixtureRows = assertAudit(fixtureAudit, ['connect', 'sendto', 'sendmsg']);
  assert.match(fixtureRows.find((row) => row.operation === 'connect').endpoint, /^203\.0\.113\.7:80$/);

  const fetchRuntimes = [];
  if (run('node', ['--version']).status === 0) fetchRuntimes.push('node');
  if (run('bun', ['--version']).status === 0) fetchRuntimes.push('bun');
  if (fetchRuntimes.length === 0) fetchRuntimes.push(process.execPath);
  for (const [index, fetchRuntime] of [...new Set(fetchRuntimes)].entries()) {
    const fetchAudit = join(tempRoot, `fetch-${index}.jsonl`);
    const fetchScript = `const r = await fetch('http://127.0.0.1:${ipv4.port}/'); const t = await r.text(); if (t !== 'vtr-egress-ok') process.exit(7); console.log('fetch-loopback-ok');`;
    const fetchRun = await guarded(fetchAudit, fetchRuntime, ['-e', fetchScript]);
    assert.equal(fetchRun.status, 0, `${basename(fetchRuntime)} fetch loopback failed: ${fetchRun.stderr || fetchRun.stdout}`);
    assert.doesNotMatch(fetchRun.stderr, /audit write failed/u);
    assert.match(fetchRun.stdout, /fetch-loopback-ok/);
    assertAudit(fetchAudit, []);

    const externalFetchAudit = join(tempRoot, `fetch-external-${index}.jsonl`);
    const externalFetch = `try { await fetch('http://203.0.113.11:8080/', { signal: AbortSignal.timeout(2500) }); process.exit(8); } catch { console.log('fetch-external-blocked'); }`;
    const externalFetchRun = await guarded(externalFetchAudit, fetchRuntime, ['-e', externalFetch]);
    assert.equal(externalFetchRun.status, 0, `${basename(fetchRuntime)} external fetch did not fail safely: ${externalFetchRun.stderr || externalFetchRun.stdout}`);
    assert.doesNotMatch(externalFetchRun.stderr, /audit write failed/u);
    assert.match(externalFetchRun.stdout, /fetch-external-blocked/);
    assertAudit(externalFetchAudit, ['connect']);
  }

  const nestedRuntime = fetchRuntimes.find((runtime) => basename(runtime) === 'bun') ?? process.execPath;
  const nestedAudit = join(tempRoot, 'nested-children.jsonl');
  const nestedExternal = `const net = require('node:net'); const socket = new net.Socket(); socket.once('error', (error) => process.exit(error.code === 'EACCES' ? 0 : 23)); socket.connect(443, '203.0.113.19');`;
  const nestedScript = `const { execFileSync, execSync } = require('node:child_process'); const sha = execSync('git rev-parse HEAD', { cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit', 3] }).trim(); if (!/^[0-9a-f]{40}$/u.test(sha)) process.exit(21); execFileSync(process.execPath, ['-e', ${JSON.stringify(nestedExternal)}], { stdio: ['ignore', 'pipe', 'pipe'] }); console.log('nested-source-query-and-denial-captured');`;
  const nestedRun = await guarded(nestedAudit, nestedRuntime, ['-e', nestedScript]);
  assert.equal(nestedRun.status, 0, `guarded nested subprocesses failed: ${nestedRun.stderr || nestedRun.stdout}`);
  assert.doesNotMatch(nestedRun.stderr, /audit write failed/u);
  assert.match(nestedRun.stdout, /nested-source-query-and-denial-captured/u);
  const nestedRows = assertAudit(nestedAudit, ['connect']);
  const nestedLoaded = nestedRows.filter((row) => row.event === 'guard_loaded');
  const nestedClosed = nestedRows.find((row) => row.event === 'guard_wrapper_closed');
  assert.ok(nestedLoaded.length >= 3, 'root runtime, nested shell/git, and nested network child must all append guard_loaded rows');
  const denial = nestedRows.find((row) => row.event === 'blocked_egress');
  assert.notEqual(denial.pid, nestedClosed.childPid, 'external denial must come from a descendant whose fd 3 was not explicitly inherited');

  let ipv6Server;
  try {
    ipv6Server = await startTcpServer('::1');
    const ipv6Audit = join(tempRoot, 'ipv6-fetch.jsonl');
    const ipv6Script = `const r = await fetch('http://[::1]:${ipv6Server.port}/'); const t = await r.text(); if (t !== 'vtr-egress-ok') process.exit(9); console.log('fetch-ipv6-loopback-ok');`;
    const ipv6Run = await guarded(ipv6Audit, process.execPath, ['-e', ipv6Script]);
    assert.equal(ipv6Run.status, 0, `IPv6 loopback fetch failed: ${ipv6Run.stderr || ipv6Run.stdout}`);
    assertAudit(ipv6Audit, []);
  } finally {
    if (ipv6Server) await new Promise((resolve) => ipv6Server.server.close(resolve));
  }

  const missingAudit = join(tempRoot, 'missing-executable.jsonl');
  const missingRun = await guarded(missingAudit, join(tempRoot, 'does-not-exist'), []);
  assert.equal(missingRun.status, 125, 'wrapper must fail when a child cannot load the guarded command');
  const missingRows = auditRows(missingAudit);
  assert.equal(missingRows.some((row) => row.event === 'guard_loaded'), false);
  assert.equal(missingRows.at(-1).coverageStatus, 'INCOMPLETE');

  const replacedAudit = join(tempRoot, 'replaced-audit.jsonl');
  const retainedOriginal = `${replacedAudit}.retained`;
  const replacementScript = `const fs = require('node:fs'); fs.renameSync(${JSON.stringify(replacedAudit)}, ${JSON.stringify(retainedOriginal)}); fs.writeFileSync(${JSON.stringify(replacedAudit)}, 'replacement\\n', { flag: 'wx', mode: 0o600 }); console.log('audit-path-replaced');`;
  const replacedRun = await guarded(replacedAudit, process.execPath, ['-e', replacementScript]);
  assert.equal(replacedRun.status, 125, 'replacing the audit pathname must fail closed');
  assert.match(replacedRun.stdout, /audit-path-replaced/u);
  const retainedRows = auditRows(retainedOriginal);
  assert.equal(retainedRows.at(-1).event, 'guard_wrapper_closed', 'wrapper should finalize only the retained original inode');
  assert.equal(retainedRows.at(-1).coverageStatus, 'INCOMPLETE');
  assert.equal(retainedRows.at(-1).auditPathIdentityVerified, false);
  assert.equal(readFileSync(replacedAudit, 'utf8'), 'replacement\n', 'wrapper must never read or append to a replacement path');

  process.stdout.write(`egress guard tests passed: verified preload, allowed AF_UNIX/IPv4+IPv6 loopback, denied connect/sendto/sendmsg, fetch loopback+external denial (${[...new Set(fetchRuntimes)].join(', ')})\n`);
} finally {
  await new Promise((resolve) => ipv4.server.close(resolve));
  await new Promise((resolve) => unixServer.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
}
