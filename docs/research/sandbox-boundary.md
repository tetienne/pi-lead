# Whole-worker sandbox and terminal boundary

Research date: 2026-09-21. Documentation/source inspection only: no installs, VM launches, benchmarks, escape tests, or Herdr session changes. This is a candidate integration, not proof of operational security.

## Conclusion

Run the Pi worker process inside Gondolin, including its extensions and child processes. The official Pi example runs Pi on the host and redirects selected tools; it does not satisfy the bootstrap's whole-worker isolation requirement. Its source overrides `read`, `write`, `edit`, `bash`, and user shell commands and mounts the starting directory read-write. Do not adopt it as the security boundary. [Pinned example](https://github.com/earendil-works/gondolin/blob/29fa74d802112f29c720990aced26165e0d57d84/host/examples/pi-gondolin.ts)

The simplest terminal candidate uses Gondolin's existing PTY support inside a dedicated Herdr tab. A custom terminal protocol is not justified by current evidence. The subsequent [Herdr 0.8.0 inventory](herdr-contracts.md) verifies native host-wrapper recognition and custom status reporting; combined guest input, lifecycle correlation and termination still require an integration test.

## Source baseline and host compatibility

Gondolin's public `main` resolved to commit `29fa74d802112f29c720990aced26165e0d57d84`; the package at that revision identifies itself as `0.12.0` and requires Node >=23.6.0. This identifies inspected source, not an installed or registry-verified release. [Package manifest](https://github.com/earendil-works/gondolin/blob/29fa74d802112f29c720990aced26165e0d57d84/host/package.json)

Current upstream documentation supports macOS and Linux and calls ARM64 its most tested runtime path. QEMU is the default; libkrun is experimental. Thus macOS arm64 and Linux are plausible targets, but this project has not verified either guest image/toolchain on Linux. [README](https://github.com/earendil-works/gondolin#cli-quick-start)

QEMU guest architecture must match its selected QEMU binary; krun requires guest/host architecture matching and backend-specific boot assets. Prefer QEMU first, following upstream's explicit recommendation. Do not expose a backend choice before needed. [Backend matrix](https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/backends.md)

## Native controls and material limits

Gondolin mediates guest HTTP/TLS on the host, rather than providing raw NAT. Its security design describes internal-address filtering, redirect checks, synthetic DNS, explicit filesystem providers, and optional SSH/TCP exception paths. Keep synthetic DNS and internal-range blocking; omit SSH forwarding and mapped TCP. Its guarantees assume a trusted host and hypervisor; VM escapes, same-user host attackers, side channels, and full denial-of-service isolation are outside scope. Allowed servers can receive guest-readable data and may reflect injected credentials. A writable mount deliberately grants access to its contents. [Security design](https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/security.md)

**Update, 2026-09-24: mapped TCP is now allowed, narrowly.** The sidecar-services feature (`sandbox.services`) maps `tcp.hosts` entries at `VM.create`, but only ever `<name>:<port> -> 127.0.0.1:<hostPort>` toward a socat relay the Lead itself starts from trusted config (global or a trusted project's `.pi/pi-lead.json`), never toward an arbitrary guest-reachable host. The mapping bypasses `blockInternalRanges` (that check is HTTP-only), so nothing in this path may be worker- or model-influenced: the service name, image, port and env all come from config the guest cannot write, and the host port is the Lead's own `docker port` resolution, not something a request can redirect to. The earlier "omit mapped TCP" guidance stands for anything not fitting that shape.

**An omitted allowlist is not deny-by-default.** `createHttpHooks` treats `allowedHosts: undefined` as allow-all and `[]` as deny-all. Secret destination restrictions are separate from the global network allowlist. Pass both hooks and placeholder environment to the VM. Substitution covers headers (including Basic auth); query substitution is opt-in, and request bodies are not substituted. Hooks may observe real secrets after replacement, so logs must not capture raw headers. These native primitives avoid inventing a credential proxy, subject to provider compatibility. [Pinned secrets contract](https://github.com/earendil-works/gondolin/blob/29fa74d802112f29c720990aced26165e0d57d84/docs/secrets.md)

The limitations page documents HTTP/1.x mediation, no HTTP/2 or HTTP/3, no full memory/process snapshots, and tmpfs paths excluded from disk checkpoints. Its image-builder restrictions require verification against the eventual pinned image/toolchain; do not infer that a Linux guest automatically supports every mise-managed compiler or binary. [Limitations](https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/limitations.md)

## Terminal bridge and cleanup

The SDK already exposes `vm.exec()` with PTY/stdin options and `proc.attach()` for terminal I/O and resizing. `vm.id` identifies a registered session. An aborted exec promise does **not** guarantee guest-process termination; `vm.close()` is required for VM lifecycle cleanup. A null runner handle can occur during close and alone does not prove completed termination. [Pinned VM API](https://github.com/earendil-works/gondolin/blob/29fa74d802112f29c720990aced26165e0d57d84/docs/sdk-vm.md)

The CLI supports `gondolin bash -- COMMAND`, enabling an entire interactive application to execute in the guest. `gondolin attach` starts a new command in the existing VM; it is not documented as reattaching the original Pi process. A preserved tab, preserved VM, and resumable Pi conversation are separate lifecycle properties. [CLI](https://raw.githubusercontent.com/earendil-works/gondolin/main/docs/cli.md)

Installed Herdr 0.8.0 help was inspected with read-only commands:

- `herdr tab new --help` reports the actual `tab create` syntax with `--label`, `--cwd`, `--env`, and `--no-focus`.
- `herdr agent start --help` accepts a supported canonical agent kind and existing pane; it requires an interactive shell and reports success when the expected agent is detected and ready.

That agent-start contract does not establish support for substituting a Gondolin launcher for Pi. The subsequent [versioned Herdr inventory](herdr-contracts.md) finds an alternative native composition: ordinary pane launch, a host-process `HERDR_AGENT=pi` hint, and trusted custom status reporting. This source evidence supersedes the initial recognition uncertainty; combined runtime behavior remains untested. [Herdr upstream](https://github.com/herdrdev/herdr#readme)

## Candidate integration and remaining proof obligations

These are project recommendations inferred from the sources above, not implemented behavior:

1. A trusted host launcher owns one Gondolin VM per worker, explicit allowlists, placeholders, and artifact collection. Pi and all worker-loaded code run inside it. Do not mount host homes, authentication files, Herdr control sockets, or privileged service sockets.
2. Open the worker's named Herdr tab without focus and connect the native guest PTY. Keep the Lead in its own tab. If native Herdr guest recognition is unavailable, first assess a minimal host adapter against Pi's existing control interfaces; avoid assuming PTY text is a reliable completion protocol.
3. Use an explicit guest workspace and private writable storage. Before choosing host worktree mounts, resolve Git metadata paths, secret files already inside repositories, and writable shared metadata. Collect output through a controlled seam; no worker-output command should be executed on the host.
4. Retain diagnostics on failure but bound execution. A visible failed tab need not imply a live autonomous worker. Collect required artifacts before VM teardown, and prove teardown before reporting no agents remain.

Before implementation can claim this boundary works, verify: Herdr guest detection/control; provider streaming and authentication through mediation without real guest secrets; image/tool versions on macOS arm64 and the selected Linux architectures; blocked egress and secret-reflection behavior; mount/symlink confinement; cancellation and orphan cleanup; and restart reconciliation. These are technical validation tasks, not reasons to ask the user to choose an invented framework.
