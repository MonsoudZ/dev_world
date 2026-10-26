// Data model for the network simulation. Everything here is plain JSON-serialisable.

export type DeviceKind = "pc" | "laptop" | "switch" | "router" | "server" | "modem" | "cloud";

export type IfaceMode = "none" | "static" | "dhcp";

export interface DhcpServerConfig {
  enabled: boolean;
  start: string; // first address in pool
  end: string; // last address in pool
  prefix: number;
  gateway: string;
  dns: string;
}

export interface Lease {
  ip: string;
  prefix: number;
  gateway?: string;
  dns?: string;
  serverId: string; // device id of the DHCP server
}

export interface Iface {
  id: string;
  name: string;
  deviceId: string;
  mac: string;
  mode: IfaceMode;
  ip?: string;
  prefix?: number;
  gateway?: string;
  dns?: string;
  nat?: boolean; // router: translate private sources leaving this interface
  dhcp?: DhcpServerConfig; // router/modem: serve addresses on this interface
  linkId?: string;
  lease?: Lease;
  locked?: boolean; // config cannot be edited (ISP side)
}

export interface StaticRoute {
  id: string;
  dest: string; // network address
  prefix: number;
  via: string; // next hop IP
}

export type Proto = "any" | "icmp" | "dns" | "http";

export interface AclRule {
  id: string;
  action: "allow" | "deny";
  src?: string; // CIDR or empty = any
  dst?: string;
  proto: Proto;
  note?: string;
}

export interface DnsRecord {
  name: string;
  ip: string;
}

export interface Services {
  dns?: { enabled: boolean; records: DnsRecord[]; forwarder?: string };
  http?: { enabled: boolean; hostnames: string[]; title: string };
}

export interface Device {
  id: string;
  kind: DeviceKind;
  name: string;
  buildingId: string;
  power: boolean;
  ifaces: Iface[];
  routes: StaticRoute[];
  acl: AclRule[];
  services: Services;
  hidden?: boolean; // not shown in any workspace (the internet)
  fixed?: boolean; // cannot be removed
  note?: string;
  bootingUntil?: number; // game time when the device finishes booting
  log?: LogEntry[];
}

export type Medium = "copper" | "fiber";

export interface Link {
  id: string;
  a: string; // iface id
  b: string; // iface id
  damaged: boolean;
  medium: Medium;
  lengthM: number; // physical run length in metres
  latencyMs?: number; // override (used for the provider uplink)
}

export const MEDIA: Record<Medium, { label: string; maxM: number; speed: string; latencyPerKm: number; description: string }> = {
  copper: { label: "Copper (Cat6)", maxM: 100, speed: "1 Gbit/s", latencyPerKm: 5, description: "Cheap and easy, but a single run must stay under 100 m or the link will not come up." },
  fiber: { label: "Fiber (single-mode)", maxM: 10000, speed: "10 Gbit/s", latencyPerKm: 5, description: "Glass. Runs for kilometres and ignores electrical noise. Needs optics on both ends." },
};

export interface LogEntry {
  t: string; // in-game clock
  text: string;
  kind: "info" | "warn" | "error";
}

export interface NetworkSnapshot {
  devices: Device[];
  links: Link[];
}

export interface CatalogEntry {
  label: string;
  short: string;
  ports: string[];
  l3: boolean; // has IP interfaces
  routes: boolean; // can forward between networks
  description: string;
  icon: string;
}

export const CATALOG: Record<DeviceKind, CatalogEntry> = {
  pc: {
    label: "Desktop PC",
    short: "PC",
    ports: ["eth0"],
    l3: true,
    routes: false,
    description: "An end host. Needs an IP address, a subnet mask and a default gateway to talk beyond its own network.",
    icon: "🖥",
  },
  laptop: {
    label: "Laptop",
    short: "Laptop",
    ports: ["eth0"],
    l3: true,
    routes: false,
    description: "A portable end host. Behaves exactly like a PC on the network.",
    icon: "💻",
  },
  switch: {
    label: "Switch (8 port)",
    short: "Switch",
    ports: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"],
    l3: false,
    routes: false,
    description: "Joins devices into one local network. It forwards frames by hardware address and knows nothing about IP.",
    icon: "🔀",
  },
  router: {
    label: "Router",
    short: "Router",
    ports: ["wan", "lan1", "lan2"],
    l3: true,
    routes: true,
    description: "Connects different networks and forwards packets between them using a routing table. Can serve DHCP and perform NAT.",
    icon: "📡",
  },
  server: {
    label: "Server",
    short: "Server",
    ports: ["eth0"],
    l3: true,
    routes: false,
    description: "A host that runs services for others: web sites, DNS, files.",
    icon: "🗄",
  },
  modem: {
    label: "ISP Modem",
    short: "Modem",
    ports: ["lan", "wan"],
    l3: true,
    routes: true,
    description: "The hand-off from the internet provider. Its LAN side hands out one public address with DHCP.",
    icon: "🌐",
  },
  cloud: {
    label: "The Internet",
    short: "Internet",
    ports: ["eth0"],
    l3: true,
    routes: false,
    description: "Everything beyond the provider.",
    icon: "☁️",
  },
};

export function createDevice(kind: DeviceKind, id: string, name: string, buildingId: string): Device {
  const cat = CATALOG[kind];
  const dev: Device = {
    id,
    kind,
    name,
    buildingId,
    power: true,
    ifaces: [],
    routes: [],
    acl: [],
    services: {},
  };
  dev.ifaces = cat.ports.map((p) => ({
    id: `${id}:${p}`,
    name: p,
    deviceId: id,
    mac: macFor(`${id}:${p}`),
    mode: cat.l3 ? (kind === "router" && p === "wan" ? "dhcp" : "static") : "none",
  }));
  if (kind === "server") {
    dev.services.http = { enabled: false, hostnames: [], title: "" };
    dev.services.dns = { enabled: false, records: [], forwarder: "" };
  }
  return dev;
}

export function isRouterKind(kind: DeviceKind): boolean {
  return CATALOG[kind].routes;
}

export function isHostKind(kind: DeviceKind): boolean {
  return CATALOG[kind].l3 && !CATALOG[kind].routes;
}

/** Deterministic locally-administered MAC address derived from an interface id. */
export function macFor(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const bytes = [0x02, 0x4d, 0x48, (h >>> 16) & 255, (h >>> 8) & 255, h & 255];
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join(":");
}
