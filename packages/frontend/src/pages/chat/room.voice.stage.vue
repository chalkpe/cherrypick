<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div ref="rootEl" :class="[$style.root, { [$style.watching]: watchedParticipants.length > 0, [$style.active]: active || menuOpen, [$style.membersHidden]: membersHidden }]" :data-voice-call-room="room.id" @pointermove="showControls" @pointerdown="showControls">
	<span :class="$style.srOnly" :aria-live="announcesStatus ? 'polite' : 'off'">{{ voiceCallStatusText }}</span>
	<div v-if="watchedParticipants.length" ref="screensEl" :class="$style.screensSpace"><XScreens :participants="watchedParticipants" :hideStrip="membersHidden" fill :class="$style.screens" :style="screenStyle"/></div>
	<div :class="[$style.list, { [$style.collapsed]: watchedParticipants.length > 0 && membersHidden }]" :inert="watchedParticipants.length > 0 && membersHidden" :aria-hidden="watchedParticipants.length > 0 && membersHidden">
		<div :class="$style.cards" :style="cardStyle">
			<XShare v-for="p in shownShares" :key="`share-${p.identity}`" :participant="p" :watchable="inThisCall" :watching="false" :class="$style.card" @toggleWatch="toggleScreenShareWatch(p.identity)"/>
			<XTile v-for="p in shown" :key="p.identity" :participant="p" :speaking="speaking(p.identity) && !p.micMuted" :menuable="inThisCall || isOwner" :class="$style.card" @openMenu="openMenu(p, $event)" @contextmenu.prevent="openMenu(p, $event)"/>
			<XGroup v-if="hidden.length || shownShares.length < availableShares.length" :participants="hidden.length ? hidden : participants" :class="$style.card" @open="call.openRoster()"/>
		</div>
	</div>
	<div :class="$style.controls">
		<XControls v-if="inThisCall" grouped><template #leading>
			<button v-if="watchedParticipants.length" v-tooltip="membersHidden ? i18n.ts._voiceCall.showParticipants : i18n.ts._voiceCall.hideParticipants" type="button" class="_button" :class="$style.membersToggle" :aria-label="membersHidden ? i18n.ts._voiceCall.showParticipants : i18n.ts._voiceCall.hideParticipants" :aria-pressed="membersHidden" @click="membersHidden = !membersHidden"><i :class="membersHidden ? 'ti ti-chevron-up' : 'ti ti-chevron-down'"></i><i class="ti ti-users"></i></button>
			<button v-tooltip="chatOpen ? i18n.ts._voiceCall.closeChat : i18n.ts._voiceCall.openChat" type="button" class="_button" :class="$style.chatToggle" :aria-label="chatOpen ? i18n.ts._voiceCall.closeChat : i18n.ts._voiceCall.openChat" @click="emit('toggleChat')"><i class="ti ti-messages"></i></button>
		</template></XControls>
		<XBanner v-else :call="call"/>
	</div>
</div>
</template>
<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, useTemplateRef, watch } from 'vue';
import type * as Misskey from 'cherrypick-js';
import XTile from './room.voice.tile.vue';
import XShare from './room.voice.share.vue';
import XScreens from './room.voice.screens.vue';
import XControls from './room.voice.controls.vue';
import XGroup from './room.voice.group.vue';
import XBanner from './room.voice.banner.vue';
import { i18n } from '@/i18n.js';
import type { ChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { toggleScreenShareWatch, voiceCall } from '@/utility/voice-call.js';
import { useVoiceCallStatusAnnouncer, voiceCallStatusText } from '@/utility/voice-call-status.js';
const props = withDefaults(defineProps<{ room: Misskey.entities.ChatRoom; call: ChatRoomVoiceCall; chatOpen?: boolean }>(), { chatOpen: true });
const emit = defineEmits<{ (ev: 'toggleChat'): void }>();
const { inThisCall, participants, watchedParticipants, isOwner } = props.call;
const rootEl = useTemplateRef('rootEl');
const screensEl = useTemplateRef('screensEl');
const announcesStatus = useVoiceCallStatusAnnouncer(inThisCall, rootEl);
const membersHidden = ref(false), active = ref(true), menuOpen = ref(false);
let idleTimer: number | undefined;

function showControls() { active.value = true; window.clearTimeout(idleTimer); idleTimer = window.setTimeout(() => { active.value = false; }, 1800); }

onBeforeUnmount(() => window.clearTimeout(idleTimer));

async function openMenu(p: typeof participants.value[number], ev: MouseEvent) {
	menuOpen.value = true;
	try { await props.call.openParticipantMenu(p, ev); } finally { menuOpen.value = false; }
}

function speaking(identity: string) { return inThisCall.value && voiceCall.speakingIdentities.includes(identity); }

const sorted = computed(() => {
	const others = participants.value.filter(p => p.identity !== props.call.myIdentity);
	return [
		...participants.value.filter(p => p.identity === props.call.myIdentity),
		...others.filter(p => speaking(p.identity) && !p.micMuted),
		...others.filter(p => !speaking(p.identity) || p.micMuted),
	];
});
const availableShares = computed(() => participants.value.filter(p => p.screenSharing && !voiceCall.watchingIdentities.includes(p.identity)));
const size = ref({ width: 640, height: 500 }), screensSize = ref({ width: 640, height: 360 });
const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
	for (const entry of entries) {
		const value = { width: entry.contentRect.width, height: entry.contentRect.height };
		if (!value.width || !value.height) continue;
		if (entry.target === rootEl.value) size.value = value;
		if (entry.target === screensEl.value) screensSize.value = value;
	}
});
watch([rootEl, screensEl], ([root, screens], [previousRoot, previousScreens]) => {
	if (previousRoot) observer?.unobserve(previousRoot);
	if (previousScreens) observer?.unobserve(previousScreens);
	if (root) observer?.observe(root);
	if (screens) observer?.observe(screens);
}, { flush: 'post' });
onBeforeUnmount(() => observer?.disconnect());
const layout = computed(() => {
	const width = Math.max(160, size.value.width - 24), isWatching = watchedParticipants.value.length > 0;
	const columns = isWatching ? Math.max(1, Math.floor((width + 8) / 168)) : width < 600 ? Math.max(1, Math.floor((width + 8) / 168)) : Math.max(2, Math.floor((width + 8) / 180));
	let rows = isWatching ? (width < 600 && size.value.height >= 600 ? 2 : 1) : Math.max(1, Math.min(3, Math.floor((size.value.height - 72 + 8) / 144)));
	let slots = columns * rows;
	if (!isWatching && availableShares.value.length + 2 > slots) {
		rows = Math.min(Math.max(1, Math.floor((size.value.height - 72 + 8) / 144)), Math.ceil((availableShares.value.length + 2) / columns));
		slots = rows * columns;
	}
	const hasOtherSpeaker = participants.value.some(p => p.identity !== props.call.myIdentity && speaking(p.identity) && !p.micMuted);
	const peopleToKeep = Math.min(participants.value.length, hasOtherSpeaker ? 2 : 1);
	const shareCount = Math.min(availableShares.value.length, Math.max(0, slots - peopleToKeep - 1));
	const peopleSlots = Math.max(1, slots - shareCount);
	const needsGroup = peopleSlots < participants.value.length || shareCount < availableShares.value.length;
	const count = Math.min(participants.value.length, Math.max(0, peopleSlots - (needsGroup ? 1 : 0)));
	const height = isWatching ? 160 : Math.max(136, Math.min(220, (size.value.height - 72 - (rows - 1) * 8) / rows));
	return { width, columns, count, height, shareCount };
});
const shownShares = computed(() => availableShares.value.slice(0, layout.value.shareCount));
const shown = computed(() => sorted.value.slice(0, layout.value.count));
const hidden = computed(() => sorted.value.slice(layout.value.count));
const cardStyle = computed(() => {
	const side = Math.min(220, layout.value.height, (layout.value.width - (layout.value.columns - 1) * 8) / layout.value.columns);
	return { '--card-width': `${side}px`, '--card-height': `${side}px`, '--voiceCallAvatarSize': side < 125 ? '32px' : size.value.width < 600 ? '48px' : '64px' };
});
const screenStyle = computed(() => {
	const { width, height } = screensSize.value;
	let best = { width: 0, columns: 1 };
	for (let columns = 1; columns <= Math.min(watchedParticipants.value.length, 3); columns++) {
		const rows = Math.ceil(watchedParticipants.value.length / columns);
		const candidate = Math.max(0, Math.min((width - (columns - 1) * 8) / columns, (height - (rows - 1) * 8) / rows * 16 / 9));
		if (candidate > best.width) best = { width: candidate, columns };
	}
	return { '--voiceCallGridWidth': `${best.width}px`, '--voiceCallGridHeight': `${best.width * 9 / 16}px` };
});
</script>
<style lang="scss" module>
.root { position: relative; display: flex; flex-direction: column; gap: 8px; box-sizing: border-box; min-width: 0; min-height: 0; height: 100%; padding: 12px; container-type: inline-size; }
.srOnly { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.list { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: 1fr; width: 100%; min-height: 0; flex: 1; transition: grid-template-rows .25s, opacity .2s, transform .25s, margin .25s; }
.cards { display: flex; flex-wrap: wrap; align-content: center; justify-content: center; gap: 8px; width: 100%; min-height: 0; overflow: clip; }
.cards > .card { flex: 0 1 var(--card-width); width: var(--card-width); max-width: var(--card-width); height: var(--card-height); min-height: 0; --voiceCallAvatarSize: inherit; }
.cards > .card:has(video) { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; overflow: clip; }
.cards > .card > span:first-child:has(video) { height: 100%; min-height: 0; aspect-ratio: auto; }
.cards > .card video { object-fit: contain; }
.screensSpace { flex: 1; min-height: 0; min-width: 0; box-sizing: border-box; transition: padding-bottom .24s; }
.watching.membersHidden.active .screensSpace, .watching.membersHidden:has(.controls:focus-within) .screensSpace { padding-bottom: 80px; }
.screens { width: 100%; height: 100%; }
.watching .list { flex: 0 0 auto; margin-bottom: 56px; }
.list.collapsed { grid-template-rows: 0fr; opacity: 0; transform: translateY(12px); margin-bottom: 0; pointer-events: none; }
.controls { display: flex; flex-shrink: 0; justify-content: center; }
.watching .controls { position: absolute; z-index: 4; left: 50%; bottom: 12px; max-width: calc(100% - 16px); transform: translate(-50%, 12px); opacity: 0; pointer-events: none; transition: opacity .2s, transform .24s; }
.active .controls, .controls:focus-within { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }
.root:not(.watching) .controls { transform: none; }
.membersToggle, .chatToggle { display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; padding: 0; border-radius: 8px; font-size: 16px; }
.membersToggle { width: 44px; gap: 3px; }
.membersToggle i:first-child { font-size: 12px; }
.membersToggle:hover, .chatToggle:hover { background: var(--MI_THEME-buttonHoverBg); }
@container (max-width: 400px) { .controls > div { gap: 8px; } }
@media (prefers-reduced-motion: reduce) { .list, .watching .controls, .screensSpace { transition: none; } }
</style>
