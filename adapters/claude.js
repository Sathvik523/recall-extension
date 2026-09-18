// adapters/claude.js
// Turn selectors are the ones the original scaffold shipped with. They are
// the single most likely thing to break after a Claude UI update (S7.2).

Recall.adapters.push(
  Recall.createDomAdapter({
    platform: "claude.ai",
    hosts: ["claude.ai"],
    turnSelector:
      '[data-testid="user-message"], [data-testid="assistant-message"], .font-claude-message, .font-user-message',
    userSelector: '[data-testid="user-message"], .font-user-message',
    titleNoise: /\s*[-–]\s*Claude\s*$/,
    siteName: "claude",
    // The composer is a ProseMirror contenteditable, not a textarea.
    inputSelectors: [
      'div[contenteditable="true"].ProseMirror',
      '[data-testid="chat-input"]',
      'div[contenteditable="true"]',
      "textarea",
    ],
  })
);
