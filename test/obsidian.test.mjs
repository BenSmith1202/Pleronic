import test from 'node:test';
import assert from 'node:assert/strict';
import { headingSlug, resolveWikiLink, resolveWikiLinks } from '../obsidian.mjs';

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

test('heading slugs are stable for punctuation, accents, and spacing', () => {
  assert.equal(headingSlug('  Café & Trees!  '), 'cafe-trees');
});
