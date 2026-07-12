import {
  ReactionEventQueue,
  SPRITE_BEHAVIOR_OPERATORS,
  buildWakeReaction,
  classifyCodexRemaining,
  compareSpriteOperator,
  compileSpriteBehaviorConfig,
  evaluateConfiguredTriggers,
  evaluateSpriteCondition,
  evaluateReactions,
  loadSpriteBehaviorConfig,
  normalizeSpriteData,
  renderSpritePhrase,
  resolveSpriteMacroValues,
  selectCompanion,
  selectPreemptableCompanion,
  validateSpriteBehaviorConfig,
} from "../../web/sprite-reaction-engine.js";

const NOW = Date.UTC(2026, 6, 11, 15, 0, 0);

async function readJsonFixture(relativePath) {
  const url = new URL(relativePath, import.meta.url);
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    return JSON.parse(await readFile(url, "utf8"));
  }
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Falha ao carregar fixture: HTTP ${response.status}`);
  return response.json();
}

let behaviorConfigPromise = null;
function actualBehaviorConfig() {
  behaviorConfigPromise ||= readJsonFixture("../../web/config/sprite-behaviors.json");
  return behaviorConfigPromise;
}

function resetAt(seconds) {
  return seconds === null ? null : new Date(NOW + seconds * 1000).toISOString();
}

function makeContext({
  fiveHour = 80,
  weekly = 80,
  fiveHourResetSeconds = null,
  weeklyResetSeconds = null,
  limitReached = false,
  allowed = true,
  fiveHourLimitReached = null,
  weeklyLimitReached = null,
  cpu = null,
  memory = null,
  disk = null,
  machineStatus = "ok",
  temperature = null,
  weatherCode = null,
  weatherCondition = "",
  panelIdleSeconds = 0,
  systemIdleSeconds = null,
  healthStatus = "ok",
  healthMessage = "",
  collectedAt = new Date(NOW).toISOString(),
  statusError = "",
  telemetryError = "",
} = {}) {
  return normalizeSpriteData({
    usage: {
      collected_at: collectedAt,
      limit_reached: limitReached,
      allowed,
      resets: {
        limite_5h: {
          found: fiveHour !== null,
          remaining_percent: fiveHour,
          reset_at: resetAt(fiveHourResetSeconds),
          limit_reached: fiveHourLimitReached,
        },
        limite_semanal: {
          found: weekly !== null,
          remaining_percent: weekly,
          reset_at: resetAt(weeklyResetSeconds),
          limit_reached: weeklyLimitReached,
        },
      },
    },
    health: { status: healthStatus, message: healthMessage },
    settings: { stale_after_minutes: 45 },
    telemetry: {
      clock: { iso: new Date(NOW).toISOString(), time: "12:00", date: "11/07/2026" },
      machine: {
        status: machineStatus,
        cpu_percent: cpu,
        memory_percent: memory,
        disk_percent: disk,
        system_idle_seconds: systemIdleSeconds,
      },
      weather: {
        status: "ok",
        temperature_c: temperature,
        weather_code: weatherCode,
        condition: weatherCondition,
      },
    },
    panelIdleSeconds,
    errors: { status: statusError, telemetry: telemetryError },
  }, NOW);
}

function eventByKey(context, key) {
  return evaluateReactions(context).find(event => event.key === key);
}

function hasEvent(context, key) {
  return Boolean(eventByKey(context, key));
}

function companions(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    dragging: false,
    reaction: null,
    pinnedKey: null,
    busyUntil: 0,
    lastTopic: null,
    lastSpokeAt: (index + 1) * 100,
  }));
}

export const spriteReactionEngineCases = [
  {
    name: "classifica exatamente os limites 61/60/30/29/10/9/0",
    run(assert) {
      const actual = [61, 60, 30, 29, 10, 9, 0]
        .map(value => classifyCodexRemaining(value));
      assert.deepEqual(actual, ["normal", "visit", "worried", "worried", "worried", "critical", "critical"]);
    },
  },
  {
    name: "limitReached prevalece sobre percentual e null é inválido",
    run(assert) {
      assert.equal(classifyCodexRemaining(99, true), "critical");
      assert.equal(classifyCodexRemaining(null), "invalid");
      assert.equal(classifyCodexRemaining("inválido"), "invalid");
    },
  },
  {
    name: "normaliza janelas de 5h, semanal e tempos de reset",
    run(assert) {
      const context = makeContext({
        fiveHour: 60,
        weekly: 29,
        fiveHourResetSeconds: 600,
        weeklyResetSeconds: 3600,
      });
      assert.equal(context.codex.fiveHourPercent, 60);
      assert.equal(context.codex.weeklyPercent, 29);
      assert.equal(context.codex.fiveHourResetSeconds, 600);
      assert.equal(context.codex.weeklyResetSeconds, 3600);
    },
  },
  {
    name: "gera reação contextual para cada faixa do limite de 5h",
    run(assert) {
      const expected = new Map([
        [61, "codex-normal"],
        [60, "codex-5h-visit"],
        [30, "codex-5h-worried"],
        [29, "codex-5h-worried"],
        [10, "codex-5h-worried"],
        [9, "codex-5h-critical"],
        [0, "codex-5h-critical"],
      ]);
      expected.forEach((key, value) => {
        assert.ok(hasEvent(makeContext({ fiveHour: value }), key), `${value}% deveria gerar ${key}`);
      });
    },
  },
  {
    name: "limitReached produz reação crítica em 5h e semanal",
    run(assert) {
      const fiveHour = makeContext({ fiveHour: 80, limitReached: true });
      assert.equal(eventByKey(fiveHour, "codex-5h-critical")?.state, "critical");

      const weekly = makeContext({ fiveHour: null, weekly: 80, limitReached: true });
      assert.equal(eventByKey(weekly, "codex-weekly-critical")?.state, "critical");
    },
  },
  {
    name: "reset próximo gera expectativa para 5h e semanal",
    run(assert) {
      const context = makeContext({
        fiveHour: 50,
        weekly: 50,
        fiveHourResetSeconds: 10 * 60,
        weeklyResetSeconds: 20 * 60,
      });
      assert.equal(eventByKey(context, "codex-5h-reset-soon")?.state, "celebrate");
      assert.equal(eventByKey(context, "codex-weekly-reset-soon")?.state, "celebrate");
      assert.ok(!hasEvent(makeContext({ fiveHour: 50, fiveHourResetSeconds: 31 * 60 }), "codex-5h-reset-soon"));
    },
  },
  {
    name: "CPU respeita limites 75, >75, 90 e >90",
    run(assert) {
      assert.ok(!hasEvent(makeContext({ cpu: 75 }), "machine-high"));
      assert.equal(eventByKey(makeContext({ cpu: 75.1 }), "machine-high")?.state, "hot");
      assert.equal(eventByKey(makeContext({ cpu: 90 }), "machine-high")?.state, "hot");
      assert.equal(eventByKey(makeContext({ cpu: 90.1 }), "machine-critical")?.state, "critical");
    },
  },
  {
    name: "RAM respeita limites 75, >75, 90 e >90",
    run(assert) {
      assert.ok(!hasEvent(makeContext({ memory: 75 }), "machine-high"));
      assert.equal(eventByKey(makeContext({ memory: 75.1 }), "machine-high")?.state, "hot");
      assert.equal(eventByKey(makeContext({ memory: 90 }), "machine-high")?.state, "hot");
      assert.equal(eventByKey(makeContext({ memory: 90.1 }), "machine-critical")?.state, "critical");
    },
  },
  {
    name: "disco tem faixas alta e crítica próprias",
    run(assert) {
      assert.ok(!hasEvent(makeContext({ disk: 85 }), "machine-high"));
      assert.equal(eventByKey(makeContext({ disk: 85.1 }), "machine-high")?.state, "worried");
      assert.equal(eventByKey(makeContext({ disk: 95 }), "machine-high")?.state, "worried");
      assert.equal(eventByKey(makeContext({ disk: 95.1 }), "machine-critical")?.state, "critical");
    },
  },
  {
    name: "frio, calor e chuva produzem estados coerentes",
    run(assert) {
      assert.equal(eventByKey(makeContext({ temperature: 12 }), "weather-cold")?.state, "cold");
      assert.equal(eventByKey(makeContext({ temperature: 30 }), "weather-hot")?.state, "hot");
      assert.equal(eventByKey(makeContext({ weatherCode: 61 }), "weather-rain")?.state, "worried");
      assert.ok(hasEvent(makeContext({ weatherCondition: "Pancadas de chuva" }), "weather-rain"));
    },
  },
  {
    name: "falha e coleta desatualizada vencem eventos menos prioritários",
    run(assert) {
      const failure = makeContext({
        fiveHour: 0,
        cpu: 99,
        healthStatus: "error",
        healthMessage: "CDP indisponível",
      });
      const failureEvents = evaluateReactions(failure);
      assert.equal(failureEvents[0].key, "collection-error");
      assert.ok(failureEvents.every((event, index) => index === 0 || failureEvents[index - 1].priority >= event.priority));

      const stale = makeContext({ collectedAt: new Date(NOW - 46 * 60 * 1000).toISOString() });
      assert.equal(evaluateReactions(stale)[0].key, "collection-stale");
    },
  },
  {
    name: "fila aplica prioridade, cooldown e mudança relevante",
    run(assert) {
      let clock = 1000;
      const queue = new ReactionEventQueue({ now: () => clock });
      const low = { key: "low", signature: "low:a", priority: 10, cooldownMs: 1000 };
      const high = { key: "high", signature: "high:a", priority: 100, cooldownMs: 1000 };

      queue.update([low, high]);
      assert.equal(queue.dequeue().key, "high");
      assert.equal(queue.dequeue().key, "low");

      clock += 500;
      queue.update([low]);
      assert.equal(queue.size, 0);

      queue.update([{ ...low, signature: "low:b" }]);
      assert.equal(queue.dequeue()?.signature, "low:b");

      clock += 1000;
      queue.update([{ ...low, signature: "low:b" }]);
      assert.equal(queue.dequeue()?.signature, "low:b");
    },
  },
  {
    name: "inatividade evolui de tédio para sono e retorno acorda",
    run(assert) {
      assert.ok(hasEvent(makeContext({ panelIdleSeconds: 300 }), "idle-bored"));
      assert.ok(!hasEvent(makeContext({ panelIdleSeconds: 899 }), "idle-sleep"));
      assert.equal(eventByKey(makeContext({ panelIdleSeconds: 900 }), "idle-sleep")?.state, "sleep");

      const wake = buildWakeReaction(900);
      assert.equal(wake.state, "wake");
      assert.equal(wake.signature, "user-returned:sleep");
      assert.equal(wake.transient, true);
      assert.equal(buildWakeReaction(300).signature, "user-returned:idle");
    },
  },
  {
    name: "normalização tolera campos inválidos e null sem inventar métricas",
    run(assert) {
      const normalizedNull = normalizeSpriteData(null, NOW);
      assert.equal(normalizedNull.codex.fiveHourPercent, null);

      const context = normalizeSpriteData({
        usage: {
          collected_at: new Date(NOW).toISOString(),
          resets: {
            limite_5h: { remaining_percent: null, reset_at: "inválido" },
            limite_semanal: { remaining_percent: false },
          },
        },
        health: { status: "ok" },
        telemetry: {
          machine: {
            status: "ok",
            cpu_percent: "NaN",
            memory_percent: false,
            disk_percent: 150,
            system_idle_seconds: -4,
          },
          weather: { temperature_c: "", weather_code: "inválido" },
        },
        panelIdleSeconds: -20,
      }, NOW);

      assert.equal(context.codex.fiveHourPercent, null);
      assert.equal(context.codex.weeklyPercent, null);
      assert.equal(context.codex.fiveHourResetAtMs, null);
      assert.equal(context.machine.cpuPercent, null);
      assert.equal(context.machine.memoryPercent, null);
      assert.equal(context.machine.diskPercent, 100);
      assert.equal(context.weather.temperatureC, null);
      assert.equal(context.idleSeconds, 0);
    },
  },
  {
    name: "seleciona corretamente com um, dois e três sprites sem repetir o último",
    run(assert) {
      const event = { topic: "machine" };
      assert.equal(selectCompanion(companions(1), event, null, NOW)?.id, 1);
      assert.equal(selectCompanion(companions(2), event, 1, NOW)?.id, 2);

      const three = companions(3);
      three[0].lastSpokeAt = 50;
      three[1].lastSpokeAt = 10;
      three[2].lastSpokeAt = 100;
      const selected = selectCompanion(three, event, 2, NOW);
      assert.equal(selected?.id, 1);
      assert.ok(selected?.id !== 2);
    },
  },
  {
    name: "seleção ignora sprites arrastados, ocupados ou já reagindo",
    run(assert) {
      const values = companions(3);
      values[0].dragging = true;
      values[1].busyUntil = NOW + 1000;
      values[2].reaction = { key: "busy" };
      assert.equal(selectCompanion(values, { topic: "codex" }, null, NOW), null);

      const pinned = companions(2);
      pinned[0].pinnedKey = "cpu_critica";
      pinned[0].pinnedEvent = { key: "cpu_critica", priority: 104 };
      pinned[1].pinnedKey = "coleta_erro";
      pinned[1].pinnedEvent = { key: "coleta_erro", priority: 120 };
      assert.equal(selectPreemptableCompanion(pinned, { key: "novo_erro", priority: 130 })?.id, 1);
      assert.equal(selectPreemptableCompanion(pinned, { key: "informativo", priority: 20 }), null);
    },
  },
  {
    name: "configuração real declara schema, macros, cards e gatilhos válidos",
    async run(assert) {
      const raw = await actualBehaviorConfig();
      const report = validateSpriteBehaviorConfig(raw);
      const schema = await readJsonFixture("../../web/config/sprite-behaviors.schema.json");
      assert.equal(report.valid, true, report.errors.map(error => error.message).join("; "));
      assert.ok(Object.keys(raw.macros).length >= 16);
      assert.deepEqual(Object.keys(raw.cards).slice(0, 6), ["hora", "interacao", "temperatura", "maquina", "codex_5h", "codex_semanal"]);
      assert.ok(raw.triggers.length >= 30);
      const casualTrigger = raw.triggers.find(trigger => trigger.id === "intervalo_casual");
      assert.deepEqual(casualTrigger.when.event.intervalSeconds, { min: 20, max: 45 });
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      assert.ok(schema.$defs.condition.oneOf.length >= 6);

      const zeroTiming = JSON.parse(JSON.stringify(raw));
      zeroTiming.triggers = [{
        ...zeroTiming.triggers.find(trigger => trigger.id === "codex_5h_normal"),
        durationSeconds: 0,
        cooldownSeconds: 0,
      }];
      const zeroEvent = evaluateConfiguredTriggers(makeContext({ fiveHour: 80 }), zeroTiming, { now: NOW, random: () => 0 })[0];
      assert.equal(zeroEvent.durationMs, 0);
      assert.equal(zeroEvent.cooldownMs, 0);

      const criticalTrigger = raw.triggers.find(trigger => trigger.id === "codex_semanal_critico");
      assert.equal(criticalTrigger.persistent, true);
      assert.equal(criticalTrigger.holdSeconds, 5);
      const criticalEvent = evaluateConfiguredTriggers(
        makeContext({ weekly: 0, weeklyLimitReached: true }),
        raw,
        { now: NOW, random: () => 0 },
      ).find(event => event.key === "codex_semanal_critico");
      assert.equal(criticalEvent.holdMs, 5000);
    },
  },
  {
    name: "operadores declarativos cobrem comparação e intervalo inclusivo",
    run(assert) {
      assert.deepEqual(SPRITE_BEHAVIOR_OPERATORS, [">", ">=", "<", "<=", "==", "between"]);
      assert.equal(compareSpriteOperator(76, ">", 75), true);
      assert.equal(compareSpriteOperator(75, ">=", 75), true);
      assert.equal(compareSpriteOperator(9, "<", 10), true);
      assert.equal(compareSpriteOperator(10, "<=", 10), true);
      assert.equal(compareSpriteOperator(true, "==", true), true);
      assert.equal(compareSpriteOperator(30, "between", [10, 30]), true);
      assert.equal(compareSpriteOperator(null, ">", 0), false);
    },
  },
  {
    name: "macros usam origem normalizada, fallback seguro e não executam tokens desconhecidos",
    async run(assert) {
      const compiled = compileSpriteBehaviorConfig(await actualBehaviorConfig()).config;
      const context = makeContext({ cpu: 42.5, memory: null, fiveHourResetSeconds: 3660 });
      const macros = resolveSpriteMacroValues(context, compiled);
      assert.equal(macros.cpu.text, "42.5");
      assert.equal(macros.ram.text, "RAM indisponível");
      assert.equal(macros.codex_5h_reset.text, "1h 1min");
      assert.equal(renderSpritePhrase("CPU {{cpu}}% / {{nao_declarada}}", macros), "CPU 42.5% / --");
    },
  },
  {
    name: "gatilhos configurados respeitam faixas Codex e limite por janela",
    async run(assert) {
      const config = await actualBehaviorConfig();
      const eventIds = context => evaluateConfiguredTriggers(context, config, { now: NOW, random: () => 0 }).map(event => event.key);
      assert.ok(eventIds(makeContext({ fiveHour: 61 })).includes("codex_5h_normal"));
      assert.ok(eventIds(makeContext({ fiveHour: 60 })).includes("codex_5h_visita"));
      assert.ok(eventIds(makeContext({ fiveHour: 30 })).includes("codex_5h_preocupado"));
      assert.ok(eventIds(makeContext({ fiveHour: 9 })).includes("codex_5h_critico"));
      assert.ok(!eventIds(makeContext({ cpu: 75 })).includes("cpu_alta"));
      assert.ok(eventIds(makeContext({ cpu: 75.1 })).includes("cpu_alta"));
      assert.ok(eventIds(makeContext({ cpu: 90 })).includes("cpu_alta"));
      assert.ok(eventIds(makeContext({ cpu: 90.1 })).includes("cpu_critica"));
      assert.ok(eventIds(makeContext({ memory: 90.1 })).includes("ram_critica"));
      assert.ok(eventIds(makeContext({ temperature: 12 })).includes("temperatura_baixa"));
      assert.ok(eventIds(makeContext({ temperature: 30 })).includes("temperatura_alta"));
      assert.ok(eventIds(makeContext({ machineStatus: "unavailable" })).includes("maquina_indisponivel"));
      assert.ok(eventIds(makeContext({ telemetryError: "API offline" })).includes("telemetria_indisponivel"));
      assert.ok(eventIds(makeContext({ collectedAt: new Date(NOW - 46 * 60 * 1000).toISOString() })).includes("coleta_desatualizada"));
      assert.ok(!eventIds(makeContext({ cpu: null, memory: null, temperature: null })).includes("cpu_alta"));
      const waitingIds = eventIds(makeContext({ fiveHour: null, weekly: null, collectedAt: null, healthStatus: "ok" }));
      assert.ok(waitingIds.includes("coleta_aguardando"));
      assert.ok(!waitingIds.includes("coleta_erro"));

      const simultaneous = makeContext({ fiveHour: 14, weekly: 0, limitReached: true });
      assert.equal(simultaneous.codex.fiveHourLimitReached, false);
      assert.equal(simultaneous.codex.weeklyLimitReached, true);
      const simultaneousIds = eventIds(simultaneous);
      assert.ok(!simultaneousIds.includes("codex_5h_critico"));
      assert.ok(simultaneousIds.includes("codex_semanal_critico"));
    },
  },
  {
    name: "prioridade configurada coloca falha de coleta acima de limites e máquina",
    async run(assert) {
      const events = evaluateConfiguredTriggers(makeContext({
        fiveHour: 0,
        cpu: 99,
        healthStatus: "error",
        healthMessage: "CDP indisponível",
      }), await actualBehaviorConfig(), { now: NOW, random: () => 0 });
      assert.equal(events[0].key, "coleta_erro");
      assert.ok(events.every((event, index) => index === 0 || events[index - 1].priority >= event.priority));
    },
  },
  {
    name: "faixas de horário funcionam inclusive quando atravessam meia-noite",
    run(assert) {
      const runtime = time => ({ context: { clock: { time } } });
      assert.equal(evaluateSpriteCondition({ timeRange: { start: "06:00", end: "11:59" } }, runtime("08:30")), true);
      assert.equal(evaluateSpriteCondition({ timeRange: { start: "22:00", end: "04:59" } }, runtime("23:30")), true);
      assert.equal(evaluateSpriteCondition({ timeRange: { start: "22:00", end: "04:59" } }, runtime("03:10")), true);
      assert.equal(evaluateSpriteCondition({ timeRange: { start: "22:00", end: "04:59" } }, runtime("12:00")), false);
      assert.equal(evaluateSpriteCondition({ timeRange: { start: "06:00", end: "11:59", days: ["sat"] } }, {
        context: { observedAt: NOW, clock: { iso: new Date(NOW).toISOString(), time: "08:30" } },
      }), true);
    },
  },
  {
    name: "mudança de valor, recuperação, clique, arraste e intervalo geram eventos próprios",
    async run(assert) {
      const config = await actualBehaviorConfig();
      const previous = makeContext({ temperature: 20, healthStatus: "error" });
      const current = makeContext({ temperature: 23, healthStatus: "ok" });
      const automatic = evaluateConfiguredTriggers(current, config, { previousContext: previous, now: NOW, random: () => 0 });
      assert.ok(automatic.some(event => event.key === "mudanca_temperatura"));
      assert.ok(automatic.some(event => event.key === "coleta_recuperada"));
      const previousWaiting = makeContext({ fiveHour: null, weekly: null, collectedAt: null, healthStatus: "ok" });
      const afterFirstCollection = evaluateConfiguredTriggers(current, config, {
        previousContext: previousWaiting,
        now: NOW,
        random: () => 0,
      });
      assert.ok(!afterFirstCollection.some(event => event.key === "coleta_recuperada"));
      const previousHour = { ...previous, clock: { ...previous.clock, time: "12:00" } };
      const currentHour = { ...current, clock: { ...current.clock, time: "13:00" } };
      const hourChange = evaluateConfiguredTriggers(currentHour, config, {
        previousContext: previousHour,
        now: NOW,
        random: () => 0,
      }).find(event => event.key === "mudanca_hora");
      assert.equal(hourChange?.cooldownMs, 3_600_000);

      const explicit = (event) => evaluateConfiguredTriggers(current, config, {
        previousContext: previous,
        event: { sequence: 1, ...event },
        eventOnly: true,
        now: NOW,
        random: () => 0,
      }).map(item => item.key);
      assert.deepEqual(explicit({ type: "click", card: "maquina" }), ["clique_card_maquina"]);
      assert.deepEqual(explicit({ type: "drag", phase: "end" }), ["fim_arraste_sprite"]);
      assert.deepEqual(explicit({ type: "random_interval" }), ["intervalo_casual"]);
    },
  },
  {
    name: "retorno só acorda após inatividade suficiente",
    async run(assert) {
      const config = await actualBehaviorConfig();
      const evaluateReturn = idleSeconds => evaluateConfiguredTriggers(makeContext({ panelIdleSeconds: idleSeconds }), config, {
        event: { type: "user_return", sequence: idleSeconds },
        eventOnly: true,
        now: NOW,
        random: () => 0,
      });
      assert.equal(evaluateReturn(299).length, 0);
      assert.equal(evaluateReturn(300)[0]?.state, "wake");
    },
  },
  {
    name: "inatividade do painel tem prioridade sem apagar idle do Windows",
    run(assert) {
      const panelActive = makeContext({ panelIdleSeconds: 0, systemIdleSeconds: 1200 });
      assert.equal(panelActive.idleSeconds, 0);
      assert.equal(panelActive.panelIdleSeconds, 0);
      assert.equal(panelActive.systemIdleSeconds, 1200);

      const windowsFallback = normalizeSpriteData({
        telemetry: { machine: { system_idle_seconds: 1200 } },
      }, NOW);
      assert.equal(windowsFallback.idleSeconds, 1200);
      assert.equal(windowsFallback.panelIdleSeconds, null);
      assert.equal(windowsFallback.systemIdleSeconds, 1200);
    },
  },
  {
    name: "validação amigável rejeita estado, token e macro desconhecidos",
    async run(assert) {
      const invalid = JSON.parse(JSON.stringify(await actualBehaviorConfig()));
      invalid.macros.cpu.token = "{{processador}}";
      invalid.triggers[0].spriteState = "voar";
      invalid.triggers[0].phrases = ["Valor {{macro_inexistente}}"];
      invalid.defaultBehavior.walkDurationSeconds = { min: 8, max: 2 };
      invalid.defaultBehavior.features.movement = "sim";
      const report = validateSpriteBehaviorConfig(invalid);
      const codes = report.errors.map(error => error.code);
      assert.equal(report.valid, false);
      assert.ok(codes.includes("invalid_macro_token"));
      assert.ok(codes.includes("invalid_state"));
      assert.ok(codes.includes("unknown_macro"));
      assert.ok(codes.includes("invalid_range"));
      assert.ok(codes.includes("invalid_boolean"));
      assert.ok(report.errors.every(error => error.path && error.message));
    },
  },
  {
    name: "carregamento inválido preserva configuração fallback validada",
    async run(assert) {
      const fallback = await actualBehaviorConfig();
      const report = await loadSpriteBehaviorConfig("./inexistente.json", {
        fetchImpl: async () => { throw new Error("offline"); },
        fallbackConfig: fallback,
      });
      assert.equal(report.valid, true);
      assert.equal(report.source, "fallback");
      assert.equal(report.usingFallback, true);
      assert.equal(report.issues[0].code, "load_failed");

      const invalid = JSON.parse(JSON.stringify(fallback));
      invalid.triggers[0].spriteState = "estado_inexistente";
      const invalidReport = await loadSpriteBehaviorConfig("./invalido.json", {
        fetchImpl: async () => ({ ok: true, json: async () => invalid }),
        fallbackConfig: fallback,
      });
      assert.equal(invalidReport.source, "fallback");
      assert.ok(invalidReport.issues.some(issue => issue.code === "invalid_state"));
    },
  },
  {
    name: "fila preserva a fala escolhida entre pollings e evita duplicação",
    run(assert) {
      let clock = 1000;
      const queue = new ReactionEventQueue({ now: () => clock });
      const first = { key: "cpu", signature: "cpu:high", priority: 50, cooldownMs: 5000, message: "fala A" };
      queue.update([first]);
      queue.update([{ ...first, message: "fala B" }]);
      assert.equal(queue.dequeue()?.message, "fala A");
      clock += 1000;
      queue.update([first]);
      assert.equal(queue.size, 0);
      queue.update([{ ...first, signature: "cpu:critical", transient: true }]);
      assert.equal(queue.size, 0);
      queue.enqueue({ ...first, key: "deslocado", signature: "deslocado:ativo" }, { force: true, transient: false });
      assert.equal(queue.size, 1);
      queue.update([]);
      assert.equal(queue.size, 0);
    },
  },
];
