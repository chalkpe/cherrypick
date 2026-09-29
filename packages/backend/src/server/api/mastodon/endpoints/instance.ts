/*
 * SPDX-FileCopyrightText: marie and other Sharkey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_MAX_IMAGE_COMMENT_LENGTH, FILE_TYPE_BROWSERSAFE, MAX_NOTE_TEXT_LENGTH } from '@/const.js';
import type { Config } from '@/config.js';
import { DI } from '@/di-symbols.js';
import type { MiMeta } from '@/models/_.js';
import { MastodonConverters } from '@/server/api/mastodon/MastodonConverters.js';
import { MastodonClientService } from '@/server/api/mastodon/MastodonClientService.js';
import { RoleService } from '@/core/RoleService.js';
import type { FastifyInstance } from 'fastify';
import type { MastodonEntity } from 'megalodon';

@Injectable()
export class ApiInstanceMastodon {
	constructor(
		@Inject(DI.meta)
		private readonly meta: MiMeta,

		@Inject(DI.config)
		private readonly config: Config,

		private readonly mastoConverters: MastodonConverters,
		private readonly clientService: MastodonClientService,
		private readonly roleService: RoleService,
	) {}

	// Mastodon clients append /api/v1/streaming to this URL.
	private get streamingUrl(): string {
		return this.config.url.replace(/^http/, 'ws').replace(/\/$/, '');
	}

	// "like Akkoma" makes clients enable the Pleroma-family extensions such as emoji reactions.
	private get version(): string {
		return `3.0.0 (compatible; CherryPick ${this.config.version}; like Akkoma)`;
	}

	public register(fastify: FastifyInstance): void {
		fastify.get('/v1/instance', async (_request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(_request);
			const data = await client.getInstance();
			const contact = this.meta.rootUser != null
				? await this.mastoConverters.convertAccount(this.meta.rootUser)
				: null;
			const roles = await this.roleService.getUserPolicies(me?.id ?? null);

			const instance = data.data;
			const response: MastodonEntity.Instance = {
				uri: this.config.host,
				title: this.meta.name || 'CherryPick',
				description: this.meta.description || '',
				email: instance.email || '',
				version: this.version,
				urls: {
					streaming_api: this.streamingUrl,
				},
				stats: {
					user_count: instance.stats.user_count,
					status_count: instance.stats.status_count,
					domain_count: instance.stats.domain_count,
				},
				thumbnail: this.meta.backgroundImageUrl || '/static-assets/transparent.png',
				languages: this.meta.langs,
				registrations: !this.meta.disableRegistration || instance.registrations,
				approval_required: this.meta.approvalRequiredForSignup,
				invites_enabled: instance.registrations,
				configuration: {
					accounts: {
						max_featured_tags: 20,
						max_pinned_statuses: roles.pinLimit,
					},
					statuses: {
						max_characters: MAX_NOTE_TEXT_LENGTH,
						max_media_attachments: 16,
						characters_reserved_per_url: instance.uri.length,
					},
					media_attachments: {
						supported_mime_types: FILE_TYPE_BROWSERSAFE,
						image_size_limit: 10485760,
						image_matrix_limit: 16777216,
						video_size_limit: 41943040,
						video_frame_limit: 60,
						video_matrix_limit: 2304000,
					},
					polls: {
						max_options: 10,
						max_characters_per_option: 150,
						min_expiration: 50,
						max_expiration: 2629746,
					},
					reactions: {
						max_reactions: 1,
					},
				},
				contact_account: contact,
				rules: instance.rules ?? [],
			};

			return reply.send(response);
		});

		fastify.get('/v2/instance', async (_request, reply) => {
			const { client, me } = await this.clientService.getAuthClient(_request);
			const [data, contact, roles] = await Promise.all([
				client.getInstance(),
				this.meta.rootUser != null
					? this.mastoConverters.convertAccount(this.meta.rootUser)
					: null,
				this.roleService.getUserPolicies(me?.id ?? null),
			]);

			const instance = data.data;
			const response: MastodonEntity.InstanceV2 = {
				domain: this.config.host,
				title: this.meta.name || 'CherryPick',
				version: this.version,
				source_url: this.meta.repositoryUrl,
				description: this.meta.description || '',
				usage: {
					users: {
						// Active user counts are not tracked, same as nodeinfo.
						active_month: 0,
					},
				},
				thumbnail: {
					url: this.meta.backgroundImageUrl || '/static-assets/transparent.png',
					blurhash: undefined,
					versions: {
						'@1x': this.meta.backgroundImageUrl || '/static-assets/transparent.png',
					},
				},
				icon: [
					{
						src: this.meta.app192IconUrl || '/static-assets/icons/192.png',
						size: '192x192',
					},
					{
						src: this.meta.app512IconUrl || '/static-assets/icons/512.png',
						size: '512x512',
					},
				],
				languages: this.meta.langs,
				configuration: {
					urls: {
						streaming: this.streamingUrl,
						status: null,
						about: this.config.url + '/about',
						privacy_policy: this.meta.privacyPolicyUrl,
						terms_of_service: this.meta.termsOfServiceUrl,
					},
					vapid: {
						// Only advertised while push notifications are enabled
						public_key: this.meta.enableServiceWorker ? this.meta.swPublicKey : null,
					},
					accounts: {
						max_featured_tags: 20,
						max_pinned_statuses: roles.pinLimit,
					},
					statuses: {
						max_characters: MAX_NOTE_TEXT_LENGTH,
						max_media_attachments: 16,
						characters_reserved_per_url: instance.uri.length,
					},
					media_attachments: {
						supported_mime_types: FILE_TYPE_BROWSERSAFE,
						description_limit: DB_MAX_IMAGE_COMMENT_LENGTH,
						image_size_limit: 10485760,
						image_matrix_limit: 16777216,
						video_size_limit: 41943040,
						video_frame_limit: 60,
						video_matrix_limit: 2304000,
					},
					polls: {
						max_options: 10,
						max_characters_per_option: 150,
						min_expiration: 50,
						max_expiration: 2629746,
					},
					reactions: {
						max_reactions: 1,
					},
					translation: {
						enabled: false,
					},
					timelines_access: {
						live_feeds: {
							local: this.meta.policies.ltlAvailable ? 'public' : 'disabled',
							remote: this.meta.policies.gtlAvailable ? 'public' : 'disabled',
						},
						hashtag_feeds: {
							local: 'public',
							remote: 'public',
						},
						trending_link_feeds: {
							local: 'disabled',
							remote: 'disabled',
						},
					},
					limited_federation: this.meta.federation !== 'all',
				},
				registrations: {
					enabled: !this.meta.disableRegistration || instance.registrations,
					approval_required: this.meta.approvalRequiredForSignup,
					reason_required: this.meta.approvalRequiredForSignup || null,
					message: null,
					min_age: null,
					url: null,
				},
				// 2 = grouped notifications (Mastodon 4.3)
				api_versions: { mastodon: 2 },
				contact: {
					email: instance.email || '',
					account: contact,
				},
				rules: instance.rules ?? [],
			};

			return reply.send(response);
		});
	}
}
