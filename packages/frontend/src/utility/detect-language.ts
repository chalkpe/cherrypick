/*
 * SPDX-FileCopyrightText: noridev and cherrypick-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { detect } from 'tinyld';
import * as mfm from 'mfc-js';
import type { Note } from 'cherrypick-js/entities.js';

export default function detectLanguage(text: string): string {
	const nodes = mfm.parse(text);
	const filtered = mfm.extract(nodes, (node) => {
		return node.type === 'text' || node.type === 'quote';
	});
	const purified = mfm.toString(filtered);

	return detect(purified);
}

export function isForeignNoteLanguage(note: Pick<Note, 'text' | 'poll'>, targetLang: string): boolean {
	if (!note.text) return false;
	const postLang = detectLanguage(note.text);
	if (postLang !== '' && postLang !== targetLang) return true;
	if (!note.poll) return false;
	const pollLang = detectLanguage(note.poll.choices.map(choice => choice.text).join(' '));
	return pollLang !== '' && pollLang !== targetLang;
}
