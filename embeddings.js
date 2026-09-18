// embeddings.js
// Wraps the local embedding model (S6.3): all-MiniLM-L6-v2, quantized,
// running in-browser through transformers.js. Nothing is sent anywhere —
// the only network traffic is the one-time download of the model weights,
// which the browser cache keeps afterwards.
//
// Runs inside offscreen.html (see background.js for why). Similarity ranking
// lives in storage.js instead, because that is where the vectors are stored.

import { pipeline, env } from "./lib/transformers.min.js";

const MODEL_ID = "Xenova/all-MiniLM-L6-v2";

// MiniLM only reads its first ~256-512 tokens, so a long thread embedded in
// one pass would be searchable by its opening paragraph alone. Content is
// split into chunks that each fit the window and the chunk vectors averaged.
const CHUNK_CHARS = 1000;
const MAX_CHUNKS = 24;

env.allowLocalModels = false;
env.useBrowserCache = true;
// The ONNX runtime would otherwise fetch its WASM from a CDN, which MV3
// forbids; the binary ships in the extension instead.
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("lib/ort/");
env.backends.onnx.wasm.numThreads = 1;

let extractorPromise = null;
let modelReady = false;

export function loadModel() {
  if (!extractorPromise) {
    extractorPromise = pipeline("feature-extraction", MODEL_ID, { quantized: true })
      .then((extractor) => {
        modelReady = true;
        return extractor;
      })
      .catch((err) => {
        extractorPromise = null; // let the next call retry instead of caching the failure
        throw err;
      });
  }
  return extractorPromise;
}

export function isModelReady() {
  return modelReady;
}

function chunk(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  const chunks = [];
  for (let i = 0; i < clean.length; i += CHUNK_CHARS) {
    chunks.push(clean.slice(i, i + CHUNK_CHARS));
  }
  if (chunks.length <= MAX_CHUNKS) return chunks;

  // Sample evenly so the end of a very long thread still counts.
  const step = chunks.length / MAX_CHUNKS;
  return Array.from({ length: MAX_CHUNKS }, (_, i) => chunks[Math.floor(i * step)]);
}

function normalize(vector) {
  let magnitude = 0;
  for (const v of vector) magnitude += v * v;
  magnitude = Math.sqrt(magnitude);
  return magnitude === 0 ? vector : vector.map((v) => v / magnitude);
}

export async function embed(text) {
  const extractor = await loadModel();
  const pieces = chunk(text);
  if (pieces.length === 0) return null;

  let sum = null;
  for (const piece of pieces) {
    const output = await extractor(piece, { pooling: "mean", normalize: true });
    const vector = output.data;
    if (!sum) sum = new Float64Array(vector.length);
    for (let i = 0; i < vector.length; i++) sum[i] += vector[i];
  }

  return normalize(Array.from(sum));
}
