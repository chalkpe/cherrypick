<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="el"></div>
</template>

<script lang="ts" setup>
import { onActivated, onBeforeUnmount, onDeactivated, onMounted, useTemplateRef } from 'vue';
import type { VoiceCallBarSlotKind } from '@/utility/voice-call-placement.js';
import { registerVoiceCallBarSlot } from '@/utility/voice-call-placement.js';

// 通話バーの差し込み先。通話バー自体は common.vue に 1 つだけあり、ここへ Teleport してくる
const props = defineProps<{
	kind: VoiceCallBarSlotKind;
}>();

const el = useTemplateRef('el');
let unregister: (() => void) | null = null;

function attach() {
	if (unregister != null || el.value == null) return;
	unregister = registerVoiceCallBarSlot(props.kind, el.value);
}

function detach() {
	unregister?.();
	unregister = null;
}

onMounted(attach);
// KeepAlive で裏に回ったページの中へは出さない
onActivated(attach);
onDeactivated(detach);
onBeforeUnmount(detach);
</script>
