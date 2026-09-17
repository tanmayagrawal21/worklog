/**
 * app.js — the shell: state, view switching, and the publish gate.
 *
 * The one rule worth stating twice: every edit in this app stages an event locally,
 * and only publish() contacts the user's repo. The publish dialog shows the literal
 * commit message and file list before anything is sent, because "changes can be
 * pushed from the UI" should not mean "changes leave without being seen".
 */
import { GitHubRepo, AuthError, ConflictError } from './github.js';
import { Store, unionEvents, foldEvents } from './store.js';
import { RepoState, inspect } from './bootstrap.js';
import { loadTokens, hasStoredTokens } from './vault.js';
import { el, clear, $, dialog, confirm, toast, notice, spinner, plural } from './ui/dom.js';
import { BoardView, newTaskDialog } from './ui/board.js';
import { BraindumpView } from './ui/braindump.js';
import { SummaryView } from './ui/summary.js';
import { settingsDialog } from './ui/settings.js';
import { welcomeDialog, unlockDialog, offerScaffold } from './ui/setup.js';

const CONFIG_KEY = 'worklog.config.v1';

const DEFAULTS = {
  owner: '', repo: '', branch: 'main',
  model: 'openai/gpt-oss-120b:fastest',
  sendNotes: true,
  theme: 'auto',
};

class App {
  constructor() {
    this.settings = { ...DEFAULTS, ...readJSON(CONFIG_KEY) };
    this.tokens = { github: null, hf: null };
    this.passphrase = null;
    this.models = null;
    this.search = '';
    this.view = 'board';
    this.repoInfo = null;
    this.loadError = null;
    this.loading = false;

    this.store = null;
    this.views = {
      board: new BoardView(this),
      braindump: new BraindumpView(this),
      summary: new SummaryView(this),
    };
  }

  /* ---------- derived state used by the views -------------------------- */

  /** Everything a view needs about the world, in one place. */
  get state() {
    const events = this.store ? unionEvents(this.store.remoteEvents, this.store.pending) : [];
    const folded = this.store ? this.store.state : foldEvents([]);
    return {
      ...folded,
      events,
      lastEventTs: events.length ? events[events.length - 1].ts : null,
    };
  }

  get tasks() { return this.store ? this.store.tasks : []; }
  get hasPending() { return !!this.store?.hasPending; }
  get configured() { return !!(this.settings.owner && this.settings.repo); }

  /* ---------- lifecycle ------------------------------------------------- */

  async start() {
    this.applyTheme();
    this.mount();

    if (hasStoredTokens()) {
      const { tokens } = await unlockDialog();
      this.tokens = { github: tokens?.githubToken || null, hf: tokens?.hfToken || null };
      this.passphrase = null;
    }

    if (!this.configured) {
      await welcomeDialog();
      const result = await settingsDialog(this);
      if (!result) { this.refresh(); return; }
    }

    await this.connect();
  }

  /** Point at the configured repo, offering to set it up when it is not ready. */
  async connect() {
    if (!this.configured) { this.refresh(); return; }

    this.loading = true;
    this.loadError = null;
    this.refresh();

    const repo = new GitHubRepo({
      owner: this.settings.owner,
      repo: this.settings.repo,
      branch: this.settings.branch,
      token: this.tokens.github,
    });
    this.store = new Store(repo);

    try {
      const { state, info } = await inspect(repo);
      this.repoInfo = info || null;

      if (state !== RepoState.READY) {
        this.loading = false;
        this.refresh();
        if (!this.tokens.github) {
          this.loadError = `${repo.slug} has no work log yet, and setting one up needs a GitHub token. Add one in Settings.`;
          this.refresh();
          return;
        }
        const made = await offerScaffold(this, repo, state);
        if (!made) { this.loadError = `Nothing loaded — ${repo.slug} has no work log in it yet.`; this.refresh(); return; }
        this.loading = true;
        this.refresh();
      }

      await this.store.load();
    } catch (e) {
      this.loadError = e instanceof AuthError
        ? `${e.message} If this repo is private, the token needs Contents: read access to it.`
        : `Could not load ${repo.slug}: ${e.message}`;
    } finally {
      this.loading = false;
      this.refresh();
    }
  }

  /* ---------- staging (local only) -------------------------------------- */

  stage(...events) {
    if (!this.store) { toast('Set up a data repo first.', 'error'); return; }
    this.store.stage(...events);
    this.refresh();
  }

  async discard() {
    const n = this.store.pending.length;
    if (!await confirm({
      title: `Discard ${plural(n, 'unpublished change')}?`,
      body: 'They have not been committed anywhere, so this cannot be undone.',
      confirmLabel: 'Discard',
      danger: true,
    })) return;
    this.store.discardPending();
    toast('Staged changes discarded.');
    this.refresh();
  }

  /* ---------- the publish gate ------------------------------------------ */

  /**
   * Show the exact commit, then push only on confirmation. The preview comes from
   * store.previewCommit(), which is pure and local, so what is shown is what is sent.
   */
  async publish() {
    if (!this.store?.hasPending) return;
    if (!this.tokens.github) {
      toast('Add a GitHub token in Settings to publish.', 'error');
      return;
    }

    const preview = this.store.previewCommit();
    const vis = this.repoInfo?.visibility;

    const body = el('div', {},
      el('p', {}, 'This commits ', el('strong', { text: plural(preview.count, 'change') }), ' to ',
        el('code', { text: `${this.settings.owner}/${this.settings.repo}` }), ' on branch ',
        el('code', { text: this.settings.branch }), ' as a single commit.'),
      el('div', { class: 'section-label', text: 'Commit message' }),
      el('pre', { class: 'commit-preview', text: preview.message }),
      el('div', { class: 'section-label', text: `Files (${preview.files.length})` }),
      el('ul', { class: 'file-list' }, preview.files.map((f) => el('li', { text: f.path }))),
      vis === 'public'
        ? notice('warn', 'This repo is public — anything here is world-readable, including task titles and notes.')
        : notice('info', 'This repo is private. Task content is committed as plain JSON, readable by anyone with access to the repo.'),
    );

    const { done } = dialog({
      title: 'Publish to GitHub?',
      body,
      buttons: [{ label: 'Cancel', value: false }, { label: 'Push this commit', class: 'primary', value: true }],
    });
    if (await done !== true) return;

    const busy = dialog({ title: 'Publishing', body: spinner('Committing to GitHub…'), dismissable: false });
    try {
      const res = await this.store.push();
      busy.close(true);
      toast(`Published ${plural(res?.count ?? preview.count, 'change')}.`);
    } catch (e) {
      busy.close(true);
      const msg = e instanceof ConflictError
        ? 'Someone (or another tab) changed the repo while this was pushing, and merging kept failing. Your changes are still staged — try again.'
        : e instanceof AuthError
          ? `${e.message} The token needs Contents: read and write on this repo.`
          : `Push failed: ${e.message}`;
      dialog({ title: 'Not published', body: notice('error', msg), buttons: [{ label: 'Close', value: true }] });
    }
    this.refresh();
  }

  /* ---------- navigation ------------------------------------------------ */

  go(view) { this.view = view; this.refresh(); }

  reveal(taskId) {
    this.view = 'board';
    this.views.board.reveal(taskId);
  }

  saveSettings(next) {
    this.settings = { ...this.settings, ...next };
    localStorage.setItem(CONFIG_KEY, JSON.stringify(this.settings));
    this.applyTheme();
  }

  applyTheme() {
    const t = this.settings.theme || 'auto';
    if (t === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = t;
  }

  /* ---------- rendering -------------------------------------------------- */

  mount() {
    this.header = el('header', { class: 'top' });
    this.nav = el('nav', { class: 'tabs' });
    this.main = el('main', {});
    document.body.append(this.header, this.nav, this.main);
    this.refresh();
  }

  refresh() {
    this.renderHeader();
    this.renderNav();
    this.renderMain();
  }

  renderHeader() {
    clear(this.header);

    const slug = this.configured ? `${this.settings.owner}/${this.settings.repo}` : 'no repo set';
    const priv = this.repoInfo?.visibility === 'private';

    const search = el('input', {
      type: 'text',
      placeholder: 'Search tasks…',
      value: this.search,
      style: 'max-width:200px',
      'aria-label': 'Search tasks',
      on: { input: (e) => { this.search = e.target.value; this.renderMain(); } },
    });

    this.header.append(
      el('div', { class: 'brand' }, el('span', { class: `dot ${this.tokens.github ? '' : 'offline'}`, title: this.tokens.github ? 'Token loaded — you can publish' : 'Read-only: no GitHub token' }), 'Work Log'),
      el('span', { class: 'repo-chip', title: slug }, priv ? el('span', { class: 'lock', text: '🔒 ' }) : null, slug),
      el('span', { class: 'spacer' }),
      this.view === 'board' ? search : null,
      this.hasPending ? el('span', { class: 'pending-badge', text: `${this.store.pending.length} unpublished` }) : null,
      this.hasPending ? el('button', { class: 'ghost', text: 'Discard', on: { click: () => this.discard() } }) : null,
      el('button', { class: 'primary', text: 'Publish', disabled: !this.hasPending, on: { click: () => this.publish() } }),
      el('button', { text: '+ Task', disabled: !this.store, on: { click: () => newTaskDialog(this) } }),
      el('button', {
        class: 'icon ghost',
        text: '⚙',
        title: 'Settings',
        'aria-label': 'Settings',
        on: {
          click: async () => {
            const r = await settingsDialog(this);
            if (r === 'repo-changed') await this.connect();
            else this.refresh();
          },
        },
      }),
    );
  }

  renderNav() {
    clear(this.nav);
    const counts = { board: this.tasks.length };
    for (const [id, label] of [['board', 'Board'], ['braindump', 'Brain dump'], ['summary', 'Summary']]) {
      this.nav.append(el('button', {
        role: 'tab',
        'aria-selected': String(this.view === id),
        text: counts[id] != null ? `${label} (${counts[id]})` : label,
        on: { click: () => this.go(id) },
      }));
    }
  }

  renderMain() {
    clear(this.main);

    if (this.loading) { this.main.append(el('div', { class: 'view-narrow' }, el('div', { class: 'card' }, spinner('Loading your log from GitHub…')))); return; }

    if (!this.configured) {
      this.main.append(el('div', { class: 'view-narrow' }, el('div', { class: 'card' },
        el('h2', { text: 'No data repo yet' }),
        el('p', { class: 'sub', text: 'Point this at a GitHub repo to store your log. It can create one for you.' }),
        el('div', { style: 'margin-top:12px' },
          el('button', { class: 'primary', text: 'Open settings', on: { click: async () => { const r = await settingsDialog(this); if (r) await this.connect(); } } })))));
      return;
    }

    if (this.loadError) {
      this.main.append(el('div', { class: 'view-narrow' }, el('div', { class: 'card' },
        el('h2', { text: 'Could not load your log' }),
        notice('error', this.loadError),
        el('div', { class: 'row' },
          el('button', { text: 'Retry', on: { click: () => this.connect() } }),
          el('span', { class: 'spacer' }),
          el('button', { text: 'Settings', on: { click: async () => { const r = await settingsDialog(this); if (r) await this.connect(); } } })))));
      return;
    }

    if (!this.tokens.github) {
      this.main.append(el('div', { class: 'view-narrow', style: 'margin-bottom:14px' },
        notice('info', 'Read-only: no GitHub token loaded, so nothing can be published. Add one in Settings.')));
    }

    this.main.append(this.views[this.view].render());
  }
}

function readJSON(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}

/* ---------- boot ---------------------------------------------------------- */

const app = new App();
window.app = app;                 // handy in devtools; nothing depends on it
app.start().catch((e) => {
  document.body.append(el('div', { class: 'view-narrow', style: 'padding:20px' },
    el('div', { class: 'card' }, el('h2', { text: 'The app failed to start' }), notice('error', e.message))));
});

/* Warn on close only when work would be lost. */
addEventListener('beforeunload', (e) => {
  if (app.hasPending) { e.preventDefault(); e.returnValue = ''; }
});
