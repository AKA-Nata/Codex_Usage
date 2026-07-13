import {
  buildStudioWhen,
  cloneStudioValue,
  createStudioPhraseGroup,
  createStudioTrigger,
  duplicateStudioPhraseGroup,
  duplicateStudioTrigger,
  extractStudioMacros,
  flattenStudioWhen,
  hasNestedStudioCondition,
  removeStudioPhraseGroup,
  removeStudioTrigger,
  replaceStudioTrigger,
  runStudioSimulation,
  setStudioTriggerEnabled,
  updateStudioPhraseGroup,
  updateStudioTrigger,
  validateStudioSpeech,
} from "../../web/behavior-studio-model.js";
import {
  ReactionEventQueue,
  evaluateConfiguredTriggers,
  normalizeSpriteData,
  selectCompanion,
  validateSpriteBehaviorConfig,
} from "../../web/sprite-reaction-engine.js";


const NOW = Date.UTC(2026, 6, 12, 15, 0, 0);


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


function testTrigger(overrides = {}) {
  return {
    id: "teste_cpu",
    name: "Teste de CPU",
    enabled: true,
    when: { metric: "cpu", operator: ">", value: 50 },
    targetCard: "maquina",
    character: "auto",
    spriteState: "inspect",
    phrases: ["CPU em {{cpu}}%."],
    fallbackPhrase: "Tenho uma atualização.",
    preventRepeat: true,
    priority: 50,
    cooldownSeconds: 30,
    durationSeconds: 5,
    persistent: false,
    repeatWhileActive: true,
    holdSeconds: 0,
    ...cloneStudioValue(overrides),
  };
}


function companions() {
  return ["explorer", "wizard", "mechanic", "orb"].map((type, index) => ({
    id: index + 1,
    type,
    dragging: false,
    reaction: null,
    pinnedKey: null,
    pinnedEvent: null,
    busyUntil: 0,
    lastTopic: null,
    lastSpokeAt: index * 100,
  }));
}


function capturedError(callback) {
  try {
    callback();
    return null;
  } catch (error) {
    return error;
  }
}


export const behaviorStudioModelCases = [
  {
    name: "studio faz CRUD de gatilhos sem mutar a configuração recebida",
    async run(assert) {
      const original = cloneStudioValue(await actualBehaviorConfig());
      const snapshot = JSON.stringify(original);
      const created = createStudioTrigger(original, {
        id: "alerta cpu",
        name: "Alerta CPU",
        priority: 91,
        phrases: ["CPU agora em {{cpu}}%."],
      });

      assert.equal(JSON.stringify(original), snapshot);
      assert.equal(created.trigger.id, "alerta_cpu");
      assert.equal(created.config.triggers.at(-1).name, "Alerta CPU");

      const updated = updateStudioTrigger(created.config, created.trigger.id, {
        id: "alerta_cpu_urgente",
        name: "Alerta CPU urgente",
        priority: 120,
        cooldownSeconds: 10,
      });
      assert.equal(updated.trigger.id, "alerta_cpu_urgente");
      assert.equal(updated.trigger.priority, 120);
      assert.equal(updated.trigger.cooldownSeconds, 10);

      const replacement = testTrigger({
        id: "alerta_cpu_final",
        name: "Alerta final",
        priority: 130,
      });
      const replaced = replaceStudioTrigger(updated.config, updated.trigger.id, replacement);
      assert.deepEqual(replaced.trigger, replacement);

      const removed = removeStudioTrigger(replaced.config, replacement.id);
      assert.equal(removed.triggers.some(trigger => trigger.id === replacement.id), false);
      assert.equal(replaced.config.triggers.some(trigger => trigger.id === replacement.id), true);
    },
  },
  {
    name: "studio duplica, ativa, desativa e exclui gatilhos com IDs únicos",
    async run(assert) {
      const config = cloneStudioValue(await actualBehaviorConfig());
      const source = config.triggers[0];
      const duplicated = duplicateStudioTrigger(config, source.id);

      assert.ok(duplicated.trigger.id.startsWith(`${source.id}_copia`));
      assert.equal(duplicated.trigger.enabled, false);
      assert.deepEqual(duplicated.trigger.when, source.when);
      assert.equal(config.triggers.length + 1, duplicated.config.triggers.length);

      const enabled = setStudioTriggerEnabled(duplicated.config, duplicated.trigger.id, true);
      assert.equal(enabled.trigger.enabled, true);
      const disabled = setStudioTriggerEnabled(enabled.config, duplicated.trigger.id, false);
      assert.equal(disabled.trigger.enabled, false);

      const removed = removeStudioTrigger(disabled.config, duplicated.trigger.id);
      assert.equal(removed.triggers.length, config.triggers.length);
      assert.equal(removed.triggers.some(trigger => trigger.id === duplicated.trigger.id), false);
    },
  },
  {
    name: "studio faz CRUD de grupos de falas e protege grupos referenciados",
    async run(assert) {
      const original = cloneStudioValue(await actualBehaviorConfig());
      const created = createStudioPhraseGroup(original, {
        id: "alertas maquina",
        texts: ["CPU {{cpu}}%.", "RAM {{ram}}%."],
        weight: 2,
      });
      assert.equal(created.phrase.id, "alertas_maquina");
      assert.equal(created.phrase.weight, 2);
      assert.equal(original.phrases.some(group => group.id === created.phrase.id), false);

      const updated = updateStudioPhraseGroup(created.config, created.phrase.id, {
        id: "alertas_hardware",
        texts: ["Disco {{disco}}%."],
      });
      assert.equal(updated.phrase.id, "alertas_hardware");
      assert.deepEqual(updated.phrase.texts, ["Disco {{disco}}%."]);

      const duplicated = duplicateStudioPhraseGroup(updated.config, updated.phrase.id);
      assert.ok(duplicated.phrase.id.startsWith("alertas_hardware_copia"));
      assert.ok(duplicated.phrase.texts !== updated.phrase.texts);
      const withoutCopy = removeStudioPhraseGroup(duplicated.config, duplicated.phrase.id);
      const withoutOriginal = removeStudioPhraseGroup(withoutCopy, updated.phrase.id);
      assert.equal(withoutOriginal.phrases.length, original.phrases.length);

      const referenced = original.defaultBehavior.casualSpeech.phraseIds[0];
      const referenceError = capturedError(() => removeStudioPhraseGroup(original, referenced));
      assert.ok(referenceError && /usada por/.test(referenceError.message));
    },
  },
  {
    name: "studio rejeita macros malformadas ou desconhecidas e expõe fallback disponível",
    async run(assert) {
      const config = cloneStudioValue(await actualBehaviorConfig());
      const extracted = extractStudioMacros("CPU {{cpu}}; inválida {{CPU}}; aberta {{ram");
      assert.deepEqual(extracted.names, ["cpu"]);
      assert.ok(extracted.malformed.includes("{{CPU}}"));
      assert.ok(extracted.malformed.includes("chaves desbalanceadas"));

      const report = validateStudioSpeech(config, [
        "CPU {{cpu}}%.",
        "GPU {{GPU}}%.",
        "Valor {{macro_inexistente}}.",
        "RAM {{ram",
      ]);
      const codes = report.errors.map(error => error.code);
      assert.equal(report.valid, false);
      assert.ok(codes.includes("malformed_macro"));
      assert.ok(codes.includes("unknown_macro"));

      const simulation = runStudioSimulation(config, { gpu: null }, { now: NOW });
      assert.equal(simulation.macros.gpu.available, false);
      assert.equal(simulation.macros.gpu.text, String(config.macros.gpu.fallback));
    },
  },
  {
    name: "studio constrói grupos AND e OR com comparações, faixa e booleanos",
    run(assert) {
      const rows = [
        { kind: "metric", metric: "cpu", operator: ">=", value: "80" },
        { kind: "metric", metric: "collection.error", operator: "==", value: "false", valueType: "boolean" },
      ];
      const all = buildStudioWhen("all", rows);
      assert.deepEqual(all, {
        all: [
          { metric: "cpu", operator: ">=", value: 80 },
          { metric: "collection.error", operator: "==", value: false },
        ],
      });
      assert.deepEqual(flattenStudioWhen(all), { group: "all", nodes: all.all });

      const any = buildStudioWhen("any", [
        { kind: "metric", metric: "temperatura", operator: "between", value: "10", valueMax: "18" },
        { kind: "timeRange", start: "22:00", end: "05:00", days: ["fri", "sat"] },
      ]);
      assert.deepEqual(any, {
        any: [
          { metric: "temperatura", operator: "between", value: [10, 18] },
          { timeRange: { start: "22:00", end: "05:00", days: ["fri", "sat"] } },
        ],
      });
      assert.deepEqual(flattenStudioWhen(any), { group: "any", nodes: any.any });

      const nested = { all: [all, { any: any.any }] };
      assert.equal(hasNestedStudioCondition(nested), true);
      assert.deepEqual(flattenStudioWhen(nested), { group: "all", nodes: nested.all });

      assert.ok(capturedError(() => buildStudioWhen("all", [
        { kind: "metric", metric: "cpu", operator: ">", value: "" },
      ])));
      assert.ok(capturedError(() => buildStudioWhen("all", [
        { kind: "metric", metric: "cpu", operator: "between", value: "90", valueMax: "20" },
      ])));
    },
  },
  {
    name: "simulador usa cópias, não muta dados reais e resolve o contexto informado",
    async run(assert) {
      const config = cloneStudioValue(await actualBehaviorConfig());
      const values = {
        cpu: 99,
        ram: 88,
        disk: 77,
        temperature: 31,
        weather: "Calor",
        fiveHourPercent: 9,
        weeklyPercent: 41,
        idleSeconds: 901,
        collectionState: "ok",
      };
      const configSnapshot = JSON.stringify(config);
      const valuesSnapshot = JSON.stringify(values);
      const simulation = runStudioSimulation(config, values, { now: NOW, random: () => 0 });

      assert.equal(simulation.realDataMutated, false);
      assert.equal(JSON.stringify(config), configSnapshot);
      assert.equal(JSON.stringify(values), valuesSnapshot);
      assert.equal(simulation.context.machine.cpuPercent, 99);
      assert.equal(simulation.context.codex.fiveHourPercent, 9);
      assert.equal(simulation.context.idleSeconds, 901);
      assert.ok(simulation.events.some(event => event.key === "cpu_critica"));
      assert.ok(simulation.events.some(event => event.key === "codex_5h_critico"));

      const changeConfig = cloneStudioValue(config);
      changeConfig.triggers = [testTrigger({
        id: "cpu_mudou",
        when: { event: { type: "value_change", metric: "cpu", minDelta: 10 } },
      })];
      const changeSimulation = runStudioSimulation(changeConfig, {
        cpu: 82,
        eventType: "value_change",
        changeMetric: "cpu",
        changeFrom: 35,
      }, { now: NOW, random: () => 0 });
      assert.equal(changeSimulation.events[0]?.key, "cpu_mudou");
      assert.equal(changeSimulation.context.machine.cpuPercent, 82);

      const multiEventConfig = cloneStudioValue(config);
      multiEventConfig.triggers = [testTrigger({
        id: "clique_ou_arraste",
        when: { any: [{ event: { type: "click", card: "maquina" } }, { event: { type: "drag", phase: "end" } }] },
      })];
      const dragSimulation = runStudioSimulation(multiEventConfig, {
        eventType: "drag",
        dragPhase: "end",
      }, { now: NOW, random: () => 0 });
      assert.equal(dragSimulation.events[0]?.key, "clique_ou_arraste");

      const mixedConfig = cloneStudioValue(config);
      mixedConfig.triggers = [testTrigger({
        id: "cpu_alta_ou_mudou",
        when: { any: [
          { metric: "cpu", operator: ">", value: 80 },
          { event: { type: "value_change", metric: "cpu", minDelta: 10, minIntervalSeconds: 45 } },
        ] },
      })];
      const metricOnlySimulation = runStudioSimulation(mixedConfig, { cpu: 90 }, { now: NOW, random: () => 0 });
      assert.equal(metricOnlySimulation.events[0]?.transient, false);
      assert.equal(metricOnlySimulation.events[0]?.signature, "cpu_alta_ou_mudou:active");
      const changedMixedSimulation = runStudioSimulation(mixedConfig, { cpu: 90 }, {
        now: NOW,
        previousValues: { cpu: 60 },
        random: () => 0,
      });
      assert.equal(changedMixedSimulation.events[0]?.transient, true);
      assert.equal(changedMixedSimulation.events[0]?.cooldownMs, 45000);
    },
  },
  {
    name: "simulação ordena gatilhos compatíveis por prioridade decrescente",
    async run(assert) {
      const config = cloneStudioValue(await actualBehaviorConfig());
      config.triggers = [
        testTrigger({ id: "prioridade_baixa", name: "Baixa", priority: 10 }),
        testTrigger({ id: "prioridade_alta", name: "Alta", priority: 900 }),
        testTrigger({ id: "prioridade_media", name: "Média", priority: 100 }),
      ];
      const validation = validateSpriteBehaviorConfig(config);
      assert.equal(validation.valid, true, validation.errors.map(error => error.message).join("; "));

      const simulation = runStudioSimulation(config, { cpu: 80 }, { now: NOW, random: () => 0 });
      assert.deepEqual(simulation.events.map(event => event.key), [
        "prioridade_alta",
        "prioridade_media",
        "prioridade_baixa",
      ]);
      assert.deepEqual(simulation.events.map(event => event.priority), [900, 100, 10]);
    },
  },
  {
    name: "motor preserva personagem específico, falas por personagem e fallback",
    async run(assert) {
      const config = cloneStudioValue(await actualBehaviorConfig());
      config.triggers = [testTrigger({
        id: "fala_mago",
        name: "Fala do mago",
        character: "wizard",
        phrases: ["Mensagem genérica {{cpu}}%."],
        characterPhrases: {
          wizard: ["Magia de CPU: {{cpu}}%."],
          explorer: ["Explorando CPU: {{cpu}}%."],
        },
        fallbackPhrase: "Fallback de CPU: {{cpu}}%.",
        preventRepeat: false,
        repeatWhileActive: false,
        priority: 80,
      })];
      const validation = validateSpriteBehaviorConfig(config);
      assert.equal(validation.valid, true, validation.errors.map(error => error.message).join("; "));

      const simulation = runStudioSimulation(config, { cpu: 81 }, { now: NOW, random: () => 0 });
      const event = simulation.events[0];
      assert.deepEqual(event.character, { kind: "id", value: "wizard" });
      assert.equal(event.characterMessages.wizard, "Magia de CPU: 81%.");
      assert.equal(event.characterMessages.explorer, "Explorando CPU: 81%.");
      assert.equal(event.fallbackMessage, "Fallback de CPU: 81%.");
      assert.equal(event.preventRepeat, false);
      assert.equal(event.repeatWhileActive, false);
      assert.equal(selectCompanion(companions(), event, null, NOW)?.type, "wizard");

      const genericConfig = cloneStudioValue(config);
      genericConfig.triggers = [testTrigger({
        id: "fala_generica",
        character: "auto",
        phrases: ["Uma fala.", "Outra fala."],
      })];
      const genericEvent = runStudioSimulation(genericConfig, { cpu: 81 }, { now: NOW, random: () => 0 }).events[0];
      assert.deepEqual(genericEvent.characterMessages, {});
      assert.equal(genericEvent.message, "Uma fala.");

      const autoCharacterConfig = cloneStudioValue(config);
      autoCharacterConfig.triggers = [testTrigger({
        id: "fala_auto_especifica",
        character: "auto",
        phrases: undefined,
        fallbackPhrase: undefined,
        characterPhrases: { wizard: ["Só o mago fala."] },
      })];
      delete autoCharacterConfig.triggers[0].phrases;
      delete autoCharacterConfig.triggers[0].fallbackPhrase;
      const autoCharacterEvent = runStudioSimulation(autoCharacterConfig, { cpu: 81 }, { now: NOW, random: () => 0 }).events[0];
      assert.equal(autoCharacterEvent.message, "");
      assert.equal(selectCompanion(companions(), autoCharacterEvent, null, NOW)?.type, "wizard");

      const randomConfig = cloneStudioValue(config);
      randomConfig.triggers = [
        testTrigger({ id: "aleatorio_a", when: { event: { type: "random_interval", intervalSeconds: { min: 20, max: 25 } } } }),
        testTrigger({ id: "aleatorio_b", when: { event: { type: "random_interval", intervalSeconds: { min: 30, max: 35 } } } }),
      ];
      const targetedRandomEvents = evaluateConfiguredTriggers(
        normalizeSpriteData({}, NOW),
        randomConfig,
        { now: NOW, eventOnly: true, event: { type: "random_interval", triggerId: "aleatorio_b", sequence: 1 }, random: () => 0 },
      );
      assert.deepEqual(targetedRandomEvents.map(item => item.key), ["aleatorio_b"]);

      const fallbackConfig = cloneStudioValue(config);
      fallbackConfig.triggers = [testTrigger({
        id: "fallback_mago",
        character: "wizard",
        phrases: undefined,
        characterPhrases: { explorer: ["Somente explorador."] },
        fallbackPhrase: "Fallback seguro {{cpu}}%.",
      })];
      delete fallbackConfig.triggers[0].phrases;
      const fallbackEvents = evaluateConfiguredTriggers(
        normalizeSpriteData({
          usage: { collected_at: new Date(NOW).toISOString() },
          telemetry: { machine: { cpu_percent: 82 } },
        }, NOW),
        fallbackConfig,
        { now: NOW, random: () => 0 },
      );
      assert.equal(fallbackEvents[0].message, "Fallback seguro 82%.");
      assert.equal(fallbackEvents[0].fallbackMessage, "Fallback seguro 82%.");
    },
  },
  {
    name: "fila respeita repeatWhileActive depois do cooldown",
    run(assert) {
      let clock = 1000;
      const noRepeatQueue = new ReactionEventQueue({ now: () => clock });
      const noRepeat = {
        key: "sem_repeticao",
        signature: "sem_repeticao:active",
        priority: 50,
        cooldownMs: 1000,
        repeatWhileActive: false,
      };
      noRepeatQueue.update([noRepeat]);
      assert.equal(noRepeatQueue.dequeue()?.key, "sem_repeticao");
      clock += 2000;
      noRepeatQueue.update([noRepeat]);
      assert.equal(noRepeatQueue.size, 0);

      const repeatQueue = new ReactionEventQueue({ now: () => clock });
      const repeat = { ...noRepeat, key: "com_repeticao", signature: "com_repeticao:active", repeatWhileActive: true };
      repeatQueue.update([repeat]);
      assert.equal(repeatQueue.dequeue()?.key, "com_repeticao");
      clock += 2000;
      repeatQueue.update([repeat]);
      assert.equal(repeatQueue.size, 1);
      assert.equal(repeatQueue.dequeue()?.key, "com_repeticao");
    },
  },
];
