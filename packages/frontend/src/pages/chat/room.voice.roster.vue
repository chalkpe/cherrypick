<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<MkModal ref="modal" preferType="dialog" @click="modal?.close()" @closed="emit('closed')" @esc="modal?.close()">
	<section :class="$style.root" role="dialog" :aria-label="i18n.ts._chat.members">
		<header><strong>{{ i18n.ts._chat.members }}</strong><button v-tooltip="i18n.ts.close" type="button" class="_button" :aria-label="i18n.ts.close" @click="modal?.close()"><i class="ti ti-x"></i></button></header>
		<!-- メニューに出すものが無い参加者 (通話に入っておらず持ち主でもないとき) は、押しても何も起きないボタンにせず、ただの行として出す -->
		<component :is="menuable ? 'button' : 'div'" v-for="{ p, menuable } in rows" :key="p.identity" :type="menuable ? 'button' : undefined" :class="[$style.person, { _button: menuable, [$style.menuable]: menuable }]" @click="menuable && call.openParticipantMenu(p, $event)" @contextmenu="onContextMenu(p, menuable, $event)">
			<MkAvatar :user="p.user" :link="false" :class="$style.avatar"/>
			<span :class="$style.status"><i v-if="p.deafened" class="ti ti-headphones-off" :aria-label="i18n.ts._voiceCall.deafened"></i><i v-else-if="p.micMuted" class="ti ti-microphone-off" :aria-label="i18n.ts._voiceCall.micMuted"></i></span>
			<MkUserName :user="p.user" :class="$style.name"/><i v-if="menuable" class="ti ti-dots"></i>
		</component>
	</section>
</MkModal>
</template>
<script lang="ts" setup>
import { computed, useTemplateRef } from 'vue';
import type { ChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import MkModal from '@/components/MkModal.vue';
import { i18n } from '@/i18n.js';
const props = defineProps<{ call: ChatRoomVoiceCall }>();
const emit = defineEmits<{ (ev: 'closed'): void }>();
const modal = useTemplateRef('modal');
const rows = computed(() => props.call.participants.value.map(p => ({ p, menuable: props.call.hasParticipantMenu(p) })));

function onContextMenu(p: typeof rows.value[number]['p'], menuable: boolean, ev: MouseEvent) {
	if (!menuable) return;
	ev.preventDefault();
	props.call.openParticipantMenu(p, ev);
}
</script>
<style lang="scss" module>
.root { margin: auto; box-sizing: border-box; width: min(400px, calc(100vw - 32px)); max-height: 80dvh; overflow: auto; padding: 16px; border-radius: var(--MI-radius); background: var(--MI_THEME-panel); }
.root header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.root header button { width: 32px; height: 32px; border-radius: 8px; }
// button でない行 (div) は UA の box-sizing: border-box を持たないので、padding の分だけはみ出さないよう明示する
.person { display: grid; grid-template-columns: 40px 16px minmax(0, 1fr) 20px; align-items: center; gap: 8px; box-sizing: border-box; width: 100%; padding: 10px 4px; border-radius: 8px; text-align: left; }
.person.menuable:hover, .root header button:hover { background: var(--MI_THEME-buttonHoverBg); }
.avatar { width: 32px; height: 32px; }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-height: 1.4em; }
.status { font-size: 12px; opacity: .75; }
</style>
