// adapters/chatgpt.js
// Selectors below were taken from a real chatgpt.com conversation (a dump of
// the DOM around a message), not guessed:
//   section[data-turn="user"|"assistant"][data-testid^="conversation-turn-"]
//     └ div[data-message-author-role="user"|"assistant"]   ← the message text
//     └ the action row, holding [data-testid="copy-turn-action-button"]
//       ("Copy message" on a question, "Copy response" on an answer)
//
// #prompt-textarea has been both a <textarea> and a ProseMirror
// contenteditable across ChatGPT releases; the shared insert logic handles
// either shape.

Recall.adapters.push(
  Recall.createDomAdapter({
    platform: "chatgpt.com",
    hosts: ["chatgpt.com", "chat.openai.com"],
    turnSelector: '[data-message-author-role="user"], [data-message-author-role="assistant"]',
    userSelector: '[data-message-author-role="user"]',
    // The site name may sit before or after the conversation title.
    titleNoise: /^\s*ChatGPT\s*[-–|]\s*|\s*[-–|]\s*ChatGPT\s*$/g,
    siteName: "chatgpt",
    inputSelectors: [
      "#prompt-textarea",
      'div[contenteditable="true"].ProseMirror',
      'div[contenteditable="true"]',
      "textarea",
    ],

    // Anchor on the copy button, then climb to the element that actually
    // holds the row of icons. Climbing matters because each button may sit
    // in its own tooltip wrapper, and appending into that wrapper would put
    // the Recall icon inside another button's hover target.
    actionRow(turnEl) {
      const turn = turnEl.closest('[data-turn-id], section[data-testid^="conversation-turn"]');
      const copy = turn?.querySelector('[data-testid="copy-turn-action-button"]');
      if (!copy) return null;

      let row = copy.parentElement;
      while (row && row !== turn && row.querySelectorAll("button").length < 2) {
        row = row.parentElement;
      }
      return row && row !== turn ? row : copy.parentElement;
    },
  })
);
