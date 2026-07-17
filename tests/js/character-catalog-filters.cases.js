import { catalogFilterOptions, filterCatalogCharacters } from "../../web/behavior-studio-characters-tab.js";

const catalog = [
  { id: "gengar", name: "Gengar", source: "bundled", installed: false, enabled: false, valid: true, compatible: true, personality: { id: "humorous" }, tags: ["bundled", "pokemon", "fan-art"] },
  { id: "pikachu", name: "Pikachu", source: "bundled", installed: false, enabled: false, valid: true, compatible: true, personality: { id: "energetic" }, tags: ["bundled", "pokemon", "fan-art"] },
  { id: "explorer", name: "Explorador", source: "native", installed: true, enabled: true, valid: true, compatible: true, personality: { id: "technical" }, tags: ["native", "technical"] },
];

export const characterCatalogFilterCases = [
  { name: "catálogo filtra dinamicamente por tag e personalidade", async run(assert) {
    assert.deepEqual(catalogFilterOptions(catalog, "tag"), ["bundled", "fan-art", "native", "pokemon", "technical"]);
    assert.deepEqual(catalogFilterOptions(catalog, "personality"), ["energetic", "humorous", "technical"]);
    assert.deepEqual(filterCatalogCharacters(catalog, { tag: "pokemon", personality: "humorous" }).map(item => item.id), ["gengar"]);
  }},
  { name: "catálogo combina busca, origem, instalação e estado sem carregar assets", async run(assert) {
    assert.deepEqual(filterCatalogCharacters(catalog, { search: "gen", tag: "pokemon", source: "bundled", installation: "uninstalled", status: "disabled" }).map(item => item.id), ["gengar"]);
    assert.deepEqual(filterCatalogCharacters(catalog, { tag: "native", installation: "installed", status: "enabled" }).map(item => item.id), ["explorer"]);
    assert.equal(filterCatalogCharacters(catalog, { tag: "missing" }).length, 0);
    assert.equal(catalog[0].manifest, undefined);
  }},
];
