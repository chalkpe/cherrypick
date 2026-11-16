<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader>
	<div class="_spacer" style="--MI_SPACER-w: 600px;">
		<MkLoading v-if="fetching"/>
		<MkResult v-else-if="fetchError === 'notFound'" type="notFound" :text="i18n.ts._chat._inviteLink.notFound"/>
		<MkResult v-else-if="fetchError === 'error'" type="error"/>
		<div v-else-if="preview != null" class="_panel _gaps" :class="$style.root">
			<!-- 공개하는 것은 그룹 이름·설명·아이콘·멤버 수뿐이다. 멤버·채널·그룹장은 보이지 않는다 -->
			<div><MkAvatar v-if="previewAvatar" :room="previewAvatar" :class="$style.icon"/></div>
			<div :class="$style.name"><Mfm :text="preview.name" :plain="true"/></div>
			<div v-if="preview.description" :class="$style.description"><Mfm :text="preview.description"/></div>
			<div :class="$style.members">{{ i18n.tsx._chat._inviteLink.membersCount({ n: preview.membersCount }) }}</div>
			<div class="_buttonsCenter">
				<MkButton v-if="preview.joinedRoomId != null" primary rounded @click="openRoom(preview.joinedRoomId)">
					<i class="ti ti-door-enter"></i> {{ i18n.ts._chat._inviteLink.openRoom }}
				</MkButton>
				<MkButton v-else primary rounded :disabled="joinState?.joining" @click="join">
					<i class="ti ti-plus"></i> {{ i18n.ts._chat.join }}
				</MkButton>
			</div>
			<MkInfo v-if="joinState?.status === 'pending'">{{ i18n.ts._chat._inviteLink.pending }}</MkInfo>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import { url } from '@@/js/config.js';
import { chatInviteAvatar, chatInviteJoinState, hasChatInviteIcon, joinChatInvite } from './chat-invite-link.js';
import { chatInviteJoinErrorText } from './chat-errors.js';
import MkButton from '@/components/MkButton.vue';
import MkInfo from '@/components/MkInfo.vue';
import { i18n } from '@/i18n.js';
import * as os from '@/os.js';
import { $i } from '@/i.js';
import { definePage } from '@/page.js';
import { useRouter } from '@/router.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { pleaseLogin } from '@/utility/please-login.js';

const props = defineProps<{
	code: string;
}>();

const router = useRouter();

const fetching = ref(true);
const fetchError = ref<'notFound' | 'error' | null>(null);
const preview = ref<Misskey.Endpoints['chat/invite-link/show']['res'] | null>(null);

// 직접 연 주소는 이 서버가 발급한 초대다
const inviteUrl = computed(() => `${url}/chat/invite/${encodeURIComponent(props.code)}`);
const joinState = computed(() => chatInviteJoinState(inviteUrl.value));
const previewAvatar = computed(() => preview.value == null ? null : chatInviteAvatar(preview.value, inviteUrl.value, null));

let latestRequest = 0;
let mounted = true;

onBeforeUnmount(() => {
	mounted = false;
});

// 미리보기만 읽는다. 화면을 열거나 미리 읽는 것으로는 가입하지 않는다
async function fetchPreview() {
	const request = ++latestRequest;
	fetching.value = true;
	fetchError.value = null;
	preview.value = null;
	try {
		const result = await misskeyApi('chat/invite-link/show', { code: props.code });
		if (request !== latestRequest) return;
		if (!hasChatInviteIcon(result)) throw new Error('Invalid chat invite icon');
		preview.value = result;
	} catch (err) {
		if (request !== latestRequest) return;
		const code = (err as { code?: string } | null)?.code;
		fetchError.value = code === 'NO_SUCH_INVITE_LINK' || code === 'INVALID_PARAM' ? 'notFound' : 'error';
	} finally {
		if (request === latestRequest) fetching.value = false;
	}
}

watch(() => props.code, fetchPreview, { immediate: true });

function openRoom(roomId: string) {
	router.push('/chat/room/:roomId', { params: { roomId } });
}

async function join() {
	// 이 화면에는 원격 계정 입력이나 다른 서버로 가입하는 절차를 두지 않는다
	if ($i == null) {
		await pleaseLogin();
		return;
	}

	const outcome = await joinChatInvite(inviteUrl.value);
	switch (outcome.kind) {
		case 'joined':
			// 기존 그룹 주소가 맨 위 채널 대화를 연다
			if (mounted) openRoom(outcome.roomId);
			break;
		case 'failed':
			os.alert({ type: 'error', text: chatInviteJoinErrorText(outcome.error) });
			break;
	}
}

definePage(() => ({
	title: i18n.ts._chat._inviteLink.pageTitle,
	icon: 'ti ti-users',
}));
</script>

<style lang="scss" module>
.root {
	padding: 24px;
	text-align: center;
}

.icon {
	width: 72px;
	height: 72px;
}

.name {
	font-size: 1.3em;
	font-weight: bold;
	overflow-wrap: anywhere;
}

.description {
	overflow-wrap: anywhere;
}

.members {
	opacity: 0.8;
}
</style>
