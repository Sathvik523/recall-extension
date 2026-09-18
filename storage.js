// storage.js
// Thin wrapper around chrome.storage.local so the rest of the extension
// doesn't need to know the underlying storage mechanism.
// Swapping this for IndexedDB later only means changing this file.

const STORAGE_KEY = "recall_items";
const SAVE_BUDGET = 5000;
const MIN_CONTENT_LENGTH = 20;

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function getAllItems() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return result[STORAGE_KEY] || [];
}

// Every write is a read-modify-write of the whole list, and embeddings are
// attached asynchronously after a save, so two writes could otherwise read
// the same snapshot and the later one would silently drop the earlier change.
let writeQueue = Promise.resolve();

function mutate(fn) {
  const run = writeQueue.then(async () => {
    const items = await getAllItems();
    const { items: next, result } = await fn(items);
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
    return result;
  });
  writeQueue = run.catch(() => {});
  return run;
}

async function getSaveCount() {
  const items = await getAllItems();
  return items.length;
}

async function getBudget() {
  const used = await getSaveCount();
  return {
    used,
    total: SAVE_BUDGET,
    remaining: Math.max(0, SAVE_BUDGET - used),
    percentPerSave: 100 / SAVE_BUDGET,
  };
}

async function saveItem({
  platform,
  granularity,
  title,
  url,
  content,
  embedding = null,
}) {
  if (!content || content.trim().length < MIN_CONTENT_LENGTH) {
    throw new Error("Nothing readable was captured from the page.");
  }

  return mutate((items) => {
    if (items.length >= SAVE_BUDGET) {
      throw new Error(`Save budget full (${SAVE_BUDGET} items). Delete something first.`);
    }

    const newItem = {
      id: generateId(),
      platform,
      granularity: granularity === "qa" ? "qa" : "thread",
      title: title?.trim() || "Untitled conversation",
      url,
      content: content.trim(),
      embedding,
      savedAt: new Date().toISOString(),
    };
    return { items: [newItem, ...items], result: newItem }; // newest first
  });
}

async function deleteItem(id) {
  return mutate((items) => ({
    items: items.filter((item) => item.id !== id),
    result: id,
  }));
}

// A no-op when the item was deleted while its vector was being computed.
async function setEmbedding(id, embedding) {
  return mutate((items) => {
    const found = items.some((item) => item.id === id);
    return {
      items: items.map((item) => (item.id === id ? { ...item, embedding } : item)),
      result: found,
    };
  });
}

async function getItemsMissingEmbeddings() {
  const items = await getAllItems();
  return items.filter((item) => !Array.isArray(item.embedding) || !item.embedding.length);
}

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function substringSearch(items, query) {
  const q = query.toLowerCase();
  return items.filter(
    (item) =>
      item.title.toLowerCase().includes(q) ||
      item.content.toLowerCase().includes(q)
  );
}

// Ranks by cosine similarity when a query embedding is supplied and the
// saved items carry their own vectors; otherwise (model still loading,
// embedding failed, or older items saved before embeddings existed) it
// degrades to substring matching so search never fully breaks (S6.3).
// Floor measured against all-MiniLM-L6-v2: a correct paraphrase match with no
// shared keywords scored 0.27 while unrelated items sat between -0.10 and 0.
const SIMILARITY_FLOOR = 0.15;

async function searchItems(query, queryEmbedding = null) {
  const items = await getAllItems();
  if (!query || !query.trim()) return items;

  const embeddable = queryEmbedding
    ? items.filter((item) => Array.isArray(item.embedding) && item.embedding.length)
    : [];

  if (!embeddable.length) return substringSearch(items, query.trim());

  const scored = embeddable
    .map((item) => ({ item, score: cosineSimilarity(queryEmbedding, item.embedding) }))
    .filter((entry) => entry.score >= SIMILARITY_FLOOR)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);

  // Items without vectors can't be ranked semantically, so they are still
  // reachable through a literal match rather than being invisible.
  const unvectored = items.filter(
    (item) => !Array.isArray(item.embedding) || !item.embedding.length
  );
  const literal = substringSearch(unvectored, query.trim());

  const seen = new Set(scored.map((item) => item.id));
  return [...scored, ...literal.filter((item) => !seen.has(item.id))];
}

// Exposed for use in popup.js / background.js via importScripts or module import.
if (typeof module !== "undefined") {
  module.exports = {
    getAllItems,
    getSaveCount,
    getBudget,
    saveItem,
    deleteItem,
    setEmbedding,
    getItemsMissingEmbeddings,
    searchItems,
    cosineSimilarity,
    SAVE_BUDGET,
  };
}
