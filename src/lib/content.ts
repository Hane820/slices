import { getCollection, type CollectionEntry, type CollectionKey } from 'astro:content';
import { site } from '../data/site';

import { sitePath } from './urls';

export type Writing = CollectionEntry<'writing'>;

export async function getPublishedWriting(locale = site.locale) {
  /* 本地草稿预览：只在 astro dev 下，按环境变量放行一篇指定 id 的草稿。
     import.meta.env.DEV 在生产构建中被静态替换为 false，构建产物永远不带此分支。 */
  const previewId = import.meta.env.DEV ? import.meta.env.OL_PREVIEW_WRITING_ID : undefined;
  const entries = await getCollection('writing', ({ id, data }) =>
    data.locale === locale && (!data.draft || (Boolean(previewId) && id === previewId)));
  return entries.sort((a, b) => {
    const aDate = a.data.updatedDate ?? a.data.pubDate;
    const bDate = b.data.updatedDate ?? b.data.pubDate;
    return bDate.valueOf() - aDate.valueOf();
  });
}

export async function getPublishedCollection<T extends CollectionKey>(
  name: T,
  locale = site.locale,
): Promise<CollectionEntry<T>[]> {
  return getCollection(name, ({ data }) => !data.draft && data.locale === locale) as Promise<CollectionEntry<T>[]>;
}

export function byDate<T extends { data: { publishedAt: Date } }>(entries: T[]) {
  return [...entries].sort((a, b) => b.data.publishedAt.valueOf() - a.data.publishedAt.valueOf());
}

export function slugFromId(id: string) {
  return id.replace(/^.*\//, '').replace(/\.(md|mdx)$/, '');
}

export function writingPath(entry: Writing) {
  const date = entry.data.pubDate;
  return sitePath(`/writing/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${slugFromId(entry.id)}/`);
}

export function yearOf(entry: Writing) {
  return entry.data.pubDate.getFullYear();
}

/* description 可选：缺失时退而取正文开头做摘要，保证列表/RSS/搜索不会空白 */
export function descriptionOf(entry: Pick<Writing, 'data' | 'body'>): string {
  const explicit = entry.data.description?.trim();
  if (explicit) return explicit;
  return excerpt(entry.body ?? '', 180);
}

export function getTags(entries: Writing[], threshold = site.tagIndexThreshold) {
  const counts = new Map<string, number>();
  for (const entry of entries) for (const tag of entry.data.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

export function tagSlug(tag: string) {
  return tag.toLowerCase().trim().replace(/[\\/?#%]+/g, '-').replace(/\s+/g, '-');
}

/* 分类：只从已发布且填了 category 的文章汇总，不预建空分类 */
export function getCategories(entries: Writing[]) {
  return [...new Set(entries.map((entry) => entry.data.category?.trim()).filter((value): value is string => Boolean(value)))];
}

export function categorySlug(category: string) {
  return category.toLowerCase().trim().replace(/[\\/?#%]+/g, '-').replace(/\s+/g, '-');
}

export function categoryPath(category: string) {
  return sitePath(`/categories/${categorySlug(category)}/`);
}

export function columnSlug(entry: CollectionEntry<'columns'>) {
  return entry.data.slug || slugFromId(entry.id);
}

export function columnPath(entry: CollectionEntry<'columns'>) { return sitePath(`/columns/${columnSlug(entry)}/`); }
export function projectPath(entry: CollectionEntry<'projects'>) {
  const date = entry.data.publishedAt;
  return sitePath(`/projects/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${slugFromId(entry.id)}/`);
}
export function researchPath(entry: CollectionEntry<'research'>) {
  const date = entry.data.publishedAt;
  return sitePath(`/research/${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}/${slugFromId(entry.id)}/`);
}
export function photoPath(entry: CollectionEntry<'photos'>) { return sitePath(`/photos/${entry.data.slug}/`); }
export function linkSlug(entry: CollectionEntry<'links'>) { return slugFromId(entry.id); }

export function excerpt(text: string, length = 180) {
  const clean = text.replace(/[#*_>`\[\]()]/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, length).trim()}…` : clean;
}
