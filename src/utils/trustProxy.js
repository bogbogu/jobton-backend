// How many reverse proxies sit between the internet and this app (for example
// Cloudflare and Render's load balancer). Express then reads the client IP from
// that many entries from the right of X-Forwarded-For, which is what the rate
// limiters key on. Without it every visitor looks like the proxy and shares one
// rate-limit bucket.
//
// Only a small whole number is accepted. "true" is deliberately not supported:
// it trusts the whole header, so anyone can pick their own IP and dodge the
// limits. Unset (or invalid) leaves proxy trust off, the safe default.
const MAX_HOPS = 5;

export const parseTrustProxyHops = (value) => {
  if (value === undefined || value === null || String(value).trim() === "") return null;

  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;

  const hops = Number(text);
  return hops >= 1 && hops <= MAX_HOPS ? hops : null;
};

export const configureTrustProxy = (app, value = process.env.TRUST_PROXY_HOPS) => {
  const hops = parseTrustProxyHops(value);

  if (hops === null) {
    if (value !== undefined && String(value).trim() !== "") {
      console.warn(`TRUST_PROXY_HOPS must be a whole number from 1 to ${MAX_HOPS}. Ignoring it.`);
    }
    return null;
  }

  app.set("trust proxy", hops);
  return hops;
};
