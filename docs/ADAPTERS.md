# Adapters: routing a tool or an agent through the fleet

This closes the loop back to the project's origin use case. The whole system exists because
a SearXNG instance run over a raw Tor exit got blocked almost everywhere (the README
["Not done, and why it matters"](../README.md#not-done-and-why-it-matters) and [`exit-blocking-benchmark.md`](exit-blocking-benchmark.md)).
An adapter is how you point that same SearXNG instance (or an AI agent, or any tool) at a
clean, gated egress IP instead, with minimal config and nothing learning who you are.

Stand up a fleet first ([`QUICKSTART.md`](QUICKSTART.md)): a bootnode, at least one gateway,
and a local client Tor SOCKS. Then pick a style.

| You have | Use | Why |
|---|---|---|
| A tool that honors an HTTP proxy (SearXNG, `curl`, most HTTP libs) | **Proxy style**: run `rgoe client`, point the tool at `http://127.0.0.1:8888` | No code change; the shim proves + rotates for every connection |
| Your own code doing many requests (an agent) | **Library style**: call `RgoeClient` directly | One proof per request, no extra proxy process, direct access to the egress IP / gateway used |

Both mint a fresh RLN proof per request and rotate the gateway per request; the anonymity
and rate-limit properties are identical. The proxy is just the library behind an HTTP-CONNECT
front-end (`client/shim.mjs` over `client/rgoe-client.mjs`).

## Shared env

Both styles read the same environment (each maps 1:1 to an `rgoe client` flag; see
[`CONFIG.md`](CONFIG.md)):

| Env | Flag | What |
|---|---|---|
| `RGOE_SECRET` | `--secret` | An enrolled member secret (`rgoe enroll`). Required. |
| `RGOE_BOOTNODE_ONION` | `--bootnode` | The bootnode's v3 onion. The client pulls the live signed directory from it over Tor and rotates gateways per request. |
| `RGOE_DIR_SIGNER` | `--dir-signer` | The bootnode's pinned signer pubkey. The directory is rejected unless it verifies against this. |
| `RGOE_TOR_PORT` | `--tor-port` | Client Tor SOCKS port. Optional; default `9250` (the bundled `scripts/start-tor-client.sh` runs `9260`). |

Static-file discovery (`RGOE_DIRECTORY` + `RGOE_DIR_SIGNER`, no bootnode) also works; see
[`CONFIG.md`](CONFIG.md). `RGOE_BOOTNODE_ONION` wins if both are set.

## Style 1: HTTP proxy (SearXNG, curl, any proxy-honoring tool)

Run the shim. It binds `127.0.0.1:8888` (override with `RGOE_SHIM_PORT`):

```bash
rgoe client \
  --secret <member-hex> \
  --bootnode <bootnode-onion> \
  --dir-signer <bootnode-signer-pubkey>
```

Then point any tool at it. Generic form:

```bash
http_proxy=http://127.0.0.1:8888 https_proxy=http://127.0.0.1:8888 \
  curl https://api.ipify.org?format=json
# or explicitly:
curl -x http://127.0.0.1:8888 https://api.ipify.org?format=json
```

The IP returned is a gateway's, not yours.

### Important: HTTPS / `:443` only

The shim implements HTTP **CONNECT** only, and a gateway egresses **TCP CONNECT to `:443`
only** (TLS stays end-to-end to the target; the gateway relays ciphertext). So every target
you route through it must be reachable over HTTPS. Plain-`http://` egress is not tunneled.
For SearXNG this is fine (its default engines use HTTPS), but scope or disable any
HTTP-only engine.

### SearXNG `settings.yml`

SearXNG routes engine fetches through the proxies under `outgoing.proxies` (httpx-style).
The value is the shim:

```yaml
# searxng settings.yml
outgoing:
  request_timeout: 6.0        # onion + proof adds latency; give engines room
  proxies:
    all://:
      - http://127.0.0.1:8888
```

Config-key confidence:

- **Confident** (verified against SearXNG's official
  [`settings_outgoing`](https://docs.searxng.org/admin/settings/settings_outgoing.html) docs):
  the top-level key is `outgoing.proxies`; values are httpx mount patterns, and the documented
  example uses the `all://` key with a **list** of proxy URLs, with plain `http://host:port`
  proxy URLs accepted. An HTTP-CONNECT proxy like the shim is a valid value.
- **Verify against your SearXNG version**: whether your build also accepts the shorthand
  `http:` / `https:` keys (older/alternate form) instead of the httpx `all://` /
  `https://` mount keys. If you want to scope to HTTPS only (matching the `:443`-only gateway),
  use `https://:` in place of `all://:`; confirm your version parses it before relying on it.

If SearXNG runs in Docker, `127.0.0.1` is the container's own loopback, not the host; run
the shim inside the same network namespace or point the proxy at the shim's reachable
address. See [`docker/README.md`](../docker/README.md) for the bundled compose wiring.

## Style 2: library (`RgoeClient`, for an agent)

For your own code doing many requests, skip the proxy and call the client directly. It is
dependency-free beyond the repo itself:

```js
import { RgoeClient, cleanUp } from "./client/rgoe-client.mjs";

const rgoe = new RgoeClient();                       // reads the shared env above
const res = await rgoe.fetch("https://api.ipify.org?format=json");
console.log(JSON.parse(res.body).ip, "via", res.gateway.onion);   // a gateway's IP
cleanUp();                                           // stop snarkjs workers on exit
```

`rgoe.connect("host:443")` is the lower-level form: a raw duplex tunnel to the target for
your own TLS/protocol. `rgoe.fetch()` is HTTPS-only for the same `:443` reason as above.

A runnable version is [`examples/agent-egress.mjs`](../examples/agent-egress.mjs) (prints the
egress IP). It parses without a fleet but needs a live fleet to actually fetch.

## Privacy note

Whichever style: **each request rotates the gateway and carries a fresh RLN proof.** The
proof has a per-request nullifier (a re-used nullifier on a second distinct signal is a
provable over-spend the gateway slashes), so requests are rate-limited without identifying
you and are mutually unlinkable, even to the gateway. There is no exit node: the client
reaches the gateway by Tor rendezvous, so the gateway never learns your IP, and TLS stays
end-to-end so it sees only ciphertext. Running many queries (SearXNG's fan-out, an agent
loop) does not accumulate a linkable trail.
