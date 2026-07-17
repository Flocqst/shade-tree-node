# network/

Canonical deployment artifacts, one folder per network. Everything that identifies a
live deployment — contract addresses, the gateway onion directory, deploy metadata —
lives here and is committed, so the repo is the source of truth for "what is deployed
where."

```
network/
  <network-name>/            e.g. sepolia, mainnet, anvil-local
    contracts.json           deployed contract addresses + chainId + deployer + block
    directory.json           signed gateway fleet directory (onions, pubkeys, weights)
    README.md                human-readable deployment record
```

Local anvil deploys write `contracts/deployed.local.json` (gitignored) instead — only
real networks get a committed `network/<name>/` record.

The client points at a network with `RGOE_DIRECTORY=network/<name>/directory.json` and
(for on-chain slashing) `RGOE_GROUP_CONTRACT` + `RGOE_RPC_URL` from that network's
`contracts.json`.
