const LABELS = {
  idle: "Idle", walk: "Walk", talk: "Talk", point: "Point", inspect: "Inspect",
  happy: "Happy", worried: "Worried", critical: "Critical", hot: "Hot", cold: "Cold",
  sleep: "Sleep", wake: "Wake", confused: "Confused", celebrate: "Celebrate", dragging: "Dragging",
};

export class BehaviorStudioAnimationPreview {
  constructor({ registry, animationEngine } = {}) {
    this.registry = registry;
    this.animationEngine = animationEngine;
    this.controller = null;
    this.container = null;
    this.characterId = "explorer";
    this.state = "idle";
    this.boundClick = event => this.handleClick(event);
    this.boundInput = event => this.handleInput(event);
  }

  mount(container, { characterId = "explorer", state = "idle", title = "Prévia da animação" } = {}) {
    this.destroy();
    if (!container || !this.animationEngine) return;
    this.container = container;
    this.characterId = characterId === "auto" ? "explorer" : characterId;
    this.state = state;
    container.innerHTML = `
      <div class="animation-preview-head"><div><b>${title}</b><small data-animation-summary>Carregando asset…</small></div><span class="behavior-chip" data-animation-status>preload</span></div>
      <div class="animation-preview-stage"><span class="animation-preview-sprite" aria-label="Prévia animada"></span></div>
      <div class="animation-preview-controls">
        <button class="behavior-mini-button" type="button" data-animation-action="play">Play</button>
        <button class="behavior-mini-button" type="button" data-animation-action="pause">Pause</button>
        <label>FPS <input type="number" min="1" max="60" step="1" value="" placeholder="auto" data-animation-fps /></label>
      </div>
      <div class="behavior-validation" data-animation-diagnostic></div>`;
    container.addEventListener("click", this.boundClick);
    container.addEventListener("input", this.boundInput);
    const element = container.querySelector(".animation-preview-sprite");
    this.controller = this.animationEngine.attach(element, {
      characterId: this.characterId,
      state: this.state,
      onDiagnostic: diagnostic => this.renderDiagnostic(diagnostic),
    });
  }

  update({ characterId = this.characterId, state = this.state } = {}) {
    this.characterId = characterId === "auto" ? "explorer" : characterId;
    this.state = state;
    if (!this.controller) return;
    const changeCharacter = this.controller.characterId !== this.characterId;
    const operation = changeCharacter ? this.controller.setCharacter(this.characterId) : Promise.resolve();
    operation.then(() => this.controller?.setState(this.state));
  }

  renderDiagnostic(diagnostic = {}) {
    if (!this.container) return;
    const summary = this.container.querySelector("[data-animation-summary]");
    const status = this.container.querySelector("[data-animation-status]");
    const detail = this.container.querySelector("[data-animation-diagnostic]");
    const label = LABELS[diagnostic.resolvedState] || diagnostic.resolvedState || "idle";
    if (summary) summary.textContent = `${label} · ${diagnostic.frames || 1} frames · ${diagnostic.fps || 1} FPS · ${diagnostic.loop ? "loop" : "1 ciclo"}`;
    if (status) {
      status.textContent = diagnostic.fallback ? "fallback" : diagnostic.status || "ready";
      status.className = `behavior-chip ${diagnostic.fallback ? "warn" : "ok"}`;
    }
    if (detail) detail.textContent = diagnostic.fallback
      ? `Asset solicitado ${diagnostic.requestedState}; resolvido como ${diagnostic.resolvedState || "idle"} por ${diagnostic.fallbackReason || "fallback legado"}.`
      : `Asset ${diagnostic.requestedState} disponível em ${diagnostic.source || "registry"}.`;
  }

  handleClick(event) {
    const action = event.target.closest("[data-animation-action]")?.dataset.animationAction;
    if (action === "play") this.controller?.play();
    if (action === "pause") this.controller?.pause();
  }

  handleInput(event) {
    if (event.target.matches("[data-animation-fps]")) this.controller?.setPreviewFps(event.target.value);
  }

  destroy() {
    this.controller?.destroy();
    this.controller = null;
    if (this.container) {
      this.container.removeEventListener("click", this.boundClick);
      this.container.removeEventListener("input", this.boundInput);
    }
    this.container = null;
  }
}
