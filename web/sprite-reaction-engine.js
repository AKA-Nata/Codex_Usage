const SPRITES = {
  explorer: { name: "Explorador", url: "./assets/sprites/explorer.png" },
  wizard: { name: "Mago", url: "./assets/sprites/wizard.png" },
  mechanic: { name: "Mecânico", url: "./assets/sprites/mechanic.png" },
  orb: { name: "Orbital", url: "./assets/sprites/orb.png" },
};

const SPRITE_ORDER = ["explorer", "wizard", "mechanic", "orb"];

export const SPRITE_STATES = Object.freeze([
  "idle",
  "walk",
  "inspect",
  "point",
  "talk",
  "happy",
  "worried",
  "critical",
  "hot",
  "cold",
  "sleep",
  "wake",
  "confused",
  "celebrate",
]);

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

function normalizedIdleSeconds(panelIdle, systemIdle) {
  const candidates = [finiteNumber(panelIdle), finiteNumber(systemIdle)]
    .filter(value => value !== null)
    .map(value => Math.max(0, value));
  return candidates.length ? Math.min(...candidates) : 0;
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
  const hour = clockHour(clock, now);

  return {
    kind: "sprite-context-v1",
    observedAt: now,
    codex: {
      fiveHourPercent: finitePercent(fiveHour.remaining_percent),
      weeklyPercent: finitePercent(weekly.remaining_percent),
      fiveHourResetAtMs,
      weeklyResetAtMs,
      fiveHourResetSeconds: secondsUntil(fiveHourResetAtMs, fiveHour.reset_after_seconds, now, collectedAtMs),
      weeklyResetSeconds: secondsUntil(weeklyResetAtMs, weekly.reset_after_seconds, now, collectedAtMs),
      limitReached: usage.limit_reached === true || usage.allowed === false,
    },
    machine: {
      status: normalizeStatus(machine.status),
      cpuPercent: finitePercent(machine.cpu_percent),
      memoryPercent: finitePercent(machine.memory_percent),
      diskPercent: finitePercent(machine.disk_percent),
      systemIdleSeconds: finiteNumber(machine.system_idle_seconds),
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
      time: String(clock.time || "").trim(),
      date: String(clock.date || "").trim(),
      hour,
      period: dayPeriod(hour),
    },
    idleSeconds: normalizedIdleSeconds(raw.panelIdleSeconds ?? raw.idleSeconds, machine.system_idle_seconds),
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
    signature: values.signature || values.key,
    topic: values.topic || values.key,
    priority: values.priority || 0,
    anchor: values.anchor || null,
    state: SPRITE_STATES.includes(values.state) ? values.state : "talk",
    message: String(values.message || "").trim(),
    durationMs: values.durationMs || 4600,
    cooldownMs: values.cooldownMs || 60_000,
    persistent: Boolean(values.persistent),
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
    limitReached: data.codex.limitReached && (data.codex.fiveHourPercent !== null || data.codex.weeklyPercent === null),
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
    limitReached: data.codex.limitReached && data.codex.fiveHourPercent === null && data.codex.weeklyPercent !== null,
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

  const fiveBand = classifyCodexRemaining(data.codex.fiveHourPercent, data.codex.limitReached, thresholds);
  const weeklyBand = classifyCodexRemaining(data.codex.weeklyPercent, false, thresholds);
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
        Object.assign(existing, event, { queuedAt: existing.queuedAt });
        return;
      }
      const previousSignature = this.activeSignatures.get(event.key);
      const lastDispatched = this.lastDispatchedAt.get(event.key);
      const changed = previousSignature === undefined || previousSignature !== event.signature;
      const cooledDown = lastDispatched === undefined || observedAt - lastDispatched >= event.cooldownMs;
      if (changed || cooledDown) this._push({ ...event, queuedAt: observedAt });
    });

    this.activeSignatures = nextActive;
    this.pending = sortReactions(this.pending).slice(0, this.maxSize);
    return this.pending.length;
  }

  enqueueTransient(event, { force = false } = {}) {
    const observedAt = this.now();
    const existing = this.pending.find(item => item.key === event.key);
    if (existing) return false;
    const lastDispatched = this.lastDispatchedAt.get(event.key);
    if (!force && lastDispatched !== undefined && observedAt - lastDispatched < event.cooldownMs) return false;
    this._push({ ...event, transient: true, queuedAt: observedAt });
    this.pending = sortReactions(this.pending).slice(0, this.maxSize);
    return true;
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

export function selectCompanion(companions = [], event = {}, lastSpeakerId = null, now = Date.now()) {
  const available = companions.filter(companion => (
    !companion.dragging
    && !companion.reaction
    && !companion.pinnedKey
    && Number(companion.busyUntil || 0) <= now
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
  constructor({ root, getContext, onHumanInteraction, thresholds, cooldowns, now, random } = {}) {
    if (!root) throw new Error("SpriteReactionEngine requer um elemento root.");
    this.root = root;
    this.getContext = getContext;
    this.onHumanInteraction = onHumanInteraction;
    this.thresholds = mergeThresholds(thresholds);
    this.cooldowns = { ...DEFAULT_COOLDOWNS, ...(cooldowns || {}) };
    this.now = typeof now === "function" ? now : () => Date.now();
    this.random = typeof random === "function" ? random : Math.random;
    this.settings = {
      enabled: true,
      sprite: "explorer",
      count: 2,
      scale: 1,
      speed: 1,
      talkInterval: 18,
      roam: true,
      reactions: true,
      speech: true,
      movement: true,
    };
    this.companions = [];
    this.queue = new ReactionEventQueue({ now: this.now });
    this.context = normalizeSpriteData({}, this.now(), this.thresholds);
    this.rawContext = {};
    this.lastFrame = typeof performance !== "undefined" ? performance.now() : 0;
    this.lastSpeakerId = null;
    this.recentSpeech = new Map();
    this.started = false;
    this.frameRequest = null;
    this.nextContextAt = 0;
    this.nextAmbientAt = this.now() + 15_000;
    this.ambientCursor = 0;
    this.protectedRects = [];
    this.protectedRectsAt = 0;
    this.resizeTimer = null;
    this.reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") || null;
    this.reducedMotion = Boolean(this.reducedMotionQuery?.matches);

    this._boundFrame = timestamp => this.frame(timestamp);
    this._boundResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.reflow(), 100);
    };
    this._boundMotionChange = event => this.setReducedMotion(Boolean(event.matches));
    window.addEventListener("resize", this._boundResize);
    window.addEventListener("scroll", this._boundResize, { passive: true });
    this.reducedMotionQuery?.addEventListener?.("change", this._boundMotionChange);
  }

  configure(values = {}) {
    const previousCount = this.settings.count;
    const previousSprite = this.settings.sprite;
    const previousMovement = this.settings.movement;
    const previousRoam = this.settings.roam;
    const reactionsValue = values.reactions ?? values.smart;
    Object.assign(this.settings, values);
    if (reactionsValue !== undefined) this.settings.reactions = Boolean(reactionsValue);
    delete this.settings.smart;
    this.settings.count = clamp(Math.round(finiteNumber(this.settings.count) || 1), 1, 3);
    this.settings.scale = clamp(finiteNumber(this.settings.scale) || 1, 0.65, 1.35);
    this.settings.speed = clamp(finiteNumber(this.settings.speed) || 1, 0.55, 1.7);
    this.settings.talkInterval = clamp(finiteNumber(this.settings.talkInterval) || 18, 8, 45);
    this.settings.sprite = SPRITES[this.settings.sprite] ? this.settings.sprite : "explorer";
    ["enabled", "roam", "reactions", "speech", "movement"].forEach(key => {
      this.settings[key] = Boolean(this.settings[key]);
    });
    this.root.classList.toggle("hidden", !this.settings.enabled);
    this.root.dataset.reducedMotion = String(this.reducedMotion);

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
    this.companions.forEach(companion => companion.element.remove());
    this.companions = [];
  }

  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
    this.root.dataset.reducedMotion = String(this.reducedMotion);
    this.companions.forEach(companion => {
      companion.targetX = companion.x;
      companion.targetY = companion.y;
      if (companion.reaction) this.presentReaction(companion, this.now());
      else if (!companion.pinnedKey) this.setState(companion, "idle");
    });
  }

  effectiveMovement() {
    return this.settings.movement && !this.reducedMotion;
  }

  ingest(rawContext = {}) {
    this.rawContext = rawContext || {};
    this.context = normalizeSpriteData(this.rawContext, this.now(), this.thresholds);
    const events = evaluateReactions(this.context, this.thresholds, this.cooldowns);
    if (this.settings.reactions) this.queue.update(events);
    const activeKeys = new Set(events.map(event => event.key));
    this.companions.forEach(companion => {
      if (companion.pinnedKey && !activeKeys.has(companion.pinnedKey)) this.releasePinned(companion, true);
    });
    this.tryDispatch();
    return { context: this.context, events, queued: this.queue.size };
  }

  notifyUserInteraction(previousIdleSeconds = this.context.idleSeconds) {
    const idleSeconds = Math.max(0, finiteNumber(previousIdleSeconds) || 0);
    if (idleSeconds < this.thresholds.idleBoredSeconds) return false;
    this.queue.removeWhere(event => event.key.startsWith("idle-"));
    this.companions.forEach(companion => {
      if (companion.pinnedKey?.startsWith("idle-")) this.releasePinned(companion, false);
    });
    const queued = this.queue.enqueueTransient(buildWakeReaction(idleSeconds, this.cooldowns, this.thresholds));
    if (queued) this.tryDispatch();
    return queued;
  }

  rebuild() {
    this.companions.forEach(companion => companion.element.remove());
    this.companions = [];
    this.queue.activeSignatures.clear();
    this.root.classList.toggle("hidden", !this.settings.enabled);
    for (let index = 0; index < this.settings.count; index += 1) {
      const startIndex = Math.max(0, SPRITE_ORDER.indexOf(this.settings.sprite));
      const spriteType = SPRITE_ORDER[(startIndex + index) % SPRITE_ORDER.length];
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

  createCompanion(index, spriteType) {
    const sprite = SPRITES[spriteType];
    const element = document.createElement("button");
    element.type = "button";
    element.className = "sprite-companion state-idle";
    element.setAttribute("aria-label", `${sprite.name}, companheiro interativo`);
    element.dataset.sprite = spriteType;
    element.dataset.state = "idle";
    element.innerHTML = `
      <span class="sprite-shadow" aria-hidden="true"></span>
      <span class="sprite-body" aria-hidden="true"></span>
      <span class="sprite-effect" aria-hidden="true"></span>
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
      x: 8 + index * 80,
      y: 64 + index * 72,
      targetX: 8 + index * 80,
      targetY: 64 + index * 72,
      state: "idle",
      dragging: false,
      pointerMoved: false,
      dragOffsetX: 0,
      dragOffsetY: 0,
      reaction: null,
      pinnedKey: null,
      pinnedEvent: null,
      anchorKey: null,
      stageUntil: 0,
      dwellUntil: 0,
      bubbleUntil: 0,
      busyUntil: 0,
      nextRoamAt: this.now() + randomBetween(2500, 7000, this.random),
      lastSpokeAt: 0,
      lastTopic: null,
    };
    companion.nameElement.textContent = companion.name;
    this.applyCompanionStyle(companion);
    this.bindPointer(companion);
    return companion;
  }

  applyCompanionStyle(companion) {
    companion.body.style.setProperty("--sprite-url", `url("${SPRITES[companion.type].url}")`);
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
      this.onHumanInteraction?.();
      const rect = element.getBoundingClientRect();
      companion.dragging = true;
      companion.pointerMoved = false;
      companion.dragOffsetX = event.clientX - rect.left;
      companion.dragOffsetY = event.clientY - rect.top;
      element.classList.add("dragging");
      this.setState(companion, "idle");
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
      element.classList.remove("dragging");
      try { element.releasePointerCapture?.(event.pointerId); } catch {}
      this.separateCompanions();
      if (!companion.pointerMoved) {
        this.speakImmediate(companion);
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
    };
    element.addEventListener("pointerup", endDrag);
    element.addEventListener("pointercancel", endDrag);
    element.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      this.onHumanInteraction?.();
      this.speakImmediate(companion);
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
    this.companions.forEach(other => {
      if (other === companion || other === ignoreCompanion) return;
      const otherSize = this.companionSize(other);
      const otherRect = rectAt(other.targetX ?? other.x, other.targetY ?? other.y, otherSize);
      score += rectIntersectionArea(rect, otherRect, this.thresholds.minSpriteGap) * 50;
    });
    const bounds = this.viewportBounds(companion);
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) score += 1_000_000;
    return score;
  }

  anchorPosition(anchorKey, companion) {
    if (!anchorKey) return null;
    const anchor = document.querySelector(`[data-sprite-anchor="${anchorKey}"]`);
    if (!anchor) return null;
    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 12 || rect.top > window.innerHeight - 12) return null;
    const size = this.companionSize(companion);
    const gap = 10;
    const candidates = [
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
    ];
    const bounds = this.viewportBounds(companion);
    const ranked = candidates.map(candidate => {
      const x = clamp(candidate.x, bounds.minX, bounds.maxX);
      const y = clamp(candidate.y, bounds.minY, bounds.maxY);
      const distance = Math.hypot(x - companion.x, y - companion.y);
      const anchorObstacle = candidate.inside ? null : rect;
      const insidePenalty = candidate.inside ? 140 : 0;
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
    const position = this.findSafeRoamPosition(companion, companion.id - 1, true);
    if (!position) return false;
    companion.targetX = position.x;
    companion.targetY = position.y;
    companion.anchorKey = null;
    companion.nextRoamAt = this.now() + randomBetween(6500, 13_500, this.random);
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
    const nextState = SPRITE_STATES.includes(state) ? state : "idle";
    companion.element.classList.remove(...STATE_CLASSES);
    companion.element.classList.add(`state-${nextState}`);
    companion.element.dataset.state = nextState;
    companion.state = nextState;
    this.updateContentLayer(companion);
  }

  updateContentLayer(companion) {
    if (!companion?.element || companion.dragging || companion.state === "walk") {
      companion?.element?.classList.remove("behind-content");
      return;
    }
    const bodyRect = rectAt(companion.x, companion.y, this.companionSize(companion));
    const overlapsContent = this.refreshProtectedRects().some(protectedRect => rectIntersectionArea(bodyRect, protectedRect, 2) > 0);
    companion.element.classList.toggle("behind-content", overlapsContent);
    if (overlapsContent) this.hideBubble(companion);
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
      const speed = 92 * this.settings.speed;
      const step = Math.min(distance, speed * deltaSeconds);
      const nextX = companion.x + (dx / distance) * step;
      const nextY = companion.y + (dy / distance) * step;
      const blockedByCompanion = this.companions.some(other => {
        if (other === companion || other.dragging) return false;
        const minimum = (this.companionSize(companion) + this.companionSize(other)) * 0.36 + this.thresholds.minSpriteGap;
        return Math.hypot(nextX - other.x, nextY - other.y) < minimum && companion.id > other.id;
      });
      if (!blockedByCompanion) {
        companion.x = nextX;
        companion.y = nextY;
        companion.element.classList.toggle("facing-left", dx < 0);
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
    const durationMs = this.settings.speech ? companion.reaction.durationMs : Math.min(2600, companion.reaction.durationMs);
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
    if (event.persistent && this.queue.hasActive(event.key)) {
      companion.pinnedKey = event.key;
      companion.pinnedEvent = event;
      this.setState(companion, event.state);
      return;
    }
    companion.anchorKey = null;
    companion.dwellUntil = 0;
    this.setState(companion, "idle");
    companion.nextRoamAt = wallNow + randomBetween(1200, 3000, this.random);
  }

  releasePinned(companion, resumeRoam = true) {
    companion.pinnedKey = null;
    companion.pinnedEvent = null;
    companion.anchorKey = null;
    if (!companion.dragging && !companion.reaction) this.setState(companion, "idle");
    if (resumeRoam && this.settings.roam && this.effectiveMovement()) {
      companion.nextRoamAt = this.now() + 700;
    }
  }

  dispatchReaction(companion, event) {
    if (!companion || !event) return false;
    companion.reaction = { ...event, stage: "travel" };
    companion.pinnedKey = null;
    companion.pinnedEvent = null;
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
    return true;
  }

  tryDispatch() {
    if (!this.settings.enabled || !this.settings.reactions || !this.companions.length) return false;
    const wallNow = this.now();
    const presenting = this.companions.some(companion => (
      companion.reaction || (companion.bubbleUntil && companion.bubbleUntil > wallNow)
    ));
    if (presenting) return false;
    const companion = selectCompanion(this.companions, this.queue.pending[0], this.lastSpeakerId, wallNow);
    if (!companion) return false;
    const event = this.queue.dequeue(() => true);
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
    this.updateBubblePlacement(companion);
  }

  hideBubble(companion) {
    companion.bubbleUntil = 0;
    companion.element.classList.remove("talking");
  }

  updateBubblePlacement(companion) {
    const size = this.companionSize(companion);
    const estimatedWidth = Math.min(260, window.innerWidth * 0.7);
    companion.element.classList.toggle("bubble-right", companion.x + size * 0.5 < estimatedWidth * 0.55);
    companion.element.classList.toggle("bubble-left", companion.x + size * 0.5 > window.innerWidth - estimatedWidth * 0.55);
    companion.element.classList.toggle("bubble-below", companion.y < 105);
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
    if (!this.settings.speech || wallNow < this.nextAmbientAt || this.queue.size || this.companions.some(companion => companion.reaction)) return;
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
