import { marked } from './vendor/marked.esm.js';
import { del, get, set } from './vendor/idb-keyval.js';
import { GitHubApiError, GitHubClient, noteFilename, validateConfig } from './github.mjs';
import { headingSlug, resolveWikiLinks } from './obsidian.mjs';

const CONFIG_KEY = 'obsidian_config';
const QUEUE_KEY = 'sync_queue';
const DRAFT_KEY = 'capture_draft';
const BLOCKED_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'SVG', 'MATH']);
const SAFE_TAGS = new Set([
  'A', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HR', 'IMG', 'LI', 'OL', 'P', 'PRE', 'STRONG', 'TABLE', 'TBODY', 'TD', 'TH',
  'THEAD', 'TR', 'UL'
]);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const elements = {
  connection: $('#connection-status'),
  connectionLabel: $('#connection-label'),
  count: $$('.queue-count'),
  banner: $('#queue-banner'),
  bannerMessage: $('#queue-message'),
  syncButton: $('#sync-queue'),
  title: $('#note-title'),
  content: $('#note-content'),
  form: $('#capture-form'),
  saveButton: $('#save-note'),
  draftStatus: $('#draft-status'),
  preview: $('#note-preview'),
  writeTab: $('#write-tab'),
  previewTab: $('#preview-tab'),
  noteList: $('#note-list'),
  inboxDescription: $('#inbox-description'),
  breadcrumbs: $('#vault-breadcrumbs'),
  directoryHeading: $('#directory-heading'),
  search: $('#inbox-search'),
  readerTitle: $('#reader-title'),
  readerMeta: $('#reader-meta'),
  readerContent: $('#reader-content'),
  toast: $('#toast'),
  owner: $('#gh-owner'),
  repo: $('#gh-repo'),
  branch: $('#gh-branch'),
  folder: $('#gh-folder'),
  token: $('#gh-token'),
  vaultName: $('#vault-name'),
  vaultBranch: $('#vault-branch')
};

let config = loadConfig();
let directoryEntries = [];
let currentDirectory = '';
let markdownPathIndex = null;
let markdownPathIndexKey = '';
let currentView = 'capture';
let syncInProgress = false;
let toastTimer;
let draftTimer;

function loadConfig() {
  try {
    const stored = localStorage.getItem(CONFIG_KEY);
    if (!stored) return null;
    return validateConfig(JSON.parse(stored));
  } catch (error) {
    console.error('Could not load saved GitHub settings:', error);
    return null;
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('active');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('active'), 4200);
}

function setConnection(state, label) {
  elements.connection.dataset.state = state;
  elements.connectionLabel.textContent = label;
}

function getQueue() {
  return get(QUEUE_KEY).then((stored) => {
    if (stored === undefined) return [];
    if (!Array.isArray(stored)) throw new Error('The saved sync queue is invalid.');

    let changed = false;
    const queue = stored.map((note) => {
      if (note && typeof note.id === 'string' && typeof note.relativePath === 'string') return note;
      if (!note || typeof note.content !== 'string' || typeof note.path !== 'string') {
        throw new Error('A queued note is invalid. It has been kept on this device.');
      }
      changed = true;
      const relativePath = note.path.split('/').filter(Boolean).pop();
      return {
        id: crypto.randomUUID(),
        relativePath,
        title: relativePath.replace(/\.md$/i, ''),
        content: note.content,
        createdAt: new Date().toISOString(),
        destination: null
      };
    });

    return changed ? set(QUEUE_KEY, queue).then(() => queue) : queue;
  });
}

function updateQueueStatus(queue) {
  const count = queue.length;
  for (const badge of elements.count) {
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }
  elements.banner.classList.toggle('active', count > 0);
  elements.bannerMessage.textContent = count === 1
    ? '1 note is waiting to sync from this device.'
    : `${count} notes are waiting to sync from this device.`;
  elements.syncButton.textContent = syncInProgress ? 'Syncing…' : 'Sync now';
  elements.syncButton.disabled = syncInProgress;
}

function updateVaultCard() {
  elements.vaultName.textContent = config ? `${config.owner}/${config.repo}` : 'Not configured';
  elements.vaultName.title = elements.vaultName.textContent;
  elements.vaultBranch.textContent = config ? `${config.branch} · ${config.folder || 'repository root'}` : 'Connect a GitHub repository';
}

function clientFromConfig(savedConfig = config) {
  if (!savedConfig) throw new Error('Connect a GitHub repository in Settings before syncing.');
  return new GitHubClient(savedConfig);
}

function updatePreview(markdown, target) {
  const parsed = new DOMParser().parseFromString(marked.parse(markdown), 'text/html');
  const fragment = document.createDocumentFragment();

  const copySafeNode = (source, destination) => {
    if (source.nodeType === Node.TEXT_NODE) {
      destination.append(document.createTextNode(source.textContent || ''));
      return;
    }
    if (source.nodeType !== Node.ELEMENT_NODE) return;

    const element = source;
    if (BLOCKED_TAGS.has(element.tagName)) return;
    if (!SAFE_TAGS.has(element.tagName)) {
      for (const child of element.childNodes) copySafeNode(child, destination);
      return;
    }

    const safeElement = document.createElement(element.tagName.toLowerCase());
    if (element.tagName === 'A') {
      const href = safeUrl(element.getAttribute('href'), false);
      if (href) {
        safeElement.setAttribute('href', href);
        safeElement.setAttribute('rel', 'noopener noreferrer');
        safeElement.setAttribute('target', '_blank');
      }
    } else if (element.tagName === 'IMG') {
      const src = safeUrl(element.getAttribute('src'), true);
      if (!src) return;
      safeElement.setAttribute('src', src);
      safeElement.setAttribute('alt', element.getAttribute('alt') || '');
      safeElement.setAttribute('loading', 'lazy');
    }
    if (element.hasAttribute('title')) safeElement.setAttribute('title', element.getAttribute('title'));
    for (const child of element.childNodes) copySafeNode(child, safeElement);
    destination.append(safeElement);
  };

  for (const child of parsed.body.childNodes) copySafeNode(child, fragment);
  target.replaceChildren(fragment);
  const headingCounts = new Map();
  for (const heading of target.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = headingSlug(heading.textContent);
    const count = headingCounts.get(base) || 0;
    headingCounts.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  }
}

function safeUrl(value, image) {
  if (!value) return null;
  if (!image && value.startsWith('vault:')) return value;
  try {
    const url = new URL(value, location.href);
    const allowed = image ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:'];
    return allowed.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function switchView(view) {
  currentView = view;
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  if (view === 'inbox') fetchInbox();
}

function formatNoteTitle(name) {
  return name.replace(/\.md$/i, '').replace(/^\d{8}-\d{6}-(?:\d{3}-)?/, '').replace(/[-_]+/g, ' ');
}

function renderInbox() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const entries = directoryEntries.filter((entry) => entry.name.toLocaleLowerCase().includes(query));
  elements.noteList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const heading = document.createElement('strong');
    heading.textContent = query ? 'No folders or notes match that filter.' : 'This folder is empty.';
    const detail = document.createElement('span');
    detail.textContent = query ? 'Try another name.' : currentDirectory ? 'Try another folder or go back up a level.' : 'Capture a thought and it will land here.';
    empty.append(heading, detail);
    elements.noteList.append(empty);
    return;
  }

  for (const entry of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-card';
    if (entry.type === 'dir') button.dataset.directoryPath = entry.path;
    else button.dataset.notePath = entry.path;
    const icon = document.createElement('span');
    icon.className = 'note-file';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = entry.type === 'dir' ? '▱' : '▤';
    const info = document.createElement('span');
    info.className = 'note-info';
    const title = document.createElement('span');
    title.className = 'note-name';
    title.textContent = entry.type === 'dir' ? entry.name : formatNoteTitle(entry.name);
    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = entry.type === 'dir'
      ? `Folder · ${entry.path}`
      : entry.path;
    info.append(title, meta);
    const kind = document.createElement('span');
    kind.className = 'note-kind';
    kind.textContent = entry.type === 'dir' ? 'FOLDER' : 'NOTE';
    const arrow = document.createElement('span');
    arrow.className = 'note-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    button.append(icon, info, kind, arrow);
    elements.noteList.append(button);
  }
}

async function fetchInbox() {
  if (!config) {
    directoryEntries = [];
    elements.inboxDescription.textContent = 'Connect a GitHub repository in Settings to browse your vault.';
    elements.directoryHeading.textContent = 'Vault root';
    renderBreadcrumbs();
    renderInbox();
    return;
  }

  elements.inboxDescription.textContent = `${config.owner}/${config.repo} · read-only`;
  elements.noteList.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.textContent = 'Opening your vault…';
  elements.noteList.append(loading);
  try {
    directoryEntries = await clientFromConfig().listDirectory(currentDirectory);
    elements.directoryHeading.textContent = currentDirectory.split('/').at(-1) || 'Vault root';
    renderBreadcrumbs();
    renderInbox();
    setConnection(navigator.onLine ? 'online' : 'offline', navigator.onLine ? 'Connected to GitHub' : 'Offline');
  } catch (error) {
    console.error('Could not load the vault inbox:', error);
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const heading = document.createElement('strong');
    heading.textContent = 'Could not open this folder.';
    const detail = document.createElement('span');
    detail.textContent = error.message;
    empty.append(heading, detail);
    elements.noteList.replaceChildren(empty);
    setConnection('error', 'GitHub connection needs attention');
  }
}

function renderBreadcrumbs() {
  elements.breadcrumbs.replaceChildren();
  const root = document.createElement('button');
  root.type = 'button';
  root.className = currentDirectory ? 'breadcrumb' : 'breadcrumb breadcrumb-current';
  root.textContent = config?.repo || 'Vault';
  root.dataset.directoryPath = '';
  elements.breadcrumbs.append(root);

  const parts = currentDirectory.split('/').filter(Boolean);
  let path = '';
  parts.forEach((part, index) => {
    const separator = document.createElement('span');
    separator.className = 'breadcrumb-separator';
    separator.setAttribute('aria-hidden', 'true');
    separator.textContent = '/';
    elements.breadcrumbs.append(separator);
    path = path ? `${path}/${part}` : part;
    const crumb = document.createElement('button');
    crumb.type = 'button';
    crumb.className = index === parts.length - 1 ? 'breadcrumb breadcrumb-current' : 'breadcrumb';
    crumb.textContent = part;
    crumb.dataset.directoryPath = path;
    elements.breadcrumbs.append(crumb);
  });
}

function vaultIndexKey() {
  return config ? `${config.owner}/${config.repo}@${config.branch}` : '';
}

function invalidateMarkdownPathIndex() {
  markdownPathIndex = null;
  markdownPathIndexKey = '';
}

async function getMarkdownPaths() {
  const key = vaultIndexKey();
  if (markdownPathIndex && key === markdownPathIndexKey) return markdownPathIndex;
  markdownPathIndex = await clientFromConfig().listMarkdownPaths();
  markdownPathIndexKey = key;
  return markdownPathIndex;
}

async function storeDraft() {
  try {
    const content = elements.content.value;
    const title = elements.title.value;
    if (content || title) {
      await set(DRAFT_KEY, { title, content, updatedAt: new Date().toISOString() });
      elements.draftStatus.textContent = 'Draft saved on this device';
    } else {
      await del(DRAFT_KEY);
      elements.draftStatus.textContent = 'Saved as a draft on this device';
    }
  } catch (error) {
    console.error('Could not save the local draft:', error);
    elements.draftStatus.textContent = 'Draft could not be saved on this device';
  }
}

async function saveNote(event) {
  event.preventDefault();
  const content = elements.content.value.trim();
  if (!content) {
    showToast('Add a little something to your note first.');
    elements.content.focus();
    return;
  }

  const enteredTitle = elements.title.value.trim();
  const title = enteredTitle || `Note ${new Date().toLocaleString()}`;
  const note = {
    id: crypto.randomUUID(),
    relativePath: noteFilename(title),
    title,
    content: elements.content.value.trim(),
    createdAt: new Date().toISOString(),
    destination: config ? {
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      folder: config.folder
    } : null
  };
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = 'Saving…';
  try {
    if (!navigator.onLine || !config) {
      await enqueueNote(note);
      showToast(config ? 'Saved on this device. It will sync when you’re back online.' : 'Saved on this device. Connect a vault to sync it.');
      clearEditor();
      return;
    }
    await clientFromConfig().createNote(repositoryPath(note), note.content, note.title);
    invalidateMarkdownPathIndex();
    showToast('Note saved to your vault.');
    clearEditor();
    if (currentView === 'inbox') fetchInbox();
  } catch (error) {
    if (!config || !navigator.onLine) {
      showToast(error.message);
      return;
    }
    console.error('Could not save the note to GitHub:', error);
    if (error instanceof GitHubApiError && error.status === 422) {
      try {
        const existing = await clientFromConfig().readNote(repositoryPath(note));
        if (existing !== note.content) {
          showToast(`“${note.relativePath}” already exists. Choose a different title; the existing note was not changed.`);
          return;
        }
        showToast('That note is already saved in your vault.');
        clearEditor();
        return;
      } catch (lookupError) {
        if (!(lookupError instanceof GitHubApiError) || lookupError.status !== 404) {
          console.error('Could not check whether the note already exists:', lookupError);
        }
      }
    }
    try {
      await enqueueNote(note);
      showToast(`Saved on this device; GitHub could not save it: ${error.message}`);
      clearEditor();
      setConnection('error', 'Note waiting to sync');
    } catch (queueError) {
      console.error('Could not queue the note locally:', queueError);
      showToast(`GitHub could not save the note, and local storage failed: ${queueError.message}`);
    }
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.innerHTML = 'Save to vault <span aria-hidden="true">↗</span>';
  }
}

function repositoryPath(note, destination = note.destination || config) {
  if (!destination) return `${note.relativePath}`;
  return [destination.folder, note.relativePath].filter(Boolean).join('/');
}

async function enqueueNote(note) {
  const queue = await getQueue();
  queue.push(note);
  await set(QUEUE_KEY, queue);
  updateQueueStatus(queue);
}

function clearEditor() {
  elements.title.value = '';
  elements.content.value = '';
  updatePreview('', elements.preview);
  void storeDraft();
}

async function syncQueue() {
  if (syncInProgress) return;
  if (!navigator.onLine) {
    showToast('You’re offline. Your notes are safe on this device.');
    return;
  }
  if (!config) {
    switchView('settings');
    showToast('Connect a GitHub vault before syncing queued notes.');
    return;
  }

  syncInProgress = true;
  setConnection('syncing', 'Syncing notes…');
  let queue;
  try {
    queue = await getQueue();
    updateQueueStatus(queue);
    while (queue.length > 0) {
      const note = queue[0];
      const destination = note.destination || config;
      await syncQueuedNote(note, destination);
      const remaining = queue.slice(1);
      await set(QUEUE_KEY, remaining);
      queue = remaining;
      updateQueueStatus(queue);
    }
    showToast('All queued notes made it to your vault.');
    setConnection('online', 'Connected to GitHub');
  } catch (error) {
    console.error('Queued notes could not be synced:', error);
    if (queue) updateQueueStatus(queue);
    setConnection('error', 'Sync needs attention');
    showToast(`Sync stopped. Notes not confirmed as saved remain queued: ${error.message}`);
  } finally {
    syncInProgress = false;
    if (queue) updateQueueStatus(queue);
  }
}

async function syncQueuedNote(note, destination) {
  const client = clientFromConfig({ ...destination, token: config.token });
  const path = repositoryPath(note, destination);
  try {
    await client.createNote(path, note.content, note.title);
    invalidateMarkdownPathIndex();
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
    const existing = await client.readNote(path);
    if (existing !== note.content) {
      throw new Error(`“${note.relativePath}” already exists. Rename or remove that file before syncing this queued note.`);
    }
  }
}

async function openNote(note, heading = null) {
  switchView('reader');
  elements.readerTitle.textContent = formatNoteTitle(note.name);
  elements.readerMeta.textContent = note.path;
  elements.readerContent.textContent = 'Loading note…';
  const cacheKey = `note_cache:${note.path}`;
  try {
    const markdown = await clientFromConfig().readNote(note.path);
    await renderVaultNote(markdown, note.path);
    try {
      await set(cacheKey, markdown);
    } catch (cacheError) {
      console.error('Could not cache the opened note:', cacheError);
      showToast(`Note opened, but its offline copy could not be saved: ${cacheError.message}`);
    }
  } catch (error) {
    console.error('Could not load the note from GitHub:', error);
    try {
      const cached = await get(cacheKey);
      if (typeof cached === 'string') {
        await renderVaultNote(cached, note.path);
        elements.readerMeta.textContent = `${note.path} · Offline copy`;
        showToast('Showing the last saved copy of this note.');
      } else {
        elements.readerContent.textContent = error.message;
        setConnection('error', 'Could not open this note');
      }
    } catch (cacheError) {
      console.error('Could not read the cached note:', cacheError);
      elements.readerContent.textContent = `${error.message} (Offline cache unavailable: ${cacheError.message})`;
    }
  }
  if (heading) {
    const target = elements.readerContent.querySelector(`#${CSS.escape(headingSlug(heading))}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

async function renderVaultNote(markdown, path) {
  let linkedMarkdown = markdown;
  try {
    linkedMarkdown = resolveWikiLinks(markdown, path, await getMarkdownPaths());
  } catch (error) {
    console.error('Could not build the vault link index:', error);
    showToast(`Note opened, but vault links could not be resolved: ${error.message}`);
  }
  updatePreview(linkedMarkdown, elements.readerContent);
}

function navigateVaultLink(href) {
  const [encodedPath, encodedHeading] = href.slice('vault:'.length).split('#', 2);
  let path;
  let heading;
  try {
    path = decodeURIComponent(encodedPath);
    heading = encodedHeading ? decodeURIComponent(encodedHeading) : null;
  } catch (error) {
    console.error('Could not decode vault link:', error);
    showToast('This vault link is invalid.');
    return;
  }

  const targetPath = markdownPathIndex?.find((entry) => entry.toLocaleLowerCase() === path.toLocaleLowerCase());
  if (!targetPath) {
    showToast('That note could not be found in the vault.');
    return;
  }
  const name = targetPath.split('/').at(-1);
  void openNote({ name, path: targetPath }, heading);
}

function populateSettingsForm() {
  elements.owner.value = config?.owner || '';
  elements.repo.value = config?.repo || '';
  elements.branch.value = config?.branch || 'main';
  elements.folder.value = config?.folder ?? 'inbox';
  elements.token.value = config?.token || '';
  updateVaultCard();
}

function readSettingsForm() {
  return validateConfig({
    owner: elements.owner.value,
    repo: elements.repo.value,
    branch: elements.branch.value,
    folder: elements.folder.value,
    token: elements.token.value
  });
}

async function saveSettings(event) {
  event.preventDefault();
  try {
    const candidate = readSettingsForm();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(candidate));
    config = candidate;
    populateSettingsForm();
    setConnection(navigator.onLine ? 'online' : 'offline', navigator.onLine ? 'Settings saved' : 'Saved for when you’re online');
    showToast('Vault settings saved on this device.');
  } catch (error) {
    showToast(error.message);
  }
}

async function testConnection() {
  const button = $('#test-connection');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const candidate = readSettingsForm();
    const branch = await new GitHubClient(candidate).testConnection();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(candidate));
    config = candidate;
    populateSettingsForm();
    setConnection('online', `Connected · ${branch.name || candidate.branch}`);
    showToast(`Connected to ${candidate.owner}/${candidate.repo} on ${candidate.branch}.`);
  } catch (error) {
    console.error('GitHub connection test failed:', error);
    setConnection('error', error instanceof GitHubApiError && error.status === 401 ? 'Token was rejected' : 'Connection test failed');
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = 'Test connection';
  }
}

function disconnect() {
  if (!confirm('Remove the GitHub token and vault settings from this device? Queued notes stay here, but you’ll need to reconnect before they can sync.')) return;
  localStorage.removeItem(CONFIG_KEY);
  config = null;
  populateSettingsForm();
  setConnection(navigator.onLine ? 'online' : 'offline', 'Not connected');
  showToast('Vault disconnected. Notes already queued remain on this device.');
}

async function initialize() {
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#date-label').textContent = date.format(new Date());
  populateSettingsForm();
  setConnection(navigator.onLine ? 'online' : 'offline', config ? 'Connected to GitHub' : 'Ready to connect');

  try {
    const [queue, draft] = await Promise.all([getQueue(), get(DRAFT_KEY)]);
    updateQueueStatus(queue);
      if (queue.length && navigator.onLine && config) void syncQueue();
    if (draft && typeof draft === 'object') {
      elements.title.value = typeof draft.title === 'string' ? draft.title : '';
      elements.content.value = typeof draft.content === 'string' ? draft.content : '';
      if (draft.updatedAt) elements.draftStatus.textContent = `Draft saved ${new Date(draft.updatedAt).toLocaleString()}`;
    }
  } catch (error) {
    console.error('Could not restore local notes:', error);
    showToast(`Could not restore local notes: ${error.message}`);
  }

  updatePreview(elements.content.value, elements.preview);
  switchView('capture');
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$('#top-settings').addEventListener('click', () => switchView('settings'));
$('#reader-back').addEventListener('click', () => switchView('inbox'));
elements.form.addEventListener('submit', saveNote);
$('#settings-form').addEventListener('submit', saveSettings);
$('#test-connection').addEventListener('click', testConnection);
$('#disconnect').addEventListener('click', disconnect);
elements.syncButton.addEventListener('click', syncQueue);
$('#refresh-inbox').addEventListener('click', fetchInbox);
elements.search.addEventListener('input', renderInbox);
elements.noteList.addEventListener('click', (event) => {
  const directory = event.target.closest('[data-directory-path]');
  if (directory) {
    currentDirectory = directory.dataset.directoryPath;
    elements.search.value = '';
    fetchInbox();
    return;
  }
  const button = event.target.closest('[data-note-path]');
  if (!button) return;
  const note = directoryEntries.find((entry) => entry.path === button.dataset.notePath && entry.type === 'file');
  if (note) openNote(note);
});
elements.readerContent.addEventListener('click', (event) => {
  const link = event.target.closest('a[href^="vault:"]');
  if (link) {
    event.preventDefault();
    navigateVaultLink(link.getAttribute('href'));
    return;
  }
  const headingLink = event.target.closest('a[href^="#"]');
  if (headingLink) {
    const heading = elements.readerContent.querySelector(`#${CSS.escape(decodeURIComponent(headingLink.hash.slice(1)))}`);
    if (heading) {
      event.preventDefault();
      heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
});
elements.writeTab.addEventListener('click', () => {
  elements.content.hidden = false;
  elements.preview.classList.remove('active');
  elements.writeTab.classList.add('active');
  elements.previewTab.classList.remove('active');
  elements.writeTab.setAttribute('aria-selected', 'true');
  elements.previewTab.setAttribute('aria-selected', 'false');
});
elements.previewTab.addEventListener('click', () => {
  updatePreview(elements.content.value, elements.preview);
  elements.content.hidden = true;
  elements.preview.classList.add('active');
  elements.previewTab.classList.add('active');
  elements.writeTab.classList.remove('active');
  elements.previewTab.setAttribute('aria-selected', 'true');
  elements.writeTab.setAttribute('aria-selected', 'false');
});

for (const field of [elements.title, elements.content]) {
  field.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(storeDraft, 350);
  });
}

window.addEventListener('online', () => {
  setConnection('online', config ? 'Connected to GitHub' : 'Ready to connect');
  void syncQueue();
});
window.addEventListener('offline', () => setConnection('offline', 'Offline · notes stay on this device'));
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .catch((error) => console.error('Service worker registration failed:', error));
}

void initialize();
