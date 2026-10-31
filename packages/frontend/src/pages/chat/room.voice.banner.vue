<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<section v-if="call.available.value && !call.inThisCall.value" :class="$style.root" :aria-label="empty ? undefined : i18n.tsx._voiceCall.inCallCount({ n: call.participants.value.length })">
	<div ref="avatarsEl" :class="$style.avatars">
		<!-- メニューに出すものが無い参加者 (通話に入っておらず持ち主でもないとき) は、押しても何も起きないボタンにせず、名前の付いた絵として出す -->
		<component
			:is="menuable ? 'button' : 'div'"
			v-for="{ p, menuable } in visible"
			:key="p.identity"
			v-tooltip="labelOf(p)"
			:type="menuable ? 'button' : undefined"
			:class="[$style.person, { _button: menuable }]"
			:role="menuable ? undefined : 'img'"
			:aria-label="labelOf(p)"
			:aria-haspopup="menuable ? 'menu' : undefined"
			@click="menuable && call.openParticipantMenu(p, $event)"
			@contextmenu="onContextMenu(p, menuable, $event)"
		>
			<MkAvatar :user="p.user" :link="false" :decorations="[]" :class="$style.avatar"/>
			<span v-if="p.micMuted || p.deafened" :class="$style.dot" aria-hidden="true"></span>
		</component>
		<button v-if="hidden > 0" v-tooltip="moreLabel" type="button" class="_button" :class="$style.more" :aria-label="moreLabel" aria-haspopup="dialog" @click="call.openRoster()">+{{ hidden }}</button>
	</div>
	<!-- 参加したときのマイクを選ぶトグル。押されている (aria-pressed) = マイクを切って参加する -->
	<button
		v-tooltip="call.prejoinMicEnabled.value ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute"
		type="button" class="_button"
		:class="[$style.mic, { [$style.muted]: !call.prejoinMicEnabled.value }]"
		:aria-label="i18n.ts._voiceCall.micMuted" :aria-pressed="!call.prejoinMicEnabled.value"
		@click="call.prejoinMicEnabled.value = !call.prejoinMicEnabled.value"
	>
		<i :class="call.prejoinMicEnabled.value ? 'ti ti-microphone' : 'ti ti-microphone-off'" aria-hidden="true"></i>
	</button>
	<MkButton primary :class="$style.join" @click="call.join()"><i class="ti ti-phone" aria-hidden="true"></i> {{ empty ? i18n.ts._voiceCall.start : i18n.ts._voiceCall.join }}</MkButton>
</section>
</template>
<script lang="ts" setup>
import { computed, useTemplateRef } from 'vue';
import type { ChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { useElementWidth } from '@/composables/use-element-width.js';
import MkButton from '@/components/MkButton.vue';
import { userNameForLabel } from '@/filters/user.js';
import { i18n } from '@/i18n.js';
const props = defineProps<{ call: ChatRoomVoiceCall }>();
const avatarsEl = useTemplateRef('avatarsEl');
const width = useElementWidth(avatarsEl);
const capacity = computed(() => Math.max(1, Math.floor(((width.value ?? 0) + 8) / 36)));
// 誰もいない通話は「参加」ではなく「開始」。既存の通話に入るのか新しく始めるのかを迷わせない
const empty = computed(() => props.call.participants.value.length === 0);
const visible = computed(() => props.call.participants.value
	.slice(0, capacity.value >= props.call.participants.value.length ? capacity.value : capacity.value - 1)
	.map(p => ({ p, menuable: props.call.hasParticipantMenu(p) })));
const hidden = computed(() => props.call.participants.value.length - visible.value.length);

// 小さな点だけでは分からないので、マイク・スピーカーの状態は名前に添えて伝える
function labelOf(p: typeof visible.value[number]['p']): string {
	const status = p.deafened ? i18n.ts._voiceCall.deafened : p.micMuted ? i18n.ts._voiceCall.micMuted : null;
	return status == null ? userNameForLabel(p.user) : `${userNameForLabel(p.user)} (${status})`;
}

const moreLabel = computed(() => `${i18n.ts._chat.members}: ${i18n.tsx._voiceCall.otherParticipants({ n: hidden.value })}`);

function onContextMenu(p: typeof visible.value[number]['p'], menuable: boolean, ev: MouseEvent) {
	if (!menuable) return;
	ev.preventDefault();
	props.call.openParticipantMenu(p, ev);
}
</script>
<style lang="scss" module>
.root {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 10px 16px;
	background: var(--MI_THEME-panel);
	border: 1px solid var(--MI_THEME-divider);
	border-radius: var(--MI-radius);
}

.join {
	border-radius: var(--MI-radius);
}

.avatars {
	display: flex;
	align-items: center;
	gap: 8px;
	flex: 1;
	min-width: 0;
	height: 44px;
	overflow: clip;
}

.person {
	position: relative;
	display: grid;
	place-items: center;
	flex: 0 0 28px;
	width: 28px;
	height: 28px;
}

.avatar {
	width: 28px;
	height: 28px;
}

.dot {
	position: absolute;
	z-index: 2;
	bottom: 0;
	left: 0;
	width: 20%;
	height: 20%;
	border-radius: 50%;
	background: color-mix(in srgb, var(--MI_THEME-fg) 50%, transparent);
	box-shadow: 0 0 0 3px var(--MI_THEME-panel);
}

.more {
	flex: 0 0 28px;
	height: 28px;
	border-radius: 50%;
	background: var(--MI_THEME-buttonBg);
	font-size: 11px;
}

.mic {
	display: grid;
	place-items: center;
	width: 36px;
	height: 36px;
	flex: 0 0 36px;
	border-radius: 50%;
	background: var(--MI_THEME-buttonBg);
	font-size: 18px;
}

.mic.muted {
	color: var(--MI_THEME-error);
}

.mic:hover, .more:hover {
	background: var(--MI_THEME-buttonHoverBg);
}
</style>
