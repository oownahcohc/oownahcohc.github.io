import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const blog = defineCollection({
	// `src/content/blog/` 안의 Markdown / MDX 파일을 읽어옵니다.
	loader: glob({ base: './src/content/blog', pattern: '**/*.{md,mdx}' }),
	// frontmatter 타입 검사
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// 문자열을 Date 객체로 변환
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: z.optional(image()),
			tags: z.array(z.string()).default([]),
			// 시리즈에 속한 글. id 는 consts.ts 의 SERIES 키, order 는 시리즈 안에서 읽는 순서(1부터),
			// label 은 시리즈 목록에 보일 짧은 이름입니다(없으면 제목을 그대로 씁니다).
			series: z
				.object({
					id: z.string(),
					order: z.number().int().positive(),
					label: z.string().optional(),
				})
				.optional(),
			// true면 배포된 사이트에 노출되지 않습니다 (로컬 dev에서는 보입니다).
			draft: z.boolean().default(false),
		}),
});

export const collections = { blog };
