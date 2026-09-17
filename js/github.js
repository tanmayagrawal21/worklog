/**
 * github.js — the persistence layer. Talks to the GitHub REST API straight from
 * the browser (api.github.com sends `access-control-allow-origin: *`, so no proxy
 * or backend is needed).
 *
 * Data is stored as plain JSON, so `git diff` and `git log -p` show real work
 * history. Confidentiality is therefore the repo's own visibility setting: a private
 * repo is enforced by GitHub server-side, and the token is what unlocks it.
 *
 * Read strategy differs by visibility:
 *   - private repo : the authenticated API only, so a token is required even to read
 *   - public repo  : raw.githubusercontent.com works with no token at all
 * The authenticated API is preferred whenever a token is present, because `raw` sits
 * behind a CDN cache of roughly five minutes and would otherwise serve a stale board
 * immediately after a write.
 */

/* Base64 <-> UTF-8. btoa/atob are Latin-1 only, so route through TextEncoder
   to keep accents and emoji intact in task titles and notes. */
const _enc = new TextEncoder();
const _dec = new TextDecoder();

function utf8ToB64(str) {
  const bytes = _enc.encode(str);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function b64ToUtf8(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return _dec.decode(out);
}

const API = 'https://api.github.com';

/** Thrown when a write races another writer; the store resolves these by merging. */
export class ConflictError extends Error {
  constructor(path) {
    super(`Conflict writing ${path} — remote changed since it was read`);
    this.name = 'ConflictError';
    this.path = path;
  }
}

export class AuthError extends Error {
  constructor(msg) { super(msg); this.name = 'AuthError'; }
}

export class GitHubRepo {
  constructor({ owner, repo, branch = 'main', token = null }) {
    Object.assign(this, { owner, repo, branch, token });
    this._visibility = null;
  }

  get slug() { return `${this.owner}/${this.repo}`; }

  _headers(extra = {}) {
    const h = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Resolve repo metadata; also the cheapest way to validate a token. */
  async info() {
    const res = await fetch(`${API}/repos/${this.slug}`, { headers: this._headers() });
    if (res.status === 401) throw new AuthError('GitHub rejected the token (401). Is it expired?');
    if (res.status === 404) {
      throw new AuthError(
        this.token
          ? `Repo ${this.slug} not found, or the token lacks access to it.`
          : `Repo ${this.slug} not found. If it is private, a token is required.`,
      );
    }
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${await res.text()}`);
    const j = await res.json();
    this._visibility = j.private ? 'private' : 'public';
    return {
      visibility: this._visibility,
      defaultBranch: j.default_branch,
      canPush: !!(j.permissions && j.permissions.push),
      htmlUrl: j.html_url,
    };
  }

  /**
   * Fetch a file. Returns {text, sha} or null when absent.
   * `sha` is the blob sha needed to update the file later; it is null on the raw
   * path, which forces a fetch-before-write in the store.
   */
  async getFile(path) {
    if (this.token) return this._getViaApi(path);
    return this._getViaRaw(path);
  }

  async _getViaApi(path) {
    const url = `${API}/repos/${this.slug}/contents/${encodeURI(path)}?ref=${encodeURIComponent(this.branch)}`;
    const res = await fetch(url, { headers: this._headers() });
    if (res.status === 404) return null;
    if (res.status === 401) throw new AuthError('GitHub rejected the token (401).');
    if (!res.ok) throw new Error(`GitHub ${res.status} reading ${path}: ${await res.text()}`);
    const j = await res.json();
    if (Array.isArray(j)) throw new Error(`${path} is a directory, not a file`);
    // The API wraps base64 at 60 chars; strip whitespace before decoding.
    return { text: b64ToUtf8(j.content.replace(/\s/g, '')), sha: j.sha };
  }

  async _getViaRaw(path) {
    const url = `https://raw.githubusercontent.com/${this.slug}/${encodeURIComponent(this.branch)}/${encodeURI(path)}`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`raw ${res.status} reading ${path}`);
    return { text: await res.text(), sha: null };
  }

  /** Look up just the blob sha, for a write that needs a fresh one. */
  async getSha(path) {
    const f = await this._getViaApi(path);
    return f ? f.sha : null;
  }

  /**
   * Create or update a file in one commit.
   * @param {string|null} sha blob sha being replaced; omit to create
   * @throws {ConflictError} when the remote moved on (409/422 from a stale sha)
   */
  async putFile(path, text, sha, message) {
    if (!this.token) throw new AuthError('A GitHub token is required to save changes.');
    const body = {
      message,
      content: utf8ToB64(text),
      branch: this.branch,
    };
    if (sha) body.sha = sha;

    const res = await fetch(`${API}/repos/${this.slug}/contents/${encodeURI(path)}`, {
      method: 'PUT',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    });

    if (res.status === 409) throw new ConflictError(path);
    if (res.status === 422) {
      // 422 covers both "sha mismatch" and genuine validation errors; only the
      // former is retryable, so inspect the message before deciding.
      const t = await res.text();
      if (/sha|does not match|but expected/i.test(t)) throw new ConflictError(path);
      throw new Error(`GitHub 422 writing ${path}: ${t}`);
    }
    if (res.status === 401) throw new AuthError('GitHub rejected the token (401).');
    if (res.status === 403) {
      throw new AuthError(
        `GitHub refused the write (403). The token likely lacks "Contents: Read and write" on ${this.slug}.`,
      );
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} writing ${path}: ${await res.text()}`);

    const j = await res.json();
    return { sha: j.content.sha, commit: j.commit.sha };
  }

  /* ---------- bootstrapping a brand-new repo ---------------------------- */

  /** Does this repo exist and can we see it? */
  async exists() {
    const res = await fetch(`${API}/repos/${this.slug}`, { headers: this._headers() });
    if (res.status === 401) throw new AuthError('GitHub rejected the token (401). Is it expired?');
    return res.ok;
  }

  /**
   * Does the branch have any commits yet?
   * A freshly created repo with no README has no branches at all, which matters
   * because commitFiles() needs a parent commit to build on.
   */
  async hasCommits() {
    const res = await fetch(`${API}/repos/${this.slug}/git/ref/heads/${this.branch}`, { headers: this._headers() });
    return res.ok;
  }

  /**
   * Create the data repo on the user's account.
   *
   * Note on tokens: a fine-grained PAT is scoped to repositories that already
   * exist, so it generally CANNOT create one. Creating a repo needs either a
   * classic token with `repo` scope, or a fine-grained token granted the
   * account-level "Administration" / repository-creation permission. When the
   * token cannot do it we say so plainly and point at the two alternatives
   * (create it by hand, or run scripts/setup.sh) rather than failing obscurely.
   */
  async createRepo({ private: isPrivate = true, description = 'Personal work log' } = {}) {
    if (!this.token) throw new AuthError('A GitHub token is required to create a repository.');
    const res = await fetch(`${API}/user/repos`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        name: this.repo,
        description,
        private: isPrivate,
        auto_init: false,       // we write the first commit ourselves, below
        has_issues: false,
        has_wiki: false,
      }),
    });

    if (res.status === 403 || res.status === 404) {
      throw new AuthError(
        'This token cannot create repositories. Fine-grained tokens only cover repos that '
        + 'already exist. Either create the repo yourself on github.com (empty, no README) and '
        + 'come back, or run scripts/setup.sh which uses the gh CLI.',
      );
    }
    if (res.status === 422) {
      const t = await res.text();
      if (/already exists/i.test(t)) return { created: false, existed: true };
      throw new Error(`GitHub could not create ${this.repo}: ${t}`);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} creating repo: ${await res.text()}`);

    const j = await res.json();
    this._visibility = j.private ? 'private' : 'public';
    return { created: true, existed: false, htmlUrl: j.html_url, defaultBranch: j.default_branch };
  }

  /**
   * Write the very first commit. commitFiles() cannot be used here because it
   * needs an existing ref to parent from; the contents API creates the branch.
   * Subsequent files go through a normal atomic commit.
   */
  async initialCommit(files, message) {
    if (!files.length) return null;
    const [first, ...rest] = files;
    await this.putFile(first.path, first.text, null, message);
    if (rest.length) await this.commitFiles(rest, message);
    return { ok: true };
  }

  /* ---------- atomic multi-file commit ---------------------------------- */
  /**
   * Write several files in ONE commit via the Git Data API.
   *
   * The simpler contents API writes one file per commit, which would produce three
   * or four commits every time the board is touched and bury the human-readable
   * work history in noise. Building a tree explicitly keeps each save to a single
   * reviewable commit, and makes the write atomic: a partial save can never leave
   * the manifest describing day files that were not written.
   *
   * @param {Array<{path:string, text:string}>} files
   * @param {string} message
   * @throws {ConflictError} when the branch advanced while we were building the commit
   */
  async commitFiles(files, message) {
    if (!this.token) throw new AuthError('A GitHub token is required to save changes.');
    if (!files.length) return null;

    const ref = `heads/${this.branch}`;

    // 1. current branch tip — also our optimistic-concurrency baseline
    const refRes = await fetch(`${API}/repos/${this.slug}/git/ref/${ref}`, { headers: this._headers() });
    if (refRes.status === 404) throw new Error(`Branch "${this.branch}" does not exist in ${this.slug}. Create it (an empty repo has no branches until its first commit).`);
    if (!refRes.ok) throw new Error(`GitHub ${refRes.status} reading ref: ${await refRes.text()}`);
    const parentSha = (await refRes.json()).object.sha;

    // 2. the tree that commit points at, used as the base so untouched files persist
    const parentCommit = await this._json(`${API}/repos/${this.slug}/git/commits/${parentSha}`);

    // 3. new tree. Passing `content` inline lets GitHub create the blobs for us,
    //    saving a round trip per file.
    const tree = await this._json(`${API}/repos/${this.slug}/git/trees`, {
      method: 'POST',
      body: JSON.stringify({
        base_tree: parentCommit.tree.sha,
        tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })),
      }),
    });

    // 4. the commit object
    const commit = await this._json(`${API}/repos/${this.slug}/git/commits`, {
      method: 'POST',
      body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
    });

    // 5. move the branch. force:false makes GitHub enforce a fast-forward, so a
    //    concurrent writer surfaces here as a rejected update rather than a
    //    silently clobbered commit.
    const patch = await fetch(`${API}/repos/${this.slug}/git/refs/${ref}`, {
      method: 'PATCH',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    if (patch.status === 422) throw new ConflictError(this.branch);
    if (!patch.ok) throw new Error(`GitHub ${patch.status} updating ref: ${await patch.text()}`);

    return { commit: commit.sha };
  }

  async _json(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: this._headers(opts.body ? { 'Content-Type': 'application/json' } : {}),
    });
    if (res.status === 401) throw new AuthError('GitHub rejected the token (401).');
    if (res.status === 403) throw new AuthError(`GitHub refused the request (403). The token likely lacks "Contents: Read and write" on ${this.slug}.`);
    if (!res.ok) throw new Error(`GitHub ${res.status} at ${url.replace(API, '')}: ${await res.text()}`);
    return res.json();
  }

  /** Recent commits, so the UI can show the work history as a changelog. */
  async commits(path = null, limit = 30) {
    const params = new URLSearchParams({ sha: this.branch, per_page: String(limit) });
    if (path) params.set('path', path);
    const res = await fetch(`${API}/repos/${this.slug}/commits?${params}`, { headers: this._headers() });
    if (!res.ok) return [];
    return (await res.json()).map((c) => ({
      sha: c.sha.slice(0, 7),
      message: c.commit.message.split('\n')[0],
      date: c.commit.author.date,
      url: c.html_url,
    }));
  }
}
