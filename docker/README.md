# Docker

Two ways to run: a **single-image** for one-off roles, and a **compose fleet**
that stands up tor + bootnode + gateway + client locally.

## Image

One image, every role. The entrypoint is the unified `rgoe` CLI; the role is the
subcommand, and every `--flag` maps to an `RGOE_*` env var.

```sh
docker build -t rgoe .

docker run --rm rgoe                       # prints the command list
docker run --rm rgoe bootnode --help       # a role's flags
docker run --rm rgoe doctor                # local setup check
docker run --rm -p 8877:8877 rgoe \
  bootnode --port 8877 --admission open --stake-mode mock
```

Notes
- Runs as the non-root `node` user. Anything the code mints at runtime (e.g. the
  bootnode signer key) must land in a writable path — use `/data` (a declared
  volume), e.g. `--signer-key /data/bootnode-signer.key`.
- The bootnode/gateway/client all bind `127.0.0.1`. Run bare like this and only
  the same container can reach them; the compose fleet solves that by sharing
  tor's network namespace (below).

## Fleet (docker compose)

The full local path: one `tor` service publishing two onion services (bootnode
and gateway) plus a SOCKS port, with `bootnode`, `gateway`, and `client` sharing
tor's loopback via `network_mode: service:tor`.

```sh
docker compose up --build
```

### Onion addresses appear on first boot

The onion hostnames are generated the first time tor boots, and their
descriptors take **~10-30s** to publish to the network before circuits work.
tor mirrors the hostnames to a shared volume; read them with:

```sh
docker compose exec tor cat /shared/bootnode.onion
docker compose exec tor cat /shared/gateway.onion
```

(or `docker volume inspect <project>_onions` for the host path). The `client`
service already reads `bootnode.onion` from that volume automatically and exports
it as `RGOE_BOOTNODE_ONION` before starting the shim.

### Driving the client

The shim binds `127.0.0.1:8888` inside tor's namespace, so a published port
can't reach it — drive it from inside the container:

```sh
docker compose exec client \
  curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The shim needs a member secret and the bootnode's signer pubkey. Provide them
before `up` (the compose passes them through):

```sh
export RGOE_SECRET="$(docker run --rm rgoe enroll | ...)"   # a member secret
export RGOE_DIR_SIGNER="<pinned signer pubkey printed in the bootnode log>"
docker compose up --build
```

Without `RGOE_SECRET` the shim prints a helpful error and exits — set it and
re-up. The bootnode prints its pinned signer pubkey at startup
(`docker compose logs bootnode`); that value is `RGOE_DIR_SIGNER`.

### Proof-of-work defense

`HiddenServicePoWDefensesEnabled` is left **commented** in `docker/torrc.services`
on purpose: stock tor (including the Debian package used here) hard-fails config
validation without the `pow` module compiled in. Enable it only on a tor build
that ships the module. This mirrors the repo's `tor/torrc` convention.
