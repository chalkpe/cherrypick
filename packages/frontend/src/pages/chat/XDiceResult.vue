<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="$style.root" class="_selectable">
	<div :class="$style.total"><span>{{ i18n.ts._chat.diceTotal }}</span> <strong>{{ dice.total }}</strong></div>
	<details :class="$style.details">
		<summary>{{ i18n.ts._chat.diceDetails }}</summary>
		<pre>{{ dice.output }}</pre>
	</details>
</div>
</template>

<script lang="ts" setup>
import type * as Misskey from 'cherrypick-js';
import { i18n } from '@/i18n.js';

defineProps<{
	dice: NonNullable<Misskey.entities.ChatMessage['dice']>;
}>();
</script>

<style lang="scss" module>
.root {
	min-width: 0;
	border-top: 1px solid var(--MI_THEME-divider);
	padding-top: 8px;
}

.total {
	display: flex;
	align-items: baseline;
	gap: 12px;

	> span {
		font-size: 0.85em;
		opacity: 0.8;
	}

	> strong {
		font-size: 1.6em;
		font-variant-numeric: tabular-nums;
		overflow-wrap: anywhere;
	}
}

.details {
	margin-top: 4px;
	font-size: 0.85em;

	> summary {
		cursor: pointer;
		width: fit-content;
	}

	> pre {
		margin: 8px 0 0;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-family: var(--MI-monospace, monospace);
	}
}
</style>
