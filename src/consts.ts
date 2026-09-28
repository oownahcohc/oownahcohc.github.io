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
	'baro-backend': {
		title: 'baro 백엔드',
		description:
			'v1을 v2로 다시 만든 정치 정보 앱 백엔드를 첫 운영, 트랜잭션 안팎의 이벤트와 알림, API와 데이터 설계, 부하 테스트와 동시성 순서로 따라가고, 마지막에 v1→v2 전환을 다시 설계해 봅니다.',
	},
	ai: {
		title: 'AI 워크플로',
		description:
			'혼자 여러 저장소를 AI 에이전트와 함께 개발하며 지침·가드·측정 체계를 세운 과정과, 검색 대신 모델이 저장소를 직접 읽게 한 사내 지식봇을 따라갑니다.',
	},
	kopang: {
		title: '코팡',
		description:
			'선착순 커머스 서버 코팡에서 재고 차감의 동시성과 DB 동기화, 결제와 주문 상태의 정합성, 부하 테스트를 차례로 따라갑니다.',
	},
	'real-mysql': {
		title: 'Real MySQL 8.0 정리',
		description:
			'Real MySQL 8.0을 읽으며 MySQL 아키텍처와 InnoDB 스토리지 엔진의 구조, 트랜잭션 격리 수준과 잠금, 전문 검색 인덱스를 차례로 정리합니다.',
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
	{
		id: 'database',
		label: '데이터베이스',
		tags: ['database', 'postgresql', 'mysql', 'innodb', 'index', 'real-mysql', 'hikaricp'],
	},
	{
		id: 'consistency',
		label: '동시성·정합성',
		tags: ['concurrency', 'idempotency', 'eventual-consistency', 'transaction', 'lock', 'lua'],
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
