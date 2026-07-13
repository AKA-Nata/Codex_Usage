import {
  STUDIO_CARDS,
  STUDIO_CHANGE_FIELDS,
  STUDIO_CHARACTER_SELECTOR_KINDS,
  STUDIO_EVENTS,
  STUDIO_OPERATORS,
  STUDIO_STATES,
  buildStudioWhen,
  cloneStudioValue,
  createStudioPhraseGroup,
  createStudioTrigger,
  duplicateStudioPhraseGroup,
  duplicateStudioTrigger,
  flattenStudioWhen,
  humanizeStudioId,
  hasNestedStudioCondition,
  removeStudioPhraseGroup,
  removeStudioTrigger,
  replaceStudioTrigger,
  runStudioSimulation,
  setStudioTriggerEnabled,
  updateStudioPhraseGroup,
  validateStudioSpeech,
} from "./behavior-studio-model.js";
import { normalizeSpriteData, resolveSpriteMacroValues, validateSpriteBehaviorConfig } from "./sprite-reaction-engine.js";
import { BehaviorStudioAnimationPreview } from "./behavior-studio-animation-preview.js";
import { normalizeCharacterSelector, resolveCharacterSelector } from "./character-selector.js";
import { BehaviorStudioCharactersTab } from "./behavior-studio-characters-tab.js";


const CHARACTER_LABELS = { auto: "Automático", explorer: "Explorador", wizard: "Mago", mechanic: "Mecânico", orb: "Orbital" };
const CHARACTER_SELECTOR_LABELS = { auto: "Automático", id: "Personagem por ID", group: "Grupo", tag: "Tag", personality: "Personalidade", capability: "Capacidade" };
const CARD_LABELS = { hora: "Hora", interacao: "Interação", temperatura: "Temperatura", maquina: "Máquina", codex_5h: "Codex 5h", codex_semanal: "Codex semanal", status: "Coleta" };
const EVENT_LABELS = {
  user_return: "Retorno do usuário",
  collection_error: "Erro da coleta",
  collection_stale: "Coleta desatualizada",
  collection_recovery: "Recuperação da coleta",
  value_change: "Mudança de valor",
  click: "Clique",
  drag: "Arraste",
  random_interval: "Intervalo aleatório",
};
const CHANGE_LABELS = {
  hora: "Hora", temperatura: "Temperatura", clima: "Clima", cpu: "CPU", ram: "RAM", disco: "Disco",
  gpu: "GPU", gpu_memoria: "Memória GPU", codex_5h_percentual: "Codex 5h %", codex_5h_reset: "Reset 5h",
  codex_5h_atingido: "Limite 5h atingido", codex_semanal_percentual: "Codex semanal %",
  codex_semanal_reset: "Reset semanal", codex_semanal_atingido: "Limite semanal atingido",
  tempo_sem_interacao: "Inatividade", coleta_status: "Estado da coleta",
};


function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}


function optionsHtml(values, selected, labels = {}) {
  return values.map(value => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(labels[value] || value)}</option>`).join("");
}


function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}


function splitLines(value) {
  return [...new Set(String(value || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean))];
}


function conditionRowModel(node = {}) {
  if (node.timeRange && node.timeRange.start === node.timeRange.end && !node.timeRange.days?.length) return { kind: "timeExact", time: node.timeRange.start };
  if (node.timeRange) return { kind: "timeRange", start: node.timeRange.start, end: node.timeRange.end, days: node.timeRange.days || [] };
  if (node.event) return {
    kind: "event",
    eventType: node.event.type,
    metric: node.event.metric,
    card: node.event.card,
    phase: node.event.phase,
    minDelta: node.event.minDelta,
    minIntervalSeconds: node.event.minIntervalSeconds,
    intervalMin: node.event.intervalSeconds?.min,
    intervalMax: node.event.intervalSeconds?.max,
  };
  const between = node.operator === "between" && Array.isArray(node.value);
  const value = between ? node.value[0] : node.value;
  const valueType = typeof value === "boolean" ? "boolean" : typeof value === "string" ? "string" : "number";
  return { kind: "metric", metric: node.metric || "cpu", operator: node.operator || ">", value, valueMax: between ? node.value[1] : "", valueType };
}


function conditionRowHtml(row, index, config) {
  const metrics = [...new Set([...Object.keys(config.macros || {}), "weather.raining", "collection.missing", "telemetry.error", "telemetry.machineUnavailable", "codex_5h_atingido", "codex_semanal_atingido"])];
  const dayValues = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  return `
    <div class="condition-row" data-condition-row data-kind="${escapeHtml(row.kind)}" data-event-type="${escapeHtml(row.eventType || "click")}">
      <select class="condition-kind" aria-label="Tipo da condição">
        <option value="metric"${row.kind === "metric" ? " selected" : ""}>Métrica</option>
        <option value="event"${row.kind === "event" ? " selected" : ""}>Evento</option>
        <option value="timeExact"${row.kind === "timeExact" ? " selected" : ""}>Horário exato</option>
        <option value="timeRange"${row.kind === "timeRange" ? " selected" : ""}>Faixa horária</option>
      </select>
      <div class="condition-fields condition-metric">
        <select data-condition="metric" aria-label="Métrica">${optionsHtml(metrics, row.metric)}</select>
        <select data-condition="operator" aria-label="Operador">${optionsHtml(STUDIO_OPERATORS, row.operator)}</select>
        <select data-condition="valueType" aria-label="Tipo do valor">
          <option value="number"${row.valueType === "number" ? " selected" : ""}>Número</option>
          <option value="string"${row.valueType === "string" ? " selected" : ""}>Texto</option>
          <option value="boolean"${row.valueType === "boolean" ? " selected" : ""}>Booleano</option>
        </select>
        <input data-condition="value" value="${escapeHtml(row.value ?? "")}" aria-label="Valor" />
        <input data-condition="valueMax" value="${escapeHtml(row.valueMax ?? "")}" aria-label="Valor final" placeholder="final do between" />
      </div>
      <div class="condition-fields condition-exact"><input type="time" data-condition="time" value="${escapeHtml(row.time || "12:00")}" aria-label="Horário exato" /></div>
      <div class="condition-fields condition-time">
        <input type="time" data-condition="start" value="${escapeHtml(row.start || "06:00")}" aria-label="Início" />
        <input type="time" data-condition="end" value="${escapeHtml(row.end || "11:59")}" aria-label="Fim" />
        <select multiple data-condition="days" aria-label="Dias da semana">${dayValues.map(day => `<option value="${day}"${row.days?.includes(day) ? " selected" : ""}>${day.toUpperCase()}</option>`).join("")}</select>
      </div>
      <div class="condition-fields condition-event">
        <select data-condition="eventType" aria-label="Evento">${optionsHtml(STUDIO_EVENTS, row.eventType || "click", EVENT_LABELS)}</select>
        <select class="event-detail event-value-change" data-condition="eventMetric" aria-label="Métrica alterada">${optionsHtml(metrics, row.metric || "cpu")}</select>
        <select class="event-detail event-click" data-condition="eventCard" aria-label="Card clicado">${optionsHtml([...STUDIO_CARDS, "sprite"], row.card || "maquina", { ...CARD_LABELS, sprite: "Sprite" })}</select>
        <select class="event-detail event-drag" data-condition="phase" aria-label="Fase do arraste">${optionsHtml(["start", "move", "end"], row.phase || "end")}</select>
        <input class="event-detail event-value-change" type="number" min="0" step="0.1" data-condition="minDelta" value="${escapeHtml(row.minDelta ?? "")}" placeholder="delta" aria-label="Delta mínimo" />
        <input class="event-detail event-value-change" type="number" min="0" data-condition="minIntervalSeconds" value="${escapeHtml(row.minIntervalSeconds ?? "")}" placeholder="intervalo mín." aria-label="Intervalo mínimo" />
        <input class="event-detail event-random-interval" type="number" min="0" data-condition="intervalMin" value="${escapeHtml(row.intervalMin ?? 20)}" placeholder="aleatório mín." aria-label="Intervalo aleatório mínimo" />
        <input class="event-detail event-random-interval" type="number" min="0" data-condition="intervalMax" value="${escapeHtml(row.intervalMax ?? 45)}" placeholder="aleatório máx." aria-label="Intervalo aleatório máximo" />
      </div>
      <button class="behavior-mini-button" type="button" data-action="remove-condition" data-index="${index}" aria-label="Remover condição">×</button>
    </div>`;
}


export class BehaviorStudio {
  constructor({ root, backdrop, openButton, closeButton, importInput, confirmDialog, getEngine, getRealContext, onSavedConfig, onOpenAppearance, onCharacterCatalogChanged, characterRegistry, animationEngine } = {}) {
    this.root = root;
    this.backdrop = backdrop;
    this.openButton = openButton;
    this.closeButton = closeButton;
    this.importInput = importInput;
    this.confirmDialog = confirmDialog;
    this.getEngine = getEngine;
    this.getRealContext = getRealContext;
    this.onSavedConfig = onSavedConfig;
    this.onOpenAppearance = onOpenAppearance;
    this.onCharacterCatalogChanged = onCharacterCatalogChanged;
    this.characterRegistry = characterRegistry;
    this.animationEngine = animationEngine;
    this.animationPreview = new BehaviorStudioAnimationPreview({ registry: characterRegistry, animationEngine });
    const charactersRoot = root?.querySelector?.('[data-behavior-panel="characters"]');
    this.charactersTab = charactersRoot ? new BehaviorStudioCharactersTab({
      root: charactersRoot,
      registry: characterRegistry,
      animationEngine,
      requestJson: (url, options) => this.request(url, options),
      requestBinary: (url, options) => fetch(url, { cache: "no-store", credentials: "same-origin", ...options }),
      confirm: (title, message) => this.confirm(title, message),
      callbacks: {
        onCatalogChanged: (characters, metadata) => this.onCharacterCatalogChanged?.(characters, metadata),
      },
    }) : null;
    this.config = null;
    this.revision = null;
    this.dirty = false;
    this.activeTab = "behaviors";
    this.selectedTriggerId = null;
    this.selectedPhraseId = null;
    this.ruleSearch = "";
    this.ruleFilter = "all";
    this.ruleSort = "priority-desc";
    this.macroSearch = "";
    this.historySearch = "";
    this.searchTimer = null;
    this.macros = [];
    this.history = [];
    this.lastSimulation = null;
    this.lastSpeechField = null;
    this.restoreFocusTo = null;
    this.boundKeydown = event => this.handleKeydown(event);
  }

  async init() {
    this.openButton?.addEventListener("click", () => this.open());
    this.closeButton?.addEventListener("click", () => this.close());
    this.backdrop?.addEventListener("click", () => this.close());
    this.root?.addEventListener("click", event => this.handleClick(event));
    this.root?.addEventListener("submit", event => this.handleSubmit(event));
    this.root?.addEventListener("change", event => this.handleChange(event));
    this.root?.addEventListener("input", event => this.handleInput(event));
    this.root?.addEventListener("focusin", event => {
      if (event.target.matches?.("[data-speech-input]")) {
        this.lastSpeechField = event.target;
        const panel = event.target.closest("[data-behavior-panel]");
        const form = event.target.closest("[data-studio-form]");
        this.lastSpeechTarget = {
          tab: panel?.dataset.behaviorPanel,
          formType: form?.dataset.studioForm,
          originalId: form?.dataset.originalId || "",
          name: event.target.name,
        };
      }
    });
    this.importInput?.addEventListener("change", event => this.importFile(event.target.files?.[0]));
    document.addEventListener("keydown", this.boundKeydown);
    await this.loadConfig();
  }

  async request(url, options = {}) {
    const requestOptions = { cache: "no-store", credentials: "same-origin", ...options };
    if (options.body && !requestOptions.headers?.["Content-Type"]) {
      requestOptions.headers = { ...(requestOptions.headers || {}), "Content-Type": "application/json" };
    }
    const response = await fetch(url, requestOptions);
    let payload = null;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.details = payload.errors || [];
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  setBusy(busy) {
    this.root?.setAttribute("aria-busy", String(Boolean(busy)));
  }

  setStatus(message, level = "") {
    const status = document.getElementById("behaviorStudioStatus");
    if (!status) return;
    status.textContent = message;
    status.className = `behavior-status-line${level ? ` ${level}` : ""}`;
  }

  async loadConfig() {
    this.setBusy(true);
    this.setStatus("Carregando configuração…");
    try {
      const payload = await this.request("/api/studio/config");
      this.config = payload.config;
      this.revision = payload.revision;
      this.dirty = false;
      this.selectedTriggerId = this.config.triggers?.[0]?.id || null;
      this.selectedPhraseId = this.config.phrases?.[0]?.id || null;
      this.setStatus(payload.valid ? `Configuração válida · revisão ${payload.revision.slice(0, 8)}` : "Configuração atual contém erros.", payload.valid ? "ok" : "error");
      if (this.root.classList.contains("open")) await this.refreshMacros();
      else this.macros = Object.entries(this.config?.macros || {}).map(([macro, spec]) => ({ macro, ...spec, displayValue: spec.fallback, available: false }));
      this.render();
    } catch (error) {
      this.setStatus(error.message, "error");
    } finally {
      this.setBusy(false);
    }
  }

  async refreshMacros() {
    try {
      const payload = await this.request("/api/studio/macros");
      this.macros = payload.macros || [];
      if (this.getRealContext && this.config) {
        const resolved = resolveSpriteMacroValues(normalizeSpriteData(this.getRealContext()), this.config);
        this.macros = this.macros.map(macro => resolved[macro.macro] ? {
          ...macro,
          value: resolved[macro.macro].raw,
          displayValue: resolved[macro.macro].text,
          available: resolved[macro.macro].available,
        } : macro);
      }
    } catch {
      this.macros = Object.entries(this.config?.macros || {}).map(([macro, spec]) => ({ macro, ...spec, displayValue: spec.fallback, available: false }));
    }
  }

  async refreshHistory(query = "") {
    try {
      const payload = await this.request(`/api/studio/history?limit=300&q=${encodeURIComponent(query)}`);
      this.history = payload.entries || [];
      if (this.activeTab === "history") this.renderHistory();
    } catch (error) {
      this.setStatus(error.message, "error");
    }
  }

  open() {
    this.restoreFocusTo = document.activeElement;
    document.querySelector("main.app")?.setAttribute("inert", "");
    document.getElementById("spriteWorld")?.setAttribute("inert", "");
    document.getElementById("studio")?.setAttribute("inert", "");
    this.root.classList.add("open");
    this.backdrop?.classList.add("open");
    this.root.setAttribute("aria-hidden", "false");
    this.backdrop?.setAttribute("aria-hidden", "false");
    document.body.classList.add("behavior-studio-open");
    this.render();
    this.refreshMacros().then(() => {
      if (this.activeTab === "macros") this.renderMacros();
      else if (this.activeTab === "speech") this.updateSpeechPreview();
    });
    if (this.activeTab === "history") this.refreshHistory();
    setTimeout(() => this.root.querySelector("[role=tab][aria-selected=true]")?.focus(), 0);
  }

  close({ commit = true } = {}) {
    if (commit) {
      try { this.commitActiveForm(); }
      catch (error) { this.setStatus(error.message, "error"); return false; }
    }
    this.root.classList.remove("open");
    this.animationPreview.destroy();
    this.charactersTab?.destroyPreview();
    this.backdrop?.classList.remove("open");
    this.root.setAttribute("aria-hidden", "true");
    this.backdrop?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("behavior-studio-open");
    document.querySelector("main.app")?.removeAttribute("inert");
    document.getElementById("spriteWorld")?.removeAttribute("inert");
    document.getElementById("studio")?.removeAttribute("inert");
    this.restoreFocusTo?.focus?.();
    return true;
  }

  handleKeydown(event) {
    if (!this.root?.classList.contains("open")) return;
    const activeTab = event.target.closest?.("[data-behavior-tab]");
    if (activeTab && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      const tabs = [...this.root.querySelectorAll("[data-behavior-tab]")];
      const current = tabs.indexOf(activeTab);
      const next = event.key === "Home" ? 0
        : event.key === "End" ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      event.preventDefault();
      if (this.switchTab(tabs[next].dataset.behaviorTab)) tabs[next].focus();
      return;
    }
    if (event.key === "Escape" && !this.confirmDialog?.open) {
      event.preventDefault();
      this.close();
      return;
    }
    if (event.key === "Tab" && !this.confirmDialog?.open) {
      const focusable = [...this.root.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.closest("[hidden]") && element.getClientRects().length);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  switchTab(tab, { commit = true } = {}) {
    if (commit) {
      try { this.commitActiveForm(); }
      catch (error) { this.setStatus(error.message, "error"); return false; }
    }
    if (this.activeTab === "characters" && tab !== "characters") this.charactersTab?.destroyPreview();
    this.activeTab = tab;
    this.root.querySelectorAll("[data-behavior-tab]").forEach(button => {
      const selected = button.dataset.behaviorTab === tab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    this.root.querySelectorAll("[data-behavior-panel]").forEach(panel => { panel.hidden = panel.dataset.behaviorPanel !== tab; });
    this.renderActivePanel();
    if (tab === "macros") this.refreshMacros().then(() => this.renderMacros());
    if (tab === "history") this.refreshHistory();
    return true;
  }

  render() {
    if (!this.config) return;
    this.root.querySelectorAll("[data-behavior-tab]").forEach(button => {
      const selected = button.dataset.behaviorTab === this.activeTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    this.root.querySelectorAll("[data-behavior-panel]").forEach(panel => { panel.hidden = panel.dataset.behaviorPanel !== this.activeTab; });
    this.renderActivePanel();
  }

  renderActivePanel() {
    ({
      characters: () => this.renderCharacters(),
      behaviors: () => this.renderBehaviors(),
      speech: () => this.renderSpeech(),
      macros: () => this.renderMacros(),
      simulator: () => this.renderSimulator(),
      defaults: () => this.renderDefaults(),
      history: () => this.renderHistory(),
    })[this.activeTab]?.();
  }

  renderCharacters() {
    if (!this.charactersTab) return;
    if (!this.charactersTab.initialized) this.charactersTab.init();
    else this.charactersTab.render();
  }

  behaviorList() {
    const search = this.ruleSearch.trim().toLowerCase();
    const values = (this.config.triggers || []).filter(trigger => {
      if (this.ruleFilter === "enabled" && !trigger.enabled) return false;
      if (this.ruleFilter === "disabled" && trigger.enabled) return false;
      return !search || `${trigger.id} ${trigger.name || ""} ${trigger.targetCard} ${trigger.spriteState}`.toLowerCase().includes(search);
    });
    return values.sort((left, right) => {
      if (this.ruleSort === "priority-asc") return left.priority - right.priority || left.id.localeCompare(right.id);
      if (this.ruleSort === "name") return (left.name || left.id).localeCompare(right.name || right.id);
      return right.priority - left.priority || left.id.localeCompare(right.id);
    });
  }

  renderBehaviors() {
    this.animationPreview.destroy();
    const panel = this.root.querySelector('[data-behavior-panel="behaviors"]');
    if (!panel) return;
    if (!this.selectedTriggerId || !this.config.triggers.some(trigger => trigger.id === this.selectedTriggerId)) this.selectedTriggerId = this.config.triggers?.[0]?.id || null;
    const selected = this.config.triggers.find(trigger => trigger.id === this.selectedTriggerId);
    const list = this.behaviorList();
    panel.innerHTML = `
      <div class="behavior-master-detail">
        <aside class="behavior-sidebar">
          <div class="behavior-sidebar-head">
            <div class="behavior-toolbar">
              <input class="behavior-search" type="search" value="${escapeHtml(this.ruleSearch)}" placeholder="Buscar regras" aria-label="Buscar comportamentos" data-control="rule-search" />
              <select class="behavior-select" aria-label="Filtrar comportamentos" data-control="rule-filter">${optionsHtml(["all", "enabled", "disabled"], this.ruleFilter, { all: "Todas", enabled: "Ativas", disabled: "Inativas" })}</select>
              <select class="behavior-select" aria-label="Ordenar comportamentos" data-control="rule-sort">${optionsHtml(["priority-desc", "priority-asc", "name"], this.ruleSort, { "priority-desc": "Maior prioridade", "priority-asc": "Menor prioridade", name: "Nome" })}</select>
              <button class="button primary" type="button" data-action="new-trigger">Nova</button>
            </div>
            <small>${list.length} de ${this.config.triggers.length} comportamentos</small>
          </div>
          <div class="behavior-sidebar-list">${list.map(trigger => `
            <article class="behavior-rule-card${trigger.id === this.selectedTriggerId ? " active" : ""}">
              <div class="behavior-rule-main">
                <button type="button" data-action="select-trigger" data-id="${escapeHtml(trigger.id)}"><b>${escapeHtml(trigger.name || humanizeStudioId(trigger.id))}</b><small>${escapeHtml(trigger.id)} · ${escapeHtml(CARD_LABELS[trigger.targetCard] || trigger.targetCard)}</small></button>
                <span class="behavior-chip ${trigger.enabled ? "ok" : ""}">P${escapeHtml(trigger.priority)}</span>
              </div>
              <div class="behavior-rule-actions">
                <button class="behavior-mini-button" type="button" data-action="toggle-trigger" data-id="${escapeHtml(trigger.id)}">${trigger.enabled ? "Desativar" : "Ativar"}</button>
                <button class="behavior-mini-button" type="button" data-action="duplicate-trigger" data-id="${escapeHtml(trigger.id)}">Duplicar</button>
                <button class="behavior-mini-button" type="button" data-action="test-trigger" data-id="${escapeHtml(trigger.id)}">Testar</button>
              </div>
            </article>`).join("") || '<div class="behavior-empty">Nenhuma regra encontrada.</div>'}</div>
        </aside>
        <section class="behavior-editor">${selected ? this.triggerEditorHtml(selected) : '<div class="behavior-empty">Crie o primeiro comportamento.</div>'}</section>
      </div>`;
    if (selected) this.animationPreview.mount(panel.querySelector("[data-trigger-animation-preview]"), {
      characterId: this.resolveTriggerCharacterId(selected.character),
      state: selected.spriteState || "idle",
    });
  }

  characterCatalog() {
    const values = this.characterRegistry?.list?.() || [];
    return values.length ? values : Object.entries(CHARACTER_LABELS)
      .filter(([id]) => id !== "auto")
      .map(([id, name], displayOrder) => ({ id, name, displayOrder, enabled: true, compatible: true }));
  }

  resolveTriggerCharacterId(selector) {
    return resolveCharacterSelector(selector, this.characterCatalog(), {
      groups: this.config?.characterGroups || {},
      preferredIds: ["explorer", "wizard", "mechanic", "orb"],
    }).characterId;
  }

  triggerEditorHtml(trigger) {
    const flattened = flattenStudioWhen(trigger.when);
    const preservesNestedCondition = hasNestedStudioCondition(trigger.when);
    const rows = preservesNestedCondition ? [] : flattened.nodes.map(conditionRowModel);
    const characterPhrases = trigger.characterPhrases || {};
    const characterSelector = normalizeCharacterSelector(trigger.character);
    const characterCatalog = this.characterCatalog();
    Object.keys(characterPhrases).forEach(characterId => {
      if (!characterCatalog.some(character => character.id === characterId)) {
        characterCatalog.push({ id: characterId, name: CHARACTER_LABELS[characterId] || `${characterId} (indisponível)`, enabled: false, compatible: true });
      }
    });
    return `
      <div class="behavior-heading"><div><h3>${escapeHtml(trigger.name || humanizeStudioId(trigger.id))}</h3><p>Edição visual da regra declarativa.</p></div><span class="behavior-chip ${trigger.enabled ? "ok" : "warn"}">${trigger.enabled ? "Ativa" : "Inativa"}</span></div>
      <form data-studio-form="trigger" data-original-id="${escapeHtml(trigger.id)}"${preservesNestedCondition ? ' data-preserve-when="true"' : ""}>
        <div class="behavior-grid">
          <label class="behavior-field span-6">Nome<input name="name" maxlength="80" required value="${escapeHtml(trigger.name || humanizeStudioId(trigger.id))}" /></label>
          <label class="behavior-field span-6">ID<input name="id" pattern="[a-z][a-z0-9_]*" required value="${escapeHtml(trigger.id)}" /></label>
          <label class="behavior-field span-3">Card<select name="targetCard">${optionsHtml(STUDIO_CARDS, trigger.targetCard, CARD_LABELS)}</select></label>
          <label class="behavior-field span-3">Seletor de personagem<select name="characterSelectorKind">${optionsHtml(STUDIO_CHARACTER_SELECTOR_KINDS, characterSelector.kind, CHARACTER_SELECTOR_LABELS)}</select></label>
          <label class="behavior-field span-3">Valor do seletor<input name="characterSelectorValue" list="studioCharacterValues" maxlength="80" value="${escapeHtml(characterSelector.value || "")}"${characterSelector.kind === "auto" ? " disabled" : ""} placeholder="ID, grupo, tag, personalidade ou capacidade" /><datalist id="studioCharacterValues">${characterCatalog.map(character => `<option value="${escapeHtml(character.id)}">${escapeHtml(character.name || character.id)}</option>`).join("")}${Object.keys(this.config.characterGroups || {}).map(group => `<option value="${escapeHtml(group)}">Grupo</option>`).join("")}</datalist></label>
          <label class="behavior-field span-3">Estado/animação<select name="spriteState">${optionsHtml(STUDIO_STATES, trigger.spriteState)}</select></label>
          <label class="behavior-field span-3">Prioridade<input name="priority" type="number" min="0" max="1000" step="1" value="${escapeHtml(trigger.priority)}" /></label>
        </div>
        <div class="behavior-checks behavior-section">
          <label class="behavior-check"><input name="enabled" type="checkbox"${trigger.enabled ? " checked" : ""} /> Ativo</label>
          <label class="behavior-check"><input name="persistent" type="checkbox"${trigger.persistent ? " checked" : ""} /> Persistente</label>
          <label class="behavior-check"><input name="repeatWhileActive" type="checkbox"${trigger.repeatWhileActive !== false ? " checked" : ""} /> Repetir enquanto ativa</label>
          <label class="behavior-check"><input name="preventRepeat" type="checkbox"${trigger.preventRepeat !== false ? " checked" : ""} /> Evitar fala repetida</label>
        </div>

        <div class="behavior-section">
          <div class="behavior-heading"><div><h4>Condições</h4><p>Combine métricas, eventos e horários em AND ou OR.</p></div>${preservesNestedCondition ? "" : `<div class="behavior-inline-actions"><select class="behavior-select" name="conditionGroup">${optionsHtml(["all", "any"], flattened.group, { all: "AND · todas", any: "OR · qualquer" })}</select><button class="button" type="button" data-action="add-condition">Adicionar</button></div>`}</div>
          ${preservesNestedCondition ? '<div class="behavior-preview"><b>Grupo aninhado preservado</b><p>Esta regra importada usa níveis recursivos de AND/OR. O Studio preservará a árvore sem alterações; duplique a regra para criar uma versão plana editável.</p></div>' : `<div class="condition-list" data-condition-list>${rows.map((row, index) => conditionRowHtml(row, index, this.config)).join("")}</div>`}
        </div>

        <div class="behavior-section">
          <h4>Tempos</h4>
          <div class="behavior-grid">
            <label class="behavior-field span-3">Cooldown (s)<input name="cooldownSeconds" type="number" min="0" step="0.1" value="${escapeHtml(trigger.cooldownSeconds ?? 0)}" /></label>
            <label class="behavior-field span-3">Duração (s)<input name="durationSeconds" type="number" min="0" max="120" step="0.1" value="${escapeHtml(trigger.durationSeconds ?? this.config.defaultBehavior.reactionDurationSeconds)}" /></label>
            <label class="behavior-field span-3">Tempo máximo no card (s)<input name="holdSeconds" type="number" min="0" max="120" step="0.1" value="${escapeHtml(trigger.holdSeconds ?? 0)}" /></label>
          </div>
        </div>

        <div class="behavior-section behavior-animation-preview" data-trigger-animation-preview></div>

        <div class="behavior-section">
          <h4>Falas do gatilho</h4>
          <div class="behavior-grid">
            <label class="behavior-field span-8">Falas (uma por linha)<textarea name="phrases" data-speech-input>${escapeHtml((trigger.phrases || []).join("\n"))}</textarea></label>
            <label class="behavior-field span-4">Grupos reutilizáveis<select name="phraseRefs" multiple size="4">${(this.config.phrases || []).map(group => `<option value="${escapeHtml(group.id)}"${trigger.phraseRefs?.includes(group.id) ? " selected" : ""}>${escapeHtml(group.id)}</option>`).join("")}</select></label>
            <label class="behavior-field full">Fallback<textarea name="fallbackPhrase" maxlength="160" data-speech-input>${escapeHtml(trigger.fallbackPhrase || "")}</textarea></label>
            ${characterCatalog.map(character => `<label class="behavior-field span-6">${escapeHtml(character.name || CHARACTER_LABELS[character.id] || character.id)} (uma por linha)<textarea name="characterPhrases_${escapeHtml(character.id)}" data-character-phrase="${escapeHtml(character.id)}" data-speech-input>${escapeHtml((characterPhrases[character.id] || []).join("\n"))}</textarea></label>`).join("")}
          </div>
          <div class="behavior-preview"><b>Macros rápidas</b><div class="behavior-inline-actions">${this.macros.slice(0, 10).map(macro => `<button class="behavior-mini-button" type="button" data-action="insert-macro" data-token="${escapeHtml(macro.token)}">${escapeHtml(macro.token)}</button>`).join("")}</div></div>
        </div>
        <div class="behavior-editor-actions">
          <button class="button danger" type="button" data-action="delete-trigger" data-id="${escapeHtml(trigger.id)}">Excluir</button>
          <button class="button" type="button" data-action="duplicate-trigger" data-id="${escapeHtml(trigger.id)}">Duplicar</button>
          <button class="button" type="button" data-action="test-trigger" data-id="${escapeHtml(trigger.id)}">Testar</button>
          <button class="button primary" type="submit">Aplicar ao rascunho</button>
        </div>
      </form>`;
  }

  serializeConditionRows(form) {
    return [...form.querySelectorAll("[data-condition-row]")].map(row => {
      const read = name => row.querySelector(`[data-condition="${name}"]`)?.value;
      const kind = row.querySelector(".condition-kind")?.value || "metric";
      if (kind === "timeExact") return { kind, time: read("time") };
      if (kind === "timeRange") return { kind, start: read("start"), end: read("end"), days: [...(row.querySelector('[data-condition="days"]')?.selectedOptions || [])].map(option => option.value) };
      if (kind === "event") return {
        kind,
        eventType: read("eventType"),
        metric: read("eventMetric"),
        card: read("eventCard"),
        phase: read("phase"),
        minDelta: read("minDelta"),
        minIntervalSeconds: read("minIntervalSeconds"),
        intervalMin: read("intervalMin"),
        intervalMax: read("intervalMax"),
      };
      return { kind, metric: read("metric"), operator: read("operator"), valueType: read("valueType"), value: read("value"), valueMax: read("valueMax") };
    });
  }

  serializeTriggerForm(form) {
    const data = new FormData(form);
    const original = this.config.triggers.find(trigger => trigger.id === form.dataset.originalId) || {};
    const trigger = {
      id: String(data.get("id") || "").trim(),
      name: String(data.get("name") || "").trim(),
      enabled: data.has("enabled"),
      when: form.dataset.preserveWhen === "true"
        ? cloneStudioValue(original.when)
        : buildStudioWhen(data.get("conditionGroup"), this.serializeConditionRows(form)),
      targetCard: data.get("targetCard"),
      character: normalizeCharacterSelector({
        kind: data.get("characterSelectorKind"),
        value: data.get("characterSelectorKind") === "auto" ? null : String(data.get("characterSelectorValue") || "").trim(),
      }),
      spriteState: data.get("spriteState"),
      priority: Math.round(numberValue(data.get("priority"), 0)),
      cooldownSeconds: Math.max(0, numberValue(data.get("cooldownSeconds"), 0)),
      durationSeconds: Math.max(0, numberValue(data.get("durationSeconds"), 0)),
      persistent: data.has("persistent"),
      repeatWhileActive: data.has("repeatWhileActive"),
      preventRepeat: data.has("preventRepeat"),
      holdSeconds: Math.max(0, numberValue(data.get("holdSeconds"), 0)),
    };
    const phrases = splitLines(data.get("phrases"));
    const phraseRefs = [...form.querySelector('[name="phraseRefs"]')?.selectedOptions || []].map(option => option.value);
    const fallbackPhrase = String(data.get("fallbackPhrase") || "").trim();
    const characterPhrases = {};
    [...form.querySelectorAll("[data-character-phrase]")].forEach(field => {
      const character = field.dataset.characterPhrase;
      const texts = splitLines(field.value);
      if (texts.length) characterPhrases[character] = texts;
    });
    if (phrases.length) trigger.phrases = phrases;
    if (phraseRefs.length) trigger.phraseRefs = phraseRefs;
    if (fallbackPhrase) trigger.fallbackPhrase = fallbackPhrase;
    if (Object.keys(characterPhrases).length) trigger.characterPhrases = characterPhrases;
    if (original.topic) trigger.topic = original.topic;
    return trigger;
  }

  renderSpeech() {
    const panel = this.root.querySelector('[data-behavior-panel="speech"]');
    if (!panel) return;
    if (!this.selectedPhraseId || !this.config.phrases.some(group => group.id === this.selectedPhraseId)) this.selectedPhraseId = this.config.phrases?.[0]?.id || null;
    const selected = this.config.phrases.find(group => group.id === this.selectedPhraseId);
    panel.innerHTML = `
      <div class="behavior-master-detail">
        <aside class="behavior-sidebar">
          <div class="behavior-sidebar-head"><div class="behavior-heading"><div><h3>Biblioteca</h3><p>Falas reutilizáveis por referência.</p></div><button class="button primary" type="button" data-action="new-phrase">Nova</button></div></div>
          <div class="behavior-sidebar-list">${this.config.phrases.map(group => `<button class="behavior-phrase-card${group.id === this.selectedPhraseId ? " active" : ""}" type="button" data-action="select-phrase" data-id="${escapeHtml(group.id)}"><b>${escapeHtml(humanizeStudioId(group.id))}</b><small>${group.texts.length} fala(s)</small></button>`).join("")}</div>
        </aside>
        <section class="behavior-editor">${selected ? this.phraseEditorHtml(selected) : '<div class="behavior-empty">Crie o primeiro grupo de falas.</div>'}</section>
      </div>`;
    this.updateSpeechPreview();
  }

  phraseEditorHtml(group) {
    return `
      <div class="behavior-heading"><div><h3>${escapeHtml(humanizeStudioId(group.id))}</h3><p>Escolha aleatória com validação de macros antes de salvar.</p></div></div>
      <form data-studio-form="phrase" data-original-id="${escapeHtml(group.id)}">
        <div class="behavior-grid">
          <label class="behavior-field full">ID<input name="id" pattern="[a-z][a-z0-9_]*" required value="${escapeHtml(group.id)}" /></label>
          <label class="behavior-field full">Falas (uma por linha)<textarea name="texts" data-speech-input required>${escapeHtml(group.texts.join("\n"))}</textarea></label>
        </div>
        <div class="behavior-preview"><b>Pré-visualização com dados reais</b><p data-speech-preview></p><div class="behavior-validation" data-speech-errors></div></div>
        <div class="behavior-section"><h4>Inserir macro</h4><div class="behavior-inline-actions">${this.macros.map(macro => `<button class="behavior-mini-button" type="button" data-action="insert-macro" data-token="${escapeHtml(macro.token)}">${escapeHtml(macro.token)}</button>`).join("")}</div></div>
        <div class="behavior-editor-actions">
          <button class="button danger" type="button" data-action="delete-phrase" data-id="${escapeHtml(group.id)}">Excluir</button>
          <button class="button" type="button" data-action="duplicate-phrase" data-id="${escapeHtml(group.id)}">Duplicar</button>
          <button class="button primary" type="submit">Aplicar ao rascunho</button>
        </div>
      </form>`;
  }

  renderSpeechTemplate(template) {
    const byName = Object.fromEntries(this.macros.map(macro => [macro.macro, macro]));
    return String(template || "").replace(/{{\s*([a-z][a-z0-9_]*)\s*}}/g, (_match, name) => byName[name]?.displayValue ?? "--");
  }

  updateSpeechPreview() {
    const form = this.root.querySelector('[data-studio-form="phrase"]');
    if (!form) return;
    const texts = splitLines(new FormData(form).get("texts"));
    const report = validateStudioSpeech(this.config, texts);
    const preview = form.querySelector("[data-speech-preview]");
    const errors = form.querySelector("[data-speech-errors]");
    if (preview) preview.textContent = this.renderSpeechTemplate(texts[0] || "Adicione uma fala.");
    if (errors) errors.textContent = report.valid ? "Macros válidas." : report.errors.map(error => error.message).join(" ");
  }

  renderMacros() {
    const panel = this.root.querySelector('[data-behavior-panel="macros"]');
    if (!panel) return;
    const search = this.macroSearch.toLowerCase();
    const values = this.macros.filter(macro => !search || `${macro.macro} ${macro.description} ${macro.origin}`.toLowerCase().includes(search));
    panel.innerHTML = `
      <section class="behavior-surface">
        <div class="behavior-heading"><div><h3>Dicionário de macros</h3><p>Valores atuais são sanitizados pelo backend local; dados indisponíveis usam fallback.</p></div><span class="behavior-chip">${values.length} macros</span></div>
        <div class="behavior-toolbar"><input class="behavior-search" type="search" value="${escapeHtml(this.macroSearch)}" placeholder="Buscar macro, origem ou descrição" aria-label="Buscar macros" data-control="macro-search" /><button class="button" type="button" data-action="refresh-macros">Atualizar valores</button></div>
        <div class="behavior-macro-grid">${values.map(macro => `
          <button class="macro-card" type="button" data-action="insert-macro" data-token="${escapeHtml(macro.token)}">
            <span class="macro-card-head"><b class="macro-token">${escapeHtml(macro.token)}</b><span class="behavior-chip ${macro.available ? "ok" : "warn"}">${macro.available ? "disponível" : "fallback"}</span></span>
            <strong class="macro-value">${escapeHtml(macro.displayValue)}${macro.available && macro.unit && macro.type !== "duration" ? escapeHtml(macro.unit) : ""}</strong>
            <p>${escapeHtml(macro.description)}</p><p>Origem: ${escapeHtml(macro.origin)} · ${escapeHtml(macro.type)}${macro.unit ? ` · ${escapeHtml(macro.unit)}` : ""}</p>
            <p>Fallback: ${escapeHtml(macro.fallback ?? "--")}</p>
          </button>`).join("")}</div>
      </section>`;
  }

  renderSimulator() {
    const panel = this.root.querySelector('[data-behavior-panel="simulator"]');
    if (!panel) return;
    panel.innerHTML = `
      <div class="behavior-simulator">
        <form class="behavior-surface" data-studio-form="simulator">
          <div class="behavior-heading"><div><h3>Cenário isolado</h3><p>Nenhum valor real do painel é alterado.</p></div><span class="behavior-chip ok">sandbox</span></div>
          <div class="behavior-grid">
            <label class="behavior-field full">Regra em teste<select name="testTriggerId"><option value="all">Todas as regras</option>${this.config.triggers.map(trigger => `<option value="${escapeHtml(trigger.id)}"${trigger.id === this.selectedTriggerId ? " selected" : ""}>${escapeHtml(trigger.name || humanizeStudioId(trigger.id))}</option>`).join("")}</select></label>
            <label class="behavior-field span-3">CPU %<input name="cpu" type="number" min="0" max="100" step="0.1" value="35" /></label>
            <label class="behavior-field span-3">RAM %<input name="ram" type="number" min="0" max="100" step="0.1" value="45" /></label>
            <label class="behavior-field span-3">Disco %<input name="disk" type="number" min="0" max="100" step="0.1" value="55" /></label>
            <label class="behavior-field span-3">GPU %<input name="gpu" type="number" min="0" max="100" step="0.1" placeholder="indisponível" /></label>
            <label class="behavior-field span-3">Memória GPU %<input name="gpuMemory" type="number" min="0" max="100" step="0.1" placeholder="indisponível" /></label>
            <label class="behavior-field span-3">Temperatura °C<input name="temperature" type="number" step="0.1" value="24" /></label>
            <label class="behavior-field span-6">Clima<input name="weather" value="Céu limpo" /></label>
            <label class="behavior-field span-3">Código clima<input name="weatherCode" type="number" value="0" /></label>
            <label class="behavior-field span-3">Codex 5h %<input name="fiveHourPercent" type="number" min="0" max="100" value="70" /></label>
            <label class="behavior-field span-3">Reset 5h (s)<input name="fiveHourResetSeconds" type="number" min="0" value="7200" /></label>
            <label class="behavior-field span-3">Semanal %<input name="weeklyPercent" type="number" min="0" max="100" value="70" /></label>
            <label class="behavior-field span-3">Reset semanal (s)<input name="weeklyResetSeconds" type="number" min="0" value="86400" /></label>
            <label class="behavior-field span-3">Inatividade (s)<input name="idleSeconds" type="number" min="0" value="0" /></label>
            <label class="behavior-field span-3">Horário<input name="time" type="time" step="1" value="12:00:00" /></label>
            <label class="behavior-field span-3">Coleta<select name="collectionState">${optionsHtml(["ok", "error", "missing"], "ok", { ok: "Normal", error: "Erro", missing: "Sem dados" })}</select></label>
            <label class="behavior-field span-3">Idade coleta (min)<input name="collectionAgeMinutes" type="number" min="0" value="0" /></label>
            <label class="behavior-field span-6">Evento<select name="eventType">${optionsHtml(["auto", ...STUDIO_EVENTS], "auto", { auto: "Avaliação automática", ...EVENT_LABELS })}</select></label>
            <label class="behavior-field span-3">Card do clique<select name="eventCard">${optionsHtml([...STUDIO_CARDS, "sprite"], "maquina", { ...CARD_LABELS, sprite: "Sprite" })}</select></label>
            <label class="behavior-field span-3">Fase do arraste<select name="dragPhase">${optionsHtml(["start", "move", "end"], "end")}</select></label>
            <label class="behavior-field span-6">Métrica alterada<select name="changeMetric">${optionsHtml(Object.keys(STUDIO_CHANGE_FIELDS), "temperatura", CHANGE_LABELS)}</select></label>
            <label class="behavior-field span-6">Valor anterior<input name="changeFrom" value="20" placeholder="ex.: 20, 11:00 ou error" /></label>
          </div>
          <div class="behavior-checks behavior-section">
            <label class="behavior-check"><input name="fiveHourLimitReached" type="checkbox" /> Limite 5h atingido</label>
            <label class="behavior-check"><input name="weeklyLimitReached" type="checkbox" /> Semanal atingido</label>
          </div>
          <div class="behavior-editor-actions"><button class="button primary" type="submit">Executar simulação</button></div>
        </form>
        <section class="behavior-surface"><div class="behavior-heading"><div><h3>Resultado</h3><p>Prioridade, sprite, card, estado, fala e tempos.</p></div><span class="behavior-chip" data-simulation-count>0 gatilhos</span></div><div data-simulation-results class="behavior-result-list"><div class="behavior-empty">Preencha o cenário e execute.</div></div></section>
      </div>`;
  }

  simulatorValues(form) {
    const data = new FormData(form);
    const optional = name => data.get(name) === "" ? null : numberValue(data.get(name));
    return {
      cpu: optional("cpu"), ram: optional("ram"), disk: optional("disk"), gpu: optional("gpu"), gpuMemory: optional("gpuMemory"),
      temperature: optional("temperature"), weather: data.get("weather"), weatherCode: optional("weatherCode"),
      fiveHourPercent: optional("fiveHourPercent"), fiveHourResetSeconds: optional("fiveHourResetSeconds"),
      weeklyPercent: optional("weeklyPercent"), weeklyResetSeconds: optional("weeklyResetSeconds"),
      idleSeconds: optional("idleSeconds"), time: data.get("time"), collectionState: data.get("collectionState"),
      collectionAgeMinutes: optional("collectionAgeMinutes"), eventType: data.get("eventType"), eventCard: data.get("eventCard"),
      dragPhase: data.get("dragPhase"), fiveHourLimitReached: data.has("fiveHourLimitReached"), weeklyLimitReached: data.has("weeklyLimitReached"),
      testTriggerId: data.get("testTriggerId"),
      changeMetric: data.get("changeMetric"), changeFrom: data.get("changeFrom"),
    };
  }

  updateSimulationResults() {
    const container = this.root.querySelector("[data-simulation-results]");
    const count = this.root.querySelector("[data-simulation-count]");
    if (!container || !this.lastSimulation) return;
    const events = this.lastSimulation.events;
    if (count) count.textContent = `${events.length} gatilho${events.length === 1 ? "" : "s"}`;
    container.innerHTML = events.length ? events.map((event, index) => `
      <article class="behavior-result-card">
        <div><h4>${escapeHtml(event.triggerName || humanizeStudioId(event.triggerId))}</h4><p>${escapeHtml(event.message || event.fallbackMessage || "Sem fala")}</p><div class="behavior-result-meta"><span class="behavior-chip">P${escapeHtml(event.priority)}</span><span class="behavior-chip">${escapeHtml(CHARACTER_LABELS[event.character] || event.character)}</span><span class="behavior-chip">${escapeHtml(CARD_LABELS[event.anchor] || event.anchor)}</span><span class="behavior-chip">${escapeHtml(event.state)}</span><span class="behavior-chip">${event.durationMs / 1000}s</span><span class="behavior-chip">cooldown ${event.cooldownMs / 1000}s</span><span class="behavior-chip">card ${event.holdMs / 1000}s</span></div></div>
        <button class="button primary" type="button" data-action="play-simulation" data-index="${index}">Executar no painel</button>
      </article>`).join("") : '<div class="behavior-empty">Nenhum gatilho foi ativado neste cenário.</div>';
  }

  renderDefaults() {
    const panel = this.root.querySelector('[data-behavior-panel="defaults"]');
    if (!panel) return;
    const behavior = this.config.defaultBehavior;
    panel.innerHTML = `
      <form class="behavior-surface" data-studio-form="defaults">
        <div class="behavior-heading"><div><h3>Configuração padrão</h3><p>Parâmetros globais usados quando o gatilho não define um valor próprio.</p></div><button class="button" type="button" data-action="open-appearance">Abrir aparência</button></div>
        <div class="behavior-grid">
          <label class="behavior-field span-3">Estado inicial<select name="initialState">${optionsHtml(STUDIO_STATES, behavior.initialState)}</select></label>
          <label class="behavior-field span-3">Velocidade px/s<input name="speed" type="number" min="0" max="400" value="${escapeHtml(behavior.speed)}" /></label>
          <label class="behavior-field span-3">Duração reação (s)<input name="reactionDurationSeconds" type="number" min="0" max="120" value="${escapeHtml(behavior.reactionDurationSeconds)}" /></label>
          <label class="behavior-field span-3">Máx. simultâneas<input name="maxConcurrentReactions" type="number" min="1" max="3" step="1" value="${escapeHtml(behavior.coordination.maxConcurrentReactions)}" /></label>
          <label class="behavior-field span-3">Caminhada mín. (s)<input name="walkMin" type="number" min="0" value="${escapeHtml(behavior.walkDurationSeconds.min)}" /></label>
          <label class="behavior-field span-3">Caminhada máx. (s)<input name="walkMax" type="number" min="0" value="${escapeHtml(behavior.walkDurationSeconds.max)}" /></label>
          <label class="behavior-field span-3">Descanso mín. (s)<input name="restMin" type="number" min="0" value="${escapeHtml(behavior.restDurationSeconds.min)}" /></label>
          <label class="behavior-field span-3">Descanso máx. (s)<input name="restMax" type="number" min="0" value="${escapeHtml(behavior.restDurationSeconds.max)}" /></label>
          <label class="behavior-field span-3">Ação mín. (s)<input name="actionMin" type="number" min="0" value="${escapeHtml(behavior.actionIntervalSeconds.min)}" /></label>
          <label class="behavior-field span-3">Ação máx. (s)<input name="actionMax" type="number" min="0" value="${escapeHtml(behavior.actionIntervalSeconds.max)}" /></label>
          <label class="behavior-field span-3">Fala casual mín. (s)<input name="casualMin" type="number" min="0" value="${escapeHtml(behavior.casualSpeech.intervalSeconds.min)}" /></label>
          <label class="behavior-field span-3">Fala casual máx. (s)<input name="casualMax" type="number" min="0" value="${escapeHtml(behavior.casualSpeech.intervalSeconds.max)}" /></label>
          <label class="behavior-field span-3">Janela antirrepetição (s)<input name="duplicatePhraseWindowSeconds" type="number" min="0" value="${escapeHtml(behavior.coordination.duplicatePhraseWindowSeconds)}" /></label>
          <label class="behavior-field span-3">Distância entre sprites (px)<input name="minimumSpriteGapPixels" type="number" min="0" value="${escapeHtml(behavior.coordination.minimumSpriteGapPixels)}" /></label>
          <label class="behavior-field span-6">Posicionamento seguro<select name="safePlacement">${optionsHtml(["safe-area", "card-edge"], behavior.motion.safePlacement, { "safe-area": "Área segura do card", "card-edge": "Borda do card" })}</select></label>
        </div>
        <div class="behavior-checks behavior-section">
          <label class="behavior-check"><input name="enabled" type="checkbox"${behavior.enabled ? " checked" : ""} /> Motor habilitado</label>
          <label class="behavior-check"><input name="reactions" type="checkbox"${behavior.features.reactions ? " checked" : ""} /> Reações</label>
          <label class="behavior-check"><input name="movement" type="checkbox"${behavior.features.movement ? " checked" : ""} /> Movimento</label>
          <label class="behavior-check"><input name="speech" type="checkbox"${behavior.features.speech ? " checked" : ""} /> Falas</label>
          <label class="behavior-check"><input name="casualEnabled" type="checkbox"${behavior.casualSpeech.enabled ? " checked" : ""} /> Fala casual</label>
          <label class="behavior-check"><input name="returnToFreeRoam" type="checkbox"${behavior.motion.returnToFreeRoam ? " checked" : ""} /> Retornar ao passeio livre</label>
          <label class="behavior-check"><input name="avoidCollisions" type="checkbox"${behavior.motion.avoidCollisions ? " checked" : ""} /> Evitar colisões</label>
          <label class="behavior-check"><input name="preserveDrag" type="checkbox"${behavior.motion.preserveDrag ? " checked" : ""} /> Permitir arraste</label>
        </div>
        <div class="behavior-editor-actions"><button class="button primary" type="submit">Aplicar ao rascunho</button></div>
      </form>`;
  }

  renderHistory() {
    const panel = this.root.querySelector('[data-behavior-panel="history"]');
    if (!panel) return;
    panel.innerHTML = `
      <section class="behavior-surface">
        <div class="behavior-heading"><div><h3>Histórico e diagnóstico</h3><p>Somente campos sanitizados das reações; nenhum dado de sessão é armazenado.</p></div><button class="button danger" type="button" data-action="clear-history">Limpar histórico</button></div>
        <div class="behavior-toolbar"><input class="behavior-search" type="search" value="${escapeHtml(this.historySearch)}" placeholder="Buscar gatilho, personagem, card ou frase" aria-label="Buscar histórico" data-control="history-search" /><button class="button" type="button" data-action="refresh-history">Atualizar</button></div>
        <div class="behavior-table-wrap"><table class="behavior-table"><thead><tr><th>Data/hora</th><th>Gatilho</th><th>Valores</th><th>Personagem</th><th>Card / estado</th><th>Frase</th><th>Tempos</th><th>Resultado</th></tr></thead><tbody>${this.history.map(entry => `<tr><td>${escapeHtml(entry.timestamp ? new Date(entry.timestamp).toLocaleString("pt-BR") : "--")}</td><td><b>${escapeHtml(entry.triggerName || entry.triggerId)}</b><br><small>${escapeHtml(entry.triggerId)}</small></td><td>${escapeHtml(Object.entries(entry.values || {}).map(([key, value]) => `${key}: ${value}`).join(" · ") || "--")}</td><td>${escapeHtml(CHARACTER_LABELS[entry.character] || entry.character || "--")}</td><td>${escapeHtml(CARD_LABELS[entry.card] || entry.card || "--")}<br><small>${escapeHtml(entry.state || "--")}</small></td><td class="history-phrase">${escapeHtml(entry.phrase || "--")}</td><td>${escapeHtml(entry.durationSeconds ?? 0)}s<br><small>CD ${escapeHtml(entry.cooldownSeconds ?? 0)}s · card ${escapeHtml(entry.holdSeconds ?? 0)}s</small></td><td><span class="behavior-chip ${entry.error ? "error" : "ok"}">${escapeHtml(entry.error || entry.result || "--")}</span></td></tr>`).join("") || '<tr><td colspan="8"><div class="behavior-empty">Nenhuma reação registrada.</div></td></tr>'}</tbody></table></div>
      </section>`;
  }

  markDirty(message = "Alterações no rascunho ainda não foram salvas.") {
    this.dirty = true;
    this.setStatus(message, "warn");
  }

  async confirm(title, message) {
    if (!this.confirmDialog?.showModal) return window.confirm(message);
    document.getElementById("behaviorConfirmTitle").textContent = title;
    document.getElementById("behaviorConfirmMessage").textContent = message;
    this.confirmDialog.showModal();
    return new Promise(resolve => {
      const close = () => {
        this.confirmDialog.removeEventListener("close", close);
        resolve(this.confirmDialog.returnValue === "confirm");
      };
      this.confirmDialog.addEventListener("close", close);
    });
  }

  insertMacro(token, sourceButton = null) {
    const localForm = sourceButton?.closest?.("[data-studio-form]");
    const localField = localForm?.querySelector?.("[data-speech-input]");
    if (localField && (!this.lastSpeechField?.isConnected || this.lastSpeechField.closest("[data-studio-form]") !== localForm)) {
      this.lastSpeechField = localField;
    }
    const owningPanel = this.lastSpeechField?.closest?.("[data-behavior-panel]");
    if (this.lastSpeechField?.isConnected && owningPanel?.hidden) {
      const fieldName = this.lastSpeechField.name;
      this.switchTab(owningPanel.dataset.behaviorPanel);
      this.lastSpeechField = this.root.querySelector(`[data-behavior-panel="${owningPanel.dataset.behaviorPanel}"] [name="${fieldName}"]`);
    } else if (!this.lastSpeechField?.isConnected) {
      const target = this.lastSpeechTarget;
      this.switchTab(target?.tab || "speech");
      const panel = this.root.querySelector(`[data-behavior-panel="${target?.tab || "speech"}"]`);
      const form = [...(panel?.querySelectorAll("[data-studio-form]") || [])].find(item => (
        item.dataset.studioForm === target?.formType && (item.dataset.originalId || "") === (target?.originalId || "")
      ));
      this.lastSpeechField = form?.elements?.namedItem?.(target?.name) || panel?.querySelector("[data-speech-input]");
    }
    const field = this.lastSpeechField;
    if (!field) return;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    field.setRangeText(token, start, end, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.focus();
  }

  commitActiveForm(form = null) {
    const activeForm = form || this.root.querySelector('[data-behavior-panel]:not([hidden]) [data-studio-form="trigger"], [data-behavior-panel]:not([hidden]) [data-studio-form="phrase"], [data-behavior-panel]:not([hidden]) [data-studio-form="defaults"]');
    if (!activeForm) return false;
    if (!activeForm.checkValidity()) {
      activeForm.reportValidity();
      throw new Error("Revise os campos obrigatórios antes de continuar.");
    }
    const before = JSON.stringify(this.config);
    if (activeForm.dataset.studioForm === "trigger") {
      const trigger = this.serializeTriggerForm(activeForm);
      const speechTexts = [...(trigger.phrases || []), trigger.fallbackPhrase || "", ...Object.values(trigger.characterPhrases || {}).flat()].filter(Boolean);
      const speechReport = validateStudioSpeech(this.config, speechTexts);
      if (!speechReport.valid) throw new Error(speechReport.errors[0].message);
      const updated = replaceStudioTrigger(this.config, activeForm.dataset.originalId, trigger);
      this.config = updated.config;
      this.selectedTriggerId = updated.trigger.id;
    } else if (activeForm.dataset.studioForm === "phrase") {
      const data = new FormData(activeForm);
      const texts = splitLines(data.get("texts"));
      const report = validateStudioSpeech(this.config, texts);
      if (!report.valid) throw new Error(report.errors[0].message);
      const original = this.config.phrases.find(group => group.id === activeForm.dataset.originalId);
      const updated = updateStudioPhraseGroup(this.config, activeForm.dataset.originalId, {
        id: String(data.get("id") || "").trim(),
        texts,
        weight: original?.weight ?? 1,
      });
      this.config = updated.config;
      this.selectedPhraseId = updated.phrase.id;
    } else if (activeForm.dataset.studioForm === "defaults") {
      const data = new FormData(activeForm);
      const behavior = cloneStudioValue(this.config.defaultBehavior);
      behavior.enabled = data.has("enabled"); behavior.initialState = data.get("initialState"); behavior.speed = numberValue(data.get("speed")); behavior.reactionDurationSeconds = numberValue(data.get("reactionDurationSeconds"));
      behavior.walkDurationSeconds = { min: numberValue(data.get("walkMin")), max: numberValue(data.get("walkMax")) };
      behavior.restDurationSeconds = { min: numberValue(data.get("restMin")), max: numberValue(data.get("restMax")) };
      behavior.actionIntervalSeconds = { min: numberValue(data.get("actionMin")), max: numberValue(data.get("actionMax")) };
      behavior.casualSpeech.enabled = data.has("casualEnabled"); behavior.casualSpeech.intervalSeconds = { min: numberValue(data.get("casualMin")), max: numberValue(data.get("casualMax")) };
      behavior.features = { reactions: data.has("reactions"), movement: data.has("movement"), speech: data.has("speech") };
      behavior.coordination.maxConcurrentReactions = Math.round(numberValue(data.get("maxConcurrentReactions"), 1)); behavior.coordination.duplicatePhraseWindowSeconds = numberValue(data.get("duplicatePhraseWindowSeconds")); behavior.coordination.minimumSpriteGapPixels = numberValue(data.get("minimumSpriteGapPixels"));
      behavior.motion.returnToFreeRoam = data.has("returnToFreeRoam"); behavior.motion.avoidCollisions = data.has("avoidCollisions"); behavior.motion.preserveDrag = data.has("preserveDrag"); behavior.motion.safePlacement = data.get("safePlacement");
      this.config = { ...this.config, defaultBehavior: behavior };
    }
    const changed = JSON.stringify(this.config) !== before;
    if (changed) this.markDirty("Alteração incorporada ao rascunho. Salve para torná-la oficial.");
    return changed;
  }

  async handleClick(event) {
    const tab = event.target.closest("[data-behavior-tab]");
    if (tab) { this.switchTab(tab.dataset.behaviorTab); return; }
    const button = event.target.closest("[data-action], [data-studio-action]");
    if (!button) return;
    const action = button.dataset.action || button.dataset.studioAction;
    let targetId = button.dataset.id;
    try {
      if (["new-trigger", "select-trigger", "toggle-trigger", "duplicate-trigger", "test-trigger", "new-phrase", "select-phrase", "duplicate-phrase"].includes(action)) {
        const previousTriggerId = this.selectedTriggerId;
        const previousPhraseId = this.selectedPhraseId;
        this.commitActiveForm();
        if (targetId === previousTriggerId) targetId = this.selectedTriggerId;
        if (targetId === previousPhraseId) targetId = this.selectedPhraseId;
      }
      if (action === "new-trigger") {
        const created = createStudioTrigger(this.config);
        this.config = created.config; this.selectedTriggerId = created.trigger.id; this.markDirty(); this.renderBehaviors();
      } else if (action === "select-trigger") { this.selectedTriggerId = targetId; this.renderBehaviors(); }
      else if (action === "toggle-trigger") {
        const trigger = this.config.triggers.find(item => item.id === targetId);
        const updated = setStudioTriggerEnabled(this.config, targetId, !trigger.enabled);
        this.config = updated.config; this.selectedTriggerId = updated.trigger.id; this.markDirty(); this.renderBehaviors();
      } else if (action === "duplicate-trigger") {
        const duplicated = duplicateStudioTrigger(this.config, targetId);
        this.config = duplicated.config; this.selectedTriggerId = duplicated.trigger.id; this.markDirty(); this.renderBehaviors();
      } else if (action === "delete-trigger") {
        if (await this.confirm("Excluir comportamento", `Excluir definitivamente ${button.dataset.id} do rascunho?`)) {
          this.config = removeStudioTrigger(this.config, button.dataset.id); this.selectedTriggerId = this.config.triggers[0]?.id || null; this.markDirty(); this.renderBehaviors();
        }
      } else if (action === "test-trigger") {
        this.selectedTriggerId = targetId; this.switchTab("simulator", { commit: false }); this.setStatus(`Simulador pronto para testar ${targetId}.`, "ok");
      } else if (action === "add-condition") {
        const list = button.closest("form")?.querySelector("[data-condition-list]");
        const index = list?.querySelectorAll("[data-condition-row]").length || 0;
        list?.insertAdjacentHTML("beforeend", conditionRowHtml(conditionRowModel({ metric: "cpu", operator: ">", value: 75 }), index, this.config));
      } else if (action === "remove-condition") {
        const list = button.closest("[data-condition-list]");
        if (list?.querySelectorAll("[data-condition-row]").length > 1) button.closest("[data-condition-row]")?.remove();
        else this.setStatus("Um grupo precisa manter ao menos uma condição.", "error");
      } else if (action === "new-phrase") {
        const created = createStudioPhraseGroup(this.config); this.config = created.config; this.selectedPhraseId = created.phrase.id; this.markDirty(); this.renderSpeech();
      } else if (action === "select-phrase") { this.selectedPhraseId = targetId; this.renderSpeech(); }
      else if (action === "duplicate-phrase") {
        const duplicated = duplicateStudioPhraseGroup(this.config, targetId); this.config = duplicated.config; this.selectedPhraseId = duplicated.phrase.id; this.markDirty(); this.renderSpeech();
      } else if (action === "delete-phrase") {
        if (await this.confirm("Excluir grupo de falas", `Excluir ${button.dataset.id}?`)) { this.config = removeStudioPhraseGroup(this.config, button.dataset.id); this.selectedPhraseId = this.config.phrases[0]?.id || null; this.markDirty(); this.renderSpeech(); }
      } else if (action === "insert-macro") this.insertMacro(button.dataset.token, button);
      else if (action === "refresh-macros") { await this.refreshMacros(); this.renderMacros(); }
      else if (action === "play-simulation") {
        const reaction = this.lastSimulation?.events?.[Number(button.dataset.index)];
        const result = this.getEngine?.()?.playTemporary(reaction);
        this.setStatus(result?.played ? `Reação temporária executada por ${CHARACTER_LABELS[result.companion] || result.companion}.` : result?.reason || "Não foi possível executar a reação.", result?.played ? "ok" : "error");
        if (result?.played) this.close();
      } else if (action === "open-appearance") { this.close(); this.onOpenAppearance?.(); }
      else if (action === "refresh-history") await this.refreshHistory(this.root.querySelector('[data-control="history-search"]')?.value || "");
      else if (action === "clear-history") {
        if (await this.confirm("Limpar histórico", "Remover todos os registros de reações? Esta ação não altera a configuração.")) { await this.request("/api/studio/history", { method: "DELETE" }); await this.refreshHistory(); this.setStatus("Histórico limpo.", "ok"); }
      } else if (action === "reload") {
        if (!this.dirty || await this.confirm("Descartar rascunho", "Recarregar a configuração oficial e perder alterações não salvas?")) await this.loadConfig();
      } else if (action === "save") await this.save();
      else if (action === "export") {
        const link = document.createElement("a"); link.href = "/api/studio/config/export"; link.download = "sprite-behaviors.json"; link.click();
      } else if (action === "import") this.importInput?.click();
      else if (action === "restore") await this.restoreDefault();
    } catch (error) {
      this.setStatus(error.details?.[0]?.message || error.message, "error");
    }
  }

  handleInput(event) {
    if (event.target.closest('[data-studio-form="trigger"], [data-studio-form="phrase"], [data-studio-form="defaults"]')) {
      this.dirty = true;
      this.setStatus("Há campos editados aguardando salvamento.", "warn");
    }
    if (event.target.closest('[data-studio-form="phrase"]')) this.updateSpeechPreview();
    const control = event.target.dataset.control;
    if (!control) return;
    clearTimeout(this.searchTimer);
    const value = event.target.value;
    const selection = event.target.selectionStart ?? value.length;
    this.searchTimer = setTimeout(() => {
      try {
        if (control === "rule-search") {
          this.commitActiveForm();
          this.ruleSearch = value;
          this.renderBehaviors();
        } else if (control === "macro-search") {
          this.macroSearch = value;
          this.renderMacros();
        } else if (control === "history-search") {
          this.historySearch = value;
          this.refreshHistory(value);
        }
        const replacement = this.root.querySelector(`[data-control="${control}"]`);
        replacement?.focus();
        replacement?.setSelectionRange?.(selection, selection);
      } catch (error) {
        this.setStatus(error.message, "error");
      }
    }, control === "history-search" ? 280 : 140);
  }

  handleChange(event) {
    if (event.target.matches(".condition-kind")) event.target.closest("[data-condition-row]").dataset.kind = event.target.value;
    if (event.target.matches('[data-condition="eventType"]')) event.target.closest("[data-condition-row]").dataset.eventType = event.target.value;
    if (event.target.matches('[data-studio-form="trigger"] [name="characterSelectorKind"], [data-studio-form="trigger"] [name="characterSelectorValue"], [data-studio-form="trigger"] [name="spriteState"]')) {
      const form = event.target.closest('[data-studio-form="trigger"]');
      const kind = form.elements.characterSelectorKind.value;
      form.elements.characterSelectorValue.disabled = kind === "auto";
      const selector = normalizeCharacterSelector({ kind, value: kind === "auto" ? null : form.elements.characterSelectorValue.value });
      this.animationPreview.update({ characterId: this.resolveTriggerCharacterId(selector), state: form.elements.spriteState.value });
    }
    if (event.target.matches('[data-control="rule-filter"], [data-control="rule-sort"]')) {
      try {
        this.commitActiveForm();
        if (event.target.dataset.control === "rule-filter") this.ruleFilter = event.target.value;
        else this.ruleSort = event.target.value;
        this.renderBehaviors();
      } catch (error) {
        this.setStatus(error.message, "error");
      }
    }
    if (event.target.closest('[data-studio-form="phrase"]')) this.updateSpeechPreview();
  }

  handleSubmit(event) {
    const form = event.target.closest("[data-studio-form]");
    if (!form) return;
    event.preventDefault();
    try {
      if (form.dataset.studioForm === "trigger") {
        this.commitActiveForm(form);
        this.setStatus("Comportamento aplicado ao rascunho. Salve para torná-lo oficial.", "warn");
        this.renderBehaviors();
      } else if (form.dataset.studioForm === "phrase") {
        this.commitActiveForm(form);
        this.setStatus("Falas aplicadas ao rascunho.", "warn");
        this.renderSpeech();
      } else if (form.dataset.studioForm === "simulator") {
        const values = this.simulatorValues(form);
        this.lastSimulation = runStudioSimulation(this.config, values);
        if (!this.lastSimulation.valid) {
          this.lastSimulation.events = [];
          this.updateSimulationResults();
          const issue = this.lastSimulation.errors[0];
          this.setStatus(`${issue?.path || "$"}: ${issue?.message || "Rascunho inválido."}`, "error");
          return;
        }
        if (values.testTriggerId && values.testTriggerId !== "all") {
          this.lastSimulation.events = this.lastSimulation.events.filter(item => item.triggerId === values.testTriggerId);
        }
        this.updateSimulationResults();
        this.setStatus(`Simulação concluída sem alterar dados reais: ${this.lastSimulation.events.length} gatilho(s).`, "ok");
      } else if (form.dataset.studioForm === "defaults") {
        this.commitActiveForm(form);
        this.setStatus("Configuração padrão aplicada ao rascunho.", "warn");
        this.renderDefaults();
      }
    } catch (error) { this.setStatus(error.message, "error"); }
  }

  async save() {
    try { this.commitActiveForm(); }
    catch (error) { this.setStatus(error.message, "error"); return; }
    const clientReport = validateSpriteBehaviorConfig(this.config);
    if (!clientReport.valid) {
      this.setStatus(`${clientReport.errors[0].path}: ${clientReport.errors[0].message}`, "error");
      return;
    }
    this.setBusy(true);
    try {
      const payload = await this.request("/api/studio/config", { method: "PUT", body: JSON.stringify({ config: this.config, expectedRevision: this.revision }) });
      this.config = payload.config; this.revision = payload.revision; this.dirty = false;
      await this.onSavedConfig?.(this.config, payload);
      await this.refreshMacros();
      this.setStatus(`Configuração salva · backup ${payload.backup} · revisão ${payload.revision.slice(0, 8)}`, "ok");
      this.renderActivePanel();
    } catch (error) { this.setStatus(error.details?.[0] ? `${error.details[0].path}: ${error.details[0].message}` : error.message, "error"); }
    finally { this.setBusy(false); }
  }

  async importFile(file) {
    if (!file) return;
    this.setBusy(true);
    try {
      if (file.size > 1_000_000) throw new Error("Arquivo de importação excede 1 MB.");
      const config = JSON.parse(await file.text());
      const payload = await this.request("/api/studio/config/import", { method: "POST", body: JSON.stringify({ config, expectedRevision: this.revision }) });
      this.config = payload.config; this.revision = payload.revision; this.dirty = false; this.selectedTriggerId = this.config.triggers[0]?.id || null; this.selectedPhraseId = this.config.phrases[0]?.id || null;
      await this.onSavedConfig?.(this.config, payload); await this.refreshMacros(); this.render(); this.setStatus(`Importação concluída · backup ${payload.backup}.`, "ok");
    } catch (error) { this.setStatus(error.details?.[0]?.message || error.message, "error"); }
    finally { this.importInput.value = ""; this.setBusy(false); }
  }

  async restoreDefault() {
    if (!await this.confirm("Restaurar configuração padrão", "Criar um backup da configuração atual e restaurar a referência padrão do Studio?")) return;
    this.setBusy(true);
    try {
      const payload = await this.request("/api/studio/config/restore-default", { method: "POST", body: JSON.stringify({ expectedRevision: this.revision }) });
      this.config = payload.config; this.revision = payload.revision; this.dirty = false; this.selectedTriggerId = this.config.triggers[0]?.id || null; this.selectedPhraseId = this.config.phrases[0]?.id || null;
      await this.onSavedConfig?.(this.config, payload); await this.refreshMacros(); this.render(); this.setStatus(`Padrão restaurado · backup ${payload.backup}.`, "ok");
    } catch (error) { this.setStatus(error.details?.[0]?.message || error.message, "error"); }
    finally { this.setBusy(false); }
  }
}


export function createBehaviorStudio(options) {
  const studio = new BehaviorStudio(options);
  return studio.init().then(() => studio);
}
