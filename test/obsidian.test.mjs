import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractObsidianFrontmatter,
  headingSlug,
  resolveAttachmentPath,
  resolveImageEmbeds,
  resolveWikiLink,
  resolveWikiLinks
} from '../obsidian.mjs';

const paths = [
  'Home.md',
  'Projects/Forest.md',
  'Projects/Planning/Trip Notes.md',
  'Reference/Forest.md'
];

test('wiki links resolve relative to the current folder, then from the vault root', () => {
  assert.deepEqual(resolveWikiLink('Planning/Trip Notes', 'Projects/Forest.md', paths), {
    path: 'Projects/Planning/Trip Notes.md',
    heading: null
  });
  assert.deepEqual(resolveWikiLink('Home', 'Projects/Forest.md', paths), {
    path: 'Home.md',
    heading: null
  });
});

test('wiki links resolve headings and heading-only links to the current note', () => {
  assert.deepEqual(resolveWikiLink('Home#First Steps', 'Projects/Forest.md', paths), {
    path: 'Home.md',
    heading: 'First Steps'
  });
  assert.deepEqual(resolveWikiLink('#Canopy', 'Projects/Forest.md', paths), {
    path: 'Projects/Forest.md',
    heading: 'Canopy'
  });
});

test('bare wiki links resolve by filename case-insensitively', () => {
  assert.deepEqual(resolveWikiLink('forest', 'Home.md', paths), {
    path: 'Projects/Forest.md',
    heading: null
  });
});

test('unresolved wiki links stay unlinked', () => {
  assert.equal(resolveWikiLink('Unknown note', 'Home.md', paths), null);
  assert.equal(resolveWikiLinks('See [[Unknown note|the missing page]].', 'Home.md', paths), 'See the missing page.');
});

test('wiki links preserve aliases and are not rewritten inside code', () => {
  const source = 'See [[Home|start here]] and `[[Home]]`.\n\n```md\n[[Home]]\n```';
  assert.equal(
    resolveWikiLinks(source, 'Projects/Forest.md', paths),
    'See [start here](vault:Home.md) and `[[Home]]`.\n\n```md\n[[Home]]\n```'
  );
});

test('image embeds resolve relative to note folders and support Obsidian aliases', () => {
  const images = ['Projects/Attachments/Forest walk.jpg', 'Attachments/cover.png'];
  assert.equal(
    resolveImageEmbeds('![[Attachments/Forest%20walk.jpg|Forest canopy]]', 'Projects/Notes.md', images),
    '![Forest canopy](vault-attachment:Projects%2FAttachments%2FForest%20walk.jpg)'
  );
  assert.equal(
    resolveImageEmbeds('![Cover](../Attachments/cover.png)', 'Projects/Notes.md', images),
    '![Cover](vault-attachment:Attachments%2Fcover.png)'
  );
});

test('image embeds preserve external, unresolved, and code-block references', () => {
  const source = '![Web](https://example.com/image.png) ![[missing.png]]\n\n`![[missing.png]]`';
  assert.equal(resolveImageEmbeds(source, 'Home.md', []), source);
});

test('attachment paths cannot traverse above the vault root', () => {
  assert.equal(resolveAttachmentPath('../../secret.png', 'Notes/Entry.md', ['secret.png']), null);
});

test('heading slugs are stable for punctuation, accents, and spacing', () => {
  assert.equal(headingSlug('  Café & Trees!  '), 'cafe-trees');
});

test('frontmatter tags support inline arrays and nested tag names', () => {
  const result = extractObsidianFrontmatter('---\ntitle: Forest walk\ntags: [garden, "project/trees", \'#field-notes\']\n---\n\nA quiet path.');
  assert.deepEqual(result, {
    markdown: '\nA quiet path.',
    tags: ['garden', 'project/trees', 'field-notes'],
    frontmatter: 'title: Forest walk\ntags: [garden, "project/trees", \'#field-notes\']'
  });
});

test('frontmatter tags support YAML lists and ignore malformed tag values', () => {
  const result = extractObsidianFrontmatter('---\ntags:\n  - garden\n  - field/notes\n  - invalid tag\nother: value\n---\nNote body.');
  assert.deepEqual(result, {
    markdown: 'Note body.',
    tags: ['garden', 'field/notes'],
    frontmatter: 'tags:\n  - garden\n  - field/notes\n  - invalid tag\nother: value'
  });
});

test('frontmatter is preserved separately from the note body, including nested properties', () => {
  const markdown = '---\ntitle: Field journal\ndate: 2026-10-08\naliases:\n  - Journal\n  - Field notes\nmetadata:\n  status: active\n---\n\nThe note body.';
  const result = extractObsidianFrontmatter(markdown);
  assert.equal(result.frontmatter, 'title: Field journal\ndate: 2026-10-08\naliases:\n  - Journal\n  - Field notes\nmetadata:\n  status: active');
  assert.equal(result.markdown, '\nThe note body.');
  assert.deepEqual(result.tags, []);
});

test('notes without frontmatter remain unchanged', () => {
  const markdown = '# A note\n\nNo properties here.';
  assert.deepEqual(extractObsidianFrontmatter(markdown), { markdown, tags: [], frontmatter: null });
});
