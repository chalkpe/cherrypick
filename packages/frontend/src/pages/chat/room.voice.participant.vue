<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.speaking]: speaking }]">
	<component :is="menuable ? 'button' : 'div'" :class="[$style.main, { _button: menuable }]" @click="menuable && emit('openMenu', $event)">
		<MkAvatar :user="participant.user" :class="$style.avatar"/>
		<MkUserName :user="participant.user" :class="$style.name"/>
	</component>
	<button
		v-if="participant.screenSharing && watchable"
		class="_button" :class="[$style.watch, { [$style.watching]: watching }]"
		:aria-label="watching ? i18n.ts._voiceCall.stopWatching : i18n.ts._voiceCall.watchStream"
		:title="watching ? i18n.ts._voiceCall.stopWatching : i18n.ts._voiceCall.watchStream"
		@click="emit('toggleWatch')"
	>
		<i v-if="watching" class="ti ti-eye-off"></i>
		<i v-else class="ti ti-screen-share"></i>
	</button>
	<i
		v-else-if="participant.screenSharing"
		class="ti ti-screen-share" :class="$style.sharing"
		role="img" :aria-label="i18n.ts._voiceCall.sharingScreen" :title="i18n.ts._voiceCall.sharingScreen"
	></i>
</div>
</template>

<script lang="ts" setup>
import * as Misskey from 'cherrypick-js';
import { i18n } from '@/i18n.js';

withDefaults(defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	speaking: boolean;
	watchable?: boolean;
	watching?: boolean;
	menuable?: boolean;
}>(), {
	watchable: false,
	watching: false,
	menuable: false,
});

const emit = defineEmits<{
	(ev: 'toggleWatch'): void;
	(ev: 'openMenu', event: MouseEvent): void;
}>();
</script>

<style lang="scss" module>
.root {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	padding: 4px 8px 4px 4px;
	border-radius: 999px;
	background: var(--MI_THEME-panelHighlight);
}

.main {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
	color: inherit;
}

.avatar {
	width: 28px;
	height: 28px;
	flex-shrink: 0;
	border-radius: 100%;
	outline: 2px solid transparent;
	outline-offset: 1px;
	transition: outline-color 0.1s;
}

.speaking .avatar {
	outline-color: var(--MI_THEME-success);
}

.name {
	min-width: 0;
	font-size: 0.9em;
}

.sharing {
	color: var(--MI_THEME-accent);
}

.watch {
	display: grid;
	place-items: center;
	width: 24px;
	height: 24px;
	border-radius: 100%;
	color: var(--MI_THEME-accent);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.watching {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-accent);
	}
}
</style>
