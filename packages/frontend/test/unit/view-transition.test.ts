/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterEach, describe, expect, test, vi } from 'vitest';
import { startViewTransition } from '@/utility/view-transition.js';

// lib.dom では startViewTransition が必須プロパティなので、テストで差し替えられるよう緩い型で扱う
const doc = window.document as unknown as { startViewTransition?: (update: () => void | Promise<void>) => ViewTransition; visibilityState: DocumentVisibilityState };
const originalStart = doc.startViewTransition;
const originalVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

function setVisibility(state: DocumentVisibilityState) {
	Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => state });
}

function fakeTransition(update: () => void | Promise<void>, reason?: unknown): ViewTransition {
	const done = Promise.resolve().then(update);
	const rejected = () => Promise.reject(reason);
	return {
		ready: reason === undefined ? Promise.resolve() : rejected(),
		updateCallbackDone: done,
		finished: reason === undefined ? done : rejected(),
		skipTransition: () => {},
		types: new Set<string>(),
	} as unknown as ViewTransition;
}

afterEach(() => {
	doc.startViewTransition = originalStart;
	if (originalVisibility) Object.defineProperty(Document.prototype, 'visibilityState', originalVisibility);
	delete (window.document as unknown as { visibilityState?: unknown }).visibilityState;
});

describe('startViewTransition', () => {
	test('runs the update directly when the browser has no view transitions', () => {
		doc.startViewTransition = undefined;
		const update = vi.fn();
		startViewTransition(update);
		expect(update).toHaveBeenCalledTimes(1);
	});

	test('skips the transition and just updates while the document is hidden', () => {
		const start = vi.fn(fakeTransition);
		doc.startViewTransition = start;
		setVisibility('hidden');
		const update = vi.fn();
		startViewTransition(update);
		expect(start).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledTimes(1);
	});

	test('uses the browser transition while visible', async () => {
		const start = vi.fn(fakeTransition);
		doc.startViewTransition = start;
		setVisibility('visible');
		const update = vi.fn();
		startViewTransition(update);
		expect(start).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		expect(update).toHaveBeenCalledTimes(1);
	});

	// 非表示になった瞬間などにスキップされたトランジションは ready / finished が reject する。放置すると unhandledrejection になり、起動中なら boot のエラー画面が出る
	test('swallows the rejection of a skipped transition', async () => {
		const reason = new DOMException('Transition was aborted because of invalid state', 'InvalidStateError');
		doc.startViewTransition = vi.fn((update: () => void | Promise<void>) => fakeTransition(update, reason));
		setVisibility('visible');
		const unhandled = vi.fn();
		process.on('unhandledRejection', unhandled);
		try {
			startViewTransition(() => {});
			await new Promise(resolve => setTimeout(resolve, 10));
		} finally {
			process.off('unhandledRejection', unhandled);
		}
		expect(unhandled).not.toHaveBeenCalled();
	});

	test('falls back to a plain update when starting the transition throws', () => {
		doc.startViewTransition = vi.fn(() => { throw new DOMException('nope', 'InvalidStateError'); });
		setVisibility('visible');
		const update = vi.fn();
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		try {
			startViewTransition(update);
		} finally {
			error.mockRestore();
		}
		expect(update).toHaveBeenCalledTimes(1);
	});

	// テーマの切り替えのように、トランジションが終わってから後始末 (クラスを外す・イベントを発する) をしたい呼び出し元のための onDone
	describe('onDone', () => {
		const settle = () => new Promise(resolve => setTimeout(resolve, 10));

		test('runs once after the transition has finished, not before', async () => {
			doc.startViewTransition = vi.fn(fakeTransition);
			setVisibility('visible');
			const order: string[] = [];
			startViewTransition(() => { order.push('update'); }, { onDone: () => order.push('done') });
			expect(order).toEqual([]);
			await settle();
			expect(order).toEqual(['update', 'done']);
		});

		test('still runs exactly once when the transition was skipped and its promises rejected', async () => {
			const reason = new DOMException('Transition was aborted because of invalid state', 'InvalidStateError');
			doc.startViewTransition = vi.fn((update: () => void | Promise<void>) => fakeTransition(update, reason));
			setVisibility('visible');
			const onDone = vi.fn();
			const unhandled = vi.fn();
			process.on('unhandledRejection', unhandled);
			try {
				startViewTransition(() => {}, { onDone });
				await settle();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
			expect(onDone).toHaveBeenCalledTimes(1);
			expect(unhandled).not.toHaveBeenCalled();
		});

		// 更新のコールバックが throw すると updateCallbackDone が reject する。それも握りつぶし、後始末は必ず行う
		test('swallows a rejected update callback and still runs once', async () => {
			const reason = new Error('update failed');
			doc.startViewTransition = vi.fn((update: () => void | Promise<void>) => {
				// 本物のブラウザと同じく、三つの約束は別々のオブジェクト
				const done = Promise.resolve().then(update).then(() => Promise.reject(reason));
				return { ready: Promise.resolve(), updateCallbackDone: done.then(() => {}), finished: done.then(() => {}), skipTransition: () => {}, types: new Set<string>() } as unknown as ViewTransition;
			});
			setVisibility('visible');
			const onDone = vi.fn();
			const unhandled = vi.fn();
			process.on('unhandledRejection', unhandled);
			try {
				startViewTransition(() => {}, { onDone });
				await settle();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
			expect(onDone).toHaveBeenCalledTimes(1);
			expect(unhandled).not.toHaveBeenCalled();
		});

		test('runs right after a synchronous update when the browser has no view transitions', () => {
			doc.startViewTransition = undefined;
			const order: string[] = [];
			startViewTransition(() => { order.push('update'); }, { onDone: () => order.push('done') });
			expect(order).toEqual(['update', 'done']);
		});

		test('waits for an asynchronous update while the document is hidden', async () => {
			doc.startViewTransition = vi.fn(fakeTransition);
			setVisibility('hidden');
			let finish!: () => void;
			const onDone = vi.fn();
			startViewTransition(() => new Promise<void>(resolve => { finish = resolve; }), { onDone });
			await settle();
			expect(onDone).not.toHaveBeenCalled();
			finish();
			await settle();
			expect(onDone).toHaveBeenCalledTimes(1);
		});

		test('runs even when the fallback update rejects, without an unhandled rejection', async () => {
			doc.startViewTransition = undefined;
			const onDone = vi.fn();
			const unhandled = vi.fn();
			process.on('unhandledRejection', unhandled);
			try {
				startViewTransition(() => Promise.reject(new Error('update failed')), { onDone });
				await settle();
			} finally {
				process.off('unhandledRejection', unhandled);
			}
			expect(onDone).toHaveBeenCalledTimes(1);
			expect(unhandled).not.toHaveBeenCalled();
		});

		test('runs after the plain update when starting the transition throws', () => {
			doc.startViewTransition = vi.fn(() => { throw new DOMException('nope', 'InvalidStateError'); });
			setVisibility('visible');
			const order: string[] = [];
			const error = vi.spyOn(console, 'error').mockImplementation(() => {});
			try {
				startViewTransition(() => { order.push('update'); }, { onDone: () => order.push('done') });
			} finally {
				error.mockRestore();
			}
			expect(order).toEqual(['update', 'done']);
		});
	});
});
