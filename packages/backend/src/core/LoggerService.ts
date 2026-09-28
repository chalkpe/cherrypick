/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Logging } from '@google-cloud/logging';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import Logger from '@/logger.js';
import { configureCloudLogging } from '@/logging/logging-runtime.js';
import { bindThis } from '@/decorators.js';
import type { Keyword } from 'color-convert';

@Injectable()
export class LoggerService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.cloudLogging)
		private cloudLogging: Logging | null,
	) {
		if (this.cloudLogging) {
			configureCloudLogging(this.cloudLogging.log(this.config.cloudLogging?.logName ?? 'cherrypick'));
		}
	}

	@bindThis
	public getLogger(domain: string, color?: Keyword | undefined) {
		return new Logger(domain, color);
	}
}
