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
import { prefer } from '@/preferences.js';
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
const fetchedNotificationChannelIds = ref<string[]>([]);
const displayUnreadChannelIds = computed(() => props.unreadChannelIds ?? fetchedUnreadChannelIds.value);
const displayNotificationChannelIds = computed(() => fetchedNotificationChannelIds.value);
const showInfo = ref(false);
const deletingOwnRoom = ref(false);
const selectedChannel = computed(() => channels.value.find(channel => channel.id === props.channelId && channel.roomId === props.roomId));
// 스택 라우터에서는 뒤에 남은 목록도 마운트가 유지되어 active만으로는 현재 화면을 알 수 없다.
// 라우트가 이 목록(또는 레일과 대화)인지로 맨 앞을 판단한다.
const isFrontmost = computed(() => {
	const current = router.currentRef.value;
	return current.route.path === '/chat/room/:roomId/channels/:channelId?'
		&& current.props.get('roomId') === props.roomId
		&& (current.props.get('channelId') ?? null) === (props.channelId ?? null);
});
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
		// 알림 대상(모두 받기의 미읽음, 멘션만 받기의 멘션)만 깜빡이고 나머지는 정적으로 보여준다.
		pulsing: displayNotificationChannelIds.value.includes(channel.id),
		ariaCurrent: channel.id === props.channelId ? 'page' : undefined,
	})),
}]);
let request = 0;
let active = true;
let unreadRequest = 0;
let mainSubscription: Misskey.IChannelConnection<Misskey.Channels['main']> | null = null;
let subscription: Misskey.IChannelConnection<Misskey.Channels['chatRoom']> | null = null;

function selectFirst() {
	if (!isFrontmost.value) return;
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
		fetchedNotificationChannelIds.value = state.notificationChannelIds;
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
		if (version !== request || !active || !isFrontmost.value) return;
		if (!fetched.hasChannels || fetched.invitationExists) {
			router.replaceByPath(`/chat/room/${target}`);
			return;
		}
		const list = await misskeyApi('chat/rooms/channels/list', { roomId: target });
		if (version !== request || !active || !isFrontmost.value) return;
		room.value = fetched;
		channels.value = list.filter(channel => channel.roomId === target);
		selectFirst();
		void refreshUnread();
		mainSubscription?.dispose();
		mainSubscription = useStream().useChannel('main');
		mainSubscription.on('chatUnread', () => { if (active && target === props.roomId) void refreshUnread(); });
		subscription?.dispose();
		// 목록을 보는 것만으로는 메시지를 읽지 않는다. read는 대화의 구독에서만 보낸다.
		subscription = useStream().useChannel('chatRoom', { roomId: target, channelId: channels.value[0]?.id });
		subscription.on('channelsUpdated', () => { if (active && target === props.roomId) void refresh(); });
		subscription.on('roomUpdated', () => { if (active && target === props.roomId) void refresh(); });
		subscription.on('roomDeleted', () => {
			if (!active || target !== props.roomId || selectedChannel.value || deletingOwnRoom.value) return;
			// 스택 라우터에서 뒤에 남은 목록은 안내·이동을 미룬다. 돌아온 시점의 다시 읽기가 삭제를 처리한다.
			if (prefer.s['experimental.stackingRouterView'] && !isFrontmost.value) return;
			closeList(i18n.ts._chat.roomDeleted);
		});
		subscription.on('membershipEnded', ctx => {
			if (!active || target !== props.roomId || selectedChannel.value || ctx.userId !== $i.id) return;
			if (prefer.s['experimental.stackingRouterView'] && !isFrontmost.value) return;
			closeList(i18n.ts._chat.removedFromRoom);
		});
	} catch (err) {
		if (version === request && active && isFrontmost.value) {
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

// 끊긴 동안 구독 기준 채널이 삭제되면 서버가 구독을 거부해 확인(_subscribed_)이 오지 않는다.
// 연결 복구 자체를 기준으로 목록과 미읽음을 한 곳에서 다시 읽고, 구독 대상도 남은 채널로 다시 고른다.
// 뒤에 남은 목록이 현재 화면을 바꾸지 않도록 맨 앞 화면일 때만 다시 읽는다.
function onStreamConnected() {
	if (active && isFrontmost.value) void refresh();
}

useStream().on('_connected_', onStreamConnected);
watch(() => props.roomId, () => { room.value = null; channels.value = []; fetchedUnreadChannelIds.value = []; fetchedNotificationChannelIds.value = []; unreadRequest++; showInfo.value = false; void refresh(); }, { immediate: true });
watch(() => props.channelId, () => { if (room.value?.id === props.roomId) void refresh(); });
watch(narrow, selectFirst);
// 스택 라우터는 뒤에 남은 목록을 언마운트/비활성화하지 않으므로 onActivated가 오지 않는다.
// 현재 경로로 돌아온 순간이 재진입 시점이라 이때 기존 다시 읽기를 실행한다.
watch(isFrontmost, (frontmost, wasFrontmost) => {
	if (!prefer.s['experimental.stackingRouterView']) return;
	if (frontmost && !wasFrontmost && active) void refresh();
});
onDeactivated(() => { active = false; request++; unreadRequest++; useStream().off('_connected_', onStreamConnected); subscription?.dispose(); subscription = null; mainSubscription?.dispose(); mainSubscription = null; });
onActivated(() => { if (!active) { active = true; useStream().on('_connected_', onStreamConnected); void refresh(); } });
onBeforeUnmount(() => { active = false; request++; unreadRequest++; useStream().off('_connected_', onStreamConnected); subscription?.dispose(); mainSubscription?.dispose(); });

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

	// 긴 채널 이름이 레일 가로폭을 늘리지 않도록 이 메뉴에서만 이름 줄바꿈을 허용한다.
	:global(.item > span:not(.itemIndicator)) {
		min-width: 0;
	}

	:global(.item .text) {
		overflow-wrap: anywhere;
	}
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
