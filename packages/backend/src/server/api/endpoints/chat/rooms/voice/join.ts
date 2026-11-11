/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import ms from 'ms';
import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import type { ChatRoomMembershipsRepository } from '@/models/_.js';
import { ChatService } from '@/core/ChatService.js';
import { ChatVoiceService } from '@/core/ChatVoiceService.js';
import { VoiceBackendService as LiveKitService } from '@/core/VoiceBackendService.js';
import { RoleService } from '@/core/RoleService.js';
import { RemoteVoiceCallError, RemoteVoiceCallService } from '@/core/RemoteVoiceCallService.js';
import type { MiRemoteUser } from '@/models/User.js';
import { VoiceRelayError } from '@/core/VoiceRelayClient.js';
import { ApiError } from '@/server/api/error.js';

export const meta = {
	tags: ['chat'],

	requireCredential: true,

	kind: 'write:chat',

	limit: {
		duration: ms('1minute'),
		max: 30,
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			mediaProvider: { type: 'string', optional: true, nullable: false },
			screenShareLimits: {
				type: 'object', optional: true, nullable: false,
				properties: {
					maxWidth: { type: 'integer', optional: false, nullable: false },
					maxHeight: { type: 'integer', optional: false, nullable: false },
					maxFrameRate: { type: 'integer', optional: false, nullable: false },
					maxBitrate: { type: 'integer', optional: false, nullable: false },
				},
			},
			url: {
				type: 'string',
				optional: false, nullable: false,
			},
			token: {
				type: 'string',
				optional: false, nullable: false,
			},
			// 通話を開くサーバーの TURN (設定されていなければ null)。ブラウザはこれを LiveKit が渡すものの代わりに使う
			iceServers: {
				type: 'array',
				optional: false, nullable: true,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						urls: {
							type: 'array',
							optional: false, nullable: false,
							items: {
								type: 'string',
								optional: false, nullable: false,
							},
						},
						username: {
							type: 'string',
							optional: true, nullable: false,
						},
						credential: {
							type: 'string',
							optional: true, nullable: false,
						},
					},
				},
			},
		},
	},

	errors: {
		relayFull: { message: 'Voice relay capacity is full.', code: 'VOICE_RELAY_CAPACITY_EXCEEDED', id: '15178244-c13a-4c16-991e-79aa7f49a7bd' },
		relayUnreachable: { message: 'Could not reach the voice relay.', code: 'VOICE_RELAY_UNREACHABLE', id: 'f4c54a69-59af-46e2-accd-fa4996c0e505' },
		relayRevoked: { message: 'Voice relay approval or credentials are no longer valid.', code: 'VOICE_RELAY_REVOKED', id: 'cc9a9ef3-a135-416b-b9b3-b59adde48708' },
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'ddc7cfd6-56be-41b2-83c6-22ce4e45b52a',
		},
		voiceCallUnavailable: {
			message: 'Voice calls are not available.',
			code: 'VOICE_CALL_UNAVAILABLE',
			id: '6467d072-503a-4ed0-b3ed-36c10637d298',
		},
		remoteHostUnsupported: {
			message: 'The server that owns this room does not support voice calls.',
			code: 'REMOTE_HOST_UNSUPPORTED',
			id: '72d62e31-06b4-4e99-9303-e2663cdbcbf6',
		},
		remoteHostUnreachable: {
			message: 'Could not get a voice call token from the server that owns this room.',
			code: 'REMOTE_HOST_UNREACHABLE',
			id: '5919264c-9150-4eec-9bbb-e31c25973f46',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roomId: { type: 'string', format: 'misskey:id' },
	},
	required: ['roomId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private chatService: ChatService,
		private chatVoiceService: ChatVoiceService,
		private liveKitService: LiveKitService,
		private roleService: RoleService,
		private remoteVoiceCallService: RemoteVoiceCallService,

		@Inject(DI.chatRoomMembershipsRepository)
		private chatRoomMembershipsRepository: ChatRoomMembershipsRepository,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (!this.liveKitService.isEnabled && !this.remoteVoiceCallService.isEnabled) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			// ルームと、そのメンバーであることを、渡された roomId で同時に読む。ルームがあるかどうかで読むものを変えず、
			// どちらかが読めなかったときも、ルームがあるかどうかで答えが変わらないようにする
			let room: Awaited<ReturnType<ChatService['findRoomById']>>;
			let hasMembership: boolean;
			try {
				[room, hasMembership] = await Promise.all([
					this.chatService.findRoomById(ps.roomId),
					this.chatRoomMembershipsRepository.exists({ where: { roomId: ps.roomId, userId: me.id } }),
				]);
			} catch (err) {
				// このサーバーに LiveKit が無ければ、読めなかったときも下と同じく最初に断る
				if (!this.liveKitService.isEnabled) throw new ApiError(meta.errors.voiceCallUnavailable);
				throw err;
			}
			const isMember = room != null && (room.ownerId === me.id || hasMembership);
			// 他のサーバーが持つルーム (ミラー) の通話はそのサーバーで開かれるので、このサーバーの LiveKit は使わない
			const remoteOwner = isMember && room != null && room.owner?.host != null ? room.owner as MiRemoteUser : null;

			// このサーバーに LiveKit が無ければ、入れるのはメンバーであるミラーの通話だけ。それ以外は他のサーバーの通話に対応する前と同じく、
			// まず断る。メンバーでない人には、ルームがあるかも、ミラーかも分からないようにする
			if (remoteOwner == null && !this.liveKitService.isEnabled) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			// 参加すると話せるので、チャットの書き込み権限を要求する
			await this.chatService.checkChatAvailability(me.id, 'write');

			if (room == null || !isMember) {
				throw new ApiError(meta.errors.noSuchRoom);
			}

			if (remoteOwner != null && !this.remoteVoiceCallService.isEnabled) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			// 通話に残れるか (ChatVoiceService の admissionOf) と同じく、停止・削除されたユーザーには発行しない
			if (room.isArchived || me.isDeleted || me.isSuspended) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.canVoiceCall) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}
			// Authentication may have returned a cached user; read current account and room permission before minting.
			if (!await this.chatVoiceService.canParticipantJoin(room.id, { identity: this.liveKitService.identityOf(me), userId: me.id, canScreenShare: policies.canScreenShare })) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			if (remoteOwner == null) {
				try { return await this.chatVoiceService.issueJoinToken(me, room, policies.canScreenShare); } catch (error) { if (error instanceof VoiceRelayError) throw new ApiError(['DIRECT_REMOVAL_PENDING', 'PARTICIPANT_REVOKED'].includes(error.code) ? meta.errors.voiceCallUnavailable : error.code === 'CAPACITY_EXCEEDED' ? meta.errors.relayFull : [401, 403].includes(error.status) ? meta.errors.relayRevoked : meta.errors.relayUnreachable); throw error; }
			}

			try {
				return await this.remoteVoiceCallService.requestJoin(me, room, remoteOwner, policies.canScreenShare);
			} catch (err) {
				if (err instanceof RemoteVoiceCallError) {
					switch (err.reason) {
						case 'unsupported': throw new ApiError(meta.errors.remoteHostUnsupported);
						case 'forbidden': throw new ApiError(meta.errors.voiceCallUnavailable);
						case 'unreachable': throw new ApiError(meta.errors.remoteHostUnreachable);
					}
				}
				throw err;
			}
		});
	}
}
