#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, closeSync, fdatasyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, resolve, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_PATH = fileURLToPath(import.meta.url);
const SOURCE_PATH = join(HERE, 'no-llm-egress-guard.c');
const POLICY_PATH = join(HERE, 'no-llm-egress-guard.policy.json');
const EXPECTED_POLICY = {
  schema: 'vtr-no-llm-egress-policy/v1',
  allow: [
    'AF_UNIX',
    'AF_INET loopback (127.0.0.0/8)',
    'AF_INET6 loopback (::1)',
  ],
  deny: 'all other socket destinations at intercepted libc egress calls',
  audit: 'append-only JSONL on a verified run-scoped file identity; descendants may reopen the same inode',
};

function fail(message) {
  process.stderr.write(`egress-guard: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  let auditPath;
  const separator = argv.indexOf('--');
  if (separator < 0) fail('usage: with-no-llm-egress-guard.mjs --audit <new-jsonl-path> -- <command> [args...]');
  const options = argv.slice(0, separator);
  const command = argv.slice(separator + 1);
  for (let i = 0; i < options.length; i += 1) {
    if (options[i] === '--audit' && options[i + 1]) {
      auditPath = resolve(options[i + 1]);
      i += 1;
    } else {
      fail(`unknown or incomplete option: ${options[i]}`);
    }
  }
  if (!auditPath) fail('--audit is required; use a fresh path for each run');
  if (command.length === 0) fail('command after -- is required');
  return { auditPath, command: command[0], commandArgs: command.slice(1) };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileSha256(path) {
  return sha256(readFileSync(path));
}

function verifyPolicy(policyBytes) {
  let policy;
  try {
    policy = JSON.parse(policyBytes.toString('utf8'));
  } catch {
    fail('policy JSON is invalid');
  }
  if (JSON.stringify(policy) !== JSON.stringify(EXPECTED_POLICY)) fail('policy JSON differs from the policy enforced by the shared library');
  return sha256(policyBytes);
}

function buildLibrary(sourcePath, outputPath) {
  const compiler = process.env.CC || 'cc';
  if (compiler.trim() !== compiler || /\s/.test(compiler)) fail('CC must name one compiler executable without arguments');
  const result = spawn(compiler, [
    '-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror',
    '-Wl,-z,relro,-z,now', sourcePath, '-ldl', '-o', outputPath,
  ], { stdio: 'inherit' });
  return new Promise((resolveBuild, rejectBuild) => {
    result.once('error', rejectBuild);
    result.once('close', (code) => code === 0 ? resolveBuild() : rejectBuild(new Error(`compiler exited ${code}`)));
  });
}

function timestampRow(event, fields) {
  return `${JSON.stringify({
    schema: 'vtr-no-llm-egress-audit/v1',
    event,
    utc: new Date().toISOString(),
    monotonicClock: 'process.hrtime.relative',
    monotonicNs: process.hrtime.bigint().toString(),
    pid: process.pid,
    ...fields,
  })}\n`;
}

function processGroupExists(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertAuditDescriptor(fd, expected = null) {
  const current = fstatSync(fd, { bigint: true });
  if (!current.isFile() || current.nlink !== 1n || current.uid !== BigInt(process.getuid()) || (current.mode & 0o077n) !== 0n
    || expected !== null && !sameFileIdentity(current, expected)) {
    throw new Error('audit descriptor identity or private-file checks failed');
  }
  return current;
}

function auditPathMatchesDescriptor(path, fd, expected) {
  try {
    const descriptor = assertAuditDescriptor(fd, expected);
    const named = lstatSync(path, { bigint: true });
    return !named.isSymbolicLink() && named.isFile() && sameFileIdentity(named, descriptor);
  } catch {
    return false;
  }
}

function readAuditDescriptor(fd, expected) {
  const before = assertAuditDescriptor(fd, expected);
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER) || before.size > 256n * 1024n * 1024n) {
    throw new Error('audit descriptor exceeds the bounded read limit');
  }
  const size = Number(before.size);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, bytes, offset, size - offset, offset);
    if (read <= 0) throw new Error('audit descriptor changed or ended during positional read');
    offset += read;
  }
  const after = assertAuditDescriptor(fd, expected);
  if (after.size !== before.size) throw new Error('audit descriptor size changed during positional read');
  return bytes.toString('utf8');
}

async function main() {
  if (process.platform !== 'linux') fail('Linux is required');
  for (const key of ['LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH']) {
    if (process.env[key]) fail(`${key} is already set; refusing an ambiguous dynamic-loader environment`);
  }

  const { auditPath, command, commandArgs } = parseArgs(process.argv.slice(2));
  const policyBytes = readFileSync(POLICY_PATH);
  const sourceBytes = readFileSync(SOURCE_PATH);
  const toolBytes = readFileSync(TOOL_PATH);
  const policySha256 = verifyPolicy(policyBytes);
  const toolSha256 = sha256(toolBytes);
  const sourceSha256 = sha256(sourceBytes);
  mkdirSync(dirname(auditPath), { recursive: true });
  const runDir = `${auditPath}.runtime`;
  try {
    mkdirSync(runDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') fail(`runtime artifact directory already exists: ${runDir}`);
    throw error;
  }
  const libraryPath = join(runDir, 'libvtr-no-llm-egress.so');
  const sourceSnapshotPath = join(runDir, 'no-llm-egress-guard.c');
  writeFileSync(sourceSnapshotPath, sourceBytes, { flag: 'wx', mode: 0o600 });
  writeFileSync(join(runDir, 'no-llm-egress-guard.policy.json'), policyBytes, { flag: 'wx', mode: 0o600 });
  await buildLibrary(sourceSnapshotPath, libraryPath).catch((error) => fail(`shared-library build failed: ${error.message}`));
  const librarySha256 = fileSha256(libraryPath);

  const auditFd = openSync(auditPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND | constants.O_CLOEXEC | constants.O_NOFOLLOW,
    0o600);
  let auditIdentity;
  try {
    auditIdentity = assertAuditDescriptor(auditFd);
    if (!auditPathMatchesDescriptor(auditPath, auditFd, auditIdentity)) throw new Error('audit pathname does not identify the newly opened descriptor');
  } catch {
    closeSync(auditFd);
    fail('audit path failed its initial descriptor identity check');
  }
  const env = {
    ...process.env,
    LD_PRELOAD: libraryPath,
    VTR_EGRESS_AUDIT_FD: '3',
    VTR_EGRESS_AUDIT_PATH: auditPath,
    VTR_EGRESS_AUDIT_DEV: auditIdentity.dev.toString(),
    VTR_EGRESS_AUDIT_INO: auditIdentity.ino.toString(),
    VTR_EGRESS_TOOL_SHA256: toolSha256,
    VTR_EGRESS_SOURCE_SHA256: sourceSha256,
    VTR_EGRESS_LIBRARY_SHA256: librarySha256,
    VTR_EGRESS_POLICY_SHA256: policySha256,
  };

  let childAuditFd;
  let child;
  try {
    childAuditFd = openSync(`/proc/self/fd/${auditFd}`,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CLOEXEC);
    assertAuditDescriptor(childAuditFd, auditIdentity);
    child = spawn(command, commandArgs, {
      env,
      detached: true,
      stdio: ['inherit', 'inherit', 'inherit', childAuditFd],
    });
  } catch (error) {
    if (childAuditFd !== undefined) closeSync(childAuditFd);
    closeSync(auditFd);
    fail(`could not start command: ${error.message}`);
  }
  closeSync(childAuditFd);

  const forwardSignal = (signal) => {
    if (child.pid) {
      try { process.kill(-child.pid, signal); } catch {}
    }
  };
  const onSigint = () => forwardSignal('SIGINT');
  const onSigterm = () => forwardSignal('SIGTERM');
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);

  const result = await new Promise((resolveResult) => {
    child.once('error', (error) => resolveResult({ error, code: null, signal: null }));
    child.once('close', (code, signal) => resolveResult({ code, signal }));
  });

  // Keep the guard available to descendants until the command's process group has stopped.
  if (child.pid && processGroupExists(child.pid)) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    if (processGroupExists(child.pid)) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);

  let rows = [];
  let auditReadError = null;
  try {
    rows = readAuditDescriptor(auditFd, auditIdentity).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    // Report below as a preload/audit initialization failure without echoing file contents.
    auditReadError = error;
  }
  const loaded = rows.some((row) => row.event === 'guard_loaded'
    && row.pid === child.pid
    && row.reason === 'preload-active');
  let processGroupGone = null;
  if (child.pid) {
    processGroupGone = !processGroupExists(child.pid);
  }

  const pathBoundBeforeClose = auditPathMatchesDescriptor(auditPath, auditFd, auditIdentity);
  const closeText = timestampRow('guard_wrapper_closed', {
    childPid: child.pid ?? null,
    processGroupId: child.pid ?? null,
    commandName: basename(command),
    childExitCode: result.code,
    childSignal: result.signal,
    preloadVerified: loaded,
    processGroupGone,
    coverageClass: 'user-space-libc-interposition',
    coverageStatus: loaded && processGroupGone && pathBoundBeforeClose ? 'USERSPACE_ONLY_CLOSED' : 'INCOMPLETE',
    externalDeniedAttempts: rows.filter((row) => row.event === 'blocked_egress').length,
    toolSha256,
    sourceSha256,
    librarySha256,
    policySha256,
    libraryPath,
    coverage: 'root-process-load-verified; observed-exec-descendants-reopened-same-audit-inode; process-group-signaled-at-close; syscall-bypass-not-covered',
    guardLoadedRows: rows.filter((row) => row.event === 'guard_loaded').length,
    auditDevice: auditIdentity.dev.toString(),
    auditInode: auditIdentity.ino.toString(),
    auditPathIdentityVerified: pathBoundBeforeClose,
  });
  let closeWriteComplete = false;
  try {
    const bytes = Buffer.from(closeText, 'utf8');
    closeWriteComplete = writeSync(auditFd, bytes) === bytes.length;
    if (closeWriteComplete) fdatasyncSync(auditFd);
  } catch {
    closeWriteComplete = false;
  }
  const pathBoundAfterClose = auditPathMatchesDescriptor(auditPath, auditFd, auditIdentity);
  try {
    if (!closeWriteComplete) throw new Error('close record was not durably appended');
    rows = readAuditDescriptor(auditFd, auditIdentity).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    auditReadError ??= error;
  }
  const finalClose = rows.filter((row) => row.event === 'guard_wrapper_closed');
  const auditFinalized = auditReadError === null && closeWriteComplete && pathBoundBeforeClose && pathBoundAfterClose
    && finalClose.length === 1 && finalClose[0].pid === process.pid
    && finalClose[0].auditPathIdentityVerified === true;
  closeSync(auditFd);

  if (result.error) {
    process.stderr.write(`egress-guard: command launch failed: ${result.error.message}\n`);
    process.exitCode = 125;
  } else if (!loaded || processGroupGone !== true || !auditFinalized) {
    process.stderr.write(`egress-guard: preload verification or process-group closure is incomplete for pid ${child.pid ?? 'unknown'}; see audit status\n`);
    process.exitCode = 125;
  } else if (result.signal) {
    const signalNumbers = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9 };
    process.exitCode = 128 + (signalNumbers[result.signal] || 1);
  } else {
    process.exitCode = result.code ?? 1;
  }
}

await main();
