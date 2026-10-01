/** A passive browser refresh can renew its own destination, never take over
 * another device. Previous endpoint is an opaque rotation capability retained
 * by that installation; only the Enable gesture intentionally moves delivery. */
export function ownsPushDestination(args: { endpoint: string; previous_endpoint?: string; activate?: boolean }, currentEndpoint: string | null) {
  return args.activate === true || (currentEndpoint !== null &&
    (args.endpoint === currentEndpoint || args.previous_endpoint === currentEndpoint));
}

export function validatePushSubscription(args: { endpoint: string; p256dh: string; auth: string }) {
  const endpoint = new URL(args.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) throw new Error("Invalid push endpoint");
  const decode = (value: string) => atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const publicKey = decode(args.p256dh);
  if (publicKey.length !== 65 || publicKey.charCodeAt(0) !== 4 || decode(args.auth).length !== 16) throw new Error("Invalid push subscription keys");
}
