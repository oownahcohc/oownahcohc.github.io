import { getCollection } from 'astro:content';

/**
 * 공개된 글을 최신순으로 가져옵니다.
 * `draft: true`인 글은 로컬 개발 서버에서만 보이고, 배포 빌드에서는 빠집니다.
 */
export async function getPublishedPosts() {
	const posts = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}
