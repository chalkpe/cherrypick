/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { MiNoteDeleteReceipt, isDeliverySettledNoteDeleteReceipt } from '@/models/NoteDeleteReceipt.js';
import type { NoteDeletePayload } from '@/models/NoteDeleteReceipt.js';
import { activityPubDigest, serializeActivityPub } from '@/misc/activitypub-payload.js';

@Injectable()
export class NoteDeletePayloadService {
	constructor(
		@Inject(DI.db) private db: DataSource,
		private apRendererService: ApRendererService,
	) {}

	// 키 조회와 LD 서명은 삭제 및 확정 transaction 밖에서만 수행한다.
	@bindThis
	public async prepareRelaySignedPayload(noteId: string, ownerUserId: string): Promise<NoteDeletePayload | null> {
		const receipts = this.db.manager.getRepository(MiNoteDeleteReceipt);
		const receipt = await receipts.findOneBy({ noteId, userId: ownerUserId });
		if (!receipt || isDeliverySettledNoteDeleteReceipt(receipt)) return null;
		if (receipt.snapshot.version !== 1) throw new Error('unsupported delete receipt snapshot');
		if (receipt.noteId !== noteId || receipt.userId !== ownerUserId || receipt.snapshot.actor.id !== ownerUserId) return null;
		const plan = receipt.snapshot.delivery;
		if (plan.version !== 2) return null;
		if (plan.relaySigned) return plan.relaySigned;
		if (!plan.relayUnsigned || plan.relays.length === 0) return null;
		if (activityPubDigest(plan.relayUnsigned.content) !== plan.relayUnsigned.digest) throw new Error('invalid delete relay payload');
		const signed = serializeActivityPub(await this.apRendererService.attachLdSignature(
			JSON.parse(plan.relayUnsigned.content), { id: ownerUserId, host: null },
		));

		return this.db.manager.transaction(async manager => {
			const repository = manager.getRepository(MiNoteDeleteReceipt);
			const current = await repository.findOne({ where: { noteId, userId: ownerUserId }, lock: { mode: 'pessimistic_write' } });
			if (!current || isDeliverySettledNoteDeleteReceipt(current)) return null;
			if (current.snapshot.version !== 1) throw new Error('unsupported delete receipt snapshot');
			if (current.snapshot.actor.id !== ownerUserId) return null;
			const delivery = current.snapshot.delivery;
			if (delivery.relaySigned) return delivery.relaySigned;
			if (delivery.version !== 2 || delivery.relayUnsigned?.digest !== plan.relayUnsigned?.digest || delivery.relayUnsigned?.content !== plan.relayUnsigned?.content || delivery.relays.length === 0) return null;
			// 잠금 뒤의 최신 snapshot만 병합하고 effects 열은 건드리지 않는다.
			await repository.update({ noteId, userId: ownerUserId }, {
				snapshot: { ...current.snapshot, delivery: { ...delivery, relaySigned: signed } },
			});
			return signed;
		});
	}
}
