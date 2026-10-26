# Maple Hollow — a networking city you keep online

A playable isometric town where you build and operate its network and learn by doing. The city is the interface: enter buildings, meet the people who live there, cable up equipment, configure it, watch packets travel the roads, and see what happens to the town when things work (and when they break).

## Run it

```bash
npm install
npm run dev
```

Open the URL Vite prints (normally http://localhost:5173). Everything is saved in the browser (localStorage), one world per mode.

## What is in the box

- **Isometric city renderer** (Canvas 2D, no engine): terrain, roads, pond, trees, street lamps, pedestrians, day/night lighting with lit windows, cable overlay along roads, packet animations, labels.
- **Network simulation** (`src/net`): switches form Layer 2 segments; hosts and routers have IP interfaces (static or DHCP); routers forward with connected/static/default routes, NAT and firewall rules; DNS servers with records and forwarders; HTTP services by hostname. Every operation returns a hop-by-hop trace with a plain-language reason and a hint when it fails.
- **Buildings with needs** (`src/game/campaign.ts`): the library wants online classes, the houses want to join, the market wants a website. Needs are checked live against the simulation, and the town reacts (signals, lit windows, more people on the street, background traffic).
- **Guided campaign**: eight lessons from "what is a cable" to an unguided capstone. Each lesson mixes dialogue, a concept card, hands-on tasks that are checked automatically, a quiz, and scripted incidents (a duplicate address, a storm that cuts a cable).
- **Sandbox**: everything unlocked, with fault injection (random cable faults, power cuts) and traffic bursts. You can copy your campaign city into the sandbox.
- **Field notes**: recap of every completed lesson plus a glossary, and buttons to replay any lesson.

## Controls

- Drag to pan, wheel to zoom, arrow keys/WASD also pan. Space pauses the clock.
- Click a building to select it, double-click or press Enter to open its workspace. Esc closes.
- In a workspace: pick a device on the rack, press **Connect** on a port, choose a port on another device, or **Another building…** to run a cable along the road and click the far building on the map.
- Every host and router has a terminal: `ip`, `ping`, `trace`, `nslookup`, `curl`, `route`, `neighbors`, `help`.

## Layout

```
src/
  net/      ip helpers, data model, simulation engine
  world/    map, buildings, people
  render/   camera + isometric renderer
  game/     game state, persistence, campaign content and needs
  ui/       workspace, terminal, HUD/panels
```

## Where it goes next

The clinic (private network, firewall rules) and the town hall (regional operations) are already on the map and unlock when the beginner campaign is finished. The simulation already supports static routes, firewall rules and multiple routers, so chapter two (segmentation and security) and chapter three (a second town, links between routers, a small data centre) can be built on the same engine.
