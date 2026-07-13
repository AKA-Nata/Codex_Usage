export const CHARACTER_SELECTOR_KINDS = Object.freeze([
  "auto",
  "id",
  "group",
  "tag",
  "personality",
  "capability",
]);

export const AUTO_CHARACTER_SELECTOR = Object.freeze({ kind: "auto", value: null });
export const CHARACTER_SELECTOR_FALLBACK_ID = "explorer";

const KIND_SET = new Set(CHARACTER_SELECTOR_KINDS);
const ID_PATTERN = /^[a-z][a-z0-9_-]{1,63}$/;

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim().toLocaleLowerCase("en-US") : "";
}

function selectorKey(selector) {
  return `${selector.kind}:${selector.value ?? ""}`;
}

function diagnostic(code, message, details = {}) {
  return { code, message, ...details };
}

function inspectSelector(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return {
      selector: { ...AUTO_CHARACTER_SELECTOR },
      valid: true,
      migrated: raw !== undefined && raw !== null,
      diagnostics: raw === ""
        ? [diagnostic("empty_selector_migrated", "Seletor vazio migrado para seleção automática.")]
        : [],
    };
  }

  if (typeof raw === "string") {
    const value = normalizeText(raw);
    if (value === "auto") {
      return {
        selector: { ...AUTO_CHARACTER_SELECTOR },
        valid: true,
        migrated: true,
        diagnostics: [diagnostic("legacy_selector_migrated", "Seletor legado 'auto' migrado para o formato estruturado.")],
      };
    }
    if (ID_PATTERN.test(value)) {
      return {
        selector: { kind: "id", value },
        valid: true,
        migrated: true,
        diagnostics: [diagnostic("legacy_selector_migrated", `ID legado '${value}' migrado para o formato estruturado.`)],
      };
    }
    return {
      selector: { ...AUTO_CHARACTER_SELECTOR },
      valid: false,
      migrated: true,
      diagnostics: [diagnostic("invalid_legacy_selector", "Seletor legado de personagem inválido.", { received: raw })],
    };
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      selector: { ...AUTO_CHARACTER_SELECTOR },
      valid: false,
      migrated: false,
      diagnostics: [diagnostic("invalid_selector_type", "Seletor deve ser uma string legada ou um objeto { kind, value }.")],
    };
  }

  // Aceita o formato transitório { id } para não quebrar catálogos 4.x.
  const transitionalId = raw.kind === undefined && raw.id !== undefined ? normalizeText(raw.id) : "";
  if (transitionalId) {
    if (!ID_PATTERN.test(transitionalId)) {
      return {
        selector: { ...AUTO_CHARACTER_SELECTOR },
        valid: false,
        migrated: true,
        diagnostics: [diagnostic("invalid_character_id", "ID transitório de personagem inválido.", { received: raw.id })],
      };
    }
    return {
      selector: { kind: "id", value: transitionalId },
      valid: true,
      migrated: true,
      diagnostics: [diagnostic("transitional_selector_migrated", "Seletor transitório { id } migrado para { kind, value }.")],
    };
  }

  const kind = normalizeText(raw.kind);
  if (!KIND_SET.has(kind)) {
    return {
      selector: { ...AUTO_CHARACTER_SELECTOR },
      valid: false,
      migrated: false,
      diagnostics: [diagnostic("unknown_selector_kind", `Tipo de seletor desconhecido: ${raw.kind ?? "ausente"}.`)],
    };
  }

  if (kind === "auto") {
    const hasUnexpectedValue = raw.value !== undefined && raw.value !== null && normalizeText(raw.value) !== "" && normalizeText(raw.value) !== "auto";
    return {
      selector: { ...AUTO_CHARACTER_SELECTOR },
      valid: !hasUnexpectedValue,
      migrated: raw.value !== null,
      diagnostics: hasUnexpectedValue
        ? [diagnostic("unexpected_auto_value", "Seletores automáticos não aceitam valor.", { received: raw.value })]
        : [],
    };
  }

  const value = normalizeText(raw.value);
  if (!value) {
    return {
      selector: { kind, value: "" },
      valid: false,
      migrated: false,
      diagnostics: [diagnostic("missing_selector_value", `Seletor '${kind}' exige um valor.`)],
    };
  }
  if (kind === "id" && !ID_PATTERN.test(value)) {
    return {
      selector: { kind, value },
      valid: false,
      migrated: value !== raw.value,
      diagnostics: [diagnostic("invalid_character_id", "ID de personagem inválido.", { received: raw.value })],
    };
  }

  return {
    selector: { kind, value },
    valid: true,
    migrated: kind !== raw.kind || value !== raw.value || Object.keys(raw).some(key => !["kind", "value"].includes(key)),
    diagnostics: [],
  };
}

/** Normaliza seletores 4.x ("auto" ou ID) e seletores 5.x para { kind, value }. */
export function normalizeCharacterSelector(raw) {
  return inspectSelector(raw).selector;
}

/** Alias semântico usado pelas rotinas de migração de configuração. */
export function migrateCharacterSelector(raw) {
  return normalizeCharacterSelector(raw);
}

export function validateCharacterSelector(raw) {
  const report = inspectSelector(raw);
  return {
    valid: report.valid,
    selector: report.selector,
    migrated: report.migrated,
    diagnostics: report.diagnostics,
  };
}

/**
 * Migra cópias de configurações ou listas de gatilhos sem alterar o objeto recebido.
 * O escopo intencional é o campo `character` de gatilhos/regras, evitando converter
 * por engano metadados de catálogo que também usem a palavra character.
 */
export function migrateCharacterSelectors(source) {
  const value = clone(source);
  const changes = [];
  const diagnostics = [];

  const migrateOwner = (owner, path) => {
    if (!owner || typeof owner !== "object" || Array.isArray(owner) || !("character" in owner)) return;
    const report = inspectSelector(owner.character);
    const before = clone(owner.character);
    owner.character = report.selector;
    if (report.migrated || JSON.stringify(before) !== JSON.stringify(report.selector)) {
      changes.push({ path: `${path}.character`, before, after: clone(report.selector) });
    }
    report.diagnostics.forEach(item => diagnostics.push({ path: `${path}.character`, ...item }));
  };

  if (Array.isArray(value)) {
    value.forEach((item, index) => migrateOwner(item, `$[${index}]`));
  } else if (value && typeof value === "object") {
    migrateOwner(value, "$.");
    if (Array.isArray(value.triggers)) value.triggers.forEach((trigger, index) => migrateOwner(trigger, `$.triggers[${index}]`));
    if (Array.isArray(value.rules)) value.rules.forEach((rule, index) => migrateOwner(rule, `$.rules[${index}]`));
  }

  return {
    value,
    config: value,
    migrated: changes.length > 0,
    changes,
    diagnostics,
  };
}

function groupEntries(rawGroups) {
  if (Array.isArray(rawGroups)) {
    return rawGroups
      .filter(group => group && typeof group === "object" && !Array.isArray(group))
      .map(group => [group.id ?? group.name, group]);
  }
  if (rawGroups && typeof rawGroups === "object") return Object.entries(rawGroups);
  return [];
}

/**
 * Converte grupos declarados como mapa ou lista para um mapa estável de seletores.
 * Membros string são IDs; grupos aninhados devem usar { kind: "group", value }.
 */
export function normalizeCharacterGroups(rawGroups = {}) {
  const normalized = {};
  groupEntries(rawGroups)
    .map(([rawId, definition]) => [normalizeText(rawId), definition])
    .filter(([id]) => Boolean(id))
    .sort(([left], [right]) => left.localeCompare(right))
    .forEach(([id, definition]) => {
      let members;
      if (Array.isArray(definition)) members = definition;
      else if (typeof definition === "string") members = [definition];
      else members = [
        ...(Array.isArray(definition?.members) ? definition.members : []),
        ...(Array.isArray(definition?.selectors) ? definition.selectors : []),
        ...(Array.isArray(definition?.include) ? definition.include : []),
      ];

      const seen = new Set();
      normalized[id] = members
        .map(member => typeof member === "string" ? { kind: "id", value: normalizeText(member) } : normalizeCharacterSelector(member))
        .filter(selector => {
          const report = validateCharacterSelector(selector);
          const key = selectorKey(selector);
          if (!report.valid || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    });
  return normalized;
}

function catalogItems(catalog) {
  if (Array.isArray(catalog)) return catalog;
  if (catalog instanceof Map) return [...catalog.values()];
  if (catalog && Array.isArray(catalog.characters)) return catalog.characters;
  if (catalog && typeof catalog.list === "function") {
    const listed = catalog.list();
    return Array.isArray(listed) ? listed : [];
  }
  return [];
}

function recordManifest(record) {
  return record?.manifest && typeof record.manifest === "object" ? record.manifest : {};
}

function recordList(record, field) {
  const direct = record?.[field];
  const nested = recordManifest(record)[field];
  const values = Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : [];
  return values.map(normalizeText).filter(Boolean);
}

function recordPersonality(record) {
  const value = record?.personality ?? recordManifest(record).personality;
  return normalizeText(typeof value === "string" ? value : value?.id ?? value?.name);
}

function isCompatible(record) {
  if (record?.compatible === false || record?.compatibility?.compatible === false) return false;
  const status = normalizeText(record?.compatibility?.status ?? record?.compatibilityStatus);
  return !["incompatible", "unsupported", "blocked"].includes(status);
}

function isActive(record) {
  if (record?.enabled === false || record?.active === false || record?.valid === false) return false;
  const status = normalizeText(record?.status);
  return !["disabled", "inactive", "invalid", "removed"].includes(status);
}

function normalizeCatalog(catalog, options = {}) {
  const available = options.availableIds ? new Set([...options.availableIds].map(normalizeText)) : null;
  const excluded = new Set([...(options.excludeIds || [])].map(normalizeText));
  const preferred = new Map([...(options.preferredIds || [])].map((id, index) => [normalizeText(id), index]));
  const byId = new Map();

  catalogItems(catalog).forEach((raw, sourceIndex) => {
    if (!raw || typeof raw !== "object") return;
    const id = normalizeText(raw.id ?? raw.characterId);
    if (!ID_PATTERN.test(id) || byId.has(id)) return;
    byId.set(id, { ...raw, id, _selectorSourceIndex: sourceIndex });
  });

  const all = [...byId.values()];
  const eligible = all
    .filter(record => isActive(record) && isCompatible(record))
    .filter(record => !available || available.has(record.id))
    .filter(record => !excluded.has(record.id))
    .sort((left, right) => {
      const leftPreferred = preferred.has(left.id) ? preferred.get(left.id) : Number.MAX_SAFE_INTEGER;
      const rightPreferred = preferred.has(right.id) ? preferred.get(right.id) : Number.MAX_SAFE_INTEGER;
      if (leftPreferred !== rightPreferred) return leftPreferred - rightPreferred;
      const leftOrder = Number.isFinite(Number(left.displayOrder)) ? Number(left.displayOrder) : Number.MAX_SAFE_INTEGER;
      const rightOrder = Number.isFinite(Number(right.displayOrder)) ? Number(right.displayOrder) : Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.id.localeCompare(right.id);
    });
  return { all, eligible };
}

function characterHasGroup(record, groupId) {
  const direct = recordList(record, "groups");
  const single = normalizeText(record?.group ?? recordManifest(record).group);
  return direct.includes(groupId) || single === groupId;
}

function matchesSelector(record, selector, groups, stack, groupDiagnostics) {
  switch (selector.kind) {
    case "auto": return true;
    case "id": return record.id === selector.value;
    case "tag": return recordList(record, "tags").includes(selector.value);
    case "personality": return recordPersonality(record) === selector.value;
    case "capability": return recordList(record, "capabilities").includes(selector.value);
    case "group": {
      if (characterHasGroup(record, selector.value)) return true;
      if (!(selector.value in groups)) {
        groupDiagnostics.add(`unknown:${selector.value}`);
        return false;
      }
      if (stack.has(selector.value)) {
        groupDiagnostics.add(`cycle:${[...stack, selector.value].join("->")}`);
        return false;
      }
      const nextStack = new Set(stack);
      nextStack.add(selector.value);
      return groups[selector.value].some(member => matchesSelector(record, member, groups, nextStack, groupDiagnostics));
    }
    default: return false;
  }
}

/** Retorna true somente para um registro ativo/compatível que satisfaça o seletor. */
export function selectorMatchesCharacter(rawSelector, character, { groups = {} } = {}) {
  const report = inspectSelector(rawSelector);
  if (!report.valid || !character || !isActive(character) || !isCompatible(character)) return false;
  return matchesSelector(character, report.selector, normalizeCharacterGroups(groups), new Set(), new Set());
}

/**
 * Resolve um seletor de forma determinística sobre o catálogo ativo e compatível.
 * A ordem é preferredIds, displayOrder e ID. Ausência de correspondência tenta o
 * Explorador ativo; depois o primeiro elegível; sem elegíveis mantém o ID lógico
 * explorer e registra o diagnóstico para o chamador não ocultar a degradação.
 */
export function resolveCharacterSelector(rawSelector, catalog, options = {}) {
  const report = inspectSelector(rawSelector);
  const selector = report.selector;
  const groups = normalizeCharacterGroups(options.groups || {});
  const { all, eligible } = normalizeCatalog(catalog, options);
  const groupDiagnostics = new Set();
  const matched = report.valid
    ? eligible.filter(record => matchesSelector(record, selector, groups, new Set(), groupDiagnostics))
    : [];

  const diagnostics = [...report.diagnostics];
  [...groupDiagnostics].sort().forEach(value => {
    if (value.startsWith("unknown:")) {
      diagnostics.push(diagnostic("unknown_character_group", `Grupo de personagens desconhecido: ${value.slice(8)}.`));
    } else {
      diagnostics.push(diagnostic("character_group_cycle", `Ciclo detectado entre grupos: ${value.slice(6)}.`));
    }
  });

  let selected = matched[0] || null;
  let fallback = false;
  let fallbackReason = null;

  if (!selected) {
    fallback = true;
    fallbackReason = report.valid ? "selector_no_match" : "invalid_selector";
    selected = eligible.find(record => record.id === CHARACTER_SELECTOR_FALLBACK_ID) || eligible[0] || null;
    if (!eligible.length) fallbackReason = "no_eligible_characters";
    else if (selected?.id !== CHARACTER_SELECTOR_FALLBACK_ID) fallbackReason = "explorer_unavailable";

    diagnostics.push(diagnostic(
      fallbackReason,
      fallbackReason === "selector_no_match"
        ? "Nenhum personagem corresponde ao seletor; usando o Explorador."
        : fallbackReason === "invalid_selector"
          ? "Seletor inválido; usando o fallback de personagem."
          : fallbackReason === "explorer_unavailable"
            ? "Explorador indisponível; usando o primeiro personagem ativo e compatível."
            : "Nenhum personagem ativo e compatível está disponível; mantendo o fallback lógico explorer.",
    ));
  }

  const characterId = selected?.id || CHARACTER_SELECTOR_FALLBACK_ID;
  const resultDiagnostic = {
    code: fallback ? fallbackReason : "selector_resolved",
    selector: clone(selector),
    selectedId: characterId,
    fallback,
    eligibleIds: eligible.map(record => record.id),
    matchedIds: matched.map(record => record.id),
  };

  return {
    selector: clone(selector),
    characterId,
    character: selected ? { ...selected } : null,
    selected: selected ? { ...selected } : null,
    candidates: matched.map(record => ({ ...record })),
    candidateIds: matched.map(record => record.id),
    eligibleIds: eligible.map(record => record.id),
    fallback,
    fallbackReason,
    diagnostic: resultDiagnostic,
    diagnostics,
    catalogSize: all.length,
  };
}

export const characterSelector = Object.freeze({
  normalize: normalizeCharacterSelector,
  migrate: migrateCharacterSelector,
  validate: validateCharacterSelector,
  resolve: resolveCharacterSelector,
  matches: selectorMatchesCharacter,
  normalizeGroups: normalizeCharacterGroups,
});

export default characterSelector;
