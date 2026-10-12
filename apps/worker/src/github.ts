import { createHash, createHmac, createPrivateKey, sign, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { KeyObject } from 'node:crypto';

/** Native GitHub REST API; server only. No imported repository code is executed. */
export const GITHUB_API_VERSION = '2026-03-10';
const API = 'https://api.github.com';
// GitHub's recursive tree response is bounded at 7 MB / 100,000 entries.
const MAX_JSON_BYTES = 8_000_000;
const SHA = /^[a-f0-9]{40}$/;
export class GitHubError extends Error {
  constructor(public readonly code: 'configuration' | 'unauthorized' | 'upstream' | 'invalid' | 'limit' | 'rate-limit' | 'aborted', message: string, public readonly status?: number, public readonly retryAfterMs?: number) {
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
export type GitHubTreeFile = GitHubSourceTree['files'][number];
export type GitHubImportLimits = Readonly<{ maxFiles: number; maxFileBytes: number; maxTotalBytes: number }>;
export type GitHubSourceSnapshot = Readonly<{ repository: GitHubRepository; commitSha: string; treeSha: string; files: readonly Readonly<{ path: string; text: string; lineCount: number; blobSha: string }>[]; limitations: readonly string[] }>;
export const GITHUB_IMPORT_LIMITS: GitHubImportLimits = Object.freeze({ maxFiles: 5000, maxFileBytes: 262_144, maxTotalBytes: 30_000_000 });
export type GitHubDiscoveryCheckpoint = Readonly<{
  schemaVersion: 1; commitSha: string; treeSha: string;
  pending: readonly Readonly<{ prefix: string; sha: string; recursive: boolean }>[];
  files: readonly GitHubTreeFile[]; limitations: readonly string[];
  discovered: number; skipped: number; treesVisited: number; entriesVisited: number; complete: boolean;
}>;
export type GitHubReadOptions = Readonly<{ signal?: AbortSignal }>;
type UserSecret = { token: string; expiresAt: number };
type RepositorySecret = { user: VerifiedGitHubUser; token: string; expiresAt: number; authorizedUntil: number; personalOwner?: boolean; refreshing?: Promise<void> | undefined };
const EXCLUDED_DIRECTORIES = new Set(['node_modules', '.git', '.next', '.nuxt', '.cache', '.turbo', '.venv', 'venv', '__pycache__', 'dist', 'build', 'vendor', 'coverage', 'target', 'out', 'generated', '.generated', '.terraform']);
function safeSourcePath(path: unknown): string {
  const result = boundedString(path, 1000);
  // eslint-disable-next-line no-control-regex -- imported paths are data, never OS paths
  if (result.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(result) || result.split('/').some(part => !part || part === '.' || part === '..') || result.split('/').length > 40) return invalid('Unsafe repository source path');
  return result;
}
function excluded(path: string): boolean { return path.split('/').some(part => EXCLUDED_DIRECTORIES.has(part.toLowerCase())); }
function sourcePath(path: string): boolean {
  if (excluded(path) || /(?:^|\/)(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519)$/i.test(path) || /\.(?:min\.[cm]?js|map|pem|key|p12|pfx)$/i.test(path)) return false;
  return /\.(?:[cm]?[jt]sx?|py|pyi|go|rs|java|cs|c|h|cpp|cc|cxx|hpp|rb|php|swift|kt|kts|scala|sh|bash|sql|css|scss|html|vue|svelte|md|mdx|yaml|yml|toml)$/.test(path)
    || /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|tsconfig(?:\.[\w-]+)?\.json|Cargo\.lock|go\.(?:mod|sum)|Gemfile(?:\.lock)?|requirements[^/]*\.txt|Dockerfile|Makefile)$/.test(path);
}
function importLimits(limits: GitHubImportLimits): void {
  if (![limits.maxFiles, limits.maxFileBytes, limits.maxTotalBytes].every(value => Number.isSafeInteger(value) && value > 0)
    || limits.maxFiles > GITHUB_IMPORT_LIMITS.maxFiles || limits.maxFileBytes > GITHUB_IMPORT_LIMITS.maxFileBytes || limits.maxTotalBytes > GITHUB_IMPORT_LIMITS.maxTotalBytes) return invalid('Invalid trusted repository import limits');
}
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new GitHubError('aborted', 'GitHub source operation was cancelled'); }
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
  private async request(path: string, token: string, body?: unknown, timeoutMs = 15_000, signal?: AbortSignal): Promise<unknown> {
    if (!path.startsWith('/') || path.startsWith('//') || new URL(path, API).origin !== API) return invalid('Invalid GitHub API path');
    abort(signal);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(15_000, timeoutMs)));
    try {
      const response = await this.fetchImpl(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': GITHUB_API_VERSION, 'User-Agent': 'RepoFair', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) {
        let rateLimited = response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'));
        // Secondary limits may have no retry headers; inspect only the fixed
        // classification, never retain or reflect upstream exception content.
        if (response.status === 403 && !rateLimited) {
          try { const body = record(await boundedJson(response)); rateLimited = typeof body.message === 'string' && /(?:secondary |primary )?rate limit/i.test(body.message); } catch { /* sanitized HTTP error below */ }
        }
        const retry = response.headers.get('retry-after'); const reset = response.headers.get('x-ratelimit-reset');
        const retryMs = retry && /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.now() : NaN;
        const resetMs = reset && /^\d+$/.test(reset) ? Number(reset) * 1000 - this.now() : NaN;
        const delay = Math.max(1000, ...(Number.isFinite(retryMs) ? [retryMs] : []), ...(Number.isFinite(resetMs) && response.headers.get('x-ratelimit-remaining') === '0' ? [resetMs] : []), ...(rateLimited && !Number.isFinite(retryMs) && !Number.isFinite(resetMs) ? [60_000] : []));
        throw new GitHubError(rateLimited ? 'rate-limit' : response.status === 401 || response.status === 403 || response.status === 404 ? 'unauthorized' : 'upstream', `GitHub API request failed (HTTP ${response.status})`, response.status, rateLimited || response.status >= 500 ? delay : undefined);
      }
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof GitHubError) throw error;
      abort(signal);
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
    if (!secret || secret.authorizedUntil <= this.now()) throw new GitHubError('unauthorized', 'GitHub repository authorization is missing or expired');
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
  private async verifyRepositoryRead(user: VerifiedGitHubUser, owner: string, name: string, signal?: AbortSignal): Promise<GitHubRepository> {
    const item = record(await this.request(`/repos/${segment(owner)}/${segment(name)}`, this.userSecret(user).token, undefined, 15_000, signal));
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
    this.repositories.set(authorized, { user, token, expiresAt, authorizedUntil: this.now() + 300_000 }); return authorized;
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
    this.repositories.set(authorized, { user, token, expiresAt, authorizedUntil: this.now() + 300_000, personalOwner: true }); return authorized;
  }
  private async refreshInstallation(authorized: AuthorizedGitHubRepository, secret: RepositorySecret): Promise<void> {
    if (!secret.refreshing) secret.refreshing = (async () => {
      this.userSecret(secret.user);
      const value = record(await this.appRequest(`/app/installations/${authorized.installationId}/access_tokens`, { repository_ids: [authorized.id], permissions: { contents: 'read', metadata: 'read' } }));
      const token = boundedString(value.token, 4096); const expiresAt = Date.parse(boundedString(value.expires_at));
      if (!Number.isFinite(expiresAt) || expiresAt <= this.now() || /\s/.test(token)) return invalid('Invalid GitHub installation access token');
      secret.token = token; secret.expiresAt = expiresAt;
    })();
    try { await secret.refreshing; } finally { secret.refreshing = undefined; }
  }
  private async installationRequest(authorized: AuthorizedGitHubRepository, path: string, signal?: AbortSignal): Promise<unknown> {
    abort(signal); const secret = this.repositorySecret(authorized);
    if (secret.expiresAt <= this.now() + 30_000) await this.refreshInstallation(authorized, secret);
    const token = secret.token;
    try { return await this.request(path, token, undefined, 15_000, signal); }
    catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 401) throw error;
      // Concurrent blob calls share the refresh; do not mint one token per 401.
      if (secret.token === token) await this.refreshInstallation(authorized, secret);
      return this.request(path, secret.token, undefined, 15_000, signal);
    }
  }
  private async authorizeRead(authorized: AuthorizedGitHubRepository, signal?: AbortSignal): Promise<RepositorySecret> {
    const secret = this.repositorySecret(authorized);
    let current: GitHubRepository;
    if (secret.personalOwner) {
      const user = record(await this.request('/user', this.userSecret(secret.user).token, undefined, 15_000, signal));
      const item = record(await this.installationRequest(authorized, `/repos/${segment(authorized.owner)}/${segment(authorized.name)}`, signal));
      const owner = record(item.owner);
      if (integer(user.id) !== secret.user.githubUserId || owner.type !== 'User' || integer(owner.id) !== secret.user.githubUserId || item.disabled === true) throw new GitHubError('unauthorized', 'Personal repository access changed');
      current = repository(item);
    } else current = await this.verifyRepositoryRead(secret.user, authorized.owner, authorized.name, signal);
    if (current.id !== authorized.id) throw new GitHubError('unauthorized', 'Repository identity changed');
    return secret;
  }
  async resolveCommit(authorized: AuthorizedGitHubRepository, ref: string, options: GitHubReadOptions = {}): Promise<GitHubCommit> {
    if (!ref || ref.length > 255 || /[\s?#\\]/.test(ref) || ref.startsWith('-')) return invalid('Invalid repository ref');
    await this.authorizeRead(authorized, options.signal);
    const commit = record(await this.installationRequest(authorized, `/repos/${segment(authorized.owner)}/${segment(authorized.name)}/commits/${encodeURIComponent(ref)}`, options.signal));
    return Object.freeze({ sha: sha(commit.sha), treeSha: sha(record(record(commit.commit).tree).sha) });
  }
  /** A bounded metadata slice. Persist the returned state before requesting the next slice. */
  async discoverSnapshot(authorized: AuthorizedGitHubRepository, commitSha: string, checkpoint?: GitHubDiscoveryCheckpoint, options: GitHubReadOptions & Readonly<{ maxRequests?: number }> = {}): Promise<GitHubDiscoveryCheckpoint> {
    sha(commitSha); const maxRequests = options.maxRequests ?? 8;
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 8) return invalid('Invalid trusted discovery slice');
    await this.authorizeRead(authorized, options.signal);
    let state: GitHubDiscoveryCheckpoint;
    if (checkpoint) {
      if (checkpoint.schemaVersion !== 1 || checkpoint.commitSha !== commitSha || !SHA.test(checkpoint.treeSha)
        || !Array.isArray(checkpoint.pending) || checkpoint.pending.length > 10_000 || !Array.isArray(checkpoint.files) || checkpoint.files.length > 5000
        || !Array.isArray(checkpoint.limitations) || checkpoint.limitations.length > 100
        || ![checkpoint.discovered, checkpoint.skipped, checkpoint.treesVisited, checkpoint.entriesVisited].every(value => Number.isSafeInteger(value) && value >= 0)
        || checkpoint.entriesVisited > 200_000 || checkpoint.treesVisited > 5000 || checkpoint.complete !== (checkpoint.pending.length === 0)) return invalid('Invalid discovery checkpoint');
      const seen = new Set<string>(); let bytes = 0;
      for (const file of checkpoint.files) {
        safeSourcePath(file.path); sha(file.blobSha);
        if (seen.has(file.path) || !sourcePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > GITHUB_IMPORT_LIMITS.maxFileBytes) return invalid('Invalid discovery file');
        seen.add(file.path); bytes += file.size;
      }
      if (bytes > GITHUB_IMPORT_LIMITS.maxTotalBytes || checkpoint.limitations.some(item => typeof item !== 'string' || item.length > 2000)) return invalid('Invalid discovery bounds');
      for (const tree of checkpoint.pending) { if (tree.prefix) safeSourcePath(tree.prefix); sha(tree.sha); if (typeof tree.recursive !== 'boolean' || tree.recursive && tree.prefix !== '') return invalid('Invalid discovery subtree'); }
      state = checkpoint;
    } else {
      const commit = record(await this.installationRequest(authorized, `/repos/${segment(authorized.owner)}/${segment(authorized.name)}/commits/${commitSha}`, options.signal));
      if (sha(commit.sha) !== commitSha) return invalid('GitHub resolved a different immutable commit');
      const treeSha = sha(record(record(commit.commit).tree).sha);
      state = { schemaVersion: 1, commitSha, treeSha, pending: [{ prefix: '', sha: treeSha, recursive: true }], files: [], limitations: [], discovered: 0, skipped: 0, treesVisited: 0, entriesVisited: 0, complete: false };
    }
    const pending = [...state.pending]; const files = [...state.files]; const limitations = [...state.limitations]; const paths = new Set(files.map(file => file.path));
    let { discovered, skipped, treesVisited, entriesVisited } = state; let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const base = `/repos/${segment(authorized.owner)}/${segment(authorized.name)}`;
    const limitation = (text: string): void => { if (limitations.length < 100) limitations.push(text); };
    for (let requests = 0; requests < maxRequests && pending.length; requests++) {
      abort(options.signal); const next = pending.shift()!;
      if (++treesVisited > 5000) throw new GitHubError('limit', 'Repository discovery exceeds the subtree limit');
      const tree = record(await this.installationRequest(authorized, `${base}/git/trees/${next.sha}${next.recursive ? '?recursive=1' : ''}`, options.signal));
      if (tree.sha !== next.sha || typeof tree.truncated !== 'boolean' || !Array.isArray(tree.tree) || tree.tree.length > 100_000) return invalid('Invalid immutable repository tree');
      if (tree.truncated) {
        if (!next.recursive) throw new GitHubError('limit', 'A repository subtree exceeds GitHub traversal limits');
        pending.unshift({ ...next, recursive: false });
        limitation('GitHub truncated the recursive tree; RepoFair traversed bounded subtrees instead.'); continue;
      }
      const localPaths = new Set<string>();
      for (const value of tree.tree) {
        if (++entriesVisited > 200_000) throw new GitHubError('limit', 'Repository discovery exceeds its entry limit');
        const entry = record(value); const relative = safeSourcePath(entry.path);
        if ((!next.recursive && relative.includes('/')) || localPaths.has(relative)) return invalid('Unsafe or duplicate repository source path');
        localPaths.add(relative); const path = safeSourcePath(next.prefix ? `${next.prefix}/${relative}` : relative);
        if (entry.type === 'tree') {
          if (entry.mode !== '040000') return invalid('Unsupported repository tree entry');
          if (!next.recursive && !excluded(path)) pending.push({ prefix: path, sha: sha(entry.sha), recursive: false });
          if (pending.length > 10_000) throw new GitHubError('limit', 'Repository discovery exceeds its pending subtree limit');
          continue;
        }
        discovered++;
        if (entry.mode === '120000' || entry.type === 'commit') { skipped++; limitation(`Skipped unsupported link or submodule: ${path}`); continue; }
        if (entry.type !== 'blob' || !['100644', '100755'].includes(String(entry.mode))) return invalid('Unsupported repository tree entry');
        if (!sourcePath(path)) { skipped++; continue; }
        if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0) return invalid('Invalid repository source file size');
        if (Number(entry.size) > GITHUB_IMPORT_LIMITS.maxFileBytes) { skipped++; limitation(`Skipped oversized source file: ${path}`); continue; }
        if (paths.has(path)) return invalid('Duplicate repository source path');
        if (files.length >= GITHUB_IMPORT_LIMITS.maxFiles) throw new GitHubError('limit', 'Repository source import exceeded its file limit');
        totalBytes += Number(entry.size);
        if (totalBytes > GITHUB_IMPORT_LIMITS.maxTotalBytes) throw new GitHubError('limit', 'Repository source exceeded its total byte limit');
        paths.add(path); files.push({ path, size: Number(entry.size), blobSha: sha(entry.sha) });
      }
    }
    if (!pending.length && !files.length) return invalid('Repository has no supported source files');
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { schemaVersion: 1, commitSha, treeSha: state.treeSha, pending, files, limitations, discovered, skipped, treesVisited, entriesVisited, complete: pending.length === 0 };
  }
  /** Authorized immutable tree metadata only. Source blobs are never read here. */
  async inspectSnapshot(authorized: AuthorizedGitHubRepository, commitSha: string, options: GitHubReadOptions = {}): Promise<GitHubSourceTree> {
    let checkpoint: GitHubDiscoveryCheckpoint | undefined;
    do { checkpoint = await this.discoverSnapshot(authorized, commitSha, checkpoint, options); } while (!checkpoint.complete);
    return { commitSha, treeSha: checkpoint.treeSha, files: checkpoint.files, limitations: checkpoint.limitations };
  }
  async downloadFiles(authorized: AuthorizedGitHubRepository, selected: readonly GitHubTreeFile[], options: GitHubReadOptions = {}): Promise<GitHubSourceSnapshot['files']> {
    if (selected.length > 32) return invalid('Invalid trusted download slice');
    for (const file of selected) { safeSourcePath(file.path); sha(file.blobSha); if (!sourcePath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > GITHUB_IMPORT_LIMITS.maxFileBytes) return invalid('Invalid trusted source selection'); }
    await this.authorizeRead(authorized, options.signal);
    const files: GitHubSourceSnapshot['files'][number][] = new Array(selected.length); const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const base = `/repos/${segment(authorized.owner)}/${segment(authorized.name)}`; let nextFile = 0; let failure: unknown;
    const download = async (): Promise<void> => {
      try { for (;;) {
        abort(signal); const position = nextFile++; const file = selected[position]; if (!file) return;
        const blob = record(await this.installationRequest(authorized, `${base}/git/blobs/${file.blobSha}`, signal));
        if (blob.sha !== file.blobSha || blob.encoding !== 'base64' || typeof blob.content !== 'string' || blob.content.length > 400_000) return invalid('Invalid GitHub source blob');
        const encoded = blob.content.replace(/\n/g, '');
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return invalid('Invalid GitHub blob encoding');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length !== file.size || blob.size !== bytes.length) return invalid('Repository source bytes differ from their immutable tree size');
        if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== file.blobSha) return invalid('GitHub source blob does not match its immutable object');
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return invalid('Repository source is not UTF-8'); }
        if (text.includes('\0')) return invalid('Repository source contains binary data');
        files[position] = { path: file.path, blobSha: file.blobSha, text, lineCount: text.split('\n').length };
      } } catch (error) { if (failure === undefined) { failure = error; controller.abort(); } }
    };
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, () => download()));
    if (failure !== undefined) throw failure;
    return files;
  }
  async downloadSnapshot(authorized: AuthorizedGitHubRepository, commitSha: string, limits: GitHubImportLimits = GITHUB_IMPORT_LIMITS): Promise<GitHubSourceSnapshot> {
    importLimits(limits); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const tree = await this.inspectSnapshot(authorized, commitSha, { signal: controller.signal });
      if (tree.files.length > limits.maxFiles || tree.files.some(file => file.size > limits.maxFileBytes) || tree.files.reduce((sum, file) => sum + file.size, 0) > limits.maxTotalBytes) throw new GitHubError('limit', 'Repository source exceeds the supported import limits');
      const files: GitHubSourceSnapshot['files'][number][] = [];
      for (let offset = 0; offset < tree.files.length; offset += 32) files.push(...await this.downloadFiles(authorized, tree.files.slice(offset, offset + 32), { signal: controller.signal }));
      return { repository: { id: authorized.id, owner: authorized.owner, name: authorized.name, fullName: authorized.fullName, private: authorized.private, defaultBranch: authorized.defaultBranch }, commitSha, treeSha: tree.treeSha, files, limitations: tree.limitations };
    } finally { clearTimeout(timer); }
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
