# Changelog

Notable changes to Pleronic are documented here.

## [Unreleased]

### Added

- Preview AVIF, GIF, JPEG, PNG, and WebP attachments from vault folders and Markdown/Obsidian image embeds, with a 20 MB per-image limit.
- Added an editor for existing Markdown notes with device-local drafts, explicit conflict reconciliation, and SHA-guarded updates that preserve ordinary Git history.
- Added an explicit **Save draft** action and a dedicated **Drafts** navigation page for saved edits to existing notes.
- Added **Save as draft** on the capture page for creating new notes to finish later; the Drafts page lists these alongside edit drafts.
- Added a collapsed **About Pleronic** section in Settings that renders the project README.
- Local edit drafts persist without repeated navigation prompts and are clearly marked; when a remote version changes, users can keep the local draft or switch to the remote version.
- Added a Settings install button that opens the browser install prompt or displays Add to Home Screen instructions.
- Added a save-draft, discard-edits, or stay choice when leaving an editor with changes not yet saved locally.
- Added a Settings popup explaining fine-grained GitHub token creation, repository-level permission scope, safe backup, and local token storage.
- Added a separate Properties panel in the note preview that displays complete Obsidian YAML frontmatter apart from the note body.
- Added Pleronic forest-themed artwork and install icons.
- Added folder browsing with breadcrumbs and a Markdown note reader.
- Added Obsidian wiki-link navigation for notes, aliases, and headings.
- Added visual styling for inline tags and tags in YAML frontmatter.
- Added whole-vault Markdown search with progress and matching-line snippets.
- Added a per-vault list of the five most recently viewed notes.
- Added a searchable destination-folder picker for captured notes.
- Added offline draft saving and a queue for notes waiting to sync.
- Added documentation for setup, GitHub Pages deployment, privacy, and limitations.

### Changed

- Show an inline “Attachment couldn't be loaded” message when an image cannot be fetched or decoded, avoid serving the app shell for failed offline asset requests, and surface unexpected async action failures.
- Reworked the capture experience as a mobile-friendly installable PWA.
- Notes use the supplied title as the Markdown filename; existing notes are not silently overwritten.
- The Settings default note folder now acts as the default destination, with per-note folder selection available during capture.
- Updated the interface with a cool green-and-blue forest palette.

## Changelog format

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions will be added here when releases are published.
