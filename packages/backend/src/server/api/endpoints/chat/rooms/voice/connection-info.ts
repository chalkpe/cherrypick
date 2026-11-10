/*
 * SPDX-FileCopyrightText: Chalk <chalkpe@gmail.com>
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
import { RemoteVoiceCallService } from '@/core/RemoteVoiceCallService.js';
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

	res: { type: 'object', optional: false, nullable: false, properties: { mediaProvider: { type: 'string', optional: true, nullable: false } } },

	errors: {
		relayFull: { message: 'Voice relay capacity is full.', code: 'VOICE_RELAY_CAPACITY_EXCEEDED', id: 'b9e28d8d-2671-4e8f-80e6-ab0a549cbef4' },
		relayUnreachable: { message: 'Could not reach the voice relay.', code: 'VOICE_RELAY_UNREACHABLE', id: '7e3f0054-c977-4bbe-864e-8af3c8213d3a' },
		relayRevoked: { message: 'Voice relay approval or credentials are no longer valid.', code: 'VOICE_RELAY_REVOKED', id: 'd2d8a5d6-e0c6-4a64-9741-6287b9dd4eb9' },
		noSuchRoom: {
			message: 'No such room.',
			code: 'NO_SUCH_ROOM',
			id: 'ed7c59c0-e99b-4d47-963a-342f91e85000',
		},
		voiceCallUnavailable: {
			message: 'Voice calls are not available.',
			code: 'VOICE_CALL_UNAVAILABLE',
			id: '6248536e-fa16-4594-89a2-35204c0aef1b',
		},
		remoteHostUnsupported: {
			message: 'The server that owns this room does not support voice calls.',
			code: 'REMOTE_HOST_UNSUPPORTED',
			id: 'cfa8efd5-09ca-4056-9202-a8696fc912ab',
		},
		remoteHostUnreachable: {
			message: 'Could not get a voice call token from the server that owns this room.',
			code: 'REMOTE_HOST_UNREACHABLE',
			id: 'b1bb45c5-a552-4aaa-8729-b6d9e944e646',
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

			// 通話に残れるか (ChatVoiceService の admissionOf) と同じく、削除されたユーザーには発行しない
			if (room.isArchived || me.isDeleted) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			const policies = await this.roleService.getUserPolicies(me.id);
			if (!policies.canVoiceCall) {
				throw new ApiError(meta.errors.voiceCallUnavailable);
			}

			if (remoteOwner == null) {
				try { await this.chatVoiceService.ensureCallRoom(room.id); return { mediaProvider: (await this.liveKitService.connectionInfo(room.id)).mediaProvider }; } catch (error) { if (error instanceof VoiceRelayError) throw new ApiError(error.code === 'CAPACITY_EXCEEDED' ? meta.errors.relayFull : [401, 403].includes(error.status) ? meta.errors.relayRevoked : meta.errors.relayUnreachable); throw error; }
			}

			return {};
		});
	}
}
