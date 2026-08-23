# Client SDK: `ShadeTreeClient`

The `ShadeTreeClient` library is the client's hardened core, callable directly with no local
proxy process. Use it when the client is your own code (an AI agent, a SearXNG-style tool
doing many queries) and you would rather call a function than run and point at an HTTP proxy.
It mints a fresh RLN membership proof per tunnel and rotates the gateway per tunnel, so the
anonymity and rate-limit properties are identical to the proxy shim (`client/shim.mjs`, which
is itself just an HTTP-CONNECT front-end over this same class).

For the proxy style and the side-by-side comparison, see [`ADAPTERS.md`](ADAPTERS.md)
("library style" is Style 2). A runnable end-to-end example is
[`examples/agent-egress.mjs`](../examples/agent-egress.mjs) (and
[`examples/agent-fetch.mjs`](../examples/agent-fetch.mjs)).

## Status: not published yet

The package declares its public SDK surface via the `exports` map in `package.json`, but
`"private": true` is intentionally still set — nothing is on npm yet (publishing is gated
until Gate 1+2 clear; see [`SHIP-PLAN.md`](SHIP-PLAN.md), T-FEAT-3). So today the import is a
**local path** into a checkout of this repo:

```js
import { ShadeTreeClient, cleanUp } from "./client/shade-tree-client.mjs";
```

Once published, the same class will resolve by the package's public subpath — this is the
entry the `exports` map reserves:

```js
// future, post-publish:
import { ShadeTreeClient } from "shade-tree-node/client";
```

Only the `./client` subpath (and `./package.json`) is a public entry; everything else under
the repo is internal. A native, single-binary Rust client is a separate future distributable
(crate `shade-tree-client`, its own release step, T-RUST-4) — not covered here.

## Constructor

```js
const shade-tree = new ShadeTreeClient(opts);
```

Every option has an `SHADE_TREE_*` environment fallback (the same env the proxy and
`shade-tree client` flags read; see [`CONFIG.md`](CONFIG.md) and [`ADAPTERS.md`](ADAPTERS.md)).
Options passed explicitly win over env.

| Option | Env fallback | Default | What |
|---|---|---|---|
| `secret` | `SHADE_TREE_SECRET` | — (required) | An enrolled member secret (`shade-tree enroll` / `shade-tree join`). The client throws if neither is set. |
| `onion` | `SHADE_TREE_ONION` | none | Pin one gateway onion for every request (skips directory selection). A trailing `.onion` is stripped. |
| `directory` | `SHADE_TREE_DIRECTORY` | none | Path to a static **signed** directory JSON (offline discovery). Requires `dirSigner`. |
| `dirSigner` | `SHADE_TREE_DIR_SIGNER` | none | The pinned directory signer pubkey. A directory is rejected unless it verifies against this — there is no unpinned default (unpinned = trust-on-first-use). |
| `torHost` | `SHADE_TREE_TOR_HOST` | `127.0.0.1` | Client Tor SOCKS host. |
| `torPort` | `SHADE_TREE_TOR_PORT` | `9250` | Client Tor SOCKS port. (The bundled `scripts/start-tor-client.sh` runs `9260`.) |
| `socksIsolation` | `SHADE_TREE_SOCKS_ISOLATION` (`0` disables) | `true` | Per-tunnel SOCKS circuit isolation (T-FEAT-17): each logical request gets a distinct SOCKS credential derived from its nonce, so distinct requests ride distinct Tor circuits while a retry/failover of one request reuses its own. Harmless against a Tor daemon without `IsolateSOCKSAuth` or a plain no-auth SOCKS proxy. |
| `dialAttempts` | — | `4` | Retries per gateway through onion cold-start before failing over to the next candidate. |
| `socksClient` | — | real `socks` lib | Injectable SOCKS client (tests pass a fake). |

Live bootnode discovery (the dynamic fleet) is selected by the `SHADE_TREE_BOOTNODE_ONION`
environment variable together with `dirSigner`/`SHADE_TREE_DIR_SIGNER` (the bootnode's signer). It
is read from the environment by the selection layer rather than a constructor option;
`SHADE_TREE_BOOTNODE_ONION` wins over a static `directory` if both are set. Gateway resolution
order per tunnel: pinned `onion` → directory selection (bootnode or static file) → a local
`tor/hs/hostname` (dev). If none resolve, `connect()`/`fetch()` throw.

## Methods

### `await shade-tree.fetch(url, opts?)` → `{ status, headers, body, gateway }`

HTTPS over the tunnel, end-to-end TLS to the target (the gateway relays ciphertext only).

- `url` must be `https://` — the gateway egresses TCP CONNECT to `:443` only; plain
  `http://` is rejected.
- `opts`: `{ method, headers, body, onEvent, onion }`. `method` defaults to `GET`. `onion`
  pins a gateway for this one call. `onEvent(e)` is an optional progress hook.
- Returns `{ status, headers, body }` (`body` is a UTF-8 string), plus `gateway` = the
  `{ onion, slot, nullifier }` actually used.

### `await shade-tree.connect(target, opts?)` → raw duplex stream

The lower-level form: a raw duplex tunnel to `target` (`"host:port"`, e.g.
`"api.ipify.org:443"`) via a gateway, for your own TLS/protocol. Do your own
`tls.connect({ socket })` — TLS stays end-to-end. Builds ONE proof and reuses the SAME
envelope across gateway failover (the deterministic-retry invariant). The returned stream
carries `stream.shade-tree = { onion, slot, nullifier }`. `opts`: `{ onEvent, onion }`.

`onEvent(e)` phases: `prove` (with the Groth16 public signals + proof points on `done`),
`dial`, `gate`, and for `fetch` also `egress`.

### `cleanUp()`

Named export (not a method). Terminates the snarkjs proving workers so the process can exit.
Call it once you are done (e.g. in a `finally`).

## Environment read

`SHADE_TREE_SECRET`, `SHADE_TREE_ONION`, `SHADE_TREE_DIRECTORY`, `SHADE_TREE_DIR_SIGNER`, `SHADE_TREE_BOOTNODE_ONION`,
`SHADE_TREE_TOR_HOST`, `SHADE_TREE_TOR_PORT`, `SHADE_TREE_SOCKS_ISOLATION`. These map 1:1 to the constructor
options above (and to `shade-tree client` flags); full descriptions in [`CONFIG.md`](CONFIG.md).

## Minimal example

```js
import { ShadeTreeClient, cleanUp } from "./client/shade-tree-client.mjs";
// (post-publish: import { ShadeTreeClient, cleanUp } from "shade-tree-node/client";)

const shade-tree = new ShadeTreeClient({
  secret: process.env.SHADE_TREE_SECRET,        // an enrolled member secret
  directory: process.env.SHADE_TREE_DIRECTORY,  // (or set SHADE_TREE_BOOTNODE_ONION for live discovery)
  dirSigner: process.env.SHADE_TREE_DIR_SIGNER, // pinned signer — no unpinned default
  torPort: 9260,                          // the bundled client Tor SOCKS
});

try {
  const res = await shade-tree.fetch("https://api.ipify.org?format=json");
  console.log(JSON.parse(res.body).ip, "via", res.gateway.onion);  // a gateway's IP, not yours
} finally {
  cleanUp();  // stop snarkjs workers so the process exits
}
```

Each `fetch`/`connect` mints a fresh proof and picks a (possibly different) gateway; running
many from an agent loop keeps every request mutually unlinkable, even to the gateway. Needs a
live fleet to actually egress — stand one up with [`QUICKSTART.md`](QUICKSTART.md).
