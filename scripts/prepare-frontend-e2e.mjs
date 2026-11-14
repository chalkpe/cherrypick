/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dump, load } from 'js-yaml';

const config = load(await readFile(new URL('../.github/cherrypick/test.yml', import.meta.url), 'utf8'));
config.url = 'http://localhost:61812';
await writeFile(new URL('../.config/frontend-e2e.yml', import.meta.url), dump(config));
