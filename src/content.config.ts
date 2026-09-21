import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
   schema: z.object({
    title: z.string(),                            // 标题
    bigTitle: z.string(),                         // 大标题（和 title 一样即可）
    emphasis: z.string().optional(),              // 标题中的强调文字，可选
    headline: z.string(),                         // 副标题/一句话介绍
    excerpt: z.string(),                          // 摘要（列表页显示）
    author: z.string(),                           // 作者
    readTime: z.string().default('5 Min Read'),   // 阅读时长，默认 5 分钟
    date: z.coerce.date(),                        // 日期
    cover: z.string().url(),                      // 封面图（完整网址）
    featured: z.boolean().default(false),         // true = 首页大图展示
    pageNumber: z.string().optional(),            // 期号，可选
    tags: z.array(z.string()).default([]),        // 标签，可多个
    draft: z.boolean().default(false),            // true = 草稿（隐藏）
  }),
});
// 首页精选列表集合：src/content/featured/
const featured = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/featured' }),
  schema: z.object({
    title: z.string(),        // 精选标题
    subtitle: z.string(),     // 副标题，列表里显示的简介
    date: z.coerce.date(),    // 日期
    order: z.number(),        // 排序序号，越小越靠前（1 排第一）
  }),
});

// 作品集集合：src/content/work/
const work = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/work' }),
  schema: z.object({
    title: z.string(),                    // 作品名称
    year: z.string(),                     // 年份，如 "2026"
    cover: z.string().url(),              // 封面图，完整网址
    summary: z.string(),                  // 作品简介
    url: z.string().url().optional(),     // 作品外链（演示地址/GitHub），可选
    order: z.number().default(0),         // 排序序号，越小越靠前，默认 0
  }),
});


export const collections = { posts, featured, work };
