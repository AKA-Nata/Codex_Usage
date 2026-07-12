import { SpriteReactionEngine, loadSpriteBehaviorConfig } from "./sprite-reaction-engine.js";
import { createBehaviorStudio } from "./behavior-studio.js";

const STORAGE_KEY = "codex-pulse-design-v2";
const DESIGN_SCHEMA_VERSION = 3;
const defaults = {
  designVersion: DESIGN_SCHEMA_VERSION,
  template: "nebula",
  title: "Codex Pulse",
  accent: "#62e8ff",
  accent2: "#a875ff",
  bg: "#090b16",
  imageUrl: "",
  videoUrl: "",
  sprite: "explorer",
  spriteEnabled: true,
  spriteCount: 2,
  spriteScale: 1,
  spriteSpeed: 1,
  spriteTalkInterval: 25,
  spriteRoam: true,
  spriteSmart: true,
  spriteSpeech: true,
  spriteMovement: true,
  customCss: "",
};

const templates = {
  nebula: { accent: "#62e8ff", accent2: "#a875ff", bg: "#090b16" },
  arcade: { accent: "#ff4da6", accent2: "#ffbf4a", bg: "#19071e" },
  glass: { accent: "#6ef3bf", accent2: "#83b7ff", bg: "#092324" },
};

const state = {
  usage: null,
  health: null,
  telemetry: null,
  settings: { stale_after_minutes: 45, auto_refresh_seconds: 60, telemetry_refresh_seconds: 5 },
  statusTimer: null,
  telemetryTimer: null,
  lastHumanInteractionAt: Date.now(),
  statusError: "",
  telemetryError: "",
  design: loadDesign(),
  spriteEngine: null,
  behaviorConfig: null,
  behaviorStudio: null,
};

function byId(id) { return document.getElementById(id); }
function validColor(value, fallback) { return /^#[0-9a-f]{6}$/i.test(value || "") ? value : fallback; }
function cleanUrl(value) { try { return value ? new URL(value, location.href).href : ""; } catch { return ""; } }
function safePercent(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}
function parseDate(value) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? date : null; }
function formatNumber(value, digits = 0) { const number = Number(value); return Number.isFinite(number) ? number.toFixed(digits) : "--"; }

function loadDesign() {
  try {
    const previous = JSON.parse(localStorage.getItem("codex-pulse-design-v1") || "{}");
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const storedVersion = Number(current.designVersion ?? previous.designVersion ?? 0);
    const merged = { ...defaults, ...previous, ...current };

    // Migração única: o valor 90s era o padrão antigo e deixava o personagem
    // inativo por muito tempo. Valores personalizados diferentes de 90s são preservados.
    if (storedVersion < DESIGN_SCHEMA_VERSION && Number(merged.spriteTalkInterval) === 90) {
      merged.spriteTalkInterval = defaults.spriteTalkInterval;
    }

    merged.designVersion = DESIGN_SCHEMA_VERSION;
    delete merged.hero;
    return merged;
  } catch {
    return { ...defaults };
  }
}

function saveDesign() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.design));
}

function countdown(date) {
  if (!date) return "Redefinição: --";
  let seconds = Math.max(0, Math.floor((date - Date.now()) / 1000));
  if (!seconds) return "Redefinição prevista para agora";
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours || days) parts.push(`${hours}h`);
  parts.push(`${minutes}min`);
  return `Redefinição em ${parts.join(" ")}`;
}

function exactDate(date) {
  return date
    ? date.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
    : "Horário exato indisponível";
}

function formatIdle(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}min ${total % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}min`;
}

function applyDesign() {
  const d = state.design;
  const behaviorDefaults = state.behaviorConfig?.defaultBehavior || {};
  const behaviorFeatures = behaviorDefaults.features || {};
  const effectiveSpriteEnabled = Boolean(d.spriteEnabled) && behaviorDefaults.enabled !== false;
  const root = document.documentElement.style;
  root.setProperty("--accent", validColor(d.accent, defaults.accent));
  root.setProperty("--accent-2", validColor(d.accent2, defaults.accent2));
  root.setProperty("--bg", validColor(d.bg, defaults.bg));
  root.setProperty("--image-url", d.imageUrl ? `url("${d.imageUrl.replaceAll('"', "%22")}")` : "none");
  byId("appTitle").textContent = d.title || defaults.title;
  byId("customCss").textContent = d.customCss || "";

  document.body.classList.toggle("has-image", Boolean(d.imageUrl));
  const video = byId("bgVideo");
  if (d.videoUrl && video.src !== d.videoUrl) {
    video.src = d.videoUrl;
    video.play().catch(() => {});
  }
  if (!d.videoUrl) {
    video.removeAttribute("src");
    video.load();
  }
  document.body.classList.toggle("has-video", Boolean(d.videoUrl));

  state.spriteEngine?.configure({
    enabled: effectiveSpriteEnabled,
    sprite: d.sprite,
    count: Number(d.spriteCount),
    scale: Number(d.spriteScale),
    speed: Number(d.spriteSpeed),
    talkInterval: Number(d.spriteTalkInterval),
    roam: Boolean(d.spriteRoam),
    reactions: Boolean(d.spriteSmart) && behaviorFeatures.reactions !== false,
    speech: Boolean(d.spriteSpeech) && behaviorFeatures.speech !== false,
    movement: Boolean(d.spriteMovement) && behaviorFeatures.movement !== false,
  });
  byId("companionBadge").textContent = effectiveSpriteEnabled
    ? `${Number(d.spriteCount) || 1} companheiro${Number(d.spriteCount) === 1 ? "" : "s"} ativo${Number(d.spriteCount) === 1 ? "" : "s"}`
    : "Companheiros desativados";
  syncControls();
}

function syncControls() {
  const d = state.design;
  byId("titleInput").value = d.title;
  byId("accentInput").value = validColor(d.accent, defaults.accent);
  byId("accent2Input").value = validColor(d.accent2, defaults.accent2);
  byId("bgInput").value = validColor(d.bg, defaults.bg);
  byId("imageUrlInput").value = d.imageUrl;
  byId("videoUrlInput").value = d.videoUrl;
  byId("spriteCountInput").value = d.spriteCount;
  byId("spriteCountOutput").value = d.spriteCount;
  byId("spriteScaleInput").value = d.spriteScale;
  byId("spriteSpeedInput").value = d.spriteSpeed;
  byId("spriteTalkInput").value = d.spriteTalkInterval;
  byId("spriteTalkOutput").value = `${d.spriteTalkInterval}s`;
  byId("spriteEnabledInput").checked = Boolean(d.spriteEnabled);
  byId("spriteRoamInput").checked = Boolean(d.spriteRoam);
  byId("spriteSmartInput").checked = Boolean(d.spriteSmart);
  byId("spriteSpeechInput").checked = Boolean(d.spriteSpeech);
  byId("spriteMovementInput").checked = Boolean(d.spriteMovement);
  byId("customCssInput").value = d.customCss;
  document.querySelectorAll("[data-template]").forEach(button => button.classList.toggle("active", button.dataset.template === d.template));
  document.querySelectorAll(".sprite-option").forEach(button => button.classList.toggle("active", button.dataset.sprite === d.sprite));
}

function updateDesign(values) {
  Object.assign(state.design, values);
  saveDesign();
  applyDesign();
}

function setStudio(open) {
  byId("studio").classList.toggle("open", open);
  byId("studioBackdrop").classList.toggle("open", open);
  byId("studio").setAttribute("aria-hidden", String(!open));
}

function renderCard(kind, data) {
  const suffix = kind === "5h" ? "5h" : "Weekly";
  const percent = safePercent(data?.remaining_percent);
  const reset = parseDate(data?.reset_at);
  byId(`percent${suffix}`).textContent = `${percent ?? "--"}%`;
  byId(`fill${suffix}`).style.width = `${percent ?? 0}%`;
  byId(`countdown${suffix}`).dataset.resetAt = data?.reset_at || "";
  byId(`countdown${suffix}`).textContent = countdown(reset);
  byId(`exact${suffix}`).textContent = exactDate(reset);
}

function setNotice(message, level = "") {
  const element = byId("notice");
  element.textContent = message || "";
  element.className = `notice${message ? " visible" : ""}${level ? ` ${level}` : ""}`;
}

function renderStatus() {
  const usage = state.usage || {};
  const health = state.health || {};
  renderCard("5h", usage.resets?.limite_5h);
  renderCard("weekly", usage.resets?.limite_semanal);

  byId("collectedAt").textContent = usage.collected_at
    ? `Atualizado ${new Date(usage.collected_at).toLocaleString("pt-BR")}`
    : "Ainda sem dados";
  const collected = parseDate(usage.collected_at);
  const stale = !collected || Date.now() - collected > Number(state.settings.stale_after_minutes || 45) * 60000;
  const badge = byId("statusBadge");
  if (health.status === "ok" && !stale) {
    badge.textContent = "Monitor online";
    setNotice("");
  } else if (health.status === "ok") {
    badge.textContent = "Dados anteriores";
    setNotice("Os dados passaram do intervalo esperado. Atualize quando quiser.", "warn");
  } else {
    badge.textContent = "Aguardando monitor";
    setNotice(health.message || "Inicie o Edge CDP e mantenha a aba de Analytics aberta.", health.status ? "warn" : "");
  }
}

function renderTelemetry() {
  const telemetry = state.telemetry || {};
  const clock = telemetry.clock || {};
  const machine = telemetry.machine || {};
  const weather = telemetry.weather || {};

  byId("clockValue").textContent = clock.time || new Date().toLocaleTimeString("pt-BR");
  byId("dateValue").textContent = clock.date || new Date().toLocaleDateString("pt-BR");
  byId("telemetryUpdatedAt").textContent = telemetry.generated_at
    ? `Atualizado ${new Date(telemetry.generated_at).toLocaleTimeString("pt-BR")}`
    : "Atualização local";

  byId("weatherLocation").textContent = weather.location || "Temperatura";
  byId("temperatureValue").textContent = weather.temperature_c !== null && weather.temperature_c !== undefined
    ? `${formatNumber(weather.temperature_c, 1)}°C`
    : "--°C";
  byId("weatherCondition").textContent = weather.status === "disabled"
    ? "Desativada no config.json"
    : weather.condition || weather.message || "Aguardando";
  byId("weatherIcon").textContent = weather.icon || "◌";

  const cpu = safePercent(machine.cpu_percent);
  const ram = safePercent(machine.memory_percent);
  const disk = safePercent(machine.disk_percent);
  byId("machineValue").textContent = `CPU ${cpu ?? "--"}% · RAM ${ram ?? "--"}%`;
  byId("machineDetail").textContent = `Disco ${disk ?? "--"}%${machine.memory_used_gb ? ` · ${machine.memory_used_gb}/${machine.memory_total_gb} GB` : ""}`;
  byId("cpuMiniBar").style.width = `${cpu ?? 0}%`;
  byId("ramMiniBar").style.width = `${ram ?? 0}%`;
}

function currentSpriteContext() {
  return {
    usage: state.usage || {},
    health: state.health || {},
    telemetry: state.telemetry || {},
    settings: state.settings,
    panelIdleSeconds: Math.floor((Date.now() - state.lastHumanInteractionAt) / 1000),
    errors: {
      status: state.statusError,
      telemetry: state.telemetryError,
    },
  };
}

function ingestSpriteContext() {
  state.spriteEngine?.ingest(currentSpriteContext());
}

async function recordSpriteReaction(entry) {
  try {
    await fetch("/api/studio/history", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
  } catch {
    // Histórico é diagnóstico auxiliar e nunca interrompe o motor visual.
  }
}

function handleStatusError(error) {
  state.statusError = error?.message || String(error || "Falha desconhecida");
  byId("statusBadge").textContent = "Painel offline";
  setNotice(`Não foi possível ler os dados locais: ${state.statusError}`, "error");
  ingestSpriteContext();
}

function handleTelemetryError(error) {
  state.telemetryError = error?.message || String(error || "Falha desconhecida");
  byId("weatherCondition").textContent = `Telemetria indisponível: ${state.telemetryError}`;
  ingestSpriteContext();
}

async function loadStatus() {
  const response = await fetch(`/api/status?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  state.usage = payload.usage || {};
  state.health = payload.health || {};
  state.settings = { ...state.settings, ...(payload.settings || {}) };
  state.statusError = "";
  renderStatus();
  ingestSpriteContext();
  scheduleStatusRefresh();
}

async function loadTelemetry() {
  const response = await fetch(`/api/telemetry?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  state.telemetry = await response.json();
  state.telemetryError = "";
  renderTelemetry();
  ingestSpriteContext();
  scheduleTelemetryRefresh();
}

function scheduleStatusRefresh() {
  clearInterval(state.statusTimer);
  state.statusTimer = setInterval(() => loadStatus().catch(handleStatusError), Math.max(15, Number(state.settings.auto_refresh_seconds || 60)) * 1000);
}

function scheduleTelemetryRefresh() {
  clearInterval(state.telemetryTimer);
  state.telemetryTimer = setInterval(() => loadTelemetry().catch(handleTelemetryError), Math.max(3, Number(state.settings.telemetry_refresh_seconds || 5)) * 1000);
}

async function refreshNow() {
  const button = byId("refreshButton");
  button.disabled = true;
  button.textContent = "Coletando...";
  setNotice("O monitor está buscando os dados na aba aberta.");
  try {
    const response = await fetch("/api/refresh", { method: "POST" });
    const payload = await response.json();
    state.usage = payload.usage || state.usage;
    state.health = payload.health || state.health;
    state.statusError = response.ok ? "" : payload.message || payload.error || "A coleta não foi concluída.";
    renderStatus();
    ingestSpriteContext();
    await loadTelemetry().catch(handleTelemetryError);
    if (!response.ok) setNotice(payload.message || payload.error || "A coleta não foi concluída.", "warn");
  } catch (error) {
    state.statusError = error.message;
    setNotice(`Falha ao atualizar: ${error.message}`, "error");
    ingestSpriteContext();
  } finally {
    button.disabled = false;
    button.innerHTML = "↻ <span>Atualizar</span>";
  }
}

function registerHumanInteraction() {
  const previousIdleSeconds = Math.floor((Date.now() - state.lastHumanInteractionAt) / 1000);
  state.spriteEngine?.notifyUserInteraction(previousIdleSeconds);
  state.lastHumanInteractionAt = Date.now();
}

function tickUi() {
  const now = new Date();
  byId("clockValue").textContent = now.toLocaleTimeString("pt-BR");
  byId("dateValue").textContent = now.toLocaleDateString("pt-BR");
  byId("idleValue").textContent = formatIdle((Date.now() - state.lastHumanInteractionAt) / 1000);

  ["countdown5h", "countdownWeekly"].forEach(id => {
    const element = byId(id);
    element.textContent = countdown(parseDate(element.dataset.resetAt));
  });
}

function bindEvents() {
  byId("openStudio").addEventListener("click", () => setStudio(true));
  byId("closeStudio").addEventListener("click", () => setStudio(false));
  byId("closeStudioBottom").addEventListener("click", () => setStudio(false));
  byId("studioBackdrop").addEventListener("click", () => setStudio(false));
  byId("refreshButton").addEventListener("click", refreshNow);

  document.querySelectorAll("[data-template]").forEach(button => button.addEventListener("click", () => updateDesign({ template: button.dataset.template, ...templates[button.dataset.template] })));
  document.querySelectorAll(".sprite-option").forEach(button => button.addEventListener("click", () => updateDesign({ sprite: button.dataset.sprite })));

  [["titleInput", "title"], ["accentInput", "accent"], ["accent2Input", "accent2"], ["bgInput", "bg"], ["customCssInput", "customCss"]]
    .forEach(([id, key]) => byId(id).addEventListener("input", event => updateDesign({ [key]: event.target.value })));

  [["spriteCountInput", "spriteCount", Number], ["spriteScaleInput", "spriteScale", Number], ["spriteSpeedInput", "spriteSpeed", Number], ["spriteTalkInput", "spriteTalkInterval", Number]]
    .forEach(([id, key, cast]) => byId(id).addEventListener("input", event => updateDesign({ [key]: cast(event.target.value) })));

  byId("spriteEnabledInput").addEventListener("change", event => updateDesign({ spriteEnabled: event.target.checked }));
  byId("spriteRoamInput").addEventListener("change", event => updateDesign({ spriteRoam: event.target.checked }));
  byId("spriteSmartInput").addEventListener("change", event => updateDesign({ spriteSmart: event.target.checked }));
  byId("spriteSpeechInput").addEventListener("change", event => updateDesign({ spriteSpeech: event.target.checked }));
  byId("spriteMovementInput").addEventListener("change", event => updateDesign({ spriteMovement: event.target.checked }));

  byId("imageUrlInput").addEventListener("change", event => updateDesign({ imageUrl: cleanUrl(event.target.value), videoUrl: "" }));
  byId("videoUrlInput").addEventListener("change", event => updateDesign({ videoUrl: cleanUrl(event.target.value), imageUrl: "" }));
  byId("imageFileInput").addEventListener("change", event => { const file = event.target.files?.[0]; if (file) updateDesign({ imageUrl: URL.createObjectURL(file), videoUrl: "" }); });
  byId("videoFileInput").addEventListener("change", event => { const file = event.target.files?.[0]; if (file) updateDesign({ videoUrl: URL.createObjectURL(file), imageUrl: "" }); });
  byId("clearMedia").addEventListener("click", () => updateDesign({ imageUrl: "", videoUrl: "" }));
  byId("resetDesign").addEventListener("click", () => { state.design = { ...defaults }; saveDesign(); applyDesign(); });

  ["pointerdown", "pointermove", "keydown", "touchstart", "wheel"].forEach(eventName => {
    document.addEventListener(eventName, registerHumanInteraction, { passive: true, capture: true });
  });
}

async function bootstrap() {
  const behaviorReport = await loadSpriteBehaviorConfig("./config/sprite-behaviors.json");
  state.behaviorConfig = behaviorReport.config;
  state.spriteEngine = new SpriteReactionEngine({
    root: byId("spriteWorld"),
    getContext: currentSpriteContext,
    onHumanInteraction: registerHumanInteraction,
    onReaction: recordSpriteReaction,
    behaviorConfig: behaviorReport.config,
    configReport: behaviorReport,
  });
  bindEvents();
  applyDesign();
  state.behaviorStudio = await createBehaviorStudio({
    root: byId("behaviorStudio"),
    backdrop: byId("behaviorStudioBackdrop"),
    openButton: byId("openBehaviorStudio"),
    closeButton: byId("closeBehaviorStudio"),
    importInput: byId("behaviorImportInput"),
    confirmDialog: byId("behaviorConfirmDialog"),
    getEngine: () => state.spriteEngine,
    getRealContext: currentSpriteContext,
    onOpenAppearance: () => setStudio(true),
    onSavedConfig: async (config, report) => {
      state.behaviorConfig = config;
      state.spriteEngine?.setBehaviors(config, { valid: true, source: "studio", usingFallback: false, issues: report.errors || [] });
      applyDesign();
      ingestSpriteContext();
    },
  });
  byId("companionBadge").title = behaviorReport.valid && !behaviorReport.usingFallback
    ? "Comportamentos declarativos ativos"
    : `Configuração principal indisponível; fallback seguro ativo. ${behaviorReport.issues?.[0]?.message || ""}`.trim();
  tickUi();
  setInterval(tickUi, 1000);

  loadStatus().catch(handleStatusError);
  loadTelemetry().catch(handleTelemetryError);
}

bootstrap().catch(error => {
  console.error("Falha ao iniciar o painel:", error);
  setNotice(`Falha ao iniciar o painel: ${error.message}`, "error");
});
