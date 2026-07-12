import {
  evaluateConfiguredTriggers,
  normalizeSpriteData,
  resolveSpriteMacroValues,
  validateSpriteBehaviorConfig,
} from "./sprite-reaction-engine.js";


export const STUDIO_CARDS = Object.freeze(["hora", "interacao", "temperatura", "maquina", "codex_5h", "codex_semanal", "status"]);
export const STUDIO_CHARACTERS = Object.freeze(["auto", "explorer", "wizard", "mechanic", "orb"]);
export const STUDIO_STATES = Object.freeze(["idle", "walk", "inspect", "point", "talk", "happy", "worried", "critical", "hot", "cold", "sleep", "wake", "confused", "celebrate"]);
export const STUDIO_OPERATORS = Object.freeze([">", ">=", "<", "<=", "==", "between"]);
export const STUDIO_EVENTS = Object.freeze(["user_return", "collection_error", "collection_stale", "collection_recovery", "value_change", "click", "drag", "random_interval"]);
export const STUDIO_CHANGE_FIELDS = Object.freeze({
  hora: { input: "time", type: "string" },
  temperatura: { input: "temperature", type: "number" },
  clima: { input: "weather", type: "string" },
  cpu: { input: "cpu", type: "number" },
  ram: { input: "ram", type: "number" },
  disco: { input: "disk", type: "number" },
  gpu: { input: "gpu", type: "number" },
  gpu_memoria: { input: "gpuMemory", type: "number" },
  codex_5h_percentual: { input: "fiveHourPercent", type: "number" },
  codex_5h_reset: { input: "fiveHourResetSeconds", type: "number" },
  codex_5h_atingido: { input: "fiveHourLimitReached", type: "boolean" },
  codex_semanal_percentual: { input: "weeklyPercent", type: "number" },
  codex_semanal_reset: { input: "weeklyResetSeconds", type: "number" },
  codex_semanal_atingido: { input: "weeklyLimitReached", type: "boolean" },
  tempo_sem_interacao: { input: "idleSeconds", type: "number" },
  coleta_status: { input: "collectionState", type: "string" },
});


export function cloneStudioValue(value) {
  return JSON.parse(JSON.stringify(value));
}


export function studioIdentifier(value, fallback = "item") {
  const normalized = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^[^a-z]+/, "");
  return normalized || fallback;
}


function uniqueId(items, seed, ignoredId = null) {
  const existing = new Set(items.map(item => item.id).filter(id => id !== ignoredId));
  const base = studioIdentifier(seed);
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}


export function humanizeStudioId(identifier) {
  const text = String(identifier || "").replaceAll("_", " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "Sem nome";
}


export function createStudioTrigger(config, values = {}) {
  const next = cloneStudioValue(config);
  const name = String(values.name || "Novo comportamento").trim();
  const id = uniqueId(next.triggers || [], values.id || name || "novo_comportamento");
  const trigger = {
    id,
    name,
    enabled: values.enabled !== false,
    when: values.when || { metric: "cpu", operator: ">", value: 75 },
    targetCard: values.targetCard || "maquina",
    character: values.character || "auto",
    spriteState: values.spriteState || "inspect",
    phrases: values.phrases?.length ? [...values.phrases] : ["CPU em {{cpu}}%."],
    fallbackPhrase: values.fallbackPhrase || "Tenho uma atualização para você.",
    preventRepeat: values.preventRepeat !== false,
    priority: Number.isInteger(values.priority) ? values.priority : 50,
    cooldownSeconds: Number.isFinite(Number(values.cooldownSeconds)) ? Number(values.cooldownSeconds) : 60,
    durationSeconds: Number.isFinite(Number(values.durationSeconds)) ? Number(values.durationSeconds) : 5,
    persistent: Boolean(values.persistent),
    repeatWhileActive: values.repeatWhileActive !== false,
    holdSeconds: Number.isFinite(Number(values.holdSeconds)) ? Number(values.holdSeconds) : 0,
  };
  next.triggers = [...(next.triggers || []), trigger];
  return { config: next, trigger: cloneStudioValue(trigger) };
}


export function updateStudioTrigger(config, identifier, values) {
  const next = cloneStudioValue(config);
  const index = (next.triggers || []).findIndex(trigger => trigger.id === identifier);
  if (index < 0) throw new Error(`Gatilho não encontrado: ${identifier}.`);
  const candidate = { ...next.triggers[index], ...cloneStudioValue(values) };
  if (candidate.id !== identifier) candidate.id = uniqueId(next.triggers, candidate.id, identifier);
  next.triggers[index] = candidate;
  return { config: next, trigger: cloneStudioValue(candidate) };
}


export function replaceStudioTrigger(config, identifier, values) {
  const next = cloneStudioValue(config);
  const index = (next.triggers || []).findIndex(trigger => trigger.id === identifier);
  if (index < 0) throw new Error(`Gatilho não encontrado: ${identifier}.`);
  const candidate = cloneStudioValue(values);
  if (candidate.id !== identifier) candidate.id = uniqueId(next.triggers, candidate.id, identifier);
  next.triggers[index] = candidate;
  return { config: next, trigger: cloneStudioValue(candidate) };
}


export function duplicateStudioTrigger(config, identifier) {
  const source = (config.triggers || []).find(trigger => trigger.id === identifier);
  if (!source) throw new Error(`Gatilho não encontrado: ${identifier}.`);
  const next = cloneStudioValue(config);
  const copy = {
    ...cloneStudioValue(source),
    id: uniqueId(next.triggers, `${source.id}_copia`),
    name: `${source.name || humanizeStudioId(source.id)} (cópia)`,
    enabled: false,
  };
  next.triggers.push(copy);
  return { config: next, trigger: cloneStudioValue(copy) };
}


export function removeStudioTrigger(config, identifier) {
  const next = cloneStudioValue(config);
  const before = (next.triggers || []).length;
  next.triggers = (next.triggers || []).filter(trigger => trigger.id !== identifier);
  if (next.triggers.length === before) throw new Error(`Gatilho não encontrado: ${identifier}.`);
  return next;
}


export function setStudioTriggerEnabled(config, identifier, enabled) {
  return updateStudioTrigger(config, identifier, { enabled: Boolean(enabled) });
}


export function createStudioPhraseGroup(config, values = {}) {
  const next = cloneStudioValue(config);
  const id = uniqueId(next.phrases || [], values.id || "nova_fala");
  const group = { id, texts: values.texts?.length ? [...values.texts] : ["Nova fala com {{hora}}."], weight: Number(values.weight) > 0 ? Number(values.weight) : 1 };
  next.phrases = [...(next.phrases || []), group];
  return { config: next, phrase: cloneStudioValue(group) };
}


export function updateStudioPhraseGroup(config, identifier, values) {
  const next = cloneStudioValue(config);
  const index = (next.phrases || []).findIndex(group => group.id === identifier);
  if (index < 0) throw new Error(`Grupo de falas não encontrado: ${identifier}.`);
  const candidate = { ...next.phrases[index], ...cloneStudioValue(values) };
  if (candidate.id !== identifier) candidate.id = uniqueId(next.phrases, candidate.id, identifier);
  next.phrases[index] = candidate;
  if (candidate.id !== identifier) {
    next.triggers = (next.triggers || []).map(trigger => ({
      ...trigger,
      ...(Array.isArray(trigger.phraseRefs) ? { phraseRefs: trigger.phraseRefs.map(id => id === identifier ? candidate.id : id) } : {}),
    }));
    const casualIds = next.defaultBehavior?.casualSpeech?.phraseIds;
    if (Array.isArray(casualIds)) next.defaultBehavior.casualSpeech.phraseIds = casualIds.map(id => id === identifier ? candidate.id : id);
  }
  return { config: next, phrase: cloneStudioValue(candidate) };
}


export function duplicateStudioPhraseGroup(config, identifier) {
  const source = (config.phrases || []).find(group => group.id === identifier);
  if (!source) throw new Error(`Grupo de falas não encontrado: ${identifier}.`);
  const next = cloneStudioValue(config);
  const copy = { ...cloneStudioValue(source), id: uniqueId(next.phrases, `${source.id}_copia`) };
  next.phrases.push(copy);
  return { config: next, phrase: cloneStudioValue(copy) };
}


export function removeStudioPhraseGroup(config, identifier) {
  const referenced = (config.triggers || []).filter(trigger => (trigger.phraseRefs || []).includes(identifier));
  const defaultReferenced = (config.defaultBehavior?.casualSpeech?.phraseIds || []).includes(identifier);
  if (referenced.length || defaultReferenced) {
    const total = referenced.length + Number(defaultReferenced);
    throw new Error(`A fala é usada por ${total} comportamento(s). Remova as referências primeiro.`);
  }
  const next = cloneStudioValue(config);
  next.phrases = (next.phrases || []).filter(group => group.id !== identifier);
  if ((next.phrases || []).length === (config.phrases || []).length) throw new Error(`Grupo de falas não encontrado: ${identifier}.`);
  return next;
}


export function flattenStudioWhen(when) {
  const group = Array.isArray(when?.all) ? "all" : Array.isArray(when?.any) ? "any" : "all";
  const nodes = when?.[group] || (when ? [when] : []);
  return { group, nodes: cloneStudioValue(nodes) };
}


export function hasNestedStudioCondition(when) {
  const rootGroup = Array.isArray(when?.all) ? when.all : Array.isArray(when?.any) ? when.any : null;
  return Boolean(rootGroup?.some(node => Array.isArray(node?.all) || Array.isArray(node?.any)));
}


function comparisonValue(row) {
  if (row.value === "" || row.value === null || row.value === undefined) throw new Error("Informe o valor da comparação.");
  if (row.operator === "between") {
    if (row.valueMax === "" || row.valueMax === null || row.valueMax === undefined) throw new Error("Informe os dois limites de between.");
    const minimum = Number(row.value);
    const maximum = Number(row.valueMax);
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) throw new Error("Os limites de between devem ser numéricos.");
    if (maximum < minimum) throw new Error("O limite final de between deve ser maior ou igual ao inicial.");
    return [minimum, maximum];
  }
  if (row.valueType === "boolean") return String(row.value) === "true";
  if (row.valueType === "string") return String(row.value ?? "");
  const numeric = Number(row.value);
  if (!Number.isFinite(numeric)) throw new Error("Informe um valor numérico válido.");
  return numeric;
}


export function buildStudioWhen(group, rows) {
  const nodes = rows.map(row => {
    if (row.kind === "timeExact") {
      const time = row.time || "12:00";
      return { timeRange: { start: time, end: time } };
    }
    if (row.kind === "timeRange") {
      const timeRange = { start: row.start || "00:00", end: row.end || row.start || "23:59" };
      if (Array.isArray(row.days) && row.days.length) timeRange.days = [...row.days];
      return { timeRange };
    }
    if (row.kind === "event") {
      const event = { type: row.eventType || "click" };
      if (event.type === "value_change") {
        event.metric = row.metric || "cpu";
        if (Number.isFinite(Number(row.minDelta))) event.minDelta = Number(row.minDelta);
        if (Number.isFinite(Number(row.minIntervalSeconds))) event.minIntervalSeconds = Number(row.minIntervalSeconds);
      }
      if (event.type === "click") event.card = row.card || "maquina";
      if (event.type === "drag") event.phase = row.phase || "end";
      if (event.type === "random_interval") {
        const min = Math.max(0, Number(row.intervalMin) || 0);
        event.intervalSeconds = { min, max: Math.max(min, Number(row.intervalMax) || min) };
      }
      return { event };
    }
    return { metric: row.metric || "cpu", operator: row.operator || ">", value: comparisonValue(row) };
  });
  if (nodes.length === 1) return nodes[0];
  return { [group === "any" ? "any" : "all"]: nodes };
}


export function extractStudioMacros(text) {
  const source = String(text || "");
  const names = [...source.matchAll(/{{\s*([a-z][a-z0-9_]*)\s*}}/g)].map(match => match[1]);
  const malformed = (source.match(/{{[^{}]*}}/g) || []).filter(token => !/^{{\s*[a-z][a-z0-9_]*\s*}}$/.test(token));
  if ((source.match(/{{/g) || []).length !== (source.match(/}}/g) || []).length) malformed.push("chaves desbalanceadas");
  return { names, malformed: [...new Set(malformed)] };
}


export function validateStudioSpeech(config, texts) {
  const declared = new Set(Object.keys(config.macros || {}));
  const errors = [];
  texts.forEach((text, index) => {
    const report = extractStudioMacros(text);
    report.malformed.forEach(token => errors.push({ index, code: "malformed_macro", message: `Macro malformada: ${token}.` }));
    report.names.filter(name => !declared.has(name)).forEach(name => errors.push({ index, code: "unknown_macro", message: `Macro não declarada: ${name}.` }));
  });
  return { valid: errors.length === 0, errors };
}


function isoAtOffset(now, seconds) {
  const numeric = Number(seconds);
  return Number.isFinite(numeric) ? new Date(now + Math.max(0, numeric) * 1000).toISOString() : null;
}


export function buildStudioSimulationInput(values = {}, now = Date.now()) {
  const observed = new Date(now);
  const time = values.time || observed.toLocaleTimeString("pt-BR", { hour12: false });
  const date = values.date || observed.toLocaleDateString("pt-BR");
  const collectionState = values.collectionState || "ok";
  const collectedAt = collectionState === "missing"
    ? null
    : new Date(now - Math.max(0, Number(values.collectionAgeMinutes) || 0) * 60000).toISOString();
  return {
    usage: {
      collected_at: collectedAt,
      resets: {
        limite_5h: {
          remaining_percent: values.fiveHourPercent ?? 70,
          reset_at: values.fiveHourResetAt || isoAtOffset(now, values.fiveHourResetSeconds ?? 7200),
          limit_reached: Boolean(values.fiveHourLimitReached),
        },
        limite_semanal: {
          remaining_percent: values.weeklyPercent ?? 70,
          reset_at: values.weeklyResetAt || isoAtOffset(now, values.weeklyResetSeconds ?? 86400),
          limit_reached: Boolean(values.weeklyLimitReached),
        },
      },
    },
    health: {
      status: collectionState === "error" ? "error" : "ok",
      message: collectionState === "error" ? "Falha simulada da coleta" : "Simulação local",
    },
    telemetry: {
      generated_at: observed.toISOString(),
      clock: { time, date, iso: observed.toISOString() },
      machine: {
        status: values.machineState || "ok",
        cpu_percent: values.cpu ?? 35,
        memory_percent: values.ram ?? 45,
        disk_percent: values.disk ?? 55,
        gpu_percent: values.gpu ?? null,
        gpu_memory_percent: values.gpuMemory ?? null,
        system_idle_seconds: values.systemIdleSeconds ?? values.idleSeconds ?? 0,
      },
      weather: {
        status: values.weatherState || "ok",
        temperature_c: values.temperature ?? 24,
        condition: values.weather || "Céu limpo",
        weather_code: values.weatherCode ?? 0,
      },
    },
    panelIdleSeconds: values.idleSeconds ?? 0,
    errors: { telemetry: values.telemetryError || "", status: "" },
  };
}


function simulationRuntimeEvent(values, sequence = 1) {
  if (!values.eventType || values.eventType === "auto") return null;
  const event = { type: values.eventType, sequence };
  if (values.eventType === "click") event.card = values.eventCard || "maquina";
  if (values.eventType === "drag") event.phase = values.dragPhase || "end";
  if (values.eventType === "user_return") event.idleSeconds = Number(values.idleSeconds) || 0;
  return event;
}


export function runStudioSimulation(config, values = {}, options = {}) {
  const now = Number(options.now) || Date.now();
  const scenarioValues = { ...values };
  if (scenarioValues.eventType === "collection_error") scenarioValues.collectionState = "error";
  if (scenarioValues.eventType === "collection_stale") scenarioValues.collectionAgeMinutes = Math.max(60, Number(scenarioValues.collectionAgeMinutes) || 0);
  if (scenarioValues.eventType === "collection_recovery") scenarioValues.collectionState = "ok";
  const rawInput = buildStudioSimulationInput(scenarioValues, now);
  const context = normalizeSpriteData(rawInput, now);
  let previousContext = null;
  if (options.previousValues) previousContext = normalizeSpriteData(buildStudioSimulationInput(options.previousValues, now - 1000), now - 1000);
  else if (scenarioValues.eventType === "collection_recovery") previousContext = normalizeSpriteData(buildStudioSimulationInput({ ...scenarioValues, collectionState: "error" }, now - 1000), now - 1000);
  else if (scenarioValues.eventType === "value_change") {
    const changeSpec = STUDIO_CHANGE_FIELDS[scenarioValues.changeMetric] || STUDIO_CHANGE_FIELDS.temperatura;
    let previousValue = scenarioValues.changeFrom;
    if (changeSpec.type === "number") previousValue = Number(scenarioValues.changeFrom);
    if (changeSpec.type === "boolean") previousValue = String(scenarioValues.changeFrom) === "true";
    previousContext = normalizeSpriteData(buildStudioSimulationInput({ ...scenarioValues, [changeSpec.input]: previousValue }, now - 1000), now - 1000);
  }
  const event = simulationRuntimeEvent(scenarioValues);
  const events = evaluateConfiguredTriggers(context, config, {
    now,
    previousContext,
    event,
    eventOnly: Boolean(event),
    random: options.random || (() => 0),
  });
  const compiledReport = validateSpriteBehaviorConfig(config);
  return {
    valid: compiledReport.valid,
    errors: compiledReport.errors,
    context,
    macros: resolveSpriteMacroValues(context, config),
    events,
    realDataMutated: false,
  };
}
