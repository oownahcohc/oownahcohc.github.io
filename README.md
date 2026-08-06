# chanwoo.dev

[Astro](https://astro.build)로 만든 개인 블로그. https://oownahcohc.github.io 에 배포됩니다.

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
description: '목록과 링크 공유에 쓰이는 한 줄 요약'
pubDate: '2026-08-06'
tags: ['astro']
# updatedDate: '2026-08-10'
# heroImage: '../../assets/cover.jpg'
# draft: true
---

본문...
```

파일명이 주소가 됩니다 (`my-post.md` → `/blog/my-post/`).
`draft: true`는 개발 서버에서만 보이고 배포에서는 빠집니다.

## 배포

`main` 브랜치에 push하면 `.github/workflows/deploy.yml` 이 빌드 후 GitHub Pages에 올립니다.
진행 상황은 저장소 **Actions** 탭에서 확인합니다.

## 자주 고치는 곳

| 무엇 | 파일 |
| --- | --- |
| 사이트 제목·설명·GitHub 주소 | [`src/consts.ts`](src/consts.ts) |
| 사이트 주소(커스텀 도메인) | [`astro.config.mjs`](astro.config.mjs) |
| 색상·폰트·타이포그래피 | [`src/styles/global.css`](src/styles/global.css) |
| 상단 메뉴 | [`src/components/Header.astro`](src/components/Header.astro) |
| 첫 화면 문구 | [`src/pages/index.astro`](src/pages/index.astro) |
| 소개 페이지 | [`src/pages/about.astro`](src/pages/about.astro) |

## 커스텀 도메인을 쓸 때

1. `public/CNAME` 파일에 도메인 한 줄만 적기
2. `astro.config.mjs` 의 `site` 값을 해당 도메인으로 변경
3. DNS에서 `oownahcohc.github.io` 로 CNAME 레코드 설정
