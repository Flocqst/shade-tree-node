# Agent guide

Use this path when one local agent should use Shade Tree and the rest of the
machine should not. The local Proxy listens on loopback. `shade-tree run` gives
its proxy settings to one child process.

> [!WARNING]
> Research preview. There is no repo-maintained public v4 access profile. Get
> current enrollment and discovery values from the Grove operator you intend to
> use. Do not use the retired Sepolia records as a connection profile.

## 1. Install the agent CLI

You need Node.js 20 or newer, npm, and Tor.

```bash
npm install --global git+https://github.com/dmarzzz/shade-tree-node.git
```

This installs the current source from GitHub. It does not install a package from
the npm registry. For a reproducible integration, append `#<commit-sha>` to the
Git URL.

Use a repository checkout instead when developing the JavaScript SDK or running
the bundled Tor helper:

```bash
git clone https://github.com/dmarzzz/shade-tree-node.git
cd shade-tree-node
npm ci && npm link
```

## 2. Get a current access profile

Ask one Grove operator for:

- a member secret or enrollment path;
- the Elder Tree onion and its raw 64-hex Canopy signer;
- the tier used when your leaf was enrolled;
- the member-set input for your admission path.

Invited access uses an operator-supplied `members.json`. Staked or paid access
also needs the operator's current RPC and contract values. The Elder onion and
signer are one trust-pinned pair. Get both from the same operator.

## 3. Start the local Proxy

For invited access, save the supplied member list locally and use a system Tor
SOCKS port:

```bash
read -s SHADE_TREE_SECRET && export SHADE_TREE_SECRET
read -r SHADE_TREE_BOOTNODE_ONION && export SHADE_TREE_BOOTNODE_ONION
read -r SHADE_TREE_DIR_SIGNER && export SHADE_TREE_DIR_SIGNER
read -r SHADE_TREE_LIMIT && export SHADE_TREE_LIMIT
```

Paste the member secret at the hidden prompt and press Enter. Then start the
Proxy:

```bash
SHADE_TREE_MEMBERS_FILE=./members.json \
shade-tree proxy \
  --bootnode "$SHADE_TREE_BOOTNODE_ONION" \
  --dir-signer "$SHADE_TREE_DIR_SIGNER" \
  --limit "$SHADE_TREE_LIMIT" \
  --tor-port 9050
```

The secret is not echoed or placed in the long-running Proxy's process
arguments.

The operator must give you the enrolled tier. Use `8` only when the operator
confirms the default tier; a mismatched tier derives a different leaf and fails
membership verification.

RLN slot allocation is default-on, durable, and atomic across Proxy/SDK/Rust
processes using the same public member leaf. It stores no bearer secret and
fails closed on corrupt, unavailable, or locked state. A crash or local proof
failure burns the already-reserved slot, so restart is safe but may reach the
epoch budget sooner. Do not delete or edit the state to reclaim capacity inside
an epoch.

Tor Browser normally uses port 9150. The repository helper
`scripts/start-tor-client.sh` uses 9260. If the operator gives you one pinned
node instead of an Elder Tree, replace the discovery flags with
`--onion <node.onion>`.

For a staked or paid profile, also set the supplied contract, RPC, tier, and leaf
source values. See [configuration](CONFIG.md) and [member onboarding](JOIN.md).

## 4. Launch one agent through it

Open another terminal:

```bash
shade-tree run -- your-agent
```

For Hermes, the shape is:

```bash
shade-tree run -- hermes
```

`shade-tree run` checks the local Proxy before launch. It gives HTTP, HTTPS, and
WSS proxy variables only to its child. The current shell and unrelated services
remain unchanged. Inherited `SHADE_TREE_*` Proxy credentials and operator
settings are stripped before the agent starts. Only the scoped Shade Tree
routing markers are added back.

If an agent ignores standard proxy variables, point its HTTP proxy setting at
`http://127.0.0.1:8888`. The Proxy accepts HTTP CONNECT only, and nodes permit
target port 443. TLS continues to the destination.

## Library integration

Agents that own their networking can use `ShadeTreeClient` directly. Add the Git
dependency to the agent project:

```bash
npm install git+https://github.com/dmarzzz/shade-tree-node.git
```

Then import `ShadeTreeClient` from `shade-tree-node/client`. The same profile
values apply. Read the [SDK reference](SDK.md) and the tested
[`examples/agent-egress.mjs`](../examples/agent-egress.mjs) example.

## Current boundary

- The node sees the target hostname, port, timing, lifetime, and traffic volume.
- TLS hides the application path and body from the node when the agent uses HTTPS.
- Tor does not prevent timing correlation by an observer who can watch both ends.
- One proof admits one CONNECT tunnel, not every HTTP request inside it.
- RLN slot state is local and fail-closed; back it up only as opaque state and never rewind it inside an epoch.

Read [Adapters](ADAPTERS.md) for proxy-aware tools and the
[threat model](THREAT-MODEL.md) for the exact guarantees.
