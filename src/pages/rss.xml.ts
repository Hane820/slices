import rss from '@astrojs/rss';
import { getPublishedWriting, writingPath, descriptionOf } from '../lib/content';
import { site } from '../data/site';
const entries=await getPublishedWriting();
export const GET=()=>rss({title:site.title,description:site.description,site:site.url,items:entries.map((entry)=>({title:entry.data.title,description:descriptionOf(entry),pubDate:entry.data.pubDate,link:writingPath(entry)}))});
