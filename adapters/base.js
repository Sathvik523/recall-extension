// adapters/base.js
// Shared DOM machinery for chat-platform adapters (S7). A platform adapter
// supplies only what differs between sites — selectors, a title suffix, where
// the composer lives — and gets back the full interface content-script.js
// calls: matches(), getButtonAnchor(), serializeConversation(),
// serializeSingleTurn(), getTitle(), insertIntoInput(), getActionRows().
//
// actionRow(turnEl) is optional: given a turn, it returns the row of icons
// under that message (copy, edit, ...) where a Recall icon can go. Without
// it, content-script.js falls back to the floating save button.
//
// Content scripts cannot use ES module imports, so adapters register on a
// shared global instead; load order is fixed in manifest.json.

var Recall = globalThis.Recall || (globalThis.Recall = { adapters: [] });

Recall.createDomAdapter = function createDomAdapter(config) {
  const {
    platform,
    hosts,
    turnSelector,
    userSelector,
    titleNoise,
    siteName,
    inputSelectors,
    actionRow,
  } = config;

  // Nested matches are common (a wrapper and an inner element both carrying
  // a turn marker), so only the outermost node of each turn is kept to avoid
  // duplicating its text. This runs once per frame while a reply streams, so
  // it walks ancestors rather than comparing every pair of turns.
  function collectTurns() {
    return Array.from(document.querySelectorAll(turnSelector))
      .filter((node) => !node.parentElement?.closest(turnSelector))
      .map((el) => ({
        el,
        role: el.matches(userSelector) ? "User" : "Assistant",
        text: (el.innerText || "").trim(),
      }))
      .filter((turn) => turn.text.length > 0);
  }

  // Selectors drift whenever a platform ships a UI update (S7.2); a whole-page
  // grab keeps saving usable until the adapter is fixed.
  function fallbackPageText() {
    const main = document.querySelector("main");
    const text = main ? main.innerText : document.body.innerText;
    return (text || "").trim();
  }

  function format(turns) {
    return turns.map((turn) => `${turn.role}:\n${turn.text}`).join("\n\n");
  }

  // "Currently in view" = the assistant turn with the most pixels on screen,
  // falling back to the last one if the user has scrolled away from all.
  function findVisibleAssistantIndex(turns) {
    const viewportHeight = window.innerHeight;
    let best = -1;
    let bestVisible = 0;

    turns.forEach((turn, i) => {
      if (turn.role !== "Assistant") return;
      const rect = turn.el.getBoundingClientRect();
      const visible = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0);
      if (visible > bestVisible) {
        bestVisible = visible;
        best = i;
      }
    });

    if (best !== -1) return best;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role === "Assistant") return i;
    }
    return -1;
  }

  // The question/answer pair a save refers to. With a turnEl (an icon under a
  // specific message was clicked) that message decides: a question pairs with
  // the answer after it, an answer with the question before it. Without one
  // (the floating button), the answer most visible on screen decides.
  function selectPair(turns, turnEl) {
    let index = turnEl ? turns.findIndex((turn) => turn.el === turnEl) : -1;
    if (index === -1) index = findVisibleAssistantIndex(turns);
    if (index === -1) return turns.length ? [turns[turns.length - 1]] : [];

    const turn = turns[index];
    if (turn.role === "User") {
      const next = turns[index + 1];
      return next?.role === "Assistant" ? [turn, next] : [turn];
    }
    for (let i = index - 1; i >= 0; i--) {
      if (turns[i].role === "User") return [turns[i], turn];
    }
    return [turn];
  }

  function truncate(text, max) {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
  }

  // getClientRects rather than offsetParent: a composer pinned with
  // position:fixed has no offsetParent but is perfectly visible. Every match
  // is checked, since pages often keep hidden textareas that would shadow it.
  function findChatInput() {
    for (const selector of inputSelectors) {
      const match = Array.from(document.querySelectorAll(selector)).find(
        (el) => el.getClientRects().length > 0
      );
      if (match) return match;
    }
    return null;
  }

  return {
    platform,

    matches(hostname) {
      return hosts.includes(hostname);
    },

    getButtonAnchor() {
      return document.body;
    },

    supportsActionRows: Boolean(actionRow),

    getActionRows() {
      if (!actionRow) return [];
      return collectTurns()
        .map((turn) => ({ turnEl: turn.el, role: turn.role, row: actionRow(turn.el) }))
        .filter((entry) => entry.row);
    },

    serializeConversation() {
      const turns = collectTurns();
      return turns.length ? format(turns) : fallbackPageText();
    },

    serializeSingleTurn(turnEl) {
      const turns = collectTurns();
      return turns.length ? format(selectPair(turns, turnEl)) : fallbackPageText();
    },

    getTitle(granularity, turnEl) {
      const turns = collectTurns();
      const question =
        selectPair(turns, turnEl).find((turn) => turn.role === "User")?.text || "";

      // For a single Q&A the question itself is a far better label than the
      // thread title, which describes the whole conversation.
      if (granularity === "qa" && question) return truncate(question, 80);

      const docTitle = document.title.replace(titleNoise, "").trim();
      if (docTitle && docTitle.toLowerCase() !== siteName) return docTitle;

      return question ? truncate(question, 80) : "Untitled conversation";
    },

    // Neither shape accepts a plain `.value =` assignment (S7.3): the editors
    // only register text that arrives as real input events.
    insertIntoInput(text) {
      const input = findChatInput();
      if (!input) return false;

      input.focus();

      if (input.tagName === "TEXTAREA") {
        // React installs its own value setter on the element, so assigning
        // through the prototype's setter is what makes the change visible.
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype,
          "value"
        )?.set;
        const next = input.value ? `${input.value}\n\n${text}` : text;
        if (setter) setter.call(input, next);
        else input.value = next;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      }

      // insertText fires the beforeinput/input pair ProseMirror listens for,
      // and lands the text at the caret rather than clobbering a draft.
      if (document.execCommand("insertText", false, text)) return true;

      input.textContent = input.textContent ? `${input.textContent}\n\n${text}` : text;
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: text }));
      return true;
    },
  };
};
