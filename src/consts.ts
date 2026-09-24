// 사이트 전역에서 쓰는 값들. 이 파일만 고치면 헤더/푸터/메타태그/히어로가 한 번에 바뀝니다.

export const SITE_TITLE = 'chanwoo.dev';
export const SITE_TAGLINE = 'Engineering Notes';
export const SITE_DESCRIPTION = '개발하면서 배운 것들을 기록합니다.';

// 첫 화면 히어로 문구
export const HERO_EYEBROW = 'Engineering Notes';
export const HERO_HEADLINE = '고민한 과정을\n기록으로 남깁니다';
export const HERO_BODY =
	'백엔드, 트랜잭션, 이벤트 처리. 결론만이 아니라 왜 그 선택을 했는지까지 남기려고 합니다.';

// 시리즈 이름과 한 줄 소개. 글 frontmatter 의 `series.id` 가 이 키를 가리킵니다.
export const SERIES: Record<string, { title: string; description: string }> = {
	'news-pipeline': {
		title: '뉴스 파이프라인',
		description:
			'같은 수집·LLM 기반 위에서 도는 두 앱, 편집자가 착수하는 매거진과 사람 없이 발행하는 뉴스 인텔리전스를 따라갑니다.',
	},
};

// 글 목록 한 페이지에 보일 글 수.
export const PAGE_SIZE = 10;

// 글 목록 옆 카테고리. 글의 tags 중 하나라도 여기 적힌 태그면 그 카테고리에 들어갑니다.
// 한 글이 여러 카테고리에 동시에 들 수 있고, 어디에도 안 걸리는 글은 「기타」로 모입니다.
// 새 태그를 쓰기 시작하면 여기에도 넣어 주세요. id 는 주소(?category=…)에 쓰입니다.
export const CATEGORIES: { id: string; label: string; tags: string[] }[] = [
	{
		id: 'architecture',
		label: '아키텍처',
		tags: ['architecture', 'api-design', 'schema-design', 'migration', 'legacy', 'pipeline'],
	},
	{ id: 'database', label: '데이터베이스', tags: ['database', 'postgresql', 'mysql', 'hikaricp'] },
	{
		id: 'consistency',
		label: '동시성·정합성',
		tags: ['concurrency', 'idempotency', 'eventual-consistency', 'transaction', 'lua'],
	},
	{
		id: 'messaging',
		label: '메시징·이벤트',
		tags: ['outbox', 'kafka', 'rabbitmq', 'event', 'event-driven'],
	},
	{
		id: 'performance',
		label: '성능·캐시',
		tags: ['performance', 'load-test', 'jvm', 'jit', 'tomcat', 'cache'],
	},
	{ id: 'ai', label: 'AI·LLM', tags: ['ai', 'llm', 'rag', 'claude-code', 'evaluation', 'experiment'] },
	{
		id: 'operations',
		label: '운영·관측',
		tags: ['observability', 'logging', 'aws', 'waf', 'reliability', 'scheduler', 'notification', 'fcm'],
	},
];

export const AUTHOR = 'chanwoo';
export const GITHUB_URL = 'https://github.com/oownahcohc';
