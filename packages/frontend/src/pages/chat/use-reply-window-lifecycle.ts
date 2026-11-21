/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { onDeactivated, watch } from 'vue';
import type { Ref } from 'vue';

/**
 * 원문 창은 현재 채팅 페이지의 생명주기 안에서만 유지한다.
 * 창 안 링크가 어떤 방식(전파를 막는 링크 포함)으로 이동하든, 이 페이지가 KeepAlive로 비활성화되거나
 * 스택 라우터에서 맨 앞이 아니게 되면 창을 닫는다.
 */
export function useReplyWindowLifecycle(close: () => void, isFrontmost: Ref<boolean>) {
	onDeactivated(close);
	watch(isFrontmost, (frontmost, wasFrontmost) => {
		if (!frontmost && wasFrontmost) close();
	});
}
