// offscreen.js
// Hosts the embedding model in a hidden extension page. Every runtime
// message in the extension reaches this listener too, so anything not
// explicitly addressed to the offscreen document is ignored.

import { embed, loadModel, isModelReady } from "./embeddings.js";

async function handle(message) {
  switch (message.type) {
    case "EMBED": {
      // Search passes ifReady: a query should fall back to substring
      // matching right away rather than wait out a first-time model download.
      if (message.ifReady && !isModelReady()) {
        loadModel().catch(() => {});
        return { embedding: null };
      }
      return { embedding: await embed(message.text) };
    }
    case "WARM_UP":
      await loadModel();
      return { ready: true };
    default:
      throw new Error(`Unknown offscreen message: ${message.type}`);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") return false;

  handle(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => {
      console.error("Recall embedding failed:", err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true;
});

chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" }).catch(() => {});
