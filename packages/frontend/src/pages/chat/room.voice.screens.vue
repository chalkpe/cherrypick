<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- 見ている共有画面を並べる。1 つなら大きく、2 つなら横に、3〜4 つなら 2×2 に、それより多ければスクロールできる格子にする。
広い画面のステージ (fill) では、押した画面を大きくして、ほかの画面は下の帯に並べる -->
<div v-if="focusedParticipant != null" :class="[$style.root, $style.focusMode]">
	<XScreen
		:key="focusedParticipant.identity"
		:participant="focusedParticipant"
		fill focusable focused
		:class="$style.focused"
		@toggleFocus="focusedIdentity = null"
	/>
	<div :class="$style.strip">
		<XScreen
			v-for="participant in others"
			:key="participant.identity"
			:participant="participant"
			compact focusable
			:class="$style.stripItem"
			@toggleFocus="focusedIdentity = participant.identity"
		/>
	</div>
</div>
<div v-else :class="[$style.root, $style.grid, $style[layout], fill ? $style.fill : $style.capped]">
	<XScreen
		v-for="participant in participants"
		:key="participant.identity"
		:participant="participant"
		:fill="fill"
		:focusable="fill && participants.length > 1"
		@toggleFocus="focusedIdentity = participant.identity"
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

// 大きくしている画面はこの並びの中だけのことなので、通話の状態には持たせない。
// その画面を見るのをやめたら (または残りが 1 つになったら) 並べた形に戻す
const focusedIdentity = ref<string | null>(null);
const focusedParticipant = computed(() => {
	if (!props.fill || props.participants.length < 2) return null;
	return props.participants.find(participant => participant.identity === focusedIdentity.value) ?? null;
});
const others = computed(() => props.participants.filter(participant => participant.identity !== focusedIdentity.value));

// 見るのをやめた画面を覚えたままにすると、あとでまた見始めたときに勝手に大きくなるので忘れる
watch(() => props.participants.some(participant => participant.identity === focusedIdentity.value), present => {
	if (!present) focusedIdentity.value = null;
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

// 狭い画面のカード: 一覧全体を高さの上限に収める。2 段になる並べ方では、1 つずつの上限をその半分にする
.capped {
	--voiceCallScreenMaxHeight: var(--voiceCallScreensMaxHeight, 70vh);
	max-height: var(--voiceCallScreensMaxHeight, 70vh);
	overflow-y: auto;

	&.layout4,
	&.layoutMany {
		--voiceCallScreenMaxHeight: calc((var(--voiceCallScreensMaxHeight, 70vh) - 8px) / 2);
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

.focusMode {
	display: flex;
	flex-direction: column;
	gap: 8px;
}

.focused {
	flex: 1 1 0;
}

.strip {
	display: flex;
	flex-shrink: 0;
	justify-content: center;
	justify-content: safe center;
	gap: 8px;
	height: 96px;
	overflow-x: auto;
}

.stripItem {
	flex-shrink: 0;
	aspect-ratio: 16 / 9;
	height: 100%;
}
</style>
