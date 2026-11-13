<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl" :class="[$style.root, { [$style.wide]: !narrow }]">
	<aside v-if="!narrow && room && channels.length" :class="$style.rail">
		<div :class="$style.groupHeading"><MkAvatar :room="room" :class="$style.groupAvatar"/><strong :class="$style.groupName">{{ room.name }}</strong></div>
		<nav :aria-label="i18n.ts._chat._channels.channels" class="_gaps_s">
			<MkA v-for="channel in channels" :key="channel.id" :to="channelConversationPath(room.id, channel.id)" :class="[$style.channel, { [$style.selected]: channel.id === channelId, [$style.unread]: displayUnreadChannelIds.includes(channel.id) }]" :aria-current="channel.id === channelId ? 'page' : undefined">#{{ channel.name }}</MkA>
		</nav>
	</aside>
	<XConversation
		v-if="room && selectedChannel"
		:key="`${room.id}:${selectedChannel.id}`"
		:class="$style.conversation"
		:roomId="room.id"
		:channelId="selectedChannel.id"
		:channels="channels"
		:channelListBack="narrow"
		@channelsUpdated="refresh"
	/>
	<PageWithHeader v-else :class="$style.listPage" backFallback="/chat" :backTo="narrow ? '/chat' : undefined" :actions="actions">
		<div class="_spacer _gaps" style="--MI_SPACER-w: 700px;">
			<MkLoading v-if="loading && !room"/>
			<MkResult v-else-if="failed" type="error"/>
			<template v-else-if="room">
				<XInfo v-if="showInfo" :room="room" :channels="channels" @updated="refresh" @channelsUpdated="refresh" @deleting="deletingOwnRoom = $event"/>
				<nav v-else :aria-label="i18n.ts._chat._channels.channels" class="_gaps_s">
					<MkA v-for="channel in channels" :key="channel.id" :to="channelConversationPath(room.id, channel.id)" class="_panel" :class="[$style.channel, { [$style.unread]: displayUnreadChannelIds.includes(channel.id) }]">#{{ channel.name }} <i class="ti ti-chevron-right" aria-hidden="true"></i></MkA>
				</nav>
			</template>
		</div>
	</PageWithHeader>
</div>
</template>

<script lang="ts" setup>
import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, useTemplateRef, watch } from 'vue';
import type * as Misskey from 'cherrypick-js';
import XConversation from './room.vue';
import XInfo from './room.info.vue';
import { channelConversationPath } from './chat-channel-references.js';
import { i18n } from '@/i18n.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { useRouter } from '@/router.js';
import { useStream } from '@/stream.js';
import { useElementWidth } from '@/composables/use-element-width.js';
import { definePage } from '@/page.js';
import { ensureSignin } from '@/i.js';
import * as os from '@/os.js';

const props = defineProps<{ roomId: string; channelId?: string; unreadChannelIds?: string[] }>();
const router = useRouter();
const $i = ensureSignin();
const rootEl = useTemplateRef('rootEl');
const width = useElementWidth(rootEl);
const narrow = computed(() => (width.value ?? 0) < 800);
const room = ref<Misskey.entities.ChatRoom | null>(null);
const channels = ref<Misskey.entities.ChatRoomChannel[]>([]);
const loading = ref(false);
const failed = ref(false);
const fetchedUnreadChannelIds = ref<string[]>([]);
const displayUnreadChannelIds = computed(() => props.unreadChannelIds ?? fetchedUnreadChannelIds.value);
const showInfo = ref(false);
const deletingOwnRoom = ref(false);
const selectedChannel = computed(() => channels.value.find(channel => channel.id === props.channelId && channel.roomId === props.roomId));
let request = 0;
let active = true;
let unreadRequest = 0;
let mainSubscription: Misskey.IChannelConnection<Misskey.Channels['main']> | null = null;
let subscription: Misskey.IChannelConnection<Misskey.Channels['chatRoom']> | null = null;

function selectFirst() {
	if (room.value?.id !== props.roomId || channels.value.length === 0) return;
	if (props.channelId != null && !selectedChannel.value) {
		os.alert({ type: 'info', text: i18n.ts._chat._channels.deletedNotice });
		router.replaceByPath(channelConversationPath(props.roomId, channels.value[0].id));
	} else if (!narrow.value && props.channelId == null) {
		router.replaceByPath(channelConversationPath(props.roomId, channels.value[0].id));
	}
}

async function refreshUnread() {
	if (props.unreadChannelIds != null) return;
	const version = ++unreadRequest;
	const target = props.roomId;
	try {
		const state = await misskeyApi('chat/rooms/unread', { roomId: target });
		if (version !== unreadRequest || !active || target !== props.roomId) return;
		fetchedUnreadChannelIds.value = state.unreadChannelIds;
	} catch {
		// Preserve the current static display until the next unread or reconnect event.
	}
}

async function refresh() {
	const version = ++request;
	const target = props.roomId;
	loading.value = true;
	failed.value = false;
	try {
		const fetched = await misskeyApi('chat/rooms/show', { roomId: target });
		if (version !== request || !active) return;
		if (!fetched.hasChannels || fetched.invitationExists) {
			router.replaceByPath(`/chat/room/${target}`);
			return;
		}
		const list = await misskeyApi('chat/rooms/channels/list', { roomId: target });
		if (version !== request || !active) return;
		room.value = fetched;
		channels.value = list.filter(channel => channel.roomId === target);
		selectFirst();
		void refreshUnread();
		mainSubscription?.dispose();
		mainSubscription = useStream().useChannel('main');
		mainSubscription.on('chatUnread', () => { if (active && target === props.roomId) void refreshUnread(); });
		mainSubscription.on('_subscribed_', () => { if (active && target === props.roomId) void refreshUnread(); });
		subscription?.dispose();
		// 목록을 보는 것만으로는 메시지를 읽지 않는다. read는 대화의 구독에서만 보낸다.
		subscription = useStream().useChannel('chatRoom', { roomId: target, channelId: channels.value[0]?.id });
		subscription.on('channelsUpdated', () => { if (active && target === props.roomId) void refresh(); });
		subscription.on('roomUpdated', () => { if (active && target === props.roomId) void refresh(); });
		subscription.on('roomDeleted', () => {
			if (!active || target !== props.roomId || selectedChannel.value || deletingOwnRoom.value) return;
			closeList(i18n.ts._chat.roomDeleted);
		});
		subscription.on('membershipEnded', ctx => {
			if (!active || target !== props.roomId || selectedChannel.value || ctx.userId !== $i.id) return;
			closeList(i18n.ts._chat.removedFromRoom);
		});
	} catch (err) {
		if (version === request && active) {
			const code = (err as Misskey.api.APIError | null)?.code;
			if (code === 'ROOM_DELETED') closeList(i18n.ts._chat.roomDeleted);
			else if (code === 'NO_SUCH_ROOM') closeList(i18n.ts._chat.roomUnavailable);
			else failed.value = true;
		}
	} finally {
		if (version === request) loading.value = false;
	}
}

function closeList(text: string) {
	os.alert({ type: 'info', text });
	router.replace('/chat');
}

watch(() => props.roomId, () => { room.value = null; channels.value = []; fetchedUnreadChannelIds.value = []; unreadRequest++; showInfo.value = false; void refresh(); }, { immediate: true });
watch(() => props.channelId, () => { if (room.value?.id === props.roomId) void refresh(); });
watch(narrow, selectFirst);
onDeactivated(() => { active = false; request++; unreadRequest++; subscription?.dispose(); subscription = null; mainSubscription?.dispose(); mainSubscription = null; });
onActivated(() => { if (!active) { active = true; void refresh(); } });
onBeforeUnmount(() => { active = false; request++; unreadRequest++; subscription?.dispose(); mainSubscription?.dispose(); });

const actions = computed(() => room.value ? [{ icon: showInfo.value ? 'ti ti-hash' : 'ti ti-info-circle', text: showInfo.value ? i18n.ts._chat._channels.channels : i18n.ts.info, handler: () => { showInfo.value = !showInfo.value; } }] : []);
definePage(computed(() => ({ title: room.value?.name ?? i18n.ts._chat._channels.channels, subtitle: i18n.ts._chat._channels.channels, ...(room.value ? { roomAvatar: room.value } : { icon: 'ti ti-users' }) })));
</script>

<style lang="scss" module>
.root {
	min-width: 0;
	min-height: 100cqh;
}

.wide {
	display: flex;
}

.rail {
	position: sticky;
	top: 0;
	align-self: flex-start;
	box-sizing: border-box;
	width: 220px;
	max-height: 100cqh;
	flex-shrink: 0;
	overflow-y: auto;
	padding: 16px 8px;
	border-right: 1px solid var(--MI_THEME-divider);
	background: var(--MI_THEME-panel);
}

.groupHeading {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px;
}

.groupAvatar {
	width: 36px;
	height: 36px;
	flex-shrink: 0;
}

.groupName {
	display: block;
	min-width: 0;
	overflow-wrap: anywhere;
}

.channel {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 14px;
	white-space: pre-wrap;
	overflow-wrap: anywhere;
	font-weight: normal;

	&.selected {
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
	}

	&.unread {
		font-weight: bold;
	}
}

.conversation, .listPage {
	flex: 1;
	min-width: 0;
}
</style>
