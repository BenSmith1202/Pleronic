<div align="center">
  <img src="./icon-512.png" alt="Pleronic crystal-and-leaf app icon" width="144">
  <h1>Pleronic</h1>
  <p><strong>Your thoughts, straight to your vault.</strong></p>
  <p>A calm, mobile-friendly way to capture notes and explore an Obsidian vault stored in GitHub.</p>
</div>

<p align="center">
  <a href="https://github.com/BenSmith1202/Pleronic"><img alt="GitHub repository" src="https://img.shields.io/badge/GitHub-Pleronic-315f52?logo=github"></a>
  <a href="https://github.com/BenSmith1202/Pleronic/issues"><img alt="Open issues" src="https://img.shields.io/github/issues/BenSmith1202/Pleronic?color=4e7d91"></a>
  <a href="./LICENSE"><img alt="ISC license" src="https://img.shields.io/badge/license-ISC-315f52"></a>
  <img alt="Progressive web app" src="https://img.shields.io/badge/app-installable%20PWA-315f52">
  <img alt="No app server" src="https://img.shields.io/badge/backend-none-4e7d91">
</p>

Pleronic is a static progressive web app (PWA) for sending Markdown notes to a GitHub-backed [Obsidian](https://obsidian.md/) vault and reading that vault from your phone or desktop. It talks directly to GitHub from your browser—there is no Pleronic server or account to set up.

## What you can do

- **Capture notes** with a title and Markdown body. Notes are saved as `<title>.md` in your configured default folder.
- **Choose a destination folder** from the searchable folder picker beside the save button. The Settings folder is the default, not a restriction; a missing destination folder is created when GitHub saves the first note there.
- **Keep writing offline.** Drafts are saved on the device, and notes waiting for a connection are queued for sync.
- **Browse the vault** by folder, with breadcrumbs and a quick filter for the current folder.
- **Search the whole vault** by note title or Markdown content, with matching-line snippets and progress.
- **Pick up where you left off.** The five most recently viewed notes are kept locally for each vault and branch.
- **Read Obsidian-flavored Markdown**, including wiki links (`[[Note]]`), aliases (`[[Note|label]]`), heading links (`[[Note#Heading]]`), and visual tag chips.
- **Edit existing notes** in a Markdown editor with local draft recovery and SHA-guarded GitHub updates. Each saved edit is a normal commit in your repository history.
- **Resolve concurrent edits safely.** If GitHub’s version changed since you opened a note, Pleronic keeps your draft, shows the latest remote version, and requires you to reconcile it before saving.
- **Install it like an app** on supported browsers and devices.

The interface uses a cool forest-green and blue palette and is designed to work on small screens as well as desktop.

## Try Pleronic

Pleronic is a static site. You can run your own copy locally or publish it with GitHub Pages. No backend, database, build step, or environment variables are required.

### Run locally

1. Clone or download this repository.
2. Serve the repository root over HTTP. For example, with Python:

   ```sh
   python3 -m http.server 8000
   ```

3. Open [http://localhost:8000](http://localhost:8000).
4. Connect your vault in **Settings** (see [Connect a vault](#connect-a-vault)).

`localhost` is treated as a secure context by browsers, so the service worker and install-related features can be tested locally. Opening `index.html` directly as a `file://` URL is not supported.

### Publish with GitHub Pages

1. Fork this repository, or push your copy to a GitHub repository.
2. In that repository, open **Settings → Pages**.
3. Under **Build and deployment**, choose **Deploy from a branch**.
4. Select the branch you want to publish (commonly `main`) and the repository root (`/`), then save.
5. Wait for the Pages deployment to finish and open the URL shown in the Pages settings.
6. Connect your Obsidian vault using the steps below.

The published app must use HTTPS. When deploying from a project subpath, keep the app files together at the published root so the manifest, service worker, icons, and modules resolve relative to the app.

## Connect a vault

Pleronic uses a GitHub fine-grained personal access token to read and write Markdown files in one repository.

1. In GitHub, create a fine-grained token restricted to only the repository containing your vault.
2. Grant **Contents: Read and write** permission. GitHub's standard repository metadata permission is also needed to identify the repository. GitHub tokens can be limited to a repository, but not to a specific folder inside it.
3. In Pleronic, open **Settings** and enter:
   - **GitHub owner** — your username or organization
   - **Repository** — the repository name only, not its URL
   - **Branch** — the branch containing the vault (usually `main`)
   - **Default note folder** — where new notes go unless you choose another folder (defaults to `inbox`; leave blank for the repository root)
   - **Token** — the fine-grained personal access token
4. Select **Test connection**, then save the settings.
5. Open **Vault** to browse, read, and search your notes.

The token must be able to read vault files for browsing, wiki links, and search, and write contents to save captured notes. Treat it like a password: create the narrowest token that works, and revoke it in GitHub if the device or browser profile is lost. GitHub displays a new token once, so save a copy in a trusted password manager.

## Using the app

### Capture

Give your note a title, write in Markdown, and select **Save to vault**. The title becomes the filename, with characters that cannot be used safely in filenames replaced by hyphens. Use a unique title within the destination folder; Pleronic does not silently overwrite an existing note.

The folder shown below the save button is the current destination. Open the adjacent arrow to search and select any folder in the vault, or choose **Vault root**. The Settings default is included even if it has not been created yet; GitHub creates that folder when the note is saved.

If GitHub is unavailable, Pleronic can save the note to a local sync queue and try again when you reconnect. Review the sync status and use **Sync now** if needed.

### Browse and read

Open **Vault** to browse from the repository root. Select a folder to enter it, use the breadcrumbs to move to an ancestor, and open a Markdown file to read it. The reader's back link returns to the note's containing folder.

Select **Edit note** to modify an existing file. Pleronic saves an edit draft on this device as you type; it is not sent to GitHub until you select **Save changes**. Leaving the editor saves any pending text locally without asking repeatedly, and the note is marked **Local draft** until it is saved to GitHub or discarded. Saving to GitHub requires a connection. The update includes the version SHA from when the note was read, so GitHub rejects it if another change has landed in the meantime. When that happens, Pleronic shows the newer remote version and offers **Keep my draft** or **Use remote version**. Keeping the draft allows a later save to replace the newer remote text; choosing the remote version discards the local draft. You can copy your draft from the conflict panel. Edits are never silently queued for later upload.

Supported wiki-link forms include:

```markdown
[[A note]]
[[A note|the label to show]]
[[A note#A heading]]
[[#A heading in this note]]
```

Links are matched case-insensitively against the vault's Markdown file index. Pleronic checks the current note's folder first, then the vault root. Unresolved wiki links are displayed as plain text.

Tags in note text and `tags` in YAML frontmatter are displayed as visual chips. They are decorative; they do not currently filter or link to other notes.

### Search

Use **Search the whole vault** to look for words or phrases in note titles and contents. Matching content includes a short line snippet. Search reads Markdown files through GitHub's Contents API, with up to four file reads in progress at once. A large vault can take a while and use a significant portion of your GitHub API quota. Searching requires a complete repository file index; if GitHub reports that the index is truncated, browsing still works but whole-vault search and wiki-link resolution may not.

### Install

Open **Settings** and choose **Install app** to use the browser's install prompt, when available. Otherwise, the button gives the browser-specific **Add to Home Screen** instructions. Installation requires an HTTPS-hosted app (localhost also works for development). If you installed an earlier version, update the app by opening it online; if the launcher still shows an old icon, remove the existing shortcut and install it again.

## Offline behavior

After the app shell has loaded, the service worker caches the interface and its local modules. While offline:

- Drafts and notes waiting to sync remain on this device.
- Existing-note edit drafts are saved locally and are never automatically uploaded later. Reopen the note while online to compare a saved draft with GitHub.
- Pleronic retries queued note sync when the connection returns.
- Previously opened notes may be available from their saved local copy.
- Browsing the GitHub repository and searching its contents require a connection.

Recent-note history and drafts are stored in the browser/device that created them. They are not synced between devices.

## Privacy and security

- Pleronic has no application server. The app sends GitHub API requests directly from your browser.
- The access token is stored in that browser profile's persistent `localStorage` on the device—not temporary `sessionStorage`. Anyone with access to the same browser profile may be able to use it.
- Use Pleronic only over HTTPS outside local development. Do not use a shared or untrusted device for a token with write access.
- Disconnecting removes the saved connection settings from the current browser. For a lost device or exposed token, revoke the token in GitHub as well.
- Note text is sent to GitHub for reading, searching, and saving. Search can make many API requests because it scans notes individually.
- Rendered Markdown is sanitized before it is displayed. This is not a security boundary for protecting a compromised device or browser.

## Current limitations

Pleronic is a lightweight companion, not a complete Obsidian replacement:

- Obsidian plugins, Dataview, canvas files, and other plugin-generated views are not rendered.
- Embedded vault images and attachments are not currently resolved or previewed.
- Only Markdown files are shown in the folder browser and searched.
- Tags are visual only; tag filtering is not implemented.
- Vault access, browsing, and search depend on GitHub API availability, token permissions, and API limits.
- Wiki links and whole-vault search rely on GitHub's recursive file index. For very large repositories the index may be truncated.

## Development and tests

Pleronic is plain HTML, CSS, and JavaScript modules; there is no compile or build step. The app shell uses locally vendored copies of `marked` for Markdown parsing and `idb-keyval` for IndexedDB storage.

To install the development dependencies and run the tests:

```sh
npm ci
npm test
```

Tests use Node's built-in test runner and cover GitHub API behavior, vault search, filename generation, wiki-link handling, heading slugs, and frontmatter tags.

To contribute, open an [issue](https://github.com/BenSmith1202/Pleronic/issues) to report a bug or suggest a feature, or submit a pull request. Please include tests for behavior changes and never include a real GitHub token or private vault contents in an issue, test fixture, or screenshot.

## License

Pleronic is distributed under the [ISC License](./LICENSE). See [CHANGELOG.md](./CHANGELOG.md) for notable project updates.
