# Lion AI

A minimalist, mobile-first AI chat app (installable PWA) that runs on free open models: DeepSeek, Qwen, Llama, Gemma, Mistral and more.

## Features
- **Auto routing**: detects the kind of prompt (code, math, research, creative, general) and picks the best-fitting model, with automatic fallback if one is busy.
- **Thinking levels**: Low / Med / High change the model choice, the reasoning effort sent to reasoning models, and the answer style. Model reasoning is shown in a collapsible block.
- **Compare**: three different models answer side by side (swipe between them).
- **Council**: three models answer, then a reasoning model compares them, fixes errors and writes one final verdict.
- **Research**: pulls Wikipedia sources and has the model cite them as [n].
- **Models tab**: tap the title to see which models your prompt will use and how they work together (answer, backups, council members, judge), live status while they run, and every available model grouped by company with its abilities and context size. Tap a model to pin it so Auto always uses it. The current model is always shown under the title.
- Streaming answers, Markdown and code rendering, stop button, chat memory on device.
- Fits an Android screen in portrait and landscape without page scrolling; works offline as an app shell.

## Run it
1. Get a free API key at https://openrouter.ai/keys (or run Ollama locally).
2. Serve the folder, e.g. `python3 -m http.server`, or enable GitHub Pages on this repo.
3. Open it on your phone → Settings → paste key → **Load models**.
4. In Chrome on Android: menu → **Add to Home screen** to install it as an app.

Your key is stored only in your browser's local storage.
