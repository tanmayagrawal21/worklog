/**
 * settings.js — repo, credentials, model, privacy.
 *
 * Tokens are the sensitive part, so the UI is explicit about where they live: this
 * browser only, never committed, never sent anywhere except the API they belong to.
 * A stored token is shown as a masked placeholder and only overwritten when the user
 * actually types something, so opening Settings to change the model cannot wipe it.
 */
import { listModels, SUGGESTED_MODELS } from '../ai.js';
import { saveTokens, clearTokens, passphraseStrength, hasStoredTokens, isLocked } from '../vault.js';
import { el, dialog, confirm, toast, notice } from './dom.js';

const MASK = '••••••••••••••••';

export function settingsDialog(app) {
  const cfg = app.settings;

  /* --- repo --- */
  const owner = el('input', { type: 'text', value: cfg.owner || '', placeholder: 'your-github-username' });
  const repo = el('input', { type: 'text', value: cfg.repo || '', placeholder: 'worklog-data' });
  const branch = el('input', { type: 'text', value: cfg.branch || 'main' });

  /* --- credentials --- */
  const gh = el('input', { type: 'password', placeholder: app.tokens.github ? MASK : 'ghp_… or github_pat_…', autocomplete: 'off' });
  const hf = el('input', { type: 'password', placeholder: app.tokens.hf ? MASK : 'hf_…', autocomplete: 'off' });

  /* --- model --- */
  const model = el('select', {}, modelOptions(cfg.model, app.models));
  const refresh = el('button', {
    text: 'Load available models',
    on: {
      click: async () => {
        refresh.disabled = true;
        refresh.textContent = 'Loading…';
        app.models = await listModels(app.tokens.hf);
        model.replaceChildren(...modelOptions(model.value, app.models));
        refresh.textContent = `${app.models.length} models`;
      },
    },
  });

  /* --- privacy & appearance --- */
  const sendNotes = el('input', { type: 'checkbox', checked: cfg.sendNotes !== false });
  const theme = el('select', {}, [['auto', 'Match system'], ['light', 'Light'], ['dark', 'Dark']]
    .map(([v, label]) => el('option', { value: v, selected: (cfg.theme || 'auto') === v, text: label })));

  /* --- passphrase lock --- */
  const lock = el('input', { type: 'checkbox', checked: isLocked() });
  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'new-password', disabled: !isLocked() });
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
    notice('info', 'Tokens are stored in this browser only. They are never committed to any repo and never leave your machine except to github.com and huggingface.co.'),
    el('div', { class: 'field' },
      el('label', { text: 'GitHub token' }), gh,
      el('div', { class: 'hint' },
        el('div', {}, el('strong', { text: 'Repo already exists:' }), ' a ',
          el('a', { href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noopener', text: 'fine-grained token' }),
          ' with Contents: read and write on that repo.'),
        el('div', { style: 'margin-top:4px' }, el('strong', { text: 'Want this app to create the repo:' }), ' a ',
          el('a', { href: 'https://github.com/settings/tokens/new?scopes=repo', target: '_blank', rel: 'noopener', text: 'classic token' }),
          ' with the ', el('code', { text: 'repo' }), ' scope. Fine-grained tokens only reach repos that already exist, so they cannot create one.'))),
    el('div', { class: 'field' },
      el('label', { text: 'Hugging Face token' }), hf,
      el('div', { class: 'hint' }, 'Needs the "Make calls to Inference Providers" permission. ',
        el('a', { href: 'https://huggingface.co/settings/tokens', target: '_blank', rel: 'noopener', text: 'Create one' }),
        '. Leave blank to use the app without AI.')),

    el('div', { class: 'field' },
      el('label', { class: 'check' }, lock,
        el('span', {}, el('strong', { text: 'Lock tokens with a passphrase' }),
          el('div', { class: 'hint', text: 'Encrypts them at rest in this browser, so a stray look at devtools does not expose them. You will be asked for it each time the app loads.' }))),
      pass, strength),

    el('h3', { style: 'margin-top:18px', text: 'AI' }),
    el('div', { class: 'field' }, el('label', { text: 'Model' }), model,
      el('div', { class: 'row', style: 'margin-top:8px' }, refresh, el('span', { class: 'spacer' }))),
    el('div', { class: 'field' },
      el('label', { class: 'check' }, sendNotes,
        el('span', {}, el('strong', { text: 'Include note text in AI requests' }),
          el('div', { class: 'hint', text: 'Off means only titles, statuses and tags are sent. Tasks marked private are excluded either way.' })))),

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
            app.tokens = { github: null, hf: null };
            toast('Tokens removed from this browser.');
          },
        },
      })),
  );

  const { done } = dialog({
    title: 'Settings',
    body,
    buttons: [
      { label: 'Cancel', value: false },
      {
        label: 'Save',
        class: 'primary',
        onClick: async () => {
          if (lock.checked && !pass.disabled && pass.value) {
            const s = passphraseStrength(pass.value);
            if (!s.acceptable) { toast('Choose a stronger passphrase.', 'error'); return undefined; }
          }
          if (lock.checked && !isLocked() && !pass.value) { toast('Enter a passphrase, or untick the lock.', 'error'); return undefined; }

          const tokens = {
            github: gh.value.trim() || app.tokens.github,
            hf: hf.value.trim() || app.tokens.hf,
          };

          const passphrase = lock.checked ? (pass.value || app.passphrase) : null;
          if (lock.checked && !passphrase) { toast('Enter the passphrase to keep the lock on.', 'error'); return undefined; }

          await saveTokens({ githubToken: tokens.github, hfToken: tokens.hf }, passphrase);
          app.tokens = tokens;
          app.passphrase = passphrase;

          const repoChanged = owner.value.trim() !== cfg.owner || repo.value.trim() !== cfg.repo || branch.value.trim() !== cfg.branch;
          app.saveSettings({
            owner: owner.value.trim(),
            repo: repo.value.trim(),
            branch: branch.value.trim() || 'main',
            model: model.value,
            sendNotes: sendNotes.checked,
            theme: theme.value,
          });
          return repoChanged ? 'repo-changed' : 'saved';
        },
      },
    ],
  });
  return done;
}

function modelOptions(current, models) {
  const list = [...new Set([...(models || SUGGESTED_MODELS), current].filter(Boolean))];
  return list.map((m) => el('option', { value: m, selected: m === current, text: m }));
}
