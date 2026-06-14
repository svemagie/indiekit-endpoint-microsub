/**
 * SSRF guard — resolved-IP based, rebinding-resistant
 * @module utils/ssrf-guard
 *
 * Unlike a hostname string-prefix check, this resolves the host via DNS and
 * inspects every resolved address. A hostname whose A-record points at an
 * internal IP (DNS rebinding) is therefore caught. IPv6, IPv4-mapped IPv6,
 * and multi-A records are all handled.
 */

import dns from "node:dns/promises";
import net from "node:net";

/**
 * Decide whether a resolved IP address is private/internal and must not be fetched.
 * @param {string} ip - A resolved IP literal (IPv4 or IPv6)
 * @returns {boolean} True if the address is internal and must be blocked
 */
export function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 0) return true; // not a valid IP literal → block defensively

  if (family === 4) return isPrivateIpv4(ip);

  // IPv6
  const lower = ip.toLowerCase();

  // Loopback ::1 and unspecified ::
  if (lower === "::1" || lower === "::") return true;

  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible — extract the v4 tail
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]);

  // Link-local fe80::/10
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) return true;

  // Unique-local fc00::/7 (fc.. and fd..)
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;

  return false;
}

/**
 * Check a single IPv4 literal against private/reserved ranges.
 * @param {string} ip - IPv4 literal
 * @returns {boolean} True if internal
 */
function isPrivateIpv4(ip) {
  const parts = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // malformed → block
  }
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved

  return false;
}

/**
 * Assert that a URL is safe to fetch (public scheme + public resolved host).
 * Throws an Error if the URL targets an internal/private address or uses a
 * non-HTTP(S) scheme.
 * @param {string} urlString - URL to validate
 * @returns {Promise<void>} Resolves if safe; rejects otherwise
 */
export async function assertPublicUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error("Blocked: invalid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked: non-HTTP scheme ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // If the host is already an IP literal, check it directly (no DNS needed).
  if (net.isIP(host) !== 0) {
    if (isPrivateIp(host)) throw new Error(`Blocked: private address ${host}`);
    return;
  }

  // Resolve ALL addresses and block if ANY is private (rebinding-resistant).
  let addresses;
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    throw new Error(`Blocked: DNS resolution failed for ${host}`);
  }

  if (addresses.length === 0) throw new Error(`Blocked: no addresses for ${host}`);

  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new Error(`Blocked: ${host} resolves to private address ${address}`);
    }
  }
}

/**
 * Fetch a URL with SSRF protection across redirects.
 * Follows up to maxRedirects hops, re-validating each hop's URL before fetching.
 * @param {string} urlString - Initial URL
 * @param {object} [options] - fetch options (redirect is forced to "manual")
 * @param {number} [maxRedirects] - Max redirect hops to follow (default 5)
 * @returns {Promise<Response>} The final response
 */
export async function safeFetch(urlString, options = {}, maxRedirects = 5) {
  let currentUrl = urlString;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicUrl(currentUrl); // guard EVERY hop, including post-redirect

    const response = await fetch(currentUrl, { ...options, redirect: "manual" });

    // Not a redirect → this is the final response.
    if (response.status < 300 || response.status >= 400) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) return response; // redirect without Location — return as-is

    currentUrl = new URL(location, currentUrl).toString(); // resolve relative redirects
  }

  throw new Error("Blocked: too many redirects");
}
