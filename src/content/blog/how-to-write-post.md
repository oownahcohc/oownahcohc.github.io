---
title: '글 쓰는 방법 (나를 위한 메모)'
description: '이 블로그에 새 글을 추가하는 절차와 frontmatter 옵션 정리.'
pubDate: '2026-08-06'
tags: ['blog', 'memo']
---

몇 달 뒤에 분명히 까먹을 것 같아서 적어 둡니다.

## 새 글 추가하기

`src/content/blog/` 안에 마크다운 파일을 만듭니다. 파일 이름이 곧 주소가 됩니다.

```
src/content/blog/my-post.md  →  /blog/my-post/
```

한글 파일명도 되지만, 주소가 지저분해지니 영문 소문자와 하이픈을 쓰는 편이 낫습니다.

## frontmatter 옵션

파일 맨 위 `---` 사이에 들어가는 값들입니다.

| 항목 | 필수 | 설명 |
| --- | --- | --- |
| `title` | ✅ | 글 제목 |
| `description` | ✅ | 목록과 검색 결과, 링크 공유 시 보이는 요약 |
| `pubDate` | ✅ | 작성일. `'2026-08-06'` 형식 |
| `updatedDate` | | 수정일. 넣으면 제목 위에 함께 표시됩니다 |
| `tags` | | `['astro', 'css']` 처럼 배열로 |
| `heroImage` | | 대표 이미지. `'../../assets/파일명.jpg'` 상대경로 |
| `draft` | | `true`면 배포된 사이트에서 숨겨집니다 |

`draft: true`인 글은 로컬 개발 서버에서는 그대로 보이고, 실제 배포에서만 빠집니다. 쓰다 만 글을
안심하고 push해 둘 수 있습니다.

## 미리 보기

```bash
npm run dev
```

`http://localhost:4321` 에서 확인합니다. 파일을 저장하면 브라우저가 알아서 갱신됩니다.

배포 전에 실제 빌드가 깨지지 않는지 보려면:

```bash
npm run build && npm run preview
```

## 배포

`main` 브랜치에 push하면 끝입니다.

```bash
git add .
git commit -m "새 글 추가"
git push
```

GitHub 저장소의 **Actions** 탭에서 진행 상황을 볼 수 있습니다. 초록불이 들어오면 사이트에
반영된 것입니다.

## 이미지 넣기

`src/assets/` 에 이미지를 두고 마크다운에서 상대경로로 참조하면 Astro가 자동으로 최적화합니다.

```markdown
![설명](../../assets/screenshot.png)
```

`public/` 에 넣으면 최적화 없이 그대로 서빙됩니다. 파비콘처럼 손대면 안 되는 파일만 여기에 둡니다.
