/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { Packed } from '@/misc/json-schema.js';

// 장식 주소는 Web Push 크기 한도를 넘을 수 있으므로 싣지 않고, 장식이 없다는 사실만 알려 SW의 추가 조회를 줄인다.
export function compactChatRoomForPush(room: Packed<'ChatRoom'>) {
	return {
		id: room.id,
		name: room.name,
		iconUrl: room.iconUrl,
		...(room.iconDecorations?.length === 0 ? { iconDecorations: [] } : {}),
		owner: { host: room.owner.host },
	};
}
