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
# series:
#   id: news-pipeline
#   order: 1
#   label: '시리즈 목록에 보일 짧은 이름'
---

본문...
```

- 파일명이 주소가 됩니다 (`my-post.md` → `/blog/my-post/`).
- 시리즈 글은 `series`를 붙입니다. `id`는 [`src/consts.ts`](src/consts.ts)의 `SERIES`에 먼저 등록하고, `order`는 읽는 순서(1부터)입니다. 글 머리에 시리즈 목록이, 본문 끝에 이전·다음 글이 붙습니다. 등록되지 않은 `id`나 같은 시리즈 안의 중복 `order`는 빌드가 실패합니다.
- 시리즈의 `pubDate`는 읽는 순서와 같은 순서가 되게 둡니다. 같은 날짜면 `'2026-08-22T10:00:00+09:00'`처럼 시각까지 적어 순서를 정합니다(날짜 표시가 UTC 빌드에서 하루 밀리지 않도록 09:00 이후로 둡니다).
- `draft: true`는 개발 서버에서만 보이고 배포에서는 빠집니다.
- `heroImage`가 없으면 글 id를 해시해 커버 그림을 자동 생성합니다.
- `tags[0]`이 카드와 글 상단 메타의 분류로 쓰입니다.
- 목록 옆 카테고리는 태그로 정해집니다. [`src/consts.ts`](src/consts.ts)의 `CATEGORIES`에 적힌 태그가 하나라도 있으면 그 카테고리에 들어가고, 어디에도 안 걸리면 「기타」로 모입니다. 새 태그를 쓰면 여기에도 넣어 주세요.
- 읽는 시간은 본문 길이로 자동 계산됩니다 (한글 기준 분당 500자).

## 화면 구성

| 화면 | 구성 |
| --- | --- |
| 홈 | 히어로 + 최신 글 대표 카드 + 글 목록(아래 참고) |
| 글 목록 | 한 줄에 한 글(왼쪽 카테고리 배지·제목·설명, 오른쪽 썸네일) + 오른쪽 카테고리 체크박스(여러 개 선택 가능) + 아래 페이지 번호. 선택과 페이지는 주소(`?category=…&page=2`)에 남습니다 |
| 글 | 제목·요약·태그 헤더 + 본문 760px + 우측 고정 목차 + 관련 글 |

목차는 h2/h3에서 자동 생성되고, 스크롤 위치에 따라 현재 항목이 강조됩니다.
화면이 1320px보다 좁으면 목차는 숨겨집니다.

## 자주 고치는 곳

| 무엇 | 파일 |
| --- | --- |
| 사이트 제목·태그라인·히어로 문구 | [`src/consts.ts`](src/consts.ts) |
| 카테고리 묶음·한 페이지 글 수 | [`src/consts.ts`](src/consts.ts)의 `CATEGORIES`, `PAGE_SIZE` |
| 목록의 카테고리·페이지 동작 | [`src/components/PostBrowser.astro`](src/components/PostBrowser.astro) |
| 색상·간격·타이포그래피 (액센트는 `--accent` 한 줄) | [`src/styles/global.css`](src/styles/global.css) |
| 사이트 주소(커스텀 도메인) | [`astro.config.mjs`](astro.config.mjs) |
| 상단 메뉴 | [`src/components/Header.astro`](src/components/Header.astro) |
| 목록 한 줄 표시 항목 | [`src/components/PostRow.astro`](src/components/PostRow.astro) |
| 첫 화면 대표 카드 | [`src/components/PostCard.astro`](src/components/PostCard.astro) |
| 자동 생성 커버 그림 | [`src/components/CoverArt.astro`](src/components/CoverArt.astro) |
| 글 페이지 레이아웃·목차·관련 글 | [`src/layouts/BlogPost.astro`](src/layouts/BlogPost.astro) |
| 읽는 시간·카테고리 계산·관련 글 선정 | [`src/lib/posts.ts`](src/lib/posts.ts) |
| 소개 페이지 | [`src/pages/about.astro`](src/pages/about.astro) |

## 배포

`main` 브랜치에 push하면 [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 이
빌드 후 GitHub Pages에 올립니다. 진행 상황은 저장소 **Actions** 탭에서 확인합니다.

## 커스텀 도메인을 쓸 때

1. `public/CNAME` 파일에 도메인 한 줄만 적기
2. `astro.config.mjs` 의 `site` 값을 해당 도메인으로 변경
3. DNS에서 `oownahcohc.github.io` 로 CNAME 레코드 설정
