// @ts-check

import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	// GitHub Pages 사용자 사이트 주소. 커스텀 도메인을 붙이면 이 값을 바꾸세요.
	site: 'https://oownahcohc.github.io',
	integrations: [mdx(), sitemap()],
	markdown: {
		shikiConfig: {
			theme: 'github-dark',
			wrap: false,
		},
	},
});
