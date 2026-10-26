// IPv4 helpers. Addresses are handled as unsigned 32-bit integers internally.

export function parseIp(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = /^\s*(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\s*$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((n) => n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

export function ipToStr(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}

export function prefixToMask(prefix: number): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export function maskToPrefix(mask: number): number {
  let c = 0;
  for (let i = 31; i >= 0; i--) {
    if ((mask >>> i) & 1) c++;
    else break;
  }
  return c;
}

export function maskStrToPrefix(s: string): number | null {
  const m = parseIp(s);
  if (m === null) {
    const n = Number(s.replace("/", ""));
    return Number.isInteger(n) && n >= 0 && n <= 32 ? n : null;
  }
  // mask must be contiguous ones
  const p = maskToPrefix(m);
  return prefixToMask(p) === m ? p : null;
}

export function networkOf(ip: number, prefix: number): number {
  return (ip & prefixToMask(prefix)) >>> 0;
}

export function broadcastOf(ip: number, prefix: number): number {
  return (networkOf(ip, prefix) | (~prefixToMask(prefix) >>> 0)) >>> 0;
}

export function sameSubnet(a: number, b: number, prefix: number): boolean {
  return networkOf(a, prefix) === networkOf(b, prefix);
}

export function inCidr(ip: number, cidr: string): boolean {
  const [addr, pre] = cidr.split("/");
  const base = parseIp(addr);
  if (base === null) return false;
  const prefix = pre === undefined ? 32 : Number(pre);
  return sameSubnet(ip, base, prefix);
}

export function cidrStr(ip: number, prefix: number): string {
  return `${ipToStr(ip)}/${prefix}`;
}

export function isPrivate(ip: number): boolean {
  return (
    inCidr(ip, "10.0.0.0/8") || inCidr(ip, "172.16.0.0/12") || inCidr(ip, "192.168.0.0/16")
  );
}

export function isValidHostAddress(ip: number, prefix: number): string | null {
  if (prefix < 1 || prefix > 30) return "Prefix must be between /1 and /30 for a host address.";
  if (ip === networkOf(ip, prefix)) return "That is the network address, not a usable host address.";
  if (ip === broadcastOf(ip, prefix)) return "That is the broadcast address, not a usable host address.";
  if ((ip >>> 24) === 0 || (ip >>> 24) === 127) return "Addresses starting with 0 or 127 cannot be used on a network.";
  return null;
}
