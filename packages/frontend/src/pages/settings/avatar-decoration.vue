<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<SearchMarker path="/settings/avatar-decoration" :label="i18n.ts.avatarDecorations" :keywords="['avatar', 'icon', 'decoration']" icon="ti ti-sparkles">
	<div>
		<div v-if="!loading" class="_gaps">
			<MkInfo>{{ i18n.tsx._profile.avatarDecorationMax({ max: $i.policies.avatarDecorationLimit }) }} ({{ i18n.tsx.remainingN({ n: $i.policies.avatarDecorationLimit - currentDecorations.length }) }})</MkInfo>

			<MkAvatar :class="$style.avatar" :user="room ? undefined : $i" :room="room" forceShowDecoration/>

			<div v-if="currentDecorations.length > 0" v-panel :class="$style.current" class="_gaps_s">
				<div>{{ i18n.ts.inUse }}</div>

				<div :class="$style.decorations">
					<XDecoration
						v-for="(avatarDecoration, i) in currentDecorations"
						:decoration="avatarDecorations.find(d => d.id === avatarDecoration.id) ?? { id: '', url: '', name: '?', roleIdsThatCanBeUsedThisDecoration: [] }"
						:angle="avatarDecoration.angle"
						:flipH="avatarDecoration.flipH"
						:offsetX="avatarDecoration.offsetX"
						:offsetY="avatarDecoration.offsetY"
						:scale="avatarDecoration.scale"
						:opacity="avatarDecoration.opacity"
						:active="true"
						:room="room"
						@click="openAttachedDecoration(i)"
					/>
				</div>

				<MkButton danger @click="detachAllDecorations">{{ i18n.ts.detachAll }}</MkButton>
			</div>
			<MkFoldableSection v-for="category in Object.keys(groupedDecorations)" :key="category" :expanded="true">
				<template #header>{{ category || i18n.ts.other }}</template>
				<div :class="$style.decorations">
					<XDecoration
						v-for="avatarDecoration in groupedDecorations[category]"
						:key="avatarDecoration.id"
						:decoration="avatarDecoration"
						:room="room"
						@click="openDecoration(avatarDecoration)"
					/>
				</div>
			</MkFoldableSection>
		</div>
		<div v-else>
			<MkLoading/>
		</div>
	</div>
</SearchMarker>
</template>

<script lang="ts" setup>
import { ref, defineAsyncComponent, computed } from 'vue';
import * as Misskey from 'cherrypick-js';
import XDecoration from './avatar-decoration.decoration.vue';
import XDialog from './avatar-decoration.dialog.vue';
import MkButton from '@/components/MkButton.vue';
import MkFoldableSection from '@/components/MkFoldableSection.vue';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import MkInfo from '@/components/MkInfo.vue';
import { definePage } from '@/page.js';
import { chatRoomUpdateErrors } from '@/pages/chat/chat-errors.js';
import { groupAvatarDecorations } from '@/utility/group-avatar-decorations.js';

const $i = ensureSignin();
const props = defineProps<{ room?: Misskey.entities.ChatRoom }>();
const emit = defineEmits<{ (ev: 'updated', room: Misskey.entities.ChatRoom): void }>();
const currentDecorations = computed(() => props.room ? props.room.iconDecorations ?? [] : $i.avatarDecorations);

async function saveDecorations(update: Misskey.entities.UserDetailed['avatarDecorations'], targetRoomId = props.room?.id) {
	if (props.room?.id !== targetRoomId) return;
	if (props.room) {
		if (props.room.isArchived || props.room.ownerId !== $i.id) return;
		const room = await os.apiWithDialog('chat/rooms/update', { roomId: props.room.id, iconDecorations: update }, undefined, chatRoomUpdateErrors);
		emit('updated', room);
	} else {
		await os.apiWithDialog('i/update', { avatarDecorations: update });
		$i.avatarDecorations = update;
	}
}

const loading = ref(true);
const avatarDecorations = ref<Misskey.entities.GetAvatarDecorationsResponse>([]);
const groupedDecorations = computed(() => groupAvatarDecorations(avatarDecorations.value));

misskeyApi('get-avatar-decorations').then(_avatarDecorations => {
	avatarDecorations.value = _avatarDecorations;
	loading.value = false;
});

function openAttachedDecoration(index: number) {
	openDecoration(avatarDecorations.value.find(d => d.id === currentDecorations.value[index].id) ?? { id: '', url: '', name: '?', roleIdsThatCanBeUsedThisDecoration: [] }, index);
}

async function openDecoration(avatarDecoration: {
	id: string;
	url: string;
	name: string;
	roleIdsThatCanBeUsedThisDecoration: string[];
}, index?: number) {
	const targetRoomId = props.room?.id;
	const { dispose } = os.popup(XDialog, {
		decoration: avatarDecoration,
		usingIndex: index ?? null,
		room: props.room,
	}, {
		'attach': async (payload) => {
			const decoration = {
				id: avatarDecoration.id,
				url: avatarDecoration.url,
				angle: payload.angle,
				flipH: payload.flipH,
				offsetX: payload.offsetX,
				offsetY: payload.offsetY,
				scale: payload.scale,
				opacity: payload.opacity,
			};
			const update = [...currentDecorations.value, decoration];
			await saveDecorations(update, targetRoomId);
		},
		'update': async (payload) => {
			const decoration = {
				id: avatarDecoration.id,
				url: avatarDecoration.url,
				angle: payload.angle,
				flipH: payload.flipH,
				offsetX: payload.offsetX,
				offsetY: payload.offsetY,
				scale: payload.scale,
				opacity: payload.opacity,
			};
			const update = [...currentDecorations.value];
			update[index!] = decoration;
			await saveDecorations(update, targetRoomId);
		},
		'detach': async () => {
			const update = [...currentDecorations.value];
			update.splice(index!, 1);
			await saveDecorations(update, targetRoomId);
		},
		closed: () => dispose(),
	});
}

function detachAllDecorations() {
	const targetRoomId = props.room?.id;
	os.confirm({
		type: 'warning',
		text: i18n.ts.areYouSure,
	}).then(async ({ canceled }) => {
		if (canceled) return;
		await saveDecorations([], targetRoomId);
	});
}

const headerActions = computed(() => []);

const headerTabs = computed(() => []);

if (props.room == null) definePage(() => ({
	title: i18n.ts.avatarDecorations,
	icon: 'ti ti-sparkles',
}));
</script>

<style lang="scss" module>
.avatar {
	display: inline-block;
	width: 72px;
	height: 72px;
	margin: 16px auto;
}

.current {
	padding: 16px;
	border-radius: var(--MI-radius);
}

.decorations {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
	grid-gap: 12px;
}
</style>
