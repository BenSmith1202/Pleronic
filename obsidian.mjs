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
