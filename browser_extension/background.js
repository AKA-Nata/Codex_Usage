const ALARM_NAME = "codex-usage-refresh";
const DEFAULTS = {
  refreshMinutes: 5,
  bridgeUrl: "http://127.0.0.1:8088/api/ingest",
  bridgeToken: ""
};

function isAnalyticsTab(tab) {
  return typeof tab.url === "string" && tab.url.startsWith("https://chatgpt.com/codex/") &&
    /analytics|usage|settings/i.test(tab.url);
}

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function resetAlarm() {
  const { refreshMinutes } = await settings();
  const minutes = Math.max(5, Number(refreshMinutes) || 5);
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: minutes });
}

async function injectObserver(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["page_observer.js"],
      world: "MAIN",
      injectImmediately: true
    });
  } catch (_) {
    // A pagina pode ter sido fechada ou ainda estar em navegacao.
  }
}

async function sendToLocalBridge(payload) {
  const { bridgeUrl, bridgeToken } = await settings();
  await chrome.storage.local.set({ latestUsage: payload, latestUsageAt: new Date().toISOString() });
  if (!bridgeToken || !bridgeUrl) return;

  try {
    const response = await fetch(bridgeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Codex-Usage-Token": bridgeToken },
      body: JSON.stringify(payload),
      cache: "no-store"
    });
    await chrome.storage.local.set({ bridgeStatus: response.ok ? "ok" : `HTTP ${response.status}` });
  } catch (error) {
    await chrome.storage.local.set({ bridgeStatus: `erro: ${String(error).slice(0, 120)}` });
  }
}

chrome.runtime.onInstalled.addListener(resetAlarm);
chrome.runtime.onStartup.addListener(resetAlarm);
chrome.storage.onChanged.addListener((changes) => {
  if (changes.refreshMinutes) resetAlarm();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "loading" && isAnalyticsTab(tab)) injectObserver(tabId);
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs.filter(isAnalyticsTab)) {
    chrome.tabs.reload(tab.id, { bypassCache: true });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "usage-observed" && sender.tab && message.payload) {
    sendToLocalBridge(message.payload);
    sendResponse({ accepted: true });
  }
  return false;
});
