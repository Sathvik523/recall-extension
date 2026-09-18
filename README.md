# Recall

Save useful answers from AI chatbots, then find them again later, even if you
don't remember the exact words. Everything stays on your computer.

Supported right now: **Claude** (claude.ai) and **ChatGPT** (chatgpt.com).

## Install (Chrome 116 or newer)

1. Unzip `recall-<version>.zip`. You get a folder called `recall`.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `recall` folder.
4. Pin Recall from the puzzle-piece menu so its icon stays in the toolbar.

Don't delete or move the folder afterwards. Chrome loads the extension from it.

## Use

- **Save:** on a Claude or ChatGPT chat, click **Save to Recall** in the
  bottom-right corner. Choose **Save this answer** (the question and answer
  on screen) or **Save whole thread**.
- **Find:** click the Recall toolbar icon and type what you remember. Search
  goes by meaning, so "CV tips" will find a saved answer about resume bullets.
- **Reuse:** open a saved item to **Copy** it, **Insert** it into the chat box
  of the tab you're on, or **Delete** it.

You can keep up to 5,000 saves. The count is shown in the popup header.

## Privacy

Saved conversations and searches never leave your browser. The first time
search runs, Recall downloads a small language model (about 23 MB) from
Hugging Face. That download only fetches the model and sends nothing about you.
After that, search works offline.

## Known limitations (v0.1)

- Recall reads chat pages through their page structure. When Claude or ChatGPT
  changes its layout, saving can fall back to grabbing the whole page's text
  until Recall is updated. If a save shows **Failed ✗**, nothing was saved.
- Gemini and Perplexity aren't supported yet. Their filters are greyed out.
- Nothing syncs between devices. Each browser keeps its own saves.

## For maintainers

Run `./package.sh` to build `dist/recall-<version>.zip` from an explicit file
allowlist. Chrome won't load an extension that contains files whose names
start with `_`, so the folder isn't zipped wholesale.
