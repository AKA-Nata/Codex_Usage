import {
  CharacterRegistry,
  isSafeCharacterAssetPath,
  validateCharacterManifest,
} from "../../web/character-registry.js";
import { SpriteAnimationEngine } from "../../web/sprite-animation-engine.js";


function manifest(overrides = {}) {
  const states = Object.fromEntries([
    "idle", "walk", "talk", "point", "inspect", "happy", "worried", "critical",
    "hot", "cold", "sleep", "wake", "confused", "celebrate",
  ].map(state => [state, { asset: `${state}.png`, frames: 4, fps: 4, loop: state !== "wake" }]));
  return {
    schemaVersion: "1.0.0",
    id: "explorer",
    name: "Explorador",
    version: "4.3.0",
    frame: { width: 256, height: 256, layout: "horizontal" },
    fps: 4,
    loop: true,
    baseline: 0.9,
    anchor: { x: 0.5, y: 0.88 },
    orientation: "right",
    fallback: "idle",
    states,
    ...overrides,
  };
}


function mockElement() {
  const values = new Map();
  return {
    dataset: {},
    style: {
      backgroundImage: "",
      backgroundRepeat: "",
      backgroundSize: "",
      backgroundPosition: "",
      setProperty(name, value) { values.set(name, String(value)); },
      getPropertyValue(name) { return values.get(name) || ""; },
    },
    removeAttribute(name) {
      if (name === "data-animation-status") delete this.dataset.animationStatus;
    },
  };
}


function resolved(state = "idle", overrides = {}) {
  return {
    characterId: "explorer",
    requestedState: state,
    resolvedState: state,
    assetUrl: `http://local/${state}.png`,
    image: { naturalWidth: 1024, naturalHeight: 256 },
    frames: 4,
    frameWidth: 256,
    frameHeight: 256,
    fps: 4,
    loop: true,
    baseline: 0.9,
    anchor: { x: 0.5, y: 0.88 },
    orientation: "right",
    source: "native",
    fallback: false,
    fallbackReason: null,
    version: "4.3.0",
    ...overrides,
  };
}


export const characterAnimationCases = [
  {
    name: "registry valida contrato, estados e caminhos relativos seguros",
    async run(assert) {
      const report = validateCharacterManifest(manifest(), { expectedId: "explorer" });
      assert.equal(report.valid, true, report.errors.map(item => item.message).join("; "));
      const fixtureUrl = new URL("../../web/assets/characters/explorer/character.json", import.meta.url);
      let nativeManifest;
      if (fixtureUrl.protocol === "file:") {
        const { readFile } = await import("node:fs/promises");
        nativeManifest = JSON.parse(await readFile(fixtureUrl, "utf8"));
      } else {
        nativeManifest = await (await fetch(fixtureUrl)).json();
      }
      const nativeReport = validateCharacterManifest(nativeManifest, { expectedId: "explorer" });
      assert.equal(nativeReport.valid, true, nativeReport.errors.map(item => `${item.path}: ${item.message}`).join("; "));
      assert.equal(isSafeCharacterAssetPath("states/idle.png"), true);
      ["../idle.png", "/idle.png", "C:/idle.png", "states\\idle.png", "https://x/idle.png"].forEach(path => {
        assert.equal(isSafeCharacterAssetPath(path), false, path);
      });
      const invalid = manifest({ states: { idle: { asset: "../escape.png", frames: 0, fps: 90, loop: "yes" } } });
      assert.equal(validateCharacterManifest(invalid).valid, false);
    },
  },
  {
    name: "registry compartilha preload e resolve fallback para idle",
    async run(assert) {
      let fetchCount = 0;
      let imageCount = 0;
      const data = manifest();
      const registry = new CharacterRegistry({
        definitions: [{ id: "explorer", name: "Explorador", manifestUrl: "http://local/explorer/character.json", legacyUrl: "http://local/explorer.png" }],
        fetchImpl: async () => ({ ok: true, json: async () => { fetchCount += 1; return data; } }),
        imageLoader: async url => { imageCount += 1; return { src: url, naturalWidth: 1024, naturalHeight: 256 }; },
      });
      const [first, second] = await Promise.all([registry.resolveState("explorer", "walk"), registry.resolveState("explorer", "walk")]);
      assert.equal(first.assetUrl, second.assetUrl);
      assert.equal(fetchCount, 1);
      assert.equal(imageCount, 1);
      const missing = await registry.resolveState("explorer", "unknown");
      assert.equal(missing.resolvedState, "idle");
      assert.equal(missing.fallback, true);
      assert.equal(missing.fallbackReason, "estado_ausente");
    },
  },
  {
    name: "registry remove pacote desinstalado sem remover personagens nativos",
    async run(assert) {
      const registry = new CharacterRegistry({
        definitions: [{ id: "explorer", name: "Explorador", source: "native", manifest: manifest(), manifestUrl: "http://local/explorer/character.json", legacyUrl: "http://local/explorer.png" }],
      });
      registry.registerCatalog({ characters: [{
        id: "sentinel",
        source: "installed",
        enabled: true,
        compatible: true,
        manifest: manifest({ id: "sentinel", name: "Sentinela", version: "1.0.0" }),
        baseUrl: "http://local/sentinel/1.0.0/",
      }] });
      assert.equal(registry.has("sentinel"), true);
      registry.registerCatalog({ characters: [] });
      assert.equal(registry.has("sentinel"), false);
      assert.equal(registry.has("explorer"), true);
    },
  },
  {
    name: "animation engine avança por FPS, pausa e respeita reduced motion",
    async run(assert) {
      const registry = { resolveState: async (_id, state) => resolved(state) };
      const engine = new SpriteAnimationEngine({ registry, raf: () => 1, cancelRaf: () => {} });
      const element = mockElement();
      const controller = engine.attach(element, { characterId: "explorer", state: "walk" });
      await controller.ready;
      controller.tick(0);
      controller.tick(260);
      assert.equal(element.dataset.animationFrame, "1");
      controller.pause();
      controller.tick(800);
      assert.equal(element.dataset.animationFrame, "1");
      controller.play();
      engine.setReducedMotion(true);
      controller.tick(1400);
      assert.equal(element.dataset.animationFrame, "0");
      assert.equal(element.dataset.animationReducedMotion, "true");
      controller.destroy();
      assert.equal(engine.controllers.size, 0);
    },
  },
  {
    name: "animation engine encerra animação sem loop no último frame",
    async run(assert) {
      const registry = { resolveState: async (_id, state) => resolved(state, { loop: false, fps: 10 }) };
      const engine = new SpriteAnimationEngine({ registry, raf: () => 1, cancelRaf: () => {} });
      const element = mockElement();
      const controller = engine.attach(element, { state: "wake" });
      await controller.ready;
      controller.tick(0);
      controller.tick(1000);
      assert.equal(element.dataset.animationFrame, "3");
      assert.equal(controller.playing, false);
      controller.destroy();
    },
  },
  {
    name: "troca assíncrona mantém o estado mais recente sem piscar",
    async run(assert) {
      const resolvers = {};
      const registry = { resolveState: (_id, state) => new Promise(resolve => { resolvers[state] = resolve; }) };
      const engine = new SpriteAnimationEngine({ registry, raf: () => 1, cancelRaf: () => {} });
      const element = mockElement();
      element.style.backgroundImage = "url(legacy.png)";
      const controller = engine.attach(element, { state: "idle" });
      const talkPromise = controller.setState("talk");
      assert.equal(element.style.backgroundImage, "url(legacy.png)");
      resolvers.talk(resolved("talk"));
      await talkPromise;
      resolvers.idle(resolved("idle"));
      await controller.ready;
      assert.equal(controller.state, "talk");
      assert.ok(element.style.backgroundImage.includes("talk.png"));
      controller.destroy();
    },
  },
  {
    name: "animation engine coordena de um a três sprites e espelhamento",
    async run(assert) {
      const registry = { resolveState: async (_id, state) => resolved(state) };
      const engine = new SpriteAnimationEngine({ registry, raf: () => 1, cancelRaf: () => {} });
      const controllers = [mockElement(), mockElement(), mockElement()].map(element => engine.attach(element));
      await Promise.all(controllers.map(controller => controller.ready));
      assert.equal(engine.controllers.size, 3);
      controllers[0].setFacing("left");
      assert.equal(controllers[0].element.dataset.animationMirrored, "true");
      controllers[1].pause();
      controllers[2].setPreviewFps(12);
      assert.equal(controllers[2].getDiagnostics().fps, 12);
      engine.destroy();
      assert.equal(engine.controllers.size, 0);
    },
  },
];
