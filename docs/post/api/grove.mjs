import { createHash } from "node:crypto";
import { GroveSnapshotError, loadGroveSnapshot } from "./_grove-contract.mjs";

const SUCCESS_HEADERS = {
  "Cache-Control": "public, max-age=60",
  "Content-Type": "application/json; charset=utf-8",
  "Vercel-CDN-Cache-Control": "public, max-age=300, stale-while-revalidate=3600",
  "X-Content-Type-Options": "nosniff",
};

const FAILURE_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Retry-After": "60",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(request) {
  try {
    const snapshot = await loadGroveSnapshot();
    const body = `${JSON.stringify(snapshot)}\n`;
    const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
    const headers = { ...SUCCESS_HEADERS, ETag: etag, "X-Shade-Tree-Schema": snapshot.schema };
    if (matchesIfNoneMatch(request?.headers?.get("if-none-match"), etag)) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(body, {
      status: 200,
      headers,
    });
  } catch (error) {
    const reason = error instanceof GroveSnapshotError ? error.code : "internal";
    console.error(JSON.stringify({ event: "grove_snapshot_unavailable", reason }));
    return new Response('{"error":"network_snapshot_unavailable"}\n', {
      status: 503,
      headers: FAILURE_HEADERS,
    });
  }
}

export function matchesIfNoneMatch(header, etag) {
  if (!header) return false;
  return header.split(",").some((candidate) => {
    const token = candidate.trim();
    if (token === "*") return true;
    return token.replace(/^W\//, "") === etag;
  });
}
