import assert from "node:assert/strict";
import { test } from "node:test";

import { assertPublicUrl, isPrivateIp } from "../lib/utils/ssrf-guard.js";

test("isPrivateIp blocks IPv4 internal ranges", () => {
  for (const ip of [
    "10.100.0.5", // RFC1918 (Sven's LDAP admin)
    "127.0.0.1", // loopback
    "169.254.169.254", // link-local / cloud metadata
    "172.16.0.1", "172.31.255.255", // RFC1918 172.16/12
    "192.168.1.1", // RFC1918
    "0.0.0.0", // this-network
    "100.64.0.1", // CGNAT
  ]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIp allows public IPv4", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "93.184.216.34"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be public`);
  }
});

test("isPrivateIp blocks IPv6 internal + IPv4-mapped", () => {
  for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be private`);
  }
});

test("isPrivateIp allows public IPv6 + mapped public", () => {
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false);
  assert.equal(isPrivateIp("::ffff:8.8.8.8"), false);
});

test("assertPublicUrl rejects internal IP literals", async () => {
  await assert.rejects(() => assertPublicUrl("http://10.100.0.5/"), /private address/);
  await assert.rejects(() => assertPublicUrl("http://localhost:6379/"), /private address|DNS/);
  await assert.rejects(() => assertPublicUrl("http://127.0.0.1/"), /private address/);
  await assert.rejects(() => assertPublicUrl("http://[::1]/"), /private address/);
});

test("assertPublicUrl rejects non-HTTP schemes", async () => {
  await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), /non-HTTP/);
  await assert.rejects(() => assertPublicUrl("gopher://10.0.0.1/"), /non-HTTP/);
});

test("assertPublicUrl accepts a public host", async () => {
  // example.com resolves to a public address; legit webmention sources look like this.
  await assert.doesNotReject(() => assertPublicUrl("https://example.com/post"));
});
