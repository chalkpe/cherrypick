/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { vi } from 'vitest';

// happy-dom は大きさを計算しないので、テストから幅を決められる ResizeObserver に差し替える
const observers = new Set<FakeResizeObserver>();

class FakeResizeObserver {
	callback: ResizeObserverCallback;
	targets = new Set<Element>();

	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		observers.add(this);
	}

	observe(el: Element) {
		this.targets.add(el);
	}

	unobserve(el: Element) {
		this.targets.delete(el);
	}

	disconnect() {
		this.targets.clear();
		observers.delete(this);
	}
}

export function installFakeResizeObserver() {
	vi.stubGlobal('ResizeObserver', FakeResizeObserver);
}

/** 監視されている要素 (target を渡せばその要素だけ) の中身の幅が width になったと知らせる */
export function resizeObserved(width: number, target?: Element) {
	for (const observer of observers) {
		for (const el of observer.targets) {
			if (target != null && el !== target) continue;
			observer.callback([{ target: el, contentRect: { width } } as unknown as ResizeObserverEntry], observer as unknown as ResizeObserver);
		}
	}
}
