/**
 * vault.js — local storage of the user's tokens.
 *
 * Scope note: data itself is NOT encrypted. Confidentiality comes from making the
 * data repo private, which GitHub enforces server-side — strictly stronger than a
 * client-side passphrase, and it keeps task JSON readable in `git diff` so the
 * repo works as an actual changelog of your work.
 *
 * What remains worth protecting are the tokens: the GitHub token, which grants write
 * access to the repo, and any AI provider keys, which are billable. Both live in this
 * browser. Two modes:
 *   - plain  : token in localStorage as-is. No prompt; convenient on a machine only
 *              you use. Readable by devtools or any script on this origin.
 *   - locked : token encrypted with AES-GCM under a key derived from a passphrase
 *              (PBKDF2-SHA256). One prompt per session.
 * Tokens are never committed to any repo, so moving to a new machine means pasting
 * the token once there.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

const STORE_KEY = 'worklog.tokens.v1';
const KDF = Object.freeze({ hash: 'SHA-256', iterations: 600000 });

/* ---------- base64 helpers (UTF-8 safe) ---------------------------------- */

const toB64 = (bytes) => {
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000));
  return btoa(s);
};

const fromB64 = (b64) => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

/* ---------- key derivation ---------------------------------------------- */

async function deriveKey(passphrase, salt, iterations = KDF.iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF.hash },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/* ---------- public API --------------------------------------------------- */

export function hasStoredTokens() {
  return localStorage.getItem(STORE_KEY) !== null;
}

/** True when the stored tokens need a passphrase to read. */
export function isLocked() {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return false;
  try { return JSON.parse(raw).locked === true; } catch { return false; }
}

/**
 * Migrate the original single-provider shape. v1 stored one `hfToken`; keys are now
 * per provider, since someone may hold an OpenAI key and an Anthropic key at once.
 * Done here rather than in the app so both storage modes get it for free.
 */
function normaliseSecrets(secrets) {
  const s = { ...(secrets || {}) };
  const aiTokens = { ...(s.aiTokens || {}) };
  if (s.hfToken && !aiTokens.huggingface) aiTokens.huggingface = s.hfToken;
  delete s.hfToken;
  return { githubToken: s.githubToken || null, ...s, aiTokens };
}

/**
 * Persist tokens. Pass a passphrase to encrypt them; omit it to store plainly.
 * @param {{githubToken?:string, aiTokens?:Record<string,string>}} secrets
 */
export async function saveTokens(rawSecrets, passphrase = null) {
  const secrets = normaliseSecrets(rawSecrets);
  if (!passphrase) {
    localStorage.setItem(STORE_KEY, JSON.stringify({ locked: false, secrets }));
    return;
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(secrets)),
  );
  localStorage.setItem(STORE_KEY, JSON.stringify({
    locked: true,
    alg: 'A256GCM',
    kdf: { ...KDF, salt: toB64(salt) },
    iv: toB64(iv),
    ct: toB64(ct),
  }));
}

/**
 * Read tokens back, in the current shape whatever version wrote them.
 * @returns {Promise<object|null>} secrets, or null if absent / wrong passphrase.
 */
export async function loadTokens(passphrase = null) {
  const raw = localStorage.getItem(STORE_KEY);
  if (!raw) return null;

  let rec;
  try { rec = JSON.parse(raw); } catch { return null; }
  if (!rec.locked) return rec.secrets ? normaliseSecrets(rec.secrets) : null;
  if (!passphrase) return null;

  try {
    const key = await deriveKey(passphrase, fromB64(rec.kdf.salt), rec.kdf.iterations);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64(rec.iv) }, key, fromB64(rec.ct),
    );
    return normaliseSecrets(JSON.parse(dec.decode(pt)));
  } catch {
    return null; // AES-GCM auth failure => wrong passphrase
  }
}

export function clearTokens() {
  localStorage.removeItem(STORE_KEY);
}

/** Conservative strength hint, shown as a meter when someone sets a passphrase. */
export function passphraseStrength(pw) {
  const s = pw || '';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(s)).length;
  const words = s.trim().split(/\s+/).filter(Boolean).length;
  let score = 0;
  if (s.length >= 8) score++;
  if (s.length >= 12) score++;
  if (s.length >= 20) score++;
  if (classes >= 3) score++;
  if (words >= 4) score++;
  const labels = ['very weak', 'weak', 'fair', 'good', 'strong', 'excellent'];
  return {
    score: Math.min(score, 5),
    label: labels[Math.min(score, 5)],
    acceptable: s.length >= 10,
  };
}
