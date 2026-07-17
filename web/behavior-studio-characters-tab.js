const DEFAULT_ENDPOINTS = Object.freeze({
  base: "/api/studio/characters/v1",
  catalog: "/api/characters/v1/catalog",
});

const FALLBACK_STATES = Object.freeze([
  "idle", "walk", "talk", "point", "inspect", "happy", "worried", "critical",
  "hot", "cold", "sleep", "wake", "confused", "celebrate",
]);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(value => String(value || "").trim()).filter(Boolean))];
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [];
  return [value];
}

function safeFilename(value, fallback = "character.codex-character.zip") {
  const normalized = String(value || "").replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function packageFilename(character) {
  return safeFilename(`${character?.id || "character"}-${character?.version || "current"}.codex-character.zip`);
}

function normalizeDiagnostics(...sources) {
  return sources.flatMap(source => asArray(source)).map(entry => {
    if (typeof entry === "string") return { level: "warn", message: entry };
    if (!entry || typeof entry !== "object") return { level: "warn", message: String(entry) };
    return {
      level: ["ok", "info", "warn", "error"].includes(entry.level) ? entry.level : (entry.error ? "error" : "warn"),
      code: entry.code || entry.type || "",
      message: entry.message || entry.error || entry.detail || JSON.stringify(entry),
    };
  });
}

function personalityLabel(value) {
  if (!value) return "Não informada";
  if (typeof value === "string") return value;
  return value.name || value.label || value.id || value.type || "Personalidade declarada";
}

function authorLabel(value) {
  if (!value) return "Não informado";
  if (typeof value === "string") return value;
  return value.name || value.id || "Autor declarado";
}

function compatibilityLabel(character) {
  const value = character.compatibility;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    if (value.dashboard && typeof value.dashboard === "object") return compatibilityLabel({ ...character, compatibility: value.dashboard });
    const minimum = value.minStudio || value.minimum || value.min || value.from;
    const maximum = value.maxStudio || value.maximum || value.max || value.to;
    if (minimum && maximum) return `Studio ${minimum}–${maximum}`;
    if (minimum) return `Studio ≥ ${minimum}`;
    if (maximum) return `Studio ≤ ${maximum}`;
    if (value.version) return String(value.version);
  }
  return character.compatible ? "Compatível com este Studio" : "Incompatível com este Studio";
}

function mergeCharacter(left = {}, right = {}) {
  const manifest = { ...(left.manifest || {}), ...(right.manifest || {}) };
  const merged = { ...left, ...right, manifest };
  const statesValue = right.states ?? left.states ?? manifest.states;
  const states = Array.isArray(statesValue) ? statesValue : Object.keys(statesValue || {});
  const source = merged.source || (merged.native ? "native" : "installed");
  const versions = uniqueStrings(merged.versions || merged.installedVersions || merged.availableVersions || []);
  const diagnostics = normalizeDiagnostics(left.diagnostics, left.issues, right.diagnostics, right.issues);
  return {
    ...merged,
    id: String(merged.id || manifest.id || ""),
    name: merged.name || manifest.name || merged.id || "Personagem",
    author: authorLabel(merged.author || manifest.author),
    version: merged.activeVersion || merged.version || manifest.version || "—",
    source,
    native: merged.native === true || source === "native",
    enabled: merged.enabled !== false && merged.active !== false,
    compatible: merged.compatible !== false && merged.compatibility?.compatible !== false,
    compatibility: merged.compatibility || manifest.compatibility || null,
    personality: merged.personality || manifest.personality || null,
    states: uniqueStrings(states),
    tags: uniqueStrings(merged.tags || manifest.tags),
    capabilities: uniqueStrings(merged.capabilities || manifest.capabilities),
    versions,
    rollbackAvailable: merged.rollbackAvailable === true || versions.length > 1,
    updateAvailable: merged.updateAvailable ?? merged.hasUpdate ?? null,
    inUse: merged.inUse === true || Number(merged.references || 0) > 0,
    diagnostics,
    valid: merged.valid !== false && !diagnostics.some(item => item.level === "error"),
    manifest,
  };
}

function payloadCharacters(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.characters || payload?.items || payload?.packages || [];
}

function mergePayloads(catalogPayload, managementPayload) {
  const byId = new Map();
  for (const item of payloadCharacters(catalogPayload)) {
    const normalized = mergeCharacter({}, item);
    if (normalized.id) byId.set(normalized.id, normalized);
  }
  for (const item of payloadCharacters(managementPayload)) {
    const identifier = String(item?.id || item?.manifest?.id || "");
    if (!identifier) continue;
    byId.set(identifier, mergeCharacter(byId.get(identifier), item));
  }
  return [...byId.values()].sort((left, right) => {
    if (left.native !== right.native) return left.native ? -1 : 1;
    return left.name.localeCompare(right.name, "pt-BR", { sensitivity: "base" });
  });
}

async function responseJson(value) {
  if (value && typeof value.json === "function") {
    if (value.ok === false) {
      let payload = {};
      try { payload = await value.json(); } catch {}
      throw new Error(payload.message || payload.error || `HTTP ${value.status || "?"}`);
    }
    return value.json();
  }
  return value ?? {};
}

function optionHtml(value, selected, label = value) {
  return `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
}

function chipList(values, emptyMessage = "Nenhum item declarado") {
  if (!values.length) return `<span class="behavior-chip">${escapeHtml(emptyMessage)}</span>`;
  return values.map(value => `<span class="behavior-chip">${escapeHtml(value)}</span>`).join("");
}

/**
 * Aba independente de gerenciamento de personagens do Studio 5.0.
 *
 * requestJson(url, options) deve devolver um payload JSON (ou Response).
 * requestBinary(url, options) deve devolver Blob, ArrayBuffer, Uint8Array,
 * Response ou { body, filename, contentType }. Todos os callbacks são opcionais.
 */
export class BehaviorStudioCharactersTab {
  constructor({
    root,
    registry,
    animationEngine,
    requestJson,
    requestBinary,
    confirm,
    callbacks = {},
    endpoints = {},
  } = {}) {
    if (!root) throw new TypeError("BehaviorStudioCharactersTab requer root.");
    this.root = root;
    this.registry = registry || null;
    this.animationEngine = animationEngine || null;
    this.requestJson = requestJson || null;
    this.requestBinary = requestBinary || null;
    this.confirmAction = confirm || null;
    this.callbacks = callbacks || {};
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...endpoints };
    this.characters = [];
    this.selectedId = null;
    this.selectedState = "idle";
    this.previewFps = "";
    this.previewPlaying = true;
    this.previewController = null;
    this.previewDiagnostic = null;
    this.search = "";
    this.sourceFilter = "all";
    this.statusFilter = "all";
    this.compatibilityFilter = "all";
    this.packageFile = null;
    this.packageReport = null;
    this.revision = null;
    this.busy = false;
    this.destroyed = false;
    this.initialized = false;
    this.loadSequence = 0;
    this.abortController = typeof AbortController === "function" ? new AbortController() : null;
    this.boundClick = event => this.handleClick(event);
    this.boundInput = event => this.handleInput(event);
    this.boundChange = event => this.handleChange(event);
    this.boundKeydown = event => this.handleKeydown(event);
  }

  async init() {
    if (this.destroyed) throw new Error("A aba de personagens já foi destruída.");
    if (!this.initialized) {
      this.root.addEventListener("click", this.boundClick);
      this.root.addEventListener("input", this.boundInput);
      this.root.addEventListener("change", this.boundChange);
      this.root.addEventListener("keydown", this.boundKeydown);
      this.initialized = true;
    }
    this.render();
    await this.refresh();
    return this;
  }

  mount() {
    return this.init();
  }

  endpoint(action, characterId = "") {
    const base = String(this.endpoints.base || DEFAULT_ENDPOINTS.base).replace(/\/$/, "");
    const identifier = characterId ? `/${encodeURIComponent(characterId)}` : "";
    const configured = this.endpoints[action];
    if (typeof configured === "function") return configured(characterId);
    if (typeof configured === "string") return configured.replace("{id}", encodeURIComponent(characterId));
    const routes = {
      validate: `${base}/validate`,
      install: `${base}/install`,
      restoreNatives: `${base}/restore-natives`,
      installBundled: `${base}/bundled/${encodeURIComponent(characterId)}/install`,
      export: `${base}${identifier}/export`,
      enable: `${base}${identifier}/enable`,
      disable: `${base}${identifier}/disable`,
      update: `${base}${identifier}/update`,
      rollback: `${base}${identifier}/rollback`,
      remove: `${base}${identifier}`,
    };
    return routes[action] || `${base}${identifier}`;
  }

  requestOptions(options = {}) {
    return {
      cache: "no-store",
      credentials: "same-origin",
      ...(this.abortController ? { signal: this.abortController.signal } : {}),
      ...options,
    };
  }

  mutationHeaders(headers = {}) {
    if (!this.revision) throw new Error("Atualize a biblioteca antes de alterar personagens.");
    return { ...headers, "If-Match": `\"${this.revision}\"` };
  }

  async json(url, options = {}) {
    const request = this.requestJson || (async (target, init) => fetch(target, init));
    return responseJson(await request(url, this.requestOptions(options)));
  }

  async binary(url, options = {}) {
    const request = this.requestBinary || (async (target, init) => fetch(target, init));
    return request(url, this.requestOptions(options));
  }

  async refresh({ preserveSelection = true } = {}) {
    const sequence = ++this.loadSequence;
    this.setBusy(true);
    this.setStatus("Atualizando biblioteca de personagens…");
    const catalogUrl = this.endpoints.catalog || DEFAULT_ENDPOINTS.catalog;
    const [catalogResult, managementResult] = await Promise.allSettled([
      this.json(catalogUrl),
      this.json(this.endpoints.base || DEFAULT_ENDPOINTS.base),
    ]);
    if (this.destroyed || sequence !== this.loadSequence) return this.characters;
    try {
      if (catalogResult.status === "rejected" && managementResult.status === "rejected") {
        throw managementResult.reason || catalogResult.reason;
      }
      const catalogPayload = catalogResult.status === "fulfilled" ? catalogResult.value : {};
      const managementPayload = managementResult.status === "fulfilled" ? managementResult.value : {};
      const previousRevision = this.revision;
      this.revision = managementPayload.revision || catalogPayload.revision || this.revision;
      this.characters = mergePayloads(catalogPayload, managementPayload);
      if (typeof this.registry?.registerCatalog === "function" && catalogResult.status === "fulfilled") {
        this.registry.registerCatalog(catalogPayload);
      }
      const previous = preserveSelection ? this.selectedId : null;
      this.selectedId = this.characters.some(item => item.id === previous) ? previous : (this.characters[0]?.id || null);
      this.ensurePreviewState();
      this.render();
      this.setStatus(`${this.characters.length} personagem(ns) disponível(is).`, "ok");
      this.emit("catalog", { characters: this.characters, catalog: catalogPayload, management: managementPayload });
      if (previousRevision === null || previousRevision !== this.revision) {
        this.call("onCatalogChanged", this.characters, { catalog: catalogPayload, management: managementPayload });
      }
      return this.characters;
    } catch (error) {
      this.render();
      this.reportError(error, "refresh");
      return this.characters;
    } finally {
      this.setBusy(false);
    }
  }

  get selectedCharacter() {
    return this.characters.find(item => item.id === this.selectedId) || null;
  }

  get visibleCharacters() {
    const query = this.search.trim().toLocaleLowerCase("pt-BR");
    return this.characters.filter(character => {
      const haystack = [character.id, character.name, character.author, personalityLabel(character.personality), ...character.tags, ...character.capabilities]
        .join(" ").toLocaleLowerCase("pt-BR");
      if (query && !haystack.includes(query)) return false;
      if (this.sourceFilter !== "all" && character.source !== this.sourceFilter) return false;
      if (this.statusFilter === "enabled" && !character.enabled) return false;
      if (this.statusFilter === "disabled" && character.enabled) return false;
      if (this.statusFilter === "update" && character.updateAvailable !== true) return false;
      if (this.statusFilter === "diagnostic" && character.valid) return false;
      if (this.compatibilityFilter === "compatible" && !character.compatible) return false;
      if (this.compatibilityFilter === "incompatible" && character.compatible) return false;
      return true;
    });
  }

  ensurePreviewState() {
    const states = this.selectedCharacter?.states || [];
    if (!states.includes(this.selectedState)) this.selectedState = states.includes("idle") ? "idle" : (states[0] || "idle");
  }

  render() {
    if (this.destroyed) return;
    this.destroyPreview();
    this.root.innerHTML = `
      <div class="behavior-master-detail" data-characters-component>
        <aside class="behavior-sidebar" aria-label="Biblioteca de personagens">
          <div class="behavior-sidebar-head">
            <div class="behavior-heading">
              <div><h3>Biblioteca</h3><p>Personagens nativos e pacotes instalados.</p></div>
              <button class="button" type="button" data-character-action="refresh" aria-label="Atualizar biblioteca">Atualizar</button>
            </div>
            <div class="behavior-toolbar">
              <input class="behavior-search" type="search" value="${escapeHtml(this.search)}" placeholder="Buscar nome, tag ou capacidade" aria-label="Buscar personagens" data-character-control="search" />
              <select class="behavior-select" aria-label="Filtrar por origem" data-character-control="source">
                ${optionHtml("all", this.sourceFilter, "Todas as origens")}
                ${optionHtml("native", this.sourceFilter, "Nativos")}
                ${optionHtml("bundled", this.sourceFilter, "Bundled")}
                ${optionHtml("installed", this.sourceFilter, "Instalados")}
              </select>
              <select class="behavior-select" aria-label="Filtrar por estado" data-character-control="status">
                ${optionHtml("all", this.statusFilter, "Todos os estados")}
                ${optionHtml("enabled", this.statusFilter, "Ativos")}
                ${optionHtml("disabled", this.statusFilter, "Inativos")}
                ${optionHtml("update", this.statusFilter, "Com atualização")}
                ${optionHtml("diagnostic", this.statusFilter, "Com diagnóstico")}
              </select>
              <select class="behavior-select" aria-label="Filtrar por compatibilidade" data-character-control="compatibility">
                ${optionHtml("all", this.compatibilityFilter, "Toda compatibilidade")}
                ${optionHtml("compatible", this.compatibilityFilter, "Compatíveis")}
                ${optionHtml("incompatible", this.compatibilityFilter, "Incompatíveis")}
              </select>
            </div>
          </div>
          <div class="behavior-sidebar-list" role="listbox" aria-label="Personagens" data-character-list>
            ${this.libraryHtml()}
          </div>
        </aside>
        <section class="behavior-editor" aria-label="Detalhes do personagem" data-character-detail>
          ${this.detailHtml()}
        </section>
      </div>
      <div class="behavior-section" aria-labelledby="character-import-title">
        ${this.importHtml()}
      </div>
      <p class="behavior-status-line" role="status" aria-live="polite" data-character-status></p>`;
    this.root.setAttribute("aria-busy", String(this.busy));
    this.mountPreview();
  }

  libraryHtml() {
    const visible = this.visibleCharacters;
    if (!visible.length) return `<div class="behavior-empty">Nenhum personagem corresponde aos filtros.</div>`;
    return visible.map((character, index) => {
      const selected = character.id === this.selectedId;
      const status = character.compatible ? (character.enabled ? "ativo" : "inativo") : "incompatível";
      return `
        <button class="behavior-phrase-card${selected ? " active" : ""}" type="button" role="option"
          aria-selected="${selected}" tabindex="${selected || (!this.selectedId && index === 0) ? "0" : "-1"}"
          data-character-action="select" data-character-id="${escapeHtml(character.id)}">
          <b>${escapeHtml(character.name)}</b>
          <small>${escapeHtml(character.id)} · ${escapeHtml(character.version)} · ${escapeHtml(status)}</small>
          <span class="behavior-chip${character.native ? "" : " ok"}">${escapeHtml(character.source || (character.native ? "native" : "installed"))}</span>
          ${character.updateAvailable === true ? `<span class="behavior-chip warn">atualização</span>` : ""}
          ${character.valid ? "" : `<span class="behavior-chip error">diagnóstico</span>`}
        </button>`;
    }).join("");
  }

  detailHtml() {
    const character = this.selectedCharacter;
    if (!character) return `<div class="behavior-empty">Selecione um personagem para visualizar detalhes e ações.</div>`;
    const states = character.states.length ? character.states : FALLBACK_STATES;
    const versions = character.versions.filter(version => version !== character.version);
    const phraseCount = Number(character.phraseCount ?? character.manifest?.phrases?.length ?? 0);
    const updateReady = !character.native
      && Boolean(this.packageReport?.valid ?? this.packageReport?.ok)
      && this.packageReport?.manifest?.id === character.id;
    return `
      <div class="behavior-heading">
        <div>
          <h3>${escapeHtml(character.name)}</h3>
          <p>${escapeHtml(character.id)} · por ${escapeHtml(character.author)}</p>
        </div>
        <div class="behavior-inline-actions">
          <span class="behavior-chip ${character.enabled ? "ok" : "warn"}">${character.enabled ? "ativo" : "inativo"}</span>
          <span class="behavior-chip ${character.compatible ? "ok" : "error"}">${character.compatible ? "compatível" : "incompatível"}</span>
        </div>
      </div>
      <div class="behavior-preview behavior-animation-preview" data-character-preview>
        <div class="animation-preview-head">
          <div><b>Preview animado</b><small data-character-preview-summary>Carregando asset…</small></div>
          <span class="behavior-chip" data-character-preview-status>preload</span>
        </div>
        <div class="animation-preview-stage">
          <span class="animation-preview-sprite" role="img" aria-label="Preview animado de ${escapeHtml(character.name)}" data-character-preview-sprite></span>
        </div>
        <div class="animation-preview-controls">
          <label>Estado
            <select class="behavior-select" data-character-control="preview-state" aria-label="Estado da animação">
              ${states.map(state => optionHtml(state, this.selectedState)).join("")}
            </select>
          </label>
          <label>FPS
            <input type="number" min="1" max="60" step="1" value="${escapeHtml(this.previewFps)}" placeholder="auto" data-character-control="preview-fps" aria-label="FPS do preview" />
          </label>
          <button class="behavior-mini-button" type="button" data-character-action="play" aria-pressed="${this.previewPlaying}">Play</button>
          <button class="behavior-mini-button" type="button" data-character-action="pause" aria-pressed="${!this.previewPlaying}">Pause</button>
        </div>
        <div class="behavior-validation" role="status" aria-live="polite" data-character-preview-diagnostic></div>
      </div>
      <div class="behavior-section">
        <h4>Identidade e compatibilidade</h4>
        <div class="behavior-grid">
          <div class="behavior-field span-3"><span>Versão</span><strong>${escapeHtml(character.version)}</strong></div>
          <div class="behavior-field span-3"><span>Origem</span><strong>${escapeHtml(character.source || (character.native ? "native" : "installed"))}</strong></div>
          <div class="behavior-field span-6"><span>Compatibilidade</span><strong>${escapeHtml(compatibilityLabel(character))}</strong></div>
          <div class="behavior-field span-6"><span>Personalidade</span><strong>${escapeHtml(personalityLabel(character.personality))}</strong></div>
          <div class="behavior-field span-3"><span>Estados</span><strong>${character.states.length}</strong></div>
          <div class="behavior-field span-3"><span>Falas</span><strong>${phraseCount}</strong></div>
        </div>
      </div>
      <div class="behavior-section"><h4>Estados</h4><div class="behavior-inline-actions">${chipList(character.states, "Nenhum estado declarado")}</div></div>
      <div class="behavior-section"><h4>Tags</h4><div class="behavior-inline-actions">${chipList(character.tags, "Sem tags")}</div></div>
      <div class="behavior-section"><h4>Capacidades</h4><div class="behavior-inline-actions">${chipList(character.capabilities, "Sem capacidades")}</div></div>
      <div class="behavior-section">
        <h4>Diagnóstico</h4>
        <div data-character-diagnostics>${this.diagnosticsHtml(character)}</div>
      </div>
      <div class="behavior-editor-actions">
        ${character.source === "bundled" ? `<button class="button primary" type="button" data-character-action="install-bundled">Instalar bundled</button>` : character.native ? "" : `<button class="button danger" type="button" data-character-action="remove"${character.inUse ? ` title="O backend verificará as referências em uso"` : ""}>Remover</button>`}
        <button class="button" type="button" data-character-action="export">Exportar pacote</button>
        <button class="button" type="button" data-character-action="toggle">${character.enabled ? "Desativar" : "Ativar"}</button>
        <button class="button" type="button" data-character-action="update"${updateReady ? "" : " disabled"} title="Selecione e valide uma versão mais nova deste personagem">Atualizar com pacote validado</button>
        ${versions.length ? `<label class="behavior-field span-3">Versão para rollback<select data-character-control="rollback-version">${versions.map(version => optionHtml(version, versions[0])).join("")}</select></label>` : ""}
        <button class="button" type="button" data-character-action="rollback"${character.native || !character.rollbackAvailable ? " disabled" : ""}>Rollback</button>
      </div>`;
  }

  diagnosticsHtml(character) {
    const diagnostics = [...character.diagnostics];
    if (!character.compatible) diagnostics.unshift({ level: "error", message: compatibilityLabel(character) });
    if (!character.enabled) diagnostics.unshift({ level: "info", message: "Personagem instalado, mas desativado." });
    if (!diagnostics.length) return `<p class="behavior-status-line ok">Manifesto, compatibilidade e assets sem alertas conhecidos.</p>`;
    return `<ul>${diagnostics.map(item => `<li class="behavior-status-line ${escapeHtml(item.level)}"><b>${escapeHtml(item.code || item.level)}</b> ${escapeHtml(item.message)}</li>`).join("")}</ul>`;
  }

  importHtml() {
    const report = this.packageReport;
    const valid = Boolean(report?.valid ?? report?.ok);
    const errors = normalizeDiagnostics(report?.errors || report?.issues).map(item => ({ ...item, level: "error" }));
    const warnings = normalizeDiagnostics(report?.warnings);
    return `
      <div class="behavior-heading">
        <div><h3 id="character-import-title">Importar pacote</h3><p>Valide antes de instalar. O conteúdo nunca é executado no navegador.</p></div>
        <button class="button" type="button" data-character-action="restore-natives">Restaurar nativos</button>
      </div>
      <div class="behavior-toolbar">
        <input type="file" accept=".zip,.codex-character.zip,application/zip" hidden data-character-control="package-file" />
        <button class="button" type="button" data-character-action="choose-file">Selecionar pacote</button>
        <span class="behavior-status-line" data-character-file-name>${escapeHtml(this.packageFile?.name || "Nenhum pacote selecionado")}</span>
        <button class="button" type="button" data-character-action="validate-package"${this.packageFile ? "" : " disabled"}>Validar</button>
        <button class="button primary" type="button" data-character-action="install-package"${this.packageFile && valid ? "" : " disabled"}>Instalar</button>
      </div>
      ${report ? `<div class="behavior-preview" role="status" aria-live="polite">
        <b class="${valid ? "ok" : "error"}">${valid ? "Pacote válido" : "Pacote recusado"}</b>
        ${report.manifest?.name ? `<p>${escapeHtml(report.manifest.name)} · ${escapeHtml(report.manifest.version || "versão não informada")}</p>` : ""}
        ${[...errors, ...warnings].length ? `<ul>${[...errors, ...warnings].map(item => `<li class="behavior-status-line ${escapeHtml(item.level)}">${escapeHtml(item.message)}</li>`).join("")}</ul>` : `<p>Manifesto, checksums, tipos e limites aprovados.</p>`}
      </div>` : ""}`;
  }

  renderLibrary() {
    const list = this.root.querySelector("[data-character-list]");
    if (list) list.innerHTML = this.libraryHtml();
  }

  mountPreview() {
    const character = this.selectedCharacter;
    const element = this.root.querySelector("[data-character-preview-sprite]");
    if (!character || !element || typeof this.animationEngine?.attach !== "function") {
      const summary = this.root.querySelector("[data-character-preview-summary]");
      const status = this.root.querySelector("[data-character-preview-status]");
      if (summary) summary.textContent = "Motor de animação indisponível.";
      if (status) { status.textContent = "indisponível"; status.className = "behavior-chip warn"; }
      return;
    }
    this.previewController = this.animationEngine.attach(element, {
      characterId: character.id,
      state: this.selectedState,
      autoplay: this.previewPlaying,
      onDiagnostic: diagnostic => this.renderPreviewDiagnostic(diagnostic),
    });
    this.previewController.setPreviewFps?.(this.previewFps);
    if (this.previewPlaying) this.previewController.play?.();
    else this.previewController.pause?.();
  }

  renderPreviewDiagnostic(diagnostic = {}) {
    if (this.destroyed) return;
    this.previewDiagnostic = diagnostic;
    const summary = this.root.querySelector("[data-character-preview-summary]");
    const status = this.root.querySelector("[data-character-preview-status]");
    const detail = this.root.querySelector("[data-character-preview-diagnostic]");
    const fps = diagnostic.fps ?? "—";
    if (summary) summary.textContent = `${diagnostic.resolvedState || diagnostic.requestedState || this.selectedState} · ${diagnostic.frames || 1} frames · ${fps} FPS · ${diagnostic.loop ? "loop" : "1 ciclo"}`;
    if (status) {
      status.textContent = diagnostic.error ? "erro" : (diagnostic.fallback ? "fallback" : diagnostic.status || "ready");
      status.className = `behavior-chip ${diagnostic.error ? "error" : diagnostic.fallback ? "warn" : "ok"}`;
    }
    if (detail) {
      detail.textContent = diagnostic.error
        ? diagnostic.error
        : diagnostic.fallback
          ? `Estado ${diagnostic.requestedState || this.selectedState} resolvido como ${diagnostic.resolvedState || "idle"}: ${diagnostic.fallbackReason || "fallback do manifesto"}.`
          : `Asset ${diagnostic.resolvedState || this.selectedState} disponível em ${diagnostic.source || "registry"}.`;
    }
    this.emit("diagnostic", { character: this.selectedCharacter, diagnostic });
    this.call("onDiagnostic", diagnostic, this.selectedCharacter);
  }

  destroyPreview() {
    this.previewController?.destroy?.();
    this.previewController = null;
  }

  handleInput(event) {
    const control = event.target?.dataset?.characterControl;
    if (control === "search") {
      this.search = event.target.value;
      this.renderLibrary();
    } else if (control === "preview-fps") {
      const value = event.target.value;
      this.previewFps = value === "" ? "" : String(Math.max(1, Math.min(60, Number(value) || 1)));
      this.previewController?.setPreviewFps?.(this.previewFps);
    }
  }

  handleChange(event) {
    const control = event.target?.dataset?.characterControl;
    if (control === "source") { this.sourceFilter = event.target.value; this.renderLibrary(); }
    if (control === "status") { this.statusFilter = event.target.value; this.renderLibrary(); }
    if (control === "compatibility") { this.compatibilityFilter = event.target.value; this.renderLibrary(); }
    if (control === "preview-state") {
      this.selectedState = event.target.value;
      this.previewController?.setState?.(this.selectedState);
    }
    if (control === "package-file") this.setPackageFile(event.target.files?.[0] || null);
  }

  async handleClick(event) {
    const button = event.target.closest?.("[data-character-action]");
    if (!button || button.disabled || this.busy) return;
    const action = button.dataset.characterAction;
    try {
      if (action === "select") this.selectCharacter(button.dataset.characterId);
      else if (action === "refresh") await this.refresh();
      else if (action === "play") this.setPreviewPlaying(true);
      else if (action === "pause") this.setPreviewPlaying(false);
      else if (action === "choose-file") this.root.querySelector('[data-character-control="package-file"]')?.click();
      else if (action === "validate-package") await this.validatePackage();
      else if (action === "install-package") await this.installPackage();
      else if (action === "install-bundled") await this.installBundled();
      else if (action === "export") await this.exportSelected();
      else if (action === "toggle") await this.toggleSelected();
      else if (action === "update") await this.updateSelected();
      else if (action === "rollback") await this.rollbackSelected();
      else if (action === "remove") await this.removeSelected();
      else if (action === "restore-natives") await this.restoreNatives();
    } catch (error) {
      this.reportError(error, action);
    }
  }

  handleKeydown(event) {
    const option = event.target.closest?.('[role="option"][data-character-id]');
    if (!option || !["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Enter" || event.key === " ") {
      this.selectCharacter(option.dataset.characterId, { focus: true });
      return;
    }
    const visible = this.visibleCharacters;
    const currentIndex = Math.max(0, visible.findIndex(item => item.id === option.dataset.characterId));
    const nextIndex = event.key === "Home" ? 0
      : event.key === "End" ? visible.length - 1
        : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length;
    const next = visible[nextIndex];
    if (next) this.selectCharacter(next.id, { focus: true });
  }

  selectCharacter(identifier, { focus = false } = {}) {
    const character = this.characters.find(item => item.id === identifier);
    if (!character) return;
    this.selectedId = character.id;
    this.selectedState = character.states.includes("idle") ? "idle" : (character.states[0] || "idle");
    this.previewFps = "";
    this.previewPlaying = true;
    this.previewDiagnostic = null;
    this.render();
    if (focus) queueMicrotask(() => this.root.querySelector(`[data-character-id="${CSS.escape(character.id)}"]`)?.focus());
    this.emit("selection", { character });
    this.call("onSelectionChanged", character);
  }

  setPreviewPlaying(playing) {
    this.previewPlaying = Boolean(playing);
    if (this.previewPlaying) this.previewController?.play?.();
    else this.previewController?.pause?.();
    const play = this.root.querySelector('[data-character-action="play"]');
    const pause = this.root.querySelector('[data-character-action="pause"]');
    play?.setAttribute("aria-pressed", String(this.previewPlaying));
    pause?.setAttribute("aria-pressed", String(!this.previewPlaying));
  }

  setPackageFile(file) {
    const maximum = 25 * 1024 * 1024;
    if (file && (!/\.codex-character\.zip$/i.test(file.name || "") && !/\.zip$/i.test(file.name || ""))) {
      this.packageFile = null;
      this.packageReport = { valid: false, errors: ["Use um arquivo .codex-character.zip."] };
    } else if (file && file.size > maximum) {
      this.packageFile = null;
      this.packageReport = { valid: false, errors: ["O pacote excede o limite local de 25 MiB."] };
    } else {
      this.packageFile = file;
      this.packageReport = null;
    }
    this.render();
  }

  async uploadPackage(action, characterId = "") {
    if (!this.packageFile) throw new Error("Selecione um pacote antes de continuar.");
    const headers = {
      "Content-Type": "application/vnd.codex-character+zip",
      "X-Character-Package-Name": safeFilename(this.packageFile.name),
    };
    const token = this.packageReport?.validationToken || this.packageReport?.token;
    if (token) headers["X-Character-Validation-Token"] = String(token);
    const requestHeaders = action === "validate" ? headers : this.mutationHeaders(headers);
    return this.json(this.endpoint(action, characterId), { method: "POST", headers: requestHeaders, body: this.packageFile });
  }

  async validatePackage() {
    this.setBusy(true);
    this.setStatus("Validando pacote, manifesto, assets e checksums…");
    try {
      this.packageReport = await this.uploadPackage("validate");
      this.render();
      const valid = Boolean(this.packageReport.valid ?? this.packageReport.ok);
      this.setStatus(valid ? "Pacote validado e pronto para instalar." : "O pacote foi recusado.", valid ? "ok" : "error");
      this.emit("package-validated", { file: this.packageFile, report: this.packageReport });
      this.call("onPackageValidated", this.packageReport, this.packageFile);
      return this.packageReport;
    } finally {
      this.setBusy(false);
    }
  }

  async installPackage() {
    if (!Boolean(this.packageReport?.valid ?? this.packageReport?.ok)) throw new Error("Valide o pacote antes da instalação.");
    this.setBusy(true);
    this.setStatus("Instalando pacote atomicamente…");
    try {
      const result = await this.uploadPackage("install");
      const installedId = result.character?.id || result.id || this.packageReport?.manifest?.id || null;
      this.packageFile = null;
      this.packageReport = null;
      if (installedId) this.selectedId = installedId;
      await this.refresh();
      this.setStatus("Personagem instalado com sucesso.", "ok");
      this.afterAction("install", result);
      this.call("onInstalled", result);
      return result;
    } finally {
      this.setBusy(false);
    }
  }

  async installBundled() {
    const character = this.selectedCharacter;
    if (!character || character.source !== "bundled") return;
    this.setBusy(true); this.setStatus(`Instalando ${character.name}…`);
    try {
      const result = await this.json(this.endpoint("installBundled", character.id), { method: "POST", headers: this.mutationHeaders({ "Content-Type": "application/json" }), body: "{}" });
      this.selectedId = character.id;
      await this.refresh();
      this.setStatus(`${character.name} instalado e ativado.`, "ok");
      this.afterAction("install-bundled", result, character);
      return result;
    } finally { this.setBusy(false); }
  }

  async postSelected(action, body = {}) {
    const character = this.selectedCharacter;
    if (!character) throw new Error("Selecione um personagem.");
    this.setBusy(true);
    try {
      const result = await this.json(this.endpoint(action, character.id), {
        method: "POST",
        headers: this.mutationHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      await this.refresh();
      this.afterAction(action, result, character);
      return result;
    } finally {
      this.setBusy(false);
    }
  }

  async toggleSelected() {
    const character = this.selectedCharacter;
    if (!character) return;
    const action = character.enabled ? "disable" : "enable";
    this.setStatus(`${character.enabled ? "Desativando" : "Ativando"} ${character.name}…`);
    const result = await this.postSelected(action, { enabled: !character.enabled });
    this.setStatus(`${character.name} foi ${character.enabled ? "desativado" : "ativado"}.`, "ok");
    return result;
  }

  async updateSelected() {
    const character = this.selectedCharacter;
    if (!character) return;
    if (!this.packageFile || !Boolean(this.packageReport?.valid ?? this.packageReport?.ok) || this.packageReport?.manifest?.id !== character.id) {
      throw new Error("Selecione e valide um pacote mais novo com o mesmo ID antes de atualizar.");
    }
    if (!await this.confirm(`Atualizar ${character.name}`, "Instalar a atualização disponível e manter a versão atual para rollback?")) return;
    this.setStatus(`Atualizando ${character.name}…`);
    this.setBusy(true);
    let result;
    try {
      result = await this.uploadPackage("update", character.id);
      this.packageFile = null;
      this.packageReport = null;
      await this.refresh();
      this.afterAction("update", result, character);
    } finally {
      this.setBusy(false);
    }
    this.setStatus(`${character.name} foi atualizado.`, "ok");
    return result;
  }

  async rollbackSelected() {
    const character = this.selectedCharacter;
    if (!character) return;
    const version = this.root.querySelector('[data-character-control="rollback-version"]')?.value || null;
    if (!await this.confirm(`Rollback de ${character.name}`, `Restaurar ${version ? `a versão ${version}` : "a versão anterior"}?`)) return;
    this.setStatus(`Restaurando versão anterior de ${character.name}…`);
    const result = await this.postSelected("rollback", version ? { version } : {});
    this.setStatus(`Rollback de ${character.name} concluído.`, "ok");
    return result;
  }

  async removeSelected() {
    const character = this.selectedCharacter;
    if (!character || character.native) return;
    const detail = character.inUse ? " Há referências ativas; o backend recusará a remoção enquanto estiver em uso." : "";
    if (!await this.confirm(`Remover ${character.name}`, `Desinstalar este pacote e suas versões?${detail}`)) return;
    this.setBusy(true);
    this.setStatus(`Removendo ${character.name}…`);
    try {
      const result = await this.json(this.endpoint("remove", character.id), {
        method: "DELETE",
        headers: this.mutationHeaders(),
      });
      this.selectedId = null;
      await this.refresh({ preserveSelection: false });
      this.setStatus(`${character.name} foi removido.`, "ok");
      this.afterAction("remove", result, character);
      return result;
    } finally {
      this.setBusy(false);
    }
  }

  async restoreNatives() {
    if (!await this.confirm("Restaurar personagens nativos", "Revalidar e restaurar os quatro pacotes nativos? Pacotes de terceiros não serão removidos.")) return;
    this.setBusy(true);
    this.setStatus("Restaurando personagens nativos…");
    try {
      const result = await this.json(this.endpoint("restoreNatives"), {
        method: "POST",
        headers: this.mutationHeaders({ "Content-Type": "application/json" }),
        body: "{}",
      });
      await this.refresh();
      this.setStatus("Personagens nativos restaurados.", "ok");
      this.afterAction("restore-natives", result);
      return result;
    } finally {
      this.setBusy(false);
    }
  }

  async exportSelected() {
    const character = this.selectedCharacter;
    if (!character) return;
    this.setBusy(true);
    this.setStatus(`Exportando ${character.name}…`);
    try {
      const result = await this.binary(this.endpoint("export", character.id), { method: "GET" });
      await this.download(result, packageFilename(character));
      this.setStatus(`Pacote de ${character.name} exportado.`, "ok");
      this.afterAction("export", { filename: packageFilename(character) }, character);
    } finally {
      this.setBusy(false);
    }
  }

  async download(result, fallbackName) {
    if (result === null || result === undefined) return;
    let filename = fallbackName;
    let contentType = "application/zip";
    let body = result;
    if (result && typeof result === "object" && "body" in result && !(result instanceof Blob)) {
      body = result.body;
      filename = safeFilename(result.filename, fallbackName);
      contentType = result.contentType || contentType;
    }
    if (body && typeof body.blob === "function") {
      const disposition = body.headers?.get?.("Content-Disposition") || "";
      const match = disposition.match(/filename\*?=(?:UTF-8''|\")?([^";]+)/i);
      if (match) filename = safeFilename(decodeURIComponent(match[1]), fallbackName);
      contentType = body.headers?.get?.("Content-Type") || contentType;
      if (body.ok === false) throw new Error(`Exportação recusada: HTTP ${body.status || "?"}`);
      body = await body.blob();
    }
    const blob = body instanceof Blob ? body : new Blob([body], { type: contentType });
    const url = URL.createObjectURL(blob);
    try {
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.rel = "noopener";
      link.click();
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  async confirm(title, message) {
    if (typeof this.confirmAction === "function") return Boolean(await this.confirmAction(title, message));
    if (typeof globalThis.confirm === "function") return globalThis.confirm(message);
    return false;
  }

  setBusy(busy) {
    this.busy = Boolean(busy);
    this.root.setAttribute("aria-busy", String(this.busy));
  }

  setStatus(message, level = "") {
    const status = this.root.querySelector("[data-character-status]");
    if (status) {
      status.textContent = message || "";
      status.className = `behavior-status-line${level ? ` ${level}` : ""}`;
    }
    this.call("onStatus", { message, level });
  }

  afterAction(action, result, character = this.selectedCharacter) {
    const detail = { action, result, character };
    this.emit("action", detail);
    this.call("onAction", detail);
  }

  reportError(error, context) {
    if (this.destroyed && error?.name === "AbortError") return;
    const message = error?.message || String(error);
    this.setStatus(message, "error");
    this.emit("error", { error, context });
    this.call("onError", error, context);
  }

  call(name, ...args) {
    try { this.callbacks?.[name]?.(...args); } catch {}
  }

  emit(name, detail) {
    if (typeof CustomEvent === "function") {
      this.root.dispatchEvent(new CustomEvent(`characters:${name}`, { detail, bubbles: true }));
    }
  }

  destroy({ clear = true } = {}) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadSequence += 1;
    this.abortController?.abort();
    this.destroyPreview();
    if (this.initialized) {
      this.root.removeEventListener("click", this.boundClick);
      this.root.removeEventListener("input", this.boundInput);
      this.root.removeEventListener("change", this.boundChange);
      this.root.removeEventListener("keydown", this.boundKeydown);
    }
    if (clear) this.root.replaceChildren();
    this.call("onDestroy");
  }
}

export function createBehaviorStudioCharactersTab(options) {
  const tab = new BehaviorStudioCharactersTab(options);
  tab.ready = tab.init();
  return tab;
}

export const __charactersTabInternals = Object.freeze({
  mergeCharacter,
  mergePayloads,
  normalizeDiagnostics,
  safeFilename,
});
