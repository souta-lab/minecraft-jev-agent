# Linux no-LLM egress guard

`with-no-llm-egress-guard.mjs` launches one command with an `LD_PRELOAD` library that allows AF_UNIX destinations and loopback-only IPv4/IPv6 destinations (`127.0.0.0/8`, `::1`). It denies intercepted non-loopback or unsupported destinations with `EACCES`.

Example:

```sh
bun tools/with-no-llm-egress-guard.mjs \
  --audit /tmp/reach-run/provider-egress-audit.jsonl \
  -- bun tools/run-no-llm-reach-probe.mjs
```

Use a fresh audit path for every invocation. The helper creates the JSONL file with exclusive creation and append mode, then keeps the compiled shared library plus the exact C-source and policy snapshots in `<audit-path>.runtime/`. It writes a `guard_loaded` record before the command's main code runs and verifies that the target PID produced it. If preload or audit initialization is missing, the helper returns a failing status. Denial records contain UTC and `CLOCK_MONOTONIC` timestamps, PID/TID, syscall-level libc operation, destination, and SHA-256 digests for the launcher, C source, compiled library, and policy JSON. Payloads and process environment values are never recorded. Audit write or sync failure stops the target process.

The focused test runs inside a temporary rootless user/network namespace with only loopback enabled. It verifies preload activation, allowed IPv4/IPv6 loopback and AF_UNIX, blocked external `connect`/`sendto`/`sendmsg`, and both Node and Bun `fetch` behavior when those runtimes are installed:

```sh
bun tools/test-no-llm-egress-guard.mjs
```

## Coverage limits

This is a process-scoped **libc interposition guard**, not kernel-enforced network isolation and not a proof that arbitrary code cannot communicate. It interposes `connect`, `sendto`, `sendmsg`, `sendmmsg`, `send`, `write`, and `writev`, and checks the peer for destination-free sends on connected sockets. It does not inspect packet payloads.

Raw syscalls, inline syscall instructions, `io_uring`, static binaries, APIs such as `sendfile`/`splice`, a child that removes `LD_PRELOAD`, or a child that starts a new session can bypass the guard. AF_UNIX is deliberately allowed and could reach a local proxy or daemon that itself has network access. The launcher verifies preload only for the root PID; inherited children produce their own `guard_loaded` records when they keep the environment and audit descriptor. The process-group cleanup and final status report an observed leftover group as `INCOMPLETE`, but cannot detect a descendant that escaped with `setsid`.

For a no-LLM proof, combine these records with the provider-call journal/counters. `coverageStatus: "USERSPACE_ONLY_CLOSED"` says the verified root process ended and its process group was gone; it does **not** imply complete system-call coverage. Treat missing preload rows, audit errors, escaped descendants, or `coverageStatus: "INCOMPLETE"` as incomplete evidence. Use a kernel-level network namespace/cgroup policy when the run must resist untrusted code or prove complete host-level egress confinement.
