(() => {
  if (window.__codexUsageLocalMonitorInstalled) return;
  window.__codexUsageLocalMonitorInstalled = true;

  const FIVE_HOURS = 18_000;
  const WEEK = 604_800;
  const endpointPattern = /(?:usage|analytics|rate[_-]?limit|codex)/i;
  let lastFingerprint = "";
  let domTimer = 0;

  const number = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const percent = (value) => {
    const parsed = number(value);
    return parsed === null ? null : Math.max(0, Math.min(100, Math.round(parsed)));
  };
  const first = (object, keys) => keys.map((key) => object?.[key]).find((value) => value !== undefined && value !== null);

  function candidates(value, result = []) {
    if (Array.isArray(value)) value.forEach((item) => candidates(item, result));
    else if (value && typeof value === "object") {
      const keys = Object.keys(value);
      if (keys.some((key) => /usedPercent|used_percent|remainingPercent|remaining_percent|resetAt|reset_at|resetAfter|reset_after/i.test(key))) result.push(value);
      Object.values(value).forEach((item) => candidates(item, result));
    }
    return result;
  }

  function toWindow(raw, fallbackSeconds) {
    const used = percent(first(raw, ["used_percent", "usedPercent", "usage_percent", "usagePercent"]));
    const remainingValue = percent(first(raw, ["remaining_percent", "remainingPercent", "percent_remaining", "percentRemaining"]));
    const remaining = remainingValue ?? (used === null ? null : 100 - used);
    const resetAt = first(raw, ["reset_at", "resetAt", "resets_at", "resetsAt"]);
    const resetAfter = number(first(raw, ["reset_after_seconds", "resetAfterSeconds", "reset_after", "resetAfter"]));
    const duration = number(first(raw, ["limit_window_seconds", "limitWindowSeconds", "window_seconds"])) ?? fallbackSeconds;
    const resetIso = typeof resetAt === "number"
      ? new Date((resetAt > 10_000_000_000 ? resetAt : resetAt * 1000)).toISOString()
      : (typeof resetAt === "string" ? resetAt : (resetAfter === null ? null : new Date(Date.now() + resetAfter * 1000).toISOString()));
    return { found: used !== null || remaining !== null || resetIso !== null, window_seconds: duration, used_percent: used, remaining_percent: remaining, reset_at: resetIso };
  }

  function emit(payload) {
    const fingerprint = JSON.stringify(payload);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    window.dispatchEvent(new CustomEvent("codex-usage-local-monitor", { detail: payload }));
  }

  function observeNetwork(json) {
    if (!json || typeof json !== "object") return;
    const windows = candidates(json).map((item) => toWindow(item, null)).filter((item) => item.found);
    if (!windows.length) return;
    windows.sort((a, b) => (a.window_seconds ?? Infinity) - (b.window_seconds ?? Infinity));
    const rate = json.rate_limit || json.rateLimit || json.rate_limits || json.rateLimits || {};
    emit({
      extraction_mode: "browser_network",
      limit_reached: typeof rate.limit_reached === "boolean" ? rate.limit_reached : rate.limitReached,
      allowed: typeof rate.allowed === "boolean" ? rate.allowed : rate.isAllowed,
      resets: {
        limite_5h: windows.find((item) => item.window_seconds === FIVE_HOURS) || windows[0],
        limite_semanal: windows.find((item) => item.window_seconds === WEEK) || windows.at(-1)
      }
    });
  }

  async function inspectResponse(response, url) {
    if (!response?.ok || !endpointPattern.test(url || "")) return;
    try {
      const type = response.headers.get("content-type") || "";
      if (type.includes("json")) observeNetwork(await response.clone().json());
    } catch (_) {}
  }

  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    const input = args[0];
    const url = typeof input === "string" ? input : input?.url;
    inspectResponse(response, url);
    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__codexUsageUrl = String(url || "");
    return originalOpen.call(this, method, url, ...rest);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("loadend", () => {
      if (this.status >= 200 && this.status < 300 && endpointPattern.test(this.__codexUsageUrl)) {
        try { observeNetwork(JSON.parse(this.responseText)); } catch (_) {}
      }
    }, { once: true });
    return originalSend.apply(this, args);
  };

  function card(text, pattern, nextPattern, seconds) {
    const match = text.match(new RegExp(`${pattern}([\\s\\S]*?)(?=${nextPattern}|$)`, "i"));
    const block = match?.[1] || "";
    const percentage = block.match(/(\\d{1,3})\\s*%\\s*(?:restantes|remaining)/i)?.[1];
    const reset = block.match(/(?:redefini[cç][aã]o|reset)\\s*:?[ \\t]*([^\\n]+)/i)?.[1]?.trim();
    const remaining = percent(percentage);
    return { found: remaining !== null || Boolean(reset), window_seconds: seconds, used_percent: remaining === null ? null : 100 - remaining, remaining_percent: remaining, reset_at: reset || null };
  }

  function scanDom() {
    const text = document.body?.innerText || "";
    const five = card(text, "(?:Limite de uso de 5 horas|5-hour usage limit)", "(?:Limite de uso semanal|Weekly usage limit)", FIVE_HOURS);
    const weekly = card(text, "(?:Limite de uso semanal|Weekly usage limit)", "(?:Cr[eé]ditos restantes|Credits remaining|Usage details)", WEEK);
    if (five.found || weekly.found) {
      emit({ extraction_mode: "browser_dom", limit_reached: /limite de uso atingido|usage limit reached/i.test(text), allowed: null, resets: { limite_5h: five, limite_semanal: weekly } });
    }
  }

  function installDomObserver() {
    if (!document.documentElement) return;
    new MutationObserver(() => {
      clearTimeout(domTimer);
      domTimer = setTimeout(scanDom, 1000);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  if (document.documentElement) installDomObserver();
  else document.addEventListener("DOMContentLoaded", installDomObserver, { once: true });
  window.addEventListener("load", () => setTimeout(scanDom, 1500), { once: true });
  setInterval(scanDom, 30_000);
})();
