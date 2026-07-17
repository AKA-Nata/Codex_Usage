function safePercent(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : null;
}

function safeId(value) {
  return String(value || "window").toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

export function countdown(resetAt) {
  const date = resetAt ? new Date(resetAt) : null;
  if (!date || Number.isNaN(date.getTime())) return "Redefinição: --";
  let seconds = Math.max(0, Math.floor((date.getTime() - Date.now()) / 1000));
  if (!seconds) return "Redefinição prevista para agora";
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  return `Redefinição em ${[days && `${days}d`, (hours || days) && `${hours}h`, `${minutes}min`].filter(Boolean).join(" ")}`;
}

function legacyCardId(provider, windowId) {
  if (provider === "codex" && windowId === "5h") return "card-five-hour";
  if (provider === "codex" && windowId === "weekly") return "card-weekly";
  if (provider === "claude" && windowId === "session") return "card-claude-session";
  if (provider === "claude" && windowId === "weekly") return "card-claude-weekly";
  return `card-${safeId(provider)}-${safeId(windowId)}`;
}

function cardHtml(provider, window, status) {
  const percent = safePercent(window.remaining_percent);
  const reset = window.reset_at || "";
  const currentState = status.state || "unavailable";
  return `<article id="${legacyCardId(provider.provider, window.id)}" class="usage-card provider-card state-${escapeHtml(currentState)}" data-provider="${escapeHtml(provider.provider)}" data-window="${escapeHtml(window.id)}" data-sprite-anchor="${escapeHtml(provider.provider)}-${escapeHtml(window.id)}"><div class="usage-content" data-sprite-protected><p class="card-label">${escapeHtml(provider.label)} · ${escapeHtml(window.label || window.id)}</p><div class="percent-row"><p class="percent">${percent ?? "--"}%</p><small>restantes</small></div><div class="progress"><div class="fill" style="width:${percent ?? 0}%"></div></div><p class="countdown" data-reset-at="${escapeHtml(reset)}">${countdown(reset)}</p><p class="exact-time">${reset ? new Date(reset).toLocaleString("pt-BR") : "Horário exato indisponível"}</p><small class="provider-meta">${escapeHtml(currentState)} · ${escapeHtml(window.source || status.source || "sem fonte")}</small></div><span class="sprite-safe-zone" data-sprite-safe-zone aria-hidden="true"></span></article>`;
}

function unavailableHtml(provider, status) {
  const currentState = status.state || "unavailable";
  return `<article id="card-${safeId(provider.provider)}-status" class="usage-card provider-card state-${escapeHtml(currentState)}" data-provider="${escapeHtml(provider.provider)}" data-sprite-anchor="${escapeHtml(provider.provider)}-status"><div class="usage-content" data-sprite-protected><p class="card-label">${escapeHtml(provider.label)}</p><div class="percent-row"><p class="percent">--</p><small>${escapeHtml(currentState)}</small></div><p class="countdown">${escapeHtml(status.error || "Dados de uso indisponíveis.")}</p><p class="exact-time">${status.collected_at ? `Última atualização: ${new Date(status.collected_at).toLocaleString("pt-BR")}` : "Ainda sem dado verificável"}</p></div><span class="sprite-safe-zone" data-sprite-safe-zone aria-hidden="true"></span></article>`;
}

export function renderProviderCards(container, payload = {}) {
  if (!container) return;
  const statuses = payload.providers || {};
  const configured = Array.isArray(payload.provider_list) ? payload.provider_list : Object.values(statuses);
  const cards = configured.flatMap(provider => {
    const status = statuses[provider.provider] || provider;
    const windows = Array.isArray(status.windows) ? status.windows : [];
    return windows.length ? windows.map(window => cardHtml(provider, window, status)) : [unavailableHtml(provider, status)];
  });
  container.innerHTML = cards.join("");
}

export function refreshProviderCountdowns(container = document) {
  container.querySelectorAll?.(".provider-card .countdown[data-reset-at]").forEach(element => { element.textContent = countdown(element.dataset.resetAt); });
}
