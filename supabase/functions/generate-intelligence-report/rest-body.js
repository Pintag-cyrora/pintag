// Parse the body of a PostgREST response that has ALREADY passed the r.ok
// check. A `RETURNS void` function (e.g. ensure_daily_metrics_snapshot)
// responds with 204 No Content / an empty body; calling Response.json() on
// that throws "Unexpected end of JSON input" — which is exactly what broke
// report generation once PostgREST started returning 204 for void RPCs.
//
// This returns null for a 204 / empty body and otherwise parses the JSON
// exactly as before, so RPCs that really return JSON are unaffected. Plain JS
// for the same dual-runtime (Deno at the edge + node unit tests) rationale as
// the other modules in this function.
export function parseRpcBody(status, bodyText) {
  if (status === 204 || bodyText == null || bodyText.trim() === '') return null;
  return JSON.parse(bodyText);
}
