import { marked } from './vendor/marked.esm.js';
import { del, get, getMany, keys, set } from './vendor/idb-keyval.js';
import { GitHubApiError, GitHubClient, isImagePath, noteFilename, validateConfig } from './github.mjs';
import { extractObsidianFrontmatter, headingSlug, resolveImageEmbeds, resolveWikiLinks } from './obsidian.mjs';

const CONFIG_KEY = 'obsidian_config';
const QUEUE_KEY = 'sync_queue';
const DRAFT_KEY = 'capture_draft';
const CAPTURE_DRAFT_PREFIX = 'capture_note_draft:';
const RECENT_NOTES_KEY = 'recent_notes';
const RECENT_NOTES_LIMIT = 5;
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
  saveCaptureDraftButton: $('#save-capture-draft'),
  saveFolderToggle: $('#save-folder-toggle'),
  saveFolderMenu: $('#save-folder-menu'),
  saveFolderSearch: $('#save-folder-search'),
  saveFolderOptions: $('#save-folder-options'),
  saveFolderStatus: $('#save-folder-status'),
  saveFolderLabel: $('#save-folder-label'),
  draftStatus: $('#draft-status'),
  preview: $('#note-preview'),
  writeTab: $('#write-tab'),
  previewTab: $('#preview-tab'),
  noteList: $('#note-list'),
  inboxDescription: $('#inbox-description'),
  breadcrumbs: $('#vault-breadcrumbs'),
  directoryHeading: $('#directory-heading'),
  search: $('#inbox-search'),
  vaultSearchForm: $('#vault-search-form'),
  vaultSearchInput: $('#vault-search-input'),
  vaultSearchButton: $('#vault-search-button'),
  vaultSearchStatus: $('#vault-search-status'),
  refreshInboxButton: $('#refresh-inbox'),
  recentNoteList: $('#recent-note-list'),
  myDraftsList: $('#my-drafts-list'),
  saveEditDraftButton: $('#save-edit-draft-button'),
  readerTitle: $('#reader-title'),
  readerMeta: $('#reader-meta'),
  readerTags: $('#reader-tags'),
  readerFrontmatter: $('#reader-frontmatter'),
  readerFrontmatterContent: $('#reader-frontmatter-content'),
  imageViewer: $('#image-viewer'),
  imageViewerTitle: $('#image-viewer-title'),
  imageViewerImage: $('#image-viewer-image'),
  imageViewerError: $('#image-viewer-error'),
  imageViewerPath: $('#image-viewer-path'),
  readerBack: $('#reader-back'),
  readerBackLabel: $('#reader-back-label'),
  readerContent: $('#reader-content'),
  readerActions: $('#reader-actions'),
  editButton: $('#edit-note'),
  cancelEditButton: $('#cancel-edit'),
  saveEditButton: $('#save-edit'),
  editStatus: $('#edit-status'),
  noteEditor: $('#note-editor'),
  editContent: $('#edit-note-content'),
  editConflict: $('#edit-conflict'),
  remoteNoteContent: $('#remote-note-content'),
  copyLocalDraftButton: $('#copy-local-draft'),
  acceptRemoteVersionButton: $('#accept-remote-version'),
  draftExitDialog: $('#draft-exit-dialog'),
  installButton: $('#install-app'),
  installHelp: $('#install-help'),
  aboutReadme: $('#about-pleronic-content'),
  toast: $('#toast'),
  owner: $('#gh-owner'),
  repo: $('#gh-repo'),
  branch: $('#gh-branch'),
  folder: $('#gh-folder'),
  token: $('#gh-token'),
  settingsPrompt: $('#settings-setup-prompt'),
  vaultName: $('#vault-name'),
  vaultBranch: $('#vault-branch')
};

let config = loadConfig();
let directoryEntries = [];
let currentDirectory = '';
let readerParentPath = '';
let selectedSaveFolder = config ? config.folder : 'inbox';
let vaultDirectories = null;
let vaultDirectoriesKey = '';
let vaultIndexPromise = null;
let vaultIndexPromiseKey = '';
let vaultIndexGeneration = 0;
let recentNotes = [];
let vaultSearchResults = null;
let vaultSearchRun = 0;
let vaultSearchInProgress = false;
let markdownPathIndex = null;
let markdownPathIndexKey = '';
let vaultImagePaths = null;
let vaultImagePathsKey = '';
let attachmentImageUrls = new Set();
let attachmentLoadRun = 0;
let imageViewerUrl = null;
let imageViewerRequest = 0;
let currentView = 'capture';
let currentNote = null;
let editDraftTimer;
let editSaveInProgress = false;
let activeCaptureDraftId = null;
let draftExitPromise = null;
let deferredInstallPrompt = null;
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

function runUiAction(label, action) {
  // Event handlers use this boundary so async failures are logged and shown instead of becoming unhandled rejections.
  void (async () => {
    try {
      await action();
    } catch (error) {
      console.error(label, error);
      showToast(`${label} ${error.message}`);
    }
  })();
}

function setConnection(state, label) {
  elements.connection.dataset.state = state;
  elements.connectionLabel.textContent = label;
}

function updateOnlineControls() {
  const offline = !navigator.onLine;
  elements.syncButton.disabled = syncInProgress || offline;
  elements.vaultSearchButton.disabled = offline || vaultSearchInProgress;
  elements.refreshInboxButton.disabled = offline;
  $('#test-connection').disabled = offline;
  elements.saveEditButton.disabled = editSaveInProgress || Boolean(currentNote?.conflict) || offline;
  elements.syncButton.title = offline ? 'Connect to the internet to sync queued notes.' : '';
  elements.vaultSearchButton.title = offline ? 'Connect to the internet to search the vault.' : '';
  elements.refreshInboxButton.title = offline ? 'Connect to the internet to refresh the vault.' : '';
  $('#test-connection').title = offline ? 'Connect to the internet to test GitHub credentials.' : '';
}

async function promptForGitHubSetup(message) {
  elements.settingsPrompt.textContent = message;
  elements.settingsPrompt.hidden = false;
  if (await switchView('settings')) elements.owner.focus();
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
  updateOnlineControls();
}

function updateVaultCard() {
  elements.vaultName.textContent = config ? `${config.owner}/${config.repo}` : 'Not configured';
  elements.vaultName.title = elements.vaultName.textContent;
  elements.vaultBranch.textContent = config ? `${config.branch} · ${config.folder || 'repository root'}` : 'Connect a GitHub repository';
}

function resetVaultNavigation() {
  currentDirectory = '';
  directoryEntries = [];
  invalidateMarkdownPathIndex();
  selectedSaveFolder = config ? config.folder : 'inbox';
  updateSaveFolderLabel();
  elements.saveFolderMenu.hidden = true;
  elements.saveFolderToggle.setAttribute('aria-expanded', 'false');
  clearVaultSearch();
  void refreshRecentNotes();
}

function clientFromConfig(savedConfig = config) {
  if (!savedConfig) throw new Error('Connect a GitHub repository in Settings before syncing.');
  return new GitHubClient(savedConfig);
}

function vaultIdentity(savedConfig = config) {
  return savedConfig ? `${savedConfig.owner}/${savedConfig.repo}@${savedConfig.branch}` : '';
}

function editDraftKey(path, identity = vaultIdentity()) {
  return `edit_draft:${identity}:${path}`;
}

function updateEditControls() {
  const canEdit = Boolean(currentNote?.sha && currentNote.identity === vaultIdentity());
  elements.readerActions.hidden = !currentNote;
  elements.editButton.hidden = !canEdit || currentNote.editing || Boolean(currentNote.conflict);
  elements.editButton.textContent = currentNote?.draftContent !== null && currentNote?.draftContent !== undefined
    ? 'Continue draft'
    : 'Edit note';
  elements.cancelEditButton.hidden = !currentNote?.editing;
  elements.saveEditDraftButton.hidden = !currentNote?.editing;
  elements.saveEditDraftButton.disabled = editSaveInProgress;
  elements.saveEditButton.hidden = !currentNote?.editing;
  elements.saveEditButton.disabled = editSaveInProgress || Boolean(currentNote?.conflict) || !navigator.onLine;
  elements.noteEditor.classList.toggle('active', Boolean(currentNote?.editing));
  elements.readerContent.hidden = Boolean(currentNote?.editing);
  elements.editConflict.hidden = !currentNote?.conflict;
  if (currentNote) {
    const draftIsUnsynced = currentNote.draftContent !== null
      && currentNote.draftContent !== undefined
      && currentNote.draftContent !== currentNote.content;
    elements.readerMeta.textContent = `${currentNote.path}${draftIsUnsynced ? ' · Local draft' : ''}${currentNote.offline ? ' · Offline copy' : ''}`;
  }
}

async function persistEditDraft() {
  if (!currentNote?.editing || !currentNote.sha) return;
  const draft = {
    content: elements.editContent.value,
    baseSha: currentNote.sha,
    updatedAt: new Date().toISOString()
  };
  try {
    await set(editDraftKey(currentNote.path, currentNote.identity), draft);
    currentNote.draftContent = draft.content;
    elements.editStatus.textContent = 'Local draft saved on this device. It has not been sent to GitHub.';
    updateEditControls();
    return true;
  } catch (error) {
    console.error('Could not save the local edit draft:', error);
    elements.editStatus.textContent = `Local draft could not be saved: ${error.message}`;
    showToast(`Your edit could not be saved locally: ${error.message}`);
    return false;
  }
}

async function saveEditDraftAndLeave() {
  if (!currentNote?.editing || editSaveInProgress) return;
  clearTimeout(editDraftTimer);
  if (!await persistEditDraft()) return;
  currentNote.editing = false;
  updateEditControls();
  currentDirectory = readerParentPath;
  elements.myDraftsList.hidden = true;
  elements.showMyDrafts.setAttribute('aria-expanded', 'false');
  elements.search.value = '';
  clearVaultSearch();
  await switchView('inbox', true);
  showToast('Draft saved on this device.');
}

function scheduleEditDraftSave() {
  clearTimeout(editDraftTimer);
  elements.editStatus.textContent = 'Saving local draft…';
  editDraftTimer = setTimeout(() => void persistEditDraft(), 250);
}

function askDraftExitChoice() {
  if (draftExitPromise) return draftExitPromise;
  draftExitPromise = new Promise((resolve) => {
    const finish = (choice) => {
      elements.draftExitDialog.close();
      resolve(choice);
    };
    $('#save-edit-draft').onclick = () => finish('save');
    $('#discard-edit-draft').onclick = () => finish('discard');
    $('#stay-in-editor').onclick = () => finish('stay');
    elements.draftExitDialog.oncancel = (event) => {
      event.preventDefault();
      finish('stay');
    };
    elements.draftExitDialog.onclose = () => {
      elements.draftExitDialog.oncancel = null;
      elements.draftExitDialog.onclose = null;
      draftExitPromise = null;
    };
    elements.draftExitDialog.showModal();
  });
  return draftExitPromise;
}

async function discardCurrentEditDraft() {
  if (!currentNote) return false;
  const remote = currentNote.conflict;
  try {
    if (remote) await set(`note_cache:${currentNote.path}`, remote.content);
    await del(editDraftKey(currentNote.path, currentNote.identity));
  } catch (error) {
    console.error('Could not discard the local edit draft:', error);
    showToast(`The local edit draft could not be discarded: ${error.message}`);
    return false;
  }
  if (remote) {
    currentNote.content = remote.content;
    currentNote.sha = remote.sha;
    currentNote.offline = false;
  }
  currentNote.editing = false;
  currentNote.conflict = null;
  currentNote.draftContent = null;
  elements.editContent.value = currentNote.content;
  elements.editStatus.textContent = '';
  updateEditControls();
  if (currentView === 'reader') await renderVaultNote(currentNote.content, currentNote.path);
  return true;
}

async function prepareToLeaveEditor() {
  if (!currentNote?.editing) return true;
  const savedDraftContent = currentNote.draftContent ?? currentNote.content;
  // A previously persisted draft is safe to leave; only edits made since that save need a decision.
  if (elements.editContent.value === savedDraftContent) {
    currentNote.editing = false;
    updateEditControls();
    return true;
  }

  clearTimeout(editDraftTimer);
  const choice = await askDraftExitChoice();
  if (choice === 'stay') {
    elements.editStatus.textContent = 'Edits are not saved as a local draft yet.';
    return false;
  }
  if (choice === 'discard') return discardCurrentEditDraft();
  if (!await persistEditDraft()) return false;
  currentNote.editing = false;
  updateEditControls();
  return true;
}

async function showEditConflict(remote) {
  currentNote.conflict = remote;
  elements.remoteNoteContent.textContent = remote.content;
  elements.editStatus.textContent = 'GitHub has a newer version. Your draft is preserved locally.';
  updateEditControls();
  await persistEditDraft();
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
      if (!src.startsWith('vault-attachment:')) {
        safeElement.addEventListener('error', () => {
          if (safeElement.isConnected) showAttachmentError(safeElement);
        }, { once: true });
      }
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
  styleInlineTags(target);
  const headingCounts = new Map();
  for (const heading of target.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    const base = headingSlug(heading.textContent);
    const count = headingCounts.get(base) || 0;
    headingCounts.set(base, count + 1);
    heading.id = count ? `${base}-${count}` : base;
  }
}

async function loadAboutReadme() {
  try {
    const response = await window.fetch('./README.md');
    if (!response.ok) throw new Error(`README request failed with HTTP ${response.status}.`);
    const markdown = await response.text();
    updatePreview(markdown, elements.aboutReadme);
  } catch (error) {
    console.error('Could not load the Pleronic README:', error);
    elements.aboutReadme.textContent = `About information could not be loaded: ${error.message}`;
  }
}

function styleInlineTags(target) {
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.parentElement?.closest('a, code, pre')) textNodes.push(node);
  }

  const tagPattern = /(^|\s)#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)(?![\p{L}\p{N}_/-])/gu;
  for (const node of textNodes) {
    const text = node.textContent || '';
    tagPattern.lastIndex = 0;
    if (!tagPattern.test(text)) continue;
    tagPattern.lastIndex = 0;
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    for (const match of text.matchAll(tagPattern)) {
      const tagStart = match.index + match[1].length;
      fragment.append(document.createTextNode(text.slice(lastIndex, tagStart)));
      const tag = document.createElement('span');
      tag.className = 'obsidian-tag';
      tag.textContent = `#${match[2]}`;
      fragment.append(tag);
      lastIndex = tagStart + match[0].length - match[1].length;
    }
    fragment.append(document.createTextNode(text.slice(lastIndex)));
    node.replaceWith(fragment);
  }
}

function safeUrl(value, image) {
  if (!value) return null;
  if (!image && value.startsWith('vault:')) return value;
  if (image && value.startsWith('vault-attachment:')) return value;
  try {
    const url = new URL(value, location.href);
    const allowed = image ? ['https:', 'http:'] : ['https:', 'http:', 'mailto:'];
    return allowed.includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function switchView(view, draftAlreadyHandled = false) {
  if (view === 'inbox' && !config) {
    if (!draftAlreadyHandled && !await prepareToLeaveEditor()) return false;
    elements.settingsPrompt.textContent = 'Enter your GitHub owner, repository, and fine-grained token below, then save settings. Use “Test connection” to verify access. Local capture and drafts remain available without connecting.';
    elements.settingsPrompt.hidden = false;
    return switchView('settings', true);
  }
  if (!draftAlreadyHandled && view !== currentView && !await prepareToLeaveEditor()) return false;
  currentView = view;
  $$('.view').forEach((section) => section.classList.toggle('active', section.id === `view-${view}`));
  $$('[data-view]').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  if (view === 'inbox') {
    fetchInbox();
  }
  if (view === 'drafts') runUiAction('Could not load your drafts.', loadMyDrafts);
  return true;
}

function formatNoteTitle(name) {
  return name.replace(/\.md$/i, '').replace(/^\d{8}-\d{6}-(?:\d{3}-)?/, '').replace(/[-_]+/g, ' ');
}

function recentNotesStorageKey() {
  if (!config) return null;
  return `${RECENT_NOTES_KEY}:${config.owner}/${config.repo}@${config.branch}`;
}

function formatRecentTime(viewedAt) {
  const timestamp = Date.parse(viewedAt);
  if (!Number.isFinite(timestamp)) return '';
  const elapsedSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (elapsedSeconds < 60) return 'just now';
  const relativeTime = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (elapsedSeconds < 3600) return relativeTime.format(-Math.floor(elapsedSeconds / 60), 'minute');
  if (elapsedSeconds < 86_400) return relativeTime.format(-Math.floor(elapsedSeconds / 3600), 'hour');
  return relativeTime.format(-Math.floor(elapsedSeconds / 86_400), 'day');
}

function renderRecentNotes() {
  elements.recentNoteList.replaceChildren();
  if (recentNotes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'vault-search-help';
    empty.textContent = config ? 'Notes you open will appear here on this device.' : 'Connect a vault to keep track of recently viewed notes.';
    elements.recentNoteList.append(empty);
    return;
  }

  for (const note of recentNotes.slice(0, RECENT_NOTES_LIMIT)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-card recent-note-card';
    button.dataset.notePath = note.path;
    const icon = document.createElement('span');
    icon.className = 'note-file';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '▤';
    const info = document.createElement('span');
    info.className = 'note-info';
    const title = document.createElement('span');
    title.className = 'note-name';
    title.textContent = formatNoteTitle(note.name);
    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = note.path;
    info.append(title, meta);
    const viewedAt = document.createElement('span');
    viewedAt.className = 'recent-when';
    viewedAt.textContent = formatRecentTime(note.viewedAt);
    button.append(icon, info, viewedAt);
    elements.recentNoteList.append(button);
  }
}

async function recordRecentNote(note) {
  const key = recentNotesStorageKey();
  if (!key) return;
  const viewed = {
    name: note.name,
    path: note.path,
    viewedAt: new Date().toISOString()
  };
  recentNotes = [viewed, ...recentNotes.filter((entry) => entry.path !== note.path)].slice(0, RECENT_NOTES_LIMIT);
  renderRecentNotes();
  try {
    await set(key, recentNotes);
  } catch (error) {
    console.error('Could not save recently viewed notes:', error);
    showToast(`Note opened, but recent history could not be saved: ${error.message}`);
  }
}

async function loadRecentNotes() {
  const key = recentNotesStorageKey();
  const storedNotes = key ? await get(key) ?? [] : [];
  if (key !== recentNotesStorageKey()) return;
  recentNotes = storedNotes;
  if (!Array.isArray(recentNotes) || recentNotes.some((note) =>
    !note || typeof note.name !== 'string' || typeof note.path !== 'string' || typeof note.viewedAt !== 'string'
  )) {
    throw new Error('The saved recently viewed notes are invalid.');
  }
  renderRecentNotes();
}

async function refreshRecentNotes() {
  try {
    await loadRecentNotes();
  } catch (error) {
    console.error('Could not load recently viewed notes:', error);
    showToast(`Could not load recent notes: ${error.message}`);
  }
}

async function loadMyDrafts() {
  const identity = vaultIdentity();
  const storedKeys = await keys();
  // New-note captures are vault-independent; existing-note edits belong to the configured vault and branch.
  const editPrefix = identity ? `edit_draft:${identity}:` : null;
  const draftKeys = storedKeys.filter((key) => typeof key === 'string'
    && (key.startsWith(CAPTURE_DRAFT_PREFIX) || (editPrefix && key.startsWith(editPrefix))));
  const drafts = await getMany(draftKeys);
  if (identity !== vaultIdentity()) return;

  const entries = draftKeys.flatMap((key, index) => {
    const draft = drafts[index];
    if (!draft || typeof draft.content !== 'string' || typeof draft.updatedAt !== 'string') return [];
    if (key.startsWith(CAPTURE_DRAFT_PREFIX)) {
      const id = key.slice(CAPTURE_DRAFT_PREFIX.length);
      if (!id || typeof draft.title !== 'string') return [];
      return [{ kind: 'capture', id, draft }];
    }
    const path = key.slice(editPrefix.length);
    if (!path || typeof draft.baseSha !== 'string') return [];
    return [{ kind: 'edit', path, draft }];
  }).sort((left, right) => Date.parse(right.draft.updatedAt) - Date.parse(left.draft.updatedAt));

  elements.myDraftsList.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'vault-search-help';
    empty.textContent = 'No saved drafts on this device.';
    elements.myDraftsList.append(empty);
  } else {
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'note-card recent-note-card';
      const titleText = entry.kind === 'capture'
        ? entry.draft.title || 'Untitled note'
        : formatNoteTitle(entry.path.split('/').at(-1));
      button.dataset.draftKind = entry.kind;
      if (entry.kind === 'capture') button.dataset.captureDraftId = entry.id;
      else button.dataset.draftPath = entry.path;
      const info = document.createElement('span');
      info.className = 'note-info';
      const title = document.createElement('span');
      title.className = 'note-name';
      title.textContent = titleText;
      const meta = document.createElement('span');
      meta.className = 'note-meta';
      meta.textContent = entry.kind === 'capture'
        ? `New note${entry.draft.folder ? ` · ${entry.draft.folder}` : ''}`
        : entry.path;
      info.append(title, meta);
      const savedAt = document.createElement('span');
      savedAt.className = 'recent-when';
      const timestamp = Date.parse(entry.draft.updatedAt);
      savedAt.textContent = Number.isFinite(timestamp) ? formatRecentTime(entry.draft.updatedAt) : 'Saved locally';
      button.append(info, savedAt);
      elements.myDraftsList.append(button);
    }
  }
}

function renderInbox() {
  const query = elements.search.value.trim().toLocaleLowerCase();
  const entries = vaultSearchResults === null
    ? directoryEntries.filter((entry) => entry.name.toLocaleLowerCase().includes(query))
    : vaultSearchResults;
  elements.noteList.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const heading = document.createElement('strong');
    heading.textContent = !navigator.onLine
      ? 'Folder contents are unavailable offline.'
      : vaultSearchResults !== null
      ? 'No notes matched your search.'
      : query ? 'No folders or notes match that filter.' : 'This folder is empty.';
    const detail = document.createElement('span');
    detail.textContent = !navigator.onLine
      ? 'Reconnect to GitHub to load this folder. Your local drafts and queued notes are still available.'
      : vaultSearchResults !== null
      ? 'Try another search term.'
      : query ? 'Try another name.' : currentDirectory ? 'Try another folder or go back up a level.' : 'Capture a thought and it will land here.';
    empty.append(heading, detail);
    elements.noteList.append(empty);
    return;
  }

  for (const entry of entries) {
    const imageEntry = entry.type === 'file' && isImagePath(entry.path);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'note-card';
    if (!navigator.onLine && (entry.type === 'dir' || imageEntry)) {
      button.disabled = true;
      button.title = 'Reconnect to GitHub to browse folders or load images.';
    }
    if (entry.type === 'dir') button.dataset.directoryPath = entry.path;
    else if (imageEntry) button.dataset.imagePath = entry.path;
    else button.dataset.notePath = entry.path;
    const icon = document.createElement('span');
    icon.className = 'note-file';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = entry.type === 'dir' ? '▱' : imageEntry ? '▧' : '▤';
    const info = document.createElement('span');
    info.className = 'note-info';
    const title = document.createElement('span');
    title.className = 'note-name';
    title.textContent = entry.type === 'dir' ? entry.name : imageEntry ? entry.name : formatNoteTitle(entry.name);
    const meta = document.createElement('span');
    meta.className = 'note-meta';
    meta.textContent = entry.type === 'dir'
      ? `Folder · ${entry.path}`
      : imageEntry ? `Image · ${entry.path}` : entry.path;
    info.append(title, meta);
    if (entry.snippet) {
      const snippet = document.createElement('span');
      snippet.className = 'search-snippet';
      snippet.textContent = entry.snippet;
      info.append(snippet);
    }
    const kind = document.createElement('span');
    kind.className = 'note-kind';
    kind.textContent = entry.type === 'dir' ? 'FOLDER' : imageEntry ? 'IMAGE' : 'NOTE';
    const arrow = document.createElement('span');
    arrow.className = 'note-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    button.append(icon, info, kind, arrow);
    elements.noteList.append(button);
  }
}

function clearVaultSearch() {
  vaultSearchRun += 1;
  vaultSearchInProgress = false;
  vaultSearchResults = null;
  elements.vaultSearchInput.value = '';
  elements.vaultSearchStatus.textContent = '';
  updateOnlineControls();
}

async function searchVault(event) {
  event.preventDefault();
  if (!navigator.onLine) {
    showToast('You’re offline. Reconnect to search your GitHub vault.');
    return;
  }
  if (!config) {
    await promptForGitHubSetup('Connect a GitHub vault before searching. Enter the owner, repository, and a fine-grained token below.');
    return;
  }
  const query = elements.vaultSearchInput.value.trim();
  if (!query) {
    elements.vaultSearchStatus.textContent = 'Enter a word or phrase to search for.';
    return;
  }

  const run = ++vaultSearchRun;
  vaultSearchInProgress = true;
  updateOnlineControls();
  vaultSearchResults = [];
  elements.directoryHeading.textContent = 'Vault search results';
  elements.noteList.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.textContent = 'Preparing a whole-vault search…';
  elements.noteList.append(loading);
  try {
    const paths = await getMarkdownPaths();
    if (run !== vaultSearchRun) return;
    const matches = await clientFromConfig().searchNotes(query, paths, (completed, total) => {
      if (run === vaultSearchRun) elements.vaultSearchStatus.textContent = `Searching ${completed} of ${total} Markdown notes…`;
    });
    if (run !== vaultSearchRun) return;
    vaultSearchResults = matches.map((match) => ({
      type: 'file',
      name: match.path.split('/').at(-1),
      path: match.path,
      snippet: match.snippet
    }));
    elements.vaultSearchStatus.textContent = `Found ${matches.length} matching ${matches.length === 1 ? 'note' : 'notes'} across ${paths.length} Markdown files.`;
    renderInbox();
  } catch (error) {
    if (run !== vaultSearchRun) return;
    console.error('Could not search the vault:', error);
    elements.vaultSearchStatus.textContent = `Search failed: ${error.message}`;
    const failure = document.createElement('div');
    failure.className = 'empty-state';
    failure.textContent = 'Could not search the vault. Check your GitHub connection and access.';
    elements.noteList.replaceChildren(failure);
  } finally {
    if (run === vaultSearchRun) {
      vaultSearchInProgress = false;
      updateOnlineControls();
    }
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

  elements.inboxDescription.textContent = `${config.owner}/${config.repo} · browse and edit`;
  if (!navigator.onLine) {
    elements.inboxDescription.textContent = `${config.owner}/${config.repo} · offline`;
    elements.directoryHeading.textContent = currentDirectory.split('/').at(-1) || 'Vault root';
    renderBreadcrumbs();
    renderInbox();
    return;
  }
  elements.noteList.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'empty-state';
  loading.textContent = 'Opening your vault…';
  elements.noteList.append(loading);
  try {
    directoryEntries = await clientFromConfig().listDirectory(currentDirectory);
    elements.directoryHeading.textContent = vaultSearchResults !== null
      ? 'Vault search results'
      : currentDirectory.split('/').at(-1) || 'Vault root';
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
  root.disabled = !navigator.onLine;
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
    crumb.disabled = !navigator.onLine;
    elements.breadcrumbs.append(crumb);
  });
}

function vaultIndexKey() {
  return config ? `${config.owner}/${config.repo}@${config.branch}` : '';
}

function invalidateMarkdownPathIndex() {
  vaultIndexGeneration += 1;
  markdownPathIndex = null;
  markdownPathIndexKey = '';
  vaultImagePaths = null;
  vaultImagePathsKey = '';
  vaultDirectories = null;
  vaultDirectoriesKey = '';
  vaultIndexPromise = null;
  vaultIndexPromiseKey = '';
}

async function getVaultIndex() {
  const key = vaultIndexKey();
  const generation = vaultIndexGeneration;
  if (markdownPathIndex && key === markdownPathIndexKey && vaultImagePaths && key === vaultImagePathsKey && vaultDirectories && key === vaultDirectoriesKey) {
    return { markdownPaths: markdownPathIndex, imagePaths: vaultImagePaths, directories: vaultDirectories };
  }
  if (vaultIndexPromise && key === vaultIndexPromiseKey) return vaultIndexPromise;

  const request = clientFromConfig().listVaultIndex();
  vaultIndexPromise = request;
  vaultIndexPromiseKey = key;
  try {
    const index = await request;
    if (generation !== vaultIndexGeneration || key !== vaultIndexKey()) return getVaultIndex();
    markdownPathIndex = index.markdownPaths;
    markdownPathIndexKey = key;
    vaultImagePaths = index.imagePaths;
    vaultImagePathsKey = key;
    vaultDirectories = index.directories;
    vaultDirectoriesKey = key;
    return index;
  } finally {
    if (vaultIndexPromise === request) {
      vaultIndexPromise = null;
      vaultIndexPromiseKey = '';
    }
  }
}

async function getMarkdownPaths() {
  return (await getVaultIndex()).markdownPaths;
}

async function getImagePaths() {
  return (await getVaultIndex()).imagePaths;
}

function saveFolderDisplay(path) {
  return path || 'Vault root';
}

function saveFolderChoices(directories = []) {
  const choices = new Set(['', ...directories, selectedSaveFolder]);
  const defaultFolder = config ? config.folder : 'inbox';
  let parent = '';
  for (const part of defaultFolder.split('/').filter(Boolean)) {
    parent = parent ? `${parent}/${part}` : part;
    choices.add(parent);
  }
  return [...choices].sort((left, right) => {
    if (!left) return -1;
    if (!right) return 1;
    return left.localeCompare(right, undefined, { sensitivity: 'base' });
  });
}

function updateSaveFolderLabel() {
  elements.saveFolderLabel.textContent = `Saving to ${saveFolderDisplay(selectedSaveFolder)}`;
}

function renderSaveFolderOptions() {
  const query = elements.saveFolderSearch.value.trim().toLocaleLowerCase();
  const choices = saveFolderChoices(vaultDirectories || [])
    .filter((path) => path.toLocaleLowerCase().includes(query));
  elements.saveFolderOptions.replaceChildren();

  if (choices.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'save-folder-empty';
    empty.textContent = 'No folders match that search.';
    elements.saveFolderOptions.append(empty);
    return;
  }
  for (const path of choices) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'save-folder-option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(path === selectedSaveFolder));
    option.dataset.saveFolder = path;
    option.textContent = saveFolderDisplay(path);
    elements.saveFolderOptions.append(option);
  }
}

async function openSaveFolderMenu() {
  const opening = elements.saveFolderMenu.hidden;
  elements.saveFolderMenu.hidden = !opening;
  elements.saveFolderToggle.setAttribute('aria-expanded', String(opening));
  if (!opening) return;

  elements.saveFolderSearch.value = '';
  renderSaveFolderOptions();
  if (!config) {
    elements.saveFolderStatus.textContent = `Connect a vault to load its folders. Your selected destination, ${saveFolderDisplay(selectedSaveFolder)}, will be used when you save.`;
    elements.saveFolderSearch.focus();
    return;
  }
  if (!navigator.onLine) {
    elements.saveFolderStatus.textContent = 'Offline: choose from folders already available, or enter a destination when you reconnect.';
    elements.saveFolderSearch.focus();
    return;
  }

  const selectedConfigKey = vaultIndexKey();
  elements.saveFolderStatus.textContent = 'Loading vault folders…';
  elements.saveFolderSearch.focus();
  try {
    const index = await getVaultIndex();
    if (elements.saveFolderMenu.hidden || selectedConfigKey !== vaultIndexKey()) return;
    vaultDirectories = index.directories;
    vaultDirectoriesKey = selectedConfigKey;
    elements.saveFolderStatus.textContent = 'Choose a folder. The configured default is available even if it does not exist yet.';
    renderSaveFolderOptions();
  } catch (error) {
    if (elements.saveFolderMenu.hidden || selectedConfigKey !== vaultIndexKey()) return;
    console.error('Could not load folders for note destination:', error);
    elements.saveFolderStatus.textContent = `Could not load vault folders: ${error.message}. Your current destination remains available.`;
    renderSaveFolderOptions();
  }
}

async function storeDraft() {
  try {
    const content = elements.content.value;
    const title = elements.title.value;
    if (activeCaptureDraftId && (content || title)) {
      await set(`${CAPTURE_DRAFT_PREFIX}${activeCaptureDraftId}`, {
        title,
        content,
        folder: selectedSaveFolder,
        updatedAt: new Date().toISOString()
      });
    }
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

async function saveCaptureDraft() {
  const content = elements.content.value.trim();
  const title = elements.title.value.trim();
  if (!content && !title) {
    showToast('Add a title or some note text before saving a draft.');
    elements.content.focus();
    return;
  }

  // Explicitly saving promotes the temporary capture buffer to a persistent entry in the Drafts list.
  const id = activeCaptureDraftId || crypto.randomUUID();
  const key = `${CAPTURE_DRAFT_PREFIX}${id}`;
  elements.saveCaptureDraftButton.disabled = true;
  try {
    await set(key, {
      title,
      content: elements.content.value,
      folder: selectedSaveFolder,
      updatedAt: new Date().toISOString()
    });
    activeCaptureDraftId = null;
    elements.title.value = '';
    elements.content.value = '';
    clearTimeout(draftTimer);
    let captureCleanupError = null;
    try {
      await del(DRAFT_KEY);
    } catch (error) {
      console.error('Saved the capture draft, but could not clear the temporary capture:', error);
      captureCleanupError = error;
    }
    elements.draftStatus.textContent = 'Saved as a draft on this device';
    updatePreview('', elements.preview);
    showToast(captureCleanupError
      ? `Draft saved, but the temporary capture could not be cleared: ${captureCleanupError.message}`
      : 'Draft saved on this device.');
  } catch (error) {
    console.error('Could not save the capture draft:', error);
    showToast(`Could not save the draft: ${error.message}`);
  } finally {
    elements.saveCaptureDraftButton.disabled = false;
  }
}

async function openCaptureDraft(id) {
  const draft = await get(`${CAPTURE_DRAFT_PREFIX}${id}`);
  if (!draft || typeof draft.title !== 'string' || typeof draft.content !== 'string') {
    throw new Error('This saved capture draft is missing or invalid.');
  }
  activeCaptureDraftId = id;
  elements.title.value = draft.title;
  elements.content.value = draft.content;
  if (typeof draft.folder === 'string') {
    selectedSaveFolder = draft.folder;
    updateSaveFolderLabel();
  }
  elements.draftStatus.textContent = draft.updatedAt
    ? `Draft saved ${new Date(draft.updatedAt).toLocaleString()}`
    : 'Saved as a draft on this device';
  updatePreview(elements.content.value, elements.preview);
  await switchView('capture');
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
    folder: selectedSaveFolder,
    destination: config ? {
      owner: config.owner,
      repo: config.repo,
      branch: config.branch,
      folder: selectedSaveFolder
    } : null
  };
  if (navigator.onLine && !config) {
    await promptForGitHubSetup('Connect a GitHub vault before saving this note online. Your note remains in the capture editor while you set up access.');
    return;
  }
  elements.saveButton.disabled = true;
  elements.saveCaptureDraftButton.disabled = true;
  elements.saveFolderToggle.disabled = true;
  elements.saveButton.textContent = 'Saving…';
  try {
    if (!navigator.onLine || !config) {
      await enqueueNote(note);
      const draftRemoved = await removeActiveCaptureDraft();
      const message = config
        ? 'Saved on this device. It will sync when you’re back online.'
        : 'Saved on this device. Connect a vault to sync it.';
      showToast(draftRemoved ? message : `${message} The original draft remains in Drafts.`);
      clearEditor();
      return;
    }
    await clientFromConfig().createNote(repositoryPath(note), note.content, note.title);
    invalidateMarkdownPathIndex();
    const draftRemoved = await removeActiveCaptureDraft();
    showToast(draftRemoved
      ? 'Note saved to your vault.'
      : 'Note saved to your vault, but the local draft remains in Drafts.');
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
        const draftRemoved = await removeActiveCaptureDraft();
        clearEditor();
        if (!draftRemoved) showToast('The note was already saved, but the local draft remains in Drafts.');
        return;
      } catch (lookupError) {
        if (!(lookupError instanceof GitHubApiError) || lookupError.status !== 404) {
          console.error('Could not check whether the note already exists:', lookupError);
        }
      }
    }
    try {
      await enqueueNote(note);
      const draftRemoved = await removeActiveCaptureDraft();
      const draftWarning = draftRemoved ? '' : ' The original draft remains in Drafts.';
      showToast(`Saved on this device; GitHub could not save it: ${error.message}${draftWarning}`);
      clearEditor();
      setConnection('error', 'Note waiting to sync');
    } catch (queueError) {
      console.error('Could not queue the note locally:', queueError);
      showToast(`GitHub could not save the note, and local storage failed: ${queueError.message}`);
    }
  } finally {
    elements.saveButton.disabled = false;
    elements.saveCaptureDraftButton.disabled = false;
    elements.saveFolderToggle.disabled = false;
    elements.saveButton.innerHTML = 'Save to vault <span aria-hidden="true">↗</span>';
  }
}

async function removeActiveCaptureDraft() {
  if (!activeCaptureDraftId) return true;
  const key = `${CAPTURE_DRAFT_PREFIX}${activeCaptureDraftId}`;
  try {
    await del(key);
    activeCaptureDraftId = null;
    return true;
  } catch (error) {
    console.error('The note was saved, but its capture draft could not be removed:', error);
    return false;
  }
}

function repositoryPath(note, destination = note.destination || config) {
  if (!destination) return `${note.relativePath}`;
  return [note.folder ?? destination.folder, note.relativePath].filter(Boolean).join('/');
}

async function enqueueNote(note) {
  const queue = await getQueue();
  queue.push(note);
  await set(QUEUE_KEY, queue);
  updateQueueStatus(queue);
}

function clearEditor() {
  activeCaptureDraftId = null;
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
    await promptForGitHubSetup('Connect a GitHub vault before syncing queued notes. They will remain safely stored on this device.');
    showToast('Queued notes are safe on this device until you connect a vault.');
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
  if (!config) {
    await promptForGitHubSetup('Connect a GitHub vault before opening notes.');
    return;
  }
  if (!await prepareToLeaveEditor()) return;
  readerParentPath = note.path.split('/').slice(0, -1).join('/');
  const parentName = readerParentPath.split('/').at(-1);
  const backLabel = parentName ? `Back to ${parentName}` : 'Back to vault';
  elements.readerBackLabel.textContent = backLabel;
  elements.readerBack.setAttribute('aria-label', backLabel);
  await switchView('reader', true);
  elements.readerTitle.textContent = formatNoteTitle(note.name);
  elements.readerMeta.textContent = note.path;
  elements.readerTags.replaceChildren();
  elements.readerTags.hidden = true;
  elements.readerFrontmatterContent.textContent = '';
  elements.readerFrontmatter.hidden = true;
  elements.readerContent.textContent = 'Loading note…';
  elements.readerContent.hidden = false;
  elements.editStatus.textContent = '';
  elements.editConflict.hidden = true;
  currentNote = {
    path: note.path,
    name: formatNoteTitle(note.name),
    content: '',
    draftContent: null,
    sha: null,
    identity: vaultIdentity(),
    offline: false,
    editing: false,
    conflict: null
  };
  elements.editContent.value = '';
  updateEditControls();
  const cacheKey = `note_cache:${note.path}`;
  try {
    const remote = await clientFromConfig().readNoteWithMetadata(note.path);
    currentNote.content = remote.content;
    currentNote.sha = remote.sha;
    elements.editContent.value = remote.content;
    await renderVaultNote(remote.content, note.path);
    void recordRecentNote(note);
    try {
      await set(cacheKey, remote.content);
    } catch (cacheError) {
      console.error('Could not cache the opened note:', cacheError);
      showToast(`Note opened, but its offline copy could not be saved: ${cacheError.message}`);
    }
    try {
      const draft = await get(editDraftKey(note.path, currentNote.identity));
      if (draft && typeof draft.content === 'string' && typeof draft.baseSha === 'string') {
        currentNote.draftContent = draft.content;
        elements.editContent.value = draft.content;
        if (draft.baseSha !== remote.sha) {
          currentNote.sha = draft.baseSha;
          currentNote.editing = true;
          await showEditConflict(remote);
        }
        else if (draft.content !== remote.content) elements.editStatus.textContent = `Local draft restored · ${new Date(draft.updatedAt).toLocaleString()}`;
        else {
          await del(editDraftKey(note.path, currentNote.identity));
          currentNote.draftContent = null;
        }
      }
    } catch (draftError) {
      console.error('Could not restore the local edit draft:', draftError);
      showToast(`Note opened, but its edit draft could not be restored: ${draftError.message}`);
    }
    updateEditControls();
  } catch (error) {
    console.error('Could not load the note from GitHub:', error);
    try {
      const cached = await get(cacheKey);
      if (typeof cached === 'string') {
        currentNote.content = cached;
        currentNote.offline = true;
        await renderVaultNote(cached, note.path);
        void recordRecentNote(note);
        elements.readerMeta.textContent = `${note.path} · Offline copy`;
        showToast('Showing the last saved copy of this note.');
        updateEditControls();
      } else {
        elements.readerContent.textContent = error.message;
        setConnection('error', 'Could not open this note');
      }
    } catch (cacheError) {
      console.error('Could not read the cached note:', cacheError);
      elements.readerContent.textContent = `${error.message} (Offline cache unavailable: ${cacheError.message})`;
    }
    elements.readerActions.hidden = true;
  }
  if (heading) {
    const target = elements.readerContent.querySelector(`#${CSS.escape(headingSlug(heading))}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function startEditingNote() {
  if (!currentNote?.sha || currentNote.identity !== vaultIdentity()) {
    showToast('Reconnect to the same vault before editing this note.');
    return;
  }
  elements.editContent.value = currentNote.draftContent ?? currentNote.content;
  currentNote.editing = true;
  elements.editStatus.textContent = '';
  updateEditControls();
  elements.editContent.focus();
}

async function cancelEditingNote() {
  if (!currentNote?.editing) return;
  if (elements.editContent.value !== currentNote.content || currentNote.conflict) {
    if (!confirm('Discard this local edit draft? This cannot be undone.')) return;
  }
  clearTimeout(editDraftTimer);
  await discardCurrentEditDraft();
}

async function saveEditedNote() {
  if (!currentNote?.editing || !currentNote.sha || currentNote.conflict || editSaveInProgress) return;
  if (!navigator.onLine) {
    showToast('You are offline. Your edit remains saved as a local draft on this device.');
    return;
  }
  if (currentNote.identity !== vaultIdentity()) {
    showToast('The connected vault changed. Reconnect to the original vault before saving this edit.');
    return;
  }
  if (!config) {
    await promptForGitHubSetup('Reconnect to your GitHub vault before saving this edit. Your local draft remains on this device.');
    return;
  }

  clearTimeout(editDraftTimer);
  if (!await persistEditDraft()) return;
  editSaveInProgress = true;
  updateEditControls();
  elements.editStatus.textContent = 'Saving to GitHub…';
  let result;
  try {
    result = await clientFromConfig().updateNote(
      currentNote.path,
      elements.editContent.value,
      currentNote.name,
      currentNote.sha
    );
  } catch (error) {
    console.error('Could not save the edited note:', error);
    if (error instanceof GitHubApiError && [409, 422].includes(error.status)) {
      try {
        const latest = await clientFromConfig().readNoteWithMetadata(currentNote.path);
        if (latest.sha !== currentNote.sha) {
          await showEditConflict(latest);
        } else {
          elements.editStatus.textContent = `GitHub rejected the update: ${error.message}`;
          showToast(`The note was not updated: ${error.message}`);
        }
      } catch (refreshError) {
        console.error('Could not load the latest note after an update conflict:', refreshError);
        elements.editStatus.textContent = `Could not verify the latest version. Your draft is saved locally: ${refreshError.message}`;
        showToast(`Could not verify the conflict; your local draft is preserved: ${refreshError.message}`);
      }
    } else {
      elements.editStatus.textContent = `Save failed. Your local draft is preserved: ${error.message}`;
      showToast(`The note was not confirmed as saved. Your local draft remains on this device: ${error.message}`);
    }
    editSaveInProgress = false;
    updateEditControls();
    return;
  }

  currentNote.content = elements.editContent.value;
  currentNote.draftContent = null;
  currentNote.sha = result.sha;
  currentNote.editing = false;
  currentNote.conflict = null;
  updateEditControls();
  let localCleanupError = null;
  try {
    await del(editDraftKey(currentNote.path, currentNote.identity));
    await set(`note_cache:${currentNote.path}`, currentNote.content);
  } catch (error) {
    console.error('The note was saved, but local cleanup failed:', error);
    localCleanupError = error;
  }
  try {
    await renderVaultNote(currentNote.content, currentNote.path);
  } catch (error) {
    console.error('The note was saved, but the updated preview could not be rendered:', error);
    elements.readerContent.textContent = currentNote.content;
  }
  editSaveInProgress = false;
  elements.editStatus.textContent = '';
  updateEditControls();
  showToast(localCleanupError
    ? `Note saved to GitHub, but local draft/cache cleanup failed: ${localCleanupError.message}`
    : 'Note updated in GitHub. The change is recorded in your repository history.');
}

async function acceptRemoteVersion() {
  if (!currentNote?.conflict) return;
  const remote = currentNote.conflict;
  const previousSha = currentNote.sha;
  currentNote.sha = remote.sha;
  currentNote.conflict = null;
  currentNote.editing = true;
  if (!await persistEditDraft()) {
    currentNote.sha = previousSha;
    currentNote.conflict = remote;
    updateEditControls();
    return;
  }
  elements.editStatus.textContent = 'Keeping your draft. Saving it will replace the newer remote text; cancel if you want to use GitHub’s version instead.';
  updateEditControls();
}

async function useRemoteVersion() {
  if (!currentNote?.conflict) return;
  const remote = currentNote.conflict;
  try {
    await set(`note_cache:${currentNote.path}`, remote.content);
    await del(editDraftKey(currentNote.path, currentNote.identity));
  } catch (error) {
    console.error('Could not replace the local draft with the remote note:', error);
    showToast(`Could not update the local copy: ${error.message}`);
    return;
  }
  currentNote.content = remote.content;
  currentNote.sha = remote.sha;
  currentNote.draftContent = null;
  currentNote.conflict = null;
  currentNote.editing = false;
  currentNote.offline = false;
  elements.editContent.value = remote.content;
  elements.editStatus.textContent = '';
  updateEditControls();
  await renderVaultNote(remote.content, currentNote.path);
}

function clearAttachmentImageUrls() {
  attachmentLoadRun += 1;
  for (const url of attachmentImageUrls) URL.revokeObjectURL(url);
  attachmentImageUrls.clear();
}

function showAttachmentError(image) {
  const message = document.createElement('span');
  message.className = 'attachment-error';
  message.setAttribute('role', 'status');
  message.textContent = "Attachment couldn't be loaded.";
  image.replaceWith(message);
}

async function loadEmbeddedImages(notePath) {
  const run = ++attachmentLoadRun;
  const images = [...elements.readerContent.querySelectorAll('img[src^="vault-attachment:"]')];
  let next = 0;
  const loadNext = async () => {
    while (next < images.length) {
      const image = images[next];
      next += 1;
      let path = '';
      let objectUrl = null;
      try {
        path = decodeURIComponent(image.getAttribute('src').slice('vault-attachment:'.length));
        const blob = await clientFromConfig().readImage(path);
        if (run !== attachmentLoadRun || currentNote?.path !== notePath) continue;
        objectUrl = URL.createObjectURL(blob);
        attachmentImageUrls.add(objectUrl);
        image.dataset.vaultPath = path;
        image.src = objectUrl;
        await image.decode();
        if (run !== attachmentLoadRun || currentNote?.path !== notePath) continue;
      } catch (error) {
        if (run !== attachmentLoadRun || currentNote?.path !== notePath) continue;
        console.error(`Could not load embedded image ${path || ''}:`, error);
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          attachmentImageUrls.delete(objectUrl);
        }
        if (image.isConnected) showAttachmentError(image);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, images.length) }, loadNext));
}

async function openVaultImage(path) {
  if (!navigator.onLine) {
    showToast('You’re offline. Reconnect to load images from GitHub.');
    return;
  }
  if (!config) {
    await promptForGitHubSetup('Connect a GitHub vault before opening attachments.');
    return;
  }
  const request = ++imageViewerRequest;
  if (imageViewerUrl) {
    URL.revokeObjectURL(imageViewerUrl);
    imageViewerUrl = null;
  }
  elements.imageViewerImage.removeAttribute('src');
  elements.imageViewerImage.hidden = false;
  elements.imageViewerError.hidden = true;
  elements.imageViewerTitle.textContent = 'Loading image…';
  elements.imageViewerPath.textContent = path;
  elements.imageViewer.showModal();
  try {
    const blob = await clientFromConfig().readImage(path);
    if (request !== imageViewerRequest || !elements.imageViewer.open) return;
    imageViewerUrl = URL.createObjectURL(blob);
    elements.imageViewerImage.src = imageViewerUrl;
    await elements.imageViewerImage.decode();
    if (request !== imageViewerRequest || !elements.imageViewer.open) return;
    elements.imageViewerTitle.textContent = path.split('/').at(-1);
  } catch (error) {
    if (request !== imageViewerRequest || !elements.imageViewer.open) return;
    console.error(`Could not open vault image ${path}:`, error);
    elements.imageViewerTitle.textContent = 'Could not load image';
    if (imageViewerUrl) URL.revokeObjectURL(imageViewerUrl);
    imageViewerUrl = null;
    elements.imageViewerImage.removeAttribute('src');
    elements.imageViewerImage.hidden = true;
    elements.imageViewerError.hidden = false;
  }
}

async function renderVaultNote(markdown, path) {
  clearAttachmentImageUrls();
  const note = extractObsidianFrontmatter(markdown);
  let linkedMarkdown = note.markdown;
  try {
    const [markdownPaths, imagePaths] = await Promise.all([getMarkdownPaths(), getImagePaths()]);
    if (currentNote?.path !== path) return;
    linkedMarkdown = resolveWikiLinks(note.markdown, path, markdownPaths);
    linkedMarkdown = resolveImageEmbeds(linkedMarkdown, path, imagePaths);
  } catch (error) {
    console.error('Could not build the vault link index:', error);
    showToast(`Note opened, but vault links or images could not be resolved: ${error.message}`);
  }
  if (currentNote?.path !== path) return;
  elements.readerFrontmatter.hidden = note.frontmatter === null;
  elements.readerFrontmatterContent.textContent = note.frontmatter || '';
  updatePreview(linkedMarkdown, elements.readerContent);
  await loadEmbeddedImages(path);
  if (currentNote?.path !== path) return;
  elements.readerTags.replaceChildren();
  for (const tagName of note.tags) {
    const tag = document.createElement('span');
    tag.className = 'obsidian-tag';
    tag.textContent = `#${tagName}`;
    elements.readerTags.append(tag);
  }
  elements.readerTags.hidden = note.tags.length === 0;
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
  runUiAction('Could not open that note.', () => openNote({ name, path: targetPath }, heading));
}

function populateSettingsForm() {
  elements.owner.value = config?.owner || '';
  elements.repo.value = config?.repo || '';
  elements.branch.value = config?.branch || 'main';
  elements.folder.value = config?.folder ?? 'inbox';
  elements.token.value = config?.token || '';
  updateSaveFolderLabel();
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
    elements.settingsPrompt.hidden = true;
    resetVaultNavigation();
    populateSettingsForm();
    setConnection(navigator.onLine ? 'online' : 'offline', navigator.onLine ? 'Settings saved' : 'Saved for when you’re online');
    showToast('Vault settings saved on this device.');
  } catch (error) {
    showToast(error.message);
  }
}

async function testConnection() {
  if (!navigator.onLine) {
    showToast('You’re offline. Reconnect to test your GitHub credentials.');
    return;
  }
  const button = $('#test-connection');
  button.disabled = true;
  button.textContent = 'Checking…';
  try {
    const candidate = readSettingsForm();
    const branch = await new GitHubClient(candidate).testConnection();
    localStorage.setItem(CONFIG_KEY, JSON.stringify(candidate));
    config = candidate;
    elements.settingsPrompt.hidden = true;
    resetVaultNavigation();
    populateSettingsForm();
    setConnection('online', `Connected · ${branch.name || candidate.branch}`);
    showToast(`Connected to ${candidate.owner}/${candidate.repo} on ${candidate.branch}.`);
  } catch (error) {
    console.error('GitHub connection test failed:', error);
    setConnection('error', error instanceof GitHubApiError && error.status === 401 ? 'Token was rejected' : 'Connection test failed');
    showToast(error.message);
  } finally {
    updateOnlineControls();
    button.textContent = 'Test connection';
  }
}

function disconnect() {
  if (!confirm('Remove the GitHub token and vault settings from this device? Queued notes stay here, but you’ll need to reconnect before they can sync.')) return;
  localStorage.removeItem(CONFIG_KEY);
  config = null;
  elements.settingsPrompt.textContent = 'Connect a GitHub vault to browse, search, or sync notes. Local drafts and queued notes remain available on this device.';
  elements.settingsPrompt.hidden = false;
  recentNotes = [];
  resetVaultNavigation();
  renderRecentNotes();
  populateSettingsForm();
  setConnection(navigator.onLine ? 'online' : 'offline', 'Not connected');
  updateOnlineControls();
  showToast('Vault disconnected. Notes already queued remain on this device.');
}

function isInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function updateInstallButton() {
  if (isInstalled()) {
    elements.installButton.hidden = true;
    elements.installHelp.textContent = 'Pleronic is installed on this device.';
    return;
  }
  elements.installButton.hidden = false;
  elements.installButton.textContent = deferredInstallPrompt ? 'Install app' : 'Install instructions';
}

async function installPleronic() {
  if (isInstalled()) {
    updateInstallButton();
    return;
  }
  if (!deferredInstallPrompt) {
    const isAppleMobile = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    elements.installHelp.textContent = isAppleMobile
      ? 'In Safari, tap Share, then choose “Add to Home Screen”.'
      : 'Open your browser menu and choose “Install app” or “Add to Home Screen”.';
    return;
  }

  elements.installButton.disabled = true;
  try {
    const prompt = deferredInstallPrompt;
    deferredInstallPrompt = null;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    elements.installHelp.textContent = outcome === 'accepted'
      ? 'Pleronic is being installed on this device.'
      : 'Installation was dismissed. You can try again from your browser menu.';
  } catch (error) {
    console.error('Could not open the Pleronic install prompt:', error);
    showToast(`Could not start installation: ${error.message}`);
  } finally {
    elements.installButton.disabled = false;
    updateInstallButton();
  }
}

async function initialize() {
  const date = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  $('#date-label').textContent = date.format(new Date());
  populateSettingsForm();
  updateInstallButton();
  setConnection(navigator.onLine ? 'online' : 'offline', config ? 'Connected to GitHub' : 'GitHub setup needed');
  updateOnlineControls();

  try {
    const [queue, draft] = await Promise.all([getQueue(), get(DRAFT_KEY)]);
    updateQueueStatus(queue);
    if (queue.length && navigator.onLine && config) runUiAction('Could not sync queued notes.', syncQueue);
    if (draft && typeof draft === 'object') {
      elements.title.value = typeof draft.title === 'string' ? draft.title : '';
      elements.content.value = typeof draft.content === 'string' ? draft.content : '';
      if (draft.updatedAt) elements.draftStatus.textContent = `Draft saved ${new Date(draft.updatedAt).toLocaleString()}`;
    }
  } catch (error) {
    console.error('Could not restore local notes:', error);
    showToast(`Could not restore local notes: ${error.message}`);
  }
  await refreshRecentNotes();

  updatePreview(elements.content.value, elements.preview);
  switchView('capture');
  void loadAboutReadme();
}

$$('[data-view]').forEach((button) => button.addEventListener('click', () => {
  runUiAction('Could not change views.', () => switchView(button.dataset.view));
}));
elements.readerBack.addEventListener('click', () => {
  runUiAction('Could not return to the vault.', async () => {
    if (!await prepareToLeaveEditor()) return;
    currentDirectory = readerParentPath;
    elements.search.value = '';
    clearVaultSearch();
    await switchView('inbox', true);
  });
});
elements.editButton.addEventListener('click', startEditingNote);
elements.saveEditDraftButton.addEventListener('click', () => runUiAction('Could not save the draft.', saveEditDraftAndLeave));
elements.cancelEditButton.addEventListener('click', () => runUiAction('Could not cancel editing.', cancelEditingNote));
elements.saveEditButton.addEventListener('click', () => runUiAction('Could not save the edit.', saveEditedNote));
$('#close-image-viewer').addEventListener('click', () => elements.imageViewer.close());
elements.imageViewer.addEventListener('close', () => {
  imageViewerRequest += 1;
  if (imageViewerUrl) URL.revokeObjectURL(imageViewerUrl);
  imageViewerUrl = null;
  elements.imageViewerImage.removeAttribute('src');
  elements.imageViewerImage.hidden = false;
  elements.imageViewerError.hidden = true;
});
elements.editContent.addEventListener('input', scheduleEditDraftSave);
elements.acceptRemoteVersionButton.addEventListener('click', () => runUiAction('Could not keep the local draft.', acceptRemoteVersion));
$('#use-remote-version').addEventListener('click', () => runUiAction('Could not use the remote note.', useRemoteVersion));
elements.copyLocalDraftButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(elements.editContent.value);
    showToast('Your local draft was copied to the clipboard.');
  } catch (error) {
    console.error('Could not copy the local edit draft:', error);
    showToast(`Could not copy your draft: ${error.message}`);
  }
});
elements.form.addEventListener('submit', (event) => runUiAction('Could not save the note.', () => saveNote(event)));
elements.saveCaptureDraftButton.addEventListener('click', () => runUiAction('Could not save the draft.', saveCaptureDraft));
elements.saveFolderToggle.addEventListener('click', () => runUiAction('Could not open the folder picker.', openSaveFolderMenu));
elements.saveFolderSearch.addEventListener('input', renderSaveFolderOptions);
elements.saveFolderOptions.addEventListener('click', (event) => {
  const option = event.target.closest('[data-save-folder]');
  if (!option) return;
  selectedSaveFolder = option.dataset.saveFolder;
  updateSaveFolderLabel();
  renderSaveFolderOptions();
  elements.saveFolderMenu.hidden = true;
  elements.saveFolderToggle.setAttribute('aria-expanded', 'false');
  elements.saveFolderToggle.focus();
});
document.addEventListener('pointerdown', (event) => {
  if (!elements.saveFolderMenu.hidden && !event.target.closest('.save-control')) {
    elements.saveFolderMenu.hidden = true;
    elements.saveFolderToggle.setAttribute('aria-expanded', 'false');
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !elements.saveFolderMenu.hidden) {
    elements.saveFolderMenu.hidden = true;
    elements.saveFolderToggle.setAttribute('aria-expanded', 'false');
    elements.saveFolderToggle.focus();
  }
});
elements.vaultSearchForm.addEventListener('submit', (event) => runUiAction('Could not search the vault.', () => searchVault(event)));
$('#settings-form').addEventListener('submit', (event) => runUiAction('Could not save settings.', () => saveSettings(event)));
elements.installButton.addEventListener('click', () => runUiAction('Could not install Pleronic.', installPleronic));
$('#github-token-help-button').addEventListener('click', () => $('#github-token-dialog').showModal());
$('#close-github-token-dialog').addEventListener('click', () => $('#github-token-dialog').close());
$('#test-connection').addEventListener('click', () => runUiAction('Could not test the GitHub connection.', testConnection));
$('#disconnect').addEventListener('click', disconnect);
elements.syncButton.addEventListener('click', () => runUiAction('Could not sync queued notes.', syncQueue));
$('#refresh-inbox').addEventListener('click', () => runUiAction('Could not refresh the vault.', fetchInbox));
elements.search.addEventListener('input', () => {
  clearVaultSearch();
  renderInbox();
});
elements.noteList.addEventListener('click', (event) => {
  const directory = event.target.closest('[data-directory-path]');
  if (directory) {
    currentDirectory = directory.dataset.directoryPath;
    elements.search.value = '';
    clearVaultSearch();
    runUiAction('Could not open that folder.', fetchInbox);
    return;
  }
  const image = event.target.closest('[data-image-path]');
  if (image) {
    runUiAction('Could not open that image.', () => openVaultImage(image.dataset.imagePath));
    return;
  }
  const button = event.target.closest('[data-note-path]');
  if (!button) return;
  const note = directoryEntries.find((entry) => entry.path === button.dataset.notePath && entry.type === 'file')
    || vaultSearchResults?.find((entry) => entry.path === button.dataset.notePath);
  if (note) runUiAction('Could not open that note.', () => openNote(note));
});
elements.breadcrumbs.addEventListener('click', (event) => {
  const breadcrumb = event.target.closest('[data-directory-path]');
  if (!breadcrumb) return;
  currentDirectory = breadcrumb.dataset.directoryPath;
  elements.search.value = '';
  clearVaultSearch();
  runUiAction('Could not open that folder.', fetchInbox);
});
elements.recentNoteList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-note-path]');
  if (!button) return;
  const note = recentNotes.find((entry) => entry.path === button.dataset.notePath);
  if (note) runUiAction('Could not open that note.', () => openNote(note));
});
elements.myDraftsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-draft-kind]');
  if (!button) return;
  if (button.dataset.draftKind === 'capture') {
    runUiAction('Could not open that draft.', () => openCaptureDraft(button.dataset.captureDraftId));
    return;
  }
  const path = button.dataset.draftPath;
  runUiAction('Could not open that draft.', () => openNote({ name: path.split('/').at(-1), path }));
});
elements.readerContent.addEventListener('click', (event) => {
  const image = event.target.closest('img[data-vault-path]');
  if (image) {
    runUiAction('Could not open that image.', () => openVaultImage(image.dataset.vaultPath));
    return;
  }
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
  setConnection('online', config ? 'Connected to GitHub' : 'GitHub setup needed');
  updateOnlineControls();
  if (config) runUiAction('Could not sync queued notes.', syncQueue);
  if (currentView === 'inbox' && config) runUiAction('Could not refresh the vault.', fetchInbox);
});
window.addEventListener('offline', () => {
  setConnection('offline', 'Offline · notes stay on this device');
  updateOnlineControls();
  if (currentView === 'inbox' && config) runUiAction('Could not update the offline vault view.', fetchInbox);
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallButton();
});
window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  elements.installHelp.textContent = 'Pleronic is installed on this device.';
  updateInstallButton();
});
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js', { scope: './' })
    .catch((error) => console.error('Service worker registration failed:', error));
}

runUiAction('Could not initialize Pleronic.', initialize);
