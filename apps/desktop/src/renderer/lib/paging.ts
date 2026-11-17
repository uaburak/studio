// Reading every page of a cursor list (`{ items, nextCursor }`), with a page cap.

export async function fetchAllPages<T>(
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages = 10,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const list = await page(cursor);
    items.push(...list.items);
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  return items;
}
