# Pleronic

Pleronic is a small, mobile-friendly progressive web app for capturing Markdown notes directly into an Obsidian vault stored in a GitHub repository. It runs entirely in your browser; there is no app server.

## Get started

1. Serve the repository over HTTPS (for example, with GitHub Pages). Service workers and installable apps require a secure context; `http://localhost` is also supported for local development.
2. Open the app and choose **Settings**.
3. Create a GitHub fine-grained personal access token limited to your vault repository. Grant **Contents: read and write** access. GitHub may also require the repository's standard metadata access.
4. Enter the repository owner, repository name, branch, inbox folder, and token. Select **Test connection** to check that the token can access the chosen branch, then save the settings.
5. Capture a note. Notes are created as Markdown files named after their title in the configured inbox folder. Characters Obsidian cannot use in filenames are replaced with hyphens; use a unique title for each note in that folder. The default folder is `inbox`; GitHub creates it with the first saved note.

The **Vault** view browses folders and Markdown files across the configured repository, with breadcrumbs and a folder filter. It also keeps the five most recently viewed notes on this device and can search note titles and contents across the vault. Content search reads Markdown files through the GitHub API, so it can take time and use API requests in large vaults. Obsidian tags in frontmatter and note text are displayed as visual labels. Select a note to read it in the app. Obsidian `[[wiki links]]`, aliases such as `[[Note|label]]`, and heading links such as `[[Note#Heading]]` are supported. Links are resolved against the vault's Markdown file index, preferring the current folder and then the vault root. Markdown previews and note views sanitize HTML before displaying it.

This is a lightweight reader, not a full Obsidian renderer: plugin-generated views, Dataview, and embedded attachments are not rendered. GitHub's recursive file index has a size limit; if it is truncated, folder navigation still works, but wiki links cannot be resolved.

## Offline use

After the app has been loaded once, the service worker caches the app shell. Drafts and notes waiting to sync are stored in this browser using IndexedDB. When the connection returns, Pleronic attempts to sync queued notes; you can also select **Sync now**. The inbox itself requires a connection unless a note has already been opened on this device.

Queued notes keep their original vault destination, so changing repositories in Settings will not silently redirect notes already waiting to sync. Notes captured before a vault is configured use the vault settings present when they are synced.

## Token and privacy

The GitHub token is saved in this browser's `localStorage` so the app can call the GitHub API directly. It is not sent to a Pleronic server (there is no server), but anyone with access to this browser profile or device may be able to use it. Use the app only over HTTPS, protect shared devices, and revoke the token from GitHub if the device is lost. Disconnecting removes the saved settings from this browser.

## Development

This is a static web app; no build step is required. From the repository root, start any static HTTP server that serves `index.html`, then run:

```sh
npm test
```
