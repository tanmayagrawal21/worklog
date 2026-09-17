/**
 * settings.js — repo, credentials, AI provider, privacy.
 *
 * Tokens are the sensitive part, so the UI is explicit about where they live: this
 * browser only, never committed, never sent anywhere except the API they belong to.
 * A stored token is shown as a masked placeholder and only overwritten when the user
 * actually types something, so opening Settings to change the model cannot wipe it.
 *
 * The AI section asks the privacy question first and the technical one second: choose
 * how much of your log you are willing to send anywhere (nothing / only your own
 * machine / open models in the cloud / a commercial API), and only then which
 * provider inside that choice. Endpoint, key field, model list and setup notes all
 * follow. Keys are kept per provider, because trying OpenAI for a day should not
 * cost you your Anthropic key.
 */
import { listModels, suggestedFor } from '../ai.js';
import { MODES, PROVIDERS, DEFAULT_PROVIDER, providersInMode, modeOf, resolveEndpoint } from '../providers.js';
import { hasWebGPU, preloadBrowserModel, unloadBrowserModel } from '../webllm.js';
import { saveTokens, clearTokens, passphraseStrength, hasStoredTokens, isLocked } from '../vault.js';
import { forgetConsent } from './consent.js';
import { el, add, clear, dialog, confirm, toast, notice } from './dom.js';

const MASK = '••••••••••••••••';

export function settingsDialog(app) {
  const cfg = app.settings;

  /* --- repo --- */
  const owner = el('input', { type: 'text', value: cfg.owner || '', placeholder: 'your-github-username' });
  const repo = el('input', { type: 'text', value: cfg.repo || '', placeholder: 'worklog-data' });
  const branch = el('input', { type: 'text', value: cfg.branch || 'main' });
  const gh = el('input', { type: 'password', placeholder: app.tokens.github ? MASK : 'ghp_… or github_pat_…', autocomplete: 'off' });

  /* --- AI: mode first, then which provider inside that mode --- */
  const startProvider = cfg.provider && PROVIDERS[cfg.provider] ? cfg.provider : DEFAULT_PROVIDER;
  let currentMode = modeOf(startProvider);
  let currentProvider = startProvider;

  const provider = el('select', {});
  const providerField = el('div', { class: 'field' }, el('label', { text: 'Which one' }), provider);

  const baseUrl = el('input', { type: 'text', autocomplete: 'off' });
  const baseField = el('div', { class: 'field' }, el('label', { text: 'Endpoint URL' }), baseUrl,
    el('div', { class: 'hint', text: 'Must end at the path that serves /chat/completions.' }));

  const key = el('input', { type: 'password', autocomplete: 'off' });
  const keyHint = el('div', { class: 'hint' });
  const keyField = el('div', { class: 'field' }, el('label', { text: 'API key' }), key, keyHint);

  const model = el('input', { type: 'text', list: 'model-list', autocomplete: 'off', placeholder: 'model id' });
  const modelList = el('datalist', { id: 'model-list' });
  const loadBtn = el('button', { text: 'Load available models' });
  const modelField = el('div', { class: 'field' }, el('label', { text: 'Model' }), model, modelList,
    el('div', { class: 'row', style: 'margin-top:8px' }, loadBtn, el('span', { class: 'spacer' })));
  const providerNote = el('div', {});

  // Keys typed this session, per provider, so switching the picker back and forth
  // does not lose an unsaved paste.
  const typedKeys = {};

  const modeRadios = MODES.map((m) => {
    const input = el('input', { type: 'radio', name: 'ai-mode', value: m.id, checked: m.id === currentMode });
    input.addEventListener('change', () => {
      if (!input.checked) return;
      typedKeys[currentProvider] = key.value;
      currentMode = m.id;
      const remembered = cfg.providerByMode?.[m.id];
      const inMode = providersInMode(m.id);
      currentProvider = inMode.some((p) => p.id === remembered) ? remembered : inMode[0].id;
      applyMode();
    });
    return el('label', { class: 'check' }, input,
      el('span', {}, el('strong', { text: m.label }), el('div', { class: 'hint', text: m.blurb })));
  });

  const setModelList = (models) => {
    clear(modelList);
    add(modelList, [...new Set(models)].map((mid) => el('option', { value: mid })));
  };

  /** Repopulate the provider list for the chosen mode, then rebuild the fields. */
  const applyMode = () => {
    const inMode = providersInMode(currentMode);
    clear(provider);
    add(provider, inMode.map((p) => el('option', { value: p.id, selected: p.id === currentProvider, text: p.label })));
    providerField.hidden = inMode.length < 2;
    applyProvider();
  };

  const applyProvider = () => {
    const id = provider.value || currentProvider;
    currentProvider = id;
    const p = PROVIDERS[id];
    const off = p.mode === 'off';

    baseUrl.value = (id === cfg.provider ? cfg.baseUrl : '') || p.baseUrl || '';
    baseUrl.placeholder = p.baseUrl || 'https://your-server/v1';
    baseField.hidden = off || p.kind === 'webgpu' || (!p.custom && !cfg.advancedEndpoint);

    keyField.hidden = off || p.kind === 'webgpu' || (!p.needsToken && !p.custom);
    key.value = typedKeys[id] || '';
    key.placeholder = app.tokens.ai?.[id] ? MASK : (p.needsToken ? 'API key' : 'optional');
    clear(keyHint);
    add(keyHint, p.tokenHint || 'Only sent to this provider. Never committed.',
      p.tokenUrl ? ' ' : null,
      p.tokenUrl ? el('a', { href: p.tokenUrl, target: '_blank', rel: 'noopener', text: 'Get a key' }) : null,
      p.needsToken ? null : ' — this provider runs without one.');

    modelField.hidden = off;
    // Remembered per provider: an OpenAI model id means nothing to Ollama.
    model.value = (cfg.modelByProvider?.[id]) || (id === cfg.provider ? cfg.model : '') || p.suggested[0] || '';
    setModelList(suggestedFor(id));
    loadBtn.disabled = false;
    loadBtn.textContent = 'Load available models';

    clear(providerNote);
    add(providerNote,
      p.kind === 'webgpu' && !hasWebGPU()
        ? notice('error', 'This browser reports no WebGPU support, so a model cannot run in the page. Chrome or Edge will; otherwise use a local server or a hosted provider.')
        : null,
      p.kind === 'webgpu' ? webgpuControls() : null,
      p.setup ? el('div', { class: 'field' },
        el('label', { text: 'Starting it on your machine' }),
        el('pre', { class: 'commit-preview', text: p.setup }),
        el('div', { class: 'hint', text: 'Nothing leaves your machine with a local provider, and it costs nothing to run.' })) : null,
      p.note ? notice('info', p.note) : null,
      p.browser === 'unknown'
        ? notice('warn', 'Browsers can only call an endpoint that permits it. If requests fail with no error detail, the server is not sending CORS headers for this page.')
        : null);
  };

  /**
   * Downloading a couple of gigabytes deserves its own button and a progress line —
   * discovering the wait halfway through generating a summary would be worse.
   */
  function webgpuControls() {
    const status = el('div', { class: 'hint' });
    const dl = el('button', {
      text: 'Download and load this model now',
      disabled: !hasWebGPU(),
      on: {
        click: async () => {
          const mid = model.value.trim();
          if (!mid) { toast('Pick a model first.', 'error'); return; }
          dl.disabled = true;
          try {
            await preloadBrowserModel(mid, ({ text, progress }) => {
              status.textContent = `${text}${progress ? ` (${Math.round(progress * 100)}%)` : ''}`;
            });
            status.textContent = 'Loaded and ready. It stays cached for next time.';
          } catch (e) {
            status.textContent = `Could not load it: ${e.message}`;
          }
          dl.disabled = false;
        },
      },
    });
    const free = el('button', {
      class: 'ghost',
      text: 'Unload from memory',
      on: { click: async () => { await unloadBrowserModel(model.value.trim()); status.textContent = 'Unloaded. The download stays cached.'; } },
    });
    return el('div', { class: 'field' },
      el('div', { class: 'row' }, dl, free, el('span', { class: 'spacer' })), status);
  }

  provider.addEventListener('change', () => {
    typedKeys[currentProvider] = key.value;
    applyProvider();
  });

  loadBtn.addEventListener('click', async () => {
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading…';
    const ep = resolveEndpoint(
      { provider: currentProvider, baseUrl: baseUrl.value.trim(), model: model.value.trim() },
      { ...app.tokens.ai, [currentProvider]: key.value.trim() || app.tokens.ai?.[currentProvider] },
    );
    const models = await listModels(ep);
    setModelList(models);
    loadBtn.disabled = false;
    loadBtn.textContent = models.length ? `${models.length} models — click the field to choose` : 'No list available; type an id';
  });

  /* --- privacy & appearance --- */
  const sendNotes = el('input', { type: 'checkbox', checked: cfg.sendNotes !== false });
  const reminderAt = el('input', { type: 'time', value: cfg.reminderAt || '' });
  const theme = el('select', {}, [['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']]
    .map(([v, label]) => el('option', { value: v, selected: (cfg.theme || 'auto') === v, text: label })));
  const advanced = el('input', { type: 'checkbox', checked: !!cfg.advancedEndpoint });
  advanced.addEventListener('change', () => { cfg.advancedEndpoint = advanced.checked; applyProvider(); });

  /* --- passphrase lock --- */
  // Ticked by default for anyone who has not stored tokens yet. A token in plain
  // localStorage is readable by devtools and by anything else running on this origin,
  // so the lock is the right default and an unlocked store should be a choice someone
  // made rather than one they never saw. Already decided? Their setting stands.
  const lockDefault = hasStoredTokens() ? isLocked() : true;
  const lock = el('input', { type: 'checkbox', checked: lockDefault });
  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'new-password', disabled: !lockDefault });
  const strength = el('div', { class: 'hint' });
  lock.addEventListener('change', () => { pass.disabled = !lock.checked; strength.textContent = ''; });
  pass.addEventListener('input', () => {
    if (!pass.value) { strength.textContent = ''; return; }
    const s = passphraseStrength(pass.value);
    strength.textContent = `Strength: ${s.label}${s.acceptable ? '' : ' — too weak, use a longer phrase'}`;
    strength.style.color = s.acceptable ? 'var(--good)' : 'var(--danger)';
  });

  const body = el('div', {},
    el('h3', { text: 'Your data repo' }),
    el('p', { class: 'sub', text: 'The repo that holds your tasks. Private keeps it to you; that setting is enforced by GitHub, not by this app.' }),
    el('div', { class: 'row', style: 'margin-top:10px' },
      el('div', { class: 'field' }, el('label', { text: 'Owner' }), owner),
      el('div', { class: 'field' }, el('label', { text: 'Repository' }), repo),
      el('div', { class: 'field' }, el('label', { text: 'Branch' }), branch)),
    el('p', { class: 'hint' }, el('strong', { text: 'The repo does not need to exist yet.' }),
      ' If it does not, saving these settings offers to create it — asking first whether it should be '
      + 'private or public, and showing you the files it would commit. Nothing is created without that yes.'),

    el('h3', { style: 'margin-top:18px', text: 'Credentials' }),
    notice('info', 'Tokens are stored in this browser only. They are never committed to any repo, and each is only ever sent to the service it belongs to.'),
    el('div', { class: 'field' },
      el('label', { text: 'GitHub token' }), gh,
      el('div', { class: 'hint' },
        el('div', {}, el('strong', { text: 'Repo already exists:' }), ' a ',
          el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'fine-grained token' }),
          ' with Contents: read and write on that repo.'),
        el('div', { style: 'margin-top:4px' }, el('strong', { text: 'Want this app to create the repo:' }), ' a ',
          el('a', { href: 'https://github.com/settings/tokens/new?scopes=repo', target: '_blank', rel: 'noopener', text: 'classic token' }),
          ' with the ', el('code', { text: 'repo' }), ' scope. Fine-grained tokens only reach repos that already exist, so they cannot create one.'))),

    hasStoredTokens() && !isLocked()
      ? notice('warn', 'Your tokens are stored unlocked, so anything with access to this browser profile can read them. Ticking the lock below encrypts them at rest.')
      : null,
    el('div', { class: 'field' },
      el('label', { class: 'check' }, lock,
        el('span', {}, el('strong', { text: 'Lock tokens with a passphrase' }),
          el('span', { class: 'pill-rec', text: 'Recommended' }),
          el('div', { class: 'hint', text: 'Encrypts them at rest in this browser (PBKDF2-SHA256 into AES-GCM), so a stray look at devtools does not expose them. One prompt each time the app loads. Untick it if this is a machine only you use and the prompt is not worth it.' }))),
      pass, strength),

    el('h3', { style: 'margin-top:18px', text: 'AI' }),
    el('p', { class: 'sub', text: 'Only two features use a model: the daily summary and the brain dump. Everything else — board, notes, search, publishing, changelog — works regardless.' }),
    el('div', { class: 'field' }, el('label', { text: 'How much leaves your machine' }), ...modeRadios),
    providerField,
    keyField,
    baseField,
    modelField,
    providerNote,
    el('div', { class: 'field' },
      el('label', { class: 'check' }, sendNotes,
        el('span', {}, el('strong', { text: 'Include note text in AI requests' }),
          el('div', { class: 'hint', text: 'Off means only titles, statuses and tags are sent. Tasks marked private are excluded either way.' })))),
    el('div', { class: 'field' },
      el('label', { class: 'check' }, advanced,
        el('span', {}, 'Let me override the endpoint URL',
          el('div', { class: 'hint', text: 'For a proxy, a self-hosted gateway, or a region-specific host.' })))),

    el('h3', { style: 'margin-top:18px', text: 'Publishing' }),
    el('div', { class: 'field' },
      el('label', { text: 'End-of-day reminder' }), reminderAt,
      el('div', { class: 'hint', text: 'Local time. Once a day, and only if something is unpublished or the evening summary is missing. Clear the field to turn it off.' })),

    el('h3', { style: 'margin-top:18px', text: 'Appearance' }),
    el('div', { class: 'field' }, el('label', { text: 'Theme' }), theme),

    el('div', { style: 'margin-top:18px' },
      el('button', {
        class: 'danger',
        text: 'Forget tokens on this browser',
        disabled: !hasStoredTokens(),
        on: {
          click: async () => {
            if (!await confirm({ title: 'Forget stored tokens?', body: 'You will need to paste them again to publish or use AI. Your data in the repo is untouched.', confirmLabel: 'Forget them', danger: true })) return;
            clearTokens();
            // The consent record is about those keys. Keeping it would silently
            // re-authorise the next key pasted for the same provider.
            forgetConsent();
            app.tokens = { github: null, ai: {} };
            toast('Tokens removed from this browser.');
          },
        },
      })),
  );

  applyMode();

  const { done } = dialog({
    title: 'Settings',
    body,
    buttons: [
      { label: 'Cancel', value: false },
      {
        label: 'Save',
        class: 'primary',
        onClick: async () => {
          const pid = currentProvider;
          if (PROVIDERS[pid].custom && !baseUrl.value.trim()) { toast('A custom provider needs an endpoint URL.', 'error'); return undefined; }

          typedKeys[pid] = key.value;
          const ai = { ...app.tokens.ai };
          for (const [id, typed] of Object.entries(typedKeys)) {
            const t = typed.trim();
            if (t && t !== MASK) ai[id] = t;
          }

          const tokens = { github: gh.value.trim() || app.tokens.github, ai };
          // The lock is ticked by default, which must not turn "save my repo name"
          // into "invent a passphrase first". Nothing stored yet means nothing to
          // protect, so the tick is a standing preference and not a blocker.
          const anySecret = !!(tokens.github || Object.values(ai).some(Boolean));
          const wantLock = lock.checked && anySecret;

          if (wantLock && pass.value) {
            const s = passphraseStrength(pass.value);
            if (!s.acceptable) { toast('Choose a stronger passphrase.', 'error'); return undefined; }
          }
          const passphrase = wantLock ? (pass.value || app.passphrase) : null;
          if (wantLock && !passphrase) { toast('Enter a passphrase, or untick the lock.', 'error'); return undefined; }

          await saveTokens({ githubToken: tokens.github, aiTokens: ai }, passphrase);
          app.tokens = tokens;
          app.passphrase = passphrase;

          const repoChanged = owner.value.trim() !== cfg.owner || repo.value.trim() !== cfg.repo || branch.value.trim() !== cfg.branch;
          app.saveSettings({
            owner: owner.value.trim(),
            repo: repo.value.trim(),
            branch: branch.value.trim() || 'main',
            provider: pid,
            providerByMode: { ...(cfg.providerByMode || {}), [PROVIDERS[pid].mode]: pid },
            baseUrl: baseUrl.value.trim(),
            model: model.value.trim(),
            modelByProvider: { ...(cfg.modelByProvider || {}), [pid]: model.value.trim() },
            advancedEndpoint: advanced.checked,
            sendNotes: sendNotes.checked,
            reminderAt: reminderAt.value || '',
            // A changed time is a fresh intention: it should be allowed to fire today
            // rather than be swallowed by this morning's already-fired flag.
            ...(reminderAt.value !== (cfg.reminderAt || '') ? { reminderLastFired: '' } : {}),
            theme: theme.value,
          });
          return repoChanged ? 'repo-changed' : 'saved';
        },
      },
    ],
  });
  return done;
}
