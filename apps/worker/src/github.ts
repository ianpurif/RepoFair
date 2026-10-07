import { createHash, createHmac, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { KeyObject } from 'node:crypto';

/** Native GitHub REST API; server only. No imported repository code is executed. */
export const GITHUB_API_VERSION = '2026-03-10';
const API = 'https://api.github.com';
const MAX_JSON_BYTES = 6_000_000;
const SHA = /^[a-f0-9]{40}$/;
export class GitHubError extends Error {
  constructor(public readonly code: 'configuration' | 'unauthorized' | 'upstream' | 'invalid' | 'limit', message: string, public readonly status?: number) {
    super(message); this.name = 'GitHubError';
  }
}
function invalid(message: string): never { throw new GitHubError('invalid', message); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('Invalid GitHub response');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return invalid('Invalid GitHub identifier');
  return value;
}
function boundedString(value: unknown, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) return invalid('Invalid GitHub value');
  return value;
}
function segment(value: string): string {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(value) || value === '.' || value === '..') return invalid('Invalid repository name');
  return encodeURIComponent(value);
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !SHA.test(value)) return invalid('Invalid immutable GitHub object');
  return value;
}
export type GitHubConfiguration = Readonly<{ appId: string; privateKey: KeyObject }>;
/** Never print the environment or PEM. A client secret is not an App signing key. */
export async function loadGitHubConfiguration(env: Readonly<Record<string, string | undefined>>): Promise<GitHubConfiguration> {
  const appId = env.GITHUB_APP_ID?.trim();
  if (!appId || !/^\d{1,18}$/.test(appId)) throw new GitHubError('configuration', 'GITHUB_APP_ID must be the numeric App ID');
  let pem = env.GITHUB_APP_PRIVATE_KEY?.trim();
  const file = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim();
  if (pem && file) throw new GitHubError('configuration', 'Configure one GitHub App private key source');
  if (file) {
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > 32_768) throw new Error();
      pem = await readFile(file, 'utf8');
    } catch { throw new GitHubError('configuration', 'GitHub App private key file is unavailable or invalid'); }
  }
  pem = pem?.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n').replace(/\r\n/g, '\n');
  if (!pem || pem.length > 32_768 || !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n/.test(pem)) {
    throw new GitHubError('configuration', 'GitHub App requires a downloaded RSA private key PEM; a client secret cannot sign App JWTs');
  }
  try {
    const privateKey = createPrivateKey(pem);
    if (privateKey.asymmetricKeyType !== 'rsa' || (privateKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error();
    return Object.freeze({ appId, privateKey });
  } catch { throw new GitHubError('configuration', 'GitHub App RSA private key PEM is invalid'); }
}
export function createGitHubAppJwt(config: GitHubConfiguration, now = Date.now()): string {
  const time = Math.floor(now / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ iss: config.appId, iat: time - 60, exp: time + 540 })).toString('base64url');
  const input = `${header}.${payload}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), config.privateKey).toString('base64url')}`;
}
export type GitHubAppMetadata = Readonly<{ id: number; slug: string; permissions: Readonly<Record<string, unknown>>; events: readonly string[] }>;
export type GitHubInstallation = Readonly<{ id: number; appId: number; account: string; repositorySelection: 'all' | 'selected'; permissions: Readonly<Record<string, unknown>>; suspended: boolean }>;
export type GitHubRepository = Readonly<{ id: number; owner: string; name: string; fullName: string; private: boolean; defaultBranch: string }>;
/** Inputs must be obtained from a server-verified application session and linked GitHub identity. */
export type GitHubPrincipal = Readonly<{ principalId: string; githubUserId: number; userAccessToken: string }>;
declare const verifiedUserBrand: unique symbol;
export type VerifiedGitHubUser = Readonly<{ principalId: string; githubUserId: number; login: string; [verifiedUserBrand]: true }>;
declare const repositoryAuthorizationBrand: unique symbol;
export type AuthorizedGitHubRepository = GitHubRepository & Readonly<{ principalId: string; installationId: number; [repositoryAuthorizationBrand]: true }>;
export type GitHubPublishingAuthority = Readonly<{ repository: AuthorizedGitHubRepository; principalId: string; githubUserId: number; authority: 'personal-owner' | 'repository-admin' }>;
export type GitHubCommit = Readonly<{ sha: string; treeSha: string }>;
export type GitHubSourceTree = Readonly<{ commitSha: string; treeSha: string; files: readonly Readonly<{ path: string; size: number; blobSha: string }>[]; limitations: readonly string[] }>;
export type GitHubImportLimits = Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalBytes: number }>;
export type GitHubSourceSnapshot = Readonly<{ repository: GitHubRepository; commitSha: string; treeSha: string; files: readonly Readonly<{ path: string; text: string; lineCount: number; blobSha: string }>[]; limitations: readonly string[] }>;
type UserSecret = { token: string; expiresAt: number };
type RepositorySecret = { user: VerifiedGitHubUser; token: string; expiresAt: number; personalOwner?: boolean };
function installation(value: unknown): GitHubInstallation {
  const item = record(value); const selection = item.repository_selection;
  if (selection !== 'all' && selection !== 'selected') return invalid('Invalid installation repository selection');
  return Object.freeze({ id: integer(item.id), appId: integer(item.app_id), account: boundedString(record(item.account).login),
    repositorySelection: selection, permissions: Object.freeze({ ...record(item.permissions) }), suspended: item.suspended_at !== null && item.suspended_at !== undefined });
}
function repository(value: unknown): GitHubRepository {
  const item = record(value); const owner = boundedString(record(item.owner).login); const name = boundedString(item.name);
  segment(owner); segment(name);
  if (item.full_name !== `${owner}/${name}` || typeof item.private !== 'boolean') return invalid('Invalid GitHub repository');
  return Object.freeze({ id: integer(item.id), owner, name, fullName: `${owner}/${name}`, private: item.private, defaultBranch: boundedString(item.default_branch) });
}
async function boundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) throw new GitHubError('limit', 'GitHub response exceeded its byte limit');
  if (!response.body) return invalid('GitHub returned an empty response');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_JSON_BYTES) { await reader.cancel(); throw new GitHubError('limit', 'GitHub response exceeded its byte limit'); }
      chunks.push(next.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    if (error instanceof GitHubError) throw error;
    return invalid('GitHub returned invalid JSON');
  } finally { reader.releaseLock(); }
}

export class GitHubAppClient {
  private readonly users = new WeakMap<VerifiedGitHubUser, UserSecret>();
  private readonly repositories = new WeakMap<AuthorizedGitHubRepository, RepositorySecret>();
  constructor(private readonly config: GitHubConfiguration, private readonly fetchImpl: typeof fetch = fetch, private readonly now: () => number = Date.now) {}
  private async request(path: string, token: string, body?: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//') || new URL(path, API).origin !== API) return invalid('Invalid GitHub API path');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(15_000, timeoutMs)));
    try {
      const response = await this.fetchImpl(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': 'Chronos-Atlas', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new GitHubError(response.status === 401 || response.status === 403 || response.status === 404 ? 'unauthorized' : 'upstream', `GitHub API request failed (HTTP ${response.status})`, response.status);
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      throw new GitHubError('upstream', 'GitHub API request failed or timed out');
    } finally { clearTimeout(timer); }
  }
  private appRequest(path: string, body?: unknown): Promise<unknown> { return this.request(path, createGitHubAppJwt(this.config, this.now()), body); }
  private userSecret(user: VerifiedGitHubUser): UserSecret {
    const secret = this.users.get(user);
    if (!secret || secret.expiresAt <= this.now()) throw new GitHubError('unauthorized', 'GitHub user verification is missing or expired');
    return secret;
  }
  private repositorySecret(authorized: AuthorizedGitHubRepository): RepositorySecret {
    const secret = this.repositories.get(authorized);
    if (!secret || secret.expiresAt <= this.now()) throw new GitHubError('unauthorized', 'GitHub repository authorization is missing or expired');
    this.userSecret(secret.user); return secret;
  }
  async getAppMetadata(): Promise<GitHubAppMetadata> {
    const value = record(await this.appRequest('/app'));
    if (String(integer(value.id)) !== this.config.appId) return invalid('GitHub returned a different App identity');
    if (!Array.isArray(value.events) || value.events.some(event => typeof event !== 'string')) return invalid('Invalid GitHub App events');
    return Object.freeze({ id: integer(value.id), slug: boundedString(value.slug), permissions: Object.freeze({ ...record(value.permissions) }), events: Object.freeze([...value.events] as string[]) });
  }
  async verifyUser(principal: GitHubPrincipal): Promise<VerifiedGitHubUser> {
    boundedString(principal.principalId); integer(principal.githubUserId);
    if (!principal.userAccessToken || principal.userAccessToken.length > 4096 || /\s/.test(principal.userAccessToken)) throw new GitHubError('unauthorized', 'GitHub user access token is unavailable or invalid');
    const user = record(await this.request('/user', principal.userAccessToken));
    if (integer(user.id) !== principal.githubUserId) throw new GitHubError('unauthorized', 'GitHub token does not match the linked user identity');
    const verified = Object.freeze({ principalId: principal.principalId, githubUserId: principal.githubUserId, login: boundedString(user.login) }) as VerifiedGitHubUser;
    this.users.set(verified, { token: principal.userAccessToken, expiresAt: this.now() + 300_000 }); return verified;
  }
  /** This endpoint requires a GitHub App user access token, not an installation token. */
  async listInstallations(user: VerifiedGitHubUser): Promise<readonly GitHubInstallation[]> {
    const token = this.userSecret(user).token; const result: GitHubInstallation[] = [];
    for (let page = 1; page <= 10; page++) {
      const value = record(await this.request(`/user/installations?per_page=100&page=${page}`, token));
      if (!Array.isArray(value.installations)) return invalid('Invalid GitHub installation list');
      result.push(...value.installations.map(installation).filter(item => String(item.appId) === this.config.appId));
      if (value.installations.length < 100) return Object.freeze(result);
    }
    throw new GitHubError('limit', 'GitHub installation pagination exceeded its limit');
  }
  async getInstallation(user: VerifiedGitHubUser, installationId: number): Promise<GitHubInstallation> {
    integer(installationId);
    const match = (await this.listInstallations(user)).find(item => item.id === installationId);
    if (!match || match.suspended) throw new GitHubError('unauthorized', 'GitHub installation is unavailable to this user');
    return match;
  }
  async listInstallationRepositories(user: VerifiedGitHubUser, installationId: number): Promise<readonly GitHubRepository[]> {
    await this.getInstallation(user, installationId); const token = this.userSecret(user).token; const result: GitHubRepository[] = [];
    for (let page = 1; page <= 10; page++) {
      const value = record(await this.request(`/user/installations/${installationId}/repositories?per_page=100&page=${page}`, token));
      if (!Array.isArray(value.repositories)) return invalid('Invalid GitHub repository list');
      result.push(...value.repositories.map(repository));
      if (value.repositories.length < 100) return Object.freeze(result);
    }
    throw new GitHubError('limit', 'GitHub repository pagination exceeded its limit');
  }
  private async verifyRepositoryRead(user: VerifiedGitHubUser, owner: string, name: string): Promise<GitHubRepository> {
    const item = record(await this.request(`/repos/${segment(owner)}/${segment(name)}`, this.userSecret(user).token));
    const selected = repository(item); const permissions = record(item.permissions);
    if (selected.fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase() || permissions.pull !== true || item.disabled === true) {
      throw new GitHubError('unauthorized', 'GitHub user cannot read the selected repository');
    }
    return selected;
  }
  /** Caller must separately verify workspace membership. Client selections never establish permission. */
  async authorizeRepository(user: VerifiedGitHubUser, selection: Readonly<{ owner: string; name: string; repositoryId?: number; installationId?: number }>): Promise<AuthorizedGitHubRepository> {
    if (user.login.toLowerCase() === selection.owner.toLowerCase()) return this.authorizePersonalOwner(user, selection);
    const selected = await this.verifyRepositoryRead(user, selection.owner, selection.name);
    if (selection.repositoryId !== undefined && selected.id !== integer(selection.repositoryId)) throw new GitHubError('unauthorized', 'Repository identity does not match selection');
    const installed = installation(await this.appRequest(`/repos/${segment(selected.owner)}/${segment(selected.name)}/installation`));
    if (String(installed.appId) !== this.config.appId || installed.suspended || !['read', 'write'].includes(String(installed.permissions.contents))) throw new GitHubError('unauthorized', 'App installation cannot read repository contents');
    if (selection.installationId !== undefined && installed.id !== integer(selection.installationId)) throw new GitHubError('unauthorized', 'Installation does not match the selected repository');
    const value = record(await this.appRequest(`/app/installations/${installed.id}/access_tokens`, { repository_ids: [selected.id], permissions: { contents: 'read', metadata: 'read' } }));
    const token = boundedString(value.token, 4096); const expiresAt = Date.parse(boundedString(value.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() || /\s/.test(token)) return invalid('Invalid GitHub installation access token');
    const authorized = Object.freeze({ ...selected, principalId: user.principalId, installationId: installed.id }) as AuthorizedGitHubRepository;
    this.repositories.set(authorized, { user, token, expiresAt: Math.min(expiresAt, this.now() + 300_000) }); return authorized;
  }
  /** Distinct sale-claim authority; read access and installation permissions never suffice. */
  async authorizePublication(user: VerifiedGitHubUser, selection: Readonly<{ owner: string; name: string; repositoryId?: number; installationId?: number }>): Promise<GitHubPublishingAuthority> {
    const identity = record(await this.request('/user', this.userSecret(user).token));
    if (integer(identity.id) !== user.githubUserId) throw new GitHubError('unauthorized', 'Publishing identity changed');
    const authorized = await this.authorizeRepository(user, selection);
    const secret = this.repositorySecret(authorized);
    if (secret.personalOwner) {
      // authorizePersonalOwner has just verified GET /user identity, the User
      // installation account and numeric repository owner using the narrow token.
      return Object.freeze({ repository: authorized, principalId: user.principalId, githubUserId: user.githubUserId, authority: 'personal-owner' });
    }
    const item = record(await this.request(`/repos/${segment(authorized.owner)}/${segment(authorized.name)}`, this.userSecret(user).token));
    const current = repository(item); const permissions = record(item.permissions);
    if (current.id !== authorized.id || current.fullName.toLowerCase() !== authorized.fullName.toLowerCase() || item.disabled === true || permissions.admin !== true) {
      throw new GitHubError('unauthorized', 'Repository administrative publishing authority is required');
    }
    return Object.freeze({ repository: authorized, principalId: user.principalId, githubUserId: user.githubUserId, authority: 'repository-admin' });
  }
  /** A verified personal owner needs no broad OAuth repo scope; content still uses a single-repo read-only App token. */
  private async authorizePersonalOwner(user: VerifiedGitHubUser, selection: Readonly<{ owner: string; name: string; repositoryId?: number; installationId?: number }>): Promise<AuthorizedGitHubRepository> {
    this.userSecret(user);
    const raw = record(await this.appRequest(`/repos/${segment(selection.owner)}/${segment(selection.name)}/installation`));
    const account = record(raw.account); const installed = installation(raw);
    if (account.type !== 'User' || integer(account.id) !== user.githubUserId || installed.account.toLowerCase() !== user.login.toLowerCase()
      || String(installed.appId) !== this.config.appId || installed.suspended || !['read','write'].includes(String(installed.permissions.contents))
      || (selection.installationId !== undefined && installed.id !== integer(selection.installationId))) throw new GitHubError('unauthorized', 'Personal repository ownership is not verified');
    const value = record(await this.appRequest(`/app/installations/${installed.id}/access_tokens`, { repositories: [selection.name], permissions: { contents: 'read', metadata: 'read' } }));
    const token = boundedString(value.token, 4096); const expiresAt = Date.parse(boundedString(value.expires_at));
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now() || /\s/.test(token)) return invalid('Invalid GitHub installation access token');
    const item = record(await this.request(`/repos/${segment(selection.owner)}/${segment(selection.name)}`, token));
    const owner = record(item.owner); const selected = repository(item);
    if (owner.type !== 'User' || integer(owner.id) !== user.githubUserId || selected.owner.toLowerCase() !== user.login.toLowerCase()
      || selected.fullName.toLowerCase() !== `${selection.owner}/${selection.name}`.toLowerCase() || item.disabled === true
      || (selection.repositoryId !== undefined && selected.id !== integer(selection.repositoryId))) throw new GitHubError('unauthorized', 'Personal repository ownership is not verified');
    const authorized = Object.freeze({ ...selected, principalId: user.principalId, installationId: installed.id }) as AuthorizedGitHubRepository;
    this.repositories.set(authorized, { user, token, expiresAt: Math.min(expiresAt, this.now() + 300_000), personalOwner: true }); return authorized;
  }
  private async authorizeRead(authorized: AuthorizedGitHubRepository): Promise<RepositorySecret> {
    const secret = this.repositorySecret(authorized);
    let current: GitHubRepository;
    if (secret.personalOwner) {
      const user = record(await this.request('/user', this.userSecret(secret.user).token));
      const item = record(await this.request(`/repos/${segment(authorized.owner)}/${segment(authorized.name)}`, secret.token));
      const owner = record(item.owner);
      if (integer(user.id) !== secret.user.githubUserId || owner.type !== 'User' || integer(owner.id) !== secret.user.githubUserId || item.disabled === true) throw new GitHubError('unauthorized', 'Personal repository access changed');
      current = repository(item);
    } else current = await this.verifyRepositoryRead(secret.user, authorized.owner, authorized.name);
    if (current.id !== authorized.id) throw new GitHubError('unauthorized', 'Repository identity changed');
    return secret;
  }
  async resolveCommit(authorized: AuthorizedGitHubRepository, ref: string): Promise<GitHubCommit> {
    if (!ref || ref.length > 255 || /[\s?#\\]/.test(ref) || ref.startsWith('-')) return invalid('Invalid repository ref');
    const secret = await this.authorizeRead(authorized);
    const commit = record(await this.request(`/repos/${segment(authorized.owner)}/${segment(authorized.name)}/commits/${encodeURIComponent(ref)}`, secret.token));
    return Object.freeze({ sha: sha(commit.sha), treeSha: sha(record(record(commit.commit).tree).sha) });
  }
  /** Authorized immutable tree metadata only. No blobs or source text are read. */
  async inspectSnapshot(authorized: AuthorizedGitHubRepository, commitSha: string): Promise<GitHubSourceTree> {
    sha(commitSha);
    const commit = await this.resolveCommit(authorized, commitSha);
    if (commit.sha !== commitSha) return invalid('GitHub resolved a different immutable commit');
    const secret = this.repositorySecret(authorized); const base = `/repos/${segment(authorized.owner)}/${segment(authorized.name)}`;
    const tree = record(await this.request(`${base}/git/trees/${commit.treeSha}?recursive=1`, secret.token));
    if (tree.sha !== commit.treeSha || tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length > 10_000) throw new GitHubError('limit', 'Repository tree is truncated or exceeds its bound');
    const files: { path: string; size: number; blobSha: string }[] = []; const limitations: string[] = []; let totalBytes = 0; const paths = new Set<string>();
    for (const value of tree.tree) {
      const entry = record(value); const path = boundedString(entry.path, 1000);
      // eslint-disable-next-line no-control-regex -- reject dangerous source paths
      if (path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..') || paths.has(path)) return invalid('Unsafe or duplicate repository source path');
      paths.add(path);
      if (entry.mode === '120000' || entry.type === 'commit') { limitations.push(`Skipped unsupported link or submodule: ${path}`); continue; }
      if (entry.type === 'tree') continue;
      if (entry.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode))) return invalid('Unsupported repository tree entry');
      if (path.split('/').some(part => ['node_modules', '.git', '.next', 'dist', 'build', 'vendor', 'coverage'].includes(part))) continue;
      if (!/\.(?:tsx?|jsx?|mjs|cjs)$/.test(path) && !/(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[\w-]+)?\.json)$/.test(path)) continue;
      if (files.length >= 300) throw new GitHubError('limit', 'Repository source import exceeded its file limit');
      if (typeof entry.size !== 'number' || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 512_000) throw new GitHubError('limit', 'Repository source file exceeded its byte limit');
      totalBytes += entry.size;
      if (totalBytes > 5_000_000) throw new GitHubError('limit', 'Repository source exceeded its total byte limit');
      files.push({ path, size: entry.size, blobSha: sha(entry.sha) });
    }
    if (!files.length) return invalid('Repository has no supported source files');
    return Object.freeze({ commitSha, treeSha: commit.treeSha, files: Object.freeze(files.map(file => Object.freeze(file))), limitations: Object.freeze(limitations) });
  }
  async downloadSnapshot(authorized: AuthorizedGitHubRepository, commitSha: string, limits: GitHubImportLimits = { maxFiles: 300, maxFileBytes: 512_000, maxTotalBytes: 5_000_000 }): Promise<GitHubSourceSnapshot> {
    if (![limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0)
      || limits.maxFiles > 300 || limits.maxFileBytes > 512_000 || limits.maxTotalBytes > 5_000_000) return invalid('Invalid trusted repository import limits');
    const tree = await this.inspectSnapshot(authorized, commitSha);
    if (tree.files.length > limits.maxFiles) throw new GitHubError('limit', 'Repository source count exceeds the supported parser limit');
    if (tree.files.some(file => file.size > limits.maxFileBytes)) throw new GitHubError('limit', 'Repository source file exceeds the supported storage limit');
    if (tree.files.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalBytes) throw new GitHubError('limit', 'Repository source exceeds the supported total byte limit');
    const secret = this.repositorySecret(authorized); const base = `/repos/${segment(authorized.owner)}/${segment(authorized.name)}`;
    const files: { path: string; text: string; lineCount: number; blobSha: string }[] = new Array(tree.files.length);
    const deadline = this.now() + 90_000; let nextFile = 0; let stopped = false;
    const download = async (): Promise<void> => {
      try { for (;;) {
        if (stopped) return;
        const position = nextFile++; const file = tree.files[position]; if (!file) return;
        if (this.now() > deadline) throw new GitHubError('limit', 'Repository source import exceeded its time limit');
        const { blobSha, path } = file; const blob = record(await this.request(`${base}/git/blobs/${blobSha}`, secret.token, undefined, deadline - this.now()));
      if (blob.sha !== blobSha || blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > 700_000) return invalid('Invalid GitHub source blob');
      const encoded = blob.content.replace(/\n/g, '');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return invalid('Invalid GitHub blob encoding');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length !== file.size || blob.size !== bytes.length) throw new GitHubError('limit', 'Repository source bytes differ from their immutable tree size');
      if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== blobSha) return invalid('GitHub source blob does not match its immutable object');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalid('Repository source is not UTF-8'); }
      if (text.includes('\0')) return invalid('Repository source contains binary data');
        files[position] = { path, text, lineCount: text.split('\n').length, blobSha };
      } } catch (error) { stopped = true; throw error; }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, tree.files.length) }, () => download()));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    return Object.freeze({ repository: Object.freeze({ id: authorized.id, owner: authorized.owner, name: authorized.name, fullName: authorized.fullName, private: authorized.private, defaultBranch: authorized.defaultBranch }), commitSha, treeSha: tree.treeSha, files: Object.freeze(files), limitations: tree.limitations });
  }
}
export async function createGitHubAppClient(env: Readonly<Record<string, string | undefined>>, options: Readonly<{ fetch?: typeof fetch; now?: () => number }> = {}): Promise<GitHubAppClient> {
  return new GitHubAppClient(await loadGitHubConfiguration(env), options.fetch, options.now);
}

export type GitHubWebhookDelivery = Readonly<{ deliveryId: string; event: 'ping' | 'push' | 'installation' | 'installation_repositories' | 'repository'; payload: Readonly<Record<string, unknown>>; bodyDigest: string }>;
/** Raw bytes must be read with a route-level streaming limit. Persist deliveryId uniquely before handling/replay. */
export function verifyGitHubWebhook(rawBody: Uint8Array, headers: Headers, secret: string | undefined): GitHubWebhookDelivery {
  if (!secret || secret.length < 16 || secret.length > 4096) throw new GitHubError('configuration', 'GitHub webhook secret is unavailable or too short');
  if (rawBody.length === 0 || rawBody.length > 1_000_000) throw new GitHubError('limit', 'GitHub webhook exceeded its body limit');
  const signature = headers.get('x-hub-signature-256');
  if (!signature || !/^sha256=[a-f0-9]{64}$/.test(signature)) throw new GitHubError('unauthorized', 'GitHub webhook signature is missing or invalid');
  const expected = createHmac('sha256', secret).update(rawBody).digest(); const actual = Buffer.from(signature.slice(7), 'hex');
  if (!timingSafeEqual(expected, actual)) throw new GitHubError('unauthorized', 'GitHub webhook signature verification failed');
  const deliveryId = headers.get('x-github-delivery'); const event = headers.get('x-github-event');
  if (!deliveryId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(deliveryId)) return invalid('Invalid GitHub webhook delivery ID');
  if (!event || !['ping', 'push', 'installation', 'installation_repositories', 'repository'].includes(event)) return invalid('Unsupported GitHub webhook event');
  if (!/^application\/json(?:\s*;|$)/i.test(headers.get('content-type') ?? '')) return invalid('GitHub webhook requires JSON');
  let payload: Record<string, unknown>;
  try { payload = record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody))); }
  catch { return invalid('GitHub webhook JSON is invalid'); }
  let nodes = 0;
  const check = (value: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 30) throw new GitHubError('limit', 'GitHub webhook structure exceeded its limit');
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) return invalid('Unsafe GitHub webhook payload');
      check(item, depth + 1);
    }
  };
  check(payload, 0);
  return Object.freeze({ deliveryId: deliveryId.toLowerCase(), event: event as GitHubWebhookDelivery['event'], payload: Object.freeze(payload), bodyDigest: createHash('sha256').update(rawBody).digest('hex') });
}
