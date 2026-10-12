# Security policy

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Use GitHub's private
**Security → Report a vulnerability** advisory flow on this repository instead.

Include what you did, what you expected, what happened, and the smallest reproduction you can.
You will get an acknowledgement on the advisory thread.

## Scope

This project drives a Minecraft client through Mineflayer against a server **you** run. The most
relevant classes of issue here are:

- credential handling: a code path that logs, commits, or echoes a secret value;
- authority/evidence integrity: a path that fabricates a VERIFY/SUCCESS result, weakens an
  acceptance predicate, or hides a fallback behind a passing gate;
- host/runtime boundary: a path that mutates world state outside the Runtime Adapter /
  ActuationPort boundary, or reuses another generation's authority or lease.

## Secrets

Secret material never belongs in this repository. Credentials are resolved at runtime from
permission-restricted files outside the repo (0600), referenced by environment variables, and only
non-secret origin metadata is logged. If you find a committed secret, report it through the advisory
flow rather than opening an issue — assume it is live until rotated.
