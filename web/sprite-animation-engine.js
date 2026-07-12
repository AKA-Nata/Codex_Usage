import { defaultCharacterRegistry } from "./character-registry.js";

function defaultRaf(callback) {
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 16);
}

function defaultCancel(handle) {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

function finiteFps(value, fallback = 1) {
  if (value === null || value === undefined || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(60, number)) : fallback;
}

export class SpriteAnimationController {
  constructor(engine, element, { characterId = "explorer", state = "idle", facing = "right", autoplay = true, onDiagnostic = null } = {}) {
    if (!element) throw new Error("Animation controller requer um elemento.");
    this.engine = engine;
    this.element = element;
    this.characterId = characterId;
    this.state = state;
    this.facing = facing;
    this.playing = autoplay !== false;
    this.onDiagnostic = typeof onDiagnostic === "function" ? onDiagnostic : null;
    this.frame = 0;
    this.frameStartedAt = null;
    this.fpsOverride = null;
    this.resolution = null;
    this.loadGeneration = 0;
    this.destroyed = false;
    this.element.dataset.animationStatus = "loading";
    this.setFacing(facing);
    this.ready = this.load(characterId, state);
  }

  async load(characterId, state) {
    const generation = ++this.loadGeneration;
    this.element.dataset.animationRequestedState = state;
    this.element.dataset.animationStatus = "loading";
    try {
      const resolution = await this.engine.registry.resolveState(characterId, state);
      if (this.destroyed || generation !== this.loadGeneration) return this.resolution;
      this.characterId = resolution.characterId;
      this.state = state;
      this.resolution = resolution;
      this.frame = 0;
      this.frameStartedAt = null;
      this.applyAsset();
      this.emitDiagnostic();
      return resolution;
    } catch (error) {
      if (this.destroyed || generation !== this.loadGeneration) return this.resolution;
      this.element.dataset.animationStatus = "error";
      this.element.dataset.animationError = String(error.message || error);
      this.emitDiagnostic(error);
      return null;
    }
  }

  applyAsset() {
    const resolution = this.resolution;
    if (!resolution) return;
    this.element.style.backgroundImage = `url("${String(resolution.assetUrl).replace(/"/g, "%22")}")`;
    this.element.style.backgroundRepeat = "no-repeat";
    this.element.style.backgroundSize = `${Math.max(1, resolution.frames) * 100}% 100%`;
    this.element.dataset.animationCharacter = resolution.characterId;
    this.element.dataset.animationState = resolution.resolvedState;
    this.element.dataset.animationRequestedState = resolution.requestedState;
    this.element.dataset.animationFrames = String(resolution.frames);
    this.element.dataset.animationFps = String(resolution.fps);
    this.element.dataset.animationLoop = String(Boolean(resolution.loop));
    this.element.dataset.animationSource = resolution.source;
    this.element.dataset.animationFallback = String(Boolean(resolution.fallback));
    this.element.dataset.animationFallbackReason = resolution.fallbackReason || "";
    this.element.dataset.animationStatus = resolution.image === null ? "fallback" : "ready";
    delete this.element.dataset.animationError;
    this.applyFacing();
    this.renderFrame();
  }

  emitDiagnostic(error = null) {
    this.onDiagnostic?.({ ...this.getDiagnostics(), error: error ? String(error.message || error) : null });
  }

  setCharacter(characterId) {
    if (characterId === this.characterId && this.resolution) return Promise.resolve(this.resolution);
    return this.load(characterId, this.state);
  }

  setState(state) {
    if (state === this.state && this.resolution?.requestedState === state) return Promise.resolve(this.resolution);
    return this.load(this.characterId, state);
  }

  setFacing(facing) {
    this.facing = facing === "left" ? "left" : "right";
    this.applyFacing();
  }

  applyFacing() {
    const nativeFacing = this.resolution?.orientation || "right";
    const mirrored = nativeFacing !== this.facing;
    this.element.style.setProperty("--animation-facing", mirrored ? "-1" : "1");
    this.element.dataset.animationFacing = this.facing;
    this.element.dataset.animationMirrored = String(mirrored);
  }

  play() {
    this.playing = true;
    this.frameStartedAt = null;
    this.element.dataset.animationPaused = "false";
  }

  pause() {
    this.playing = false;
    this.element.dataset.animationPaused = "true";
  }

  setPreviewFps(value) {
    this.fpsOverride = value === null || value === undefined || value === "" ? null : finiteFps(value);
    this.element.dataset.animationPreviewFps = this.fpsOverride === null ? "" : String(this.fpsOverride);
  }

  setReducedMotion(reduced) {
    if (reduced) {
      this.frame = 0;
      this.frameStartedAt = null;
      this.renderFrame();
    }
    this.element.dataset.animationReducedMotion = String(Boolean(reduced));
  }

  tick(timestamp) {
    const resolution = this.resolution;
    if (!resolution || !this.playing || this.engine.reducedMotion || resolution.frames <= 1) return;
    if (this.frameStartedAt === null) {
      this.frameStartedAt = timestamp;
      return;
    }
    const frameDuration = 1000 / finiteFps(this.fpsOverride, finiteFps(resolution.fps));
    const elapsedFrames = Math.floor((timestamp - this.frameStartedAt) / frameDuration);
    if (elapsedFrames < 1) return;
    this.frameStartedAt += elapsedFrames * frameDuration;
    const nextFrame = this.frame + elapsedFrames;
    if (resolution.loop) this.frame = nextFrame % resolution.frames;
    else {
      this.frame = Math.min(resolution.frames - 1, nextFrame);
      if (this.frame === resolution.frames - 1) this.pause();
    }
    this.renderFrame();
  }

  renderFrame() {
    const frames = Math.max(1, Number(this.resolution?.frames) || 1);
    const clampedFrame = Math.max(0, Math.min(frames - 1, this.frame));
    const percentage = frames <= 1 ? 0 : (clampedFrame / (frames - 1)) * 100;
    this.element.style.backgroundPosition = `${percentage}% center`;
    this.element.dataset.animationFrame = String(clampedFrame);
  }

  getDiagnostics() {
    const resolution = this.resolution;
    return {
      characterId: this.characterId,
      requestedState: this.state,
      resolvedState: resolution?.resolvedState || null,
      source: resolution?.source || null,
      fallback: Boolean(resolution?.fallback),
      fallbackReason: resolution?.fallbackReason || null,
      assetUrl: resolution?.assetUrl || null,
      frames: resolution?.frames || 0,
      fps: this.fpsOverride ?? resolution?.fps ?? null,
      loop: resolution?.loop ?? null,
      frame: this.frame,
      playing: this.playing,
      reducedMotion: this.engine.reducedMotion,
      facing: this.facing,
      status: this.element.dataset.animationStatus,
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.loadGeneration += 1;
    this.engine.detach(this);
    this.element.removeAttribute("data-animation-status");
  }
}

export class SpriteAnimationEngine {
  constructor({ registry = defaultCharacterRegistry, reducedMotion = false, raf = defaultRaf, cancelRaf = defaultCancel } = {}) {
    this.registry = registry;
    this.reducedMotion = Boolean(reducedMotion);
    this.raf = raf;
    this.cancelRaf = cancelRaf;
    this.controllers = new Set();
    this.frameHandle = null;
    this.boundFrame = timestamp => this.frame(timestamp);
  }

  attach(element, options = {}) {
    const controller = new SpriteAnimationController(this, element, options);
    this.controllers.add(controller);
    controller.setReducedMotion(this.reducedMotion);
    this.schedule();
    return controller;
  }

  detach(controller) {
    this.controllers.delete(controller);
    if (!this.controllers.size && this.frameHandle !== null) {
      this.cancelRaf(this.frameHandle);
      this.frameHandle = null;
    }
  }

  schedule() {
    if (this.frameHandle === null && this.controllers.size) this.frameHandle = this.raf(this.boundFrame);
  }

  frame(timestamp) {
    this.frameHandle = null;
    this.controllers.forEach(controller => controller.tick(timestamp));
    this.schedule();
  }

  setReducedMotion(reduced) {
    this.reducedMotion = Boolean(reduced);
    this.controllers.forEach(controller => controller.setReducedMotion(this.reducedMotion));
  }

  pauseAll() {
    this.controllers.forEach(controller => controller.pause());
  }

  resumeAll() {
    this.controllers.forEach(controller => controller.play());
  }

  destroy() {
    [...this.controllers].forEach(controller => controller.destroy());
    if (this.frameHandle !== null) this.cancelRaf(this.frameHandle);
    this.frameHandle = null;
  }
}

export const defaultSpriteAnimationEngine = new SpriteAnimationEngine();
