/**
 * Address ranges for the "local-network" login mode and for trusted reverse proxies. Ranges are always configured
 * explicitly (ADR 0019); nothing here looks at the machine's own interfaces.
 */
import net from "node:net";

export interface Cidr {
  address: string;
  prefix: number;
  family: "ipv4" | "ipv6";
}

/** "192.168.1.0/24", "fd00::/8" or a single address ("10.0.0.5" = /32, "::1" = /128). Throws on anything else. */
export function parseCidr(text: string): Cidr {
  const [addr, bits, extra] = text.trim().split("/");
  const v = net.isIP(addr ?? "");
  if (!v || extra !== undefined) throw new Error(`'${text}' is not an IP address or CIDR range`);
  const max = v === 4 ? 32 : 128;
  const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) throw new Error(`'${text}': prefix must be 0-${max}`);
  return { address: addr!, prefix, family: v === 4 ? "ipv4" : "ipv6" };
}

/** "::ffff:192.168.1.5" (IPv4 on a dual-stack socket) is matched as the IPv4 address. */
export function normaliseIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

export class NetworkList {
  private readonly list = new net.BlockList();
  readonly ranges: readonly string[];

  constructor(cidrs: readonly string[]) {
    for (const c of cidrs) {
      const r = parseCidr(c);
      this.list.addSubnet(r.address, r.prefix, r.family);
    }
    this.ranges = cidrs;
  }

  has(ip: string | undefined): boolean {
    if (!ip) return false;
    const a = normaliseIp(ip);
    const v = net.isIP(a);
    if (!v) return false;
    return this.list.check(a, v === 4 ? "ipv4" : "ipv6");
  }
}
