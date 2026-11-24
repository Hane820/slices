import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const root = process.cwd();
const contentRoot = path.join(root, 'src', 'content');
const publicRoot = path.join(root, 'public');

function filesIn(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(target) : /\.(md|mdx)$/.test(entry.name) ? [target] : [];
  });
}

export function frontmatter(file) {
  // Windows editors write CRLF. Normalize before matching so the LF delimiter regex still works.
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const match = source.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { data: {}, frontmatter: '', body: source };
  return { data: parse(match[1]) ?? {}, frontmatter: match[1], body: source.slice(match[0].length) };
}

function isDraft(entry, collection) {
  // writing 集合的 draft 默认是 true：只有显式 draft:false 才算发布
  if (collection === 'writing') return entry.data.draft !== false && entry.data.draft !== 'false';
  return entry.data.draft === true || entry.data.draft === 'true';
}

function validDateOnly(value) {
  if (value instanceof Date) value = value.toISOString().slice(0, 10);
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function relative(entry) {
  return path.relative(root, entry.file);
}

function validateContent() {
  const errors = [];
  const warnings = [];
  const collections = ['writing', 'columns', 'projects', 'research', 'photos', 'links'];
  const entries = new Map();
  for (const collection of collections) {
    const directory = path.join(contentRoot, collection);
    const current = filesIn(directory).map((file) => ({ collection, file, ...frontmatter(file) }));
    entries.set(collection, current);
    for (const entry of current) {
      // writing 只强制 title + pubDate；其他集合维持原有必填要求
      const required = collection === 'writing' ? ['title', 'pubDate'] : ['title', 'description', 'locale'];
      for (const field of required) {
        if (!entry.data[field]) errors.push(`${relative(entry)}: missing ${field}`);
      }
      if (entry.data.locale && !['zh-cn', 'en'].includes(entry.data.locale)) errors.push(`${relative(entry)}: unsupported locale ${entry.data.locale}`);
      if (collection === 'writing' && entry.data.pubDate && !validDateOnly(entry.data.pubDate)) {
        errors.push(`${relative(entry)}: pubDate must be a real YYYY-MM-DD calendar date`);
      }
      if (collection === 'writing' && entry.data.updatedDate && !validDateOnly(entry.data.updatedDate)) {
        errors.push(`${relative(entry)}: updatedDate must be a real YYYY-MM-DD calendar date`);
      }
      if (isDraft(entry, collection)) continue;
      if (['projects', 'research'].includes(collection) && !entry.data.publishedAt) errors.push(`${relative(entry)}: missing publishedAt`);
      if (collection === 'links' && !/^https?:\/\//.test(entry.data.url ?? '')) errors.push(`${relative(entry)}: url must use http(s)`);
      if (collection === 'photos') {
        const assets = [entry.data.cover, ...(Array.isArray(entry.data.photos) ? entry.data.photos.map((photo) => photo?.src) : [])].filter(Boolean);
        for (const asset of assets) {
          if (typeof asset === 'string' && asset.startsWith('/') && !fs.existsSync(path.join(publicRoot, asset.slice(1)))) {
            warnings.push(`${relative(entry)}: photo asset not found: ${asset}`);
          }
        }
      }
    }
  }

  const translationKeys = new Set();
  for (const [collection, current] of entries) {
    for (const entry of current) {
      const key = entry.data.translationKey;
      if (!key || isDraft(entry, collection)) continue;
      const identity = `${collection}:${entry.data.locale}:${key}`;
      if (translationKeys.has(identity)) errors.push(`${relative(entry)}: duplicate ${identity}`);
      translationKeys.add(identity);
    }
  }

  const columns = new Set(entries.get('columns').filter((entry) => !isDraft(entry, 'columns')).map((entry) => entry.data.title));
  for (const entry of entries.get('writing')) {
    if (isDraft(entry, 'writing') || !entry.data.column) continue;
    if (!columns.has(entry.data.column)) errors.push(`${relative(entry)}: unknown column "${entry.data.column}"`);
  }

  const paths = new Set();
  function addPath(entry, url) {
    if (paths.has(url)) errors.push(`${relative(entry)}: duplicate public path ${url}`);
    paths.add(url);
  }
  function entrySlug(entry) {
    return path.basename(entry.file).replace(/\.(md|mdx)$/, '');
  }
  function datePath(entry, collection) {
    const raw = collection === 'writing' ? entry.data.pubDate : entry.data.publishedAt;
    const date = new Date(raw);
    // writing 用 UTC 归档避免时区跨日；其他集合维持原有本地取值行为
    const year = collection === 'writing' ? date.getUTCFullYear() : date.getFullYear();
    const month = collection === 'writing' ? date.getUTCMonth() + 1 : date.getMonth() + 1;
    return `/${collection}/${year}/${String(month).padStart(2, '0')}/${entrySlug(entry)}/`;
  }
  for (const collection of ['writing', 'projects', 'research']) {
    for (const entry of entries.get(collection)) {
      const date = collection === 'writing' ? entry.data.pubDate : entry.data.publishedAt;
      if (!isDraft(entry, collection) && date) addPath(entry, datePath(entry, collection));
    }
  }
  for (const entry of entries.get('columns')) {
    if (!isDraft(entry, 'columns')) addPath(entry, `/columns/${entry.data.slug || entrySlug(entry)}/`);
  }
  for (const entry of entries.get('photos')) {
    if (isDraft(entry, 'photos')) continue;
    if (!entry.data.slug) errors.push(`${relative(entry)}: missing slug`);
    else addPath(entry, `/photos/${entry.data.slug}/`);
  }

  const tagPaths = new Map();
  const tagSlug = (tag) => tag.toLowerCase().trim().replace(/[\\/?#%]+/g, '-').replace(/\s+/g, '-');
  for (const entry of entries.get('writing')) {
    if (isDraft(entry, 'writing')) continue;
    const tags = Array.isArray(entry.data.tags) ? entry.data.tags : [];
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      const slug = tagSlug(tag);
      const previous = tagPaths.get(slug);
      if (previous && previous !== tag) errors.push(`${relative(entry)}: tags "${previous}" and "${tag}" share slug ${slug}`);
      tagPaths.set(slug, tag);
    }
  }

  const categoryPaths = new Map();
  const categorySlug = (category) => category.toLowerCase().trim().replace(/[\\/?#%]+/g, '-').replace(/\s+/g, '-');
  for (const entry of entries.get('writing')) {
    if (isDraft(entry, 'writing') || typeof entry.data.category !== 'string') continue;
    const category = entry.data.category.trim();
    if (!category) continue;
    const slug = categorySlug(category);
    const previous = categoryPaths.get(slug);
    if (previous && previous !== category) errors.push(`${relative(entry)}: categories "${previous}" and "${category}" share slug ${slug}`);
    categoryPaths.set(slug, category);
  }

  if (errors.length) {
    console.error(`Content validation failed with ${errors.length} error(s):`);
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else {
    console.log(`Content validation passed: ${[...entries.values()].reduce((count, items) => count + items.length, 0)} entries checked.`);
  }
  if (warnings.length) {
    console.warn(`Warnings (${warnings.length}):`);
    warnings.forEach((warning) => console.warn(`- ${warning}`));
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) validateContent();
