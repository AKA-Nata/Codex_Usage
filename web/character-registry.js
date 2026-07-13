export const CHARACTER_STATES = Object.freeze([
  "idle", "walk", "talk", "point", "inspect", "happy", "worried", "critical",
  "hot", "cold", "sleep", "wake", "confused", "celebrate", "dragging",
]);

export const NATIVE_CHARACTER_DEFINITIONS = Object.freeze([
  { id: "explorer", name: "Explorador", manifestUrl: "./assets/characters/explorer/character.json", legacyUrl: "./assets/sprites/explorer.png" },
  { id: "wizard", name: "Mago", manifestUrl: "./assets/characters/wizard/character.json", legacyUrl: "./assets/sprites/wizard.png" },
  { id: "mechanic", name: "Mecânico", manifestUrl: "./assets/characters/mechanic/character.json", legacyUrl: "./assets/sprites/mechanic.png" },
  { id: "orb", name: "Orbital", manifestUrl: "./assets/characters/orb/character.json", legacyUrl: "./assets/sprites/orb.png" },
]);

export const NATIVE_CHARACTER_IDS = Object.freeze(NATIVE_CHARACTER_DEFINITIONS.map(item => item.id));
export const CHARACTER_SELECTIONS = Object.freeze(["auto", ...NATIVE_CHARACTER_IDS]);

const ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function normalizePackageCharacterManifest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  if (raw.frame && Object.values(raw.states || {}).every(state => typeof state?.asset === "string" && state?.frames)) return clone(raw);
  const firstState = Object.values(raw.states || {})[0] || {};
  const firstFrame = firstState.frame || {};
  const fallbackState = typeof raw.fallback === "string" ? raw.fallback : raw.fallback?.state || "idle";
  return {
    schemaVersion: raw.schemaVersion || "1.0.0",
    id: raw.id,
    name: raw.name,
    version: raw.version,
    frame: {
      width: Number(firstFrame.width) || 256,
      height: Number(firstFrame.height) || 256,
      layout: "horizontal",
    },
    fps: Number(firstState.fps) || 6,
    loop: firstState.loop !== false,
    baseline: Number(raw.visualIdentity?.baseline ?? 0.9),
    anchor: clone(raw.visualIdentity?.anchor || { x: 0.5, y: 0.88 }),
    orientation: raw.visualIdentity?.orientation || "right",
    fallback: fallbackState,
    visualIdentity: clone(raw.visualIdentity || { id: raw.id, name: raw.name }),
    personality: clone(raw.personality || null),
    tags: clone(raw.tags || []),
    capabilities: clone(raw.capabilities || []),
    groups: clone(raw.groups || []),
    states: Object.fromEntries(Object.entries(raw.states || {}).map(([state, spec]) => {
      const asset = raw.assets?.[spec.asset];
      return [state, {
        asset: asset?.route || asset?.path || asset?.file || spec.asset,
        frames: Number(spec.frame?.count || spec.frames) || 1,
        fps: Number(spec.fps) || Number(firstState.fps) || 6,
        loop: spec.loop !== false,
      }];
    })),
  };
}

function issue(path, code, message) {
  return { path, code, message };
}

export function isSafeCharacterAssetPath(value) {
  if (typeof value !== "string" || !value || value.length > 180) return false;
  if (value.includes("\\") || value.includes("\0") || value.includes(":")) return false;
  if (value.startsWith("/") || value.startsWith("//") || /^[a-z]+:/i.test(value)) return false;
  const parts = value.split("/");
  return parts.every(part => part && part !== "." && part !== ".." && !/[. ]$/.test(part));
}

export function validateCharacterManifest(raw, { expectedId = null, requireAllStates = true } = {}) {
  const errors = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { valid: false, errors: [issue("$", "type", "Manifesto deve ser um objeto.")] };
  if (!ID_PATTERN.test(raw.id || "")) errors.push(issue("$.id", "id", "ID de personagem inválido."));
  if (expectedId && raw.id !== expectedId) errors.push(issue("$.id", "id_mismatch", `ID esperado: ${expectedId}.`));
  if (typeof raw.name !== "string" || !raw.name.trim() || raw.name.length > 80) errors.push(issue("$.name", "name", "Nome de personagem inválido."));
  if (!SEMVER_PATTERN.test(raw.version || "")) errors.push(issue("$.version", "semver", "Versão deve usar SemVer."));
  const frame = raw.frame;
  if (!frame || !Number.isInteger(frame.width) || !Number.isInteger(frame.height) || frame.width < 16 || frame.height < 16 || frame.width > 1024 || frame.height > 1024) {
    errors.push(issue("$.frame", "frame", "Frame deve informar dimensões inteiras entre 16 e 1024 px."));
  }
  if (frame?.layout !== "horizontal") errors.push(issue("$.frame.layout", "layout", "Somente sheets horizontais são aceitas."));
  if (!Number.isFinite(Number(raw.fps)) || Number(raw.fps) < 1 || Number(raw.fps) > 60) errors.push(issue("$.fps", "fps", "FPS deve ficar entre 1 e 60."));
  if (typeof raw.loop !== "boolean") errors.push(issue("$.loop", "loop", "loop deve ser booleano."));
  if (!Number.isFinite(Number(raw.baseline)) || Number(raw.baseline) < 0 || Number(raw.baseline) > 1) errors.push(issue("$.baseline", "baseline", "Baseline deve ficar entre 0 e 1."));
  if (!raw.anchor || !Number.isFinite(Number(raw.anchor.x)) || !Number.isFinite(Number(raw.anchor.y)) || raw.anchor.x < 0 || raw.anchor.x > 1 || raw.anchor.y < 0 || raw.anchor.y > 1) {
    errors.push(issue("$.anchor", "anchor", "Âncora deve usar coordenadas normalizadas."));
  }
  if (!["left", "right"].includes(raw.orientation)) errors.push(issue("$.orientation", "orientation", "Orientação deve ser left ou right."));
  if (typeof raw.fallback !== "string" || !raw.fallback) errors.push(issue("$.fallback", "fallback", "Fallback é obrigatório."));
  if (!raw.states || typeof raw.states !== "object" || Array.isArray(raw.states)) {
    errors.push(issue("$.states", "states", "Estados são obrigatórios."));
  } else {
    if (requireAllStates) CHARACTER_STATES.filter(state => state !== "dragging").forEach(state => {
      if (!raw.states[state]) errors.push(issue(`$.states.${state}`, "missing_state", `Estado obrigatório ausente: ${state}.`));
    });
    Object.entries(raw.states).forEach(([state, spec]) => {
      if (!ID_PATTERN.test(state)) errors.push(issue(`$.states.${state}`, "state", "Nome de estado inválido."));
      if (!spec || typeof spec !== "object" || !isSafeCharacterAssetPath(spec.asset)) errors.push(issue(`$.states.${state}.asset`, "asset", "Asset relativo inválido."));
      if (!Number.isInteger(spec?.frames) || spec.frames < 1 || spec.frames > 128) errors.push(issue(`$.states.${state}.frames`, "frames", "Quantidade de frames deve ficar entre 1 e 128."));
      const fps = spec?.fps ?? raw.fps;
      if (!Number.isFinite(Number(fps)) || Number(fps) < 1 || Number(fps) > 60) errors.push(issue(`$.states.${state}.fps`, "fps", "FPS deve ficar entre 1 e 60."));
      if (spec?.loop !== undefined && typeof spec.loop !== "boolean") errors.push(issue(`$.states.${state}.loop`, "loop", "loop deve ser booleano."));
    });
  }
  if (raw.states && !raw.states[raw.fallback]) errors.push(issue("$.fallback", "unknown_fallback", "Fallback deve referenciar um estado existente."));
  if (raw.legacyFallback !== undefined && !isSafeCharacterAssetPath(raw.legacyFallback)) errors.push(issue("$.legacyFallback", "legacy", "Fallback legado inválido."));
  return { valid: errors.length === 0, errors, manifest: errors.length ? null : clone(raw) };
}

function defaultImageLoader(url) {
  if (typeof Image === "undefined") return Promise.resolve({ src: url, naturalWidth: null, naturalHeight: null, decode: async () => {} });
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = async () => {
      try { await image.decode?.(); } catch {}
      resolve(image);
    };
    image.onerror = () => reject(new Error(`Asset de personagem indisponível: ${url}`));
    image.src = url;
  });
}

function resolveUrl(relative, base) {
  if (!isSafeCharacterAssetPath(relative)) throw new Error(`Caminho de asset recusado: ${relative}`);
  return new URL(relative, base).toString();
}

export class CharacterRegistry {
  constructor({ definitions = NATIVE_CHARACTER_DEFINITIONS, fetchImpl = null, imageLoader = defaultImageLoader, catalogUrl = "/api/characters/v1/catalog" } = {}) {
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
    this.imageLoader = imageLoader;
    this.catalogUrl = catalogUrl;
    this.definitions = new Map(definitions.map((definition, index) => [definition.id, { ...definition, source: definition.source || "native", displayOrder: definition.displayOrder ?? index }]));
    this.manifestPromises = new Map();
    this.assetPromises = new Map();
    this.records = new Map();
    this.diagnostics = new Map();
    this.catalogRevision = null;
  }

  async loadManifest(definition) {
    if (definition.manifest) return clone(definition.manifest);
    if (typeof this.fetchImpl !== "function") throw new Error("Fetch indisponível para carregar manifesto.");
    const key = definition.manifestUrl;
    if (!this.manifestPromises.has(key)) {
      this.manifestPromises.set(key, (async () => {
        const response = await this.fetchImpl(key, { cache: "no-store", credentials: "same-origin" });
        if (!response?.ok) throw new Error(`Manifesto ${definition.id} indisponível: HTTP ${response?.status ?? "?"}`);
        return response.json();
      })());
    }
    return clone(await this.manifestPromises.get(key));
  }

  async loadCharacter(id) {
    if (this.records.has(id)) return this.records.get(id);
    const definition = this.definitions.get(id);
    if (!definition) return null;
    try {
      const raw = await this.loadManifest(definition);
      const report = validateCharacterManifest(raw, { expectedId: id, requireAllStates: definition.source === "native" });
      if (!report.valid) throw new Error(report.errors[0].message);
      const documentBase = globalThis.document?.baseURI || globalThis.location?.href || "http://localhost/";
      const manifestBaseUrl = definition.baseUrl
        ? new URL(definition.baseUrl, documentBase).toString()
        : new URL(".", new URL(definition.manifestUrl, documentBase)).toString();
      const record = { ...definition, name: raw.name, manifest: report.manifest, manifestBaseUrl, valid: true, issues: [] };
      this.records.set(id, record);
      return record;
    } catch (error) {
      const record = { ...definition, name: definition.name || id, manifest: null, valid: false, issues: [String(error.message || error)] };
      this.records.set(id, record);
      return record;
    }
  }

  async loadNative() {
    await Promise.all(NATIVE_CHARACTER_IDS.filter(id => this.definitions.has(id)).map(id => this.loadCharacter(id)));
    return this.list();
  }

  async refreshCatalog() {
    if (typeof this.fetchImpl !== "function") return this.list();
    try {
      const response = await this.fetchImpl(this.catalogUrl, { cache: "no-store", credentials: "same-origin" });
      if (!response?.ok) return this.list();
      const payload = await response.json();
      this.registerCatalog(payload);
    } catch {}
    return this.list();
  }

  registerCatalog(payload = {}) {
    this.catalogRevision = payload.revision || this.catalogRevision;
    const incomingIds = new Set((payload.characters || []).map(item => item?.id).filter(Boolean));
    [...this.definitions.entries()].forEach(([id, definition]) => {
      if (definition.source === "installed" && !incomingIds.has(id)) {
        this.definitions.delete(id);
        this.records.delete(id);
      }
    });
    (payload.characters || []).forEach((item, index) => {
      if (!ID_PATTERN.test(item.id || "") || !item.manifest) return;
      const normalizedManifest = normalizePackageCharacterManifest(item.manifest);
      const report = validateCharacterManifest(normalizedManifest, { expectedId: item.id, requireAllStates: false });
      if (!report.valid) return;
      const previous = this.definitions.get(item.id) || {};
      this.definitions.set(item.id, {
        id: item.id,
        name: item.name || item.manifest.name,
        manifest: report.manifest,
        manifestUrl: item.manifestUrl || `${this.catalogUrl}/${item.id}/manifest`,
        baseUrl: item.baseUrl || item.assetBaseUrl || item.manifestUrl,
        legacyUrl: item.legacyUrl || previous.legacyUrl || null,
        source: item.source || "installed",
        native: item.native === true || item.source === "native",
        author: item.author || item.manifest.author || null,
        compatibility: item.compatibility || item.manifest.compatibility || null,
        versions: item.versions || [],
        enabled: item.enabled !== false,
        compatible: item.compatible !== false,
        displayOrder: item.displayOrder ?? previous.displayOrder ?? (NATIVE_CHARACTER_IDS.length + index),
        activeVersion: item.activeVersion || item.manifest.version,
        diagnostics: item.diagnostics || [],
      });
      this.records.delete(item.id);
    });
  }

  list() {
    return [...this.definitions.values()]
      .filter(item => item.enabled !== false)
      .sort((left, right) => Number(left.displayOrder || 0) - Number(right.displayOrder || 0) || left.id.localeCompare(right.id))
      .map(item => {
        const record = this.records.get(item.id);
        const manifest = record?.manifest || item.manifest;
        return {
          id: item.id,
          name: manifest?.name || item.name || item.id,
          version: manifest?.version || item.activeVersion || null,
          source: item.source || "native",
          enabled: item.enabled !== false,
          compatible: item.compatible !== false,
          states: Object.keys(manifest?.states || {}),
          personality: manifest?.personality || null,
          tags: manifest?.tags || [],
          capabilities: manifest?.capabilities || [],
          groups: manifest?.groups || [],
          author: item.author || manifest?.author || null,
          compatibility: item.compatibility || null,
          native: item.native === true || item.source === "native",
          versions: item.versions || [],
          valid: record ? record.valid : null,
          issues: record?.issues || item.diagnostics || [],
        };
      });
  }

  get(id) {
    const definition = this.definitions.get(id);
    if (!definition) return null;
    const record = this.records.get(id);
    return { ...definition, ...(record || {}) };
  }

  has(id) {
    return this.definitions.has(id);
  }

  async loadAsset(url, expectedWidth = null, expectedHeight = null) {
    if (!this.assetPromises.has(url)) this.assetPromises.set(url, Promise.resolve().then(() => this.imageLoader(url)));
    const image = await this.assetPromises.get(url);
    const width = Number(image?.naturalWidth || image?.width) || null;
    const height = Number(image?.naturalHeight || image?.height) || null;
    if (expectedWidth && width && width !== expectedWidth) throw new Error(`Largura inválida em ${url}: ${width}, esperado ${expectedWidth}.`);
    if (expectedHeight && height && height !== expectedHeight) throw new Error(`Altura inválida em ${url}: ${height}, esperado ${expectedHeight}.`);
    return image;
  }

  async resolveState(characterId, requestedState = "idle") {
    const record = await this.loadCharacter(characterId);
    const definition = this.definitions.get(characterId);
    if (!record || !definition) return this.resolveLegacy("explorer", requestedState, "personagem_desconhecido");
    const manifest = record.manifest;
    const candidates = [];
    if (manifest?.states?.[requestedState]) candidates.push({ state: requestedState, reason: null });
    if (manifest?.states?.[manifest.fallback || "idle"] && !candidates.some(item => item.state === (manifest.fallback || "idle"))) {
      candidates.push({ state: manifest.fallback || "idle", reason: "estado_ausente" });
    }
    for (const candidate of candidates) {
      const spec = manifest.states[candidate.state];
      try {
        const assetUrl = resolveUrl(spec.asset, record.manifestBaseUrl);
        const frames = Number(spec.frames) || 1;
        const image = await this.loadAsset(assetUrl, manifest.frame.width * frames, manifest.frame.height);
        const result = {
          characterId, requestedState, resolvedState: candidate.state, assetUrl, image,
          frames, frameWidth: manifest.frame.width, frameHeight: manifest.frame.height,
          fps: Number(spec.fps ?? manifest.fps), loop: spec.loop ?? manifest.loop,
          baseline: manifest.baseline, anchor: clone(manifest.anchor), orientation: manifest.orientation,
          source: record.source || "native", fallback: candidate.state !== requestedState,
          fallbackReason: candidate.reason, version: manifest.version,
        };
        this.diagnostics.set(`${characterId}:${requestedState}`, result);
        return result;
      } catch (error) {
        this.diagnostics.set(`${characterId}:${candidate.state}`, { error: String(error.message || error) });
      }
    }
    return this.resolveLegacy(characterId, requestedState, manifest ? "asset_indisponivel" : "manifesto_invalido");
  }

  async resolveLegacy(characterId, requestedState, reason) {
    const requested = this.definitions.get(characterId);
    const definition = (requested?.legacyUrl ? requested : null)
      || this.definitions.get("explorer")
      || NATIVE_CHARACTER_DEFINITIONS[0];
    const assetUrl = new URL(definition.legacyUrl, globalThis.document?.baseURI || globalThis.location?.href || "http://localhost/").toString();
    let image = null;
    try { image = await this.loadAsset(assetUrl); } catch {}
    const result = {
      characterId: definition.id, requestedState, resolvedState: "idle", assetUrl, image,
      frames: 1, frameWidth: null, frameHeight: null, fps: 1, loop: false,
      baseline: 0.9, anchor: { x: 0.5, y: 0.88 }, orientation: "right",
      source: "legacy", fallback: true, fallbackReason: reason, version: null,
    };
    this.diagnostics.set(`${characterId}:${requestedState}`, result);
    return result;
  }

  async preload(characterId, states = ["idle"]) {
    return Promise.all(states.map(state => this.resolveState(characterId, state)));
  }

  getDiagnostics(characterId, state = "idle") {
    return this.diagnostics.get(`${characterId}:${state}`) || null;
  }
}

export const defaultCharacterRegistry = new CharacterRegistry();
