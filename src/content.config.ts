import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

const locale = z.enum(['zh-cn', 'en']).default('zh-cn');

/* writing 专用日期字段：只接受严格 YYYY-MM-DD 的真实日历日。
   未加引号的 YAML 日期会被解析成 Date，这里统一归一化后再校验。 */
const normalizeDate = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
const dateOnly = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须是 YYYY-MM-DD')
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }, '日期必须是真实存在的日历日')
  .transform((value) => new Date(`${value}T00:00:00Z`));
const writingDate = z.preprocess(normalizeDate, dateOnly);

const common = {
  title: z.string(),
  description: z.string(),
  locale,
  translationKey: z.string().optional(),
  draft: z.boolean().default(false),
  featured: z.boolean().default(false),
  order: z.number().default(0),
  seoTitle: z.string().optional(),
  canonical: z.url().optional(),
  ogImage: z.string().optional(),
};

const writing = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/writing' }),
  /* 只要求 title + pubDate；其余全部可选。draft 默认 true：只有显式 draft:false 才发布。 */
  schema: z.object({
    title: z.string().trim().min(1),
    pubDate: writingDate,
    description: z.string().optional(),
    updatedDate: writingDate.optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(true),
    featured: z.boolean().default(false),
    order: z.number().default(0),
    locale,
    translationKey: z.string().optional(),
    seoTitle: z.string().optional(),
    canonical: z.url().optional(),
    ogImage: z.string().optional(),
    author: z.string().optional(),
    column: z.string().optional(),
    columnOrder: z.number().optional(),
    minutes: z.number().positive().optional(),
    comments: z.boolean().default(false),
  }),
});

const columns = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/columns' }),
  schema: z.object({ ...common, slug: z.string().regex(/^[^/?#]+$/) }),
});

const projects = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/projects' }),
  schema: z.object({
    ...common,
    publishedAt: z.coerce.date(),
    status: z.enum(['active', 'maintained', 'archived', 'paused']).default('active'),
    type: z.string().default('project'),
    externalUrl: z.url().optional(),
    repositoryUrl: z.url().optional(),
    tags: z.array(z.string()).default([]),
  }),
});

const research = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/research' }),
  schema: z.object({
    ...common,
    publishedAt: z.coerce.date(),
    kind: z.string().default('note'),
    version: z.string().default('0.1'),
    tags: z.array(z.string()).default([]),
    paperUrl: z.url().optional(),
    codeUrl: z.url().optional(),
  }),
});

const photos = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/photos' }),
  schema: z.object({
    ...common,
    slug: z.string().regex(/^[^/?#]+$/),
    cover: z.string().optional(),
    photos: z.array(z.object({ src: z.string(), alt: z.string(), caption: z.string().optional() })).default([]),
  }),
});

const links = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/links' }),
  schema: z.object({
    ...common,
    url: z.url(),
    group: z.string().default('常读'),
  }),
});

export const collections = { writing, columns, projects, research, photos, links };
