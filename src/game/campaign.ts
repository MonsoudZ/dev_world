// Campaign content for Maple Hollow: the seeded world, the needs of each building and the
// beginner lesson sequence. Lessons are data; the Game runs them.

import type { Game } from "./game";
import { Network } from "../net/sim";
import { DeviceKind, Iface } from "../net/model";
import { parseIp, sameSubnet, ipToStr } from "../net/ip";

// ----------------------------------------------------------------- world seed
export function seedWorld(net: Network) {
  const cloud = net.addDevice("cloud", "internet", "Internet", "__isp");
  cloud.hidden = true;
  cloud.fixed = true;
  cloud.ifaces[0].mode = "static";
  cloud.ifaces[0].ip = "198.51.100.10";
  cloud.ifaces[0].prefix = 24;
  cloud.ifaces[0].gateway = "198.51.100.1";
  cloud.ifaces[0].locked = true;
  cloud.services.dns = {
    enabled: true,
    records: [
      { name: "learn.example", ip: "198.51.100.10" },
      { name: "weather.example", ip: "198.51.100.10" },
      { name: "mail.example", ip: "198.51.100.10" },
      { name: "time.example", ip: "198.51.100.10" },
    ],
  };
  cloud.services.http = { enabled: true, hostnames: ["learn.example", "weather.example", "mail.example", "time.example"], title: "Learn Online: free classes for everyone" };

  const modem = net.addDevice("modem", "workshop", "ISP-Modem", "ws_modem");
  modem.fixed = true;
  modem.note = "Installed by the provider. The orange fiber from the street ends here. You cannot change its settings.";
  const lan = modem.ifaces.find((i) => i.name === "lan")!;
  lan.mode = "static";
  lan.ip = "203.0.113.1";
  lan.prefix = 29;
  lan.locked = true;
  lan.dhcp = { enabled: true, start: "203.0.113.2", end: "203.0.113.6", prefix: 29, gateway: "203.0.113.1", dns: "198.51.100.10" };
  const wan = modem.ifaces.find((i) => i.name === "wan")!;
  wan.mode = "static";
  wan.ip = "198.51.100.1";
  wan.prefix = 24;
  wan.locked = true;
  const uplink = net.connect(wan.id, cloud.ifaces[0].id);
  if (typeof uplink !== "string") {
    uplink.medium = "fiber";
    uplink.lengthM = 12000;
    uplink.latencyMs = 8.5; // the provider's network between the modem and the wider internet
  }

  net.addDevice("pc", "workshop", "Rosa-PC", "ws_pc");
  net.addDevice("laptop", "workshop", "Rosa-Laptop", "ws_laptop");
  net.addDevice("switch", "workshop", "Workshop-SW", "ws_switch");

  net.addDevice("switch", "library", "Library-SW", "lib_switch");
  net.addDevice("laptop", "library", "Reading-Room-1", "lib_laptop1");
  net.addDevice("laptop", "library", "Front-Desk", "lib_laptop2");

  net.addDevice("laptop", "house_jun", "Jun-Laptop", "jun_laptop");
  net.addDevice("laptop", "house_priya", "Priya-Laptop", "priya_laptop");
  net.addDevice("laptop", "house_theo", "Theo-Laptop", "theo_laptop");

  net.addDevice("pc", "shop", "Market-POS", "shop_pc");

  const clinicPc = net.addDevice("pc", "clinic", "Records-PC", "clinic_pc");
  clinicPc.note = "Must reach the records server and the internet.";
  const clinicSrv = net.addDevice("server", "clinic", "Records-Server", "clinic_server");
  clinicSrv.services.http = { enabled: true, hostnames: ["records.clinic"], title: "Hollow Clinic patient records (confidential)" };
  clinicSrv.note = "Holds patient records. Must never be reachable from outside the clinic.";
  net.touch();
}

// ----------------------------------------------------------------- helpers
export function effIp(g: Game, deviceId: string): string | null {
  const d = g.net.device(deviceId);
  if (!d) return null;
  const e = g.net.primaryAddr(d);
  return e ? ipToStr(e.ip) : null;
}

function ifaceOf(g: Game, deviceId: string, name: string): Iface | undefined {
  return g.net.device(deviceId)?.ifaces.find((i) => i.name === name);
}

function linkedTo(g: Game, deviceId: string, name: string, otherDeviceId: string, otherName?: string): boolean {
  const i = ifaceOf(g, deviceId, name);
  if (!i) return false;
  const peer = g.net.peerIface(i.id);
  if (!peer || peer.deviceId !== otherDeviceId) return false;
  if (otherName && peer.name !== otherName) return false;
  return g.net.linkState(i) === "up";
}

function devicesLinked(g: Game, aId: string, bId: string): boolean {
  const a = g.net.device(aId);
  if (!a) return false;
  return a.ifaces.some((i) => g.net.peerIface(i.id)?.deviceId === bId && g.net.linkState(i) === "up");
}

function routerIn(g: Game, buildingId: string) {
  return g.net.devicesIn(buildingId).find((d) => d.kind === "router");
}

function reachesRouterLan(g: Game, deviceId: string): boolean {
  const d = g.net.device(deviceId);
  const r = routerIn(g, "workshop");
  if (!d || !r) return false;
  const lan = r.ifaces.filter((i) => i.name.startsWith("lan"));
  return d.ifaces.some((i) => {
    const seg = g.net.segment(i.id);
    return seg.ifaces.some((s) => lan.some((l) => l.id === s.id));
  });
}

function fetchOk(g: Game, deviceId: string, url: string): boolean {
  return g.net.device(deviceId) ? g.net.fetch(deviceId, url).ok : false;
}

function hasFlag(g: Game, f: string): boolean {
  return g.flags.has(f);
}

function addrIs(g: Game, deviceId: string, ip: string, prefix?: number): boolean {
  const d = g.net.device(deviceId);
  if (!d) return false;
  const e = g.net.primaryAddr(d);
  if (!e) return false;
  return ipToStr(e.ip) === ip && (prefix === undefined || e.prefix === prefix);
}

function hostConfigured(g: Game, deviceId: string, gw: string, dns: string): boolean {
  const d = g.net.device(deviceId);
  if (!d) return false;
  const e = g.net.primaryAddr(d);
  if (!e) return false;
  const gwn = parseIp(gw)!;
  if (!sameSubnet(e.ip, gwn, 24) || e.gateway !== gwn) return false;
  if (e.dns !== parseIp(dns)) return false;
  return !d.ifaces.some((i) => g.net.conflicts.has(i.id));
}

// ----------------------------------------------------------------- needs
export interface Need {
  id: string;
  buildingId: string;
  label: string;
  description: string;
  fromLesson: string; // becomes active when this lesson is reached
  check: (g: Game) => { ok: boolean; detail: string };
  traffic?: (g: Game) => import("../net/sim").TraceResult | null;
  onSatisfied?: string; // NPC quote when the need is first met
  onLost?: string; // NPC quote when it breaks again
}

function fetchNeed(id: string, buildingId: string, deviceId: string, url: string, label: string, description: string, fromLesson: string, onSatisfied?: string, onLost?: string): Need {
  return {
    id,
    buildingId,
    label,
    description,
    fromLesson,
    onSatisfied,
    onLost,
    check: (g) => {
      const d = g.net.device(deviceId);
      if (!d) return { ok: false, detail: "Device missing." };
      const r = g.net.fetch(deviceId, url);
      return { ok: r.ok, detail: r.ok ? `${d.name} loads ${url}` : `${d.name}: ${r.reason}` };
    },
    traffic: (g) => {
      const r = g.net.fetch(deviceId, url);
      return r.request ?? null;
    },
  };
}

export const NEEDS: Need[] = [
  {
    id: "workshop_uplink",
    buildingId: "workshop",
    label: "Internet uplink working",
    description: "The workshop router can reach the provider's network.",
    fromLesson: "router",
    onSatisfied: "The uplink is live. Maple Hollow has a door to the world.",
    onLost: "We've lost the uplink. Check the router and the modem.",
    check: (g) => {
      const r = routerIn(g, "workshop");
      if (!r) return { ok: false, detail: "No router in the workshop yet." };
      const p = g.net.ping(r.id, "198.51.100.10");
      return { ok: p.ok, detail: p.ok ? "Router reaches the internet." : p.summary };
    },
    traffic: (g) => {
      const r = routerIn(g, "workshop");
      return r ? g.net.ping(r.id, "198.51.100.10").request : null;
    },
  },
  {
    id: "library_classes",
    buildingId: "library",
    label: "Online classes",
    description: "Both library laptops can open learn.example.",
    fromLesson: "router",
    onSatisfied: "It loads! Evening classes start Monday.",
    onLost: "The reading room just went dark again. Forty laptops, forty frowns.",
    check: (g) => {
      const a = g.net.fetch("lib_laptop1", "http://learn.example");
      const b = g.net.fetch("lib_laptop2", "http://learn.example");
      if (a.ok && b.ok) return { ok: true, detail: "Both laptops reach learn.example. Classes are running." };
      const bad = a.ok ? b : a;
      return { ok: false, detail: `${g.net.device(a.ok ? "lib_laptop2" : "lib_laptop1")?.name}: ${bad.reason}` };
    },
    traffic: (g) => g.net.fetch(Math.random() < 0.5 ? "lib_laptop1" : "lib_laptop2", "http://learn.example").request ?? null,
  },
  fetchNeed("jun_online", "house_jun", "jun_laptop", "http://learn.example", "Join classes from home", "Jun's laptop can reach learn.example.", "dhcp", "I'm in the class from my own room!", "My video just froze. Is it me or the network?"),
  fetchNeed("priya_online", "house_priya", "priya_laptop", "http://mail.example", "Remote work", "Priya's laptop can reach mail.example.", "dhcp", "Spreadsheets are syncing. You have no idea how happy that makes me.", "I just dropped off a call with a client. Not great."),
  fetchNeed("theo_online", "house_theo", "theo_laptop", "http://weather.example", "Weather and news", "Theo's laptop can reach weather.example.", "dhcp", "Weather radar on my own screen. Marvellous.", "Screen says offline. Did I do that?"),
  {
    id: "shop_site",
    buildingId: "shop",
    label: "Online orders",
    description: "The market's website market.hollow is reachable by the shop and by customers in town.",
    fromLesson: "dns",
    onSatisfied: "First online order just came in. Oranges, two kilos!",
    onLost: "The order page is down and the phone is ringing.",
    check: (g) => {
      const own = g.net.fetch("shop_pc", "http://market.hollow");
      if (!own.ok) return { ok: false, detail: `Market-POS: ${own.reason}` };
      const cust = g.net.fetch("jun_laptop", "http://market.hollow");
      if (!cust.ok) return { ok: false, detail: `Customers cannot reach it. Jun-Laptop: ${cust.reason}` };
      return { ok: true, detail: `market.hollow is live ("${own.title}").` };
    },
    traffic: (g) => g.net.fetch(["jun_laptop", "priya_laptop", "theo_laptop", "lib_laptop1"][Math.floor(Math.random() * 4)], "http://market.hollow").request ?? null,
  },
  fetchNeed("shop_supplier", "shop", "shop_pc", "http://learn.example", "Supplier portal", "Market-POS can reach the internet.", "dns", "Supplier portal works. Restocking tonight.", "Can't reach the supplier. Shelves will be thin."),
  fetchNeed("theo_pc_online", "house_theo", "theo_pc", "http://learn.example", "Grandkid's homework PC", "Theo's new desktop can reach learn.example.", "capstone", "Homework PC is online. Grandkid approved.", "The homework PC is offline. There will be complaints."),
  fetchNeed("clinic_online", "clinic", "clinic_pc", "http://learn.example", "Clinic workstation online", "Records-PC can reach the internet.", "finished", "The clinic is connected. Now keep it private.", "The clinic workstation is offline."),
  {
    id: "clinic_private",
    buildingId: "clinic",
    label: "Records stay private",
    description: "Records-PC can open records.clinic, but nobody in the library can.",
    fromLesson: "finished",
    check: (g) => {
      const inside = g.net.fetch("clinic_pc", "http://records.clinic");
      if (!inside.ok) return { ok: false, detail: `Records-PC: ${inside.reason}` };
      const outside = g.net.fetch("lib_laptop1", "http://records.clinic");
      if (outside.ok) return { ok: false, detail: "Reading-Room-1 in the library can open the records server. That must be blocked." };
      return { ok: true, detail: "Records reachable inside the clinic only." };
    },
  },
];

// ----------------------------------------------------------------- lessons
export type Step =
  | { kind: "talk"; speaker: string; text: string; focus?: string }
  | { kind: "info"; title: string; text: string; focus?: string }
  | { kind: "task"; title: string; text: string; hint?: string; check: (g: Game) => boolean; focus?: string; items?: (g: Game) => { label: string; done: boolean }[] }
  | { kind: "quiz"; question: string; choices: string[]; answer: number; explain: string; focus?: string }
  | { kind: "predict"; question: string; choices: string[]; reveal: string; focus?: string }
  | { kind: "event"; run: (g: Game) => void; focus?: string }
  | { kind: "unlock"; devices?: DeviceKind[]; buildings?: string[]; focus?: string };

export interface Lesson {
  id: string;
  title: string;
  concept: string;
  note: string; // field-note recap shown after completion
  steps: Step[];
}

const talk = (speaker: string, text: string, focus?: string): Step => ({ kind: "talk", speaker, text, focus });
const info = (title: string, text: string, focus?: string): Step => ({ kind: "info", title, text, focus });
type Item = { label: string; done: boolean };
const task = (title: string, text: string, check: (g: Game) => boolean, hint?: string, focus?: string, items?: (g: Game) => Item[]): Step => ({ kind: "task", title, text, check, hint, focus, items });
const predict = (question: string, choices: string[], reveal: string): Step => ({ kind: "predict", question, choices, reveal });
const linkItem = (g: Game, dev: string, name: string, other: string, label: string): Item => ({ label, done: linkedTo(g, dev, name, other) });
const quiz = (question: string, choices: string[], answer: number, explain: string): Step => ({ kind: "quiz", question, choices, answer, explain });

export const LESSONS: Lesson[] = [
  {
    id: "welcome",
    title: "Welcome to Maple Hollow",
    concept: "Getting around",
    note: "Pan by dragging, zoom with the wheel, click a building to select it, then Enter it to see its equipment. The orange line is the provider's fiber; it ends at the modem in Rosa's workshop.",
    steps: [
      talk("Rosa", "You must be the new network builder. Good. This town has been offline long enough. Everything starts in my workshop: the provider ran a fiber to the street and it ends in a modem on my rack.", "workshop"),
      info(
        "Getting around",
        "Drag the map to pan and use the mouse wheel to zoom. Click a building to select it; the card at the bottom shows who lives there and what they need. Buildings with a yellow ! have an unmet need. Overlay toggles in the top bar show cables, traffic and labels."
      ),
      task("Select the workshop", "Click on Rosa's Workshop (the brown building with the rooftop unit).", (g) => g.selected === "workshop", "It is west of the library, north of the pond.", "workshop"),
      task("Enter the workshop", "Press Enter building on the card, or double-click the building.", (g) => g.workspace === "workshop", undefined, "workshop"),
      talk("Rosa", "This is my rack. The orange ISP-Modem is the provider's; leave it alone for now. I have a desktop, a laptop and an unused switch. Let's start small and make those two talk to each other."),
    ],
  },
  {
    id: "links",
    title: "Link lights",
    concept: "Cables, ports and switches",
    note: "A cable between two ports makes a link. Both ends must be powered for the link to come up (green); copper runs stop working past 100 m, fiber goes for kilometres. A switch joins many devices into one local network, learns which MAC address sits behind each port (show mac-address-table) and forwards frames by that; it does not understand IP addresses at all.",
    steps: [
      info(
        "Cables and links",
        "Every network starts with something physical. A cable joins two ports; when both devices are on, the link comes up and the port shows green. Copper cable is cheap but a single run must stay under 100 m; longer runs need fiber. A switch has many ports and joins everything plugged into it into one local network. In the workspace, select a device, find a port and press Connect."
      ),
      task("Connect Rosa-PC to the switch", "Select Rosa-PC, press Connect on its eth0 port, and pick any port on Workshop-SW.", (g) => linkedTo(g, "ws_pc", "eth0", "ws_switch"), "Rosa-PC → eth0 → Connect → Workshop-SW p1.", "workshop"),
      task("Connect Rosa-Laptop to the switch", "Same again for the laptop.", (g) => linkedTo(g, "ws_laptop", "eth0", "ws_switch") && linkedTo(g, "ws_pc", "eth0", "ws_switch"), undefined, "workshop", (g) => [linkItem(g, "ws_pc", "eth0", "ws_switch", "Rosa-PC ↔ Workshop-SW"), linkItem(g, "ws_laptop", "eth0", "ws_switch", "Rosa-Laptop ↔ Workshop-SW")]),
      info("Two green lights", "Both links are up. The switch now carries one small local network with two devices on it. Notice the switch's ports have no address fields: a switch works below IP, forwarding frames by hardware address."),
      task("Look inside the switch", "Select Workshop-SW and in its console run: show mac-address-table. Each port lists the hardware (MAC) addresses the switch has learned behind it.", (g) => hasFlag(g, "mactable:ws_switch"), "Switches have a console too. Type help there.", "workshop"),
      quiz("What does a switch use to decide where to send a frame?", ["The IP address", "The hardware (MAC) address", "The colour of the cable", "The device's name"], 1, "Switches learn which hardware address sits behind each port and forward frames accordingly. IP addresses are a layer above and belong to routers and hosts."),
      talk("Rosa", "Now open the terminal on Rosa-PC and type: ping Rosa-Laptop. Read what comes back carefully. I don't expect it to work yet."),
      task("Try a ping", "In Rosa-PC's terminal run: ping Rosa-Laptop", (g) => hasFlag(g, "ping:ws_pc"), "Select Rosa-PC; the terminal is on the right side of the workspace.", "workshop"),
      talk("Rosa", "\"Exists but has no IP address\". The cable is fine; the switch is fine. The computers simply have no addresses, so they have no idea who they are or who to talk to. That is the next job."),
    ],
  },
  {
    id: "addresses",
    title: "Addresses",
    concept: "IP addresses and subnets",
    note: "An IP address (192.168.1.10) plus a mask (/24) names a host and the network it belongs to. Two hosts can talk directly only when the network part matches; the sender first uses ARP to turn the neighbour's IP into a MAC address. If the network part differs, the host needs a router (a default gateway) to pass the packet along.",
    steps: [
      info(
        "IP addresses and subnets",
        "An address like 192.168.1.10/24 has two parts. The mask /24 says the first 24 bits (192.168.1) name the network and the rest (.10) names the host. Two devices can talk directly only when their network part is identical. Private ranges such as 192.168.x.x are free to use inside a town."
      ),
      task("Address Rosa-PC", "Select Rosa-PC → eth0 → set Static, IP 192.168.1.10, mask /24. Apply.", (g) => addrIs(g, "ws_pc", "192.168.1.10", 24), "Mask /24 is the same as 255.255.255.0.", "workshop"),
      task("Address Rosa-Laptop", "Give Rosa-Laptop 192.168.1.11 /24.", (g) => addrIs(g, "ws_laptop", "192.168.1.11", 24) && addrIs(g, "ws_pc", "192.168.1.10", 24), undefined, "workshop"),
      task("Ping across the switch", "From Rosa-PC: ping 192.168.1.11 (or ping Rosa-Laptop). It should answer now. Notice the ARP line: before the first packet, the PC asked \"who has 192.168.1.11?\" and learned the laptop's MAC address.", (g) => hasFlag(g, "pingok:ws_pc"), "Both hosts are in network 192.168.1.0/24, so the PC sends the packet straight to the laptop through the switch. Run arp afterwards to see the cache.", "workshop"),
      talk("Rosa", "Good. Now break it on purpose: change the laptop to 192.168.2.11 /24 and ping it again from the PC."),
      predict("Before you do: Rosa-Laptop moves to 192.168.2.11/24, Rosa-PC stays on 192.168.1.10/24, same switch, same cables. What will the ping do?", ["Work exactly as before; the switch connects them", "Fail: they are now on different networks and nothing routes between them", "Work, but slower"], "Make the change and ping. Then compare what happened with what you predicted."),
      task("Experiment: a different network", "Set Rosa-Laptop to 192.168.2.11 /24, then ping it from Rosa-PC and read the trace.", (g) => addrIs(g, "ws_laptop", "192.168.2.11") && hasFlag(g, "pingfail:ws_pc"), "The address changed, the cable did not. Watch where the packet dies.", "workshop"),
      info("Why it failed", "192.168.2.11 is in a different network from 192.168.1.10. The PC knows it cannot deliver directly, so it looks for a default gateway (a router) and finds none. Same switch, same cable, no conversation. Networks are drawn by addresses, not by wires."),
      quiz("Two laptops on one switch: 192.168.1.10/24 and 192.168.2.11/24. Why can't they talk?", ["The cable is broken", "They are on different IP networks and there is no router between them", "The switch needs an IP address first", "192.168.2.11 is not a valid address"], 1, "The mask /24 makes 192.168.1 and 192.168.2 different networks. Crossing between networks is a router's job."),
      task("Put it back", "Set Rosa-Laptop back to 192.168.1.11 /24 and confirm the ping works again.", (g) => addrIs(g, "ws_laptop", "192.168.1.11") && g.net.ping("ws_pc", "192.168.1.11").ok && hasFlag(g, "pingok:ws_pc"), undefined, "workshop"),
      talk("Rosa", "Marcus from the library just called. Forty laptops and no internet. Our little network is about to meet the outside world."),
    ],
  },
  {
    id: "router",
    title: "The router",
    concept: "Routing, default gateways and NAT",
    note: "A router joins networks. Hosts send anything not on their own network to the default gateway, the router's address on their network. The router uses its routing table to pick the next hop. Private addresses cannot be routed on the internet, so the edge router translates them with NAT.",
    steps: [
      talk("Marcus", "We have forty laptops and a reading room, and not a single one can reach the internet. If you can connect us, I can run evening classes for the whole town.", "library"),
      info(
        "Routers and gateways",
        "A router has a foot in each network. Hosts send everything not on their own network to their default gateway, which is the router's address on their network. The router looks up the destination in its routing table and forwards it. The modem's LAN side is the provider's network; the router's WAN port belongs there."
      ),
      { kind: "unlock", devices: ["router"] },
      task("Add a router", "In the workshop press Add equipment and choose Router.", (g) => !!routerIn(g, "workshop"), undefined, "workshop"),
      task("Plug the router into the modem", "Connect the router's wan port to the ISP-Modem's lan port.", (g) => {
        const r = routerIn(g, "workshop");
        return !!r && linkedTo(g, r.id, "wan", "ws_modem", "lan");
      }, "Select the router → wan → Connect → ISP-Modem lan.", "workshop"),
      task("Read the WAN address", "The modem hands out an address with DHCP. Look at the router's wan interface: it should show 203.0.113.2/29 with gateway 203.0.113.1. That is Maple Hollow's one public address.", (g) => {
        const r = routerIn(g, "workshop");
        const w = r?.ifaces.find((i) => i.name === "wan");
        return !!w && !!g.net.effective(w);
      }, "The wan port is set to DHCP by default. If it shows waiting, check the cable.", "workshop"),
      task("Connect the LAN side", "Connect the router's lan1 port to Workshop-SW.", (g) => {
        const r = routerIn(g, "workshop");
        return !!r && linkedTo(g, r.id, "lan1", "ws_switch");
      }, undefined, "workshop"),
      task("Address the LAN side", "Set lan1 to Static 192.168.1.1 /24. This becomes everyone's default gateway.", (g) => {
        const r = routerIn(g, "workshop");
        const l = r?.ifaces.find((i) => i.name === "lan1");
        const e = l ? g.net.effective(l) : null;
        return !!e && ipToStr(e.ip) === "192.168.1.1" && e.prefix === 24;
      }, undefined, "workshop"),
      task("Give the hosts a gateway", "On Rosa-PC and Rosa-Laptop set Default gateway 192.168.1.1.", (g) => {
        for (const id of ["ws_pc", "ws_laptop"]) {
          const d = g.net.device(id);
          const e = d ? g.net.primaryAddr(d) : null;
          if (!e || e.gateway !== parseIp("192.168.1.1")) return false;
        }
        return true;
      }, undefined, "workshop", (g) => ["ws_pc", "ws_laptop"].map((id) => {
        const d = g.net.device(id)!;
        const e = g.net.primaryAddr(d);
        return { label: `${d.name} gateway 192.168.1.1`, done: !!e && e.gateway === parseIp("192.168.1.1") };
      })),
      predict("Rosa-PC has an address, a gateway, and the router holds a public address from the provider. Will ping 198.51.100.10 succeed?", ["Yes, everything is in place", "No, something is still missing", "Only the first packet will"], "Run it and read the whole trace, there and back."),
      task("Ping the internet", "From Rosa-PC: ping 198.51.100.10 (a server out on the internet). Read the whole trace.", (g) => hasFlag(g, "ping:ws_pc:198.51.100.10"), undefined, "workshop"),
      info(
        "The request arrived. The reply did not.",
        "Follow the hops: PC → router → modem → internet, delivered. Then the server replied to 192.168.1.10 and the provider's router dropped it: private addresses are not routable on the internet, so nothing out there knows the way back to your PC. The fix is Network Address Translation: the router rewrites outgoing packets to use its public address and remembers who asked, then rewrites the replies back."
      ),
      quiz("Why did the reply to 192.168.1.10 fail?", ["The PC has no gateway", "The internet has no route to private addresses like 192.168.1.10", "The modem blocks ping", "The cable to the library is missing"], 1, "Private ranges (10/8, 172.16/12, 192.168/16) exist precisely so they can be reused everywhere, which also means no one on the internet can route to them. NAT on the edge router hides them behind the public address."),
      task("Enable NAT", "Open the router → wan → tick Enable NAT, then ping 198.51.100.10 from Rosa-PC again.", (g) => {
        const r = routerIn(g, "workshop");
        const w = r?.ifaces.find((i) => i.name === "wan");
        return !!w?.nat && g.net.ping("ws_pc", "198.51.100.10").ok && hasFlag(g, "pingok:ws_pc");
      }, "The checkbox is in the wan interface settings.", "workshop"),
      talk("Rosa", "The workshop is online. Now the library: it is across the plaza. Cables can run between buildings along the road. From a port, press Connect and choose Another building."),
      task("Run a cable to the library", "Connect any free port on Workshop-SW to any port on Library-SW.", (g) => devicesLinked(g, "ws_switch", "lib_switch"), "Workshop-SW → free port → Connect → Another building… → click the library → Library-SW port.", "library"),
      task("Cable the library laptops", "Connect Reading-Room-1 and Front-Desk to Library-SW.", (g) => linkedTo(g, "lib_laptop1", "eth0", "lib_switch") && linkedTo(g, "lib_laptop2", "eth0", "lib_switch"), undefined, "library", (g) => [linkItem(g, "lib_laptop1", "eth0", "lib_switch", "Reading-Room-1 ↔ Library-SW"), linkItem(g, "lib_laptop2", "eth0", "lib_switch", "Front-Desk ↔ Library-SW")]),
      task("Address the library laptops", "Give each a static address in 192.168.1.0/24 (for example .20 and .21), gateway 192.168.1.1 and DNS server 198.51.100.10.", (g) => hostConfigured(g, "lib_laptop1", "192.168.1.1", "198.51.100.10") && hostConfigured(g, "lib_laptop2", "192.168.1.1", "198.51.100.10"), "Two switches linked together form one local network, so the library uses the same 192.168.1.x range. Don't reuse .10, .11 or .1.", "library", (g) => ["lib_laptop1", "lib_laptop2"].map((id) => ({ label: `${g.net.device(id)!.name}: address, gateway, DNS`, done: hostConfigured(g, id, "192.168.1.1", "198.51.100.10") }))),
      task("Open the classes site", "From Reading-Room-1: curl http://learn.example", (g) => hasFlag(g, "fetchok:lib_laptop1:learn.example") && fetchOk(g, "lib_laptop1", "http://learn.example"), "curl resolves the name with DNS, then sends a web request. Watch the packet travel on the map.", "library"),
      talk("Marcus", "It loads! Evening classes start Monday. Watch the plaza: people will come.", "library"),
    ],
  },
  {
    id: "dhcp",
    title: "Hand out addresses",
    concept: "DHCP and address conflicts",
    note: "DHCP lets a router or server hand addresses, mask, gateway and DNS to hosts automatically from a pool. Keep static addresses outside the pool. Two devices with the same address on one network is a conflict: traffic for that address goes to the wrong device and everything that relied on it breaks.",
    steps: [
      talk("Jun", "The library classes are great, but I want to join from my room. Priya and Theo asked too.", "house_jun"),
      info(
        "DHCP",
        "Typing addresses into every laptop in town does not scale. A DHCP server on the router hands out an address, mask, gateway and DNS server to any host that asks. Pick a pool (192.168.1.100 to .200) that does not overlap your static addresses."
      ),
      task("Enable DHCP on the router", "Router → lan1 → DHCP server: enable, pool 192.168.1.100 to 192.168.1.200, gateway 192.168.1.1, DNS 198.51.100.10.", (g) => {
        const r = routerIn(g, "workshop");
        const l = r?.ifaces.find((i) => i.name === "lan1");
        const d = l?.dhcp;
        return !!d && d.enabled && d.start === "192.168.1.100" && d.end === "192.168.1.200" && d.gateway === "192.168.1.1" && d.dns === "198.51.100.10" && d.prefix === 24;
      }, undefined, "workshop"),
      task("Cable the three houses", "Run a cable from each house laptop to Workshop-SW (or add a switch in a house and link that).", (g) => ["jun_laptop", "priya_laptop", "theo_laptop"].every((id) => reachesRouterLan(g, id)), "Open a house, select the laptop → eth0 → Connect → Another building… → the workshop.", "house_jun", (g) => ["jun_laptop", "priya_laptop", "theo_laptop"].map((id) => ({ label: `${g.net.device(id)!.name} reaches the router's network`, done: reachesRouterLan(g, id) }))),
      task("Switch the laptops to DHCP", "Set eth0 on Jun-Laptop, Priya-Laptop and Theo-Laptop to DHCP. Each should show an address from the pool.", (g) => ["jun_laptop", "priya_laptop", "theo_laptop"].every((id) => {
        const d = g.net.device(id);
        const i = d?.ifaces[0];
        return !!i && i.mode === "dhcp" && !!i.lease;
      }), "No lease? The laptop must sit on the same local network as the router's lan1 (through the switches).", "house_jun", (g) => ["jun_laptop", "priya_laptop", "theo_laptop"].map((id) => {
        const i = g.net.device(id)!.ifaces[0];
        return { label: `${g.net.device(id)!.name}: ${i.lease ? "lease " + i.lease.ip : i.mode === "dhcp" ? "DHCP, no lease yet" : "still static"}`, done: i.mode === "dhcp" && !!i.lease };
      })),
      task("Watch the handshake", "From Jun-Laptop run: dhcp. Read the four messages: DISCOVER, OFFER, REQUEST, ACK.", (g) => hasFlag(g, "dhcp:jun_laptop"), undefined, "house_jun"),
      task("Try it from Jun's room", "From Jun-Laptop: curl http://learn.example", (g) => hasFlag(g, "fetchok:jun_laptop:learn.example"), undefined, "house_jun"),
      talk("Theo", "Neat trick, that DHCP. I wrote down the first address I saw on your router and typed it into my laptop myself. Static is more reliable, right?", "house_theo"),
      {
        kind: "event",
        run: (g) => {
          const i = g.net.device("theo_laptop")?.ifaces[0];
          if (!i) return;
          i.mode = "static";
          i.ip = "192.168.1.1";
          i.prefix = 24;
          i.gateway = "192.168.1.1";
          i.dns = "198.51.100.10";
          i.lease = undefined;
          g.net.touch();
          g.toast("Several buildings just lost their connection.", "bad");
        },
      },
      talk("Rosa", "And now half the town is dark. Something Theo did. Use the terminal: from Jun-Laptop ping the gateway and read the hint. Look for red address badges in the workspaces."),
      task("Find and fix the conflict", "Theo's laptop took the router's address 192.168.1.1. Put it back on DHCP so the gateway is unique again, then confirm Jun can reach learn.example.", (g) => {
        const i = g.net.device("theo_laptop")?.ifaces[0];
        return !!i && i.mode === "dhcp" && g.net.conflicts.size === 0 && fetchOk(g, "jun_laptop", "http://learn.example");
      }, "House of Theo → Theo-Laptop → eth0 → mode DHCP → Apply.", "house_theo"),
      quiz("What happened when Theo typed 192.168.1.1 into his laptop?", ["The router shut itself down", "Two devices claimed one address, so traffic meant for the gateway reached the wrong device", "DHCP ran out of addresses", "Nothing; addresses can be shared"], 1, "An address must be unique on a network. With two claimants, neighbours cannot tell which one is the real gateway, so packets land on Theo's laptop and are dropped."),
      info("Recap", "DHCP pool for the many, static addresses outside the pool for the few (routers, servers). A red address badge in a workspace means a conflict; the terminal's ping hints will point you at it."),
    ],
  },
  {
    id: "dns",
    title: "Names and a website",
    concept: "DNS and web services",
    note: "DNS turns names into addresses. A client asks its configured DNS server; if that server has no record it can forward the question upstream. A web server answers HTTP requests for the hostnames it is configured to serve. Hand the local DNS server out via DHCP so every client uses it.",
    steps: [
      talk("Dev", "People keep asking whether they can order online. I would love a little website: market.hollow. Nothing fancy.", "shop"),
      { kind: "unlock", devices: ["server", "switch", "pc", "laptop"] },
      info(
        "Names and services",
        "People remember names, not numbers. DNS turns market.hollow into 192.168.1.20. A client asks its DNS server; a server that does not know a name can forward the question upstream (to 198.51.100.10). A web server answers HTTP on port 80 for the hostnames you tell it to serve."
      ),
      task("Give the market a switch", "Workshop-SW is nearly full. Add a switch in the Corner Market, link it to Workshop-SW, connect Market-POS to it and set Market-POS to DHCP. The market is about 135 m from the workshop by road: too far for copper, so choose fiber for that run.", (g) => {
        const sw = g.net.devicesIn("shop").find((d) => d.kind === "switch");
        const pos = g.net.device("shop_pc");
        return !!sw && !!pos && reachesRouterLan(g, "shop_pc") && pos.ifaces[0].mode === "dhcp" && !!pos.ifaces[0].lease;
      }, "Add equipment → Switch, then cable: shop switch ↔ Workshop-SW (Another building…, pick Fiber), Market-POS ↔ shop switch.", "shop", (g) => {
        const sw = g.net.devicesIn("shop").find((d) => d.kind === "switch");
        const pos = g.net.device("shop_pc")!;
        return [
          { label: "A switch in the Corner Market", done: !!sw },
          { label: "Shop switch linked to Workshop-SW", done: !!sw && devicesLinked(g, sw.id, "ws_switch") },
          { label: "Market-POS cabled to the shop switch", done: !!sw && linkedTo(g, "shop_pc", "eth0", sw.id) },
          { label: "Market-POS on DHCP with a lease", done: pos.ifaces[0].mode === "dhcp" && !!pos.ifaces[0].lease },
        ];
      }),
      task("Add a server", "Add a Server in the Corner Market, connect it to the shop switch, and give it static 192.168.1.20 /24, gateway 192.168.1.1, DNS 198.51.100.10.", (g) => {
        const srv = g.net.devicesIn("shop").find((d) => d.kind === "server");
        return !!srv && addrIs(g, srv.id, "192.168.1.20", 24) && reachesRouterLan(g, srv.id) && hostConfigured(g, srv.id, "192.168.1.1", "198.51.100.10");
      }, "Servers get static addresses outside the DHCP pool so their address never changes.", "shop"),
      task("Enable the web service", "On the server: Services → Web → enable, hostname market.hollow, any title.", (g) => {
        const srv = g.net.devicesIn("shop").find((d) => d.kind === "server");
        return !!srv?.services.http?.enabled && srv.services.http.hostnames.map((h) => h.toLowerCase()).includes("market.hollow");
      }, undefined, "shop"),
      task("Try the name", "From Market-POS: curl http://market.hollow. It will fail; read why.", (g) => hasFlag(g, "fetch:shop_pc:market.hollow"), undefined, "shop"),
      info("Nobody knows that name", "Market-POS asked its DNS server, 198.51.100.10 out on the internet, and that server has never heard of market.hollow. Local names need a local DNS server. Your new server can do that job too."),
      task("Enable DNS on the server", "Services → DNS → enable. Add record market.hollow → 192.168.1.20 and set forwarder 198.51.100.10 so internet names still resolve.", (g) => {
        const srv = g.net.devicesIn("shop").find((d) => d.kind === "server");
        const dns = srv?.services.dns;
        return !!dns?.enabled && dns.records.some((r) => r.name.toLowerCase() === "market.hollow" && r.ip === "192.168.1.20") && dns.forwarder === "198.51.100.10";
      }, undefined, "shop"),
      task("Tell the town about it", "Change the router's DHCP DNS option to 192.168.1.20. Also update the two library laptops and Rosa's machines if they use static DNS.", (g) => {
        const r = routerIn(g, "workshop");
        const l = r?.ifaces.find((i) => i.name === "lan1");
        return l?.dhcp?.dns === "192.168.1.20" && g.net.device("shop_pc")?.ifaces[0].lease?.dns === "192.168.1.20";
      }, "Router → lan1 → DHCP server → DNS.", "workshop"),
      task("Open the market's site", "From Market-POS: curl http://market.hollow", (g) => hasFlag(g, "fetchok:shop_pc:market.hollow") && fetchOk(g, "jun_laptop", "http://market.hollow"), "Customers need it too: Jun's laptop must get the new DNS server from DHCP.", "shop"),
      quiz("Why set a forwarder on the local DNS server?", ["It makes the website load faster", "So names it does not know, like learn.example, are still answered by the upstream server", "DNS does not work without one", "To block unwanted sites"], 1, "Your server is authoritative for market.hollow only. For everything else it asks the forwarder and passes the answer back."),
      talk("Dev", "Orders are coming in from the whole street. Jun's mum ordered oranges from her laptop. Thank you.", "shop"),
    ],
  },
  {
    id: "storm",
    title: "The storm",
    concept: "Troubleshooting from the bottom up",
    note: "Troubleshoot in layers: is the link up (cable, power)? Does the host have an address? Can it reach its gateway? Does the name resolve? Does the service answer? A trace that stops at a hop tells you exactly which layer broke.",
    steps: [
      talk("Rosa", "Storm last night. Branches down all over the north side. Marcus says the library is dark again, and I bet it's not the only thing.", "library"),
      {
        kind: "event",
        run: (g) => {
          let target = [...g.net.links.values()].find((l) => {
            const a = g.net.ifaceDevice(l.a);
            const b = g.net.ifaceDevice(l.b);
            return a && b && [a.buildingId, b.buildingId].sort().join() === ["library", "workshop"].join();
          });
          if (!target) target = [...g.net.links.values()].find((l) => g.net.ifaceDevice(l.a)?.buildingId !== g.net.ifaceDevice(l.b)?.buildingId && !g.net.ifaceDevice(l.a)?.hidden);
          if (target) g.net.setDamaged(target.id, true);
          g.setRain(1, 150);
          g.toast("A cable was damaged in the storm.", "bad");
        },
      },
      task("Find the break", "From Reading-Room-1 run: trace learn.example. Follow the hops, find the damaged cable (a red port, a red dashed line on the map) and replace it. The event log on Library-SW also records the moment the link went down.", (g) => ![...g.net.links.values()].some((l) => l.damaged) && fetchOk(g, "lib_laptop1", "http://learn.example"), "In the workspace, a damaged port shows red. Press Replace cable on it.", "library"),
      info("Bottom-up", "When something breaks, test the layers in order: physical (link up?), addressing (does the host have an address? any conflicts?), routing (can it reach the gateway?), names (does DNS answer?), service (is the server listening?). The trace tool shows which layer failed."),
      quiz("A user says 'the website is down'. What do you check first?", ["Reinstall the browser", "Link lights, then whether the host can ping its gateway", "Rewrite the DNS records", "Buy a new server"], 1, "Start at the bottom. Most outages are a cable, a power switch or an address, and those are also the quickest to confirm or rule out."),
    ],
  },
  {
    id: "capstone",
    title: "On your own",
    concept: "Putting it together",
    note: "You connected a town: links, addresses, a router with NAT, DHCP, a local DNS server and a web service, then diagnosed a conflict and an outage. The same ideas scale up: more networks, more routers, more services.",
    steps: [
      talk("Theo", "My grandkid is moving in and needs a desktop for homework. I put it in the back room. Over to you.", "house_theo"),
      {
        kind: "event",
        run: (g) => {
          if (!g.net.device("theo_pc")) {
            const pc = g.net.addDevice("pc", "house_theo", "Homework-PC", "theo_pc");
            pc.note = "New. Not connected to anything yet.";
          }
          const p = g.net.device("priya_laptop")?.ifaces[0];
          if (p) {
            p.mode = "static";
            p.ip = "192.168.1.150";
            p.prefix = 24;
            p.gateway = "192.168.1.254";
            p.dns = "192.168.1.20";
            p.lease = undefined;
          }
          g.net.touch();
        },
      },
      talk("Priya", "My connection died this morning. A support line told me to type some settings in by hand. I may have made it worse.", "house_priya"),
      task("Bring everyone online", "No step-by-step this time. Get Theo's Homework-PC online, fix Priya's laptop, and make sure every building shows a green signal.", (g) => {
        const needs = ["library_classes", "jun_online", "priya_online", "theo_online", "theo_pc_online", "shop_site", "shop_supplier", "workshop_uplink"];
        return needs.every((n) => g.needStatus.get(n)?.ok);
      }, "Theo's house has one laptop cabled straight to the workshop. A second device needs a switch in the house. Priya: check her gateway against the router's lan1 address, or just use DHCP.", "house_theo", (g) => ["library_classes", "jun_online", "priya_online", "theo_online", "theo_pc_online", "shop_site", "shop_supplier", "workshop_uplink"].map((n) => ({ label: NEEDS.find((x) => x.id === n)!.label + " (" + NEEDS.find((x) => x.id === n)!.buildingId.replace("house_", "").replace(/^\w/, (c) => c.toUpperCase()) + ")", done: !!g.needStatus.get(n)?.ok }))),
      talk("Rosa", "Every light in town is green. You did this. Dr. Okafor at the clinic wants to talk about keeping patient records private, and the mayor is asking about the other towns in the valley. Chapter two."),
    ],
  },
];
