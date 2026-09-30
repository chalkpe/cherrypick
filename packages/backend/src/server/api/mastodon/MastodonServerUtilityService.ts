/*
 * SPDX-FileCopyrightText: hazelnoot and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import querystring from 'node:querystring';
import multipart from '@fastify/multipart';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { createTemp } from '@/misc/create-temp.js';
import { bindThis } from '@/decorators.js';
import { ApiError } from '@/server/api/error.js';
import type { Config } from '@/config.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';

export type SavedRequestFile = NonNullable<FastifyRequest['savedRequestFiles']>[number];

/**
 * Reads a file saved by the multipart hook below, for uploading it through the Misskey API.
 * Its stream has already been written to the temporary file, so the data has to come from there.
 */
export async function readSavedRequestFile(file: SavedRequestFile): Promise<File> {
	const buffer = await fs.promises.readFile(file.filepath);
	return new File([new Uint8Array(buffer)], file.filename || file.fieldname, {
		type: file.mimetype,
	});
}

// Profile updates carry an avatar and a header, and media uploads a thumbnail along with the file
const MAX_FILES = 4;

async function saveToTempFile(stream: NodeJS.ReadableStream & { truncated?: boolean }): Promise<string> {
	const [filepath, cleanup] = await createTemp();

	try {
		await pipeline(stream, fs.createWriteStream(filepath));
	} catch (e) {
		cleanup();
		throw e;
	}

	if (stream.truncated) {
		cleanup();
		throw new Error('Read failed: input stream truncated');
	}

	return filepath;
}

/**
 * Request parsing helpers shared by the Mastodon-compatible API routes
 */
@Injectable()
export class MastodonServerUtilityService {
	constructor(
		@Inject(DI.config)
		private readonly config: Config,
	) {}

	@bindThis
	public addMultipartFormDataContentType(fastify: FastifyInstance): void {
		// The number of files is limited in the hook below rather than by busboy,
		// whose files limit stops the file being read at that moment and leaves the request hanging
		fastify.register(multipart, {
			limits: {
				fileSize: this.config.maxFileSize,
			},
		});

		// Default behavior saves files to memory - we don't want that!
		// Store to temporary file instead, and copy the body fields while we're at it.
		fastify.addHook<{ Body?: Record<string, string | string[] | undefined> }>('preValidation', async request => {
			if (request.isMultipart()) {
				// We can't use saveRequestFiles() because it erases all the data fields.
				// Instead, recreate it manually.
				// https://github.com/fastify/fastify-multipart/issues/549

				let tooManyFiles = false;
				for await (const part of request.parts()) {
					if (part.type === 'field') {
						const k = part.fieldname;
						const v = part.value;
						const body = request.body ??= {};

						// Value can be string, buffer, or undefined.
						// We only support the first one.
						if (typeof(v) !== 'string') continue;

						// This is just progressive conversion from undefined -> string -> string[]
						const existing = body[k];
						if (!existing) {
							body[k] = v;
						} else if (Array.isArray(existing)) {
							existing.push(v);
						} else {
							body[k] = [existing, v];
						}
					} else { // Otherwise it's a file
						if ((request.savedRequestFiles?.length ?? 0) >= MAX_FILES) {
							// Read the rest of the request, so that it can be answered once the parts are done
							part.file.resume();
							tooManyFiles = true;
							continue;
						}

						try {
							const filepath = await saveToTempFile(part.file);

							const tmpUploads = (request.tmpUploads ??= []);
							tmpUploads.push(filepath);

							const requestSavedFiles = (request.savedRequestFiles ??= []);
							requestSavedFiles.push({
								...part,
								filepath,
							});
						} catch (e) {
							// Cleanup to avoid file leak in case of errors
							await request.cleanRequestFiles();
							request.tmpUploads = null;
							request.savedRequestFiles = null;
							throw e;
						}
					}
				}

				if (tooManyFiles) {
					await request.cleanRequestFiles();
					request.tmpUploads = null;
					request.savedRequestFiles = null;
					throw new ApiError({
						message: `A request can carry at most ${MAX_FILES} files.`,
						code: 'TOO_MANY_FILES',
						id: '79856fc3-0032-47af-b64c-e979960fd1d9',
						kind: 'client',
						httpStatusCode: 413,
					});
				}
			}
		});
	}

	@bindThis
	public addFormUrlEncodedContentType(fastify: FastifyInstance) {
		// Parsed as a string so that Fastify applies its body size limit, which it does not do for parsers reading the stream themselves
		fastify.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_, body, done) => {
			try {
				done(null, querystring.parse(body as string));
			} catch (e) {
				done(e as Error);
			}
		});
	}

	@bindThis
	public addCORS(fastify: FastifyInstance) {
		fastify.addHook('preHandler', (_, reply, done) => {
			// Allow web-based clients to connect from other origins.
			reply.header('Access-Control-Allow-Origin', '*');

			// Mastodon uses all types of request methods.
			reply.header('Access-Control-Allow-Methods', '*');

			// Allow web-based clients to access Link header - required for mastodon pagination.
			// https://docs.joinmastodon.org/api/guidelines/#pagination
			reply.header('Access-Control-Expose-Headers', 'Link');

			// Cache to avoid extra pre-flight requests
			reply.header('Access-Control-Max-Age', 60 * 60 * 24); // 1 day in seconds

			done();
		});
	}

	@bindThis
	public addFlattenedQueryType(fastify: FastifyInstance) {
		// Remove trailing "[]" from query params
		fastify.addHook<{ Querystring?: Record<string, string | string[] | undefined> }>('preValidation', (request, _reply, done) => {
			if (!request.query || typeof(request.query) !== 'object') {
				return done();
			}

			for (const key of Object.keys(request.query)) {
				if (!key.endsWith('[]')) {
					continue;
				}
				if (request.query[key] == null) {
					continue;
				}

				const newKey = key.substring(0, key.length - 2);
				const newValue = request.query[key];
				const oldValue = request.query[newKey];

				// Move the value to the correct key
				if (oldValue != null) {
					if (Array.isArray(oldValue)) {
						// Works for both array and single values
						request.query[newKey] = oldValue.concat(newValue);
					} else if (Array.isArray(newValue)) {
						// Preserve order
						request.query[newKey] = [oldValue, ...newValue];
					} else {
						// Preserve order
						request.query[newKey] = [oldValue, newValue];
					}
				} else {
					request.query[newKey] = newValue;
				}

				// Remove the invalid key
				delete request.query[key];
			}

			return done();
		});
	}
}
