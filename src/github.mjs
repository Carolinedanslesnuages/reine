/** GitHub API access with your token (GITHUB_TOKEN, GH_TOKEN, or the one from `gh`). */
import { execFileSync } from 'node:child_process';

export function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('Aucun jeton GitHub : connectez-vous avec « gh auth login », ou définissez GITHUB_TOKEN.');
  }
}

export function client(authToken = token(), apiBase = process.env.REINE_API_BASE || 'https://api.github.com') {
  async function call(method, path, body) {
    const response = await fetch(apiBase + path, {
      method,
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'reine',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return { status: 204, data: null };
    const text = await response.text();
    return { status: response.status, data: text ? JSON.parse(text) : null };
  }
  return {
    call,
    async currentUser() {
      const result = await call('GET', '/user');
      if (result.status !== 200) throw new Error(`Jeton refusé par GitHub (${result.status}).`);
      return result.data.login;
    },
    async repositories(owner) {
      const allRepositories = [];
      for (let page = 1; ; page++) {
        const result = await call('GET', `/user/repos?per_page=100&page=${page}&affiliation=owner`);
        if (result.status !== 200) throw new Error(`Liste des dépôts impossible (${result.status}).`);
        allRepositories.push(...result.data);
        if (result.data.length < 100) break;
      }
      return allRepositories.filter((repo) => repo.owner.login.toLowerCase() === owner.toLowerCase());
    },
    async repository(fullName) {
      const result = await call('GET', `/repos/${fullName}`);
      if (result.status !== 200) throw new Error(`Dépôt introuvable ou inaccessible : ${fullName} (${result.status}).`);
      return result.data;
    },
    /** Settings that are not part of the repository record. */
    async extra(fullName) {
      const [actions, alerts, codeScanning] = await Promise.all([
        call('GET', `/repos/${fullName}/actions/permissions/workflow`),
        call('GET', `/repos/${fullName}/vulnerability-alerts`),
        call('GET', `/repos/${fullName}/code-scanning/default-setup`),
      ]);
      return {
        actions: actions.status === 200 ? actions.data : undefined,
        alerts: alerts.status === 204 ? true : alerts.status === 404 ? false : undefined,
        // Unavailable (403/404) on a private repository of a free account: the rule is then not applicable.
        codeScanning: codeScanning.status === 200 ? codeScanning.data.state : undefined,
        workflowsWithoutPermissions: await this.workflowsWithoutPermissions(fullName),
      };
    },
    /** Workflows that declare no "permissions:" at all (neither global nor per job). */
    async workflowsWithoutPermissions(fullName) {
      const listing = await call('GET', `/repos/${fullName}/contents/.github/workflows`);
      if (listing.status !== 200 || !Array.isArray(listing.data)) return [];
      const missing = [];
      for (const entry of listing.data.filter((item) => /\.ya?ml$/.test(item.name))) {
        const content = await call('GET', `/repos/${fullName}/contents/.github/workflows/${encodeURIComponent(entry.name)}`);
        const text = content.data && content.data.content ? Buffer.from(content.data.content, 'base64').toString('utf8') : '';
        if (!/^\s*permissions\s*:/m.test(text)) missing.push(entry.name);
      }
      return missing;
    },
  };
}
