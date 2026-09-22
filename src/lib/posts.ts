import { getCollection, type CollectionEntry } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

/**
 * 공개된 글을 최신순으로 가져옵니다.
 * `draft: true`인 글은 로컬 개발 서버에서만 보이고, 배포 빌드에서는 빠집니다.
 */
export async function getPublishedPosts() {
	const posts = await getCollection('blog', ({ data }) => import.meta.env.DEV || !data.draft);
	return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

/**
 * 본문 길이로 읽는 시간을 추정합니다.
 * 한글은 분당 약 500자, 코드 블록은 읽는 속도가 느려 절반으로 환산합니다.
 */
export function readingTime(body = ''): number {
	const codeChars = (body.match(/```[\s\S]*?```/g) ?? []).join('').length;
	const proseChars = body.replace(/```[\s\S]*?```/g, '').replace(/\s/g, '').length;
	const minutes = (proseChars + codeChars * 0.5) / 500;
	return Math.max(1, Math.round(minutes));
}

/** 글 목록에서 태그별 개수를 세어 많이 쓰인 순으로 돌려줍니다. */
export function collectTags(posts: Post[]): { name: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const post of posts) {
		for (const tag of post.data.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
	}
	return [...counts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** 태그가 겹치는 글을 우선으로 관련 글을 고릅니다. 모자라면 최신 글로 채웁니다. */
export function relatedPosts(current: Post, all: Post[], limit = 4): Post[] {
	const others = all.filter((p) => p.id !== current.id);
	const scored = others
		.map((p) => ({
			post: p,
			score: p.data.tags.filter((t) => current.data.tags.includes(t)).length,
		}))
		.sort(
			(a, b) => b.score - a.score || b.post.data.pubDate.valueOf() - a.post.data.pubDate.valueOf(),
		);
	return scored.slice(0, limit).map((s) => s.post);
}
