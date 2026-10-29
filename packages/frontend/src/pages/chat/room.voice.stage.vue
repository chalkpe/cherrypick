<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->
<template>
<div ref="rootEl" :class="[$style.root, { [$style.watching]: watchedParticipants.length > 0, [$style.active]: active || menuOpen, [$style.membersHidden]: membersHidden }]" :data-voice-call-room="room.id" @pointermove="showControls" @pointerdown="showControls">
	<span :class="$style.srOnly" :aria-live="announcesStatus ? 'polite' : 'off'">{{ voiceCallStatusText }}</span>
	<div v-if="watchedParticipants.length" ref="screensEl" :class="$style.screensSpace"><XScreens :participants="watchedParticipants" :hideStrip="membersHidden" fill :class="$style.screens" :style="screenStyle"/></div>
	<div :class="[$style.list, { [$style.collapsed]: watchedParticipants.length > 0 && membersHidden }]" :inert="watchedParticipants.length > 0 && membersHidden" :aria-hidden="watchedParticipants.length > 0 && membersHidden">
		<!-- TransitionGroup は直下の子コンポーネントを毎回描き直させるので、カードは要素で包む -->
		<component :is="prefer.s.animation ? TransitionGroup : 'div'" v-bind="prefer.s.animation ? { tag: 'div', css: false, moveClass: $style.cardMove } : {}" :class="$style.cards" :style="cardStyle" @pointerover="trackHover" @pointerleave="hovering = false">
			<div v-for="p in shownShares" :key="`share-${p.identity}`" :class="$style.card" data-voice-call-card><XShare :participant="p" :watchable="inThisCall" :watching="false" @toggleWatch="toggleScreenShareWatch(p.identity)"/></div>
			<div v-for="p in shown" :key="p.identity" :class="$style.card" data-voice-call-card><XTile :participant="p" :speaking="speaking(p.identity) && !p.micMuted" :menuable="inThisCall || isOwner" @openMenu="openMenu(p, $event)" @contextmenu.prevent="openMenu(p, $event)"/></div>
			<div v-if="hidden.length || shownShares.length < availableShares.length" key="group" :class="$style.card" data-voice-call-card><XGroup :participants="hidden.length ? hidden : participants" @open="call.openRoster()"/></div>
		</component>
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
import { computed, onBeforeUnmount, ref, TransitionGroup, useTemplateRef, watch } from 'vue';
import type * as Misskey from 'cherrypick-js';
import XTile from './room.voice.tile.vue';
import XShare from './room.voice.share.vue';
import XScreens from './room.voice.screens.vue';
import XControls from './room.voice.controls.vue';
import XGroup from './room.voice.group.vue';
import XBanner from './room.voice.banner.vue';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import type { ChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { toggleScreenShareWatch, voiceCall } from '@/utility/voice-call.js';
import { useVoiceCallStatusAnnouncer, voiceCallStatusText } from '@/utility/voice-call-status.js';
const props = withDefaults(defineProps<{ room: Misskey.entities.ChatRoom; call: ChatRoomVoiceCall; chatOpen?: boolean }>(), { chatOpen: true });
const emit = defineEmits<{ (ev: 'toggleChat'): void }>();
const { inThisCall, participants, watchedParticipants, isOwner } = props.call;
const rootEl = useTemplateRef('rootEl');
const screensEl = useTemplateRef('screensEl');
const announcesStatus = useVoiceCallStatusAnnouncer(inThisCall, rootEl);
const membersHidden = ref(false), active = ref(true), menuOpen = ref(false), hovering = ref(false);
let idleTimer: number | undefined;

function showControls() { active.value = true; window.clearTimeout(idleTimer); idleTimer = window.setTimeout(() => { active.value = false; }, 1800); }

onBeforeUnmount(() => { window.clearTimeout(idleTimer); window.clearTimeout(promoteTimer); });

async function openMenu(p: typeof participants.value[number], ev: MouseEvent) {
	menuOpen.value = true;
	try { await props.call.openParticipantMenu(p, ev); } finally { menuOpen.value = false; }
}

function speaking(identity: string) { return inThisCall.value && voiceCall.speakingIdentities.includes(identity); }

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
// 見えているカードは入れ替えない。隠れている人がこれだけ話し続けたときだけ、見えている人のうちいちばん長く黙っている人と席を替える
const PROMOTE_AFTER_MS = 800;
const order = ref<string[]>([]);
const speakingSince = new Map<string, number>(), lastSpokeAt = new Map<string, number>();
let promoteTimer: number | undefined;
const speakingNow = computed(() => new Set(participants.value.filter(p => p.identity !== props.call.myIdentity && speaking(p.identity) && !p.micMuted).map(p => p.identity)));
// メニューが開いているあいだや、ポインターがカードに乗っているあいだは並びを動かさず、離れてから追いつく。カードの隙間に置かれているだけなら止めない
const frozen = computed(() => menuOpen.value || hovering.value);

function trackHover(ev: PointerEvent) { hovering.value = ev.target instanceof Element && ev.target.closest('[data-voice-call-card]') != null; }

watch(participants, list => {
	const ids = list.filter(p => p.identity !== props.call.myIdentity).map(p => p.identity);
	const kept = order.value.filter(id => ids.includes(id));
	order.value = [...kept, ...ids.filter(id => !kept.includes(id))];
	for (const map of [speakingSince, lastSpokeAt]) for (const id of map.keys()) if (!ids.includes(id)) map.delete(id);
}, { immediate: true });

watch(speakingNow, (now, before) => {
	const at = Date.now();
	for (const id of now) {
		if (!before?.has(id)) speakingSince.set(id, at);
		lastSpokeAt.set(id, at);
	}
	for (const id of before ?? []) {
		if (now.has(id)) continue;
		speakingSince.delete(id);
		lastSpokeAt.set(id, at);
	}
	promote();
}, { immediate: true });
watch(frozen, value => { if (!value) promote(); });
watch(() => layout.value.count, () => promote());

function promote() {
	window.clearTimeout(promoteTimer);
	if (frozen.value) return;
	const at = Date.now();
	const visibleCount = Math.max(0, layout.value.count - (participants.value.some(p => p.identity === props.call.myIdentity) ? 1 : 0));
	let next = order.value, soonest: number | undefined;
	const qualified = next.slice(visibleCount).filter(id => speakingSince.has(id)).sort((a, b) => speakingSince.get(a)! - speakingSince.get(b)!);
	for (const id of qualified) {
		const since = speakingSince.get(id)!;
		if (at - since < PROMOTE_AFTER_MS) {
			soonest = Math.min(soonest ?? Infinity, since + PROMOTE_AFTER_MS);
			continue;
		}
		// 話している人の席は奪わない。黙っている人の中で、いちばん長く黙っている人 (同じなら後ろの人)
		const silent = next.slice(0, visibleCount).filter(v => !speakingNow.value.has(v));
		if (silent.length === 0) break;
		const seat = silent.reduce((a, b) => (lastSpokeAt.get(b) ?? 0) <= (lastSpokeAt.get(a) ?? 0) ? b : a);
		next = next.map(v => v === seat ? id : v === id ? seat : v);
	}
	if (next !== order.value) order.value = next;
	if (soonest != null) promoteTimer = window.setTimeout(promote, soonest - at + 1);
}

const sorted = computed(() => {
	const byIdentity = new Map(participants.value.map(p => [p.identity, p]));
	const ordered = order.value.map(id => byIdentity.get(id)).filter(p => p != null);
	return [
		...participants.value.filter(p => p.identity === props.call.myIdentity),
		...ordered,
		...participants.value.filter(p => p.identity !== props.call.myIdentity && !order.value.includes(p.identity)),
	];
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
.cardMove { transition: transform .25s; }
.cards > .card { flex: 0 1 var(--card-width); width: var(--card-width); max-width: var(--card-width); height: var(--card-height); min-height: 0; }
.cards > .card > * { box-sizing: border-box; width: 100%; max-width: none; height: 100%; --voiceCallAvatarSize: inherit; }
.cards > .card > :has(video) { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; overflow: clip; }
.cards > .card > * > span:first-child:has(video) { height: 100%; min-height: 0; aspect-ratio: auto; }
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
@media (prefers-reduced-motion: reduce) { .list, .watching .controls, .screensSpace, .cardMove { transition: none; } }
</style>
