/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test, vi } from 'vitest';
import { isVNode } from 'vue';
import { createMfmRenderer } from '@@/js/mfm-renderer.js';
import type { MfmBaseProps, MfmRendererConfig } from '@@/js/mfm-renderer.js';

// happy-dom omits compatMode; both client HTML templates use standards mode.
// Temml checks this browser property at import time.
vi.hoisted(() => {
	Object.defineProperty(window.document, 'compatMode', { configurable: true, value: 'CSS1Compat' });
});

// happy-dom also lacks MathMLElement.style. Keep real Temml parsing and MathML
// output, using its string renderer to bridge the missing browser DOM support.
vi.mock('temml', async importOriginal => {
	const { default: temml } = await importOriginal<typeof import('temml')>();
	return {
		default: {
			...temml,
			render(formula: string, element: HTMLElement, options: Parameters<typeof temml.render>[2]) {
				element.innerHTML = temml.renderToString(formula, options);
			},
		},
	};
});

type RendererProps = MfmBaseProps & {
	enableEmojiMenu?: boolean;
	enableEmojiMenuReaction?: boolean;
};

const stub = () => null;
const components = () => ({
	Url: stub,
	Link: stub,
	Mention: stub,
	A: stub,
	Time: stub,
	Emoji: stub,
	CustomEmoji: stub,
});

function render(props: RendererProps, config: Partial<MfmRendererConfig> = {}) {
	const renderer = createMfmRenderer<RendererProps>({ components, ...config });
	const root = renderer(props, { emit: vi.fn() });
	if (!Array.isArray(root?.children)) throw new Error('Expected rendered MFM children');
	return root.children;
}

describe('shared MFM renderer', () => {
	test.each([
		['\\(x^2\\)', 'span', false],
		['\\[\nx^2\n\\]', 'div', true],
	] as const)('renders %s as MathML', (text, tag, block) => {
		const [node] = render({ text });
		if (!isVNode(node)) throw new Error('Expected a math node');
		expect(node.type).toBe(tag);
		const element = window.document.createElement('div');
		element.innerHTML = node.props?.innerHTML;
		expect(element.querySelector('math msup')).not.toBeNull();
		expect(element.querySelector('math')?.getAttribute('display') === 'block').toBe(block);
	});

	test('renders fade with its speed and delay when the full client supports it', () => {
		const [node] = render({ text: '$[fade.speed=2s,delay=1s fading]' }, { supports: { fade: true } });
		if (!isVNode(node)) throw new Error('Expected an animation node');
		expect(node.props?.style).toContain('animation: mfm-fade 2s');
		expect(node.props?.style).toContain('animation-delay: 1s');
		expect(node.children).toEqual(['fading']);
	});

	test('keeps fade content readable when animations are disabled', () => {
		expect(render({ text: '$[fade fading]' }, {
			supports: { fade: true },
			getOptions: () => ({ advancedMfm: true, animatedMfm: false }),
		})).toEqual(['fading']);
	});

	test('keeps the embed fade fallback without exposing MFM markup', () => {
		expect(render({ text: '$[fade fading]' })).toEqual(['fading']);
	});

	test('retains the remote emoji reaction menu in the full client', () => {
		const [node] = render({
			text: ':wave:',
			author: { id: 'alice', username: 'alice', host: 'remote.example' } as MfmBaseProps['author'],
			emojiUrls: { wave: 'https://remote.example/wave.webp' },
			enableEmojiMenu: true,
			enableEmojiMenuReaction: true,
		}, { supports: { emojiMenu: true } });
		if (!isVNode(node)) throw new Error('Expected an emoji node');
		expect(node.props).toMatchObject({
			host: 'remote.example',
			url: 'https://remote.example/wave.webp',
			menu: true,
			menuReaction: true,
		});
	});

	test('passes mention clicks to the client handler without adding one to embeds', () => {
		const onMentionClick = vi.fn((ev: MouseEvent) => ev.preventDefault());
		const [node] = render({ text: '@alice' }, { onMentionClick });
		if (!isVNode(node)) throw new Error('Expected a mention node');
		const event = new MouseEvent('click', { cancelable: true });
		node.props?.onClick(event);
		expect(onMentionClick).toHaveBeenCalledWith(event);
		expect(event.defaultPrevented).toBe(true);

		const [embedNode] = render({ text: '@alice' });
		if (!isVNode(embedNode)) throw new Error('Expected a mention node');
		expect(embedNode.props?.onClick).toBeUndefined();
	});
});
