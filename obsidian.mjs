function normalizePath(path) {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
}

function notePath(path) {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

export function resolveWikiLink(target, sourcePath, markdownPaths) {
  const [rawPath, ...headingParts] = target.split('#');
  const requestedPath = normalizePath(rawPath.trim() || (headingParts.length ? sourcePath : ''));
  if (!requestedPath) return null;

  const requested = notePath(requestedPath);
  const sourceDirectory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  const candidates = [
    sourceDirectory ? `${sourceDirectory}/${requested}` : requested,
    requested
  ];
  const matchingPaths = markdownPaths
    .map(normalizePath)
    .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));

  let resolved = candidates
    .map((candidate) => matchingPaths.find((path) => path.toLocaleLowerCase() === candidate.toLocaleLowerCase()))
    .find(Boolean);

  if (!resolved && !requested.includes('/')) {
    const basename = requested.toLocaleLowerCase();
    resolved = matchingPaths.find((path) => path.slice(path.lastIndexOf('/') + 1).toLocaleLowerCase() === basename);
  }
  if (!resolved) return null;

  const heading = headingParts.join('#').trim();
  return { path: resolved, heading: heading || null };
}

export function headingSlug(heading) {
  return heading.normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function normalizedAttachmentPath(target, sourcePath) {
  let decodedTarget = target.trim();
  try {
    decodedTarget = decodeURIComponent(decodedTarget);
  } catch {
    return null;
  }
  const absolute = decodedTarget.startsWith('/');
  const sourceDirectory = sourcePath.includes('/') ? sourcePath.slice(0, sourcePath.lastIndexOf('/')) : '';
  const segments = absolute ? [] : sourceDirectory.split('/').filter(Boolean);
  for (const segment of decodedTarget.replace(/^\/+/, '').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
}

export function resolveAttachmentPath(target, sourcePath, imagePaths) {
  const requested = normalizedAttachmentPath(target, sourcePath);
  if (!requested) return null;
  return imagePaths.find((path) => path.toLocaleLowerCase() === requested.toLocaleLowerCase()) || null;
}

export function resolveImageEmbeds(markdown, sourcePath, imagePaths) {
  const protectedParts = [];
  const protectedMarkdown = markdown.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)/g, (code) => {
    const index = protectedParts.push(code) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  const withObsidianEmbeds = protectedMarkdown.replace(/!\[\[([^\]]+)\]\]/g, (match, contents) => {
    const [target, alias] = contents.split('|', 2);
    const path = resolveAttachmentPath(target, sourcePath, imagePaths);
    if (!path) return match;
    const alt = (alias?.trim() || target.trim().split('/').at(-1)).replace(/[\\[\]]/g, '\\$&');
    return `![${alt}](vault-attachment:${encodeURIComponent(path)})`;
  });
  const withMarkdownEmbeds = withObsidianEmbeds.replace(
    /!\[([^\]]*)\]\((<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\)/g,
    (match, alt, rawTarget) => {
      const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return match;
      const path = resolveAttachmentPath(target, sourcePath, imagePaths);
      return path ? `![${alt}](vault-attachment:${encodeURIComponent(path)})` : match;
    }
  );
  return withMarkdownEmbeds.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => protectedParts[Number(index)]);
}

export function extractObsidianFrontmatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { markdown, tags: [], frontmatter: null };

  const lines = match[1].split(/\r?\n/);
  const tags = [];
  let collectingList = false;
  for (const line of lines) {
    const tagField = line.match(/^tags\s*:\s*(.*)$/i);
    if (tagField) {
      collectingList = !tagField[1].trim();
      const inlineTags = tagField[1].trim().replace(/^\[|\]$/g, '');
      if (inlineTags) tags.push(...inlineTags.split(','));
      continue;
    }
    if (collectingList && /^\s+-\s+/.test(line)) {
      tags.push(line.replace(/^\s+-\s+/, ''));
      continue;
    }
    if (collectingList && /^\S/.test(line)) collectingList = false;
  }

  const uniqueTags = [...new Set(tags.map((tag) => tag
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/^#/, '')
  ).filter((tag) => /^[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*$/u.test(tag)))];

  return {
    markdown: markdown.slice(match[0].length),
    tags: uniqueTags,
    frontmatter: match[1]
  };
}

function escapeMarkdownLabel(value) {
  return value.replace(/[\\[\]]/g, '\\$&');
}

export function resolveWikiLinks(markdown, sourcePath, markdownPaths) {
  const protectedParts = [];
  const protectedMarkdown = markdown.replace(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)/g, (code) => {
    const index = protectedParts.push(code) - 1;
    return `\u0000CODE${index}\u0000`;
  });

  const linkedMarkdown = protectedMarkdown.replace(/(!?)\[\[([^\]]+)\]\]/g, (match, embed, contents) => {
    if (embed) return match;
    const [target, alias] = contents.split('|', 2);
    const resolved = resolveWikiLink(target, sourcePath, markdownPaths);
    if (!resolved) return alias?.trim() || target.trim();

    const href = `vault:${encodeURIComponent(resolved.path)}${resolved.heading ? `#${encodeURIComponent(resolved.heading)}` : ''}`;
    const label = escapeMarkdownLabel(alias?.trim() || target.trim().split('#')[0].trim());
    return `[${label}](${href})`;
  });

  return linkedMarkdown.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => protectedParts[Number(index)]);
}
