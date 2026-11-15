import { describe, expect, it } from "vitest";
import { NetworkList, normaliseIp, parseCidr } from "../../src/server/netmatch.js";

describe("trusted network ranges", () => {
  it("parses ranges and single addresses, refusing anything else", () => {
    expect(parseCidr("192.168.1.0/24")).toEqual({ address: "192.168.1.0", prefix: 24, family: "ipv4" });
    expect(parseCidr("10.0.0.5")).toMatchObject({ prefix: 32 });
    expect(parseCidr(" fd00::/8 ")).toEqual({ address: "fd00::", prefix: 8, family: "ipv6" });
    expect(parseCidr("::1")).toMatchObject({ prefix: 128, family: "ipv6" });
    for (const bad of ["", "lan", "192.168.1", "192.168.1.0/33", "192.168.1.0/-1", "10.0.0.0/8/8", "fd00::/129", "10.0.0.0/ 8", "10.0.0.0/08x", "localhost"]) {
      expect(() => parseCidr(bad), bad).toThrow();
    }
  });

  it("matches IPv4, IPv6 and IPv4 on dual-stack sockets; nothing else", () => {
    const n = new NetworkList(["192.168.1.0/24", "10.0.0.5", "fd00::/8"]);
    expect(n.has("192.168.1.200")).toBe(true);
    expect(n.has("::ffff:192.168.1.200")).toBe(true);
    expect(n.has("::FFFF:192.168.1.200")).toBe(true);
    expect(n.has("192.168.2.1")).toBe(false);
    expect(n.has("10.0.0.5")).toBe(true);
    expect(n.has("10.0.0.6")).toBe(false);
    expect(n.has("fd12:3456::1")).toBe(true);
    expect(n.has("fe80::1")).toBe(false);
    for (const odd of [undefined, "", "not-an-ip", "192.168.1.200, 8.8.8.8", "192.168.1.200:80"]) expect(n.has(odd), String(odd)).toBe(false);
    expect(new NetworkList([]).has("127.0.0.1")).toBe(false);
    expect(normaliseIp("::ffff:10.1.2.3")).toBe("10.1.2.3");
    expect(normaliseIp("::ffff:abcd")).toBe("::ffff:abcd");
  });
});
