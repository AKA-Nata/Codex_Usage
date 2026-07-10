const defaults = { refreshMinutes: 5, bridgeUrl: "http://127.0.0.1:8088/api/ingest", bridgeToken: "" };

async function load() {
  const values = { ...defaults, ...(await chrome.storage.local.get(defaults)) };
  for (const [key, value] of Object.entries(values)) document.getElementById(key).value = value;
}

document.getElementById("save").addEventListener("click", async () => {
  const refreshMinutes = Math.max(5, Number(document.getElementById("refreshMinutes").value) || 5);
  await chrome.storage.local.set({
    refreshMinutes,
    bridgeUrl: document.getElementById("bridgeUrl").value.trim(),
    bridgeToken: document.getElementById("bridgeToken").value.trim()
  });
  document.getElementById("status").textContent = "Salvo.";
});

load();
