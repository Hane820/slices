import { getPublishedWriting, writingPath, descriptionOf } from '../lib/content';

export async function GET() {
  const entries = await getPublishedWriting();
  return new Response(JSON.stringify(entries.map((entry) => ({
    id: entry.id,
    title: entry.data.title,
    description: descriptionOf(entry),
    tags: entry.data.tags,
    locale: entry.data.locale,
    url: writingPath(entry),
    text: entry.body ?? '',
  }))), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
