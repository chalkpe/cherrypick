<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<MkModalWindow
	ref="dialog"
	:width="520"
	:height="560"
	@close="dialog?.close()"
	@closed="emit('closed')"
>
	<template #header>{{ i18n.ts._chat.replyOriginalTitle }}</template>
	<div class="_spacer" style="--MI_SPACER-min: 16px; --MI_SPACER-max: 24px;">
		<div class="_gaps" @click="onClick">
			<div v-for="message in ordered" :key="message.id" :ref="el => { if (message.id === originalId) originalEl = el as HTMLElement | null; }" :class="{ [$style.original]: message.id === originalId }">
				<XMessage :message="message" :canEdit="false" :canReply="false" :canJumpToReply="false" :roomArchived="roomArchived" :channels="channels"/>
			</div>
		</div>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { computed, nextTick, onMounted, useTemplateRef } from 'vue';
import type * as Misskey from 'cherrypick-js';
import type { NormalizedChatMessage } from './room.vue';
import XMessage from './XMessage.vue';
import MkModalWindow from '@/components/MkModalWindow.vue';
import { i18n } from '@/i18n.js';

// 목록에 합치지 않고 따로 보여 주므로, 불러온 타임라인에 구멍이 생기지 않는다
const props = defineProps<{
	/** 새 글이 앞에 오는 순서 */
	messages: NormalizedChatMessage[];
	originalId: string;
	roomArchived?: boolean;
	channels?: Misskey.entities.ChatRoomChannel[];
}>();

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const dialog = useTemplateRef('dialog');
const ordered = computed(() => props.messages.toReversed());
let originalEl = null as HTMLElement | null;

// 앞선 글을 남기되 첫 화면에서 원문이 가운데에 오도록 한다
onMounted(async () => {
	await nextTick();
	(originalEl as HTMLElement | null)?.scrollIntoView({ block: 'center' });
});

// 링크로 다른 화면이 열리면 창이 덮고 있지 않게 닫는다
function onClick(ev: MouseEvent) {
	if ((ev.target as HTMLElement | null)?.closest('a')) dialog.value?.close();
}
</script>

<style lang="scss" module>
.original {
	border-radius: var(--MI-radius);
	outline: 2px solid var(--MI_THEME-accent);
	outline-offset: 4px;
}
</style>
