<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl" data-snow-effect aria-hidden="true" :style="layerStyle"></div>
</template>

<script lang="ts" setup>
import { onBeforeUnmount, onMounted, useTemplateRef } from 'vue';
import { fillWithSnow } from '@/utility/snow-effect.js';

// 지연 로딩한 청크의 CSS는 끈 뒤에도 남으므로 인라인으로 둔다
const layerStyle = {
	position: 'fixed',
	inset: '0',
	// claimZIndex의 최솟값(500000) 바로 아래. 같은 쌓임 맥락의 화면과 드로어는 덮고 팝업은 덮지 않는다
	zIndex: '499999',
	overflow: 'hidden',
	contain: 'strict',
	pointerEvents: 'none',
} as const;

const rootEl = useTemplateRef('rootEl');
let stopSnow: (() => void) | null = null;

onMounted(() => {
	if (rootEl.value != null) stopSnow = fillWithSnow(rootEl.value);
});

onBeforeUnmount(() => {
	stopSnow?.();
});
</script>
