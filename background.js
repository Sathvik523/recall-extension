// background.js
// Service worker: mediates between content scripts, the popup, storage, and
// the embedding model. Nothing else talks to storage.js directly.
//
// The model runs in an offscreen document rather than in this worker: the
// worker is torn down after ~30s idle, which would throw away a loaded model
// each time, and an offscreen page is a normal DOM context where the ONNX
// WASM runtime behaves exactly as it does on any web page.
importScripts("storage.js");

const OFFSCREEN_URL = "offscreen.html";

// createDocument resolves once the page exists, which is before its module
// script has finished importing the model library and registered a message
// listener — anything sent in that gap fails with "Receiving end does not
// exist". So readiness is signalled by the page itself (OFFSCREEN_READY).
// Held as one shared promise so concurrent callers never create it twice.
let offscreenReady = null;
let markOffscreenReady = null;

function ensureOffscreen() {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
      });
      // Outlived a service-worker restart, so it finished loading long ago.
      if (contexts.length) return;

      const ready = new Promise((resolve) => {
        markOffscreenReady = resolve;
      });
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ["WORKERS"],
        justification: "Runs the local embedding model used for semantic search.",
      });
      await ready;
    })().catch((err) => {
      offscreenReady = null;
      throw err;
    });
  }
  return offscreenReady;
}

async function askOffscreen(message) {
  await ensureOffscreen();
  let response;
  try {
    response = await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
  } catch (err) {
    offscreenReady = null; // the page went away; recreate it on the next call
    throw err;
  }
  if (!response?.ok) throw new Error(response?.error || "Embedding host did not respond.");
  return response;
}

// Items are saved without a vector first so the save is instant even while
// the model is still downloading; vectors are attached here afterwards. The
// scan covers anything left over from earlier failures or worker restarts.
let backfilling = null;

function backfillEmbeddings() {
  if (backfilling) return backfilling;

  backfilling = (async () => {
    // Re-scan after each pass: a save that lands mid-run gets handed this
    // same in-flight promise, so the run itself has to pick the new item up.
    // Each item is tried once per run so one that cannot embed can't spin.
    const attempted = new Set();
    for (;;) {
      const pending = (await getItemsMissingEmbeddings()).filter(
        (item) => !attempted.has(item.id)
      );
      if (!pending.length) return;

      for (const item of pending) {
        attempted.add(item.id);
        try {
          const { embedding } = await askOffscreen({ type: "EMBED", text: item.content });
          if (embedding) await setEmbedding(item.id, embedding);
        } catch (err) {
          console.warn("Recall: embedding unavailable, search will use substring matching.", err);
          return; // model failed to load; retried on the next trigger
        }
      }
    }
  })().finally(() => {
    backfilling = null;
  });

  return backfilling;
}

async function embedQuery(query) {
  try {
    const { embedding } = await askOffscreen({ type: "EMBED", text: query, ifReady: true });
    return embedding;
  } catch (err) {
    console.warn("Recall: query embedding failed, using substring search.", err);
    return null;
  }
}

const handlers = {
  async SAVE_CONVERSATION(payload) {
    const item = await saveItem(payload);
    backfillEmbeddings();
    return { item };
  },

  async GET_BUDGET() {
    return { budget: await getBudget() };
  },

  async GET_ALL_ITEMS() {
    // The popup just opened: a good moment to load the model so the first
    // search is semantic, and to finish any vectors that never got computed.
    backfillEmbeddings();
    return { items: await getAllItems() };
  },

  async SEARCH_ITEMS({ query }) {
    const queryEmbedding = await embedQuery(query);
    return {
      items: await searchItems(query, queryEmbedding),
      semantic: Boolean(queryEmbedding),
    };
  },

  async DELETE_ITEM({ id }) {
    await deleteItem(id);
    return { id };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  if (message?.type === "OFFSCREEN_READY") {
    markOffscreenReady?.();
    sendResponse({ ok: true });
    return false;
  }
  const handler = handlers[message?.type];
  if (!handler) return false;

  handler(message.payload || {}, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => {
      console.error(`Recall ${message.type} failed:`, err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });

  return true; // keep the message channel open for async sendResponse
});
