import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeUtf8Base64,
  encodeUtf8Base64,
  GitHubApiError,
  GitHubClient,
  validateConfig
} from '../github.mjs';

const config = {
  owner: 'octo-user',
  repo: 'my-vault',
  branch: 'main',
  folder: 'notes/inbox',
  token: 'github_pat_test'
};

function response(status, body, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body === null ? '' : JSON.stringify(body)
  };
}

test('config trims values and accepts a nested inbox folder', () => {
  assert.deepEqual(validateConfig({ ...config, owner: ' octo-user ', folder: '/notes/inbox/' }), {
    ...config,
    owner: 'octo-user',
    folder: 'notes/inbox'
  });
});

test('config migrates existing settings to the original inbox and main branch defaults', () => {
  assert.deepEqual(validateConfig({ owner: 'octo-user', repo: 'my-vault', token: 'github_pat_test' }), {
    owner: 'octo-user',
    repo: 'my-vault',
    branch: 'main',
    folder: 'inbox',
    token: 'github_pat_test'
  });
});

test('config rejects path traversal in the inbox folder', () => {
  assert.throws(() => validateConfig({ ...config, folder: 'notes/../private' }), /valid repository path/);
});

test('base64 helpers round-trip Unicode note content', () => {
  const note = 'Café — こんにちは 🌱';
  assert.equal(decodeUtf8Base64(encodeUtf8Base64(note)), note);
});

test('connection test requests the configured repository branch with the token', async () => {
  let request;
  const client = new GitHubClient(config, async (url, options) => {
    request = { url, options };
    return response(200, { name: 'main' });
  });

  assert.deepEqual(await client.testConnection(), { name: 'main' });
  assert.equal(request.url, 'https://api.github.com/repos/octo-user/my-vault/branches/main');
  assert.equal(request.options.headers.Authorization, 'Bearer github_pat_test');
  assert.equal(request.options.headers.Accept, 'application/vnd.github+json');
});

test('default fetch is invoked with the browser global as its receiver', async () => {
  const originalFetch = globalThis.fetch;
  let fetchReceiver;
  globalThis.fetch = function (url, options) {
    fetchReceiver = this;
    return Promise.resolve(response(200, { name: 'main' }));
  };
  try {
    const client = new GitHubClient(config);
    await client.testConnection();
    assert.equal(fetchReceiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('createNote writes UTF-8 content to the configured branch and nested folder', async () => {
  let request;
  const client = new GitHubClient(config, async (url, options) => {
    request = { url, options };
    return response(201, { content: { path: 'notes/inbox/cafe.md' } });
  });

  await client.createNote('notes/inbox/cafe.md', 'Café 🌿', 'Café');
  assert.equal(request.url, 'https://api.github.com/repos/octo-user/my-vault/contents/notes/inbox/cafe.md');
  assert.equal(request.options.method, 'PUT');
  const body = JSON.parse(request.options.body);
  assert.equal(body.branch, 'main');
  assert.equal(body.message, 'Add note: Café');
  assert.equal(decodeUtf8Base64(body.content), 'Café 🌿');
});

test('listNotes uses the configured branch and only returns Markdown files', async () => {
  let requestedUrl;
  const client = new GitHubClient(config, async (url) => {
    requestedUrl = url;
    return response(200, [
      { type: 'file', name: 'thought.md', path: 'notes/inbox/thought.md' },
      { type: 'file', name: 'image.png', path: 'notes/inbox/image.png' },
      { type: 'dir', name: 'archive.md', path: 'notes/inbox/archive.md' }
    ]);
  });

  const notes = await client.listNotes();
  assert.match(requestedUrl, /\/contents\/notes\/inbox\?ref=main$/);
  assert.deepEqual(notes.map((note) => note.name), ['thought.md']);
});

test('a missing inbox folder is empty when the configured branch exists', async () => {
  const requestedUrls = [];
  const client = new GitHubClient(config, async (url) => {
    requestedUrls.push(url);
    return requestedUrls.length === 1
      ? response(404, { message: 'Not Found' }, 'Not Found')
      : response(200, { name: 'main' });
  });

  assert.deepEqual(await client.listNotes(), []);
  assert.equal(requestedUrls.length, 2);
  assert.match(requestedUrls[1], /\/branches\/main$/);
});

test('GitHub API errors preserve status and actionable message', async () => {
  const client = new GitHubClient(config, async () => response(403, { message: 'Resource not accessible by personal access token' }));
  await assert.rejects(client.testConnection(), (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.status, 403);
    assert.match(error.message, /Resource not accessible by personal access token/);
    return true;
  });
});
