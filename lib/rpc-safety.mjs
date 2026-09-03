export function isLoopbackRpcUrl(value) {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

// One deadline for every execution-layer JSON-RPC transport. Ethers otherwise defaults each
// FetchRequest to five minutes and its initial network detection retries forever. Operators can
// raise this for a slow remote endpoint, but an invalid/zero value never disables the guard.
export const DEFAULT_RPC_TIMEOUT_MS = 15_000;
// A responsive RPC can still return `null` forever while ethers polls for a receipt. Keep that
// operation-level wait separate from the per-request deadline above: a timeout means UNKNOWN,
// never "reverted" or "not broadcast", and callers must retain the hash before allowing a retry.
export const DEFAULT_TX_RECEIPT_TIMEOUT_MS = 180_000;

export function rpcTimeoutMs(env = process.env) {
  const raw = env.SHADE_TREE_RPC_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_RPC_TIMEOUT_MS;
  const value = Math.floor(Number(raw));
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : DEFAULT_RPC_TIMEOUT_MS;
}

export function txReceiptTimeoutMs(env = process.env) {
  const raw = env.SHADE_TREE_TX_RECEIPT_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TX_RECEIPT_TIMEOUT_MS;
  const value = Math.floor(Number(raw));
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : DEFAULT_TX_RECEIPT_TIMEOUT_MS;
}

const safeTransactionHash = (value) => (/^0x[0-9a-fA-F]{64}$/.test(String(value || ""))
  ? String(value)
  : null);

export class TransactionReceiptTimeoutError extends Error {
  constructor({ transactionHash = null, timeoutMs, confirmations = 1, operation = "transaction", cause } = {}) {
    const hash = safeTransactionHash(transactionHash);
    const count = Number(confirmations) === 1 ? "1 confirmation" : `${confirmations} confirmations`;
    const subject = hash ? `${operation} transaction ${hash}` : `${operation} transaction`;
    super(`${subject} was broadcast but did not reach ${count} within ${timeoutMs}ms. It may still confirm; check the transaction hash before retrying.`, cause ? { cause } : undefined);
    this.name = "TransactionReceiptTimeoutError";
    this.code = "TX_RECEIPT_TIMEOUT";
    this.transactionHash = hash;
    this.timeoutMs = timeoutMs;
    this.confirmations = confirmations;
    this.operation = operation;
  }
}

export function isTransactionReceiptTimeout(error) {
  return error instanceof TransactionReceiptTimeoutError || error?.code === "TX_RECEIPT_TIMEOUT";
}

// Ethers' TransactionResponse.wait(confirmations, timeout) has its own timeout, but this race is
// intentional too: injected providers and test doubles are not required to honor that argument.
// The ordinary timer (rather than AbortSignal.timeout's unref'ed timer) also guarantees a
// short-lived CLI remains alive long enough to print the actionable unknown-state error.
export async function waitForTransactionReceipt(tx, {
  confirmations = 1,
  timeoutMs = txReceiptTimeoutMs(),
  operation = "transaction",
} = {}) {
  if (!tx || typeof tx.wait !== "function") throw new TypeError("transaction response must expose wait()");
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647
    ? timeoutMs
    : DEFAULT_TX_RECEIPT_TIMEOUT_MS;
  const transactionHash = safeTransactionHash(tx.hash);
  const waiting = Promise.resolve().then(() => tx.wait(confirmations, deadline));
  // If our outer deadline wins first, consume the eventual provider rejection. Real ethers also
  // receives the deadline as wait's second argument, so it will stop polling and release listeners.
  waiting.catch(() => {});
  let timer = null;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TransactionReceiptTimeoutError({
      transactionHash, timeoutMs: deadline, confirmations, operation,
    })), deadline);
  });
  try {
    return await Promise.race([waiting, expired]);
  } catch (error) {
    if (isTransactionReceiptTimeout(error)) throw error;
    // ethers v6 rejects TransactionResponse.wait with code=TIMEOUT when its own receipt deadline
    // wins. Normalize that into the same recoverable error shape as the outer deadline.
    if (error?.code === "TIMEOUT" || error?.name === "TimeoutError") {
      throw new TransactionReceiptTimeoutError({
        transactionHash, timeoutMs: deadline, confirmations, operation, cause: error,
      });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function rpcOrigin(value) {
  try { return new URL(String(value)).origin; }
  catch { return "[configured RPC]"; }
}

// A small raw JSON-RPC call used both by the root provider and by the bounded ethers bootstrap.
// The AbortSignal covers connection, response headers and response-body decoding.
export async function jsonRpcCall(url, method, params = [], {
  timeoutMs = rpcTimeoutMs(),
  fetchImpl = globalThis.fetch,
  id = 1,
} = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  let json;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal,
    });
    // `ok` is present on real Fetch Responses. Some injected/test transports expose only
    // `json()`; retain that supported seam while still refusing explicit HTTP errors.
    if (response.ok === false) throw new Error(`HTTP ${response.status}`);
    json = await response.json();
  } catch (error) {
    if (signal.aborted || error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error(`${method}: RPC request timed out after ${timeoutMs}ms at ${rpcOrigin(url)}`, { cause: error });
    }
    throw new Error(`${method}: RPC request failed at ${rpcOrigin(url)}: ${error?.message || error}`, { cause: error });
  }
  if (json?.error) throw new Error(`${method}: ${json.error.message || "JSON-RPC error"}`);
  if (!json || !("result" in json)) throw new Error(`${method}: malformed JSON-RPC response from ${rpcOrigin(url)}`);
  return json.result;
}

// Probe eth_chainId once under the deadline, then pin ethers to that network. Pinning prevents
// JsonRpcProvider's background network-detection retry loop from keeping a CLI or registrar boot
// alive forever when the endpoint is unreachable. The FetchRequest deadline applies to every
// later eth_call, sendRawTransaction and receipt poll as well.
export async function makeBoundedJsonRpcProvider(ethers, rpcUrl, {
  timeoutMs = rpcTimeoutMs(),
  fetchImpl = globalThis.fetch,
} = {}) {
  const chainId = await jsonRpcCall(rpcUrl, "eth_chainId", [], { timeoutMs, fetchImpl });
  const request = new ethers.FetchRequest(rpcUrl);
  request.timeout = timeoutMs;
  return new ethers.JsonRpcProvider(
    request,
    ethers.Network.from(BigInt(chainId)),
    { staticNetwork: true },
  );
}

export function requireRpcChainId(actual, expected, { label = "RPC" } = {}) {
  if (expected == null || expected === "") return;
  let got;
  let want;
  try { got = BigInt(actual); } catch { throw new Error(`${label} returned an invalid chainId; refusing to sign`); }
  try { want = BigInt(expected); } catch { throw new Error("configured chainId is invalid; refusing to sign"); }
  if (got <= 0n || want <= 0n) throw new Error(`${label} chainId must be positive; refusing to sign`);
  if (got !== want) throw new Error(`${label} chainId ${got} does not match configured chainId ${want}; refusing to sign`);
}

export function registrationKey({ rpcUrl, explicitKey, developmentKey, label = "registration" }) {
  if (explicitKey) return explicitKey;
  if (isLoopbackRpcUrl(rpcUrl)) return developmentKey;
  throw new Error(`${label} on a non-loopback RPC requires SHADE_TREE_REGISTER_KEY; the public Anvil key is never used remotely`);
}
