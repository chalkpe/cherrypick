/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import * as Misskey from 'cherrypick-js';
import { useStream } from '@/stream.js';

// 招待・参加中・自分のルームの一覧。サーバーから変わったと知らされたときと、ストリームがつながり直したときに読み直す
export function useChatRoomList<T>(fetchItems: () => Promise<T[]>) {
	const fetching = ref(true);
	const items = shallowRef<T[]>([]);
	const stream = useStream();
	let connection: Misskey.IChannelConnection<Misskey.Channels['main']> | null = null;
	let latestRequest = 0;

	async function refresh() {
		const request = ++latestRequest;
		try {
			const result = await fetchItems();
			// 遅れて返ってきた古い一覧で、新しい一覧を置き換えない
			if (request !== latestRequest) return;
			items.value = result;
			fetching.value = false;
		} catch {
			// 次に知らされたときに読み直せるので、今の表示のままにする
		}
	}

	onMounted(() => {
		connection = stream.useChannel('main');
		connection.on('chatRoomListChanged', refresh);
		stream.on('_connected_', refresh);
		refresh();
	});

	onBeforeUnmount(() => {
		connection?.dispose();
		stream.off('_connected_', refresh);
	});

	return { items, fetching };
}
