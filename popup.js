// popup.js — the "Use" experience (S5).
//
// Structure and styling come from the approved mockup (Appendix B); the mock
// `items` array is replaced by real reads through background.js, which owns
// storage and the embedding model.
//
// Saved content is scraped from third-party pages, so every value that
// reaches the DOM here is written with textContent / DOM nodes rather than
// the mockup's innerHTML template literals. The popup holds chrome.storage
// access, so injecting page-authored HTML into it would be a real XSS path.

const platformMeta = {
  claude: { label: 'Claude', color: '#E8A186', glyph: 'C' },
  chatgpt: { label: 'ChatGPT', color: '#7FCDB3', glyph: 'G' },
  gemini: { label: 'Gemini', color: '#7FA8F0', glyph: 'G' },
  perplexity: { label: 'Perplexity', color: '#B097D9', glyph: 'P' },
};

const unknownMeta = { label: 'Unknown', color: '#B0A895', glyph: '?' };

// Items store a hostname (S7.1); the UI keys off a short platform name.
const HOST_TO_PLATFORM = {
  'claude.ai': 'claude',
  'chatgpt.com': 'chatgpt',
  'chat.openai.com': 'chatgpt',
  'gemini.google.com': 'gemini',
  'perplexity.ai': 'perplexity',
  'www.perplexity.ai': 'perplexity',
};

// Chips for platforms without an adapter stay visible but inert (S5). The
// supported set is read from the manifest's content-script hosts, so adding
// an adapter never requires touching this file (S8).
const SUPPORTED_PLATFORMS = [
  ...new Set(
    chrome.runtime
      .getManifest()
      .content_scripts.flatMap((entry) => entry.matches)
      .map((pattern) => HOST_TO_PLATFORM[/^https?:\/\/([^/]+)\//.exec(pattern)?.[1]])
      .filter(Boolean)
  ),
];

const SAVE_BUDGET = 5000;

let activeFilter = 'all';
let searchQuery = '';
let currentItem = null;
let totalSaved = 0;

const listEl = document.getElementById('list');
const countBadge = document.getElementById('countBadge');
const detailEl = document.getElementById('detail');
const searchInput = document.getElementById('searchInput');

/* --------------------------------------------------------------- plumbing */

function sendMessage(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response || { ok: false, error: 'No response from background.' });
    });
  });
}

function platformKey(item) {
  return HOST_TO_PLATFORM[item.platform] || item.platform;
}

function metaFor(item) {
  return platformMeta[platformKey(item)] || unknownMeta;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date
    .toLocaleDateString('en-US', { month: 'short', day: '2-digit' })
    .toUpperCase();
}

// Saved content is "User:\n…\n\nAssistant:\n…"; the fallback whole-page grab
// has no role markers at all, so that degrades to a single unlabelled block.
function parseTurns(content) {
  const re = /^(User|Assistant):\n/gm;
  const turns = [];
  let match;
  let role = null;
  let start = 0;

  while ((match = re.exec(content)) !== null) {
    if (role !== null) {
      turns.push({ role, text: content.slice(start, match.index).trim() });
    }
    role = match[1];
    start = re.lastIndex;
  }
  if (role !== null) turns.push({ role, text: content.slice(start).trim() });

  return turns.length ? turns : [{ role: null, text: content.trim() }];
}

function previewText(item) {
  return parseTurns(item.content)
    .map((turn) => turn.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ---------------------------------------------------------------- list UI */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function emptyState(label) {
  const wrap = el('div', 'empty-state');
  wrap.appendChild(el('div', 'glyph-lg', '—'));
  wrap.appendChild(el('p', null, label));
  return wrap;
}

// S7.4: an empty popup on first install is a dead end, so zero saves gets an
// explainer rather than the "nothing matches" state used for empty searches.
function firstRunState() {
  const wrap = el('div', 'first-run');
  wrap.appendChild(el('div', 'glyph-lg', 'R'));
  wrap.appendChild(el('h3', null, 'Nothing saved yet'));
  wrap.appendChild(
    el('p', 'lede', 'Recall keeps the answers worth coming back to, and finds them again later — even when you forget the exact words.')
  );

  const where = SUPPORTED_PLATFORMS.map((p) => platformMeta[p].label).join(' or ');
  const steps = el('ol');
  [
    `Open a chat on ${where} and click "Save to Recall" in the corner.`,
    'Choose whether to keep just that answer or the whole thread.',
    'Come back here any time and search everything you have saved.',
  ].forEach((text, i) => {
    const li = el('li');
    li.appendChild(el('span', 'step', String(i + 1)));
    li.appendChild(el('span', null, text));
    steps.appendChild(li);
  });

  wrap.appendChild(steps);
  return wrap;
}

function card(item) {
  const meta = metaFor(item);

  const node = el('div', 'card');
  node.style.setProperty('--tab-color', meta.color);

  const blob = el('div', 'platform-blob');
  blob.style.background = meta.color;
  blob.appendChild(el('span', 'glyph', meta.glyph));

  const metaRow = el('div', 'card-meta');
  metaRow.appendChild(el('span', 'platform-label', meta.label));
  metaRow.appendChild(el('span', 'stamp-date', formatDate(item.savedAt)));

  node.append(
    blob,
    el('div', 'card-title', item.title),
    el('div', 'card-preview', previewText(item)),
    metaRow
  );

  node.addEventListener('click', () => openDetail(item));
  return node;
}

function renderList(items) {
  listEl.replaceChildren();

  if (!items.length) {
    const nothingSavedAtAll = totalSaved === 0 && !searchQuery.trim();
    listEl.appendChild(
      nothingSavedAtAll ? firstRunState() : emptyState('NOTHING MATCHES')
    );
    return;
  }

  items.forEach((item) => listEl.appendChild(card(item)));
}

function syncFilterChips(items) {
  const present = new Set(items.map(platformKey));
  document.querySelectorAll('.filter-chip').forEach((chip) => {
    const platform = chip.dataset.platform;
    if (platform === 'all') return;
    const usable = SUPPORTED_PLATFORMS.includes(platform) || present.has(platform);
    chip.classList.toggle('disabled', !usable);
  });
}

async function refresh() {
  const query = searchQuery.trim();
  const response = query
    ? await sendMessage('SEARCH_ITEMS', { query })
    : await sendMessage('GET_ALL_ITEMS');

  if (!response.ok) {
    listEl.replaceChildren(emptyState('COULD NOT LOAD'));
    console.error('Recall load failed:', response.error);
    return;
  }

  const budget = await sendMessage('GET_BUDGET');
  if (budget.ok) {
    totalSaved = budget.budget.used;
    countBadge.textContent = `${totalSaved.toLocaleString()} / ${budget.budget.total.toLocaleString()} saved`;
  } else {
    countBadge.textContent = `— / ${SAVE_BUDGET.toLocaleString()} saved`;
  }

  const all = response.items;
  syncFilterChips(all);

  const filtered =
    activeFilter === 'all'
      ? all
      : all.filter((item) => platformKey(item) === activeFilter);

  renderList(filtered);
}

/* -------------------------------------------------------------- detail UI */

function openDetail(item) {
  currentItem = item;
  const meta = metaFor(item);

  const blob = document.getElementById('detailBlob');
  blob.style.background = meta.color;
  document.getElementById('detailGlyph').textContent = meta.glyph;
  document.getElementById('detailTitle').textContent = item.title;

  const platformEl = document.getElementById('detailPlatform');
  platformEl.textContent = meta.label;
  platformEl.style.color = meta.color;

  document.getElementById('detailDate').textContent = `SAVED ${formatDate(item.savedAt)}`;

  const content = document.getElementById('detailContent');
  content.replaceChildren();
  parseTurns(item.content).forEach((turn) => {
    if (turn.role) {
      content.appendChild(
        el('span', 'who', turn.role === 'User' ? 'You' : meta.label)
      );
    }
    content.appendChild(document.createTextNode(turn.text));
  });

  document.getElementById('detailBody')?.scrollTo(0, 0);
  detailEl.classList.add('open');
}

function closeDetail() {
  detailEl.classList.remove('open');
  currentItem = null;
}

function flashAction(button, label) {
  const original = button.dataset.label || button.textContent;
  button.dataset.label = original;
  button.textContent = label;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

/* ---------------------------------------------------------------- wiring */

document.getElementById('backBtn').addEventListener('click', closeDetail);

document.getElementById('copyBtn').addEventListener('click', async (event) => {
  if (!currentItem) return;
  try {
    await navigator.clipboard.writeText(currentItem.content);
    flashAction(event.currentTarget, 'Copied ✓');
  } catch (err) {
    console.error('Recall copy failed:', err);
    flashAction(event.currentTarget, 'Failed ✗');
  }
});

document.getElementById('insertBtn').addEventListener('click', async (event) => {
  if (!currentItem) return;
  const button = event.currentTarget;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    flashAction(button, 'No tab ✗');
    return;
  }

  chrome.tabs.sendMessage(
    tab.id,
    { type: 'INSERT_INTO_INPUT', payload: { content: currentItem.content } },
    (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        // Nothing to insert into: the active tab is not a supported chat page.
        flashAction(button, 'Not here ✗');
        return;
      }
      flashAction(button, 'Inserted ✓');
      window.close();
    }
  );
});

document.getElementById('deleteBtn').addEventListener('click', async (event) => {
  if (!currentItem) return;
  const button = event.currentTarget;

  if (button.dataset.confirming !== 'true') {
    button.dataset.confirming = 'true';
    button.dataset.label = 'Delete';
    button.textContent = 'Sure?';
    setTimeout(() => {
      if (button.dataset.confirming !== 'true') return;
      button.dataset.confirming = 'false';
      button.textContent = 'Delete';
    }, 2500);
    return;
  }

  button.dataset.confirming = 'false';
  button.textContent = 'Delete';

  const response = await sendMessage('DELETE_ITEM', { id: currentItem.id });
  if (!response.ok) {
    flashAction(button, 'Failed ✗');
    return;
  }
  closeDetail();
  refresh();
});

let searchTimer = null;
searchInput.addEventListener('input', (event) => {
  searchQuery = event.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 180);
});

document.getElementById('filterRow').addEventListener('click', (event) => {
  const chip = event.target.closest('.filter-chip');
  if (!chip || chip.classList.contains('disabled')) return;
  document.querySelectorAll('.filter-chip').forEach((c) => c.classList.remove('active'));
  chip.classList.add('active');
  activeFilter = chip.dataset.platform;
  refresh();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && detailEl.classList.contains('open')) {
    closeDetail();
  }
});

refresh();
