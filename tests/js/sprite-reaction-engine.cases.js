import {
  ReactionEventQueue,
  buildWakeReaction,
  classifyCodexRemaining,
  evaluateReactions,
  normalizeSpriteData,
  selectCompanion,
} from "../../web/sprite-reaction-engine.js";

const NOW = Date.UTC(2026, 6, 11, 15, 0, 0);

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
        },
        limite_semanal: {
          found: weekly !== null,
          remaining_percent: weekly,
          reset_at: resetAt(weeklyResetSeconds),
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
    },
  },
];
