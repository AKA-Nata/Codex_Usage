const SPRITES = {
  explorer: { name: "Explorador", url: "./assets/sprites/explorer.png" },
  wizard: { name: "Mago", url: "./assets/sprites/wizard.png" },
  mechanic: { name: "Mecânico", url: "./assets/sprites/mechanic.png" },
  orb: { name: "Orbital", url: "./assets/sprites/orb.png" },
};

const ORDER = ["explorer", "wizard", "mechanic", "orb"];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours}h ${remMinutes}min` : `${hours}h`;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function nowMs() {
  return performance.now();
}

export class SpriteEngine {
  constructor({ root, getContext, onHumanInteraction }) {
    this.root = root;
    this.getContext = getContext;
    this.onHumanInteraction = onHumanInteraction;
    this.settings = {
      enabled: true,
      sprite: "explorer",
      count: 2,
      scale: 1,
      speed: 1,
      roam: true,
      smart: true,
      talkInterval: 18,
    };
    this.companions = [];
    this.lastFrame = nowMs();
    this.nextPlannerAt = Date.now() + 3500;
    this.cooldowns = new Map();
    this.started = false;
    this.resizeTimer = null;
    this.reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    this._boundFrame = timestamp => this.frame(timestamp);
    this._boundResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.keepInsideViewport(), 120);
    };
    window.addEventListener("resize", this._boundResize);
    window.addEventListener("scroll", this._boundResize, { passive: true });
  }

  configure(values = {}) {
    const previousCount = this.settings.count;
    const previousSprite = this.settings.sprite;
    Object.assign(this.settings, values);
    this.settings.count = clamp(Math.round(Number(this.settings.count) || 1), 1, 3);
    this.settings.scale = clamp(Number(this.settings.scale) || 1, 0.65, 1.35);
    this.settings.speed = clamp(Number(this.settings.speed) || 1, 0.55, 1.7);
    this.settings.talkInterval = clamp(Number(this.settings.talkInterval) || 18, 8, 45);
    this.settings.sprite = SPRITES[this.settings.sprite] ? this.settings.sprite : "explorer";
    this.settings.enabled = Boolean(this.settings.enabled);
    this.settings.roam = Boolean(this.settings.roam);
    this.settings.smart = Boolean(this.settings.smart);

    if (!this.started) {
      this.started = true;
      this.rebuild();
      requestAnimationFrame(this._boundFrame);
      return;
    }

    if (previousCount !== this.settings.count || previousSprite !== this.settings.sprite) {
      this.rebuild();
    } else {
      this.companions.forEach(companion => this.applyCompanionStyle(companion));
    }

    this.root.classList.toggle("hidden", !this.settings.enabled || this.reducedMotion);
  }

  destroy() {
    window.removeEventListener("resize", this._boundResize);
    window.removeEventListener("scroll", this._boundResize);
    this.companions.forEach(companion => companion.element.remove());
    this.companions = [];
  }

  rebuild() {
    this.companions.forEach(companion => companion.element.remove());
    this.companions = [];
    this.root.classList.toggle("hidden", !this.settings.enabled || this.reducedMotion);

    for (let index = 0; index < this.settings.count; index += 1) {
      const spriteType = ORDER[(ORDER.indexOf(this.settings.sprite) + index) % ORDER.length];
      const companion = this.createCompanion(index, spriteType);
      this.companions.push(companion);
      this.root.appendChild(companion.element);
    }

    requestAnimationFrame(() => {
      const bounds = this.viewportBounds();
      this.companions.forEach((companion, index) => {
        companion.x = clamp(bounds.maxX - 135 - index * 82, bounds.minX, bounds.maxX);
        companion.y = clamp(bounds.minY + 95 + index * 64, bounds.minY, bounds.maxY);
        this.setRandomDestination(companion, 0.6);
        this.render(companion);
      });
    });
  }

  createCompanion(index, spriteType) {
    const sprite = SPRITES[spriteType];
    const element = document.createElement("button");
    element.type = "button";
    element.className = "sprite-companion";
    element.setAttribute("aria-label", `${sprite.name}, companheiro interativo`);
    element.dataset.sprite = spriteType;
    element.innerHTML = `
      <span class="sprite-shadow"></span>
      <span class="sprite-body"></span>
      <span class="sprite-bubble" role="status"><b class="sprite-name"></b><span class="sprite-message"></span></span>
    `;

    const companion = {
      id: index + 1,
      type: spriteType,
      name: sprite.name,
      element,
      body: element.querySelector(".sprite-body"),
      bubble: element.querySelector(".sprite-bubble"),
      nameElement: element.querySelector(".sprite-name"),
      messageElement: element.querySelector(".sprite-message"),
      x: 30 + index * 100,
      y: 120 + index * 55,
      targetX: 30 + index * 100,
      targetY: 120 + index * 55,
      state: "idle",
      dragging: false,
      dragOffsetX: 0,
      dragOffsetY: 0,
      pendingMessage: null,
      bubbleUntil: 0,
      dwellUntil: 0,
      nextRoamAt: Date.now() + randomBetween(2500, 7000),
      lastTargetKey: null,
      pointerMoved: false,
    };

    companion.nameElement.textContent = companion.name;
    this.applyCompanionStyle(companion);
    this.bindPointer(companion);
    return companion;
  }

  applyCompanionStyle(companion) {
    companion.body.style.setProperty("--sprite-url", `url("${SPRITES[companion.type].url}")`);
    const baseSize = window.innerWidth <= 760 ? 88 : 112;
    companion.element.style.setProperty("--companion-size", `${Math.round(baseSize * this.settings.scale)}px`);
  }

  bindPointer(companion) {
    const element = companion.element;

    element.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      this.onHumanInteraction?.();
      const rect = element.getBoundingClientRect();
      companion.dragging = true;
      companion.pointerMoved = false;
      companion.dragOffsetX = event.clientX - rect.left;
      companion.dragOffsetY = event.clientY - rect.top;
      companion.state = "dragging";
      element.classList.add("dragging");
      element.setPointerCapture?.(event.pointerId);
      event.preventDefault();
    });

    element.addEventListener("pointermove", event => {
      if (!companion.dragging) return;
      companion.pointerMoved = true;
      const bounds = this.viewportBounds(companion);
      companion.x = clamp(event.clientX - companion.dragOffsetX, bounds.minX, bounds.maxX);
      companion.y = clamp(event.clientY - companion.dragOffsetY, bounds.minY, bounds.maxY);
      companion.targetX = companion.x;
      companion.targetY = companion.y;
      this.render(companion);
      event.preventDefault();
    });

    const endDrag = event => {
      if (!companion.dragging) return;
      companion.dragging = false;
      companion.state = "idle";
      companion.nextRoamAt = Date.now() + 1800;
      element.classList.remove("dragging");
      try { element.releasePointerCapture?.(event.pointerId); } catch {}
      if (!companion.pointerMoved) this.speakImmediate(companion);
    };

    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
    element.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.onHumanInteraction?.();
        this.speakImmediate(companion);
      }
    });
  }

  viewportBounds(companion = null) {
    const size = companion?.element?.getBoundingClientRect().width || 112 * this.settings.scale;
    return {
      minX: 6,
      minY: 54,
      maxX: Math.max(6, window.innerWidth - size - 6),
      maxY: Math.max(54, window.innerHeight - size - 6),
    };
  }

  keepInsideViewport() {
    this.companions.forEach(companion => {
      this.applyCompanionStyle(companion);
      const bounds = this.viewportBounds(companion);
      companion.x = clamp(companion.x, bounds.minX, bounds.maxX);
      companion.y = clamp(companion.y, bounds.minY, bounds.maxY);
      companion.targetX = clamp(companion.targetX, bounds.minX, bounds.maxX);
      companion.targetY = clamp(companion.targetY, bounds.minY, bounds.maxY);
      this.render(companion);
    });
  }

  frame(timestamp) {
    const deltaSeconds = Math.min(0.05, Math.max(0, (timestamp - this.lastFrame) / 1000));
    this.lastFrame = timestamp;
    const wallNow = Date.now();

    this.companions.forEach(companion => this.updateCompanion(companion, deltaSeconds, wallNow));

    if (this.settings.enabled && this.settings.smart && wallNow >= this.nextPlannerAt && !this.reducedMotion) {
      this.planInteraction();
      this.nextPlannerAt = wallNow + this.settings.talkInterval * 1000 + randomBetween(-2500, 4500);
    }

    requestAnimationFrame(this._boundFrame);
  }

  updateCompanion(companion, deltaSeconds, wallNow) {
    if (!this.settings.enabled || this.reducedMotion || companion.dragging) return;

    if (companion.bubbleUntil && wallNow >= companion.bubbleUntil) {
      companion.bubbleUntil = 0;
      companion.element.classList.remove("talking", "alert", "sleeping");
    }

    const dx = companion.targetX - companion.x;
    const dy = companion.targetY - companion.y;
    const distance = Math.hypot(dx, dy);
    const speed = 92 * this.settings.speed;

    if (distance > 2) {
      const step = Math.min(distance, speed * deltaSeconds);
      companion.x += (dx / distance) * step;
      companion.y += (dy / distance) * step;
      companion.state = "walking";
      companion.element.classList.add("walking");
      companion.element.classList.toggle("facing-left", dx < 0);
      this.render(companion);
      return;
    }

    companion.element.classList.remove("walking");
    companion.state = "idle";

    if (companion.pendingMessage) {
      const pending = companion.pendingMessage;
      companion.pendingMessage = null;
      this.say(companion, pending.message, pending.options);
      companion.dwellUntil = wallNow + (pending.options?.dwellMs || 4200);
      companion.nextRoamAt = companion.dwellUntil + randomBetween(1000, 3000);
      return;
    }

    if (wallNow < companion.dwellUntil) return;

    if (this.settings.roam && wallNow >= companion.nextRoamAt) {
      this.setRandomDestination(companion);
    }
  }

  render(companion) {
    companion.element.style.transform = `translate3d(${Math.round(companion.x)}px, ${Math.round(companion.y)}px, 0)`;
  }

  setRandomDestination(companion, areaFactor = 1) {
    const bounds = this.viewportBounds(companion);
    const horizontalMargin = (bounds.maxX - bounds.minX) * (1 - areaFactor) * 0.5;
    const verticalMargin = (bounds.maxY - bounds.minY) * (1 - areaFactor) * 0.5;
    companion.targetX = randomBetween(bounds.minX + horizontalMargin, bounds.maxX - horizontalMargin);
    companion.targetY = randomBetween(bounds.minY + verticalMargin, bounds.maxY - verticalMargin);
    companion.nextRoamAt = Date.now() + randomBetween(6500, 13500);
    companion.lastTargetKey = "roam";
  }

  anchorPosition(anchorKey, companion, index = 0) {
    const anchor = document.querySelector(`[data-sprite-anchor="${anchorKey}"]`);
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    const companionRect = companion.element.getBoundingClientRect();
    const size = companionRect.width || 112;
    const bounds = this.viewportBounds(companion);

    let x = rect.left + rect.width * (0.58 + index * 0.08) - size / 2;
    let y = rect.top - size * 0.72;
    if (y < bounds.minY + 10) y = rect.bottom - size * 0.28;

    return {
      x: clamp(x, bounds.minX, bounds.maxX),
      y: clamp(y, bounds.minY, bounds.maxY),
    };
  }

  moveTo(companion, anchorKey, message, options = {}) {
    const position = this.anchorPosition(anchorKey, companion, companion.id - 1);
    if (!position) return false;
    companion.targetX = position.x;
    companion.targetY = position.y;
    companion.lastTargetKey = anchorKey;
    companion.pendingMessage = { message, options };
    companion.dwellUntil = 0;
    return true;
  }

  say(companion, message, options = {}) {
    companion.messageElement.textContent = message;
    companion.element.classList.add("talking");
    companion.element.classList.toggle("alert", Boolean(options.alert));
    companion.element.classList.toggle("sleeping", Boolean(options.sleeping));
    companion.bubbleUntil = Date.now() + (options.durationMs || 5000);
  }

  speakImmediate(companion) {
    const context = this.getContext?.() || {};
    const actions = this.buildActions(context, true);
    const action = actions[0] || {
      key: "hello",
      anchor: "hero",
      message: "Estou explorando o painel. Arraste-me para onde quiser.",
    };
    this.moveTo(companion, action.anchor, action.message, { ...action.options, durationMs: 5200 });
  }

  cooldownReady(key, cooldownMs) {
    const last = this.cooldowns.get(key) || 0;
    if (Date.now() - last < cooldownMs) return false;
    this.cooldowns.set(key, Date.now());
    return true;
  }

  buildActions(context, immediate = false) {
    const actions = [];
    const fiveHour = Number(context.codex?.fiveHourPercent);
    const weekly = Number(context.codex?.weeklyPercent);
    const cpu = Number(context.machine?.cpuPercent);
    const memory = Number(context.machine?.memoryPercent);
    const idleSeconds = Number(context.idleSeconds || 0);

    if (Number.isFinite(fiveHour) && fiveHour <= 15 && (immediate || this.cooldownReady("low-5h", 3 * 60 * 1000))) {
      actions.push({
        key: "low-5h",
        priority: 100,
        anchor: "codex-5h",
        message: `Atenção: restam ${Math.round(fiveHour)}% no limite de 5 horas.`,
        options: { alert: true, durationMs: 6500 },
      });
    }

    if (Number.isFinite(weekly) && weekly <= 10 && (immediate || this.cooldownReady("low-weekly", 5 * 60 * 1000))) {
      actions.push({
        key: "low-weekly",
        priority: 95,
        anchor: "codex-weekly",
        message: `O limite semanal está em ${Math.round(weekly)}%. Vale planejar as próximas tarefas.`,
        options: { alert: true, durationMs: 6500 },
      });
    }

    if ((cpu >= 85 || memory >= 88) && (immediate || this.cooldownReady("machine-high", 2 * 60 * 1000))) {
      const hottest = cpu >= memory ? `CPU em ${Math.round(cpu)}%` : `RAM em ${Math.round(memory)}%`;
      actions.push({
        key: "machine-high",
        priority: 90,
        anchor: "machine",
        message: `${hottest}. A máquina está trabalhando forte agora.`,
        options: { alert: true, durationMs: 6000 },
      });
    }

    if (idleSeconds >= 300 && (immediate || this.cooldownReady("idle", 4 * 60 * 1000))) {
      actions.push({
        key: "idle",
        priority: 82,
        anchor: "idle",
        message: `Você está há ${formatDuration(idleSeconds)} sem interagir. Continuo cuidando do painel.`,
        options: { sleeping: idleSeconds >= 900, durationMs: 6200 },
      });
    }

    if (context.weather?.temperatureC !== null && context.weather?.temperatureC !== undefined && (immediate || this.cooldownReady("weather", 4 * 60 * 1000))) {
      actions.push({
        key: "weather",
        priority: 50,
        anchor: "weather",
        message: `${context.weather.icon || ""} Agora faz ${context.weather.temperatureC}°C em ${context.weather.location || "sua região"}. ${context.weather.condition || ""}`.trim(),
      });
    }

    if (context.clock?.time && (immediate || this.cooldownReady("clock", 2 * 60 * 1000))) {
      actions.push({
        key: "clock",
        priority: 45,
        anchor: "clock",
        message: `Agora são ${context.clock.time}. ${context.clock.date ? `Hoje é ${context.clock.date}.` : ""}`.trim(),
      });
    }

    if (Number.isFinite(cpu) && Number.isFinite(memory) && (immediate || this.cooldownReady("machine-normal", 4 * 60 * 1000))) {
      actions.push({
        key: "machine-normal",
        priority: 40,
        anchor: "machine",
        message: `Máquina estável: CPU ${Math.round(cpu)}% e RAM ${Math.round(memory)}%.`,
      });
    }

    if (Number.isFinite(fiveHour) && (immediate || this.cooldownReady("codex-normal", 4 * 60 * 1000))) {
      actions.push({
        key: "codex-normal",
        priority: 35,
        anchor: "codex-5h",
        message: `Seu limite de 5 horas está com ${Math.round(fiveHour)}% disponível.`,
      });
    }

    actions.push({
      key: "roam-info",
      priority: 10,
      anchor: "hero",
      message: "Posso circular, observar os dados e avisar quando algo exigir atenção.",
    });

    return actions.sort((a, b) => b.priority - a.priority);
  }

  planInteraction() {
    if (!this.companions.length) return;
    const context = this.getContext?.() || {};
    const actions = this.buildActions(context, false);
    const action = actions[0];
    if (!action) return;

    const available = this.companions.filter(companion => !companion.dragging && Date.now() >= companion.dwellUntil);
    const companion = available[Math.floor(Math.random() * available.length)] || this.companions[0];
    this.moveTo(companion, action.anchor, action.message, action.options || {});
  }
}
