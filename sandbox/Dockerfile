# Root filesystem of PI Lead worker VMs (exported by Gondolin as the guest rootfs).
# glibc, so the prebuilt binaries mise downloads (node, python, go, java…) run as-is.
FROM debian:bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash build-essential ca-certificates curl git gpg unzip xz-utils \
 && install -dm 755 /etc/apt/keyrings \
 && curl -fsSL https://mise.jdx.dev/gpg-key.pub | gpg --dearmor -o /etc/apt/keyrings/mise-archive-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg] https://mise.jdx.dev/deb stable main" \
      > /etc/apt/sources.list.d/mise.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends mise \
 && rm -rf /var/lib/apt/lists/*

# /etc/profile resets PATH, and workers run commands in login shells (bash -lc).
RUN echo '[ -d /opt/mise/shims ] && PATH="/opt/mise/shims:$PATH"' > /etc/profile.d/pi-lead-mise.sh
