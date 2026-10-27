<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 見ている共有画面を並べる。1 つなら大きく、2 つなら横に、3〜4 つなら 2×2 に、それより多ければスクロールできる格子にする。
広い画面のステージ (fill) では、押した画面を大きくして、ほかの画面は下の帯に並べる。
大きくする画面を変えても画面を作り直さない (作り直すと全画面やピクチャーインピクチャーが解け、キーボードのフォーカスも失われる) よう、
並べ方はクラスだけで切り替える -->
<div :class="[$style.root, focusedParticipant != null ? $style.focusMode : [$style.grid, $style[layout], fill ? $style.fill : $style.capped]]">
	<XScreen
		v-for="participant in participants"
		:key="participant.identity"
		:participant="participant"
		:fill="fill"
		:focusable="fill && participants.length > 1"
		:focused="focusedParticipant?.identity === participant.identity"
		:compact="focusedParticipant != null && focusedParticipant.identity !== participant.identity"
		:class="focusedParticipant == null ? null : focusedParticipant.identity === participant.identity ? $style.focused : $style.stripItem"
		@toggleFocus="toggleFocus(participant.identity)"
	/>
</div>
</template>

<script lang="ts" setup>
import { computed, ref, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import XScreen from './room.voice.screen.vue';

type Participant = Misskey.entities.ChatRoomVoiceState['participants'][number];

const props = withDefaults(defineProps<{
	// 見ている共有画面の持ち主 (見始めた順)
	participants: Participant[];
	// 与えられた高さいっぱいに並べる (広い画面のステージ)。指定しなければ、一覧全体を高さの上限 (--voiceCallScreensMaxHeight) までに収める
	fill?: boolean;
}>(), {
	fill: false,
});

const layout = computed(() => {
	const count = props.participants.length;
	if (count <= 1) return 'layout1';
	if (count === 2) return 'layout2';
	if (count <= 4) return 'layout4';
	return 'layoutMany';
});

// 大きくしている画面はこの並びの中だけのことなので、通話の状態には持たせない
const focusedIdentity = ref<string | null>(null);
const focusedParticipant = computed(() => {
	if (!props.fill || props.participants.length < 2) return null;
	return props.participants.find(participant => participant.identity === focusedIdentity.value) ?? null;
});

function toggleFocus(identity: string) {
	focusedIdentity.value = focusedIdentity.value === identity ? null : identity;
}

// その画面を見るのをやめたとき、または残りが 1 つになったときは忘れる。
// 覚えたままにすると、あとでまた見始めたときに勝手に大きくなる
watch(() => props.participants.length >= 2 && props.participants.some(participant => participant.identity === focusedIdentity.value), keep => {
	if (!keep) focusedIdentity.value = null;
});
</script>

<style lang="scss" module>
.root {
	min-width: 0;
	min-height: 0;
}

.grid {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	gap: 8px;

	&.layout1 {
		grid-template-columns: minmax(0, 1fr);
	}
}

// 狭い画面のカード: 一覧全体を高さの上限に収める。2 段になる並べ方では、1 つずつの上限をその半分にする。
// ただし 1 つずつの上限は、操作の列 (44px) と、その幅 (124px) で 16:9 の映像が見える高さ (70px) を下回らせない。
// 横向きのスマートフォンのように上限がそれより低いときは、映像を潰さずに一覧の中でスクロールさせる
.capped {
	--voiceCallScreenMaxHeight: max(114px, var(--voiceCallScreensMaxHeight, 70vh));
	max-height: var(--voiceCallScreensMaxHeight, 70vh);
	overflow-y: auto;

	&.layout4,
	&.layoutMany {
		--voiceCallScreenMaxHeight: max(114px, calc((var(--voiceCallScreensMaxHeight, 70vh) - 8px) / 2));
	}
}

// 広い画面のステージ: 与えられた高さを段で分ける。5 つ以上は 2 段分の高さでスクロールする
.fill {
	&.layout1,
	&.layout2 {
		grid-template-rows: minmax(0, 1fr);
	}

	&.layout4 {
		grid-template-rows: repeat(2, minmax(0, 1fr));
	}

	&.layoutMany {
		grid-auto-rows: calc((100% - 8px) / 2);
		overflow-y: auto;
	}
}

// 大きくした画面を一段目いっぱいに、ほかの画面を二段目に帯として並べる (帯が一段に収まらなければ折り返してスクロールする)
.focusMode {
	--voiceCallScreensStripHeight: 96px;
	display: flex;
	flex-wrap: wrap;
	align-content: flex-start;
	justify-content: center;
	gap: 8px;
	overflow-y: auto;
}

.focused {
	order: -1;
	flex: 0 0 100%;
	height: calc(100% - var(--voiceCallScreensStripHeight) - 8px);
}

.stripItem {
	flex: 0 0 auto;
	aspect-ratio: 16 / 9;
	height: var(--voiceCallScreensStripHeight);
}
</style>
