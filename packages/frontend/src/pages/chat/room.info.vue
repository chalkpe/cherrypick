<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div class="_gaps">
	<template v-if="isOwner">
		<MkInput v-model="name_" :mfmAutocomplete="['emoji']" :disabled="room.isArchived">
			<template #label>{{ i18n.ts.name }}</template>
			<template #caption>{{ i18n.ts.preview }}: <Mfm :text="name_" :plain="true" :author="room.owner"/></template>
		</MkInput>

		<MkTextarea v-model="description_" :mfmAutocomplete="['emoji']" mfmPreview :disabled="room.isArchived">
			<template #label>{{ i18n.ts.description }}</template>
		</MkTextarea>
		<MkButton v-if="!room.isArchived" primary @click="save">{{ i18n.ts.save }}</MkButton>
	</template>
	<template v-else>
		<MkKeyValue><template #key>{{ i18n.ts.name }}</template><template #value><Mfm :text="room.name" :plain="true" :author="room.owner"/></template></MkKeyValue>
		<MkKeyValue><template #key>{{ i18n.ts.description }}</template><template #value><Mfm v-if="room.description" :text="room.description" :author="room.owner"/><template v-else>{{ i18n.ts.noDescription }}</template></template></MkKeyValue>
	</template>

	<hr>

	<MkButton v-if="isOwner" @click="setArchived(!room.isArchived)"><i :class="room.isArchived ? 'ti ti-archive-off' : 'ti ti-archive'"></i> {{ room.isArchived ? i18n.ts.unarchive : i18n.ts.archive }}</MkButton>

	<MkButton v-if="isOwner || ($i.isAdmin || $i.isModerator)" danger @click="del">{{ i18n.ts._chat.deleteRoom }}</MkButton>

	<MkSwitch :modelValue="isMuted" @update:modelValue="setMuted">
		<template #label>{{ i18n.ts._chat.muteThisRoom }}</template>
	</MkSwitch>
</div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import MkButton from '@/components/MkButton.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { ensureSignin } from '@/i.js';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import { useRouter } from '@/router.js';
import { chatMuteErrors, chatRoomDeleteErrors, chatRoomUpdateErrors } from './chat-errors.js';

const router = useRouter();
const $i = ensureSignin();

const props = defineProps<{
	room: Misskey.entities.ChatRoom;
}>();

const isOwner = computed(() => {
	return props.room.ownerId === $i.id;
});

const name_ = ref(props.room.name);
const description_ = ref(props.room.description);

const emit = defineEmits<{
	(ev: 'updated', room: Misskey.entities.ChatRoom): void;
	(ev: 'deleting', deleting: boolean): void;
}>();

async function save() {
	// 失敗したときは apiWithDialog がダイアログで知らせるので、ここでは何もしない
	const updated = await os.apiWithDialog('chat/rooms/update', {
		roomId: props.room.id,
		name: name_.value,
		description: description_.value,
	}, undefined, chatRoomUpdateErrors).catch(() => null);
	if (updated == null) return;
	emit('updated', updated);
}

async function setArchived(isArchived: boolean) {
	if (isArchived) {
		const { canceled } = await os.confirm({
			type: 'warning',
			title: i18n.tsx._chat.archiveRoomConfirmTitle({ name: props.room.name }),
			text: i18n.ts._chat.archiveRoomConfirmDescription,
		});
		if (canceled) return;
	}

	const updated = await os.apiWithDialog('chat/rooms/update', {
		roomId: props.room.id,
		isArchived,
	}, undefined, chatRoomUpdateErrors).catch(() => null);
	if (updated == null) return;
	emit('updated', updated);
}

let roomClosed = false;
onBeforeUnmount(() => {
	roomClosed = true;
});

async function del() {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._chat.deleteRoomConfirm({ name: props.room.name }),
	});
	if (canceled) return;

	emit('deleting', true);
	try {
		await os.apiWithDialog('chat/rooms/delete', {
			roomId: props.room.id,
		}, undefined, chatRoomDeleteErrors);
	} catch {
		// apiWithDialog がエラーを表示済み。削除の通知を先に受けていれば、戻るルームはもう無い
		emit('deleting', false);
		if (!roomClosed) return;
	}
	router.push('/chat');
}

// ミュートは見ている本人だけの通知の設定で、ルームの持ち主も自分の分を切り替えられる
const isMuted = ref(props.room.isMuted ?? false);

// ページがルームを読み直したら、スイッチもそれに合わせる
watch(() => props.room.isMuted, muted => {
	isMuted.value = muted ?? false;
});

async function setMuted(mute: boolean) {
	isMuted.value = mute;
	try {
		await os.apiWithDialog('chat/rooms/mute', {
			roomId: props.room.id,
			mute,
		}, undefined, chatMuteErrors);
	} catch {
		// apiWithDialog がエラーを表示済み。変わっていないのだから、スイッチも戻す
		isMuted.value = !mute;
		return;
	}

	// このタブは開き直すたびに作り直される。ページが持つルームにも伝えておかないと、戻ってきたときにスイッチが前の状態で出る
	emit('updated', { ...props.room, isMuted: mute });
}
</script>

<style lang="scss" module>
.membership {
	display: flex;
}

.membershipBody {
	flex: 1;
	min-width: 0;
	margin-right: 8px;

	&:hover {
		text-decoration: none;
	}
}
</style>
