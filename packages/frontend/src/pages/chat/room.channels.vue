<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div ref="rootEl" :class="[$style.root, { [$style.wide]: !narrow }]">
	<aside v-if="!narrow && room && channels.length" :class="$style.rail">
		<div class="_spacer" style="--MI_SPACER-w: 700px; --MI_SPACER-min: 16px;">
			<div class="_gaps">
				<div :class="$style.banner">
					<MkAvatar :room="room" :class="$style.bannerAvatar"/>
					<div :class="$style.bannerName">{{ room.name }}</div>
				</div>
				<nav :aria-label="i18n.ts._chat._channels.channels">
					<MkSuperMenu :def="menuDef" :draggable="canReorder && !railBusy" @reorder="onRailReorder"/>
				</nav>
			</div>
		</div>
	</aside>
	<XConversation
		v-if="room && selectedChannel"
		:key="`${room.id}:${selectedChannel.id}`"
		:class="$style.conversation"
		:roomId="room.id"
		:channelId="selectedChannel.id"
		:channels="channels"
		:channelListBack="narrow"
		:mobileFooterInFlow="true"
		@channelsUpdated="refresh"
	/>
	<PageWithHeader v-else :class="$style.listPage" backFallback="/chat" :backTo="narrow ? '/chat' : undefined" :actions="actions">
		<div class="_spacer _gaps" style="--MI_SPACER-w: 700px;">
			<MkLoading v-if="loading && !room"/>
			<MkResult v-else-if="failed" type="error"/>
			<template v-else-if="room">
				<XInfo v-if="showInfo" :room="room" :channels="channels" @updated="refresh" @channelsUpdated="refresh" @deleting="deletingOwnRoom = $event"/>
				<nav v-else :aria-label="i18n.ts._chat._channels.channels">
					<MkSuperMenu :def="menuDef" grid/>
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
import { chatErrorText } from './chat-errors.js';
import type { SuperMenuDef } from '@/components/MkSuperMenu.vue';
import MkSuperMenu from '@/components/MkSuperMenu.vue';
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
const railBusy = ref(false);
const canReorder = computed(() => room.value != null && room.value.ownerId === $i.id && !room.value.isArchived && $i.policies.chatAvailability === 'available');
const menuDef = computed<SuperMenuDef[]>(() => [{
	items: channels.value.map(channel => ({
		id: channel.id,
		to: channelConversationPath(props.roomId, channel.id),
		icon: 'ti ti-hash',
		text: channel.name,
		active: channel.id === props.channelId,
		indicated: displayUnreadChannelIds.value.includes(channel.id),
	})),
}]);
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

function onRailReorder(_groupIndex: number, items: SuperMenuDef['items']) {
	const byId = new Map(channels.value.map(channel => [channel.id, channel]));
	const next = items.flatMap(item => {
		const channel = item.id != null ? byId.get(item.id) : undefined;
		return channel ? [channel] : [];
	});
	void reorderChannels(next);
}

async function reorderChannels(newList: Misskey.entities.ChatRoomChannel[]) {
	if (!canReorder.value || railBusy.value || !active) return;
	const target = props.roomId;
	const previous = channels.value;
	const ids = newList.map(channel => channel.id);
	channels.value = newList;
	railBusy.value = true;
	try {
		await misskeyApi('chat/rooms/channels/reorder', { roomId: target, channelIds: ids });
	} catch (err) {
		if (active && target === props.roomId) {
			channels.value = previous;
			os.alert({ type: 'error', text: chatErrorText(err) });
			void refresh();
		}
	} finally {
		railBusy.value = false;
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
definePage(computed(() => ({ title: room.value?.name ?? i18n.ts._chat._channels.channels, subtitle: i18n.ts._chat._channels.channels, mobileFooterInFlow: true, ...(room.value ? { roomAvatar: room.value } : { icon: 'ti ti-users' }) })));
</script>

<style lang="scss" module>
.root {
	height: 100%;
	min-width: 0;
	min-height: 0;
}

.wide {
	display: flex;
}

.rail {
	position: sticky;
	top: 0;
	box-sizing: border-box;
	width: 32%;
	max-width: 280px;
	flex-shrink: 0;
	border-right: solid 0.5px var(--MI_THEME-divider);
	overflow: auto;
	height: 100cqh;
}

.banner {
	margin: 16px;
}

.bannerAvatar {
	display: block;
	margin: auto;
	width: 54px;
	height: 54px;
}

.bannerName {
	margin-top: 8px;
	text-align: center;
	font-weight: bold;
	overflow-wrap: anywhere;
}

.conversation, .listPage {
	flex: 1;
	min-width: 0;
}
</style>
