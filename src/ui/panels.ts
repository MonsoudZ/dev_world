// HUD, building card, lesson panel, field notes, menu, sandbox tools and toasts.

import { el } from "../core/events";
import { Game, Mode } from "../game/game";
import { LESSONS } from "../game/campaign";
import { BUILDINGS, building } from "../world/map";
import { CATALOG } from "../net/model";

export class Panels {
  hud: HTMLElement;
  card: HTMLElement;
  lesson: HTMLElement;
  toasts: HTMLElement;
  modal: HTMLElement;
  sandbox: HTMLElement;
  private quizState: { chosen?: number; right?: boolean } = {};
  private hintShown = false;
  private legend: HTMLElement;
  private liveKey = "";
  private liveTimer = 0;
  private stepStartedAt = 0;

  constructor(private game: Game, private host: HTMLElement, private hooks: { centerOn: (id: string) => void }) {
    this.hud = el("div", { class: "hud" });
    this.card = el("div", { class: "card-panel hidden" });
    this.lesson = el("div", { class: "lesson-panel" });
    this.toasts = el("div", { class: "toasts" });
    this.modal = el("div", { class: "modal-overlay hidden" });
    this.sandbox = el("div", { class: "sandbox-tools hidden" });
    this.legend = el(
      "div",
      { class: "legend" },
      el("span", { class: "dot", style: "background:rgb(255,210,80)" }),
      "request ",
      el("span", { class: "dot", style: "background:rgb(80,230,170)" }),
      "reply ",
      el("span", { class: "dot", style: "background:rgb(180,140,255)" }),
      "DNS ",
      el("span", { class: "dot", style: "background:rgb(90,200,255)" }),
      "town traffic ",
      el("span", { class: "dot", style: "background:rgb(255,90,90)" }),
      "dropped"
    );
    host.append(this.hud, this.card, this.lesson, this.toasts, this.modal, this.sandbox, this.legend);
    game.events.on("toast", (t) => this.toast(t.text, t.kind));
    game.events.on("select", () => this.renderCard());
    game.events.on("workspace", (id) => host.classList.toggle("in-workspace", !!id));
    game.events.on("step", () => {
      this.quizState = {};
      this.hintShown = false;
      this.stepStartedAt = game.time;
      this.renderLesson();
    });
    game.events.on("change", () => {
      this.renderHud();
      this.renderLesson();
      this.renderCard();
      this.renderSandbox();
    });
    this.renderHud();
    this.renderLesson();
    this.renderSandbox();
  }

  tick(dt: number) {
    const g = this.game;
    const clock = this.hud.querySelector(".clock");
    if (clock) clock.textContent = `${g.light > 0.35 ? "☀" : "☾"} ${g.clockLabel()} · Day ${g.day}`;
    this.legend.classList.toggle("hidden", !g.overlays.traffic || !!g.workspace);
    this.liveTimer -= dt;
    if (this.liveTimer > 0) return;
    this.liveTimer = 0.5;
    const step = g.step;
    const items = step?.kind === "task" && step.items ? step.items(g) : null;
    const key = JSON.stringify([g.selected, [...g.needStatus.entries()].map(([k, v]) => [k, v.ok, v.active]), items, g.net.devicesIn(g.selected ?? "").length]);
    if (key === this.liveKey) {
      if (step?.kind === "task" && step.hint && !this.hintShown && g.time - this.stepStartedAt > 75) {
        this.hintShown = true;
        this.renderLesson();
      }
      return;
    }
    this.liveKey = key;
    if (!this.card.classList.contains("hidden")) this.renderCardStatus();
    if (items) this.renderChecklist(items);
  }

  private renderChecklist(items: { label: string; done: boolean }[]) {
    const holder = this.lesson.querySelector(".checklist");
    if (!holder) return;
    holder.innerHTML = "";
    for (const it of items) holder.append(el("div", { class: `check-item ${it.done ? "done" : ""}` }, el("span", { class: "check-box" }, it.done ? "✓" : ""), el("span", {}, it.label)));
  }

  // ------------------------------------------------------------------ HUD
  renderHud() {
    const g = this.game;
    this.hud.innerHTML = "";
    const toggle = (label: string, key: keyof typeof g.overlays) =>
      el(
        "button",
        {
          class: `chip ${g.overlays[key] ? "on" : ""}`,
          onclick: () => {
            g.overlays[key] = !g.overlays[key];
            g.save();
            this.renderHud();
          },
        },
        label
      );
    const modeBtn = (m: Mode, label: string) =>
      el(
        "button",
        {
          class: `chip ${g.mode === m ? "on" : ""}`,
          onclick: () => {
            if (g.mode !== m) g.switchMode(m);
          },
        },
        label
      );
    const online = g.onlineBuildings().length;
    const total = BUILDINGS.filter((b) => g.needsFor(b.id).length).length;
    this.hud.append(
      el("div", { class: "hud-left" }, el("div", { class: "logo" }, el("span", { class: "logo-dot" }), "Maple Hollow"), el("div", { class: "seg" }, modeBtn("campaign", "Campaign"), modeBtn("sandbox", "Sandbox"))),
      el(
        "div",
        { class: "hud-center" },
        el("span", { class: "clock" }, `${g.clockLabel()} · Day ${g.day}`),
        el("span", { class: "muted small" }, total ? ` · ${online}/${total} buildings online` : ""),
        el(
          "span",
          { class: "time-controls" },
          ...([
            ["⏸", 0],
            ["1×", 1],
            ["3×", 3],
          ] as const).map(([label, scale]) =>
            el(
              "button",
              {
                class: `chip tiny ${(scale === 0 ? g.paused : !g.paused && g.timeScale === scale) ? "on" : ""}`,
                title: scale === 0 ? "Pause the clock (space)" : `Run time at ${scale}×`,
                onclick: () => {
                  if (scale === 0) g.paused = !g.paused;
                  else {
                    g.paused = false;
                    g.timeScale = scale;
                  }
                  this.renderHud();
                },
              },
              label
            )
          )
        )
      ),
      el(
        "div",
        { class: "hud-right" },
        toggle("Cables", "network"),
        toggle("Traffic", "traffic"),
        toggle("Labels", "labels"),
        el("button", { class: "btn ghost", onclick: () => this.showNotes() }, "Field notes"),
        el("button", { class: "btn ghost", onclick: () => this.showMenu() }, "Menu")
      )
    );
  }

  // ------------------------------------------------------------------ building card
  renderCard() {
    const g = this.game;
    const id = g.selected;
    if (!id) {
      this.card.classList.add("hidden");
      return;
    }
    const b = building(id);
    this.card.classList.remove("hidden");
    this.card.innerHTML = "";
    const unlocked = g.unlockedBuildings.has(id);
    add(this.card, 
      el(
        "div",
        { class: "card-head" },
        el("div", {}, el("div", { class: "muted small" }, b.kind.toUpperCase()), el("h3", {}, b.name)),
        el("button", { class: "btn ghost small", onclick: () => g.select(undefined) }, "✕")
      ),
      el("p", { class: "muted small" }, b.description),
      b.npc
        ? el(
            "div",
            { class: "npc-row" },
            el("span", { class: "avatar", style: `background:${b.npc.color}` }, b.npc.name[0]),
            el("div", {}, el("strong", {}, b.npc.name), el("div", { class: "muted small" }, b.npc.role), el("div", { class: "quote" }, `“${b.npc.greeting}”`))
          )
        : null,
      el("div", { class: "needs" }),
      unlocked
        ? el(
            "div",
            { class: "row" },
            el("button", { class: "btn primary", onclick: () => g.openWorkspace(id) }, "Enter building"),
            el("button", { class: "btn ghost", onclick: () => this.hooks.centerOn(id) }, "Centre view")
          )
        : el("p", { class: "locked" }, `🔒 ${b.lockedHint ?? "Locked"}`)
    );
    this.renderCardStatus();
  }

  private renderCardStatus() {
    const g = this.game;
    const id = g.selected;
    if (!id) return;
    const holder = this.card.querySelector(".needs");
    if (!holder) return;
    holder.innerHTML = "";
    const needs = g.needsFor(id);
    const devs = g.net.devicesIn(id);
    if (needs.length) holder.append(el("h4", {}, "Needs"));
    for (const { need, status } of needs) {
      holder.append(
        el(
          "div",
          { class: `need ${status.ok ? "ok" : "todo"}` },
          el("span", { class: "need-icon" }, status.ok ? "✓" : "!"),
          el("div", {}, el("strong", {}, need.label), el("div", { class: "muted small" }, status.ok ? status.detail : need.description), !status.ok && status.detail ? el("div", { class: "small bad" }, status.detail) : null)
        )
      );
    }
    if (devs.length) holder.append(el("div", { class: "muted small" }, "Equipment: " + devs.map((d) => `${CATALOG[d.kind].icon} ${d.name}`).join(", ")));
  }

  // ------------------------------------------------------------------ lesson panel
  renderLesson() {
    const g = this.game;
    this.lesson.innerHTML = "";
    this.host.classList.toggle("has-lesson", g.mode === "campaign");
    this.host.classList.toggle("has-sandbox", g.mode === "sandbox");
    if (g.mode !== "campaign") {
      this.lesson.classList.add("hidden");
      return;
    }
    this.lesson.classList.remove("hidden");
    const lesson = g.lesson;
    const idx = g.progress.lesson;
    const header = el(
      "div",
      { class: "lesson-head" },
      el("div", { class: "muted small" }, g.progress.finished ? "Campaign complete" : `Lesson ${idx + 1} of ${LESSONS.length} · ${lesson.concept}`),
      el("h3", {}, g.progress.finished ? "Maple Hollow is online" : lesson.title),
      el("div", { class: "progress" }, ...LESSONS.map((l, i) => el("span", { class: `pip ${g.progress.completed.includes(l.id) ? "done" : i === idx && !g.progress.finished ? "cur" : ""}`, title: l.title })))
    );
    add(this.lesson, header);
    const step = g.step;
    if (!step) {
      add(this.lesson, 
        el("p", {}, "Every building has a green signal. The clinic and the town hall are open: the clinic needs a private network that the rest of town cannot reach. Try it in the clinic workspace with firewall rules, or explore freely in Sandbox mode."),
        el("div", { class: "row" }, el("button", { class: "btn", onclick: () => this.showNotes() }, "Review field notes"), el("button", { class: "btn ghost", onclick: () => g.switchMode("sandbox") }, "Open sandbox"))
      );
      return;
    }
    const stepNo = el("div", { class: "muted small" }, `Step ${g.progress.step + 1} of ${lesson.steps.length}`);
    switch (step.kind) {
      case "talk": {
        const npc = BUILDINGS.find((b) => b.npc?.name === step.speaker)?.npc;
        add(this.lesson, 
          stepNo,
          el(
            "div",
            { class: "speech" },
            el("span", { class: "avatar", style: `background:${npc?.color ?? "#888"}` }, step.speaker[0]),
            el("div", {}, el("strong", {}, step.speaker), el("p", {}, step.text))
          ),
          el("div", { class: "row" }, el("button", { class: "btn primary", onclick: () => g.advance() }, "Continue"), step.focus ? el("button", { class: "btn ghost", onclick: () => this.hooks.centerOn(step.focus!) }, "Show me") : null)
        );
        break;
      }
      case "info":
        add(this.lesson, stepNo, el("div", { class: "concept" }, el("div", { class: "concept-tag" }, "Concept"), el("h4", {}, step.title), el("p", {}, step.text)), el("button", { class: "btn primary", onclick: () => g.advance() }, "Got it"));
        break;
      case "task": {
        const hintBtn = step.hint
          ? el(
              "button",
              {
                class: "btn ghost small",
                onclick: () => {
                  this.hintShown = !this.hintShown;
                  this.renderLesson();
                },
              },
              this.hintShown ? "Hide hint" : "Need a hint?"
            )
          : null;
        const items = step.items ? step.items(g) : null;
        const focusUnlocked = !!step.focus && g.unlockedBuildings.has(step.focus);
        add(
          this.lesson,
          stepNo,
          el(
            "div",
            { class: "task" },
            el("div", { class: "task-tag" }, "Your task"),
            el("h4", {}, step.title),
            el("p", {}, step.text),
            items ? el("div", { class: "checklist" }) : null,
            this.hintShown && step.hint ? el("p", { class: "hint" }, "💡 " + step.hint) : null
          ),
          el(
            "div",
            { class: "row wrap" },
            step.focus ? el("button", { class: "btn", onclick: () => { this.hooks.centerOn(step.focus!); g.select(step.focus!); } }, "Show me where") : null,
            focusUnlocked && g.workspace !== step.focus ? el("button", { class: "btn", onclick: () => { g.select(step.focus!); g.openWorkspace(step.focus!); } }, "Open it") : null,
            hintBtn
          ),
          this.conceptDrawer(),
          el("p", { class: "muted small" }, "Checked automatically as you work.")
        );
        if (items) this.renderChecklist(items);
        break;
      }
      case "quiz": {
        const qs = this.quizState;
        add(this.lesson, 
          stepNo,
          el("div", { class: "quiz" }, el("div", { class: "quiz-tag" }, "Check your understanding"), el("h4", {}, step.question)),
          el(
            "div",
            { class: "choices" },
            ...step.choices.map((c, i) =>
              el(
                "button",
                {
                  class: `choice ${qs.chosen === i ? (qs.right ? "right" : "wrong") : ""} ${qs.right && i === step.answer ? "right" : ""}`,
                  onclick: () => {
                    if (qs.right) return;
                    const ok = g.answerQuiz(i);
                    this.quizState = { chosen: i, right: ok };
                    this.renderLesson();
                  },
                },
                c
              )
            )
          ),
          qs.chosen !== undefined ? el("p", { class: qs.right ? "good" : "bad" }, qs.right ? "Correct. " + step.explain : "Not quite. Think about which layer is responsible, and try again.") : null,
          qs.right ? el("button", { class: "btn primary", onclick: () => g.advance() }, "Continue") : null
        );
        break;
      }
      case "predict": {
        const qs = this.quizState;
        add(
          this.lesson,
          stepNo,
          el("div", { class: "predict" }, el("div", { class: "predict-tag" }, "Make a prediction"), el("h4", {}, step.question)),
          el(
            "div",
            { class: "choices" },
            ...step.choices.map((c, i) =>
              el(
                "button",
                {
                  class: `choice ${qs.chosen === i ? "picked" : ""}`,
                  onclick: () => {
                    this.quizState = { chosen: i };
                    g.flags.add(`predict:${i}`);
                    this.renderLesson();
                  },
                },
                c
              )
            )
          ),
          qs.chosen !== undefined ? el("p", { class: "info" }, `You predicted: “${step.choices[qs.chosen]}”. ${step.reveal}`) : el("p", { class: "muted small" }, "There is no wrong answer here. Commit to a guess, then test it."),
          qs.chosen !== undefined ? el("button", { class: "btn primary", onclick: () => g.advance() }, "Let's find out") : null
        );
        break;
      }
      default:
        add(this.lesson, stepNo, el("p", { class: "muted" }, "…"));
    }
  }

  /** The most recent concept card of the current lesson, folded under the task for quick reference. */
  private conceptDrawer(): HTMLElement | null {
    const g = this.game;
    const steps = g.lesson.steps.slice(0, g.progress.step);
    const info = [...steps].reverse().find((s) => s.kind === "info");
    if (!info || info.kind !== "info") return null;
    return el("details", { class: "concept-drawer" }, el("summary", {}, `Concept recap: ${info.title}`), el("p", {}, info.text));
  }

  // ------------------------------------------------------------------ sandbox tools
  renderSandbox() {
    const g = this.game;
    if (g.mode !== "sandbox") {
      this.sandbox.classList.add("hidden");
      return;
    }
    this.sandbox.classList.remove("hidden");
    this.sandbox.innerHTML = "";
    const interLinks = () => [...g.net.links.values()].filter((l) => {
      const a = g.net.ifaceDevice(l.a);
      const b = g.net.ifaceDevice(l.b);
      return a && b && !a.hidden && !b.hidden;
    });
    this.sandbox.append(
      el("h4", {}, "Sandbox"),
      el("p", { class: "muted small" }, "All equipment unlocked. Break things on purpose."),
      el(
        "button",
        {
          class: "btn small",
          onclick: () => {
            const ls = interLinks().filter((l) => !l.damaged);
            if (!ls.length) return g.toast("No cables to damage.", "info");
            const l = ls[Math.floor(Math.random() * ls.length)];
            l.damaged = true;
            g.net.touch();
            g.recompute();
            g.save();
            const a = g.net.ifaceDevice(l.a)!;
            const b = g.net.ifaceDevice(l.b)!;
            g.toast(`Storm! Cable ${a.name} ↔ ${b.name} damaged.`, "bad");
          },
        },
        "⚡ Random cable fault"
      ),
      el(
        "button",
        {
          class: "btn small",
          onclick: () => {
            const ds = [...g.net.devices.values()].filter((d) => !d.hidden && !d.fixed && d.power);
            if (!ds.length) return;
            const d = ds[Math.floor(Math.random() * ds.length)];
            d.power = false;
            g.net.touch();
            g.recompute();
            g.save();
            g.toast(`Power cut: ${d.name} went dark.`, "bad");
          },
        },
        "🔌 Random power cut"
      ),
      el(
        "button",
        {
          class: "btn small good",
          onclick: () => {
            for (const l of g.net.links.values()) l.damaged = false;
            for (const d of g.net.devices.values()) d.power = true;
            g.net.touch();
            g.recompute();
            g.save();
            g.toast("Everything repaired and powered.", "good");
          },
        },
        "🛠 Repair everything"
      ),
      el(
        "button",
        {
          class: "btn small",
          onclick: () => {
            for (let k = 0; k < 8; k++) setTimeout(() => (g as unknown as { backgroundTraffic: () => void }).backgroundTraffic(), k * 150);
          },
        },
        "📈 Traffic burst"
      ),
      el(
        "button",
        {
          class: "btn small",
          onclick: () => {
            if (g.rainTarget > 0) g.setRain(0);
            else g.setRain(1, 600);
            g.toast(g.rainTarget > 0 ? "Rain moving in." : "Clearing up.");
            this.renderSandbox();
          },
        },
        g.rainTarget > 0 ? "☀ Clear weather" : "🌧 Make it rain"
      ),
      el("button", { class: "btn small ghost", onclick: () => this.showNotes() }, "📓 Field notes")
    );
  }

  // ------------------------------------------------------------------ modals
  private openModal(content: HTMLElement) {
    this.modal.innerHTML = "";
    this.modal.classList.remove("hidden");
    this.modal.append(el("div", { class: "modal" }, el("button", { class: "btn ghost close", onclick: () => this.closeModal() }, "✕"), content));
    this.modal.onclick = (e) => {
      if (e.target === this.modal) this.closeModal();
    };
  }

  closeModal() {
    this.modal.classList.add("hidden");
  }

  isModalOpen() {
    return !this.modal.classList.contains("hidden");
  }

  showNotes() {
    const g = this.game;
    let campaignNotes: string[] = [];
    try {
      const raw = localStorage.getItem("dev-world:campaign");
      if (raw) campaignNotes = (JSON.parse(raw) as { notes?: string[] }).notes ?? [];
    } catch {
      /* ignore */
    }
    const list = LESSONS.map((l, i) => {
      const done = g.progress.completed.includes(l.id) || g.notes.includes(l.id) || campaignNotes.includes(l.id);
      return el(
        "div",
        { class: `note-item ${done ? "" : "locked"}` },
        el("div", { class: "row between" }, el("strong", {}, `${i + 1}. ${l.title}`), el("span", { class: "muted small" }, l.concept)),
        done ? el("p", {}, l.note) : el("p", { class: "muted" }, "Complete this lesson to unlock the note."),
        g.mode === "campaign" ? el("button", { class: "btn tiny ghost", onclick: () => { g.gotoLesson(i); this.closeModal(); } }, done ? "Replay lesson" : "Jump here") : null
      );
    });
    this.openModal(
      el(
        "div",
        {},
        el("h2", {}, "Field notes"),
        el("p", { class: "muted" }, `Quiz score: ${g.progress.quizRight} right, ${g.progress.quizWrong} wrong.`),
        el("div", { class: "notes" }, ...list),
        el("h3", {}, "Glossary"),
        el(
          "dl",
          { class: "glossary" },
          ...Object.entries(GLOSSARY).map(([k, v]) => el("div", {}, el("dt", {}, k), el("dd", {}, v)))
        )
      )
    );
  }

  showMenu() {
    const g = this.game;
    this.openModal(
      el(
        "div",
        {},
        el("h2", {}, "Maple Hollow"),
        el("p", { class: "muted" }, "A city you keep online. Everything you build is saved in this browser."),
        el("h4", {}, "Controls"),
        el("ul", { class: "help" }, el("li", {}, "Drag to pan, wheel to zoom, click a building to select, double-click or Enter to open it."), el("li", {}, "Esc closes a workspace. Cables between buildings are drawn along the roads."), el("li", {}, "Every terminal supports ping, trace, curl, nslookup, ip and route. Read the hops: the simulation explains why a packet died.")),
        el("h4", {}, "World"),
        el(
          "div",
          { class: "row wrap" },
          el("button", { class: "btn", onclick: () => { g.switchMode(g.mode === "campaign" ? "sandbox" : "campaign"); this.closeModal(); } }, g.mode === "campaign" ? "Switch to Sandbox" : "Switch to Campaign"),
          g.mode === "sandbox" ? el("button", { class: "btn", onclick: () => { if (g.copyCampaignToSandbox()) { g.switchMode("sandbox"); g.toast("Sandbox now mirrors your campaign city.", "good"); } else g.toast("No campaign save to copy yet.", "bad"); this.closeModal(); } }, "Copy campaign city here") : null,
          el("button", { class: "btn danger", onclick: () => { if (confirm(`Reset the ${g.mode} world? This cannot be undone.`)) { g.reset(); this.closeModal(); } } }, `Reset ${g.mode} world`)
        ),
        el("h4", {}, "Event log"),
        el("div", { class: "log" }, ...[...g.log].reverse().slice(0, 30).map((l) => el("div", { class: `small ${l.kind}` }, l.text)))
      )
    );
  }

  // ------------------------------------------------------------------ toasts
  toast(text: string, kind: "info" | "good" | "bad") {
    const t = el("div", { class: `toast ${kind}` }, text);
    this.toasts.append(t);
    setTimeout(() => t.classList.add("show"), 10);
    setTimeout(() => {
      t.classList.remove("show");
      setTimeout(() => t.remove(), 400);
    }, 4200);
    while (this.toasts.children.length > 4) this.toasts.firstChild?.remove();
  }
}

function add(parent: HTMLElement, ...children: (Node | string | null | undefined | false)[]) {
  for (const c of children) if (c !== null && c !== undefined && c !== false) parent.append(c);
}

const GLOSSARY: Record<string, string> = {
  Link: "A cable between two ports. Up when both ends are powered, the cable is intact and the run is within the medium's limit (copper 100 m, fiber kilometres).",
  "MAC address": "The hardware address burned into a network interface (02:4d:48:…). Switches forward by it; ARP maps an IP to it.",
  ARP: "Address Resolution Protocol: \"who has 192.168.1.1?\" A host asks the local network for the MAC behind an IP before it can send the first frame.",
  Latency: "Time for a packet to cross links and devices. Each cable adds propagation delay, each router adds processing; ping reports the round trip.",
  Switch: "Joins devices into one local network, forwarding frames by hardware (MAC) address. Knows nothing about IP.",
  "IP address / mask": "192.168.1.10/24: the first 24 bits name the network, the rest the host. Same network part = can talk directly.",
  "Default gateway": "The router's address on your network. Anything not local is sent there.",
  Router: "Forwards packets between networks using a routing table: connected networks, static routes, default route.",
  NAT: "Network Address Translation. The edge router rewrites private source addresses to its public one and maps replies back.",
  DHCP: "Automatic addressing: a server hands out address, mask, gateway and DNS from a pool to hosts that ask.",
  "Address conflict": "Two devices with the same IP on one network. Traffic for that address goes to the wrong place.",
  DNS: "Turns names into addresses. A server answers from its records or forwards unknown names upstream.",
  HTTP: "The web protocol. A server listens on port 80 and answers for the hostnames it is configured to serve.",
  "Firewall rule": "A router filter: allow or deny traffic by source, destination and protocol. First match wins.",
  Troubleshooting: "Bottom-up: link, address, gateway, name, service. A trace shows the hop where things stopped.",
};
