<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<button type="button" class="_button" :class="$style.root" :aria-label="label" @click="emit('open')">
	<span :class="[$style.grid, { [$style.singleRow]: participants.length <= 2 }]">
		<MkAvatar v-for="p in participants.slice(0, 4)" :key="p.identity" :user="p.user" :link="false" :class="$style.avatar"/>
	</span>
	<span v-if="participants.length > 4" :class="$style.label">{{ i18n.tsx._voiceCall.otherParticipants({ n: participants.length - 4 }) }}</span>
</button>
</template>
<script lang="ts" setup>
import { computed } from 'vue';
import type * as Misskey from 'cherrypick-js';
import { userName } from '@/filters/user.js';
import { i18n } from '@/i18n.js';
const props = defineProps<{ participants: Misskey.entities.ChatRoomVoiceState['participants'] }>();
// このカードにまとめた参加者 (カードを持たない人) だけを、名前で伝える。通話の人数を言うと、カードを持つ人まで数えたように聞こえる
const label = computed(() => `${i18n.ts._chat.members}: ${props.participants.map(p => userName(p.user)).join(', ')}`);
const emit = defineEmits<{ (ev: 'open'): void }>();
</script>
<style lang="scss" module>
.root { position: relative; box-sizing: border-box; border: 1px solid var(--MI_THEME-divider); border-radius: var(--MI-radius); background: var(--MI_THEME-panel); }
.root:hover { background: var(--MI_THEME-panelHighlight); }
.grid { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); display: grid; grid-template-columns: repeat(2, 32px); grid-template-rows: repeat(2, 32px); gap: 8px; }
.grid.singleRow { display: flex; }
.avatar { width: 32px; height: 32px; }
.label { position: absolute; top: calc(50% + 44px); left: 0; right: 0; font-size: 11px; color: var(--MI_THEME-fgMuted); }
</style>
