// content-script.js
// Picks the adapter for this site, then puts a Recall icon in the row of
// icons under each message (next to copy / edit) and wires up the
// save-choice dialog (S4). Contains no platform-specific logic: everything
// that reads or writes the chat page goes through the adapter interface
// defined in adapters/base.js (S3.2, S7).

const BUTTON_ID = "recall-save-button";
const OVERLAY_ID = "recall-overlay";
const INLINE_CLASS = "recall-inline-btn";
const SVG_NS = "http://www.w3.org/2000/svg";

const adapter = (globalThis.Recall?.adapters || []).find((a) =>
  a.matches(window.location.hostname)
);

/* ------------------------------------------------------------------ icons */

const ICON_PATHS = {
  ok: ["M20 6 9 17l-5-5"],
  error: ["M18 6 6 18", "M6 6l12 12"],
};

// Built with DOM calls rather than innerHTML: chat sites enforce strict CSP
// and Trusted Types, and markup strings are what those policies reject.
// Size and classes are taken from the site's own neighbouring icon so ours
// renders at the same scale.
function icon(name, template) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("width", template?.getAttribute("width") || "18");
  svg.setAttribute("height", template?.getAttribute("height") || "18");
  const templateClass = template?.getAttribute("class");
  if (templateClass) svg.setAttribute("class", templateClass);

  // The Recall mark is the wordmark "R", drawn as SVG text so it scales with
  // whatever size the site's own icons use. Saved/failed states switch to a
  // tick and a cross, which read more clearly as feedback than a letter.
  if (name === "save") {
    const text = document.createElementNS(SVG_NS, "text");
    text.setAttribute("x", "12");
    text.setAttribute("y", "12");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("dominant-baseline", "central");
    text.setAttribute("font-family", '"Fraunces", Georgia, serif');
    text.setAttribute("font-weight", "700");
    text.setAttribute("font-size", "20");
    text.setAttribute("fill", "currentColor");
    text.setAttribute("stroke", "none");
    text.textContent = "R";
    svg.appendChild(text);
    return svg;
  }

  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

/* ----------------------------------------------------------------- saving */

function sendMessage(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: "No response from background." });
    });
  });
}

// context.turnEl is the message whose icon was clicked; it is absent when
// the save came from the floating button.
async function performSave(granularity, context) {
  const content =
    granularity === "qa"
      ? adapter.serializeSingleTurn(context.turnEl)
      : adapter.serializeConversation();

  const response = await sendMessage("SAVE_CONVERSATION", {
    platform: adapter.platform,
    granularity,
    title: adapter.getTitle(granularity, context.turnEl),
    url: window.location.href,
    content,
  });

  const tone = response.ok ? "ok" : "error";
  if (context.invoker) flashInline(context.invoker, tone);
  else flashButtonState(response.ok ? "Saved ✓" : "Failed ✗", tone);
  if (!response.ok) console.error("Recall save failed:", response.error);
}

/* ----------------------------------------------------------- insert (S7.3) */

function handleInsertMessage(message, sender, sendResponse) {
  if (message?.type !== "INSERT_INTO_INPUT") return false;
  try {
    const ok = adapter.insertIntoInput(message.payload?.content || "");
    sendResponse({ ok, error: ok ? undefined : "No chat input found on this page." });
  } catch (err) {
    console.error("Recall insert failed:", err);
    sendResponse({ ok: false, error: String(err) });
  }
  return false;
}

/* ----------------------------------------------------------------- dialog */

let dialogInvoker = null;

function closeDialog() {
  const overlay = document.getElementById(OVERLAY_ID);
  if (!overlay) return;
  overlay.remove();
  document.removeEventListener("keydown", handleDialogKeydown, true);
  document.getElementById(BUTTON_ID)?.setAttribute("aria-expanded", "false");
  if (dialogInvoker?.isConnected) dialogInvoker.focus();
  dialogInvoker = null;
}

function handleDialogKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    closeDialog();
  }
}

function choiceButton({ label, sub, cost, granularity, context }) {
  const btn = document.createElement("button");
  btn.className = "recall-choice";
  btn.type = "button";
  btn.dataset.granularity = granularity;

  const labelEl = document.createElement("span");
  labelEl.className = "recall-choice-label";
  labelEl.textContent = label;

  const subEl = document.createElement("span");
  subEl.className = "recall-choice-sub";
  subEl.textContent = sub;

  const costEl = document.createElement("span");
  costEl.className = "recall-choice-cost";
  costEl.textContent = cost;

  btn.append(labelEl, subEl, costEl);
  btn.addEventListener("click", () => {
    closeDialog(); // S4.4: dialog closes on selection, the invoker reports the result
    performSave(granularity, context);
  });
  return btn;
}

function answerDescription(context) {
  if (!context.turnEl) return "The question and answer currently in view";
  return context.role === "User"
    ? "This question and its answer"
    : "This answer and the question before it";
}

async function openDialog(context) {
  if (document.getElementById(OVERLAY_ID)) {
    closeDialog();
    return;
  }

  const response = await sendMessage("GET_BUDGET", {});
  const budget = response.ok
    ? response.budget
    : { used: 0, total: 5000, percentPerSave: 100 / 5000 };

  // Both options cost exactly one slot: the budget is a count of saves, not
  // a byte size (S4), so granularity does not change what a save costs.
  const cost = `~${budget.percentPerSave.toFixed(2)}% of your budget`;

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });

  const dialog = document.createElement("div");
  dialog.className = "recall-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Save to Recall");

  const head = document.createElement("div");
  head.className = "recall-dialog-head";

  const title = document.createElement("div");
  title.className = "recall-dialog-title";
  title.textContent = "Save to Recall";

  const pill = document.createElement("div");
  pill.className = "recall-budget-pill";
  pill.textContent = `${budget.used.toLocaleString()} / ${budget.total.toLocaleString()} saved`;

  head.append(title, pill);

  const qa = choiceButton({
    granularity: "qa",
    label: "Save this answer",
    sub: answerDescription(context),
    cost,
    context,
  });

  const thread = choiceButton({
    granularity: "thread",
    label: "Save whole thread",
    sub: "Everything in this conversation so far",
    cost,
    context,
  });

  const cancel = document.createElement("button");
  cancel.className = "recall-cancel";
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", closeDialog);

  dialog.append(head, qa, thread, cancel);
  overlay.appendChild(dialog);
  adapter.getButtonAnchor().appendChild(overlay);

  dialogInvoker = context.invoker || document.getElementById(BUTTON_ID);
  document.addEventListener("keydown", handleDialogKeydown, true);
  qa.focus();

  if (!context.invoker) {
    document.getElementById(BUTTON_ID)?.setAttribute("aria-expanded", "true");
  }
}

/* ------------------------------------------------- icon under each message */

function setInlineLabel(btn, label) {
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

function flashInline(btn, tone) {
  if (!btn.isConnected) return;
  btn.replaceChildren(icon(tone, btn.querySelector("svg")));
  btn.dataset.state = tone;
  setInlineLabel(btn, tone === "ok" ? "Saved to Recall" : "Recall couldn't save this");
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.replaceChildren(icon("save", btn.querySelector("svg")));
    delete btn.dataset.state;
    setInlineLabel(btn, "Save to Recall");
  }, 1600);
}

function makeInlineButton(entry) {
  const neighbor = entry.row.querySelector(`button:not(.${INLINE_CLASS})`);

  const btn = document.createElement("button");
  btn.type = "button";
  // Borrowing the neighbouring button's classes gives ours the site's own
  // size, colour, hover state and reveal-on-hover behaviour.
  btn.className = neighbor
    ? `${neighbor.className} ${INLINE_CLASS}`
    : `${INLINE_CLASS} recall-inline-plain`;
  btn.setAttribute("aria-haspopup", "dialog");
  setInlineLabel(btn, "Save to Recall");
  btn.appendChild(icon("save", neighbor?.querySelector("svg")));

  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    // The site may have re-rendered the message since the icon was added,
    // so look the turn up again; the original element is the fallback.
    const fresh = adapter.getActionRows().find((e) => e.row.contains(btn));
    const turnEl = fresh?.turnEl || (entry.turnEl.isConnected ? entry.turnEl : undefined);
    openDialog({ invoker: btn, turnEl, role: fresh?.role || entry.role });
  });

  return btn;
}

/* ----------------------------------------------------------------- button */

function flashButtonState(label, tone) {
  const btn = document.getElementById(BUTTON_ID);
  if (!btn) return;
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = label;
  btn.disabled = true;
  btn.classList.add(tone === "error" ? "recall-error" : "recall-ok");
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
    btn.classList.remove("recall-ok", "recall-error");
  }, 1600);
}

function injectButton() {
  if (document.getElementById(BUTTON_ID)) return; // already injected

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.type = "button";
  btn.textContent = "Save to Recall";
  btn.dataset.label = "Save to Recall";
  btn.setAttribute("aria-haspopup", "dialog");
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", () => openDialog({}));
  adapter.getButtonAnchor().appendChild(btn);
}

/* ------------------------------------------------------------------- sync */

// Once an icon row has been found on this page the floating button goes
// away. Until then — no rows configured for this site, or a redesign that
// broke them — it stays, so Recall never ends up with no way to save.
let inlineSeen = false;

function syncButtons() {
  for (const entry of adapter.getActionRows()) {
    inlineSeen = true;
    if (!entry.row.querySelector(`.${INLINE_CLASS}`)) {
      entry.row.prepend(makeInlineButton(entry)); // left-most in the row
    }
  }

  if (inlineSeen) document.getElementById(BUTTON_ID)?.remove();
  else injectButton();
}

if (adapter) {
  chrome.runtime.onMessage.addListener(handleInsertMessage);

  // The chat UI is a SPA that re-renders constantly while a reply streams,
  // and some sites only render the icon row on hover, so the page is
  // re-checked on mutation — coalesced into one pass per frame.
  let syncScheduled = false;
  const observer = new MutationObserver(() => {
    if (syncScheduled) return;
    syncScheduled = true;
    requestAnimationFrame(() => {
      syncScheduled = false;
      syncButtons();
    });
  });

  observer.observe(document.body, { childList: true, subtree: true });
  syncButtons();
}
