/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { getHTMLElementOrNull } from '@/utility/get-dom-node-or-null.js';

type FocusTrapOptions = {
	hasInteractionWithOtherFocusTrappedEls: boolean;
	// Only the siblings inside this element are made inert (the rest of the page stays usable).
	boundary: HTMLElement | null;
};

// Trapped elements in the order they were trapped.
const focusTrapElements = new Map<HTMLElement, FocusTrapOptions>();
// Every element made inert by a trap. Releasing any trap clears these and re-applies the
// remaining traps, so closing a lower trap under a popup (or a host that is no longer in
// the document) never leaves part of the page inert.
const inertElements = new Set<HTMLElement>();
const ignoreElements = [
	'script',
	'style',
];

function containsFocusTrappedElements(el: HTMLElement): boolean {
	return Array.from(focusTrapElements.keys()).some((focusTrapElement) => {
		return el.contains(focusTrapElement);
	});
}

function getZIndex(el: HTMLElement): number {
	const zIndex = parseInt(window.getComputedStyle(el).zIndex || '0', 10);
	if (isNaN(zIndex)) {
		return 0;
	}
	return zIndex;
}

function applyFocusTrap(el: HTMLElement, { hasInteractionWithOtherFocusTrappedEls, boundary }: FocusTrapOptions): void {
	for (let current = el; ; current = current.parentElement) {
		if (current.inert === true) {
			current.inert = false;
		}
		if (current.parentElement == null || current === window.document.body || current === boundary) break;

		current.parentElement.childNodes.forEach((siblingNode) => {
			const siblingEl = getHTMLElementOrNull(siblingNode);
			if (!siblingEl) return;
			if (
				siblingEl !== current && (!hasInteractionWithOtherFocusTrappedEls || (!focusTrapElements.has(siblingEl) && !containsFocusTrappedElements(siblingEl))) &&
				!ignoreElements.includes(siblingEl.tagName.toLowerCase())
			) {
				siblingEl.inert = true;
				inertElements.add(siblingEl);
			}
		});
	}
}

function refreshFocusTraps(): void {
	for (const el of inertElements) {
		el.inert = false;
	}
	inertElements.clear();

	// Apply from the lowest to the highest z-index so the topmost trap wins.
	// Ties keep the trap order, so the latest one is applied last.
	const traps = Array.from(focusTrapElements)
		.filter(([el]) => el.isConnected)
		.map(([el, options], index) => ({ el, options, index, zIndex: getZIndex(el) }))
		.sort((a, b) => a.zIndex - b.zIndex || a.index - b.index);
	for (const trap of traps) {
		applyFocusTrap(trap.el, trap.options);
	}
}

export function focusTrap(el: HTMLElement, hasInteractionWithOtherFocusTrappedEls = false, boundary: HTMLElement | null = null): { release: () => void; } {
	focusTrapElements.delete(el);
	focusTrapElements.set(el, { hasInteractionWithOtherFocusTrappedEls, boundary });
	refreshFocusTraps();

	let released = false;
	return {
		release: () => {
			if (released) return;
			released = true;
			focusTrapElements.delete(el);
			if (el.inert === true) {
				el.inert = false;
			}
			refreshFocusTraps();
		},
	};
}
