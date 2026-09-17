/**
 * setup.js — first run, unlocking, and creating a data repo.
 *
 * The rule this file exists to enforce: nothing is written to anyone's GitHub without
 * an explicit yes, and the yes is shown the exact file list it is agreeing to. The
 * scaffold is computed by bootstrap.scaffoldFiles(), which is pure, so the dialog can
 * list precisely what a confirmation will commit.
 */
import { RepoState, scaffoldFiles, scaffold } from '../bootstrap.js';
import { loadTokens, isLocked } from '../vault.js';
import { el, dialog, notice, toast } from './dom.js';

export function welcomeDialog() {
  const { done } = dialog({
    title: 'Welcome to your work log',
    body: el('div', {},
      el('p', {}, 'A Kanban board for your own work that lives in a git repo you own, so you end up with a ',
        el('strong', { text: 'readable changelog of what you did' }), '.'),
      el('ul', {},
        el('li', {}, el('strong', { text: 'You own the data.' }), ' Tasks are committed as plain JSON to your repo — private or public, your choice.'),
        el('li', {}, el('strong', { text: 'Nothing is published without asking.' }), ' Edits stage locally; you see the exact commit before it goes.'),
        el('li', {}, el('strong', { text: 'The AI is optional, and you choose how much it sees.' }),
          ' Off entirely, running on your own machine, an open model in the cloud, or your own API key — and every change it proposes is yours to approve.')),
      el('p', { class: 'sub' }, 'Next: a repo to keep the log in, and a GitHub token so this can write to it. No repo yet? It can create one for you.'),
      // Offered as a preview, not as an alternative -- the demo is a nice way to see the
      // loop, but the token is the two-minute step that makes the app yours.
      el('p', { class: 'sub' }, 'Want to see it running first? ',
        el('a', { href: '?demo=1', text: 'Open the demo board' }),
        ' — the same app over invented work, then come back here.'),
    ),
    buttons: [{ label: 'Get started', class: 'primary', value: true }],
    dismissable: false,
  });
  return done;
}

/** Ask for the passphrase that unlocks stored tokens. Retries until right or skipped. */
export async function unlockDialog() {
  if (!isLocked()) return { tokens: await loadTokens(), passphrase: null };

  const pass = el('input', { type: 'password', placeholder: 'passphrase', autocomplete: 'current-password' });
  const err = el('div', {});

  const { done, close } = dialog({
    title: 'Unlock your tokens',
    body: el('div', {},
      el('p', { class: 'sub', text: 'Your GitHub token and any AI provider keys are encrypted in this browser.' }),
      el('div', { class: 'field' }, el('label', { text: 'Passphrase' }), pass), err),
    buttons: [
      { label: 'Skip (read-only)', value: 'skip' },
      {
        label: 'Unlock',
        class: 'primary',
        onClick: async () => {
          const tokens = await loadTokens(pass.value);
          if (!tokens) {
            err.replaceChildren(notice('error', 'That passphrase does not match. Try again.'));
            pass.value = '';
            pass.focus();
            return undefined;
          }
          return { tokens, passphrase: pass.value };
        },
      },
    ],
    dismissable: false,
  });
  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.closest('dialog').querySelector('.dlg-foot button.primary').click(); });
  setTimeout(() => pass.focus(), 50);

  const result = await done;
  if (!result || result === 'skip') return { tokens: { githubToken: null, aiTokens: {} }, passphrase: null, skipped: true };
  return { tokens: result.tokens, passphrase: result.passphrase };
}

/**
 * Offer to set up a repo that is missing or empty.
 * @returns {Promise<boolean>} true when something was created and the caller should reload.
 */
export async function offerScaffold(app, repo, state) {
  const missing = state === RepoState.MISSING;

  const isPrivate = el('input', { type: 'radio', name: 'vis', checked: true });
  const isPublic = el('input', { type: 'radio', name: 'vis' });
  const examples = el('input', { type: 'checkbox', checked: true });

  const preview = scaffoldFiles({ slug: repo.slug, appUrl: location.href.split('?')[0], withExamples: true });

  const body = el('div', {},
    el('p', {}, missing
      ? `The repo ${repo.slug} does not exist yet. This can create it and add a starter board.`
      : `${repo.slug} exists but has no work log in it yet. This can add the starter files.`),

    missing ? el('div', { class: 'field' },
      el('label', { text: 'Visibility' }),
      el('label', { class: 'check' }, isPrivate, el('span', {}, el('strong', { text: 'Private' }), el('div', { class: 'hint', text: 'Recommended. Only you (and anyone you invite) can read it.' }))),
      el('label', { class: 'check' }, isPublic, el('span', {}, el('strong', { text: 'Public' }), el('div', { class: 'hint', text: 'Anyone can read your task titles and notes. Also readable without a token.' })))) : null,

    el('div', { class: 'field' },
      el('label', { class: 'check' }, examples,
        el('span', {}, el('strong', { text: 'Include three example tasks' }), el('div', { class: 'hint', text: 'A quick way to see how the board works. Delete them whenever.' })))),

    el('div', { class: 'section-label', text: 'This will commit' }),
    el('ul', { class: 'file-list' }, preview.files.map((f) => el('li', { text: f.path }))),
    notice('info', 'One commit, on your repo, only after you confirm. Nothing else on your account is touched.'),
  );

  const { done } = dialog({
    title: missing ? 'Create your data repo?' : 'Set up this repo?',
    body,
    buttons: [
      { label: 'Not now', value: false },
      { label: missing ? 'Create repo and commit' : 'Commit starter files', class: 'primary', value: true },
    ],
  });

  if (await done !== true) return false;

  try {
    await scaffold({
      repo,
      state,
      isPrivate: isPrivate.checked,
      withExamples: examples.checked,
      appUrl: location.href.split('?')[0],
    });
    toast('Repo set up.');
    return true;
  } catch (e) {
    dialog({
      title: 'Could not set that up',
      body: el('div', {}, notice('error', e.message),
        el('p', { class: 'sub' }, 'If this is about permissions: fine-grained tokens only work on repos that already exist. Create ',
          el('code', { text: repo.slug }), ' on GitHub yourself, then try again — or use a classic token with the ',
          el('code', { text: 'repo' }), ' scope.')),
      buttons: [{ label: 'Close', value: true }],
    });
    return false;
  }
}
