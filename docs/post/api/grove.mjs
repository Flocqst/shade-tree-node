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

export async function GET() {
  try {
    const snapshot = await loadGroveSnapshot();
    return new Response(`${JSON.stringify(snapshot)}\n`, {
      status: 200,
      headers: SUCCESS_HEADERS,
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
