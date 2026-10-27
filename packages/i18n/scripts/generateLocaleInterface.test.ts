/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';
import { createMemberType } from './generateLocaleInterface.js';

test('deduplicates repeated interpolation names in the generated type', () => {
	const type = createMemberType('{host} and {host} for {name}');
	const source = ts.createSourceFile('test.ts', '', ts.ScriptTarget.Latest);
	assert.equal(ts.createPrinter().printNode(ts.EmitHint.Unspecified, type, source), 'ParameterizedString<"host" | "name">');
});
