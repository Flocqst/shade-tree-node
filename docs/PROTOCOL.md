# Reputation-gated egress: a protocol design for anonymous paid access

**Status.** The access layer is a live proof of concept. The payment layer is design, not built. Any contract, fee, or binding below is a plan; measured numbers are marked. Written to be read by people who do this for a living, so it is concrete, and where a claim is a deployment parameter rather than a proven bound, it says so.

## 1. Problem

An open clean-IP egress is blocklisted within hours, because exit IPs are a shared resource and one abuser ruins them for everyone. We publish the egress as a Tor v3 onion service that forwards to clearnet only for a client presenting a valid anonymous credential, and drops everyone else. No exit node. The gateway never learns the client IP. The destination sees the gateway's IP, not a Tor exit and not the client.

The live credential is a Semaphore v4 membership proof with epoch-scoped nullifiers, the RLN construction at PoC fidelity: a member proves in zero knowledge that they own the secret behind some leaf in a Merkle tree; the proof carries a nullifier derived from (secret, epoch), so within an epoch a member always produces the same nullifier (rate-limit without identity) and across epochs it rotates (unlinkable over time). The gateway meters a per-nullifier budget per epoch. Measured: proof generation 240ms (laptop) to 800ms (2 vCPU gateway), once per epoch, cached client-side; verification 10 to 32ms per request, account-independent within noise, so timing does not fingerprint the member.

We are adding access granted by **payment** rather than a local enroll command. The decision this document makes is what *kind* of payment.

**The constraint that shapes everything: we cannot ban or attribute.** Anonymity is the product, so we deliberately cannot tell which user poisoned an IP. The gateway operator must be unable to deanonymize its own users by cryptography, not by policy. Every enforcement idea has to survive that fact.

## 2. Design goals

1. **Anonymous.** Cryptographic unlinkability between who paid and who used. Not no-KYC, actual unlinkability.
2. **No single facilitator.** The protocol assumes interaction with two things only: the permissionless chain (many nodes, no operator) and the operator you buy from (irreducible). No relayer, no association-set curator, no mint. The operator is made cryptographically unable to link payer to user.
3. **Ethereum L1.** Every L2 runs a single sequencer, exactly the party that can censor, reorder, and observe. L1 has no sequencer. Here L1 is the anonymity choice, not a tax paid for one.
4. **Cheap and scalable.** Cost and state grow with active users on hardware we control, not with block space. No expensive operation per message: per-request cost is a cached token check, never a fresh proof or on-chain tx.

## 3. Two use cases, two economics

One access primitive, two workloads with different abuse surfaces.

**Search engines.** A query is nearly free to the user. The scarce resource is the clean IP's reputation, a shared externality: one abuser's scraping poisons the IP for everyone, and we cannot attribute it. Cheap, high-volume abuse is the threat.

**Private Ethereum transactions.** Naturally throttled: a tx is rate-limited by gas, nonce, and balance, so you cannot fire an unbounded stream from a funded account. And the user already pays gas at the moment of use, which opens a binding search lacks: the access fee can be fused into the work. We intend to **colocate these gateways with home-staker software**. Home stakers run validators on residential IPs, which are high-reputation rather than flagged datacenter ranges; private-tx egress then looks like ordinary validator p2p traffic; the set of gateways becomes a naturally distributed fleet of clean residential IPs (the real answer to the scarce-IP problem); and the access fee subsidizes home staking, so the payment funds decentralization instead of one datacenter operator. It also softens goal 2: for this use case there are many independent operators a user can choose between, not one.

The access layer is shared. The payment binding is not.

## 4. Stake or payment

The load-bearing decision.

**Stake** (a refundable bond) deters only abuse you can **slash**, and slashing needs attributable misbehavior. RLN can slash exactly one thing: exceeding your per-identity rate limit within an epoch (two messages under one nullifier recover the key). That is not the abuse we fear. Poisoning an IP is, to the gateway, a valid in-budget request from an anonymous member. Nothing to slash. And because the bond refunds, a patient adversary locks capital once, spreads it over Sybil identities, stays inside every per-identity limit, consumes huge bandwidth, poisons the shared IP, and withdraws. Cost per request approaches zero. Stake also locks capital and makes an RPC user ask when they get it back.

**Payment** (a consumed fee) inverts this. The resource costs money every time, so abuse is self-throttling and no identification is ever required.

> We cannot punish, so we must price. We cannot attribute, so we charge up front per unit, rather than bond and slash.

Both use cases land on payment, for different supporting reasons (search because the externality must be priced in, RPC because the workload is already on-chain and self-limiting). Stated honestly: payment bounds *volume* and *funds recovery*. It does not *prevent* poisoning, because a single request can poison an IP and nothing buildable stops that under anonymity. The fee rations the scarce resource and pays to rotate IPs, so a poisoned IP becomes an amortized cost the abuser paid into. We convert an unsolvable enforcement problem into a pricing problem. Section 8 is honest that the pricing is not yet proven.

## 5. The protocol

**Two frequencies.** Funding is infrequent, may be heavy, and is where anonymity is won. Access is per-message and near-free, a cached credential check. Payment gates issuance; it adds no per-message cost. The access half already runs.

**Layer 0, decorrelation (optional, user's choice).** To keep a funding address from being publicly known as a customer, route it through any large shared shielded pool into a fresh address first. The protocol mandates no specific pool (Railgun, Privacy Pools, a CEX, a bridge are all replaceable). That is how no-single-party holds at the identity layer. A curator-free default is Railgun (client-side proof of innocence, decentralized broadcasters) over Privacy Pools (whose association-set provider is a curator).

**Layer 1, deposit and off-chain redemption.** A minimal immutable contract:

```
deposit(commitment) payable
    require msg.value == D            // one fixed denomination, so amounts never fingerprint
    append commitment to a Merkle tree
sweep() onlyOperator
    transfer accumulated balance to the operator   // how the operator is paid
```

No on-chain user withdrawal. Funds accumulate; the operator sweeps (revealing only a count). The commitment preimage is spent **off chain**, to the gateway, as the same proof the gateway already verifies: Merkle membership plus an epoch nullifier plus a trusted-root match. The only swap from the live system is the tree: the group becomes the **on-chain deposit set** instead of the enrolled list. The gateway reads the root from its own node, checks the nullifier is unspent, grants budget. This is zk-creds, "insertion equals issuance" (Rosenberg et al., S&P 2023), with one twist: redeem off chain, so the user never needs a gas-funded fresh address, which is what otherwise forces a relayer back in.

The deposit `D` is **consumed, not staked**. That is what makes it Sybil-proof: more identities never lower your per-unit cost. `D` buys a budget of `N` units, metered by the existing per-nullifier count; the price `D/N` rations the IP and funds rotation.

**Per-use-case binding.** Search has no natural on-chain event per query, so a deposit pre-buys `N` queries (prepaid metered credit). Private RPC fuses the fee into the submission: the relay behaves like a builder or ERC-4337 bundler that forwards only a tx carrying a tip to the operator, so payment and consumption are the same on-chain event, the strongest form of settled-not-promised.

## 6. Leak ledger

| Link | Where it breaks | Residual |
|---|---|---|
| payer address to use | off-chain zk membership over the deposit set | set is our deposit count under the root, small at low volume |
| funding identity to customer set | optional Layer 0 hop through a large shared pool | bounded by the pool, shrunk by unique amounts and timing |
| deposit amount fingerprint | single fixed denomination | reintroduced by any tiered price |
| client IP to anything | redemption rides the existing onion | standard Tor caveats |
| operator linking payment to use | cannot, the proof hides which leaf | deposit-to-first-use timing correlation |
| RPC fee to the tx | the fused tip is visible | builder / private-mempool linkage, see Q5 |

Two facilitator-parties are gone by construction: no relayer (nothing is submitted for the user), no curator (the gateway verifies its own deposit set and learns nothing about which depositor), no mint (value settles on chain).

## 7. Rejected

- **Payment channels, including zk channels** (BOLT, Green and Miers, CCS 2017; descendants AMHL, A2L, the dead zkChannels line). A channel needs a persistent counterparty established before use, and BOLT's own Tor example concedes every payment on a channel links to all the others. That persistent counterparty is the link we destroy.
- **Single-mint ecash (Cashu, Taler).** A mint sees every payment and holds the float. The single-party dependency we exist to avoid.
- **Privacy Pools as a mandated step.** Its association-set provider is a curator. We keep shielded pools as a user-chosen Layer 0 rail, not a protocol party.
- **On-chain redemption.** Trustless, but needs a gas-funded fresh address, reintroducing a relayer and an L1 tx per redemption. Loses cheap, ergonomic, scalable at once.
- **Stake.** Section 4.

## 8. Built vs designed

Built and measured: the onion egress, the membership proof, the epoch nullifier, the per-nullifier budget, the two-machine split, and the benchmarks in section 1. Designed, not built: the entire payment layer (deposit/sweep contract, off-chain redemption, both bindings, the rotation economics). Parameters that are knobs with defensible defaults and no proof: the issuance batch size `K`, the epoch length, the per-IP exposure cap `E`, and the price `D/N`.

## 9. Open questions for review

Ordered by how much they worry us.

1. **Redemption-set vs upstream-set size.** Payer-to-use unlinkability is bounded by deposits to *our* contract, small at low volume. Layer 0 protects funding identity, not the redemption link. Is there a construction where the redemption proof borrows a large external pool's set directly, so the link is bounded by the big set, not our deposit count? Or is a small redemption set the price of self-hosting the gate? (Home-staker colocation multiplies operators; can independent gateways share one redemption root to pool their sets without trusting each other?)
2. **The singleton, quantified.** Every credential primitive scopes transport and timing metadata out, so a 1:1 deposit-then-redeem re-links payer to user. We defend with batching, Tor, and epoch windows. Is there a tight analysis of how deposit-to-first-use timing degrades the effective set, and a dwell-time distribution that flattens it? What is the right `K`, and can it adapt without itself leaking volume?
3. **Pricing an externality you cannot observe.** Formalize the griefing game: an adversary whose utility is poisoning IPs (not use), paying per request, versus an operator rotating IPs from fee revenue and capping per-IP exposure at `E` per epoch. Is there an `f` and `E` making griefing a strictly losing trade, and what is the equilibrium? This is the mechanism-design heart and the part we are least sure of.
4. **Quality vs quantity.** Metered payment bounds volume but not per-request harm: one query can poison an IP. Is there an anonymity-preserving way to gate on request behavior, or to attach reputation that travels with the credential and degrades on misbehavior, without deanonymizing the holder? Or is pure pricing the ceiling under full anonymity?
5. **Does the fused-fee RPC path leak?** If the relay is a builder taking a tip, does the tip or the bundling reveal the payer-to-tx map the search path hides? How does a private mempool (Flashbots-style) compose with the onion, and what does the builder learn that the gateway does not?
6. **Trust-minimizing off-chain redemption.** It trusts the operator to honor a valid proof (the trust Cashu places in its mint). Can we get on-chain trustlessness without reintroducing a relayer or a per-redemption L1 tx (optimistic redemption, a fraud proof, escrow released on a published nullifier)? We found nothing that did not drag a facilitator back in.
7. **Epoch length per use case.** Within an epoch a member's requests are linkable to each other. Search likely wants a shorter epoch, RPC tolerates a longer one. Should epoch be per-use-case, and what breaks if two workloads share a gateway but not an epoch?
8. **Combined circuit.** Verify the Layer 0 decorrelation proof inside the same circuit as the redemption (one proof) or two steps? Undemonstrated. Does one-proof improve anonymity, or only gas and latency?

## 10. Sources

RLN and Semaphore: rln.waku.org, Semaphore v4.0.0 notes. zk-creds: Rosenberg, White, Garman, Miers, S&P 2023 (eprint 2022/878). Channels: BOLT, Green and Miers, CCS 2017; AMHL, Malavolta et al., NDSS 2019; A2L, Tairi/Moreno-Sanchez/Maffei, S&P 2021. Shielded pools: Railgun; Privacy Pools, Buterin/Soleimani et al. (SSRN 4563364). Fused-fee path: ERC-4337, ERC-5564. A deeper non-channel payment menu and the funding-layer analysis live in `docs/PAYMENTS.md`; gas and library-maturity claims there need re-verification before building. This protocol depends on no single number.
