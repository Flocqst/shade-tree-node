// This entrypoint is intentionally retained so old commands fail clearly instead
// of sending a legacy envelope to a current node.

console.error(`ARCHIVED: experiments/soak.mjs targets the legacy v1/Semaphore protocol.
Shade Tree v4 uses RLN and will reject these envelopes. No network request was made.
Historical source: experiments/archive/v1-semaphore-soak.mjs.txt
There is no v4 replacement soak harness yet.`);

process.exitCode = 1;
