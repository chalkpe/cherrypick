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
		<div class="_gaps">
			<div v-for="message in ordered" :key="message.id" :class="{ [$style.original]: message.id === originalId }">
				<XMessage :message="message" :canEdit="false" :canReply="false" :canJumpToReply="false"/>
			</div>
		</div>
	</div>
</MkModalWindow>
</template>

<script lang="ts" setup>
import { computed, useTemplateRef } from 'vue';
import type { NormalizedChatMessage } from './room.vue';
import XMessage from './XMessage.vue';
import MkModalWindow from '@/components/MkModalWindow.vue';
import { i18n } from '@/i18n.js';

// 목록에 합치지 않고 따로 보여 주므로, 불러온 타임라인에 구멍이 생기지 않는다
const props = defineProps<{
	/** 새 글이 앞에 오는 순서 */
	messages: NormalizedChatMessage[];
	originalId: string;
}>();

const emit = defineEmits<{
	(ev: 'closed'): void;
}>();

const dialog = useTemplateRef('dialog');
const ordered = computed(() => props.messages.toReversed());
</script>

<style lang="scss" module>
.original {
	border-radius: var(--MI-radius);
	outline: 2px solid var(--MI_THEME-accent);
	outline-offset: 4px;
}
</style>
