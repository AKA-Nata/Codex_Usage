import {
  AUTO_CHARACTER_SELECTOR,
  migrateCharacterSelector,
  migrateCharacterSelectors,
  normalizeCharacterGroups,
  normalizeCharacterSelector,
  resolveCharacterSelector,
  selectorMatchesCharacter,
  validateCharacterSelector,
} from "../../web/character-selector.js";


function catalog() {
  return [
    {
      id: "wizard",
      displayOrder: 30,
      enabled: true,
      compatible: true,
      personality: { id: "humorous" },
      tags: ["native", "magic"],
      capabilities: ["speech", "movement"],
    },
    {
      id: "explorer",
      displayOrder: 10,
      enabled: true,
      compatible: true,
      personality: { id: "technical" },
      tags: ["native", "diagnostics"],
      capabilities: ["speech", "diagnostics"],
    },
    {
      id: "mechanic",
      displayOrder: 20,
      enabled: true,
      compatible: true,
      manifest: {
        personality: { id: "objective" },
        tags: ["native", "maintenance"],
        capabilities: ["movement", "diagnostics"],
      },
    },
    {
      id: "orb",
      displayOrder: 5,
      enabled: false,
      compatible: true,
      personality: { id: "silent" },
      tags: ["native"],
      capabilities: ["speech"],
    },
    {
      id: "future",
      displayOrder: 1,
      enabled: true,
      compatible: false,
      personality: { id: "critical" },
      tags: ["installed"],
      capabilities: ["speech"],
    },
  ];
}


export const characterSelectorCases = [
  {
    name: "selector migra strings auto e ID para o contrato estruturado",
    async run(assert) {
      assert.deepEqual(normalizeCharacterSelector("auto"), { kind: "auto", value: null });
      assert.deepEqual(migrateCharacterSelector(" Explorer "), { kind: "id", value: "explorer" });
      assert.deepEqual(normalizeCharacterSelector({ id: "Wizard" }), { kind: "id", value: "wizard" });
      assert.deepEqual(normalizeCharacterSelector(undefined), AUTO_CHARACTER_SELECTOR);
      const canonical = validateCharacterSelector({ kind: "TAG", value: " Native " });
      assert.equal(canonical.valid, true);
      assert.deepEqual(canonical.selector, { kind: "tag", value: "native" });
    },
  },
  {
    name: "selector rejeita tipos, kinds, IDs e valores inválidos com diagnóstico",
    async run(assert) {
      const type = validateCharacterSelector(42);
      assert.equal(type.valid, false);
      assert.equal(type.diagnostics[0].code, "invalid_selector_type");
      const kind = validateCharacterSelector({ kind: "random", value: "explorer" });
      assert.equal(kind.valid, false);
      assert.equal(kind.diagnostics[0].code, "unknown_selector_kind");
      const id = validateCharacterSelector({ kind: "id", value: "../explorer" });
      assert.equal(id.valid, false);
      assert.equal(id.diagnostics[0].code, "invalid_character_id");
      const missing = validateCharacterSelector({ kind: "capability", value: "" });
      assert.equal(missing.valid, false);
      assert.equal(missing.diagnostics[0].code, "missing_selector_value");
      const auto = validateCharacterSelector({ kind: "auto", value: "wizard" });
      assert.equal(auto.valid, false);
      assert.equal(auto.diagnostics[0].code, "unexpected_auto_value");
    },
  },
  {
    name: "migração de configuração não altera o original e relata caminhos convertidos",
    async run(assert) {
      const original = {
        triggers: [
          { id: "automatico", character: "auto" },
          { id: "mago", character: "wizard" },
          { id: "grupo", character: { kind: "group", value: "operations" } },
        ],
        phrases: [{ id: "intacta", character: "texto que não é regra" }],
      };
      const result = migrateCharacterSelectors(original);
      assert.equal(result.migrated, true);
      assert.equal(result.changes.length, 2);
      assert.deepEqual(result.config.triggers.map(item => item.character), [
        { kind: "auto", value: null },
        { kind: "id", value: "wizard" },
        { kind: "group", value: "operations" },
      ]);
      assert.equal(original.triggers[0].character, "auto");
      assert.equal(result.config.phrases[0].character, "texto que não é regra");
    },
  },
  {
    name: "resolução automática é determinística e ignora inativos e incompatíveis",
    async run(assert) {
      const shuffled = [catalog()[2], catalog()[4], catalog()[0], catalog()[3], catalog()[1]];
      const result = resolveCharacterSelector("auto", shuffled);
      assert.equal(result.characterId, "explorer");
      assert.deepEqual(result.eligibleIds, ["explorer", "mechanic", "wizard"]);
      assert.deepEqual(result.candidateIds, ["explorer", "mechanic", "wizard"]);
      assert.equal(result.fallback, false);
      assert.equal(result.diagnostic.code, "selector_resolved");
      const preferred = resolveCharacterSelector("auto", shuffled, { preferredIds: ["wizard"] });
      assert.equal(preferred.characterId, "wizard");
      const available = resolveCharacterSelector("auto", shuffled, { availableIds: ["mechanic"] });
      assert.equal(available.characterId, "mechanic");
    },
  },
  {
    name: "resolução cobre ID, tag, personalidade e capacidade em catálogo e manifesto",
    async run(assert) {
      assert.equal(resolveCharacterSelector({ kind: "id", value: "wizard" }, catalog()).characterId, "wizard");
      assert.equal(resolveCharacterSelector({ kind: "tag", value: "magic" }, catalog()).characterId, "wizard");
      assert.equal(resolveCharacterSelector({ kind: "personality", value: "objective" }, catalog()).characterId, "mechanic");
      const diagnostics = resolveCharacterSelector({ kind: "capability", value: "diagnostics" }, catalog());
      assert.deepEqual(diagnostics.candidateIds, ["explorer", "mechanic"]);
      assert.equal(diagnostics.characterId, "explorer");
      assert.equal(selectorMatchesCharacter({ kind: "tag", value: "maintenance" }, catalog()[2]), true);
      assert.equal(selectorMatchesCharacter({ kind: "id", value: "orb" }, catalog()[3]), false);
    },
  },
  {
    name: "grupos aceitam membros, seletores, aninhamento e associação no catálogo",
    async run(assert) {
      const groups = {
        operations: { members: ["mechanic"], selectors: [{ kind: "capability", value: "diagnostics" }] },
        responders: [{ kind: "group", value: "operations" }, { kind: "id", value: "wizard" }],
      };
      assert.deepEqual(normalizeCharacterGroups(groups), {
        operations: [
          { kind: "id", value: "mechanic" },
          { kind: "capability", value: "diagnostics" },
        ],
        responders: [
          { kind: "group", value: "operations" },
          { kind: "id", value: "wizard" },
        ],
      });
      const operations = resolveCharacterSelector({ kind: "group", value: "operations" }, catalog(), { groups });
      assert.deepEqual(operations.candidateIds, ["explorer", "mechanic"]);
      const responders = resolveCharacterSelector({ kind: "group", value: "responders" }, catalog(), { groups });
      assert.deepEqual(responders.candidateIds, ["explorer", "mechanic", "wizard"]);
      const embedded = catalog();
      embedded[0].groups = ["mentors"];
      assert.equal(resolveCharacterSelector({ kind: "group", value: "mentors" }, embedded).characterId, "wizard");
    },
  },
  {
    name: "grupos desconhecidos e cíclicos degradam para explorer com diagnóstico",
    async run(assert) {
      const unknown = resolveCharacterSelector({ kind: "group", value: "missing" }, catalog());
      assert.equal(unknown.characterId, "explorer");
      assert.equal(unknown.fallback, true);
      assert.equal(unknown.fallbackReason, "selector_no_match");
      assert.ok(unknown.diagnostics.some(item => item.code === "unknown_character_group"));

      const cyclicGroups = {
        alpha: [{ kind: "group", value: "beta" }],
        beta: [{ kind: "group", value: "alpha" }],
      };
      const cyclic = resolveCharacterSelector({ kind: "group", value: "alpha" }, catalog(), { groups: cyclicGroups });
      assert.equal(cyclic.characterId, "explorer");
      assert.equal(cyclic.fallback, true);
      assert.ok(cyclic.diagnostics.some(item => item.code === "character_group_cycle"));
    },
  },
  {
    name: "fallback prefere explorer, sinaliza indisponibilidade e cobre catálogo vazio",
    async run(assert) {
      const missing = resolveCharacterSelector({ kind: "id", value: "absent" }, catalog());
      assert.equal(missing.characterId, "explorer");
      assert.equal(missing.fallback, true);
      assert.equal(missing.fallbackReason, "selector_no_match");

      const withoutExplorer = catalog().filter(item => item.id !== "explorer");
      const alternative = resolveCharacterSelector({ kind: "id", value: "absent" }, withoutExplorer);
      assert.equal(alternative.characterId, "mechanic");
      assert.equal(alternative.fallbackReason, "explorer_unavailable");

      const empty = resolveCharacterSelector({ kind: "id", value: "absent" }, []);
      assert.equal(empty.characterId, "explorer");
      assert.equal(empty.character, null);
      assert.equal(empty.fallbackReason, "no_eligible_characters");
      assert.equal(empty.diagnostic.fallback, true);
    },
  },
  {
    name: "resolução aceita CharacterRegistry.list e filtros de disponibilidade",
    async run(assert) {
      const registry = { list: () => catalog() };
      const result = resolveCharacterSelector({ kind: "capability", value: "movement" }, registry, {
        excludeIds: ["wizard"],
      });
      assert.equal(result.characterId, "mechanic");
      assert.deepEqual(result.candidateIds, ["mechanic"]);
    },
  },
];
