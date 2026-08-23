# Experiments

This directory contains historical measurements and their reports. They do not
describe the current Shade Tree v4 wire protocol unless a file says otherwise.

## Archived network harnesses

`run.mjs` and `soak.mjs` are compatibility guards. Both exit with status 1
before opening a socket because the original harnesses emit legacy
v1/Semaphore envelopes. Shade Tree v4 nodes use RLN and reject those envelopes.

The original source is preserved, but deliberately non-executable, at:

- `archive/v1-semaphore-run.mjs.txt`
- `archive/v1-semaphore-soak.mjs.txt`

A future v4 harness should use the same request construction and validation path
as the supported client rather than recreating protocol envelopes here.

The HTML dashboards and JSON files in this directory are historical experiment
artifacts, not live network status. For the current public aggregate, use the
Grove page linked from the project README.
