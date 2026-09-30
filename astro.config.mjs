// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// GitHub Pages 사용자 사이트 주소. 커스텀 도메인을 붙이면 이 값을 바꾸세요.
	site: 'https://oownahcohc.github.io',
	integrations: [mdx(), sitemap()],
	// `astro dev`와 `astro build`가 같은 Vite 의존성 캐시를 쓰면, 빌드가 Mermaid의
	// 지연 로딩 청크를 교체해 실행 중인 개발 서버가 504(Outdated Optimize Dep)를 낼 수 있습니다.
	vite: {
		cacheDir:
			process.env.NODE_ENV === 'development'
				? 'node_modules/.vite/dev'
				: 'node_modules/.vite/build',
		// Mermaid는 글 페이지의 동적 import로만 쓰여서, 개발 서버가 첫 방문 때에야 발견해 다시 번들합니다.
		// 그 순간 열려 있던 탭은 옛 청크 주소를 요청해 "Importing a module script failed"로 도표를 못 그립니다.
		// 서버를 띄울 때 미리 번들하도록 지정합니다.
		optimizeDeps: {
			include: ['mermaid'],
		},
	},
	markdown: {
		shikiConfig: {
			theme: 'github-dark',
			wrap: false,
		},
	},
});
