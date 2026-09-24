import { getCollection, type CollectionEntry } from 'astro:content';
import { CATEGORIES, SERIES } from '../consts';

export type Post = CollectionEntry<'blog'>;

export type SeriesInfo = {
	id: string;
	title: string;
	description: string;
	/** 읽는 순서(order)대로 정렬한 시리즈 글. */
	parts: Post[];
	/** 현재 글의 위치(0부터). */
	index: number;
};

/**
 * 글이 속한 시리즈를 읽는 순서대로 돌려줍니다. 시리즈에 속하지 않으면 undefined.
 * consts.ts 에 없는 시리즈 id 나 한 시리즈 안의 중복 order 는 빌드를 멈춥니다 — 목록이
 * 조용히 어긋난 채 배포되는 것보다 낫습니다.
 */
export function seriesOf(current: Post, all: Post[]): SeriesInfo | undefined {
	const id = current.data.series?.id;
	if (!id) return undefined;
	const meta = SERIES[id];
	if (!meta) throw new Error(`consts.ts 의 SERIES 에 없는 시리즈: ${id} (${current.id})`);

	const parts = all
		.filter((p) => p.data.series?.id === id)
		.sort((a, b) => a.data.series!.order - b.data.series!.order);
	const orders = parts.map((p) => p.data.series!.order);
	if (new Set(orders).size !== orders.length) {
		throw new Error(`시리즈 ${id} 에 같은 order 가 있습니다: ${orders.join(', ')}`);
	}
	return { id, ...meta, parts, index: parts.findIndex((p) => p.id === current.id) };
}

/** 시리즈 목록과 이전·다음 글에 보일 이름. */
export function seriesLabel(post: Post): string {
	return post.data.series?.label ?? post.data.title;
}

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

/** 어느 카테고리 태그에도 안 걸리는 글이 모이는 자리. */
const OTHER_CATEGORY = { id: 'etc', label: '기타' };

/**
 * 글이 속한 카테고리 id. 태그 하나라도 겹치면 그 카테고리에 들고, 하나도 없으면 「기타」.
 * 글의 태그 순서를 따라 정렬해서, 첫 태그에 해당하는 카테고리가 맨 앞(목록의 첫 배지)에 옵니다.
 */
export function categoriesOf(post: Post): string[] {
	const { tags } = post.data;
	const firstHit = (c: (typeof CATEGORIES)[number]) =>
		Math.min(...c.tags.map((t) => tags.indexOf(t)).filter((i) => i >= 0));
	const ids = CATEGORIES.filter((c) => c.tags.some((t) => tags.includes(t)))
		.sort((a, b) => firstHit(a) - firstHit(b))
		.map((c) => c.id);
	return ids.length > 0 ? ids : [OTHER_CATEGORY.id];
}

/** 카테고리 id 를 화면에 보일 이름으로. */
export function categoryLabel(id: string): string {
	return CATEGORIES.find((c) => c.id === id)?.label ?? OTHER_CATEGORY.label;
}

/** 카테고리별 글 수. consts.ts 에 적은 순서대로, 글이 하나도 없는 카테고리는 뺍니다. */
export function collectCategories(posts: Post[]): { id: string; label: string; count: number }[] {
	return [...CATEGORIES, OTHER_CATEGORY]
		.map((c) => ({
			id: c.id,
			label: c.label,
			count: posts.filter((p) => categoriesOf(p).includes(c.id)).length,
		}))
		.filter((c) => c.count > 0);
}

/**
 * 태그가 겹치는 글을 우선으로 관련 글을 고릅니다. 모자라면 최신 글로 채웁니다.
 * 같은 시리즈의 글은 글 머리의 시리즈 목록에 이미 있으므로 뺍니다.
 */
export function relatedPosts(current: Post, all: Post[], limit = 4): Post[] {
	const seriesId = current.data.series?.id;
	const others = all.filter(
		(p) => p.id !== current.id && !(seriesId && p.data.series?.id === seriesId),
	);
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
