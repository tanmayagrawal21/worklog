# Architecture and workflow

Diagrams are [Mermaid](https://mermaid.js.org/), which GitHub renders inline.

## Architecture

Everything runs in the browser. There is no backend: the only outbound calls are to GitHub (your
data repo) and, if you choose a tier that needs one, a model provider.

```mermaid
flowchart TB
  subgraph Browser["Your browser (static ES modules, no build)"]
    direction TB
    app["app.js<br/>shell, panes, publish gate"]

    subgraph UI["js/ui/"]
      board["board"]
      braindump["braindump"]
      summary["summary"]
      standupui["standup"]
      wiki["wiki"]
      settings["settings / setup / consent"]
    end

    subgraph Core["Core"]
      store["store.js<br/>events, fold, union-merge,<br/>staging, markdown rendering"]
      standup["standup.js<br/>reports built from the log"]
      reminder["reminder.js<br/>end-of-day nudge (pure)"]
      bootstrap["bootstrap.js<br/>inspect / scaffold a repo"]
    end

    subgraph AI["AI layer (optional)"]
      ai["ai.js<br/>negotiation, sanitise, few-shot"]
      providers["providers.js<br/>four tiers"]
      webllm["webllm.js + worker<br/>WebGPU"]
      rules["rules.js<br/>demo interpreter"]
    end

    vault["vault.js<br/>tokens, optional passphrase lock"]
    ls[("localStorage<br/>pending events, tokens")]
    gh["github.js<br/>contents + Git Data API"]
  end

  repo[("Your data repo<br/>JSON + rendered .md")]
  local["Local model<br/>Ollama / llama.cpp / LM Studio"]
  cloud["Cloud model<br/>HF / OpenAI / Anthropic / Google / custom"]

  app --> UI
  UI --> store
  UI --> standup
  UI --> ai
  app --> reminder
  app --> bootstrap
  standup --> store
  store --> ls
  vault --> ls
  app --> vault
  store --> gh
  bootstrap --> gh
  gh -->|"atomic commit, only after preview"| repo
  repo -->|"manifest + snapshot + ~3 months"| gh
  ai --> providers
  ai --> webllm
  ai -.->|"demo, no provider"| rules
  ai -->|"after disclosure gate"| cloud
  ai --> local
```

## Data model

The event log is the source of truth; the board is `fold(events)`.

```mermaid
flowchart LR
  e1["events<br/>data/log/YYYY/MM.json"] --> merge["union by event id<br/>sort by (ts, id)"]
  snap["data/board.json<br/>snapshot + `through` marker"] --> fold
  merge --> fold["fold()"]
  fold --> state["board state"]
  state --> md["BOARD.md, month pages,<br/>year README, CHANGELOG.md"]
```

## Daily workflow

Every edit stages locally. Nothing reaches GitHub until you approve the commit.

```mermaid
sequenceDiagram
  actor U as You
  participant A as App
  participant S as Store (local)
  participant M as Model (optional)
  participant G as GitHub repo

  U->>A: open app
  A->>G: read manifest, snapshot, recent months
  G-->>A: events
  A->>S: fold to board
  opt AI enabled
    A->>M: morning summary
    M-->>A: summary
  end

  loop through the day
    alt drag / edit a card
      U->>S: stage event
    else brain dump
      U->>A: free text
      A->>M: board + text (private tasks excluded)
      M-->>A: proposed operations
      A->>A: sanitise (drop bad ids, enums, no-ops)
      A-->>U: proposals with checkboxes
      U->>S: stage only the ticked ones
    end
  end

  U->>A: Standup
  A->>S: build report from log (no model needed)
  opt Write it up
    A->>M: grouped lines, few-shot prompt
    M-->>A: phrased lines (clamped)
  end
  U->>A: copy
  A->>S: stage standup.set event

  U->>A: Publish
  A-->>U: commit message + file list
  U->>A: approve
  A->>G: one atomic commit (conflicts detected, merged by union)
```

## Cloud disclosure gate

Applies only to the two cloud tiers, before the first request and again when the provider or
endpoint URL changes.

```mermaid
flowchart LR
  req["AI request"] --> tier{"Tier?"}
  tier -->|"No AI"| off["refuse cleanly"]
  tier -->|"On my machine"| run["run locally<br/>nothing leaves"]
  tier -->|"Cloud"| seen{"disclosure<br/>already approved?"}
  seen -->|yes| send
  seen -->|no| show["show URL, model, counts,<br/>private tasks held back,<br/>brain dump verbatim"]
  show -->|approve| send["send"]
  show -->|decline| stop["nothing sent"]
```
