window.addEventListener("codex-usage-local-monitor", (event) => {
  const detail = event.detail;
  if (detail && typeof detail === "object") {
    chrome.runtime.sendMessage({ type: "usage-observed", payload: detail });
  }
});
