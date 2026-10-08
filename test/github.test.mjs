import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeUtf8Base64,
  encodeUtf8Base64,
  GitHubApiError,
  GitHubClient,
  noteFilename,
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

test('config tells users to enter the repository name instead of its URL', () => {
  assert.throws(() => validateConfig({ ...config, repo: 'https://github.com/octo-user/my-vault' }), /repository name only, not its URL/);
});

test('base64 helpers round-trip Unicode note content', () => {
  const note = 'Café — こんにちは 🌱';
  assert.equal(decodeUtf8Base64(encodeUtf8Base64(note)), note);
});

test('note filenames use the title without timestamp or slug conversion', () => {
  assert.equal(noteFilename('My Field Notes 🌲'), 'My Field Notes 🌲.md');
});

test('note filenames replace filesystem and Obsidian-reserved characters', () => {
  assert.equal(noteFilename('Plan: A/B? #1'), 'Plan- A-B- -1.md');
  assert.equal(noteFilename('  Name...  '), 'Name.md');
  assert.equal(noteFilename('   '), 'Untitled.md');
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

test('createNote writes UTF-8 content to the configured branch and creates the destination path', async () => {
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

test('readNoteWithMetadata returns the file content and SHA for conditional updates', async () => {
  const client = new GitHubClient(config, async () => response(200, {
    encoding: 'base64',
    content: encodeUtf8Base64('Original note'),
    sha: 'original-sha'
  }));

  assert.deepEqual(await client.readNoteWithMetadata('notes/inbox/Forest Notes.md'), {
    content: 'Original note',
    sha: 'original-sha'
  });
});

test('readNoteWithMetadata rejects a response without a SHA', async () => {
  const client = new GitHubClient(config, async () => response(200, {
    encoding: 'base64',
    content: encodeUtf8Base64('Original note')
  }));
  await assert.rejects(client.readNoteWithMetadata('notes/inbox/Forest.md'), /unsupported note format/);
});

test('readNote remains compatible with content-only responses', async () => {
  const client = new GitHubClient(config, async () => response(200, {
    encoding: 'base64',
    content: encodeUtf8Base64('Original note')
  }));
  assert.equal(await client.readNote('notes/inbox/Forest.md'), 'Original note');
});

test('updateNote sends the original SHA and returns the new commit blob SHA', async () => {
  let request;
  const client = new GitHubClient(config, async (url, options) => {
    request = { url, options };
    return response(200, { content: { path: 'notes/inbox/Forest Notes.md', sha: 'updated-sha' } });
  });

  assert.deepEqual(await client.updateNote('notes/inbox/Forest Notes.md', 'Edited 🌲', 'Forest Notes', 'original-sha'), {
    sha: 'updated-sha'
  });
  assert.equal(request.url, 'https://api.github.com/repos/octo-user/my-vault/contents/notes/inbox/Forest%20Notes.md');
  const body = JSON.parse(request.options.body);
  assert.equal(body.sha, 'original-sha');
  assert.equal(body.branch, 'main');
  assert.equal(body.message, 'Update note: Forest Notes');
  assert.equal(decodeUtf8Base64(body.content), 'Edited 🌲');
});

test('updateNote requires the original SHA to prevent unconditional overwrites', async () => {
  const client = new GitHubClient(config, async () => {
    throw new Error('A request should not be sent without a SHA.');
  });
  await assert.rejects(client.updateNote('notes/inbox/Forest.md', 'Edited', 'Forest', ''), /SHA is required/);
});

test('updateNote preserves GitHub conflicts for safe recovery', async () => {
  const client = new GitHubClient(config, async () => response(409, { message: 'sha does not match' }));
  await assert.rejects(client.updateNote('notes/inbox/Forest.md', 'Edited', 'Forest', 'stale-sha'), (error) => {
    assert.ok(error instanceof GitHubApiError);
    assert.equal(error.status, 409);
    assert.match(error.message, /sha does not match/);
    return true;
  });
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

test('listDirectory shows folders and Markdown notes, with folders first', async () => {
  let requestedUrl;
  const client = new GitHubClient(config, async (url) => {
    requestedUrl = url;
    return response(200, [
      { type: 'file', name: 'zebra.md', path: 'zebra.md' },
      { type: 'file', name: 'photo.png', path: 'photo.png' },
      { type: 'dir', name: 'Work', path: 'Work' },
      { type: 'file', name: 'alpha.MD', path: 'alpha.MD' }
    ]);
  });

  const entries = await client.listDirectory('Projects/Field Notes');
  assert.match(requestedUrl, /\/contents\/Projects\/Field%20Notes\?ref=main$/);
  assert.deepEqual(entries.map((entry) => entry.name), ['Work', 'alpha.MD', 'zebra.md']);
});

test('listMarkdownPaths requests the recursive branch tree and returns Markdown paths', async () => {
  const requestedUrls = [];
  const client = new GitHubClient(config, async (url) => {
    requestedUrls.push(url);
    if (requestedUrls.length === 1) {
      return response(200, { commit: { commit: { tree: { sha: 'tree-sha' } } } });
    }
    return response(200, {
        truncated: false,
        tree: [
          { type: 'blob', path: 'Home.md' },
          { type: 'blob', path: 'Journal/Today.MD' },
          { type: 'blob', path: 'image.png' },
          { type: 'tree', path: 'Journal' }
        ]
      });
  });

  assert.deepEqual(await client.listMarkdownPaths(), ['Home.md', 'Journal/Today.MD']);
  assert.match(requestedUrls[0], /\/branches\/main$/);
  assert.match(requestedUrls[1], /\/git\/trees\/tree-sha\?recursive=1$/);
});

test('listVaultIndex returns Markdown paths and directories, including folders with only attachments', async () => {
  const client = new GitHubClient(config, async (url) => {
    if (url.endsWith('/branches/main')) {
      return response(200, { commit: { commit: { tree: { sha: 'tree-sha' } } } });
    }
    return response(200, {
      truncated: false,
      tree: [
        { type: 'tree', path: 'Projects' },
        { type: 'tree', path: 'Projects/Forest' },
        { type: 'blob', path: 'Projects/Forest/map.png' },
        { type: 'blob', path: 'Projects/Forest/Notes.md' }
      ]
    });
  });

  assert.deepEqual(await client.listVaultIndex(), {
    markdownPaths: ['Projects/Forest/Notes.md'],
    directories: ['', 'Projects', 'Projects/Forest']
  });
});

test('listMarkdownPaths reports truncated GitHub trees instead of returning incomplete links', async () => {
  let requestCount = 0;
  const client = new GitHubClient(config, async () => {
    requestCount += 1;
    return requestCount === 1
      ? response(200, { commit: { commit: { tree: { sha: 'tree-sha' } } } })
      : response(200, { truncated: true, tree: [] });
  });
  await assert.rejects(client.listMarkdownPaths(), /too large.*complete file index/i);
});

test('searchNotes finds title and content matches with a short matching-line snippet', async () => {
  const requestedPaths = [];
  const progress = [];
  const paths = ['Garden/Forest.md', 'Journal/Day.md', 'Reference/Notes.md'];
  const contents = new Map([
    ['Journal/Day.md', 'A quiet day.\nWalked through the forest after rain.'],
    ['Reference/Notes.md', 'No matching word here.']
  ]);
  const client = new GitHubClient(config, async (url) => {
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
    requestedPaths.push(path);
    return response(200, { encoding: 'base64', content: encodeUtf8Base64(contents.get(path)) });
  });

  const results = await client.searchNotes('FOREST', paths, (completed, total) => progress.push([completed, total]));
  assert.deepEqual(results, [
    { path: 'Garden/Forest.md', snippet: 'Note title match' },
    { path: 'Journal/Day.md', snippet: 'Walked through the forest after rain.' }
  ]);
  assert.deepEqual(requestedPaths, ['Journal/Day.md', 'Reference/Notes.md']);
  assert.deepEqual(progress, [[1, 3], [2, 3], [3, 3]]);
});

test('searchNotes reports the note that could not be read', async () => {
  const client = new GitHubClient(config, async () => response(403, { message: 'Resource not accessible' }));
  await assert.rejects(client.searchNotes('forest', ['Garden/Note.md']), /Could not search.*Garden\/Note\.md.*HTTP 403/);
});

test('searchNotes limits concurrent GitHub content requests', async () => {
  let activeRequests = 0;
  let maximumRequests = 0;
  const client = new GitHubClient(config, async () => {
    activeRequests += 1;
    maximumRequests = Math.max(maximumRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    return response(200, { encoding: 'base64', content: encodeUtf8Base64('No match here.') });
  });

  const paths = Array.from({ length: 9 }, (_, index) => `Note ${index}.md`);
  assert.deepEqual(await client.searchNotes('forest', paths), []);
  assert.equal(maximumRequests, 4);
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
