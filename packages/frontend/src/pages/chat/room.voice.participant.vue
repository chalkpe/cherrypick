<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.speaking]: speaking }]">
	<MkAvatar :user="participant.user" :class="$style.avatar"/>
	<MkUserName :user="participant.user" :class="$style.name"/>
</div>
</template>

<script lang="ts" setup>
import * as Misskey from 'cherrypick-js';

defineProps<{
	participant: Misskey.entities.ChatRoomVoiceState['participants'][number];
	speaking: boolean;
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
</style>
