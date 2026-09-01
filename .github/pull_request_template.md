## Summary

Describe what changed and why. Link the issue or design discussion when one exists.

## Verification

List the commands you ran and their results. Include focused tests for the behavior
you changed.

```text
npm run lint
npm run test:node
# npm run test:contracts, when contracts change
```

## Security and trust model

- [ ] I considered untrusted input, secret handling, fail-closed behavior, and the
      trust boundaries in `docs/AUDIT.md`.
- [ ] New or changed parsers, wire formats, signatures, and state machines include
      adversarial tests.
- [ ] This change does not commit credentials, member identities, private inventory,
      or other sensitive data.
- [ ] Any intentional trust-model or protocol change is called out explicitly below.

Security notes, or `Not applicable`:

## Documentation and release impact

- [ ] User-facing commands, configuration, wire formats, and operational behavior
      are documented in this change.
- [ ] Backward-compatibility and rollout implications are described below, or are
      not applicable.
- [ ] The change is narrowly scoped and any remaining work is stated honestly.

Release or migration notes, or `Not applicable`:
