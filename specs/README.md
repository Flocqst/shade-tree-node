# Shade Tree Grove specifications

These files are the canonical, implementation-grounded contracts for Shade Tree
Grove. Presentation names do not rename wire roles or identifiers.

| Specification | Scope |
| --- | --- |
| [`protocol.md`](protocol.md) | Protocol roles, tunnel flow, admission, discovery, trust boundaries, and versioning |
| [`data-api.md`](data-api.md) | Signed public Grove aggregate, publisher/observer separation, privacy contract, caching, and evolution rules |
| [`data-api.openapi.yaml`](data-api.openapi.yaml) | OpenAPI 3.1 description of the currently implemented public read endpoint only |

Byte-level wire formats and the Elder Tree HTTP protocol remain in
[`docs/PROTOCOL-API.md`](../docs/PROTOCOL-API.md).
