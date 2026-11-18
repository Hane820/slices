const siteOrigin = (import.meta.env.SITE_URL ?? 'https://example.org').replace(/\/$/, '');
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const siteUrl = `${siteOrigin}${basePath}`;

export const site = {
  name: 'Slices0fMe',
  title: '关于一切· 我的切片',
  description: '这是人类切片。',
  url: siteUrl,
  author: {
    name: 'HANE',
    bio: '我到底要如何把自己切得足够薄？',
    email: 'hanehane@foxmail.com',
  },
  locale: 'zh-cn',
  locales: ['zh-cn', 'en'] as const,
  writingPageSize: 8,
  tagIndexThreshold: 1,
  license: {
    name: 'CC BY-NC-SA 4.0',
    url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
  },
  social: [
    { label: 'GitHub', href: 'https://github.com/Hane820/slices' },
  ] as Array<{ label: string; href: string }>,
  features: {
    search: true,
    favorites: true,
    theme: true,
    rss: true,
    share: true,
    tips: false,
    newsletter: false,
    comments: false,
  },
} as const;

export type Locale = (typeof site.locales)[number];
