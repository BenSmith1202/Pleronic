const API_ROOT = 'https://api.github.com';
const IMAGE_MIME_TYPES = new Map([
  ['avif', 'image/avif'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['jpg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp']
]);

export function isImagePath(path) {
  return IMAGE_MIME_TYPES.has(path.split('.').at(-1).toLocaleLowerCase());
}

export class GitHubApiError extends Error {
  constructor(status, message) {
    super(`GitHub returned HTTP ${status}: ${message}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export function validateConfig(config) {
  const required = ['owner', 'repo', 'token'];
  for (const field of required) {
    if (typeof config?.[field] !== 'string' || !config[field].trim()) {
      throw new Error(`Enter a GitHub ${field}.`);
    }
  }

  const branch = typeof config.branch === 'string' && config.branch.trim() ? config.branch.trim() : 'main';
  if (/[\/\\\u0000-\u001f]/.test(config.repo)) {
    throw new Error('Enter the repository name only, not its URL.');
  }
  if ([config.owner, branch].some((value) => /[/\\\u0000-\u001f]/.test(value))) {
    throw new Error('Owner, repository, and branch must not contain slashes or control characters.');
  }

  const folderValue = typeof config.folder === 'string' ? config.folder : 'inbox';
  const folder = folderValue.trim().replace(/^\/+|\/+$/g, '');
  if (folder.split('/').some((segment) => segment === '.' || segment === '..') || /[\\\u0000-\u001f]/.test(folder)) {
    throw new Error('The inbox folder must be a valid repository path.');
  }

  return {
    owner: config.owner.trim(),
    repo: config.repo.trim(),
    branch,
    folder,
    token: config.token.trim()
  };
}

export function encodeUtf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeUtf8Base64(base64) {
  const binary = atob(base64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function noteFilename(title) {
  const safeTitle = title
    .trim()
    .replace(/[<>:"/\\|?*#^\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return `${safeTitle || 'Untitled'}.md`;
}

export class GitHubClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = validateConfig(config);
    // Native window.fetch requires its global receiver; binding also preserves that contract for injected fetches.
    this.fetch = fetchImpl.bind(globalThis);
    this.repositoryPath = `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repo)}`;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${API_ROOT}${path}`, {
      ...options,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.headers || {})
      }
    });

    const responseText = await response.text();
    let body;
    try {
      body = responseText ? JSON.parse(responseText) : null;
    } catch {
      body = null;
    }

    if (!response.ok) {
      const message = typeof body?.message === 'string' ? body.message : response.statusText || 'Request failed';
      throw new GitHubApiError(response.status, message);
    }
    if (body === null) throw new Error('GitHub returned an invalid response.');
    return body;
  }

  async testConnection() {
    const branch = encodeURIComponent(this.config.branch);
    return this.request(`${this.repositoryPath}/branches/${branch}`);
  }

  async listNotes() {
    const directory = this.config.folder
      ? `/contents/${this.config.folder.split('/').map(encodeURIComponent).join('/')}`
      : '/contents';
    const ref = new URLSearchParams({ ref: this.config.branch }).toString();
    let entries;
    try {
      entries = await this.request(`${this.repositoryPath}${directory}?${ref}`);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404 || !this.config.folder) throw error;
      await this.testConnection();
      return [];
    }
    if (!Array.isArray(entries)) throw new Error('GitHub returned an invalid inbox listing.');
    return entries
      .filter((entry) => entry.type === 'file' && typeof entry.name === 'string' && entry.name.toLowerCase().endsWith('.md'))
      .sort((left, right) => right.name.localeCompare(left.name));
  }

  async listDirectory(path = '') {
    const encodedPath = path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : '';
    const ref = new URLSearchParams({ ref: this.config.branch }).toString();
    const entries = await this.request(`${this.repositoryPath}/contents${encodedPath}?${ref}`);
    if (!Array.isArray(entries)) {
      throw new Error(`GitHub did not return a directory listing for ${path || 'the vault root'}.`);
    }
    return entries
      .filter((entry) => entry.type === 'dir' || (entry.type === 'file' && (/\.md$/i.test(entry.name) || isImagePath(entry.name))))
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'dir' ? -1 : 1;
        return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
      });
  }

  async listVaultIndex() {
    const branch = encodeURIComponent(this.config.branch);
    const ref = new URLSearchParams({ recursive: '1' }).toString();
    const branchInfo = await this.request(`${this.repositoryPath}/branches/${branch}`);
    const treeSha = branchInfo.commit?.commit?.tree?.sha;
    if (typeof treeSha !== 'string' || !treeSha) {
      throw new Error('GitHub did not return the configured branch’s file tree.');
    }
    const tree = await this.request(`${this.repositoryPath}/git/trees/${encodeURIComponent(treeSha)}?${ref}`);
    if (!Array.isArray(tree.tree) || typeof tree.truncated !== 'boolean') {
      throw new Error('GitHub returned an invalid vault file index.');
    }
    if (tree.truncated) {
      throw new Error('This vault is too large for GitHub’s complete file index. Folder browsing still works, but search, wiki links, and the destination folder list may be incomplete.');
    }
    const markdownPaths = [];
    const imagePaths = [];
    const directories = new Set(['']);
    for (const entry of tree.tree) {
      if (typeof entry.path !== 'string') continue;
      if (entry.type === 'blob') {
        if (/\.md$/i.test(entry.path)) markdownPaths.push(entry.path);
        else if (isImagePath(entry.path)) imagePaths.push(entry.path);
      }
      let parent = '';
      const parts = entry.path.split('/');
      for (const part of entry.type === 'tree' ? parts : parts.slice(0, -1)) {
        parent = parent ? `${parent}/${part}` : part;
        directories.add(parent);
      }
      if (entry.type === 'tree') directories.add(entry.path);
    }
    return {
      markdownPaths,
      imagePaths,
      directories: [...directories].sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    };
  }

  async listMarkdownPaths() {
    return (await this.listVaultIndex()).markdownPaths;
  }

  async readNote(path) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const ref = new URLSearchParams({ ref: this.config.branch }).toString();
    const file = await this.request(`${this.repositoryPath}/contents/${encodedPath}?${ref}`);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error('GitHub returned an unsupported note format.');
    }
    return decodeUtf8Base64(file.content);
  }

  async readNoteWithMetadata(path) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const ref = new URLSearchParams({ ref: this.config.branch }).toString();
    const file = await this.request(`${this.repositoryPath}/contents/${encodedPath}?${ref}`);
    if (file.encoding !== 'base64' || typeof file.content !== 'string' || typeof file.sha !== 'string') {
      throw new Error('GitHub returned an unsupported note format.');
    }
    return {
      content: decodeUtf8Base64(file.content),
      sha: file.sha
    };
  }

  async readImage(path) {
    const extension = path.split('.').at(-1).toLocaleLowerCase();
    const expectedMimeType = IMAGE_MIME_TYPES.get(extension);
    if (!expectedMimeType) throw new Error('This image format is not supported.');
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const ref = new URLSearchParams({ ref: this.config.branch }).toString();
    const response = await this.fetch(`${API_ROOT}${this.repositoryPath}/contents/${encodedPath}?${ref}`, {
      headers: {
        Accept: 'application/vnd.github.raw',
        Authorization: `Bearer ${this.config.token}`,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (!response.ok) {
      let message = response.statusText || 'Image request failed';
      try {
        const body = await response.json();
        if (typeof body.message === 'string') message = body.message;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      throw new GitHubApiError(response.status, message);
    }
    const contentLength = Number(response.headers?.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 20 * 1024 * 1024) {
      throw new Error('This image is larger than Pleronic’s 20 MB preview limit.');
    }
    const blob = await response.blob();
    if (blob.size > 20 * 1024 * 1024) {
      throw new Error('This image is larger than Pleronic’s 20 MB preview limit.');
    }
    const responseMimeType = blob.type.toLocaleLowerCase().split(';')[0];
    if (responseMimeType && responseMimeType !== 'application/octet-stream' && responseMimeType !== expectedMimeType) {
      throw new Error('GitHub returned an unexpected image format.');
    }
    return responseMimeType === expectedMimeType ? blob : new Blob([blob], { type: expectedMimeType });
  }

  async updateNote(path, content, title, sha) {
    if (typeof sha !== 'string' || !sha) throw new Error('A note SHA is required to safely update an existing file.');
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await this.request(`${this.repositoryPath}/contents/${encodedPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Update note: ${title}`,
        content: encodeUtf8Base64(content),
        sha,
        branch: this.config.branch
      })
    });
    if (response.content?.path !== path || typeof response.content.sha !== 'string') {
      throw new Error('GitHub did not confirm that the updated note was saved.');
    }
    return { sha: response.content.sha };
  }

  async searchNotes(query, paths, onProgress = () => {}) {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return [];
    if (!Array.isArray(paths)) throw new Error('A vault file index is required to search notes.');

    const matches = [];
    let nextIndex = 0;
    let completed = 0;
    let firstError = null;
    const searchNext = async () => {
      while (nextIndex < paths.length && !firstError) {
        const path = paths[nextIndex];
        nextIndex += 1;
        try {
          if (path.split('/').at(-1).toLocaleLowerCase().includes(normalizedQuery)) {
            matches.push({ path, snippet: 'Note title match' });
          } else {
            const content = await this.readNote(path);
            const matchingLine = content.split(/\r?\n/).find((line) => line.toLocaleLowerCase().includes(normalizedQuery));
            if (matchingLine !== undefined) {
              const line = matchingLine.trim();
              matches.push({
                path,
                snippet: line.length > 180 ? `${line.slice(0, 177)}…` : line
              });
            }
          }
        } catch (error) {
          firstError = new Error(`Could not search “${path}”: ${error.message}`, { cause: error });
        }
        completed += 1;
        onProgress(completed, paths.length);
      }
    };

    await Promise.all(Array.from({ length: Math.min(4, paths.length) }, searchNext));
    if (firstError) throw firstError;
    return matches.sort((left, right) => left.path.localeCompare(right.path, undefined, { sensitivity: 'base' }));
  }

  async createNote(path, content, title) {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const response = await this.request(`${this.repositoryPath}/contents/${encodedPath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Add note: ${title}`,
        content: encodeUtf8Base64(content),
        branch: this.config.branch
      })
    });
    if (!response.content?.path) throw new Error('GitHub did not confirm that the note was saved.');
    return response;
  }
}
