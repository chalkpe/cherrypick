/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import _Ajv from 'ajv';
import { Schema, SchemaType } from '@/misc/json-schema.js';

const Ajv = _Ajv.default;

// i/export-clips が書き出す JSON のうち、インポートに必要な部分だけを検証する
const exportedClipNoteSchema = {
	type: 'object',
	properties: {
		note: {
			type: 'object',
			properties: {
				id: { type: 'string' },
				uri: { type: 'string', nullable: true },
			},
			required: ['id'],
		},
	},
	required: ['note'],
} as const satisfies Schema;

export const exportedClipsSchema = {
	type: 'array',
	items: {
		type: 'object',
		properties: {
			name: { type: 'string', minLength: 1, maxLength: 100 },
			description: { type: 'string', nullable: true, maxLength: 2048 },
			clipNotes: { type: 'array', items: exportedClipNoteSchema },
		},
		required: ['name', 'clipNotes'],
	},
} as const satisfies Schema;

export type ExportedClips = SchemaType<typeof exportedClipsSchema>;
export type ExportedClipNote = ExportedClips[number]['clipNotes'][number]['note'];

export const validateExportedClips = new Ajv().compile<ExportedClips>(exportedClipsSchema);
