import {
  CHARACTER_SELECTIONS,
  CHARACTER_STATES,
  NATIVE_CHARACTER_DEFINITIONS,
  NATIVE_CHARACTER_IDS,
  defaultCharacterRegistry,
} from "./character-registry.js";
import { defaultSpriteAnimationEngine } from "./sprite-animation-engine.js";
import {
  migrateCharacterSelectors,
  normalizeCharacterSelector,
  selectorMatchesCharacter,
  validateCharacterSelector,
} from "./character-selector.js";

const SPRITES = Object.fromEntries(NATIVE_CHARACTER_DEFINITIONS.map(item => [item.id, { name: item.name, url: item.legacyUrl }]));
const SPRITE_ORDER = [...NATIVE_CHARACTER_IDS];
export const SPRITE_CHARACTER_SELECTIONS = CHARACTER_SELECTIONS;
export const SPRITE_STATES = Object.freeze(CHARACTER_STATES.filter(state => state !== "dragging"));

export const DEFAULT_THRESHOLDS = Object.freeze({
  codexNormalAbove: 60,
  codexVisitFrom: 30,
  codexCriticalBelow: 10,
  resetSoonSeconds: 30 * 60,
  machineHighAbove: 75,
  machineCriticalAbove: 90,
  diskHighAbove: 85,
  diskCriticalAbove: 95,
  temperatureColdAt: 12,
  temperatureHotAt: 30,
  idleBoredSeconds: 5 * 60,
  idleSleepSeconds: 15 * 60,
  staleAfterMinutes: 45,
  minSpriteGap: 12,
});

export const DEFAULT_COOLDOWNS = Object.freeze({
  collectionError: 60 * 1000,
  collectionStale: 2 * 60 * 1000,
  telemetryError: 2 * 60 * 1000,
  codexCritical: 90 * 1000,
  codexWorried: 3 * 60 * 1000,
  codexVisit: 4 * 60 * 1000,
  codexNormal: 10 * 60 * 1000,
  resetSoon: 2 * 60 * 1000,
  machineCritical: 2 * 60 * 1000,
  machineHigh: 2 * 60 * 1000,
  weather: 4 * 60 * 1000,
  idle: 4 * 60 * 1000,
  clock: 5 * 60 * 1000,
  wake: 30 * 1000,
});

const STATE_CLASSES = SPRITE_STATES.map(state => `state-${state}`);
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomBetween(min, max, random = Math.random) {
  return min + random() * (max - min);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finitePercent(value) {
  const number = finiteNumber(value);
  return number === null ? null : clamp(number, 0, 100);
}

function timestampMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = finiteNumber(value);
  if (numeric !== null && numeric > 0) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function secondsUntil(resetAtMs, fallbackSeconds, now, collectedAtMs = null) {
  if (resetAtMs !== null) return Math.max(0, Math.floor((resetAtMs - now) / 1000));
  const fallback = finiteNumber(fallbackSeconds);
  if (fallback === null) return null;
  const elapsed = collectedAtMs === null ? 0 : Math.max(0, (now - collectedAtMs) / 1000);
  return Math.max(0, Math.floor(fallback - elapsed));
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number === null ? null : Math.max(0, number);
}

function clockHour(clock, now) {
  const iso = timestampMs(clock?.iso);
  if (iso !== null) return new Date(iso).getHours();
  const match = String(clock?.time || "").match(/^(\d{1,2}):/);
  if (match) return clamp(Number(match[1]), 0, 23);
  return new Date(now).getHours();
}

function dayPeriod(hour) {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 18) return "afternoon";
  if (hour >= 18 && hour < 23) return "evening";
  return "late";
}

function isRain(weatherCode, condition) {
  const code = finiteNumber(weatherCode);
  return (code !== null && RAIN_CODES.has(Math.round(code))) || /chuva|garoa|pancada|trovoada|tempestade/i.test(String(condition || ""));
}

function mergeThresholds(values = {}) {
  return { ...DEFAULT_THRESHOLDS, ...(values || {}) };
}

export function classifyCodexRemaining(percent, limitReached = false, thresholdValues = DEFAULT_THRESHOLDS) {
  const thresholds = mergeThresholds(thresholdValues);
  const value = finitePercent(percent);
  if (limitReached === true) return "critical";
  if (value === null) return "invalid";
  if (value < thresholds.codexCriticalBelow) return "critical";
  if (value <= thresholds.codexVisitFrom) return "worried";
  if (value <= thresholds.codexNormalAbove) return "visit";
  return "normal";
}

export function normalizeSpriteData(raw = {}, now = Date.now(), thresholdValues = DEFAULT_THRESHOLDS) {
  raw = raw && typeof raw === "object" ? raw : {};
  const thresholds = mergeThresholds(thresholdValues);
  const usage = raw.usage || {};
  const health = raw.health || {};
  const telemetry = raw.telemetry || {};
  const machine = telemetry.machine || {};
  const weather = telemetry.weather || {};
  const clock = telemetry.clock || {};
  const fiveHour = usage.resets?.limite_5h || {};
  const weekly = usage.resets?.limite_semanal || {};
  const claudeProvider = raw.providers?.providers?.claude || raw.providers?.claude || {};
  const claudeWindows = Array.isArray(claudeProvider.windows) ? claudeProvider.windows : [];
  const claudeSession = claudeWindows.find(item => item?.id === "session") || {};
  const claudeWeekly = claudeWindows.find(item => item?.id === "weekly") || {};
  const settingsStale = finiteNumber(raw.settings?.stale_after_minutes);
  const staleAfterMinutes = settingsStale === null
    ? thresholds.staleAfterMinutes
    : Math.max(1, settingsStale);
  const collectedAtMs = timestampMs(usage.collected_at);
  const collectedAgeSeconds = collectedAtMs === null ? null : Math.max(0, Math.floor((now - collectedAtMs) / 1000));
  const healthStatus = normalizeStatus(health.status);
  const statusFetchError = String(raw.errors?.status || raw.statusFetchError || "").trim();
  const telemetryFetchError = String(raw.errors?.telemetry || raw.telemetryFetchError || "").trim();
  const explicitHealthError = Boolean(healthStatus && !["ok", "success", "healthy"].includes(healthStatus));
  const hasUsage = Boolean(usage.collected_at || usage.resets?.limite_5h?.found || usage.resets?.limite_semanal?.found);
  const collectionError = Boolean(statusFetchError || explicitHealthError);
  const collectionStale = !collectionError && collectedAgeSeconds !== null && collectedAgeSeconds > staleAfterMinutes * 60;
  const collectionMissing = !collectionError && !hasUsage;
  const fiveHourResetAtMs = timestampMs(fiveHour.reset_at);
  const weeklyResetAtMs = timestampMs(weekly.reset_at);
  const fiveHourPercent = finitePercent(fiveHour.remaining_percent);
  const weeklyPercent = finitePercent(weekly.remaining_percent);
  const claudeCollectedAtMs = timestampMs(claudeProvider.collected_at);
  const claudeSessionPercent = finitePercent(claudeSession.remaining_percent);
  const claudeWeeklyPercent = finitePercent(claudeWeekly.remaining_percent);
  const panelIdleSeconds = nonNegativeNumber(raw.panelIdleSeconds ?? raw.idleSeconds);
  const systemIdleSeconds = nonNegativeNumber(machine.system_idle_seconds);
  const globalLimitReached = usage.limit_reached === true || usage.allowed === false;
  let fiveHourLimitReached = fiveHour.limit_reached === true || fiveHour.allowed === false || fiveHourPercent === 0;
  let weeklyLimitReached = weekly.limit_reached === true || weekly.allowed === false || weeklyPercent === 0;
  if (globalLimitReached && !fiveHourLimitReached && !weeklyLimitReached) {
    const fiveHourAvailable = fiveHour.found === true || fiveHourPercent !== null;
    const weeklyAvailable = weekly.found === true || weeklyPercent !== null;
    if (fiveHourAvailable) fiveHourLimitReached = true;
    else if (weeklyAvailable) weeklyLimitReached = true;
  }
  const hour = clockHour(clock, now);

  return {
    kind: "sprite-context-v1",
    observedAt: now,
    codex: {
      fiveHourPercent,
      weeklyPercent,
      fiveHourResetAtMs,
      weeklyResetAtMs,
      fiveHourResetSeconds: secondsUntil(fiveHourResetAtMs, fiveHour.reset_after_seconds, now, collectedAtMs),
      weeklyResetSeconds: secondsUntil(weeklyResetAtMs, weekly.reset_after_seconds, now, collectedAtMs),
      fiveHourLimitReached,
      weeklyLimitReached,
      limitReached: globalLimitReached,
    },
    claude: {
      status: normalizeStatus(claudeProvider.state),
      collectedAtMs: claudeCollectedAtMs,
      sessionPercent: claudeSessionPercent,
      weeklyPercent: claudeWeeklyPercent,
      sessionResetSeconds: secondsUntil(timestampMs(claudeSession.reset_at), claudeSession.reset_after_seconds, now, claudeCollectedAtMs),
      weeklyResetSeconds: secondsUntil(timestampMs(claudeWeekly.reset_at), claudeWeekly.reset_after_seconds, now, claudeCollectedAtMs),
      sessionLimitReached: claudeSession.limit_reached === true || claudeSessionPercent === 0,
      weeklyLimitReached: claudeWeekly.limit_reached === true || claudeWeeklyPercent === 0,
    },
    machine: {
      status: normalizeStatus(machine.status),
      cpuPercent: finitePercent(machine.cpu_percent),
      memoryPercent: finitePercent(machine.memory_percent),
      diskPercent: finitePercent(machine.disk_percent),
      gpuPercent: finitePercent(machine.gpu_percent),
      gpuMemoryPercent: finitePercent(machine.gpu_memory_percent),
      systemIdleSeconds,
    },
    weather: {
      status: normalizeStatus(weather.status),
      temperatureC: finiteNumber(weather.temperature_c),
      apparentTemperatureC: finiteNumber(weather.apparent_temperature_c),
      code: finiteNumber(weather.weather_code),
      condition: String(weather.condition || "").trim(),
      location: String(weather.location || "").trim(),
      icon: String(weather.icon || "").trim(),
      raining: isRain(weather.weather_code, weather.condition),
    },
    clock: {
      iso: String(clock.iso || "").trim(),
      time: String(clock.time || "").trim(),
      date: String(clock.date || "").trim(),
      hour,
      period: dayPeriod(hour),
    },
    idleSeconds: panelIdleSeconds ?? systemIdleSeconds ?? 0,
    panelIdleSeconds,
    systemIdleSeconds,
    collection: {
      status: healthStatus || (hasUsage ? "unknown" : "waiting"),
      message: String(statusFetchError || health.message || "").trim(),
      collectedAtMs,
      ageSeconds: collectedAgeSeconds,
      staleAfterMinutes,
      error: collectionError,
      stale: collectionStale,
      missing: collectionMissing,
    },
    telemetry: {
      error: Boolean(telemetryFetchError),
      message: telemetryFetchError,
      machineUnavailable: ["error", "unavailable"].includes(normalizeStatus(machine.status)),
      weatherUnavailable: ["error", "stale"].includes(normalizeStatus(weather.status)),
    },
  };
}

export function formatCompactDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(finiteNumber(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}min` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function resetPhrase(seconds) {
  if (seconds === 0) return "Reset previsto para agora";
  return seconds !== null && seconds > 0 ? `Reset em ${formatCompactDuration(seconds)}` : "Reset ainda sem horário";
}

function reaction(values) {
  return {
    key: values.key,
    triggerId: values.triggerId || values.key,
    triggerName: values.triggerName || values.name || values.key,
    signature: values.signature || values.key,
    topic: values.topic || values.key,
    priority: values.priority || 0,
    anchor: values.anchor || null,
    state: SPRITE_STATES.includes(values.state) ? values.state : "talk",
    message: String(values.message || "").trim(),
    character: normalizeCharacterSelector(values.character),
    characterGroups: isPlainObject(values.characterGroups) ? { ...values.characterGroups } : {},
    characterMessages: isPlainObject(values.characterMessages) ? { ...values.characterMessages } : {},
    fallbackMessage: String(values.fallbackMessage || "").trim(),
    preventRepeat: values.preventRepeat !== false,
    repeatWhileActive: values.repeatWhileActive !== false,
    matchedValues: isPlainObject(values.matchedValues) ? { ...values.matchedValues } : {},
    source: values.source || "runtime",
    durationMs: values.durationMs ?? 4600,
    cooldownMs: values.cooldownMs ?? 60_000,
    persistent: Boolean(values.persistent),
    holdMs: Math.max(
      0,
      finiteNumber(values.holdMs) ?? (values.persistent ? 6000 : 0),
    ),
    transient: Boolean(values.transient),
  };
}

function codexReaction({ key, label, anchor, percent, resetSeconds, limitReached, priorityOffset, thresholds, cooldowns }) {
  const band = classifyCodexRemaining(percent, limitReached, thresholds);
  if (band === "invalid") return [];
  const rounded = Math.round(percent ?? 0);
  const resetSoon = resetSeconds !== null && resetSeconds > 0 && resetSeconds <= thresholds.resetSoonSeconds;
  const results = [];

  if (band === "critical") {
    const lead = limitReached ? `${label} atingido.` : `${label}: restam ${rounded}%.`;
    results.push(reaction({
      key: `${key}-critical`,
      signature: `${key}:critical:${limitReached}:${resetSoon}`,
      topic: key,
      priority: 110 - priorityOffset,
      anchor,
      state: "critical",
      message: `${lead} ${resetPhrase(resetSeconds)}.`,
      durationMs: 6200,
      cooldownMs: cooldowns.codexCritical,
      persistent: true,
    }));
    return results;
  }

  if (resetSoon) {
    results.push(reaction({
      key: `${key}-reset-soon`,
      signature: `${key}:reset-soon`,
      topic: `${key}-reset`,
      priority: 105 - priorityOffset,
      anchor,
      state: "celebrate",
      message: `${resetPhrase(resetSeconds)}. Quase lá!`,
      durationMs: 4800,
      cooldownMs: cooldowns.resetSoon,
    }));
  }

  if (band === "worried") {
    results.push(reaction({
      key: `${key}-worried`,
      signature: `${key}:worried`,
      topic: key,
      priority: 90 - priorityOffset,
      anchor,
      state: "worried",
      message: `${label}: ${rounded}% restantes. Vamos com calma.`,
      durationMs: 5400,
      cooldownMs: cooldowns.codexWorried,
    }));
  } else if (band === "visit") {
    results.push(reaction({
      key: `${key}-visit`,
      signature: `${key}:visit`,
      topic: key,
      priority: 65 - priorityOffset,
      anchor,
      state: "inspect",
      message: `${label} em ${rounded}%. Estou de olho.`,
      cooldownMs: cooldowns.codexVisit,
    }));
  }
  return results;
}

function dominantMetric(data, predicate) {
  const metrics = [
    { key: "CPU", value: data.cpuPercent },
    { key: "RAM", value: data.memoryPercent },
    { key: "disco", value: data.diskPercent },
  ].filter(metric => metric.value !== null && predicate(metric));
  return metrics.sort((a, b) => b.value - a.value)[0] || null;
}

export function sortReactions(reactions = []) {
  return [...reactions].sort((left, right) => right.priority - left.priority || left.key.localeCompare(right.key));
}

export const SPRITE_BEHAVIOR_OPERATORS = Object.freeze([">", ">=", "<", "<=", "==", "between"]);
const SPRITE_BEHAVIOR_EVENTS = Object.freeze([
  "user_return",
  "collection_error",
  "collection_stale",
  "collection_recovery",
  "value_change",
  "click",
  "drag",
  "random_interval",
]);

const REQUIRED_BEHAVIOR_CARDS = Object.freeze([
  "hora",
  "interacao",
  "temperatura",
  "maquina",
  "codex_5h",
  "codex_semanal",
  "claude_sessao",
  "claude_semanal",
]);

const REQUIRED_BEHAVIOR_CARD_SELECTORS = Object.freeze({
  hora: "#card-clock",
  interacao: "#card-idle",
  temperatura: "#card-weather",
  maquina: "#card-machine",
  codex_5h: "#card-five-hour",
  codex_semanal: "#card-weekly",
  claude_sessao: "#card-claude-session",
  claude_semanal: "#card-claude-weekly",
});

const SPRITE_MACRO_TYPES = Object.freeze(["string", "number", "boolean", "datetime", "duration"]);

const REQUIRED_BEHAVIOR_MACROS = Object.freeze([
  "hora",
  "data",
  "tempo_sem_interacao",
  "temperatura",
  "clima",
  "cpu",
  "ram",
  "disco",
  "gpu",
  "gpu_memoria",
  "codex_5h_percentual",
  "codex_5h_reset",
  "codex_semanal_percentual",
  "codex_semanal_reset",
  "claude_status",
  "claude_ultima_atualizacao",
  "claude_session_percentual",
  "claude_session_reset",
  "claude_weekly_percentual",
  "claude_weekly_reset",
  "coleta_status",
  "ultima_atualizacao",
]);

const DEFAULT_MACRO_SPECS = Object.freeze({
  hora: { token: "{{hora}}", sourcePath: "clock.time", type: "string", unit: "", fallback: "horário indisponível" },
  data: { token: "{{data}}", sourcePath: "clock.date", type: "string", unit: "", fallback: "data indisponível" },
  tempo_sem_interacao: { token: "{{tempo_sem_interacao}}", sourcePath: "idleSeconds", type: "duration", unit: "s", fallback: "tempo indisponível" },
  temperatura: { token: "{{temperatura}}", sourcePath: "weather.temperatureC", type: "number", unit: "°C", fallback: "temperatura indisponível" },
  clima: { token: "{{clima}}", sourcePath: "weather.condition", type: "string", unit: "", fallback: "clima indisponível" },
  cpu: { token: "{{cpu}}", sourcePath: "machine.cpuPercent", type: "number", unit: "%", fallback: "CPU indisponível" },
  ram: { token: "{{ram}}", sourcePath: "machine.memoryPercent", type: "number", unit: "%", fallback: "RAM indisponível" },
  disco: { token: "{{disco}}", sourcePath: "machine.diskPercent", type: "number", unit: "%", fallback: "disco indisponível" },
  gpu: { token: "{{gpu}}", sourcePath: "machine.gpuPercent", type: "number", unit: "%", fallback: "GPU indisponível" },
  gpu_memoria: { token: "{{gpu_memoria}}", sourcePath: "machine.gpuMemoryPercent", type: "number", unit: "%", fallback: "memória da GPU indisponível" },
  codex_5h_percentual: { token: "{{codex_5h_percentual}}", sourcePath: "codex.fiveHourPercent", type: "number", unit: "%", fallback: "limite de 5h indisponível" },
  codex_5h_reset: { token: "{{codex_5h_reset}}", sourcePath: "codex.fiveHourResetSeconds", type: "duration", unit: "s", fallback: "reset de 5h indisponível" },
  codex_semanal_percentual: { token: "{{codex_semanal_percentual}}", sourcePath: "codex.weeklyPercent", type: "number", unit: "%", fallback: "limite semanal indisponível" },
  codex_semanal_reset: { token: "{{codex_semanal_reset}}", sourcePath: "codex.weeklyResetSeconds", type: "duration", unit: "s", fallback: "reset semanal indisponível" },
  claude_status: { token: "{{claude_status}}", sourcePath: "claude.status", type: "string", unit: "", fallback: "indisponível" },
  claude_ultima_atualizacao: { token: "{{claude_ultima_atualizacao}}", sourcePath: "claude.collectedAtMs", type: "datetime", unit: "", fallback: "atualização indisponível" },
  claude_session_percentual: { token: "{{claude_session_percentual}}", sourcePath: "claude.sessionPercent", type: "number", unit: "%", fallback: "sessão indisponível" },
  claude_session_reset: { token: "{{claude_session_reset}}", sourcePath: "claude.sessionResetSeconds", type: "duration", unit: "s", fallback: "reset indisponível" },
  claude_session_limite_atingido: { token: "{{claude_session_limite_atingido}}", sourcePath: "claude.sessionLimitReached", type: "boolean", unit: "", fallback: false },
  claude_weekly_percentual: { token: "{{claude_weekly_percentual}}", sourcePath: "claude.weeklyPercent", type: "number", unit: "%", fallback: "semanal indisponível" },
  claude_weekly_reset: { token: "{{claude_weekly_reset}}", sourcePath: "claude.weeklyResetSeconds", type: "duration", unit: "s", fallback: "reset indisponível" },
  claude_weekly_limite_atingido: { token: "{{claude_weekly_limite_atingido}}", sourcePath: "claude.weeklyLimitReached", type: "boolean", unit: "", fallback: false },
  coleta_status: { token: "{{coleta_status}}", sourcePath: "collection.status", type: "string", unit: "", fallback: "status indisponível" },
  ultima_atualizacao: { token: "{{ultima_atualizacao}}", sourcePath: "collection.collectedAtMs", type: "datetime", unit: "", fallback: "atualização indisponível" },
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getByPath(value, path) {
  if (!path) return undefined;
  return String(path).split(".").reduce((current, key) => current?.[key], value);
}

function configIssue(path, code, message) {
  return { path, code, message };
}

function validateAllowedProperties(value, allowed, path, errors) {
  if (!isPlainObject(value)) return;
  const allowedSet = new Set(allowed);
  Object.keys(value).forEach(key => {
    if (!allowedSet.has(key)) errors.push(configIssue(`${path}.${key}`, "unknown_property", `Propriedade não prevista pelo schema: ${key}.`));
  });
}

function validateNonNegativeRange(value, path, errors) {
  if (!isPlainObject(value)) {
    errors.push(configIssue(path, "invalid_range", "O intervalo deve conter min e max."));
    return false;
  }
  validateAllowedProperties(value, ["min", "max"], path, errors);
  const minimum = typeof value.min === "number" && Number.isFinite(value.min) ? value.min : null;
  const maximum = typeof value.max === "number" && Number.isFinite(value.max) ? value.max : null;
  if (minimum === null || maximum === null || minimum < 0 || maximum < minimum) {
    errors.push(configIssue(path, "invalid_range", "min/max devem ser números não negativos e max deve ser maior ou igual a min."));
    return false;
  }
  return true;
}

function validateBoundedNumber(value, path, errors, { minimum = 0, maximum = Number.POSITIVE_INFINITY, integer = false } = {}) {
  const number = typeof value === "number" && Number.isFinite(value) ? value : null;
  if (number === null || number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    errors.push(configIssue(path, "invalid_number", `Valor deve estar entre ${minimum} e ${maximum}.`));
    return false;
  }
  return true;
}

function validateWhenNode(node, path, errors) {
  if (!isPlainObject(node)) {
    errors.push(configIssue(path, "invalid_condition", "A condição deve ser um objeto."));
    return;
  }
  const branches = ["all", "any"].filter(key => key in node);
  const conditionKinds = branches.length
    + Number("metric" in node)
    + Number("event" in node)
    + Number("timeRange" in node);
  if (conditionKinds !== 1) {
    errors.push(configIssue(path, "ambiguous_condition", "Cada condição deve usar exatamente um de metric, event, timeRange, all ou any."));
  }
  if (branches.length === 1 && conditionKinds === 1) validateAllowedProperties(node, [branches[0]], path, errors);
  branches.forEach(key => {
    if (!Array.isArray(node[key]) || !node[key].length) {
      errors.push(configIssue(`${path}.${key}`, "empty_condition_group", `${key} deve conter ao menos uma condição.`));
    } else {
      node[key].forEach((child, index) => validateWhenNode(child, `${path}.${key}[${index}]`, errors));
    }
  });
  if ("metric" in node) {
    validateAllowedProperties(node, ["metric", "operator", "value"], path, errors);
    if (typeof node.metric !== "string" || !node.metric.trim()) {
      errors.push(configIssue(`${path}.metric`, "invalid_metric", "metric deve ser uma string não vazia."));
    }
    if (!SPRITE_BEHAVIOR_OPERATORS.includes(node.operator)) {
      errors.push(configIssue(`${path}.operator`, "invalid_operator", `Operador não suportado: ${node.operator}.`));
    }
    if (node.operator === "between" && (!Array.isArray(node.value) || node.value.length !== 2)) {
      errors.push(configIssue(`${path}.value`, "invalid_between", "between requer um array com dois limites."));
    } else if (node.operator === "between" && node.value.some(value => finiteNumber(value) === null)) {
      errors.push(configIssue(`${path}.value`, "invalid_between", "Os limites de between devem ser numéricos."));
    } else if (!("value" in node)) {
      errors.push(configIssue(`${path}.value`, "missing_comparison_value", "A comparação requer value."));
    }
  }
  if ("event" in node) {
    validateAllowedProperties(node, ["event"], path, errors);
    const event = node.event;
    if (!isPlainObject(event) || typeof event.type !== "string" || !event.type.trim()) {
      errors.push(configIssue(`${path}.event`, "invalid_event", "event requer um objeto com type."));
    } else if (!SPRITE_BEHAVIOR_EVENTS.includes(event.type)) {
      errors.push(configIssue(`${path}.event.type`, "unknown_event", `Evento não suportado: ${event.type}.`));
    } else {
      validateAllowedProperties(event, ["type", "metric", "card", "phase", "minDelta", "minIntervalSeconds", "intervalSeconds"], `${path}.event`, errors);
      if (event.type === "value_change" && (typeof event.metric !== "string" || !event.metric.trim())) {
        errors.push(configIssue(`${path}.event.metric`, "missing_event_metric", "value_change requer metric."));
      }
      if (event.type === "click" && (typeof event.card !== "string" || !event.card.trim())) {
        errors.push(configIssue(`${path}.event.card`, "missing_event_card", "click requer card."));
      }
      if (event.type === "drag" && event.phase && !["start", "move", "end"].includes(event.phase)) {
        errors.push(configIssue(`${path}.event.phase`, "invalid_event_phase", "phase de drag deve ser start, move ou end."));
      }
      if (event.type === "random_interval") validateNonNegativeRange(event.intervalSeconds, `${path}.event.intervalSeconds`, errors);
      ["minDelta", "minIntervalSeconds"].forEach(field => {
        if (event[field] !== undefined) validateBoundedNumber(event[field], `${path}.event.${field}`, errors);
      });
    }
  }
  if ("timeRange" in node) {
    validateAllowedProperties(node, ["timeRange"], path, errors);
    const range = node.timeRange;
    if (!isPlainObject(range) || minutesOfDay(range.start) === null || minutesOfDay(range.end) === null) {
      errors.push(configIssue(`${path}.timeRange`, "invalid_time_range", "timeRange requer start/end no formato HH:MM."));
    } else if (range.days !== undefined && (!Array.isArray(range.days)
      || !range.days.length
      || range.days.some(day => !["mon", "tue", "wed", "thu", "fri", "sat", "sun"].includes(day)))) {
      errors.push(configIssue(`${path}.timeRange.days`, "invalid_days", "days contém um dia inválido."));
    }
    if (isPlainObject(range)) validateAllowedProperties(range, ["start", "end", "days"], `${path}.timeRange`, errors);
  }
  if (!branches.length && !("metric" in node) && !("event" in node) && !("timeRange" in node)) {
    errors.push(configIssue(path, "unknown_condition", "A condição precisa de metric, event, timeRange, all ou any."));
  }
}

export function validateSpriteBehaviorConfig(raw) {
  const errors = [];
  const warnings = [];
  if (!isPlainObject(raw)) {
    return { ok: false, valid: false, errors: [configIssue("$", "invalid_root", "A configuração deve ser um objeto JSON.")], warnings };
  }
  if (raw.$schema !== "./sprite-behaviors.schema.json") {
    errors.push(configIssue("$.$schema", "invalid_schema_reference", "$schema deve apontar para ./sprite-behaviors.schema.json."));
  }
  const allowedTopLevel = new Set(["$schema", "metadata", "macros", "cards", "defaultBehavior", "characterGroups", "phrases", "triggers"]);
  Object.keys(raw).forEach(key => {
    if (!allowedTopLevel.has(key)) errors.push(configIssue(`$.${key}`, "unknown_property", `Propriedade não prevista pelo schema: ${key}.`));
  });
  ["metadata", "macros", "cards", "defaultBehavior"].forEach(key => {
    if (!isPlainObject(raw[key])) errors.push(configIssue(`$.${key}`, "missing_object", `${key} deve ser um objeto.`));
  });
  ["phrases", "triggers"].forEach(key => {
    if (!Array.isArray(raw[key]) || !raw[key].length) errors.push(configIssue(`$.${key}`, "missing_array", `${key} deve ser um array não vazio.`));
  });
  if (raw.characterGroups !== undefined) {
    if (!isPlainObject(raw.characterGroups)) {
      errors.push(configIssue("$.characterGroups", "invalid_character_groups", "characterGroups deve ser um objeto."));
    } else {
      Object.entries(raw.characterGroups).forEach(([group, selectors]) => {
        if (!/^[a-z][a-z0-9_-]{1,63}$/.test(group) || !Array.isArray(selectors) || !selectors.length) {
          errors.push(configIssue(`$.characterGroups.${group}`, "invalid_character_group", "Grupo de personagens inválido ou vazio."));
          return;
        }
        selectors.forEach((selector, index) => {
          if (!validateCharacterSelector(selector).valid) {
            errors.push(configIssue(`$.characterGroups.${group}[${index}]`, "invalid_character", "Seletor de grupo inválido."));
          }
        });
      });
    }
  }
  if (isPlainObject(raw.metadata)) {
    validateAllowedProperties(raw.metadata, ["id", "version", "schemaVersion", "locale", "description"], "$.metadata", errors);
    ["id", "version", "schemaVersion", "locale", "description"].forEach(field => {
      if (typeof raw.metadata[field] !== "string" || !raw.metadata[field].trim()) {
        errors.push(configIssue(`$.metadata.${field}`, "invalid_metadata", `${field} é obrigatório nos metadados.`));
      }
    });
    ["version", "schemaVersion"].forEach(field => {
      if (raw.metadata[field] && !/^\d+\.\d+\.\d+$/.test(raw.metadata[field])) {
        errors.push(configIssue(`$.metadata.${field}`, "invalid_version", `${field} deve usar versão semântica.`));
      }
    });
    if (raw.metadata.locale && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(raw.metadata.locale)) {
      errors.push(configIssue("$.metadata.locale", "invalid_locale", "locale deve usar formato pt-BR."));
    }
    if (raw.metadata.id && !/^[a-z0-9][a-z0-9-]*$/.test(raw.metadata.id)) {
      errors.push(configIssue("$.metadata.id", "invalid_metadata_id", "id dos metadados deve usar letras minúsculas, números e hífen."));
    }
  }
  if (isPlainObject(raw.cards)) {
    validateAllowedProperties(raw.cards, [...REQUIRED_BEHAVIOR_CARDS, "status"], "$.cards", errors);
    REQUIRED_BEHAVIOR_CARDS.forEach(key => {
      if (typeof raw.cards[key] !== "string" || !raw.cards[key].trim()) {
        errors.push(configIssue(`$.cards.${key}`, "missing_card", `Seletor obrigatório ausente para ${key}.`));
      } else if (raw.cards[key] !== REQUIRED_BEHAVIOR_CARD_SELECTORS[key]) {
        errors.push(configIssue(`$.cards.${key}`, "invalid_card_selector", `O seletor esperado é ${REQUIRED_BEHAVIOR_CARD_SELECTORS[key]}.`));
      }
    });
    Object.entries(raw.cards).forEach(([key, selector]) => {
      if (typeof selector !== "string" || !/^#[A-Za-z][A-Za-z0-9_-]*$/.test(selector)) {
        errors.push(configIssue(`$.cards.${key}`, "invalid_card_selector", "Cada card deve usar um seletor de id seguro."));
      }
    });
  }
  if (isPlainObject(raw.macros)) {
    REQUIRED_BEHAVIOR_MACROS.forEach(key => {
      if (!isPlainObject(raw.macros[key])) {
        errors.push(configIssue(`$.macros.${key}`, "missing_macro", `Macro obrigatória ausente: ${key}.`));
      }
    });
    Object.entries(raw.macros).forEach(([key, macro]) => {
      if (!/^[a-z][a-z0-9_]*$/.test(key) || !isPlainObject(macro)) {
        errors.push(configIssue(`$.macros.${key}`, "invalid_macro", `Definição inválida para a macro ${key}.`));
        return;
      }
      validateAllowedProperties(macro, ["token", "origin", "sourcePath", "type", "unit", "fallback", "description"], `$.macros.${key}`, errors);
      ["token", "origin", "sourcePath", "type", "description"].forEach(field => {
        if (typeof macro[field] !== "string" || !macro[field].trim()) {
          errors.push(configIssue(`$.macros.${key}.${field}`, "invalid_macro_field", `${field} deve ser uma string não vazia.`));
        }
      });
      if (macro.token !== `{{${key}}}`) {
        errors.push(configIssue(`$.macros.${key}.token`, "invalid_macro_token", `O token esperado é {{${key}}}.`));
      }
      if (!/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(macro.sourcePath || "")) {
        errors.push(configIssue(`$.macros.${key}.sourcePath`, "invalid_source_path", "sourcePath deve ser um caminho de propriedades seguro."));
      }
      if (!SPRITE_MACRO_TYPES.includes(macro.type)) {
        errors.push(configIssue(`$.macros.${key}.type`, "invalid_macro_type", `Tipo de macro não suportado: ${macro.type}.`));
      }
      if (typeof macro.unit !== "string") errors.push(configIssue(`$.macros.${key}.unit`, "invalid_macro_unit", "unit deve ser uma string."));
      if (!("fallback" in macro)) errors.push(configIssue(`$.macros.${key}.fallback`, "missing_fallback", "Toda macro precisa de fallback."));
      else if (macro.fallback !== null && !["string", "number", "boolean"].includes(typeof macro.fallback)) {
        errors.push(configIssue(`$.macros.${key}.fallback`, "invalid_fallback", "fallback deve ser string, número, booleano ou null."));
      }
    });
  }
  if (isPlainObject(raw.defaultBehavior)) {
    const behavior = raw.defaultBehavior;
    validateAllowedProperties(behavior, [
      "enabled", "initialState", "speed", "reactionDurationSeconds", "walkDurationSeconds",
      "restDurationSeconds", "actionIntervalSeconds", "allowedDestinations", "casualSpeech",
      "features", "coordination", "motion",
    ], "$.defaultBehavior", errors);
    if (typeof behavior.enabled !== "boolean") errors.push(configIssue("$.defaultBehavior.enabled", "invalid_boolean", "enabled deve ser booleano."));
    if (!SPRITE_STATES.includes(behavior.initialState)) errors.push(configIssue("$.defaultBehavior.initialState", "invalid_state", "initialState não é um estado de sprite válido."));
    validateBoundedNumber(behavior.speed, "$.defaultBehavior.speed", errors, { maximum: 400 });
    validateBoundedNumber(behavior.reactionDurationSeconds, "$.defaultBehavior.reactionDurationSeconds", errors, { maximum: 120 });
    ["walkDurationSeconds", "restDurationSeconds", "actionIntervalSeconds"].forEach(field => {
      validateNonNegativeRange(behavior[field], `$.defaultBehavior.${field}`, errors);
    });
    if (!Array.isArray(behavior.allowedDestinations) || !behavior.allowedDestinations.length) {
      errors.push(configIssue("$.defaultBehavior.allowedDestinations", "invalid_destinations", "allowedDestinations deve conter ao menos um card."));
    } else {
      if (new Set(behavior.allowedDestinations).size !== behavior.allowedDestinations.length) {
        errors.push(configIssue("$.defaultBehavior.allowedDestinations", "duplicate_destination", "allowedDestinations não pode repetir cards."));
      }
      behavior.allowedDestinations.forEach((destination, index) => {
        if (!raw.cards?.[destination]) errors.push(configIssue(`$.defaultBehavior.allowedDestinations[${index}]`, "unknown_card", `Destino não configurado: ${destination}.`));
      });
    }

    const casual = behavior.casualSpeech;
    if (!isPlainObject(casual)) {
      errors.push(configIssue("$.defaultBehavior.casualSpeech", "missing_object", "casualSpeech deve ser um objeto."));
    } else {
      validateAllowedProperties(casual, ["enabled", "intervalSeconds", "phraseIds"], "$.defaultBehavior.casualSpeech", errors);
      if (typeof casual.enabled !== "boolean") errors.push(configIssue("$.defaultBehavior.casualSpeech.enabled", "invalid_boolean", "enabled deve ser booleano."));
      validateNonNegativeRange(casual.intervalSeconds, "$.defaultBehavior.casualSpeech.intervalSeconds", errors);
      if (!Array.isArray(casual.phraseIds) || !casual.phraseIds.length || casual.phraseIds.some(id => typeof id !== "string" || !id)) {
        errors.push(configIssue("$.defaultBehavior.casualSpeech.phraseIds", "invalid_phrase_refs", "phraseIds deve conter IDs de falas."));
      } else if (new Set(casual.phraseIds).size !== casual.phraseIds.length) {
        errors.push(configIssue("$.defaultBehavior.casualSpeech.phraseIds", "duplicate_phrase_ref", "phraseIds não pode repetir IDs."));
      }
    }

    const features = behavior.features;
    if (!isPlainObject(features)) {
      errors.push(configIssue("$.defaultBehavior.features", "missing_object", "features deve ser um objeto."));
    } else {
      validateAllowedProperties(features, ["reactions", "movement", "speech"], "$.defaultBehavior.features", errors);
      ["reactions", "movement", "speech"].forEach(field => {
        if (typeof features[field] !== "boolean") errors.push(configIssue(`$.defaultBehavior.features.${field}`, "invalid_boolean", `${field} deve ser booleano.`));
      });
    }

    const coordination = behavior.coordination;
    if (!isPlainObject(coordination)) {
      errors.push(configIssue("$.defaultBehavior.coordination", "missing_object", "coordination deve ser um objeto."));
    } else {
      validateAllowedProperties(coordination, ["maxConcurrentReactions", "duplicatePhraseWindowSeconds", "minimumSpriteGapPixels"], "$.defaultBehavior.coordination", errors);
      validateBoundedNumber(coordination.maxConcurrentReactions, "$.defaultBehavior.coordination.maxConcurrentReactions", errors, { minimum: 1, maximum: 3, integer: true });
      validateBoundedNumber(coordination.duplicatePhraseWindowSeconds, "$.defaultBehavior.coordination.duplicatePhraseWindowSeconds", errors);
      validateBoundedNumber(coordination.minimumSpriteGapPixels, "$.defaultBehavior.coordination.minimumSpriteGapPixels", errors);
    }

    const motion = behavior.motion;
    if (!isPlainObject(motion)) {
      errors.push(configIssue("$.defaultBehavior.motion", "missing_object", "motion deve ser um objeto."));
    } else {
      validateAllowedProperties(motion, ["returnToFreeRoam", "avoidCollisions", "respectViewport", "preserveDrag", "safePlacement", "reducedMotion"], "$.defaultBehavior.motion", errors);
      ["returnToFreeRoam", "avoidCollisions", "respectViewport", "preserveDrag"].forEach(field => {
        if (typeof motion[field] !== "boolean") errors.push(configIssue(`$.defaultBehavior.motion.${field}`, "invalid_boolean", `${field} deve ser booleano.`));
      });
      if (!["card-edge", "safe-area"].includes(motion.safePlacement)) {
        errors.push(configIssue("$.defaultBehavior.motion.safePlacement", "invalid_safe_placement", "safePlacement deve ser card-edge ou safe-area."));
      }
      if (!isPlainObject(motion.reducedMotion)) {
        errors.push(configIssue("$.defaultBehavior.motion.reducedMotion", "missing_object", "reducedMotion deve ser um objeto."));
      } else {
        validateAllowedProperties(motion.reducedMotion, ["honorPreference", "disableWalking", "reactionDurationSeconds"], "$.defaultBehavior.motion.reducedMotion", errors);
        ["honorPreference", "disableWalking"].forEach(field => {
          if (typeof motion.reducedMotion[field] !== "boolean") errors.push(configIssue(`$.defaultBehavior.motion.reducedMotion.${field}`, "invalid_boolean", `${field} deve ser booleano.`));
        });
        validateBoundedNumber(motion.reducedMotion.reactionDurationSeconds, "$.defaultBehavior.motion.reducedMotion.reactionDurationSeconds", errors, { maximum: 120 });
      }
    }
  }
  const validatePhraseMacros = (text, path) => {
    if (typeof text !== "string" || !isPlainObject(raw.macros)) return;
    const tokenLikeValues = text.match(/{{[^{}]*}}/g) || [];
    tokenLikeValues.forEach(token => {
      if (!/^{{\s*[a-z][a-z0-9_]*\s*}}$/.test(token)) {
        errors.push(configIssue(path, "malformed_macro", `Macro malformada: ${token}.`));
      }
    });
    const opens = (text.match(/{{/g) || []).length;
    const closes = (text.match(/}}/g) || []).length;
    if (opens !== closes) errors.push(configIssue(path, "malformed_macro", "A fala possui chaves de macro desbalanceadas."));
    for (const match of text.matchAll(/{{\s*([\w_]+)\s*}}/g)) {
      if (!raw.macros[match[1]]) {
        errors.push(configIssue(path, "unknown_macro", `Macro não declarada: ${match[1]}.`));
      }
    }
  };
  const phraseIds = new Set();
  if (Array.isArray(raw.phrases)) {
    raw.phrases.forEach((phrase, index) => {
      if (!isPlainObject(phrase) || typeof phrase.id !== "string" || !phrase.id.trim()) {
        errors.push(configIssue(`$.phrases[${index}]`, "invalid_phrase", "Cada grupo de falas requer id."));
        return;
      }
      validateAllowedProperties(phrase, ["id", "texts", "weight"], `$.phrases[${index}]`, errors);
      if (phraseIds.has(phrase.id)) errors.push(configIssue(`$.phrases[${index}].id`, "duplicate_id", `ID duplicado: ${phrase.id}.`));
      phraseIds.add(phrase.id);
      if (!/^[a-z][a-z0-9_]*$/.test(phrase.id)) errors.push(configIssue(`$.phrases[${index}].id`, "invalid_id", "ID de fala inválido."));
      if (!Array.isArray(phrase.texts)
        || !phrase.texts.length
        || !phrase.texts.every(text => typeof text === "string" && text.length >= 1 && text.length <= 160)) {
        errors.push(configIssue(`$.phrases[${index}].texts`, "invalid_phrase_texts", "texts deve ser um array de strings."));
      } else {
        if (new Set(phrase.texts).size !== phrase.texts.length) errors.push(configIssue(`$.phrases[${index}].texts`, "duplicate_phrase", "Um grupo não pode repetir a mesma fala."));
        phrase.texts.forEach((text, textIndex) => validatePhraseMacros(text, `$.phrases[${index}].texts[${textIndex}]`));
      }
      if (phrase.weight !== undefined && (finiteNumber(phrase.weight) === null || Number(phrase.weight) <= 0)) {
        errors.push(configIssue(`$.phrases[${index}].weight`, "invalid_weight", "weight deve ser maior que zero."));
      }
    });
  }
  (Array.isArray(raw.defaultBehavior?.casualSpeech?.phraseIds) ? raw.defaultBehavior.casualSpeech.phraseIds : []).forEach((id, index) => {
    if (!phraseIds.has(id)) errors.push(configIssue(`$.defaultBehavior.casualSpeech.phraseIds[${index}]`, "unknown_phrase_ref", `Grupo de falas não encontrado: ${id}.`));
  });
  if (Array.isArray(raw.triggers)) {
    const ids = new Set();
    raw.triggers.forEach((trigger, index) => {
      const path = `$.triggers[${index}]`;
      if (!isPlainObject(trigger) || typeof trigger.id !== "string" || !trigger.id.trim()) {
        errors.push(configIssue(path, "invalid_trigger", "Cada gatilho requer id."));
        return;
      }
      validateAllowedProperties(trigger, [
        "id", "name", "enabled", "when", "targetCard", "spriteState", "character", "topic",
        "phrases", "phraseRefs", "characterPhrases", "fallbackPhrase", "preventRepeat",
        "priority", "cooldownSeconds", "durationSeconds", "persistent", "repeatWhileActive", "holdSeconds",
      ], path, errors);
      if (ids.has(trigger.id)) errors.push(configIssue(`${path}.id`, "duplicate_id", `ID duplicado: ${trigger.id}.`));
      ids.add(trigger.id);
      if (trigger.name !== undefined && (typeof trigger.name !== "string" || !trigger.name.trim() || trigger.name.length > 80)) {
        errors.push(configIssue(`${path}.name`, "invalid_name", "name deve ter entre 1 e 80 caracteres."));
      }
      if (trigger.character !== undefined && !validateCharacterSelector(trigger.character).valid) {
        errors.push(configIssue(`${path}.character`, "invalid_character", "Seletor de personagem inválido."));
      }
      if (trigger.topic !== undefined && (typeof trigger.topic !== "string" || !/^[a-z][a-z0-9_]*$/.test(trigger.topic))) {
        errors.push(configIssue(`${path}.topic`, "invalid_id", "topic deve usar um identificador seguro."));
      }
      if (!/^[a-z][a-z0-9_]*$/.test(trigger.id)) errors.push(configIssue(`${path}.id`, "invalid_id", "ID de gatilho inválido."));
      if (typeof trigger.enabled !== "boolean") errors.push(configIssue(`${path}.enabled`, "invalid_boolean", "enabled deve ser booleano."));
      validateWhenNode(trigger.when, `${path}.when`, errors);
      if (!SPRITE_STATES.includes(trigger.spriteState)) {
        errors.push(configIssue(`${path}.spriteState`, "invalid_state", `Estado desconhecido: ${trigger.spriteState}.`));
      }
      if (typeof trigger.targetCard !== "string" || !raw.cards?.[trigger.targetCard]) {
        errors.push(configIssue(`${path}.targetCard`, "unknown_card", `Card não configurado: ${trigger.targetCard}.`));
      }
      const characterPhrasesValid = isPlainObject(trigger.characterPhrases)
        && Object.keys(trigger.characterPhrases).length > 0
        && Object.entries(trigger.characterPhrases).every(([character, texts]) => (
          /^[a-z][a-z0-9_-]{1,63}$/.test(character)
          && Array.isArray(texts)
          && texts.length
          && texts.every(text => typeof text === "string" && text.length >= 1 && text.length <= 160)
        ));
      const fallbackValid = typeof trigger.fallbackPhrase === "string"
        && trigger.fallbackPhrase.length >= 1
        && trigger.fallbackPhrase.length <= 160;
      if ((!Array.isArray(trigger.phrases) || !trigger.phrases.length || !trigger.phrases.every(text => typeof text === "string" && text.length >= 1 && text.length <= 160))
        && (!Array.isArray(trigger.phraseRefs) || !trigger.phraseRefs.length || !trigger.phraseRefs.every(id => typeof id === "string"))
        && !characterPhrasesValid
        && !fallbackValid) {
        errors.push(configIssue(`${path}.phrases`, "missing_trigger_phrase", "Gatilho requer phrases, phraseRefs, falas por personagem ou fallback."));
      }
      if (Array.isArray(trigger.phrases) && new Set(trigger.phrases).size !== trigger.phrases.length) errors.push(configIssue(`${path}.phrases`, "duplicate_phrase", "Gatilho não pode repetir falas."));
      if (Array.isArray(trigger.phraseRefs) && new Set(trigger.phraseRefs).size !== trigger.phraseRefs.length) errors.push(configIssue(`${path}.phraseRefs`, "duplicate_phrase_ref", "Gatilho não pode repetir phraseRefs."));
      (Array.isArray(trigger.phrases) ? trigger.phrases : []).forEach((text, textIndex) => validatePhraseMacros(text, `${path}.phrases[${textIndex}]`));
      if (trigger.characterPhrases !== undefined && !characterPhrasesValid) {
        errors.push(configIssue(`${path}.characterPhrases`, "invalid_character_phrases", "Falas por personagem devem usar personagens conhecidos e textos válidos."));
      }
      Object.entries(isPlainObject(trigger.characterPhrases) ? trigger.characterPhrases : {}).forEach(([character, texts]) => {
        if (new Set(texts || []).size !== (texts || []).length) errors.push(configIssue(`${path}.characterPhrases.${character}`, "duplicate_phrase", "O personagem não pode repetir a mesma fala."));
        (texts || []).forEach((text, textIndex) => validatePhraseMacros(text, `${path}.characterPhrases.${character}[${textIndex}]`));
      });
      if (trigger.fallbackPhrase !== undefined) {
        if (!fallbackValid) errors.push(configIssue(`${path}.fallbackPhrase`, "invalid_phrase_texts", "fallbackPhrase deve ser uma fala válida."));
        else validatePhraseMacros(trigger.fallbackPhrase, `${path}.fallbackPhrase`);
      }
      (Array.isArray(trigger.phraseRefs) ? trigger.phraseRefs : []).forEach((id, referenceIndex) => {
        if (!phraseIds.has(id)) errors.push(configIssue(`${path}.phraseRefs[${referenceIndex}]`, "unknown_phrase_ref", `Grupo de falas não encontrado: ${id}.`));
      });
      validateBoundedNumber(trigger.priority, `${path}.priority`, errors, { maximum: 1000, integer: true });
      validateBoundedNumber(trigger.cooldownSeconds, `${path}.cooldownSeconds`, errors);
      if (trigger.durationSeconds !== undefined) validateBoundedNumber(trigger.durationSeconds, `${path}.durationSeconds`, errors, { maximum: 120 });
      if (trigger.holdSeconds !== undefined) validateBoundedNumber(trigger.holdSeconds, `${path}.holdSeconds`, errors, { maximum: 120 });
      if (trigger.persistent !== undefined && typeof trigger.persistent !== "boolean") errors.push(configIssue(`${path}.persistent`, "invalid_boolean", "persistent deve ser booleano."));
      if (trigger.repeatWhileActive !== undefined && typeof trigger.repeatWhileActive !== "boolean") errors.push(configIssue(`${path}.repeatWhileActive`, "invalid_boolean", "repeatWhileActive deve ser booleano."));
      if (trigger.preventRepeat !== undefined && typeof trigger.preventRepeat !== "boolean") errors.push(configIssue(`${path}.preventRepeat`, "invalid_boolean", "preventRepeat deve ser booleano."));
    });
  }
  const valid = errors.length === 0;
  return { ok: valid, valid, errors, warnings };
}

export const validateBehaviorConfig = validateSpriteBehaviorConfig;

export function compileSpriteBehaviorConfig(raw) {
  const migrated = migrateCharacterSelectors(raw).config;
  const report = validateSpriteBehaviorConfig(migrated);
  if (!report.valid) return { ...report, config: null };
  const phrasesById = Object.fromEntries((migrated.phrases || []).map(group => [group.id, [...group.texts]]));
  const config = {
    ...migrated,
    metadata: { ...migrated.metadata },
    macros: { ...migrated.macros },
    cards: { ...migrated.cards },
    defaultBehavior: { ...migrated.defaultBehavior },
    phrases: [...migrated.phrases],
    triggers: [...migrated.triggers],
    _compiled: { phrasesById },
  };
  return { ...report, config };
}

export const compileBehaviorConfig = compileSpriteBehaviorConfig;

export async function loadSpriteBehaviorConfig(url = "./config/sprite-behaviors.json", options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const issues = [];
  try {
    if (typeof fetchImpl !== "function") throw new Error("fetch indisponível");
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "?"}`);
    const raw = await response.json();
    const compiled = compileSpriteBehaviorConfig(raw);
    if (compiled.valid) return { ...compiled, source: "file", usingFallback: false, issues: [] };
    issues.push(...compiled.errors);
  } catch (error) {
    issues.push(configIssue("$", "load_failed", `Não foi possível carregar ${url}: ${error.message}`));
  }
  for (const [source, candidate] of [["previous", options.previousConfig], ["fallback", options.fallbackConfig]]) {
    if (!candidate) continue;
    const compiled = compileSpriteBehaviorConfig(candidate);
    if (compiled.valid) return { ...compiled, source, usingFallback: true, issues };
    issues.push(...compiled.errors);
  }
  return { ok: false, valid: false, config: null, source: "legacy", usingFallback: true, errors: issues, warnings: [], issues };
}

export const loadBehaviorConfig = loadSpriteBehaviorConfig;

function formatMacroValue(spec, raw) {
  if (raw === null || raw === undefined || raw === "" || (typeof raw === "number" && !Number.isFinite(raw))) {
    return String(spec.fallback ?? "--");
  }
  if (spec.type === "duration") return formatCompactDuration(raw);
  if (spec.type === "datetime") {
    const milliseconds = timestampMs(raw);
    return milliseconds === null ? String(spec.fallback ?? "--") : new Date(milliseconds).toLocaleString("pt-BR");
  }
  if (spec.type === "boolean") return raw === true ? "sim" : raw === false ? "não" : String(spec.fallback ?? "--");
  if (spec.type === "number" || spec.type === "percent") {
    const number = finiteNumber(raw);
    if (number === null) return String(spec.fallback ?? "--");
    return Number.isInteger(number) ? String(number) : number.toFixed(Number.isInteger(spec.decimals) ? spec.decimals : 1);
  }
  return String(raw);
}

export function resolveSpriteMacroValues(input = {}, behaviorConfig = null) {
  const context = input?.kind === "sprite-context-v1" ? input : normalizeSpriteData(input);
  const specs = behaviorConfig?.macros || DEFAULT_MACRO_SPECS;
  const values = {};
  Object.entries(specs).forEach(([name, spec]) => {
    const raw = getByPath(context, spec.sourcePath);
    values[name] = {
      name,
      token: spec.token || `{{${name}}}`,
      raw,
      text: formatMacroValue(spec, raw),
      available: raw !== null && raw !== undefined && raw !== "",
      spec,
    };
  });
  return values;
}

export const resolveMacroValues = resolveSpriteMacroValues;

export function renderSpritePhrase(template, macroValues = {}) {
  return String(template || "").replace(/{{\s*([\w_]+)\s*}}/g, (_match, name) => {
    const entry = macroValues[name];
    if (isPlainObject(entry) && "text" in entry) return entry.text;
    if (entry !== null && entry !== undefined && typeof entry !== "object") return String(entry);
    return "--";
  });
}

export const renderPhrase = renderSpritePhrase;

export function compareSpriteOperator(actual, operator, expected) {
  if (actual === null || actual === undefined || actual === "") return false;
  if (operator === "==") return typeof expected === "number" ? finiteNumber(actual) === expected : actual === expected;
  if (operator === "between") {
    const number = finiteNumber(actual);
    const minimum = finiteNumber(expected?.[0]);
    const maximum = finiteNumber(expected?.[1]);
    return number !== null && minimum !== null && maximum !== null && number >= Math.min(minimum, maximum) && number <= Math.max(minimum, maximum);
  }
  const left = finiteNumber(actual);
  const right = finiteNumber(expected);
  if (left === null || right === null) return false;
  if (operator === ">") return left > right;
  if (operator === ">=") return left >= right;
  if (operator === "<") return left < right;
  if (operator === "<=") return left <= right;
  return false;
}

function metricValue(metric, context, config) {
  const macro = config?.macros?.[metric] || DEFAULT_MACRO_SPECS[metric];
  if (macro?.sourcePath) return getByPath(context, macro.sourcePath);
  return getByPath(context, metric);
}

function minutesOfDay(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? hour * 60 + minute : null;
}

function matchesEventCondition(spec, runtime, context, previousContext, config) {
  const type = spec.type;
  if (type === "collection_error") return context.collection.error;
  if (type === "collection_stale") return context.collection.stale;
  if (type === "collection_recovery") {
    const wasBroken = Boolean(previousContext && (previousContext.collection.error || previousContext.collection.stale));
    return wasBroken && !context.collection.error && !context.collection.stale && !context.collection.missing;
  }
  if (type === "value_change") {
    if (!previousContext || !spec.metric) return false;
    const current = metricValue(spec.metric, context, config);
    const previous = metricValue(spec.metric, previousContext, config);
    if (current === null || current === undefined || previous === null || previous === undefined || current === previous) return false;
    const currentNumber = finiteNumber(current);
    const previousNumber = finiteNumber(previous);
    if (spec.minDelta !== undefined && currentNumber !== null && previousNumber !== null) {
      return Math.abs(currentNumber - previousNumber) >= Number(spec.minDelta);
    }
    return true;
  }
  if (!runtime || runtime.type !== type) return false;
  if (spec.card && runtime.card !== spec.card) return false;
  if (spec.phase && runtime.phase !== spec.phase) return false;
  return true;
}

export function evaluateSpriteCondition(when, runtime = {}) {
  const context = runtime.context;
  if (!isPlainObject(when) || !context) return false;
  if (Array.isArray(when.all)) return when.all.every(child => evaluateSpriteCondition(child, runtime));
  if (Array.isArray(when.any)) return when.any.some(child => evaluateSpriteCondition(child, runtime));
  if (when.event) return matchesEventCondition(when.event, runtime.event, context, runtime.previousContext, runtime.config);
  if (when.timeRange) {
    const current = minutesOfDay(context.clock.time);
    const start = minutesOfDay(when.timeRange.start);
    const end = minutesOfDay(when.timeRange.end);
    if (current === null || start === null || end === null) return false;
    if (Array.isArray(when.timeRange.days) && when.timeRange.days.length) {
      const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
      const clockTimestamp = timestampMs(context.clock.iso) ?? context.observedAt;
      const weekday = weekdays[new Date(clockTimestamp).getDay()];
      if (!when.timeRange.days.includes(weekday)) return false;
    }
    return start <= end ? current >= start && current <= end : current >= start || current <= end;
  }
  if (when.metric) return compareSpriteOperator(metricValue(when.metric, context, runtime.config), when.operator, when.value);
  return false;
}

export const evaluateCondition = evaluateSpriteCondition;

export function collectSpriteConditionValues(when, runtime = {}) {
  const values = {};
  const visit = node => {
    if (!isPlainObject(node)) return;
    if (Array.isArray(node.all)) {
      node.all.forEach(visit);
      return;
    }
    if (Array.isArray(node.any)) {
      node.any.filter(child => evaluateSpriteCondition(child, runtime)).forEach(visit);
      return;
    }
    if (node.metric) values[node.metric] = metricValue(node.metric, runtime.context, runtime.config);
    if (node.timeRange) values.hora = runtime.context?.clock?.time ?? null;
    if (node.event?.type) {
      values[`evento:${node.event.type}`] = true;
      if (node.event.type.startsWith("collection_")) values.coleta_status = runtime.context?.collection?.status ?? null;
      if (node.event.type === "value_change" && node.event.metric) values[node.event.metric] = metricValue(node.event.metric, runtime.context, runtime.config);
      if (node.event.type === "user_return") values.tempo_sem_interacao = runtime.context?.idleSeconds ?? null;
      if (runtime.event?.card) values.card_evento = runtime.event.card;
      if (runtime.event?.phase) values.fase_arraste = runtime.event.phase;
    }
  };
  visit(when);
  return values;
}

function triggerEventDescriptors(trigger) {
  const events = [];
  const visit = node => {
    if (!node || typeof node !== "object") return;
    if (node.event?.type) events.push(node.event);
    [...(node.all || []), ...(node.any || [])].forEach(visit);
  };
  visit(trigger.when);
  return events;
}


function triggerEventDescriptor(trigger, type = null) {
  const events = triggerEventDescriptors(trigger);
  return (type ? events.find(event => event.type === type) : events[0]) || null;
}

function triggerHasEventType(trigger, type) {
  return triggerEventDescriptors(trigger).some(event => event.type === type);
}

function triggerPhrasePool(trigger, config) {
  const phrases = Array.isArray(trigger.phrases) ? [...trigger.phrases] : [];
  (trigger.phraseRefs || []).forEach(id => phrases.push(...(config._compiled?.phrasesById?.[id] || [])));
  return phrases;
}

function triggerCharacterPhrasePool(trigger, character) {
  const phrases = trigger.characterPhrases?.[character];
  return Array.isArray(phrases) ? [...phrases] : [];
}

function selectPhraseTemplate(pool, random) {
  return pool.length ? pool[Math.floor(random() * pool.length) % pool.length] : "";
}

export function evaluateConfiguredTriggers(input, behaviorConfig, options = {}) {
  const compiled = behaviorConfig?._compiled ? { valid: true, config: behaviorConfig } : compileSpriteBehaviorConfig(behaviorConfig);
  if (!compiled.valid || !compiled.config) return [];
  const config = compiled.config;
  const context = input?.kind === "sprite-context-v1" ? input : normalizeSpriteData(input, options.now || Date.now());
  const random = typeof options.random === "function" ? options.random : Math.random;
  const macros = resolveSpriteMacroValues(context, config);
  const events = [];
  config.triggers.forEach(trigger => {
    const declaredEvents = triggerEventDescriptors(trigger);
    const declaredEventTypes = declaredEvents.map(event => event.type);
    if (options.event && options.eventOnly !== false && !declaredEventTypes.includes(options.event.type)) return;
    if (options.event?.triggerId && trigger.id !== options.event.triggerId) return;
    const runtime = {
      context,
      previousContext: options.previousContext || null,
      event: options.event || null,
      config,
    };
    if (trigger.enabled === false || !evaluateSpriteCondition(trigger.when, runtime)) return;
    const eventDescriptor = options.event && declaredEventTypes.includes(options.event.type)
      ? declaredEvents.find(event => event.type === options.event.type)
      : declaredEvents.find(event => evaluateSpriteCondition({ event }, runtime)) || null;
    const eventType = eventDescriptor?.type || null;
    const pool = triggerPhrasePool(trigger, config);
    const fallbackMessage = renderSpritePhrase(trigger.fallbackPhrase || "", macros);
    const characterMessages = Object.fromEntries(Object.keys(trigger.characterPhrases || {}).map(character => {
      const characterPool = triggerCharacterPhrasePool(trigger, character);
      const characterTemplate = selectPhraseTemplate(characterPool, random);
      return [character, renderSpritePhrase(characterTemplate, macros)];
    }).filter(([, message]) => message));
    const template = selectPhraseTemplate(pool, random);
    const changingMetric = eventType === "value_change" ? eventDescriptor?.metric : null;
    const signatureValue = changingMetric ? metricValue(changingMetric, context, config) : eventType && options.event ? options.event.sequence || eventType : "active";
    const derivedTransient = ["collection_recovery", "value_change"].includes(eventType);
    const configuredCooldownSeconds = Math.max(
      0,
      Number(trigger.cooldownSeconds) || 0,
      eventType === "value_change" ? Number(eventDescriptor?.minIntervalSeconds) || 0 : 0,
    );
    events.push(reaction({
      key: trigger.id,
      triggerId: trigger.id,
      triggerName: trigger.name || trigger.id,
      signature: `${trigger.id}:${signatureValue}`,
      topic: trigger.topic || trigger.targetCard || trigger.id,
      priority: Number(trigger.priority) || 0,
      anchor: trigger.targetCard,
      state: trigger.spriteState,
      message: renderSpritePhrase(template, macros) || fallbackMessage,
      character: trigger.character || "auto",
      characterGroups: config.characterGroups || {},
      characterMessages,
      fallbackMessage,
      preventRepeat: trigger.preventRepeat !== false,
      repeatWhileActive: trigger.repeatWhileActive !== false,
      matchedValues: collectSpriteConditionValues(trigger.when, runtime),
      durationMs: Math.max(0, Number(trigger.durationSeconds ?? config.defaultBehavior.reactionDurationSeconds ?? 5) * 1000),
      cooldownMs: configuredCooldownSeconds * 1000,
      persistent: Boolean(trigger.persistent),
      holdMs: Math.max(0, Number(trigger.holdSeconds ?? (trigger.persistent ? 6 : 0)) * 1000),
      transient: Boolean(options.event) || derivedTransient,
    }));
  });
  return sortReactions(events);
}


export function evaluateReactions(input = {}, thresholdValues = DEFAULT_THRESHOLDS, cooldownValues = DEFAULT_COOLDOWNS) {
  const thresholds = mergeThresholds(thresholdValues);
  const cooldowns = { ...DEFAULT_COOLDOWNS, ...(cooldownValues || {}) };
  const data = input?.kind === "sprite-context-v1" ? input : normalizeSpriteData(input, Date.now(), thresholds);
  const results = [];

  if (data.collection.error) {
    results.push(reaction({
      key: "collection-error",
      signature: `collection-error:${data.collection.status}:${Boolean(data.collection.message)}`,
      priority: 120,
      anchor: "status",
      state: "confused",
      message: "A coleta falhou. Vou vigiar o status.",
      durationMs: 6000,
      cooldownMs: cooldowns.collectionError,
      persistent: true,
    }));
  } else if (data.collection.stale) {
    results.push(reaction({
      key: "collection-stale",
      signature: "collection-stale",
      priority: 115,
      anchor: "status",
      state: "confused",
      message: `Dados sem atualizar há ${formatCompactDuration(data.collection.ageSeconds)}.`,
      durationMs: 5800,
      cooldownMs: cooldowns.collectionStale,
      persistent: true,
    }));
  } else if (data.collection.missing) {
    results.push(reaction({
      key: "collection-waiting",
      signature: "collection-waiting",
      priority: 112,
      anchor: "status",
      state: "confused",
      message: "Ainda não encontrei uma coleta válida.",
      durationMs: 5200,
      cooldownMs: cooldowns.collectionStale,
      persistent: true,
    }));
  }

  if (data.telemetry.error) {
    results.push(reaction({
      key: "telemetry-error",
      signature: "telemetry-error",
      priority: 107,
      anchor: "machine",
      state: "confused",
      message: "A telemetria ficou indisponível.",
      cooldownMs: cooldowns.telemetryError,
      persistent: true,
    }));
  } else if (data.telemetry.machineUnavailable) {
    results.push(reaction({
      key: "machine-unavailable",
      signature: `machine-unavailable:${data.machine.status}`,
      priority: 72,
      anchor: "machine",
      state: "confused",
      message: "Não consigo ler CPU, RAM e disco agora.",
      cooldownMs: cooldowns.telemetryError,
    }));
  }

  results.push(...codexReaction({
    key: "codex-5h",
    label: "Janela de 5h",
    anchor: "codex-5h",
    percent: data.codex.fiveHourPercent,
    resetSeconds: data.codex.fiveHourResetSeconds,
    limitReached: data.codex.fiveHourLimitReached,
    priorityOffset: 0,
    thresholds,
    cooldowns,
  }));
  results.push(...codexReaction({
    key: "codex-weekly",
    label: "Semanal",
    anchor: "codex-weekly",
    percent: data.codex.weeklyPercent,
    resetSeconds: data.codex.weeklyResetSeconds,
    limitReached: data.codex.weeklyLimitReached,
    priorityOffset: 2,
    thresholds,
    cooldowns,
  }));

  const machineCritical = dominantMetric(data.machine, metric => (
    metric.key === "disco"
      ? metric.value > thresholds.diskCriticalAbove
      : metric.value > thresholds.machineCriticalAbove
  ));
  const machineHigh = dominantMetric(data.machine, metric => (
    metric.key === "disco"
      ? metric.value > thresholds.diskHighAbove
      : metric.value > thresholds.machineHighAbove
  ));

  if (machineCritical) {
    results.push(reaction({
      key: "machine-critical",
      signature: `machine-critical:${machineCritical.key}`,
      priority: 104,
      anchor: "machine",
      state: "critical",
      message: `${machineCritical.key} em ${Math.round(machineCritical.value)}%. Alerta crítico.`,
      durationMs: 5600,
      cooldownMs: cooldowns.machineCritical,
      persistent: true,
    }));
  } else if (machineHigh) {
    results.push(reaction({
      key: "machine-high",
      signature: `machine-high:${machineHigh.key}`,
      priority: 80,
      anchor: "machine",
      state: machineHigh.key === "disco" ? "worried" : "hot",
      message: `${machineHigh.key} em ${Math.round(machineHigh.value)}%. A máquina está se esforçando.`,
      durationMs: 5200,
      cooldownMs: cooldowns.machineHigh,
    }));
  }

  if (data.idleSeconds >= thresholds.idleSleepSeconds) {
    results.push(reaction({
      key: "idle-sleep",
      signature: "idle-sleep",
      priority: 78,
      anchor: "idle",
      state: "sleep",
      message: `Sem interação há ${formatCompactDuration(data.idleSeconds)}. Vou cochilar.`,
      durationMs: 5200,
      cooldownMs: cooldowns.idle,
      persistent: true,
    }));
  } else if (data.idleSeconds >= thresholds.idleBoredSeconds) {
    results.push(reaction({
      key: "idle-bored",
      signature: "idle-bored",
      priority: 55,
      anchor: "idle",
      state: "inspect",
      message: `Tudo quieto há ${formatCompactDuration(data.idleSeconds)}.`,
      cooldownMs: cooldowns.idle,
    }));
  }

  if (data.weather.raining) {
    results.push(reaction({
      key: "weather-rain",
      signature: `weather-rain:${Math.round(data.weather.code || 0)}`,
      priority: 67,
      anchor: "weather",
      state: "worried",
      message: "Chuva lá fora. Melhor ficar por perto.",
      cooldownMs: cooldowns.weather,
    }));
  }
  if (data.weather.temperatureC !== null && data.weather.temperatureC <= thresholds.temperatureColdAt) {
    results.push(reaction({
      key: "weather-cold",
      signature: "weather-cold",
      priority: 64,
      anchor: "weather",
      state: "cold",
      message: `${Math.round(data.weather.temperatureC)}°C. Está frio!`,
      cooldownMs: cooldowns.weather,
    }));
  } else if (data.weather.temperatureC !== null && data.weather.temperatureC >= thresholds.temperatureHotAt) {
    results.push(reaction({
      key: "weather-hot",
      signature: "weather-hot",
      priority: 64,
      anchor: "weather",
      state: "hot",
      message: `${Math.round(data.weather.temperatureC)}°C. Que calor!`,
      cooldownMs: cooldowns.weather,
    }));
  }

  const periodMessages = {
    morning: "Bom dia! O painel já está de pé.",
    afternoon: "Boa tarde! Sigo acompanhando tudo.",
    evening: "Boa noite! Hora de dosar o ritmo.",
    late: "Já está tarde. Vamos com calma.",
  };
  results.push(reaction({
    key: `clock-${data.clock.period}`,
    signature: `clock-${data.clock.period}`,
    priority: 30,
    anchor: "clock",
    state: data.clock.period === "morning" ? "happy" : "talk",
    message: periodMessages[data.clock.period],
    cooldownMs: cooldowns.clock,
  }));

  const fiveBand = classifyCodexRemaining(data.codex.fiveHourPercent, data.codex.fiveHourLimitReached, thresholds);
  const weeklyBand = classifyCodexRemaining(data.codex.weeklyPercent, data.codex.weeklyLimitReached, thresholds);
  if (fiveBand === "normal" && (weeklyBand === "normal" || weeklyBand === "invalid")) {
    results.push(reaction({
      key: "codex-normal",
      signature: "codex-normal",
      priority: 20,
      state: "happy",
      message: "Limites confortáveis. Tudo tranquilo.",
      cooldownMs: cooldowns.codexNormal,
    }));
  }

  return sortReactions(results);
}

export function buildWakeReaction(idleSeconds, cooldownValues = DEFAULT_COOLDOWNS, thresholdValues = DEFAULT_THRESHOLDS) {
  const cooldowns = { ...DEFAULT_COOLDOWNS, ...(cooldownValues || {}) };
  const thresholds = mergeThresholds(thresholdValues);
  return reaction({
    key: "user-returned",
    signature: `user-returned:${idleSeconds >= thresholds.idleSleepSeconds ? "sleep" : "idle"}`,
    priority: 118,
    anchor: "idle",
    state: "wake",
    message: "Você voltou! Bom ter você por aqui.",
    durationMs: 4800,
    cooldownMs: cooldowns.wake,
    transient: true,
  });
}

export class ReactionEventQueue {
  constructor({ now = () => Date.now(), maxSize = 32 } = {}) {
    this.now = now;
    this.maxSize = maxSize;
    this.pending = [];
    this.activeSignatures = new Map();
    this.lastDispatchedAt = new Map();
  }

  update(events = []) {
    const observedAt = this.now();
    const nextActive = new Map(events.map(event => [event.key, event.signature]));
    const activeKeys = new Set(nextActive.keys());
    this.pending = this.pending.filter(event => event.transient || activeKeys.has(event.key));

    events.forEach(event => {
      const existing = this.pending.find(item => item.key === event.key);
      if (existing) {
        const preservedMessage = existing.signature === event.signature ? existing.message : event.message;
        Object.assign(existing, event, { queuedAt: existing.queuedAt, message: preservedMessage });
        return;
      }
      const previousSignature = this.activeSignatures.get(event.key);
      const lastDispatched = this.lastDispatchedAt.get(event.key);
      const changed = previousSignature === undefined || previousSignature !== event.signature;
      const cooledDown = lastDispatched === undefined || observedAt - lastDispatched >= event.cooldownMs;
      const canRepeat = event.repeatWhileActive !== false;
      if ((event.transient && cooledDown) || (!event.transient && (changed || (canRepeat && cooledDown)))) {
        this._push({ ...event, queuedAt: observedAt });
      }
    });

    this.activeSignatures = nextActive;
    this.pending = sortReactions(this.pending).slice(0, this.maxSize);
    return this.pending.length;
  }

  enqueue(event, { force = false, transient = Boolean(event?.transient) } = {}) {
    const observedAt = this.now();
    const existing = this.pending.find(item => item.key === event.key);
    if (existing) return false;
    const lastDispatched = this.lastDispatchedAt.get(event.key);
    if (!force && lastDispatched !== undefined && observedAt - lastDispatched < event.cooldownMs) return false;
    this._push({ ...event, transient, queuedAt: observedAt });
    this.pending = sortReactions(this.pending).slice(0, this.maxSize);
    return true;
  }

  enqueueTransient(event, { force = false } = {}) {
    return this.enqueue(event, { force, transient: true });
  }

  _push(event) {
    this.pending.push(event);
  }

  dequeue(predicate = () => true) {
    const index = this.pending.findIndex(predicate);
    if (index < 0) return null;
    const [event] = this.pending.splice(index, 1);
    this.lastDispatchedAt.set(event.key, this.now());
    return event;
  }

  removeWhere(predicate) {
    const before = this.pending.length;
    this.pending = this.pending.filter(event => !predicate(event));
    return before - this.pending.length;
  }

  hasActive(key) {
    return this.activeSignatures.has(key);
  }

  activeKeys() {
    return new Set(this.activeSignatures.keys());
  }

  clear() {
    this.pending = [];
    this.activeSignatures.clear();
  }

  get size() {
    return this.pending.length;
  }
}

function companionMatchesEvent(companion, event = {}) {
  if (!selectorMatchesCharacter(event.character, { ...companion, id: companion.type }, { groups: event.characterGroups || {} })) return false;
  const hasGenericMessage = Boolean(event.message || event.fallbackMessage);
  const hasCharacterMessages = Object.keys(event.characterMessages || {}).length > 0;
  return hasGenericMessage || !hasCharacterMessages || Boolean(event.characterMessages?.[companion.type]);
}


export function selectCompanion(companions = [], event = {}, lastSpeakerId = null, now = Date.now()) {
  const available = companions.filter(companion => (
    !companion.dragging
    && !companion.reaction
    && !companion.pinnedKey
    && Number(companion.busyUntil || 0) <= now
    && companionMatchesEvent(companion, event)
  ));
  if (!available.length) return null;
  return [...available].sort((left, right) => {
    const leftRepeated = left.id === lastSpeakerId ? 1 : 0;
    const rightRepeated = right.id === lastSpeakerId ? 1 : 0;
    if (leftRepeated !== rightRepeated) return leftRepeated - rightRepeated;
    const leftTopicRepeated = left.lastTopic === event.topic ? 1 : 0;
    const rightTopicRepeated = right.lastTopic === event.topic ? 1 : 0;
    if (leftTopicRepeated !== rightTopicRepeated) return leftTopicRepeated - rightTopicRepeated;
    return Number(left.lastSpokeAt || 0) - Number(right.lastSpokeAt || 0) || left.id - right.id;
  })[0];
}

export function selectPreemptableCompanion(companions = [], event = {}) {
  if (!event) return null;
  return companions
    .filter(companion => (
      !companion.dragging
      && !companion.reaction
      && companion.pinnedEvent
      && Number(companion.pinnedEvent.priority || 0) < Number(event.priority || 0)
      && companionMatchesEvent(companion, event)
    ))
    .sort((left, right) => (
      Number(left.pinnedEvent.priority || 0) - Number(right.pinnedEvent.priority || 0)
      || Number(left.lastSpokeAt || 0) - Number(right.lastSpokeAt || 0)
      || left.id - right.id
    ))[0] || null;
}

function rectIntersectionArea(left, right, margin = 0) {
  const xOverlap = Math.max(0, Math.min(left.right, right.right + margin) - Math.max(left.left, right.left - margin));
  const yOverlap = Math.max(0, Math.min(left.bottom, right.bottom + margin) - Math.max(left.top, right.top - margin));
  return xOverlap * yOverlap;
}

function rectAt(x, y, size, inset = 0.12) {
  const padding = size * inset;
  return {
    left: x + padding,
    top: y + padding,
    right: x + size - padding,
    bottom: y + size - padding * 0.45,
    width: size - padding * 2,
    height: size - padding * 1.45,
  };
}

export class SpriteReactionEngine {
  constructor({ root, getContext, onHumanInteraction, onReaction, thresholds, cooldowns, now, random, behaviorConfig = null, configReport = null, characterRegistry = defaultCharacterRegistry, animationEngine = defaultSpriteAnimationEngine } = {}) {
    if (!root) throw new Error("SpriteReactionEngine requer um elemento root.");
    this.root = root;
    this.getContext = getContext;
    this.onHumanInteraction = onHumanInteraction;
    this.onReaction = typeof onReaction === "function" ? onReaction : null;
    this.characterRegistry = characterRegistry;
    this.animationEngine = animationEngine;
    this.thresholds = mergeThresholds(thresholds);
    this.cooldowns = { ...DEFAULT_COOLDOWNS, ...(cooldowns || {}) };
    this.now = typeof now === "function" ? now : () => Date.now();
    this.random = typeof random === "function" ? random : Math.random;
    const compiledBehaviors = behaviorConfig?._compiled
      ? { valid: true, config: behaviorConfig, errors: [] }
      : behaviorConfig ? compileSpriteBehaviorConfig(behaviorConfig) : { valid: false, config: null, errors: [] };
    this.behaviorConfig = compiledBehaviors.config;
    this.configReport = configReport || {
      valid: compiledBehaviors.valid,
      source: compiledBehaviors.valid ? "provided" : "legacy",
      usingFallback: !compiledBehaviors.valid,
      issues: compiledBehaviors.errors || [],
    };
    const configuredGap = finiteNumber(this.behaviorConfig?.defaultBehavior?.coordination?.minimumSpriteGapPixels);
    if (configuredGap !== null) this.thresholds.minSpriteGap = Math.max(0, configuredGap);
    const behaviorDefaults = this.behaviorConfig?.defaultBehavior || {};
    const featureDefaults = behaviorDefaults.features || {};
    const configuredTalkInterval = finiteNumber(behaviorDefaults.casualSpeech?.intervalSeconds?.min);
    this.settings = {
      enabled: behaviorDefaults.enabled !== false,
      sprite: "explorer",
      count: 2,
      scale: 1,
      speed: 1,
      talkInterval: configuredTalkInterval || 18,
      roam: true,
      reactions: featureDefaults.reactions !== false,
      speech: featureDefaults.speech !== false,
      movement: featureDefaults.movement !== false,
    };
    this.companions = [];
    this.queue = new ReactionEventQueue({ now: this.now });
    this.context = normalizeSpriteData({}, this.now(), this.thresholds);
    this.previousContext = null;
    this.hasContext = false;
    this.rawContext = {};
    this.lastFrame = typeof performance !== "undefined" ? performance.now() : 0;
    this.lastSpeakerId = null;
    this.recentSpeech = new Map();
    this.started = false;
    this.frameRequest = null;
    this.nextContextAt = 0;
    const casualInterval = this.behaviorConfig?.defaultBehavior?.casualSpeech?.intervalSeconds;
    const casualMinimum = Math.max(12, finiteNumber(casualInterval?.min) || 15);
    const casualMaximum = Math.max(casualMinimum, finiteNumber(casualInterval?.max) || casualMinimum);
    this.nextAmbientAt = this.now() + randomBetween(casualMinimum, casualMaximum, this.random) * 1000;
    this.randomTriggerDue = new Map();
    this.syncRandomTriggerSchedules(this.now(), true);
    this.ambientCursor = 0;
    this.protectedRects = [];
    this.protectedRectsAt = 0;
    this.cardEventBindings = [];
    this.eventSequence = 0;
    this.resizeTimer = null;
    this.reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
    this.reducedMotion = Boolean(this.reducedMotionQuery?.matches);
    this.animationEngine?.setReducedMotion(this.reducedMotion);

    this._boundFrame = timestamp => this.frame(timestamp);
    this._boundResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.reflow(), 100);
    };
    this._boundMotionChange = event => this.setReducedMotion(Boolean(event.matches));
    window.addEventListener("resize", this._boundResize);
    window.addEventListener("scroll", this._boundResize, { passive: true });
    this.reducedMotionQuery?.addEventListener?.("change", this._boundMotionChange);
    this.root.dataset.configStatus = this.behaviorConfig ? "valid" : "fallback";
  }

  setBehaviors(rawConfig, report = null) {
    const previousConfig = this.behaviorConfig;
    const previousInitialState = previousConfig?.defaultBehavior?.initialState;
    const compiled = rawConfig?._compiled
      ? { valid: true, config: rawConfig, errors: [] }
      : compileSpriteBehaviorConfig(rawConfig);
    if (!compiled.valid || !compiled.config) {
      this.behaviorConfig = previousConfig || null;
      this.configReport = report || {
        valid: Boolean(previousConfig),
        source: previousConfig ? "previous" : "legacy",
        usingFallback: true,
        issues: compiled.errors || [],
      };
      this.root.dataset.configStatus = previousConfig ? "previous" : "fallback";
    } else {
      this.behaviorConfig = compiled.config;
      this.configReport = report || { valid: true, source: "provided", usingFallback: false, issues: [] };
      this.root.dataset.configStatus = "valid";
      const configuredGap = finiteNumber(this.behaviorConfig.defaultBehavior?.coordination?.minimumSpriteGapPixels);
      if (configuredGap !== null) this.thresholds.minSpriteGap = Math.max(0, configuredGap);
    }
    this.bindConfiguredCardEvents();
    this.queue.clear();
    this.hasContext = false;
    this.syncRandomTriggerSchedules(this.now(), true);
    if (this.started && this.behaviorConfig?.defaultBehavior?.initialState !== previousInitialState) this.rebuild();
    return this.configReport;
  }

  syncRandomTriggerSchedules(wallNow = this.now(), reset = false) {
    const triggers = (this.behaviorConfig?.triggers || []).filter(trigger => (
      trigger.enabled !== false && triggerHasEventType(trigger, "random_interval")
    ));
    const activeIds = new Set(triggers.map(trigger => trigger.id));
    [...this.randomTriggerDue.keys()].forEach(id => {
      if (!activeIds.has(id)) this.randomTriggerDue.delete(id);
    });
    triggers.forEach(trigger => {
      if (!reset && this.randomTriggerDue.has(trigger.id)) return;
      const interval = triggerEventDescriptor(trigger, "random_interval")?.intervalSeconds || {};
      const minimum = Math.max(1, finiteNumber(interval.min) ?? 20);
      const maximum = Math.max(minimum, finiteNumber(interval.max) ?? minimum);
      this.randomTriggerDue.set(trigger.id, wallNow + randomBetween(minimum, maximum, this.random) * 1000);
    });
    return triggers;
  }

  bindConfiguredCardEvents() {
    this.cardEventBindings.forEach(({ element, handler }) => element.removeEventListener("click", handler));
    this.cardEventBindings = [];
    if (!this.behaviorConfig) return;
    Object.entries(this.behaviorConfig.cards || {}).forEach(([card, selector]) => {
      let element = null;
      try { element = document.querySelector(selector); } catch {}
      if (!element) return;
      const handler = event => {
        if (event.target.closest?.(".sprite-companion")) return;
        this.notify("click", { card });
      };
      element.addEventListener("click", handler);
      this.cardEventBindings.push({ element, handler });
    });
  }

  configure(values = {}) {
    const previousCount = this.settings.count;
    const previousSprite = this.settings.sprite;
    const previousMovement = this.settings.movement;
    const previousRoam = this.settings.roam;
    const previousTalkInterval = this.settings.talkInterval;
    const reactionsValue = values.reactions ?? values.smart;
    Object.assign(this.settings, values);
    if (reactionsValue !== undefined) this.settings.reactions = Boolean(reactionsValue);
    delete this.settings.smart;
    this.settings.count = clamp(Math.round(finiteNumber(this.settings.count) || 1), 1, 3);
    this.settings.scale = clamp(finiteNumber(this.settings.scale) || 1, 0.65, 1.35);
    this.settings.speed = clamp(finiteNumber(this.settings.speed) || 1, 0.55, 1.7);
    const configuredTalkInterval = finiteNumber(this.behaviorConfig?.defaultBehavior?.casualSpeech?.intervalSeconds?.min);
    this.settings.talkInterval = clamp(finiteNumber(this.settings.talkInterval) || configuredTalkInterval || 18, 8, 180);
    const availableIds = this.availableCharacterIds();
    this.settings.sprite = availableIds.includes(this.settings.sprite)
      ? this.settings.sprite
      : availableIds.includes("explorer") ? "explorer" : availableIds[0];
    ["enabled", "roam", "reactions", "speech", "movement"].forEach(key => {
      this.settings[key] = Boolean(this.settings[key]);
    });
    this.root.classList.toggle("hidden", !this.settings.enabled);
    this.root.dataset.reducedMotion = String(this.reducedMotion);
    if (!this.started || previousTalkInterval !== this.settings.talkInterval) {
      this.nextAmbientAt = this.now() + this.settings.talkInterval * 1000;
    }

    if (!this.settings.reactions) {
      this.queue.clear();
      this.companions.forEach(companion => {
        companion.reaction = null;
        companion.busyUntil = 0;
        companion.dwellUntil = 0;
        this.hideBubble(companion);
        this.releasePinned(companion, false);
      });
    }
    if (!this.settings.speech) {
      this.companions.forEach(companion => this.hideBubble(companion));
    }
    if (!this.effectiveMovement()) {
      this.companions.forEach(companion => {
        companion.targetX = companion.x;
        companion.targetY = companion.y;
      });
    }

    if (!this.started) {
      this.started = true;
      this.bindConfiguredCardEvents();
      this.rebuild();
      this.ingest(this.getContext?.() || {});
      this.frameRequest = requestAnimationFrame(this._boundFrame);
      return;
    }

    if (previousCount !== this.settings.count || previousSprite !== this.settings.sprite) {
      this.rebuild();
    } else {
      this.companions.forEach(companion => this.applyCompanionStyle(companion));
      this.reflow();
    }
    if (this.settings.roam && this.settings.movement && (!previousRoam || !previousMovement)) {
      this.companions.forEach(companion => {
        if (!companion.reaction && !companion.pinnedKey) companion.nextRoamAt = this.now() + 250;
      });
    }
  }

  destroy() {
    window.removeEventListener("resize", this._boundResize);
    window.removeEventListener("scroll", this._boundResize);
    this.reducedMotionQuery?.removeEventListener?.("change", this._boundMotionChange);
    clearTimeout(this.resizeTimer);
    if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
    this.cardEventBindings.forEach(({ element, handler }) => element.removeEventListener("click", handler));
    this.cardEventBindings = [];
    this.companions.forEach(companion => { companion.animation?.destroy(); companion.element.remove(); });
    this.companions = [];
  }

  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
    this.animationEngine?.setReducedMotion(this.reducedMotion);
    this.root.dataset.reducedMotion = String(this.reducedMotion);
    this.companions.forEach(companion => {
      companion.targetX = companion.x;
      companion.targetY = companion.y;
      if (companion.reaction) this.presentReaction(companion, this.now());
      else if (!companion.pinnedKey) this.setState(companion, "idle");
    });
  }

  effectiveMovement() {
    const reducedConfig = this.behaviorConfig?.defaultBehavior?.motion?.reducedMotion;
    const mustReduce = this.reducedMotion
      && reducedConfig?.honorPreference !== false
      && reducedConfig?.disableWalking !== false;
    return this.settings.movement && !mustReduce;
  }

  ingest(rawContext = {}) {
    const previousContext = this.hasContext ? this.context : null;
    this.rawContext = rawContext || {};
    this.context = normalizeSpriteData(this.rawContext, this.now(), this.thresholds);
    const events = this.behaviorConfig
      ? evaluateConfiguredTriggers(this.context, this.behaviorConfig, {
        previousContext,
        now: this.now(),
        random: this.random,
      })
      : evaluateReactions(this.context, this.thresholds, this.cooldowns);
    if (this.settings.reactions) this.queue.update(events);
    const activeKeys = new Set(events.map(event => event.key));
    this.companions.forEach(companion => {
      if (companion.pinnedKey && !activeKeys.has(companion.pinnedKey)) this.releasePinned(companion, true);
    });
    this.previousContext = previousContext;
    this.hasContext = true;
    this.tryDispatch();
    return { context: this.context, events, queued: this.queue.size };
  }

  notify(type, payload = {}, preferredCompanion = null, contextOverride = null) {
    if (!this.behaviorConfig || !this.settings.reactions) return false;
    const runtimeEvent = {
      type,
      sequence: ++this.eventSequence,
      ...payload,
    };
    const events = evaluateConfiguredTriggers(contextOverride || this.context, this.behaviorConfig, {
      previousContext: this.previousContext,
      event: runtimeEvent,
      eventOnly: true,
      now: this.now(),
      random: this.random,
    });
    if (!events.length) return false;
    let queued = false;
    events.forEach(event => {
      let candidate = preferredCompanion && type === "drag" ? { ...event, anchor: null } : event;
      queued = this.queue.enqueueTransient(candidate) || queued;
    });
    if (!queued) return false;

    const wallNow = this.now();
    const canUsePreferred = preferredCompanion
      && !preferredCompanion.dragging
      && !preferredCompanion.reaction
      && !preferredCompanion.pinnedKey
      && Number(preferredCompanion.busyUntil || 0) <= wallNow
      && events.some(event => companionMatchesEvent(preferredCompanion, event))
      && !this.companions.some(companion => companion !== preferredCompanion && (
        companion.reaction || (companion.bubbleUntil && companion.bubbleUntil > wallNow)
      ));
    if (canUsePreferred) {
      const selected = this.queue.dequeue(event => (
        events.some(candidate => candidate.key === event.key) && companionMatchesEvent(preferredCompanion, event)
      ));
      if (selected) return this.dispatchReaction(preferredCompanion, selected);
    }
    this.tryDispatch();
    return true;
  }

  notifyUserInteraction(previousIdleSeconds = this.context.idleSeconds) {
    const idleSeconds = Math.max(0, finiteNumber(previousIdleSeconds) || 0);
    if (idleSeconds < this.thresholds.idleBoredSeconds) return false;
    this.queue.removeWhere(event => (
      event.key.startsWith("idle-")
      || (event.anchor === "interacao" && ["idle", "inspect", "sleep"].includes(event.state))
    ));
    this.companions.forEach(companion => {
      if (companion.pinnedKey?.startsWith("idle-")
        || (companion.pinnedEvent?.anchor === "interacao" && ["idle", "inspect", "sleep"].includes(companion.pinnedEvent.state))) {
        this.releasePinned(companion, false);
      }
    });
    if (this.behaviorConfig) {
      const interactionContext = {
        ...this.context,
        idleSeconds,
        panelIdleSeconds: idleSeconds,
      };
      return this.notify("user_return", { idleSeconds }, null, interactionContext);
    }
    const queued = this.queue.enqueueTransient(buildWakeReaction(idleSeconds, this.cooldowns, this.thresholds));
    if (queued) this.tryDispatch();
    return queued;
  }

  rebuild() {
    this.companions.forEach(companion => { companion.animation?.destroy(); companion.element.remove(); });
    this.companions = [];
    this.queue.activeSignatures.clear();
    this.root.classList.toggle("hidden", !this.settings.enabled);
    const characterIds = this.availableCharacterIds();
    for (let index = 0; index < this.settings.count; index += 1) {
      const startIndex = Math.max(0, characterIds.indexOf(this.settings.sprite));
      const spriteType = characterIds[(startIndex + index) % characterIds.length];
      const companion = this.createCompanion(index, spriteType);
      this.companions.push(companion);
      this.root.appendChild(companion.element);
    }
    requestAnimationFrame(() => {
      this.refreshProtectedRects(true);
      this.companions.forEach((companion, index) => {
        const position = this.findSafeRoamPosition(companion, index) || { x: 8 + index * 76, y: 60 + index * 74 };
        companion.x = position.x;
        companion.y = position.y;
        companion.targetX = position.x;
        companion.targetY = position.y;
        companion.nextRoamAt = this.now() + randomBetween(1800, 4800, this.random);
        this.render(companion);
      });
      this.separateCompanions();
    });
  }

  availableCharacterIds() {
    const catalog = this.characterRegistry?.list?.() || [];
    const ids = catalog
      .filter(character => character.enabled !== false && character.compatible !== false && character.valid !== false)
      .map(character => character.id)
      .filter(Boolean);
    return ids.length ? [...new Set(ids)] : [...SPRITE_ORDER];
  }

  createCompanion(index, spriteType) {
    const registryCharacter = this.characterRegistry?.get(spriteType);
    const sprite = { name: registryCharacter?.manifest?.name || registryCharacter?.name || SPRITES[spriteType]?.name || spriteType, url: registryCharacter?.legacyUrl || SPRITES[spriteType]?.url || SPRITES.explorer.url };
    const initialState = SPRITE_STATES.includes(this.behaviorConfig?.defaultBehavior?.initialState)
      ? this.behaviorConfig.defaultBehavior.initialState
      : "idle";
    const element = document.createElement("button");
    element.type = "button";
    element.className = `sprite-companion state-${initialState}`;
    element.setAttribute("aria-label", `${sprite.name}, companheiro interativo`);
    element.dataset.sprite = spriteType;
    element.dataset.state = initialState;
    element.innerHTML = `
      <span class="sprite-shadow" aria-hidden="true"></span>
      <span class="sprite-body" aria-hidden="true"></span>
      <span class="sprite-effect" aria-hidden="true"></span>
      <span class="sprite-bubble" role="status"><b class="sprite-name"></b><span class="sprite-message"></span></span>
    `;
    const companion = {
      id: index + 1,
      type: spriteType,
      characterId: spriteType,
      name: sprite.name,
      enabled: registryCharacter?.enabled !== false,
      compatible: registryCharacter?.compatible !== false,
      valid: registryCharacter?.valid !== false,
      personality: registryCharacter?.manifest?.personality || registryCharacter?.personality || null,
      tags: registryCharacter?.manifest?.tags || registryCharacter?.tags || [],
      capabilities: registryCharacter?.manifest?.capabilities || registryCharacter?.capabilities || [],
      groups: registryCharacter?.manifest?.groups || registryCharacter?.groups || [],
      element,
      body: element.querySelector(".sprite-body"),
      bubble: element.querySelector(".sprite-bubble"),
      nameElement: element.querySelector(".sprite-name"),
      messageElement: element.querySelector(".sprite-message"),
      x: 8 + index * 80,
      y: 64 + index * 72,
      targetX: 8 + index * 80,
      targetY: 64 + index * 72,
      state: initialState,
      dragging: false,
      pointerMoved: false,
      dragOffsetX: 0,
      dragOffsetY: 0,
      reaction: null,
      pinnedKey: null,
      pinnedEvent: null,
      pinnedUntil: 0,
      anchorKey: null,
      stageUntil: 0,
      dwellUntil: 0,
      bubbleUntil: 0,
      busyUntil: 0,
      nextRoamAt: this.now() + randomBetween(2500, 7000, this.random),
      lastSpokeAt: 0,
      lastTopic: null,
      lastDragNotifyAt: 0,
    };
    companion.nameElement.textContent = companion.name;
    companion.body.style.backgroundImage = `url("${sprite.url}")`;
    companion.animation = this.animationEngine?.attach(companion.body, {
      characterId: spriteType,
      state: initialState,
      facing: "right",
      onDiagnostic: diagnostic => {
        companion.element.dataset.animationFallback = String(Boolean(diagnostic.fallback));
        companion.element.dataset.animationDiagnostic = diagnostic.fallbackReason || diagnostic.status || "ready";
      },
    });
    this.applyCompanionStyle(companion);
    this.bindPointer(companion);
    return companion;
  }

  applyCompanionStyle(companion) {
    const baseSize = window.innerWidth <= 520 ? 76 : window.innerWidth <= 760 ? 88 : 112;
    companion.element.style.setProperty("--companion-size", `${Math.round(baseSize * this.settings.scale)}px`);
  }

  companionSize(companion) {
    return companion.element.getBoundingClientRect().width || (window.innerWidth <= 520 ? 76 : window.innerWidth <= 760 ? 88 : 112) * this.settings.scale;
  }

  bindPointer(companion) {
    const element = companion.element;
    element.addEventListener("pointerdown", event => {
      if (event.button !== undefined && event.button !== 0) return;
      if (this.behaviorConfig?.defaultBehavior?.motion?.preserveDrag === false) return;
      this.onHumanInteraction?.();
      const rect = element.getBoundingClientRect();
      companion.dragging = true;
      companion.pointerMoved = false;
      companion.dragOffsetX = event.clientX - rect.left;
      companion.dragOffsetY = event.clientY - rect.top;
      element.classList.add("dragging");
      this.setState(companion, "dragging");
      element.setPointerCapture?.(event.pointerId);
      this.notify("drag", { phase: "start" });
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
      if (this.now() - companion.lastDragNotifyAt >= 500) {
        companion.lastDragNotifyAt = this.now();
        this.notify("drag", { phase: "move" });
      }
      this.render(companion);
      event.preventDefault();
    });
    const endDrag = event => {
      if (!companion.dragging) return;
      companion.dragging = false;
      element.classList.remove("dragging");
      try { element.releasePointerCapture?.(event.pointerId); } catch {}
      this.separateCompanions();
      if (!companion.pointerMoved) {
        if (!this.notify("click", { card: "sprite" }, companion)) this.speakImmediate(companion);
      } else if (companion.pinnedEvent) {
        const position = this.anchorPosition(companion.pinnedEvent.anchor, companion);
        if (position && this.effectiveMovement()) {
          companion.targetX = position.x;
          companion.targetY = position.y;
          this.setState(companion, "walk");
        } else {
          this.setState(companion, companion.pinnedEvent.state);
        }
      } else {
        this.setState(companion, "idle");
        companion.nextRoamAt = this.now() + 1600;
      }
      if (companion.pointerMoved) this.notify("drag", { phase: "end" }, companion);
    };
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
    element.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.onHumanInteraction?.();
      if (!this.notify("click", { card: "sprite" }, companion)) this.speakImmediate(companion);
    });
  }

  viewportBounds(companion = null) {
    const size = companion ? this.companionSize(companion) : 112 * this.settings.scale;
    return {
      minX: 6,
      minY: 48,
      maxX: Math.max(6, window.innerWidth - size - 6),
      maxY: Math.max(48, window.innerHeight - size - 6),
    };
  }

  refreshProtectedRects(force = false) {
    const observedAt = this.now();
    if (!force && observedAt - this.protectedRectsAt < 350) return this.protectedRects;
    const selector = "[data-sprite-protected], .progress, .machine-bars, .studio.open";
    this.protectedRects = [...document.querySelectorAll(selector)]
      .filter(element => !this.root.contains(element))
      .map(element => element.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < window.innerHeight)
      .map(rect => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
    this.protectedRectsAt = observedAt;
    return this.protectedRects;
  }

  positionScore(x, y, companion, { anchorRect = null, ignoreCompanion = null } = {}) {
    const size = this.companionSize(companion);
    const rect = rectAt(x, y, size);
    let score = 0;
    this.refreshProtectedRects().forEach(protectedRect => {
      score += rectIntersectionArea(rect, protectedRect, 7) * 18;
    });
    if (anchorRect) score += rectIntersectionArea(rect, anchorRect, 8) * 40;
    if (this.behaviorConfig?.defaultBehavior?.motion?.avoidCollisions !== false) {
      this.companions.forEach(other => {
        if (other === companion || other === ignoreCompanion) return;
        const otherSize = this.companionSize(other);
        const otherRect = rectAt(other.targetX ?? other.x, other.targetY ?? other.y, otherSize);
        score += rectIntersectionArea(rect, otherRect, this.thresholds.minSpriteGap) * 50;
      });
    }
    const bounds = this.viewportBounds(companion);
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) score += 1_000_000;
    return score;
  }

  anchorPosition(anchorKey, companion) {
    if (!anchorKey) return null;
    let anchor = null;
    const configuredSelector = this.behaviorConfig?.cards?.[anchorKey];
    try {
      anchor = configuredSelector
        ? document.querySelector(configuredSelector)
        : document.querySelector(`[data-sprite-anchor="${anchorKey}"]`);
    } catch {
      anchor = document.querySelector(`[data-sprite-anchor="${anchorKey}"]`);
    }
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 12 || rect.top > window.innerHeight - 12) return null;
    const size = this.companionSize(companion);
    const gap = 10;
    const safePlacement = this.behaviorConfig?.defaultBehavior?.motion?.safePlacement;
    const safeZone = safePlacement === "card-edge"
      ? null
      : anchor.querySelector?.("[data-sprite-safe-zone]");
    const safeRect = safeZone?.getBoundingClientRect?.();
    const candidates = [];
    if (safeRect && safeRect.width > 0 && safeRect.height > 0) {
      candidates.push({
        x: safeRect.left + safeRect.width * 0.5 - size * 0.5,
        y: safeRect.top + safeRect.height * 0.5 - size * 0.5,
        inside: true,
        safe: true,
      });
    }
    candidates.push(
      { x: rect.left - size - gap, y: rect.top + rect.height * 0.5 - size * 0.5 },
      { x: rect.right + gap, y: rect.top + rect.height * 0.5 - size * 0.5 },
      { x: rect.left + rect.width * 0.2 - size * 0.5, y: rect.top - size - gap },
      { x: rect.left + rect.width * 0.5 - size * 0.5, y: rect.top - size - gap },
      { x: rect.left + rect.width * 0.8 - size * 0.5, y: rect.top - size - gap },
      { x: rect.left + rect.width * 0.2 - size * 0.5, y: rect.bottom + gap },
      { x: rect.left + rect.width * 0.5 - size * 0.5, y: rect.bottom + gap },
      { x: rect.left + rect.width * 0.8 - size * 0.5, y: rect.bottom + gap },
      { x: rect.right - size - 6, y: rect.top + 6, inside: true },
      { x: rect.right - size - 6, y: rect.bottom - size - 6, inside: true },
      { x: rect.left + 6, y: rect.bottom - size - 6, inside: true },
    );
    const bounds = this.viewportBounds(companion);
    const ranked = candidates.map(candidate => {
      const x = clamp(candidate.x, bounds.minX, bounds.maxX);
      const y = clamp(candidate.y, bounds.minY, bounds.maxY);
      const distance = Math.hypot(x - companion.x, y - companion.y);
      const anchorObstacle = candidate.inside ? null : rect;
      const insidePenalty = candidate.safe ? -400 : candidate.inside ? 5000 : 0;
      return { x, y, score: this.positionScore(x, y, companion, { anchorRect: anchorObstacle }) + distance * 0.08 + insidePenalty };
    }).sort((left, right) => left.score - right.score);
    if (!ranked.length || ranked[0].score >= 1_000_000) return null;
    return ranked[0];
  }

  findSafeRoamPosition(companion, seed = 0, preferDifferent = false) {
    const bounds = this.viewportBounds(companion);
    const candidates = [];
    const cornerOffset = seed * 18;
    candidates.push(
      { x: bounds.minX + cornerOffset, y: bounds.maxY - cornerOffset },
      { x: bounds.maxX - cornerOffset, y: bounds.maxY - cornerOffset },
      { x: bounds.maxX - cornerOffset, y: bounds.minY + cornerOffset },
      { x: bounds.minX + cornerOffset, y: bounds.minY + cornerOffset },
    );
    for (let index = 0; index < 30; index += 1) {
      candidates.push({
        x: randomBetween(bounds.minX, bounds.maxX, this.random),
        y: randomBetween(bounds.minY, bounds.maxY, this.random),
      });
    }
    const ranked = candidates.map(candidate => {
      const safetyScore = this.positionScore(candidate.x, candidate.y, companion);
      const distance = Math.hypot(candidate.x - companion.x, candidate.y - companion.y);
      return {
        ...candidate,
        score: preferDifferent ? safetyScore * 1_000_000 - distance : safetyScore,
      };
    }).sort((left, right) => left.score - right.score);
    return ranked[0] || null;
  }

  setRandomDestination(companion) {
    if (!this.effectiveMovement()) return false;
    const configuredDestinations = this.behaviorConfig?.defaultBehavior?.allowedDestinations || [];
    const availableDestinations = configuredDestinations.filter(destination => destination !== companion.anchorKey);
    let position = null;
    let destination = null;
    if (availableDestinations.length) {
      const start = Math.floor(this.random() * availableDestinations.length) % availableDestinations.length;
      for (let offset = 0; offset < availableDestinations.length; offset += 1) {
        const candidateDestination = availableDestinations[(start + offset) % availableDestinations.length];
        const candidatePosition = this.anchorPosition(candidateDestination, companion);
        if (!candidatePosition) continue;
        position = candidatePosition;
        destination = candidateDestination;
        break;
      }
    }
    if (!position) position = this.findSafeRoamPosition(companion, companion.id - 1, true);
    if (!position) return false;
    companion.targetX = position.x;
    companion.targetY = position.y;
    companion.anchorKey = destination;
    const actionInterval = this.behaviorConfig?.defaultBehavior?.actionIntervalSeconds;
    const minimum = Math.max(4, finiteNumber(actionInterval?.min) || 6.5);
    const maximum = Math.max(minimum, finiteNumber(actionInterval?.max) || 13.5);
    companion.nextRoamAt = this.now() + randomBetween(minimum, maximum, this.random) * 1000;
    return true;
  }

  reflow() {
    this.refreshProtectedRects(true);
    this.companions.forEach(companion => {
      this.applyCompanionStyle(companion);
      const bounds = this.viewportBounds(companion);
      companion.x = clamp(companion.x, bounds.minX, bounds.maxX);
      companion.y = clamp(companion.y, bounds.minY, bounds.maxY);
      const anchoredEvent = companion.reaction || companion.pinnedEvent;
      const position = anchoredEvent?.anchor ? this.anchorPosition(anchoredEvent.anchor, companion) : null;
      if (position && this.effectiveMovement()) {
        companion.targetX = position.x;
        companion.targetY = position.y;
      } else if (this.effectiveMovement() && (anchoredEvent || this.positionScore(companion.x, companion.y, companion) > 0)) {
        const safePosition = this.findSafeRoamPosition(companion, companion.id - 1);
        companion.targetX = safePosition?.x ?? companion.x;
        companion.targetY = safePosition?.y ?? companion.y;
      } else {
        companion.targetX = clamp(companion.targetX, bounds.minX, bounds.maxX);
        companion.targetY = clamp(companion.targetY, bounds.minY, bounds.maxY);
        if (!this.effectiveMovement() && this.positionScore(companion.x, companion.y, companion) > 0) {
          const safePosition = this.findSafeRoamPosition(companion, companion.id - 1);
          if (safePosition) {
            companion.x = safePosition.x;
            companion.y = safePosition.y;
            companion.targetX = safePosition.x;
            companion.targetY = safePosition.y;
          }
        }
      }
      this.render(companion);
      this.updateBubblePlacement(companion);
    });
    this.separateCompanions();
  }

  setState(companion, state) {
    const nextState = CHARACTER_STATES.includes(state) ? state : "idle";
    companion.element.classList.remove(...STATE_CLASSES);
    companion.element.classList.add(`state-${nextState}`);
    companion.element.dataset.state = nextState;
    companion.state = nextState;
    companion.animation?.setState(nextState);
    this.updateContentLayer(companion);
  }

  updateContentLayer(companion) {
    companion?.element?.classList.remove("behind-content");
  }

  frame(timestamp) {
    const deltaSeconds = Math.min(0.05, Math.max(0, (timestamp - this.lastFrame) / 1000));
    this.lastFrame = timestamp;
    const wallNow = this.now();
    if (this.settings.enabled && wallNow >= this.nextContextAt) {
      this.nextContextAt = wallNow + 1000;
      if (this.getContext) this.ingest(this.getContext() || {});
    }

    this.companions.forEach(companion => this.updateCompanion(companion, deltaSeconds, wallNow));
    this.separateCompanions();
    if (this.settings.enabled && this.settings.reactions) {
      this.enqueueAmbientIfDue(wallNow);
      this.tryDispatch();
    }
    this.frameRequest = requestAnimationFrame(this._boundFrame);
  }

  updateCompanion(companion, deltaSeconds, wallNow) {
    if (!this.settings.enabled || companion.dragging) return;
    if (companion.bubbleUntil && wallNow >= companion.bubbleUntil) this.hideBubble(companion);
    const dx = companion.targetX - companion.x;
    const dy = companion.targetY - companion.y;
    const distance = Math.hypot(dx, dy);

    if (this.effectiveMovement() && distance > 1.5) {
      const configuredSpeed = Math.max(24, finiteNumber(this.behaviorConfig?.defaultBehavior?.speed) || 92);
      const maximumWalk = Math.max(1, finiteNumber(this.behaviorConfig?.defaultBehavior?.walkDurationSeconds?.max) || 8);
      const speed = Math.max(configuredSpeed * this.settings.speed, distance / maximumWalk);
      const step = Math.min(distance, speed * deltaSeconds);
      const nextX = companion.x + (dx / distance) * step;
      const nextY = companion.y + (dy / distance) * step;
      const blockedByCompanion = this.behaviorConfig?.defaultBehavior?.motion?.avoidCollisions !== false && this.companions.some(other => {
        if (other === companion || other.dragging) return false;
        const minimum = (this.companionSize(companion) + this.companionSize(other)) * 0.36 + this.thresholds.minSpriteGap;
        return Math.hypot(nextX - other.x, nextY - other.y) < minimum && companion.id > other.id;
      });
      if (!blockedByCompanion) {
        companion.x = nextX;
        companion.y = nextY;
        companion.element.classList.toggle("facing-left", dx < 0);
        companion.animation?.setFacing(dx < 0 ? "left" : "right");
      }
      this.setState(companion, "walk");
      this.render(companion);
      return;
    }

    if (companion.reaction) {
      if (companion.reaction.stage === "travel") this.beginArrival(companion, wallNow);
      if (companion.reaction?.stage === "inspect" && wallNow >= companion.stageUntil) {
        companion.reaction.stage = "point";
        companion.stageUntil = wallNow + (this.reducedMotion ? 0 : 520);
        this.setState(companion, "point");
      }
      if (companion.reaction?.stage === "point" && wallNow >= companion.stageUntil) this.presentReaction(companion, wallNow);
      if (companion.reaction?.stage === "present" && wallNow >= companion.dwellUntil) this.finishReaction(companion, wallNow);
      return;
    }

    if (companion.pinnedKey) {
      const pinnedUntil = finiteNumber(companion.pinnedUntil) || 0;
      if (pinnedUntil > 0 && wallNow >= pinnedUntil) {
        this.releasePinned(companion, true);
        return;
      }
      this.setState(companion, companion.pinnedEvent?.state || "inspect");
      return;
    }

    if (this.settings.roam && this.effectiveMovement() && wallNow >= companion.nextRoamAt) {
      this.setRandomDestination(companion);
    } else if (distance <= 1.5) {
      this.setState(companion, "idle");
    }
  }

  beginArrival(companion, wallNow) {
    if (!companion.reaction) return;
    if (!companion.reaction.anchor || this.reducedMotion || !this.settings.movement) {
      this.presentReaction(companion, wallNow);
      return;
    }
    companion.reaction.stage = "inspect";
    companion.stageUntil = wallNow + 440;
    this.setState(companion, "inspect");
  }

  presentReaction(companion, wallNow) {
    if (!companion.reaction) return;
    companion.reaction.stage = "present";
    this.setState(companion, companion.reaction.state);
    const reducedDurationSeconds = finiteNumber(
      this.behaviorConfig?.defaultBehavior?.motion?.reducedMotion?.reactionDurationSeconds,
    );
    const configuredDurationMs = this.reducedMotion && reducedDurationSeconds !== null
      ? Math.max(500, reducedDurationSeconds * 1000)
      : companion.reaction.durationMs;
    const durationMs = this.settings.speech ? configuredDurationMs : Math.min(2600, configuredDurationMs);
    companion.dwellUntil = wallNow + durationMs;
    companion.busyUntil = companion.dwellUntil;
    if (this.settings.speech && companion.reaction.message) this.say(companion, companion.reaction.message, durationMs);
  }

  finishReaction(companion, wallNow) {
    const event = companion.reaction;
    if (!event) return;
    this.hideBubble(companion);
    companion.lastTopic = event.topic;
    companion.reaction = null;
    companion.busyUntil = 0;
    const holdMs = Math.max(0, finiteNumber(event.holdMs) || 0);
    if (event.persistent && this.queue.hasActive(event.key) && holdMs > 0) {
      companion.pinnedKey = event.key;
      companion.pinnedEvent = event;
      companion.pinnedUntil = wallNow + holdMs;
      this.setState(companion, event.state);
      return;
    }
    companion.anchorKey = null;
    companion.dwellUntil = 0;
    this.setState(companion, "idle");
    if (this.behaviorConfig?.defaultBehavior?.motion?.returnToFreeRoam === false) {
      companion.targetX = companion.x;
      companion.targetY = companion.y;
      companion.nextRoamAt = Number.POSITIVE_INFINITY;
      return;
    }
    const rest = this.behaviorConfig?.defaultBehavior?.restDurationSeconds;
    const restMinimum = Math.max(0.5, finiteNumber(rest?.min) || 1.2);
    const restMaximum = Math.max(restMinimum, finiteNumber(rest?.max) || 3);
    companion.nextRoamAt = wallNow + randomBetween(restMinimum, restMaximum, this.random) * 1000;
  }

  releasePinned(companion, resumeRoam = true) {
    companion.pinnedKey = null;
    companion.pinnedEvent = null;
    companion.pinnedUntil = 0;
    companion.anchorKey = null;
    if (!companion.dragging && !companion.reaction) this.setState(companion, "idle");
    if (resumeRoam
      && this.behaviorConfig?.defaultBehavior?.motion?.returnToFreeRoam !== false
      && this.settings.roam
      && this.effectiveMovement()) {
      companion.nextRoamAt = this.now() + 700;
    }
  }

  playTemporary(event) {
    if (!event || !this.settings.enabled || !this.settings.reactions) {
      return { played: false, reason: "Reações ou sprites estão desativados." };
    }
    const preview = reaction({
      ...event,
      key: `studio_preview_${++this.eventSequence}`,
      triggerId: event.triggerId || event.key,
      triggerName: event.triggerName || event.name || event.key,
      signature: `studio-preview:${this.eventSequence}`,
      source: "studio",
      transient: true,
      persistent: false,
      holdMs: 0,
      repeatWhileActive: false,
    });
    const wallNow = this.now();
    let companion = selectCompanion(this.companions, preview, this.lastSpeakerId, wallNow);
    if (!companion) companion = selectPreemptableCompanion(this.companions, preview);
    if (!companion) return { played: false, reason: "Nenhum personagem compatível está disponível agora." };
    if (companion.pinnedKey) this.releasePinned(companion, false);
    return { played: this.dispatchReaction(companion, preview), companion: companion.type };
  }

  dispatchReaction(companion, event) {
    if (!companion || !event) return false;
    const characterMessage = event.characterMessages?.[companion.type];
    event = {
      ...event,
      message: characterMessage || event.message || event.fallbackMessage || "",
    };
    const duplicateWindowMs = Math.max(
      0,
      finiteNumber(this.behaviorConfig?.defaultBehavior?.coordination?.duplicatePhraseWindowSeconds) || 0,
    ) * 1000;
    const recent = event.message ? this.recentSpeech.get(event.message) : null;
    const duplicateInWindow = event.preventRepeat !== false
      && recent
      && this.now() - recent.at < duplicateWindowMs
      && recent.companionId !== undefined;
    if (duplicateInWindow) {
      const fallback = event.fallbackMessage && event.fallbackMessage !== event.message ? event.fallbackMessage : "";
      event = { ...event, message: fallback };
    }
    companion.reaction = { ...event, stage: "travel" };
    companion.pinnedKey = null;
    companion.pinnedEvent = null;
    companion.pinnedUntil = 0;
    companion.anchorKey = event.anchor;
    const position = this.effectiveMovement() ? this.anchorPosition(event.anchor, companion) : null;
    if (position) {
      companion.targetX = position.x;
      companion.targetY = position.y;
      const distance = Math.hypot(companion.targetX - companion.x, companion.targetY - companion.y);
      if (distance > 1.5) this.setState(companion, "walk");
      else this.beginArrival(companion, this.now());
    } else {
      companion.targetX = companion.x;
      companion.targetY = companion.y;
      this.beginArrival(companion, this.now());
    }
    if (this.onReaction) {
      const historyEntry = {
        triggerId: event.triggerId || event.key,
        triggerName: event.triggerName || event.triggerId || event.key,
        timestamp: new Date(this.now()).toISOString(),
        values: event.matchedValues || {},
        character: companion.type,
        card: event.anchor,
        phrase: event.message,
        state: event.state,
        priority: event.priority,
        durationSeconds: event.durationMs / 1000,
        cooldownSeconds: event.cooldownMs / 1000,
        holdSeconds: event.holdMs / 1000,
        result: "executado",
        source: event.source || "runtime",
      };
      try {
        Promise.resolve(this.onReaction(historyEntry)).catch(() => {});
      } catch {}
    }
    return true;
  }

  tryDispatch() {
    if (!this.settings.enabled || !this.settings.reactions || !this.companions.length) return false;
    const wallNow = this.now();
    const presentingCount = this.companions.filter(companion => (
      companion.reaction || (companion.bubbleUntil && companion.bubbleUntil > wallNow)
    )).length;
    const maxConcurrent = clamp(
      Math.round(finiteNumber(this.behaviorConfig?.defaultBehavior?.coordination?.maxConcurrentReactions) || 1),
      1,
      this.companions.length,
    );
    if (presentingCount >= maxConcurrent) return false;
    let nextEvent = null;
    let companion = null;
    for (const candidate of this.queue.pending) {
      const available = selectCompanion(this.companions, candidate, this.lastSpeakerId, wallNow);
      if (!available) continue;
      nextEvent = candidate;
      companion = available;
      break;
    }
    let displacedEvent = null;
    if (!companion) {
      for (const candidate of this.queue.pending) {
        const preemptable = selectPreemptableCompanion(this.companions, candidate);
        if (!preemptable) continue;
        nextEvent = candidate;
        companion = preemptable;
        displacedEvent = companion.pinnedEvent;
        break;
      }
    }
    if (!companion) return false;
    if (displacedEvent) {
      this.releasePinned(companion, false);
      if (this.queue.hasActive(displacedEvent.key)) {
        this.queue.enqueue(displacedEvent, { force: true, transient: false });
      }
    }
    const event = this.queue.dequeue(candidate => candidate === nextEvent);
    if (!event) return false;
    return this.dispatchReaction(companion, event);
  }

  say(companion, message, durationMs) {
    const cleanMessage = String(message || "").trim();
    if (!cleanMessage) return;
    companion.messageElement.textContent = cleanMessage;
    companion.element.classList.add("talking");
    companion.bubbleUntil = this.now() + durationMs;
    companion.lastSpokeAt = this.now();
    this.lastSpeakerId = companion.id;
    this.recentSpeech.set(cleanMessage, { at: this.now(), companionId: companion.id });
    this.refreshProtectedRects(true);
    this.updateBubblePlacement(companion);
  }

  hideBubble(companion) {
    companion.bubbleUntil = 0;
    companion.element.classList.remove("talking");
  }

  updateBubblePlacement(companion) {
    const size = this.companionSize(companion);
    const width = Math.min(companion.bubble?.offsetWidth || 180, window.innerWidth * 0.7);
    const height = companion.bubble?.offsetHeight || 48;
    if (!companion.element.classList.contains("talking")) {
      companion.element.style.setProperty("--bubble-shift-x", "0px");
      companion.element.style.setProperty("--bubble-shift-y", "0px");
      companion.element.classList.toggle("bubble-right", companion.x + size * 0.5 < width * 0.55);
      companion.element.classList.toggle("bubble-left", companion.x + size * 0.5 > window.innerWidth - width * 0.55);
      companion.element.classList.toggle("bubble-below", companion.y < height + 8);
      return;
    }
    const placements = [
      { horizontal: "center", below: false, preference: 0 },
      { horizontal: "left", below: false, preference: 2 },
      { horizontal: "right", below: false, preference: 2 },
      { horizontal: "center", below: true, preference: 4 },
      { horizontal: "left", below: true, preference: 6 },
      { horizontal: "right", below: true, preference: 6 },
    ];
    const basePosition = placement => {
      let left;
      if (placement.horizontal === "left") left = companion.x;
      else if (placement.horizontal === "right") left = companion.x + size - width;
      else left = companion.x + (size - width) / 2;
      return {
        left,
        top: placement.below ? companion.y + size - 3 : companion.y + 3 - height,
      };
    };
    const candidates = placements.map(placement => ({ ...placement, ...basePosition(placement) }));
    const gridStep = Math.max(24, Math.min(42, Math.round(width / 5)));
    for (let top = 6; top <= Math.max(6, window.innerHeight - height - 6); top += gridStep) {
      for (let left = 6; left <= Math.max(6, window.innerWidth - width - 6); left += gridStep) {
        const below = top >= companion.y + size * 0.5;
        const horizontal = left + width * 0.5 < companion.x + size * 0.35
          ? "right"
          : left + width * 0.5 > companion.x + size * 0.65 ? "left" : "center";
        candidates.push({ left, top, below, horizontal, preference: 30 });
      }
    }
    const ranked = candidates.map(placement => {
      const { left, top } = placement;
      const rect = { left, top, right: left + width, bottom: top + height };
      const overflow = Math.max(0, -rect.left)
        + Math.max(0, -rect.top)
        + Math.max(0, rect.right - window.innerWidth)
        + Math.max(0, rect.bottom - window.innerHeight);
      let score = placement.preference + overflow * 10_000;
      this.refreshProtectedRects().forEach(protectedRect => {
        score += rectIntersectionArea(rect, protectedRect, 14) * 120;
      });
      this.companions.forEach(other => {
        if (other === companion) return;
        score += rectIntersectionArea(rect, rectAt(other.x, other.y, this.companionSize(other)), 3) * 80;
      });
      const bubbleCenterX = left + width * 0.5;
      const bubbleCenterY = top + height * 0.5;
      score += Math.hypot(bubbleCenterX - (companion.x + size * 0.5), bubbleCenterY - (companion.y + size * 0.5)) * 0.12;
      return { ...placement, score };
    }).sort((left, right) => left.score - right.score);
    const selected = ranked[0] || placements[0];
    companion.element.classList.toggle("bubble-right", selected.horizontal === "left");
    companion.element.classList.toggle("bubble-left", selected.horizontal === "right");
    companion.element.classList.toggle("bubble-below", selected.below);
    const base = basePosition(selected);
    companion.element.style.setProperty("--bubble-shift-x", `${Math.round(selected.left - base.left)}px`);
    companion.element.style.setProperty("--bubble-shift-y", `${Math.round(selected.top - base.top)}px`);
  }

  speakImmediate(companion) {
    if (companion.pinnedEvent) {
      this.setState(companion, companion.pinnedEvent.state);
      if (this.settings.speech) this.say(companion, companion.pinnedEvent.message, Math.min(companion.pinnedEvent.durationMs, 5200));
      return;
    }
    if (!this.settings.speech) {
      if (!companion.reaction) {
        this.dispatchReaction(companion, reaction({
          key: `manual-visual-${companion.id}`,
          topic: "manual",
          priority: 1,
          state: "happy",
          durationMs: 900,
          cooldownMs: 0,
          transient: true,
        }));
      }
      return;
    }
    const events = evaluateReactions(this.context, this.thresholds, this.cooldowns);
    const recentWindow = Math.max(8000, this.settings.talkInterval * 1000);
    const event = events.find(candidate => {
      const spoken = this.recentSpeech.get(candidate.message);
      return !spoken || spoken.companionId === companion.id || this.now() - spoken.at >= recentWindow;
    }) || reaction({
      key: `manual-${companion.id}`,
      topic: "manual",
      priority: 1,
      state: "talk",
      message: `${companion.name} segue de olho no painel.`,
      cooldownMs: 8000,
      transient: true,
    });
    if (companion.reaction) return;
    this.dispatchReaction(companion, { ...event, persistent: false, durationMs: Math.min(event.durationMs, 5200) });
  }

  enqueueAmbientIfDue(wallNow) {
    if (!this.settings.speech || this.queue.size || this.companions.some(companion => companion.reaction)) return;
    if (this.behaviorConfig) {
      const randomTriggers = this.syncRandomTriggerSchedules(wallNow);
      const dueTrigger = randomTriggers
        .filter(trigger => wallNow >= (this.randomTriggerDue.get(trigger.id) || Number.POSITIVE_INFINITY))
        .sort((left, right) => (this.randomTriggerDue.get(left.id) || 0) - (this.randomTriggerDue.get(right.id) || 0))[0];
      if (dueTrigger) {
        this.notify("random_interval", { source: "timer", triggerId: dueTrigger.id });
        const interval = triggerEventDescriptor(dueTrigger, "random_interval")?.intervalSeconds || {};
        const minimum = Math.max(1, finiteNumber(interval.min) ?? 20);
        const maximum = Math.max(minimum, finiteNumber(interval.max) ?? minimum);
        this.randomTriggerDue.set(dueTrigger.id, wallNow + randomBetween(minimum, maximum, this.random) * 1000);
        return;
      }
      if (randomTriggers.length || wallNow < this.nextAmbientAt) return;
      if (this.behaviorConfig.defaultBehavior?.casualSpeech?.enabled !== false) {
        const phraseIds = this.behaviorConfig.defaultBehavior?.casualSpeech?.phraseIds || [];
        const phrasePool = phraseIds.flatMap(id => this.behaviorConfig._compiled?.phrasesById?.[id] || []);
        if (phrasePool.length) {
          const template = phrasePool[Math.floor(this.random() * phrasePool.length) % phrasePool.length];
          const destinations = this.behaviorConfig.defaultBehavior?.allowedDestinations || [];
          const anchor = destinations.length
            ? destinations[Math.floor(this.random() * destinations.length) % destinations.length]
            : null;
          this.queue.enqueueTransient(reaction({
            key: "configured-casual",
            topic: anchor || "casual",
            priority: 10,
            anchor,
            state: "talk",
            message: renderSpritePhrase(template, resolveSpriteMacroValues(this.context, this.behaviorConfig)),
            cooldownMs: Math.max(8000, this.settings.talkInterval * 1000),
            transient: true,
          }));
        }
      }
      const declaredInterval = this.behaviorConfig.defaultBehavior?.casualSpeech?.intervalSeconds;
      const configuredMinimum = finiteNumber(declaredInterval?.min);
      const configuredMaximum = finiteNumber(declaredInterval?.max);
      const minimum = Math.max(12, configuredMinimum ?? this.settings.talkInterval);
      const maximum = Math.max(minimum, configuredMaximum ?? minimum);
      this.nextAmbientAt = wallNow + randomBetween(minimum, maximum, this.random) * 1000;
      return;
    }
    const options = [];
    if (this.context.clock.time) options.push(reaction({
      key: "ambient-clock",
      topic: "clock",
      priority: 8,
      anchor: "clock",
      state: "talk",
      message: `Agora são ${this.context.clock.time}.`,
      cooldownMs: Math.max(30_000, this.settings.talkInterval * 1000),
      transient: true,
    }));
    if (this.context.machine.cpuPercent !== null && this.context.machine.memoryPercent !== null) options.push(reaction({
      key: "ambient-machine",
      topic: "machine",
      priority: 8,
      anchor: "machine",
      state: "inspect",
      message: `CPU ${Math.round(this.context.machine.cpuPercent)}% e RAM ${Math.round(this.context.machine.memoryPercent)}%.`,
      cooldownMs: Math.max(30_000, this.settings.talkInterval * 1000),
      transient: true,
    }));
    if (this.context.codex.fiveHourPercent !== null) options.push(reaction({
      key: "ambient-codex",
      topic: "codex-5h",
      priority: 8,
      anchor: "codex-5h",
      state: "inspect",
      message: `Janela de 5h com ${Math.round(this.context.codex.fiveHourPercent)}%.`,
      cooldownMs: Math.max(30_000, this.settings.talkInterval * 1000),
      transient: true,
    }));
    if (options.length) {
      const selected = options[this.ambientCursor % options.length];
      this.ambientCursor += 1;
      this.queue.enqueueTransient(selected);
    }
    this.nextAmbientAt = wallNow + Math.max(12, this.settings.talkInterval) * 1000 + randomBetween(0, 3500, this.random);
  }

  render(companion) {
    companion.element.style.transform = `translate3d(${Math.round(companion.x)}px, ${Math.round(companion.y)}px, 0)`;
    this.updateBubblePlacement(companion);
    this.updateContentLayer(companion);
  }

  separateCompanions() {
    if (this.behaviorConfig?.defaultBehavior?.motion?.avoidCollisions === false) return;
    for (let leftIndex = 0; leftIndex < this.companions.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < this.companions.length; rightIndex += 1) {
        const left = this.companions[leftIndex];
        const right = this.companions[rightIndex];
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const minimum = (this.companionSize(left) + this.companionSize(right)) * 0.36 + this.thresholds.minSpriteGap;
        if (distance >= minimum) continue;
        const overlap = minimum - distance;
        const unitX = dx / distance || (left.id < right.id ? 1 : -1);
        const unitY = dy / distance || 0;
        const moveLeft = left.dragging ? 0 : right.dragging ? overlap : overlap / 2;
        const moveRight = right.dragging ? 0 : left.dragging ? overlap : overlap / 2;
        const leftBounds = this.viewportBounds(left);
        const rightBounds = this.viewportBounds(right);
        left.x = clamp(left.x - unitX * moveLeft, leftBounds.minX, leftBounds.maxX);
        left.y = clamp(left.y - unitY * moveLeft, leftBounds.minY, leftBounds.maxY);
        right.x = clamp(right.x + unitX * moveRight, rightBounds.minX, rightBounds.maxX);
        right.y = clamp(right.y + unitY * moveRight, rightBounds.minY, rightBounds.maxY);
        if (!left.dragging && !left.reaction && !left.pinnedKey) {
          left.targetX = left.x;
          left.targetY = left.y;
        }
        if (!right.dragging && !right.reaction && !right.pinnedKey) {
          right.targetX = right.x;
          right.targetY = right.y;
        }
        this.render(left);
        this.render(right);
      }
    }
  }
}

// Compatibilidade para integrações que ainda importam o nome anterior.
export const SpriteEngine = SpriteReactionEngine;
