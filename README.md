# chanwoo.dev

[Astro](https://astro.build)로 만든 개인 블로그. https://oownahcohc.github.io 에 배포됩니다.

레이아웃과 타이포그래피는 [쏘카 테크 블로그](https://tech.socar.kr)의 구성을 참고했습니다.

## 명령어

```bash
npm install       # 최초 1회
npm run dev       # 개발 서버 → http://localhost:4321
npm run build     # 정적 파일 빌드 → ./dist
npm run preview   # 빌드 결과 미리보기
```

## 새 글 쓰기

`src/content/blog/` 에 마크다운 파일을 추가합니다.

```markdown
---
title: '글 제목'
description: '카드와 링크 공유에 쓰이는 한 줄 요약'
pubDate: '2026-09-22'
tags: ['spring', 'transaction']
# updatedDate: '2026-09-30'
# heroImage: '../../assets/cover.jpg'
# draft: true
---

본문...
```

- 파일명이 주소가 됩니다 (`my-post.md` → `/blog/my-post/`).
- `draft: true`는 개발 서버에서만 보이고 배포에서는 빠집니다.
- `heroImage`가 없으면 글 id를 해시해 커버 그림을 자동 생성합니다.
- `tags[0]`이 카드와 글 상단 메타의 분류로 쓰입니다.
- 읽는 시간은 본문 길이로 자동 계산됩니다 (한글 기준 분당 500자).

## 화면 구성

| 화면 | 구성 |
| --- | --- |
| 홈 | 히어로 + 최신 글 대표 카드 + 태그 필터 + 2단 카드 그리드 |
| 글 목록 | 태그 필터 + 2단 카드 그리드 |
| 글 | 제목·요약·태그 헤더 + 본문 760px + 우측 고정 목차 + 관련 글 |

목차는 h2/h3에서 자동 생성되고, 스크롤 위치에 따라 현재 항목이 강조됩니다.
화면이 1320px보다 좁으면 목차는 숨겨집니다.

## 자주 고치는 곳

| 무엇 | 파일 |
| --- | --- |
| 사이트 제목·태그라인·히어로 문구 | [`src/consts.ts`](src/consts.ts) |
| 색상·간격·타이포그래피 (액센트는 `--accent` 한 줄) | [`src/styles/global.css`](src/styles/global.css) |
| 사이트 주소(커스텀 도메인) | [`astro.config.mjs`](astro.config.mjs) |
| 상단 메뉴 | [`src/components/Header.astro`](src/components/Header.astro) |
| 카드 표시 항목 | [`src/components/PostCard.astro`](src/components/PostCard.astro) |
| 자동 생성 커버 그림 | [`src/components/CoverArt.astro`](src/components/CoverArt.astro) |
| 글 페이지 레이아웃·목차·관련 글 | [`src/layouts/BlogPost.astro`](src/layouts/BlogPost.astro) |
| 읽는 시간·태그 집계·관련 글 선정 | [`src/lib/posts.ts`](src/lib/posts.ts) |
| 소개 페이지 | [`src/pages/about.astro`](src/pages/about.astro) |

## 배포

`main` 브랜치에 push하면 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 이
빌드 후 GitHub Pages에 올립니다. 진행 상황은 저장소 **Actions** 탭에서 확인합니다.

## 커스텀 도메인을 쓸 때

1. `public/CNAME` 파일에 도메인 한 줄만 적기
2. `astro.config.mjs` 의 `site` 값을 해당 도메인으로 변경
3. DNS에서 `oownahcohc.github.io` 로 CNAME 레코드 설정
