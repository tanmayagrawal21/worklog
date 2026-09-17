# Setup

Two things to decide: **where your log lives** (a git repo you own) and **how much AI you want**
(possibly none). Ten minutes, no installs.

---

## 1. Get a GitHub token

The app talks to GitHub's REST API directly from your browser. There is no backend, and browser-only
OAuth is impossible against GitHub (its login endpoints send no CORS headers), so the credential is a
personal access token.

**If your data repo already exists** — a [fine-grained token][fg] is the tighter option:

1. Open <https://github.com/settings/personal-access-tokens/new>
2. Resource owner: you. Repository access: **Only select repositories** → your log repo.
3. Permissions → Repository permissions → **Contents: Read and write**.
4. Set an expiry you're happy to renew. Generate, and copy the token.

**If you want the app to create the repo for you** — you need a [classic token][cl] with the `repo`
scope. Fine-grained tokens can only reach repos that already exist, so they cannot create one.

Either token goes into Settings in the app. It is stored in `localStorage` on that browser only,
never committed, and never sent anywhere except `api.github.com`.

[fg]: https://github.com/settings/personal-access-tokens/new
[cl]: https://github.com/settings/tokens/new?scopes=repo

## 2. Point the app at your repo

Open <https://tanmayagrawal21.github.io/worklog/>. The first-run wizard asks for:

- **Data repo** — `your-username/worklog-data`, or any repo you like. It can be one you already use.
- **Visibility**, if it doesn't exist yet — **Private** is the recommended default. Public means
  anyone can read your task titles and notes (and the app can then read it with no token at all,
  which is handy for a read-only view on a machine you don't want to put a token on).
- Whether to seed **three example tasks** so the board isn't empty.

Then it shows you the exact files it is about to commit, and commits nothing until you say yes.

If you'd rather create and seed the repo from a terminal, see [Option B](#option-b-gh-cli) below.

## 3. Choose an AI tier

Settings → AI. Four options; the default is the first.

**No AI.** The board and the changelog, nothing sent anywhere. Everything except the summary and
brain-dump panes works exactly the same.

**On my machine.** Nothing leaves your computer.

- *In this browser (WebGPU)* — downloads an open model into the browser and runs it on your GPU.
  Needs a WebGPU-capable browser (recent Chrome or Edge; Safari 18+) and a few GB of disk for the
  cached weights. First load is a large download; after that it's offline.
- *Ollama* — `ollama serve`, then set the endpoint to `http://localhost:11434/v1`. Ollama needs to
  allow the page's origin: `OLLAMA_ORIGINS='https://tanmayagrawal21.github.io' ollama serve`
  (or `http://localhost:8000` if you're running the app locally).
- *llama.cpp server* / *LM Studio* — same idea; both expose an OpenAI-compatible `/v1`. Start them
  with CORS enabled (`llama-server --host 127.0.0.1 ... ` behind a proxy that adds the header, or
  LM Studio's "Enable CORS" toggle).

**Open models in the cloud.** A Hugging Face token from
<https://huggingface.co/settings/tokens>. The model list is read live from HF's catalogue. Free-tier
inference credits are small; a 402 from HF means you've used them up, and the app says so plainly.

**A commercial or custom API.** OpenAI, Anthropic, Google, or OpenRouter — pick the provider, paste
its key, choose a model. For anything else that speaks the OpenAI chat-completions format
(a company gateway, LiteLLM, vLLM, a proxy), choose **Custom endpoint** and give it the base URL,
the key, and the model name. Requests degrade gracefully: if the endpoint rejects
`response_format` or a sampling parameter like `temperature`, the app retries without it rather than
failing.

Keys are stored per provider, so switching back and forth doesn't make you re-paste them.

## 4. Optional: lock your tokens with a passphrase

Settings → Security. Without it, tokens sit in plaintext `localStorage` — fine on a machine only you
use, less fine on a shared one. With it, they're encrypted at rest (PBKDF2-SHA256, 600k iterations →
AES-GCM) and you're prompted once per session. Skipping the prompt gives you a read-only board.

There is no recovery: forget the passphrase and you re-enter your tokens.

---

## Option B: gh CLI

If you prefer to create the repo yourself, or want to script it for a team:

```sh
./scripts/setup.sh                          # private repo named <you>/worklog-data
./scripts/setup.sh --repo me/journal        # a name you pick
./scripts/setup.sh --public                 # public instead
./scripts/setup.sh --no-examples            # skip the three example tasks
./scripts/setup.sh --dry-run                # print the plan and every file, write nothing
./scripts/setup.sh --yes                    # skip the confirmation prompt
```

It needs the [`gh` CLI](https://cli.github.com) authenticated (`gh auth login`), creates the repo if
it's missing, and commits the same starter files the in-app wizard would — literally the same code
renders them, so the two paths can't drift. Like the app, it shows you the plan and waits for a `y`
before creating anything. If the repo already holds a log it stops rather than guessing at a merge;
open the app and point it at the repo instead. It never touches tokens — you still paste one into
the app.

## Running it on your own machine instead

Three ways in, and they are interchangeable — the app is the same code and your log is the same
repo, so you can switch whenever:

| | How | When it fits |
| --- | --- | --- |
| Hosted | open the link | you just want to use it |
| npm | `npx work-log` | you have Node and want a pinned version, or a local AI server |
| Clone | `git clone …` then `python3 -m http.server 8000` | you want to change the app |

`npx work-log` serves the package's own files on `http://127.0.0.1:8765` and opens a browser.
`--demo` opens the sample board, `--no-open` just prints the URL, `--port` and `--host` do what you
would expect (`--host 0.0.0.0` if you want to reach it from a phone on the same network).

One reason to prefer local: a page served over `https://` cannot call an `http://localhost` model
server, so the Ollama / LM Studio tier needs either the CORS setup described above or an app served
over plain HTTP — which is what this gives you.

## Hosting your own copy of the app

The hosted link is convenient but it is someone else's Pages site. To own the whole thing: use the
[app repo](https://github.com/tanmayagrawal21/worklog) as a template, enable Pages on your copy
(Settings → Pages → `main`, `/ (root)`), and use your own URL instead. No configuration — the app
reads its own location at runtime. Your data repo is unaffected either way; the two are separate,
and you can point any copy of the app at the same data repo.

## Using it from more than one machine

Point both at the same data repo and paste a token into each. Edits stage locally and merge by event
id on push, so two machines that both went a while without syncing converge rather than clobbering
each other — that case has a test. What doesn't sync is your token or your AI keys: those are
per-browser by design.

## Troubleshooting

**"GitHub refused the write (403)"** — the token lacks *Contents: Read and write* on that repo, or
it's fine-grained and that repo isn't in its selected list.

**The wizard can't create the repo** — fine-grained tokens can't create repos. Either create it
yourself on GitHub and retry, or use a classic token with the `repo` scope.

**"404 reading data/manifest.json"** on a repo you know exists — usually a private repo with no
token, or a token without access to it. A public repo needs no token; a private one always does.

**Nothing loads and the console mentions modules** — you opened `index.html` as a `file://` URL.
Serve it over HTTP (`python3 -m http.server 8000`).

**Changes to a public data repo take a few minutes to appear** — reads of public repos go through
`raw.githubusercontent.com`, which caches for about five minutes. Adding a token switches to the
API, which doesn't.

**A local model endpoint gives a CORS error** — the server needs to allow the app's origin; see the
Ollama and LM Studio notes above.

**The board looks like it's missing old work** — it isn't. Boot reads a snapshot plus recent months
so startup stays fast; the wiki's Days view has *Load 2025* / *Load everything* buttons, and tasks
whose older notes weren't downloaded say so with a button to fetch them.

**An "Upgrade layout" banner appears** — your repo was written by an earlier version that put every
month in one flat directory. The upgrade is one commit that rewrites the layout without changing a
single event, and like every other write it shows you the full plan first. It refuses to run until
the whole history is loaded, so it can't drop anything.
