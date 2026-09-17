/**
 * app.js — the shell: state, panes, and the publish gate.
 *
 * Layout: the views are panes, not tabs. On a wide screen you can have the board,
 * the brain dump, the summary and the wiki open beside each other, which is the
 * arrangement the daily loop actually wants — read the summary, type what happened,
 * watch the board change. Capacity is derived from the window width, so the same
 * code degrades to one pane on a phone without a separate mobile path.
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
import { el, add, clear, dialog, confirm, toast, notice, spinner, plural } from './ui/dom.js';
import { BoardView, newTaskDialog } from './ui/board.js';
import { BraindumpView } from './ui/braindump.js';
import { SummaryView } from './ui/summary.js';
import { WikiView } from './ui/wiki.js';
import { settingsDialog } from './ui/settings.js';
import { resolveEndpoint, endpointProblem, PROVIDERS } from './providers.js';
import { welcomeDialog, unlockDialog, offerScaffold } from './ui/setup.js';
import { demoRepo } from './demo.js';

const CONFIG_KEY = 'worklog.config.v1';

const DEFAULTS = {
  owner: '', repo: '', branch: 'main',
  // 'none' by default on purpose: until you choose a provider, this app sends your
  // work log to exactly one place -- your own repo.
  provider: 'none',
  baseUrl: '',
  model: '',
  modelByProvider: {},
  providerByMode: {},
  advancedEndpoint: false,
  sendNotes: true,
  theme: 'auto',
  panes: ['board'],
};

const VIEWS = Object.freeze([
  ['board', 'Board'],
  ['braindump', 'Brain dump'],
  ['summary', 'Summary'],
  ['wiki', 'Wiki'],
]);

/**
 * How many panes fit. Thresholds come from the panes themselves: a board column is
 * ~235px and prose stops being readable much under 380px, so anything narrower than
 * these would be worse side by side than stacked.
 */
function paneCapacity() {
  const w = typeof window === 'undefined' ? 1200 : window.innerWidth;
  if (w < 900) return 1;
  if (w < 1300) return 2;
  if (w < 1750) return 3;
  return 4;
}

class App {
  constructor() {
    this.settings = { ...DEFAULTS, ...readJSON(CONFIG_KEY) };
    this.tokens = { github: null, ai: {} };
    this.passphrase = null;
    this.search = '';
    this.panes = this.restorePanes();
    this.focus = this.panes[0];
    this.capacity = paneCapacity();
    this.repoInfo = null;
    this.loadError = null;
    this.loading = false;
    this.historyLoading = null;      // year being fetched on demand, if any
    this.migrating = false;          // a layout upgrade is in flight
    this.demo = typeof location !== 'undefined'
      && new URLSearchParams(location.search).has('demo');

    this.store = null;
    this.views = {
      board: new BoardView(this),
      braindump: new BraindumpView(this),
      summary: new SummaryView(this),
      wiki: new WikiView(this),
    };

    // Re-render only when the number of panes that fit actually changes, so dragging
    // a window edge does not rebuild the DOM on every pixel.
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        const next = paneCapacity();
        if (next === this.capacity) return;
        this.capacity = next;
        this.trimPanes();
        this.refresh();
      });
    }
  }

  /* ---------- panes ------------------------------------------------------- */

  restorePanes() {
    // ?panes=board,summary,wiki wins over the saved layout, so a link can carry one.
    const asked = typeof location !== 'undefined'
      ? (new URLSearchParams(location.search).get('panes') || '').split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const valid = (list) => list.filter((id) => VIEWS.some(([v]) => v === id));
    const saved = valid(this.settings.panes || []);
    const panes = valid(asked).length ? valid(asked) : saved.length ? saved : ['board'];
    return panes.slice(0, paneCapacity());
  }

  isOpen(id) { return this.panes.includes(id); }

  /** Drop the least recently focused panes until the rest fit. */
  trimPanes() {
    while (this.panes.length > this.capacity) {
      const victim = this.panes.find((id) => id !== this.focus) ?? this.panes[0];
      this.panes = this.panes.filter((id) => id !== victim);
    }
    if (!this.panes.includes(this.focus)) this.focus = this.panes[0];
  }

  openPane(id) {
    if (!this.isOpen(id)) {
      this.panes = [...this.panes, id];
      this.focus = id;
      this.trimPanes();
      this.persistPanes();
    } else {
      this.focus = id;
    }
  }

  closePane(id) {
    if (this.panes.length === 1) return;          // always leave something on screen
    this.panes = this.panes.filter((p) => p !== id);
    if (this.focus === id) this.focus = this.panes[0];
    this.persistPanes();
  }

  /** Nav click: with room to spare it toggles a pane; at capacity 1 it swaps. */
  togglePane(id) {
    if (this.capacity === 1) { this.panes = [id]; this.focus = id; this.persistPanes(); }
    else if (this.isOpen(id) && this.panes.length > 1) this.closePane(id);
    else this.openPane(id);
    this.refresh();
  }

  persistPanes() {
    this.saveSettings({ panes: this.panes });
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

  /** Where AI requests go, resolved fresh so a settings change takes effect at once. */
  get endpoint() {
    const ep = resolveEndpoint(this.settings, this.tokens.ai);
    // The demo has no key to paste, and an AI pane that only says "configure a provider"
    // demonstrates nothing. So when the demo's endpoint is unusable -- which for a first
    // visitor it always is -- fall back to the built-in keyword interpreter. A visitor
    // who HAS configured a provider keeps it; this never overrides a working choice.
    if (this.demo && endpointProblem(ep)) return resolveEndpoint({ provider: 'rules' }, {});
    return ep;
  }

  /** True when the AI panes are running on keyword rules rather than a model. */
  get onRules() { return this.endpoint.kind === 'rules'; }

  get aiEnabled() { return !endpointProblem(this.endpoint); }

  /* ---------- lifecycle ------------------------------------------------- */

  async start() {
    this.applyTheme();
    this.mount();

    // ?demo=1 is the front door for someone who has not decided yet: a board to look
    // at with no token, no repo and nothing saved. Checked before anything that could
    // prompt, so the demo never asks for a credential.
    if (this.demo) { await this.connectDemo(); return; }

    if (hasStoredTokens()) {
      const { tokens } = await unlockDialog();
      this.tokens = { github: tokens?.githubToken || null, ai: tokens?.aiTokens || {} };
      this.passphrase = null;
    }

    if (!this.configured) {
      await welcomeDialog();
      const result = await settingsDialog(this);
      if (!result) { this.refresh(); return; }
    }

    await this.connect();
  }

  /**
   * Load the invented board. No network, no token, and writes throw -- so the demo
   * cannot quietly become a thing you lose work in.
   */
  async connectDemo() {
    this.loading = true;
    this.refresh();
    try {
      this.store = new Store(demoRepo({ appUrl: location.href.split('?')[0] }));
      await this.store.load();
    } catch (e) {
      this.loadError = `Could not build the demo board: ${e.message}`;
    } finally {
      this.loading = false;
      this.refresh();
    }
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

  /** Make sure a view is on screen and focused. Used by cross-view links. */
  go(view) {
    this.openPane(view);
    this.refresh();
  }

  /**
   * Fetch a year the boot deliberately skipped.
   *
   * A boot reads the snapshot and the last few months, which is what keeps opening the
   * app fast in year five. The wiki is where you go looking further back, so that is
   * where the rest of the history is offered rather than loaded for everyone.
   */
  async loadHistory(year = null) {
    if (!this.store || this.historyLoading) return;
    this.historyLoading = year || 'all';
    this.refresh();
    try {
      await (year ? this.store.loadYear(year) : this.store.loadAll());
    } catch (e) {
      toast(`Could not load ${year || 'the full history'}: ${e.message}`, 'error');
    } finally {
      this.historyLoading = null;
      this.refresh();
    }
  }

  reveal(taskId) {
    this.openPane('board');
    this.refresh();
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

    add(this.header,
      el('div', { class: 'brand' }, el('span', {
        class: `dot ${this.demo || this.tokens.github ? '' : 'offline'}`,
        title: this.demo ? 'Demo: sample data, nothing saved'
          : this.tokens.github ? 'Token loaded — you can publish' : 'Read-only: no GitHub token',
      }), 'Work Log'),
      this.demo
        ? el('span', { class: 'repo-chip', title: 'Sample data. Nothing is saved and nothing is sent.' }, 'demo — nothing saved')
        : el('span', { class: 'repo-chip', title: slug }, priv ? el('span', { class: 'lock', text: '🔒 ' }) : null, slug),
      this.aiChip(),
      el('span', { class: 'spacer' }),
      this.isOpen('board') ? search : null,
      this.hasPending ? el('span', { class: 'pending-badge', text: `${this.store.pending.length} unpublished` }) : null,
      this.hasPending ? el('button', { class: 'ghost', text: 'Discard', on: { click: () => this.discard() } }) : null,
      this.demo
        ? el('button', { class: 'primary', text: 'Set up mine', title: 'Point this at a repo of your own', on: { click: () => this.leaveDemo() } })
        : el('button', { class: 'primary', text: 'Publish', disabled: !this.hasPending, on: { click: () => this.publish() } }),
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

  /**
   * Says where AI requests go, at a glance. Worth a permanent spot in the header:
   * "is my work log leaving this machine" should never require opening a dialog.
   */
  aiChip() {
    const ep = this.endpoint;
    const p = PROVIDERS[ep.id] || {};
    const mode = p.mode || 'off';
    const rules = ep.kind === 'rules';
    const text = rules ? 'AI: demo rules' : mode === 'off' ? 'AI off' : mode === 'local' ? 'AI: local' : `AI: ${p.label.split(' (')[0]}`;
    const title = rules
      ? 'The demo interpreter: keyword rules in this page, not a model. Nothing is sent anywhere.'
      : mode === 'off'
        ? 'No model configured — nothing is sent anywhere but your repo.'
        : mode === 'local'
          ? `${p.label} — task data stays on this machine.`
          : `${p.label} — task titles (and notes, unless you turn that off) are sent there.`;
    return el('button', {
      class: `ai-chip mode-${mode}`,
      text,
      title,
      on: {
        click: async () => {
          const r = await settingsDialog(this);
          if (r === 'repo-changed') await this.connect(); else this.refresh();
        },
      },
    });
  }

  renderNav() {
    clear(this.nav);
    const counts = { board: this.tasks.length };

    for (const [id, label] of VIEWS) {
      const open = this.isOpen(id);
      this.nav.append(el('button', {
        role: 'tab',
        'aria-selected': String(open),
        class: open ? 'open' : '',
        title: this.capacity === 1
          ? label
          : open
            ? (this.panes.length > 1 ? `Close the ${label} pane` : `${label} — the only pane open`)
            : `Open ${label} beside the others`,
        text: counts[id] != null ? `${label} (${counts[id]})` : label,
        on: { click: () => this.togglePane(id) },
      }));
    }

    // Only worth saying once someone has the room to act on it.
    if (this.capacity > 1) {
      this.nav.append(el('span', { class: 'spacer' }),
        el('span', { class: 'nav-hint', text: `${plural(this.capacity, 'pane')} fit — click to open side by side` }));
    }
  }

  renderMain() {
    clear(this.main);

    if (this.loading) { this.main.append(el('div', { class: 'view-narrow' }, el('div', { class: 'card' }, spinner('Loading your log from GitHub…')))); return; }

    if (!this.configured && !this.demo) {
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

    if (!this.tokens.github && !this.demo) {
      this.main.append(el('div', { class: 'view-narrow', style: 'margin-bottom:14px' },
        notice('info', 'Read-only: no GitHub token loaded, so nothing can be published. Add one in Settings.')));
    }

    if (this.demo) this.main.append(this.demoBanner());
    if (this.store?.needsMigration) this.main.append(this.migrationBanner());

    this.main.append(this.panesEl());
  }

  /**
   * An older repo works as it is, so this says what the upgrade buys rather than
   * warning about a problem. It is offered once per session and never acts on its own.
   */
  /**
   * Say what this is, once, without covering the board. The point of the demo is to
   * be obviously a demo: drag things, read the wiki, and know none of it is kept.
   */
  demoBanner() {
    return el('div', { class: 'view-narrow', style: 'margin-bottom:14px' },
      el('div', { class: 'card' },
        el('h2', { text: 'This is a demo board' }),
        el('p', { class: 'sub', text: 'A week of invented work, so you can see the thing before setting anything up. Drag cards, open the wiki, brain-dump a paragraph and take a summary — nothing is saved, nothing is sent anywhere, and no token was asked for.' }),
        el('p', { class: 'sub' }, 'The two AI views work here too, run by a ',
          el('strong', { text: 'keyword interpreter built into the page' }),
          ' rather than a model: good enough to show how proposals are reviewed before they touch the board, and obviously not as good as the real thing. Settings is where a real provider goes.'),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', { class: 'primary', text: 'Set up my own log', on: { click: () => this.leaveDemo() } }),
          el('span', { class: 'spacer' }),
          el('a', { class: 'sub', href: 'https://github.com/tanmayagrawal21/worklog#readme', target: '_blank', rel: 'noopener', text: 'How it works' }))));
  }

  /** Leave the demo by reloading without ?demo, so no demo state can leak into a real board. */
  async leaveDemo() {
    const go = await confirm({
      title: 'Set up your own log?',
      body: el('p', { class: 'sub', text: 'This leaves the demo and starts the normal setup, which asks for a GitHub repo and a token. The sample board is discarded — it was never saved anywhere.' }),
      confirmLabel: 'Continue',
    });
    if (!go) return;
    location.href = location.href.split('?')[0];
  }

  migrationBanner() {
    return el('div', { class: 'view-narrow', style: 'margin-bottom:14px' },
      el('div', { class: 'card' },
        el('h2', { text: 'This repo uses the older layout' }),
        el('p', { class: 'sub' }, 'Your board and history are complete — nothing is missing or at risk. '
          + 'The older layout just keeps every month in one flat folder with no rendered pages, so the repo '
          + 'is harder to read on GitHub and slower to open once you have a few years in it.'),
        el('p', { class: 'sub', text: 'Upgrading rewrites the same events into per-year folders, adds a readable markdown page beside each month, and turns CHANGELOG.md into an index. No event is changed, and you see the exact commit first.' }),
        el('div', { class: 'row', style: 'margin-top:12px' },
          el('button', {
            class: 'primary',
            text: this.migrating ? 'Preparing…' : 'Upgrade layout…',
            disabled: this.migrating || !this.tokens.github,
            on: { click: () => this.upgradeLayout() },
          }),
          this.tokens.github ? null : el('span', { class: 'hint', text: 'Needs a GitHub token with write access.' }))));
  }

  /**
   * Read the whole history, show the upgrade commit, and only then write it.
   * Same gate as publish(): what the dialog lists is literally what gets sent.
   */
  async upgradeLayout() {
    if (!this.store || this.migrating) return;
    this.migrating = true;
    this.refresh();

    let plan;
    const busy = dialog({ title: 'Reading your full history', body: spinner('Every month has to be read before it can be rewritten…'), dismissable: false });
    try {
      await this.store.loadAll();
      plan = this.store.migrationCommit();
    } catch (e) {
      busy.close(true);
      this.migrating = false;
      this.refresh();
      dialog({ title: 'Could not prepare the upgrade', body: notice('error', e.message), buttons: [{ label: 'Close', value: true }] });
      return;
    }
    busy.close(true);
    this.migrating = false;
    this.refresh();

    if (!plan) { toast('Already on the current layout.'); return; }

    const shown = plan.files.slice(0, 12);
    const body = el('div', {},
      el('p', {}, 'This rewrites ', el('strong', { text: plural(plan.months.length, 'month') }),
        ' as a single commit, preserving all ', el('strong', { text: plural(plan.count, 'event') }), '.'),
      el('div', { class: 'section-label', text: 'Commit message' }),
      el('pre', { class: 'commit-preview', text: plan.message }),
      el('div', { class: 'section-label', text: `Files written (${plan.files.length})` }),
      el('ul', { class: 'file-list' }, [
        ...shown.map((f) => el('li', { text: f.path })),
        plan.files.length > shown.length ? el('li', { text: `…and ${plan.files.length - shown.length} more` }) : null,
      ]),
      plan.deletions.length
        ? el('div', {},
          el('div', { class: 'section-label', text: `Files removed (${plan.deletions.length})` }),
          el('ul', { class: 'file-list' }, plan.deletions.map((d) => el('li', { text: d }))),
          notice('info', 'Their events are written to the new paths in this same commit, and git keeps the old versions in history either way.'))
        : null);

    const { done } = dialog({
      title: 'Upgrade the data layout?',
      body,
      buttons: [{ label: 'Not now', value: false }, { label: 'Push this commit', class: 'primary', value: true }],
    });
    if (await done !== true) return;

    const writing = dialog({ title: 'Upgrading', body: spinner('Committing the new layout…'), dismissable: false });
    try {
      await this.store.migrate();
      writing.close(true);
      toast('Layout upgraded. The repo now renders as markdown on GitHub.');
    } catch (e) {
      writing.close(true);
      dialog({ title: 'Upgrade failed', body: notice('error', `${e.message} Nothing was lost — your events are still committed where they were.`), buttons: [{ label: 'Close', value: true }] });
    }
    this.refresh();
  }

  /** The panes themselves. One element per open view, in the order they were opened. */
  panesEl() {
    const wrap = el('div', { class: `panes count-${this.panes.length}` });

    for (const id of this.panes) {
      const label = VIEWS.find(([v]) => v === id)?.[1] || id;
      const pane = el('section', {
        class: `pane${this.focus === id ? ' focused' : ''}`,
        'aria-label': label,
        on: { focusin: () => { this.focus = id; } },
      });

      // A single pane needs no chrome; more than one, and you need to know which is
      // which and how to get rid of one.
      if (this.panes.length > 1) {
        pane.append(el('div', { class: 'pane-head' },
          el('span', { class: 'pane-title', text: label }),
          el('span', { class: 'spacer' }),
          el('button', {
            class: 'icon ghost',
            text: '×',
            title: `Close ${label}`,
            'aria-label': `Close ${label}`,
            on: { click: () => { this.closePane(id); this.refresh(); } },
          })));
      }

      pane.append(this.views[id].render());
      wrap.append(pane);
    }
    return wrap;
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
