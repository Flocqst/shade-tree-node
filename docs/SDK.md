# JavaScript client

`ShadeTreeClient` is the programmatic form of the Shade Tree client. It creates
access proofs, chooses a node, and opens a raw HTTPS tunnel without starting
the local proxy. The proxy in `client/shim.mjs` uses the same class.

For most existing agents, the smaller integration is still:

```sh
shade-tree proxy
shade-tree run -- your-agent
```

Use the SDK when the calling program owns its networking. Runnable examples
live in [`examples/agent-egress.mjs`](../examples/agent-egress.mjs) and
[`examples/agent-fetch.mjs`](../examples/agent-fetch.mjs).

## Status

This is a research-preview API. The package remains private on npm, so install
the Git repository in your agent project:

```sh
npm install git+https://github.com/dmarzzz/shade-tree-node.git
```

Then use the exported client surface:

```js
import { ShadeTreeClient, cleanUp } from "shade-tree-node/client";
```

Pin the Git URL to a commit for a reproducible build. Everything else beneath
the repository is internal.

## Constructor

```js
const shadeTree = new ShadeTreeClient(options);
```

Explicit options override environment values. User-facing configuration with
an environment fallback is listed below; test injection hooks such as
`socksClient`, `prove`, and `loadGroupFn` are intentionally omitted.

| Option | Environment | Default | Meaning |
| --- | --- | --- | --- |
| `secret` | `SHADE_TREE_SECRET` | required | Locally held enrolled-member secret. |
| `onion` | `SHADE_TREE_ONION` | none | Pin one node for each tunnel and skip canopy selection. |
| `directory` | `SHADE_TREE_DIRECTORY` | none | Static signed directory path. Requires `dirSigner`. |
| `dirSigner` | `SHADE_TREE_DIR_SIGNER` | none | Pinned directory signer public key. Without it, directory mode is disabled. There is no trust-on-first-use fallback. |
| `torHost` | `SHADE_TREE_TOR_HOST` | `127.0.0.1` | Tor SOCKS host. |
| `torPort` | `SHADE_TREE_TOR_PORT` | `9250` | Tor SOCKS port. The bundled client script uses `9260`. |
| `socksIsolation` | `SHADE_TREE_SOCKS_ISOLATION` | enabled | Give each CONNECT tunnel distinct SOCKS credentials. This isolates Tor streams only when the Tor endpoint enables `IsolateSOCKSAuth`. |
| `limit` | `SHADE_TREE_LIMIT` | `SHADE_TREE_SLOTS`, usually `8` | The private rate tier used when the member leaf was enrolled. |
| `leafSource` | `SHADE_TREE_LEAF_SOURCE` | `auto` | Pin `invited`, `staked`, or `paid` membership discovery. |
| `maxAnon` | `SHADE_TREE_MAX_ANON` | disabled | Restrict selection to invited-only gateways; requires an invited leaf. |

`dialAttempts` is a constructor-only retry count and defaults to `4`.
`fetchTimeoutMs` bounds a complete `fetch()` call and defaults to `120000`.
`fetchMaxBodyBytes` caps the buffered response body and defaults to `8388608`
(8 MiB). These are constructor defaults; one call can override them with
`timeoutMs` and `maxBodyBytes`:

```js
await shadeTree.fetch(url, { timeoutMs: 30_000, maxBodyBytes: 1_048_576 });
```

Timeouts reject with `ShadeTreeFetchError` code `SHADE_TREE_FETCH_TIMEOUT`.
Oversized bodies reject with code `SHADE_TREE_FETCH_BODY_TOO_LARGE`. The error
also carries the active bound (`timeoutMs` or `maxBodyBytes`) and requests,
responses, and tunnels acquired by that call are closed.

`SHADE_TREE_BOOTNODE_ONION` is environment-only dynamic discovery; it requires
the pinned directory signer and takes precedence over a static directory.

Slot accounting is process-local. Never create two clients with one member
secret. After any CONNECT attempt, wait for the next epoch before restarting a
client with that secret. Persistent coordination is tracked in
[issue #75](https://github.com/dmarzzz/shade-tree-node/issues/75).

Node resolution for each tunnel is: call-level onion pin, client-level onion
pin, signed directory selection, then the local development onion. If none can
be resolved, the call fails closed.

## `fetch`

```js
const result = await shadeTree.fetch("https://example.com/data", {
  method: "GET",
  headers: {},
  onEvent(event) {},
});
```

`fetch()` accepts HTTPS URLs only and returns:

```js
{
  status,
  headers,
  body,
  gateway: { onion, slot, nullifier, receipt, artifact, leafSource }
}
```

TLS terminates at the destination. The serving gateway can still observe the
destination host, tunnel timing, lifetime, and traffic volume.

## `connect`

```js
const stream = await shadeTree.connect("example.com:443", { onEvent });
console.log(stream.shadeTree.onion);
```

`connect()` returns a raw duplex stream. Wrap it with `tls.connect({ socket:
stream })` for your own application protocol. The stream metadata is:

```js
stream.shadeTree = { onion, slot, nullifier, receipt, artifact, leafSource };
```

A single proof and envelope are reused across gateway failover for that tunnel.
Separate calls receive distinct RLN transcripts and nullifiers. This does not
prevent a gateway or destination from correlating tunnels through timing,
volume, accounts, cookies, or other application metadata.

Progress events use the phases `canopy`, `select`, `prove`, `dial`, `gate`, and
`receipt`; `fetch()` also emits `egress`. `canopy` appears only when dynamic
discovery performs a live Elder Tree refresh. It emits `query`, followed by one of:

```js
{ phase: "canopy", status: "verified", issued, count }
{ phase: "canopy", status: "cache", issued, count }
{ phase: "canopy", status: "error", reason: "unavailable-or-invalid" }
```

An in-memory refresh-window hit and a static directory read emit no canopy
event. Canopy events are local callbacks. They carry no onion, target, URL,
secret, raw response, request identifier, or shared query counter. Progress
callbacks are best-effort and do not change the result.

## Cleanup

`cleanUp()` is a named export, not a client method. Call it once after the last
request so the proof worker can exit:

```js
import { ShadeTreeClient, cleanUp } from "shade-tree-node/client";

const shadeTree = new ShadeTreeClient({
  secret: process.env.SHADE_TREE_SECRET,
  directory: process.env.SHADE_TREE_DIRECTORY,
  dirSigner: process.env.SHADE_TREE_DIR_SIGNER,
  torPort: 9260,
});

try {
  const response = await shadeTree.fetch("https://api.ipify.org?format=json");
  console.log(response.body, response.gateway.onion);
} finally {
  cleanUp();
}
```

See [`CONFIG.md`](CONFIG.md) for the complete configuration reference and
[`THREAT-MODEL.md`](THREAT-MODEL.md) for the limits of the design.
