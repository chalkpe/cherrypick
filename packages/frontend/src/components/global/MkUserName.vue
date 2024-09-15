<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<Mfm :text="deidentified ? i18n.ts.mutedUsers : userName(user)" :author="user" :plain="true" :nowrap="nowrap" :emojiUrls="user.emojis" :enableEmojiMenu="enableEmojiMenu"/>
</template>

<script lang="ts" setup>
import { computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import { userName } from '@/filters/user.js';
import { prefer } from '@/preferences.js';
import { i18n } from '@/i18n.js';

const props = withDefaults(defineProps<{
	user: Misskey.entities.User;
	nowrap?: boolean;
	enableEmojiMenu?: boolean;
}>(), {
	nowrap: true,
	enableEmojiMenu: false,
});
const deidentified = computed(() => prefer.r.deidentifyMutedUsers.value && 'isMuted' in props.user && props.user.isMuted === true);
</script>
