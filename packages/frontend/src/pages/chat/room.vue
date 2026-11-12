<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader ref="pageEl" v-model:tab="tab" centerTitle backFallback="/chat" :reversed="tab === 'chat'" :tabs="headerTabs" :actions="headerActions">
	<!-- 自分が通話に入っているあいだは、通話 (ステージ) を出す。広いページではステージとチャットを左右に並べ、ステージは一つだけ作ってチャットを置く側の反対へ CSS の順序で移す。
	狭いページではステージをいっぱいに広げ、チャットはその上に下から重ねるシートとして開く -->
	<div v-if="tab === 'chat'" ref="chatTabEl" :style="{ '--voiceCallBottomSpacing': isMobile && isFriendly().value ? 'var(--MI-mobileFooterHeight, 0px)' : '0px' }" :class="[$style.chatTab, { [$style.split]: split, [$style.narrowCall]: split && voiceInOwnTab, [$style.chatLeft]: split && chatSide === 'left' }]">
		<XStage v-if="split && room" :room="room" :call="voiceCallState" :class="$style.stage" :chatOpen="chatOpen" @toggleChat="chatOpen = !chatOpen"/>
		<div v-if="split && voiceInOwnTab && chatOpen" ref="sheetBackdropEl" :class="$style.sheetBackdrop" @click="chatOpen = false"></div>
		<!-- シートを開いたらすぐ中へフォーカスを移すので、v-show (フォーカスを移す watch より後に表示を切り替える) ではなく style で隠す -->
		<!-- シートはステージの上に重ねるだけなので、ステージ (と暗くした背景) の外、ページのヘッダーや画面下のナビゲーションは使えるままにする (aria-modal にはしない) -->
		<div
			ref="chatPaneEl"
			:class="$style.chatPane"
			:style="!split || chatOpen ? undefined : { display: 'none' }"
			:role="split && voiceInOwnTab && chatOpen ? 'dialog' : undefined"
			:aria-label="i18n.ts._chat.messages"
			@dragover="chatFormEl?.onDragover($event)"
			@drop="chatFormEl?.onDrop($event)"
			@keydown.esc="onSheetEsc"
		>
			<!-- シートを開くと focus trap がステージを inert にするので、通話の状態はシートの中からも読み上げる -->
			<div v-if="split && voiceInOwnTab" :class="$style.sheetHeading">
				<strong>{{ i18n.ts._chat.messages }}</strong>
				<span v-if="chatOpen" class="_srOnly" aria-live="polite">{{ voiceCallStatusText }}</span>
				<button v-tooltip="i18n.ts.close" class="_button" :aria-label="i18n.ts.close" @click="chatOpen = false"><i class="ti ti-x" aria-hidden="true"></i></button>
			</div>
			<button
				v-if="split && !voiceInOwnTab"
				v-tooltip="chatSide === 'right' ? i18n.ts._voiceCall.moveChatLeft : i18n.ts._voiceCall.moveChatRight"
				class="_button" :class="[$style.chatCorner, { [$style.cornerRight]: chatSide === 'left' }]"
				:aria-label="chatSide === 'right' ? i18n.ts._voiceCall.moveChatLeft : i18n.ts._voiceCall.moveChatRight"
				@click="swapChatSide"
			>
				<i :class="chatSide === 'right' ? 'ti ti-layout-sidebar' : 'ti ti-layout-sidebar-right'" aria-hidden="true"></i>
			</button>
			<!-- 並べているときはメッセージの欄だけを自分でスクロールさせる -->
			<div ref="chatScrollerEl" :class="$style.chatScroller">
				<!-- 通話の参加バナーはメッセージをスクロールしてもページヘッダーの下に貼り付ける -->
				<MkStickyContainer ref="chatStickyEl" class="_spacer" style="--MI_SPACER-w: 700px;">
					<template #header>
						<XBanner v-if="room && !split" :call="voiceCallState" :class="$style.joinBanner"/>
					</template>
					<div class="_gaps">
						<div v-if="initializing">
							<MkLoading/>
						</div>

						<MkResult v-else-if="fetchError != null" :type="fetchError"/>

						<div v-else-if="messages.length === 0">
							<div class="_gaps" style="text-align: center;">
								<div>{{ i18n.ts._chat.noMessagesYet }}</div>
								<template v-if="user">
									<div v-if="user.chatScope === 'followers'">{{ i18n.ts._chat.thisUserAllowsChatOnlyFromFollowers }}</div>
									<div v-else-if="user.chatScope === 'following'">{{ i18n.ts._chat.thisUserAllowsChatOnlyFromFollowing }}</div>
									<div v-else-if="user.chatScope === 'mutual'">{{ i18n.ts._chat.thisUserAllowsChatOnlyFromMutualFollowing }}</div>
									<div v-else-if="user.chatScope === 'none'">{{ i18n.ts._chat.thisUserNotAllowedChatAnyone }}</div>
								</template>
								<!-- 招待できるのは主だけなので、ほかの人には招待を勧めない -->
								<template v-else-if="room && !room.isArchived && room.ownerId === $i.id && $i.policies.chatAvailability === 'available'">
									<div aria-live="polite" class="_gaps">
										<div v-if="joinedMemberCount > 0">{{ i18n.tsx._chat.roomMembersJoined({ n: joinedMemberCount }) }}</div>
										<div v-if="sentInvitationCount > 0">{{ i18n.tsx._chat.roomInvitationsWaiting({ n: sentInvitationCount }) }}</div>
										<div v-if="joinedMemberCount === 0 && sentInvitationCount === 0">{{ i18n.ts._chat.inviteUserToChat }}</div>
									</div>
									<div :class="$style.emptyActions">
										<MkButton v-if="joinedMemberCount > 0 || sentInvitationCount > 0" rounded @click="tab = 'members'"><i class="ti ti-users"></i> {{ i18n.ts._chat.viewMembers }}</MkButton>
										<MkButton primary rounded @click="inviteUser"><i class="ti ti-plus"></i> {{ i18n.ts._chat.inviteUser }}</MkButton>
									</div>
								</template>
							</div>
						</div>

						<div v-else ref="timelineEl" class="_gaps" :class="{ [$style.ownScroller]: split }">
							<div v-if="canFetchMore" :class="$style.moreRow">
								<MkButton :class="$style.more" :wait="moreFetching" primary rounded @click="fetchMore">{{ i18n.ts.loadMore }}</MkButton>
							</div>

							<TransitionGroup
								ref="timelineItemsEl"
								:enterActiveClass="prefer.s.animation ? $style.transition_x_enterActive : ''"
								:leaveActiveClass="prefer.s.animation ? $style.transition_x_leaveActive : ''"
								:enterFromClass="prefer.s.animation ? $style.transition_x_enterFrom : ''"
								:leaveToClass="prefer.s.animation ? $style.transition_x_leaveTo : ''"
								:moveClass="prefer.s.animation ? $style.transition_x_move : ''"
								tag="div" class="_gaps"
							>
								<template v-for="(item, i) in displayTimeline" :key="item.id">
									<!-- TransitionGroup は直下の子コンポーネントを毎回描き直させるので、吹き出しは要素で包む。
									こうすると新着が来ても、まとまりの位置 (真偽値) が変わった吹き出しだけが描き直される -->
									<div v-if="item.type === 'item'" :class="{ [$style.stackedMessage]: groupPositions[i]?.first === false }">
										<XMessage
											:message="item.data"
											:canEdit="true"
											:roomArchived="room?.isArchived === true"
											:firstInGroup="groupPositions[i]?.first ?? true"
											:lastInGroup="groupPositions[i]?.last ?? true"
											@edit="onEditMessage"
										/>
									</div>
									<div v-else-if="item.type === 'date'" :class="$style.dateDivider">
										<span><i class="ti ti-chevron-up"></i> {{ item.nextText }}</span>
										<span style="height: 1em; width: 1px; background: var(--MI_THEME-divider);"></span>
										<span>{{ item.prevText }} <i class="ti ti-chevron-down"></i></span>
									</div>
								</template>
							</TransitionGroup>
						</div>

						<div v-if="user && !user.canChat">
							<MkInfo warn>{{ i18n.ts._chat.chatNotAvailableInOtherAccount }}</MkInfo>
						</div>

						<MkInfo v-if="room?.isArchived" warn>{{ i18n.ts._chat.thisRoomIsArchived }}</MkInfo>

						<MkInfo v-if="$i.policies.chatAvailability !== 'available'" warn>{{ $i.policies.chatAvailability === 'readonly' ? i18n.ts._chat.chatIsReadOnlyForThisAccountOrServer : i18n.ts._chat.chatNotAvailableForThisAccountOrServer }}</MkInfo>
					</div>
				</MkStickyContainer>
			</div>
			<!-- 並べているときの入力欄の置き場所。入力欄はページの下端 (footer) からここへ移ってくる。
			v-show は描画のあと (フォーカスを戻す watch より後) に表示を切り替えるので、隠れた所へ focus() してしまう。
			ブラウザは隠れた要素への focus() を無視するので、表示は style で描画と同時に切り替える -->
			<div ref="paneFormHostEl" :class="$style.paneFooter" :style="split ? undefined : { display: 'none' }"></div>
		</div>
	</div>

	<div v-if="tab === 'search'" class="_spacer" style="--MI_SPACER-w: 700px;">
		<XSearch :userId="userId" :roomId="roomId"/>
	</div>

	<div v-else-if="tab === 'members'" class="_spacer" style="--MI_SPACER-w: 700px;">
		<XMembers v-if="room != null" :key="membershipVersion" :room="room" @inviteUser="inviteUser"/>
	</div>

	<div v-else-if="tab === 'info'" class="_spacer" style="--MI_SPACER-w: 700px;">
		<XInfo v-if="room != null" :room="room" @updated="room = $event" @deleting="deletingOwnRoom = $event"/>
	</div>

	<template #footer>
		<!-- 表示は v-show ではなく style で切り替える (上の paneFormHostEl と同じ理由) -->
		<div v-if="tab === 'chat'" :class="[$style.footer, {[$style.isFriendly]: isMobile && isFriendly().value }]" :style="split ? { display: 'none' } : undefined">
			<!-- 入力欄は 1 つだけ作り、並べ方が変わっても作り直さずに置き場所だけを移す (並べているときはメッセージの欄の下へ)。
			作り直すとフォーカスが外れてページ全体のショートカットが効いてしまい、変換中の文字や送信中の状態も失われる -->
			<Teleport v-if="paneFormHostEl != null" :to="paneFormHostEl" :disabled="!split">
				<div ref="formEl" class="_gaps" :class="$style.formArea" @compositionstart="composing = true" @compositionend="composing = false" @focusout="composing = false">
					<Transition name="fade">
						<div v-show="showIndicator" :class="$style.new">
							<button class="_buttonPrimary" :class="$style.newButton" @click="onIndicatorClick">
								<i class="ti ti-circle-arrow-down" :class="$style.newIcon" aria-hidden="true"></i>{{ i18n.ts._chat.newMessage }}
							</button>
						</div>
					</Transition>
					<XForm v-if="initialized && !room?.isArchived && !membershipEnded" ref="chatFormEl" :user="user" :room="room" :editingMessage="editingMessage" :class="$style.form" @edited="onEdited" @cancelEdit="onCancelEdit" @sent="onSent"/>
				</div>
			</Teleport>
		</div>
	</template>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, useTemplateRef, computed, watch, nextTick, onMounted, onBeforeUnmount, onDeactivated, onActivated, onUnmounted } from 'vue';
import * as Misskey from 'cherrypick-js';
import { getScrollContainer } from '@@/js/scroll.js';
import XMessage from './XMessage.vue';
import XForm from './room.form.vue';
import XSearch from './room.search.vue';
import XMembers from './room.members.vue';
import XInfo from './room.info.vue';
import XBanner from './room.voice.banner.vue';
import XStage from './room.voice.stage.vue';
import { chatJoinErrors, chatLeaveErrors } from './chat-errors.js';
import { getUninvitableUsers, inviteUsersToRoom } from './chat-invite.js';
import type { MenuItem } from '@/types/menu.js';
import type { PageHeaderItem } from '@/types/page-header.js';
import * as os from '@/os.js';
import { globalEvents } from '@/events.js';
import { useStream } from '@/stream.js';
import * as sound from '@/utility/sound.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { prefer } from '@/preferences.js';
import MkButton from '@/components/MkButton.vue';
import { useRouter } from '@/router.js';
import MkInfo from '@/components/MkInfo.vue';
import { makeDateSeparatedTimelineComputedRef } from '@/utility/timeline-date-separate.js';
import { getChatMessageGroupPositions } from '@/utility/chat-message-grouping.js';
import { acct as getAcct } from '@@/js/user.js';
import { isFriendly } from '@/utility/is-friendly.js';
import { deviceKind } from '@/utility/device-kind.js';
import { useChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { useChatReadingPlace } from '@/composables/use-chat-reading-place.js';
import { useElementWidth } from '@/composables/use-element-width.js';
import { focusTrap } from '@/utility/focus-trap.js';
import { isTouchUsing } from '@/utility/touch.js';
import { voiceCallStatusText } from '@/utility/voice-call-status.js';

const MOBILE_THRESHOLD = 500;
// ページ自身の幅がこれ以上あれば、通話とチャットを左右に並べる
const STAGE_MIN_PAGE_WIDTH = 960;

const isMobile = ref(deviceKind === 'smartphone' || window.innerWidth <= MOBILE_THRESHOLD);
const handleResize = () => {
	isMobile.value = deviceKind === 'smartphone' || window.innerWidth <= MOBILE_THRESHOLD;
};

window.addEventListener('resize', handleResize);

const $i = ensureSignin();
const router = useRouter();

const props = defineProps<{
	userId?: string;
	roomId?: string;
}>();

export type NormalizedChatMessage = Omit<Misskey.entities.ChatMessageLite, 'fromUser' | 'reactions'> & {
	fromUser: Misskey.entities.UserLite;
	editedAt?: string | null;
	deletedAt?: string | null;
	reactions: (Misskey.entities.ChatMessageLite['reactions'][number] & {
		user: Misskey.entities.UserLite;
	})[];
};

const initializing = ref(false);
const initialized = ref(false);
const fetchError = ref<'notFound' | 'error' | null>(null);
const moreFetching = ref(false);
const messages = ref<NormalizedChatMessage[]>([]);
const editingMessage = ref<NormalizedChatMessage | null>(null);

function onEditMessage(message: NormalizedChatMessage) {
	editingMessage.value = message;
}

function onEdited() {
	editingMessage.value = null;
}

function onCancelEdit() {
	editingMessage.value = null;
}

const canFetchMore = ref(false);
const user = ref<Misskey.entities.UserDetailed | null>(null);
const room = ref<Misskey.entities.ChatRoom | null>(null);
const joinedMemberCount = ref(0);
const sentInvitationCount = ref(0);
const membershipVersion = ref(0);
const membershipEnded = ref(false);
const deletingOwnRoom = ref(false);
const leavingRoom = ref(false);
let roomDeletedWhileInactive = false;
const connection = ref<Misskey.IChannelConnection<Misskey.Channels['chatUser']> | Misskey.IChannelConnection<Misskey.Channels['chatRoom']> | null>(null);
const showIndicator = ref(false);
const timelineEl = useTemplateRef('timelineEl');
const timelineItemsEl = useTemplateRef('timelineItemsEl');
const timeline = makeDateSeparatedTimelineComputedRef(messages);
// 画面には古い順に並べる
const displayTimeline = computed(() => timeline.value.toReversed());
// 同じ送信者が続けて送ったメッセージは吹き出しをまとめて詰めて表示する
const groupPositions = computed(() => getChatMessageGroupPositions(displayTimeline.value));
const voiceCallState = useChatRoomVoiceCall(room);

const SCROLL_HEAD_THRESHOLD = 200;
// スクロール位置は小数になることがあるので、このくらいの差は最下部とみなす
const SCROLL_BOTTOM_TOLERANCE = 2;

const readingPlace = useChatReadingPlace({
	timeline: timelineEl,
	items: () => Array.from<Element>(timelineItemsEl.value?.$el.children ?? []),
	nearNewest: SCROLL_HEAD_THRESHOLD,
});

// TransitionGroup は描き直す前後で吹き出しの位置を比べ、動いた分をなめらかに動かす。先に場所を戻さないと、戻した分までもう一度動いて見える。
// post の watch は変更の時点で積まれるので、描き直しで積まれる TransitionGroup の updated より先に走る。
// ブラウザのスクロールアンカーは、ここで位置を読んだ時点で済んでいるので、残ったずれだけを直す
watch([displayTimeline, groupPositions], () => {
	readingPlace.keep();
}, { flush: 'post' });

// 追従するのは最新のメッセージが変わったときだけ。編集やリアクション、古いメッセージの読み込みでは動かさない。
// ボタンを押している途中に動かすと、ボタンが逃げて押せなくなる
const newestMessageId = computed(() => messages.value[0]?.id);
let wasNearNewest = true;

// 描画のあとに測ると、読んでいた場所を保つためにブラウザが新着の高さの分だけ動かしたあとの位置になり、
// 新着が高いと最下部の近くにいても遠くにいたことになってしまう。column-reverseなのでscrollTopは負になる
watch(newestMessageId, () => {
	const scrollContainer = getScrollContainer(timelineEl.value);
	wasNearNewest = scrollContainer == null || -scrollContainer.scrollTop < SCROLL_HEAD_THRESHOLD;
}, { flush: 'pre' });

// column-reverseなので本来はスクロール位置の最下部への追従は不要なはずだが、おそらくブラウザのバグにより、最下部にスクロールした状態でも追従されない場合がある(スクロール位置が少数になることがあるのが関わっていそう)
// そのため補助として描画のあとに追従を行う
watch(newestMessageId, (_newest, previous) => {
	// KeepAlive で裏に回っているあいだや、ほかのタブを見ているあいだは、スクロールする箱がない
	const scrollContainer = getScrollContainer(timelineEl.value);
	if (scrollContainer == null) return;

	if (wasNearNewest) {
		scrollContainer.scrollTo({
			top: 0,
			behavior: 'instant',
		});
	} else if (previous != null && hasMessageFromOthersSince(previous)) {
		notifyNewMessage();
	}
}, { flush: 'post' });

// 自分がほかの端末から送ったものは知らせなくていい
function hasMessageFromOthersSince(id: NormalizedChatMessage['id']) {
	for (const message of messages.value) {
		if (message.id === id) return false;
		if (message.fromUserId !== $i.id) return true;
	}
	return false;
}

// この窓から送ったものだけ、読み返している途中でも最新へ移る。チャンネルから届くメッセージでは、自分の別の端末から送ったものと区別できないので、
// 送信の返事で知る。返事とメッセージのどちらが先に届くかは決まっていない
const sentMessageId = ref<NormalizedChatMessage['id'] | null>(null);
const sentMessageArrived = computed(() => sentMessageId.value != null && messages.value.some(m => m.id === sentMessageId.value));

function onSent(id: NormalizedChatMessage['id']) {
	sentMessageId.value = id;
}

watch(sentMessageArrived, arrived => {
	if (!arrived) return;
	sentMessageId.value = null;
	goToNewest();
}, { flush: 'post' });

function goToNewest() {
	showIndicator.value = false;
	readingPlace.forget();
	getScrollContainer(timelineEl.value)?.scrollTo({
		top: 0,
		behavior: 'instant',
	});
}

// スクロールする箱は並べ方で変わるので、箱ごとに付け替えずにまとめて受ける (scroll は上へ伝わらないがキャプチャでは受けられる)
function onScrollWhileNotified(ev: Event) {
	if (!showIndicator.value) return;
	const scrollContainer = getScrollContainer(timelineEl.value);
	if (scrollContainer != null && ev.target === scrollContainer && -scrollContainer.scrollTop < SCROLL_BOTTOM_TOLERANCE) {
		showIndicator.value = false;
	}
}

window.addEventListener('scroll', onScrollWhileNotified, { capture: true, passive: true });

// タブを移ったり閉じたりしたら案内も終わる
watch(timelineEl, el => {
	if (el == null) showIndicator.value = false;
});

function normalizeMessage(message: Misskey.entities.ChatMessageLite | Misskey.entities.ChatMessage): NormalizedChatMessage {
	return {
		...message,
		fromUser: message.fromUser ?? (message.fromUserId === $i.id ? $i : user.value!),
		reactions: message.reactions.map(record => ({
			...record,
			user: record.user ?? (message.fromUserId === $i.id ? user.value! : $i),
		})),
	};
}

function toFetchError(err: unknown): 'notFound' | 'error' {
	const code = (err as { code?: string } | null)?.code;
	return code === 'NO_SUCH_ROOM' || code === 'NO_SUCH_USER' ? 'notFound' : 'error';
}

async function initialize() {
	const LIMIT = 20;

	if (initializing.value) return;

	initializing.value = true;
	initialized.value = false;
	deletingOwnRoom.value = false;
	leavingRoom.value = false;
	fetchError.value = null;

	if (props.userId) {
		const result = await Promise.all([
			misskeyApi('users/show', { userId: props.userId }),
			misskeyApi('chat/messages/user-timeline', { userId: props.userId, limit: LIMIT, includeDeleted: true }),
		]).catch(err => {
			fetchError.value = toFetchError(err);
			return null;
		});

		if (result == null) {
			initializing.value = false;
			return;
		}

		const [u, m] = result;

		user.value = u;
		messages.value = m.map(x => normalizeMessage(x));

		if (messages.value.length === LIMIT) {
			canFetchMore.value = true;
		}

		connection.value = useStream().useChannel('chatUser', {
			otherId: user.value.id,
		});
		connection.value.on('_subscribed_', readAgain);
		connection.value.on('message', onMessage);
		connection.value.on('deleted', onDeleted);
		connection.value.on('react', onReact);
		connection.value.on('unreact', onUnreact);
		connection.value.on('updated', onUpdated);
	} else if (props.roomId) {
		const [rResult, mResult] = await Promise.allSettled([
			misskeyApi('chat/rooms/show', { roomId: props.roomId }),
			misskeyApi('chat/messages/room-timeline', { roomId: props.roomId, limit: LIMIT, includeDeleted: true }),
		]);

		if (rResult.status === 'rejected') {
			const code = (rResult.reason as Misskey.api.APIError | null | undefined)?.code;
			if (code === 'ROOM_DELETED') {
				notifyRoomClosed(i18n.ts._chat.roomDeleted);
			} else if (membershipEnded.value) {
				// 別のページを見ているあいだに外された
				notifyRoomClosed(i18n.ts._chat.removedFromRoom);
			} else if (code === 'NO_SUCH_ROOM') {
				// 外されたあとの削除はこのサーバーに届かないことがあり、削除されたのか外されただけなのかは分からない
				notifyRoomClosed(i18n.ts._chat.roomUnavailable);
			} else {
				fetchError.value = toFetchError(rResult.reason);
			}
			initializing.value = false;
			return;
		}

		const r = rResult.value as Misskey.entities.ChatRoomsShowResponse;

		if (r.invitationExists) {
			const confirm = await os.confirm({
				type: 'question',
				title: r.name,
				text: i18n.ts._chat.youAreNotAMemberOfThisRoomButInvited + '\n' + i18n.ts._chat.doYouAcceptInvitation,
			});
			if (confirm.canceled) {
				initializing.value = false;
				router.push('/chat');
				return;
			} else {
				try {
					await os.apiWithDialog('chat/rooms/join', { roomId: r.id }, undefined, chatJoinErrors);
					globalEvents.emit('chatRoomInvitationHandled', r.id, 'joined');
				} catch {
					// The dialog already explained the refusal, and this page has nothing to show a non-member.
					initializing.value = false;
					router.push('/chat');
					return;
				}
				initializing.value = false;
				initialize();
				return;
			}
		}

		// ルーム情報は取れても、タイムラインの取得だけ失敗することがある（通信エラーなど）
		if (mResult.status === 'rejected') {
			fetchError.value = toFetchError(mResult.reason);
			initializing.value = false;
			return;
		}

		const m = mResult.value as Misskey.entities.ChatMessagesRoomTimelineResponse;

		room.value = r;
		messages.value = m.map(x => normalizeMessage(x));

		await refreshRoomPeople();

		if (messages.value.length === LIMIT) {
			canFetchMore.value = true;
		}

		connection.value = useStream().useChannel('chatRoom', {
			roomId: room.value.id,
		});
		connection.value.on('_subscribed_', readAgain);
		connection.value.on('message', onMessage);
		connection.value.on('deleted', onDeleted);
		connection.value.on('react', onReact);
		connection.value.on('unreact', onUnreact);
		connection.value.on('updated', onUpdated);
		connection.value.on('roomUpdated', onRoomUpdated);
		connection.value.on('membershipStarted', onMembershipChanged);
		connection.value.on('membershipEnded', onMembershipEnded);
		connection.value.on('roomDeleted', onRoomDeleted);
	}

	window.document.addEventListener('visibilitychange', onVisibilitychange);

	initialized.value = true;
	membershipEnded.value = false;
	initializing.value = false;
}

let isActivated = true;

onActivated(() => {
	isActivated = true;
});

onDeactivated(() => {
	isActivated = false;
	showIndicator.value = false;
});

async function fetchMore() {
	const LIMIT = 30;

	moreFetching.value = true;

	const newMessages = props.userId ? await misskeyApi('chat/messages/user-timeline', {
		userId: user.value!.id,
		limit: LIMIT,
		untilId: messages.value[messages.value.length - 1].id,
		includeDeleted: true,
	}) : await misskeyApi('chat/messages/room-timeline', {
		roomId: room.value!.id,
		limit: LIMIT,
		untilId: messages.value[messages.value.length - 1].id,
		includeDeleted: true,
	});

	const earlierLoaded = readingPlace.whileLoadingEarlier();

	messages.value.push(...newMessages.map(x => normalizeMessage(x)));

	canFetchMore.value = newMessages.length === LIMIT;
	moreFetching.value = false;

	await nextTick();
	earlierLoaded();
}

function onMessage(message: Misskey.entities.ChatMessageLite) {
	// 読み直しのほうが先に届けていることがある
	if (messages.value.some(m => m.id === message.id)) return;

	if (!('shouldNotify' in message) || message.shouldNotify !== false) sound.playMisskeySfx('chatMessage');

	// 読み直しで手元にもっと新しいものが入っていても、順番を崩さない
	const index = messages.value.findIndex(m => m.id < message.id);
	messages.value.splice(index === -1 ? messages.value.length : index, 0, normalizeMessage(message));

	// TODO: DOM的にバックグラウンドになっていないかどうかも考慮する
	if (message.fromUserId !== $i.id && !window.document.hidden && isActivated) {
		connection.value?.send('read', {
			id: message.id,
		});
	}
}

function onDeleted(id: string) {
	noteChangeDuringRead();
	// リロード後と同じく、削除済みの吹き出しとして残す
	const message = messages.value.find(m => m.id === id);
	if (message) {
		message.deletedAt = new Date().toISOString();
		message.text = null;
		message.fileId = null;
		message.file = null;
		message.fileIds = [];
		message.files = [];
		message.reactions = [];
		message.emojis = {};
	}
	if (editingMessage.value?.id === id) {
		editingMessage.value = null;
	}
}

function onReact(ctx: Parameters<Misskey.Channels['chatUser']['events']['react']>[0] | Parameters<Misskey.Channels['chatRoom']['events']['react']>[0]) {
	noteChangeDuringRead();
	const message = messages.value.find(m => m.id === ctx.messageId);
	if (message) {
		// 1on1の時はuserは省略される
		const reactor = room.value == null ? (message.fromUserId === $i.id ? user.value! : $i) : ctx.user!;
		// 読み直しのほうが先に届けていることがある
		if (message.reactions.some(r => r.reaction === ctx.reaction && r.user.id === reactor.id)) return;
		message.reactions.push({ reaction: ctx.reaction, user: reactor });
	}
}

function onUnreact(ctx: Parameters<Misskey.Channels['chatUser']['events']['unreact']>[0] | Parameters<Misskey.Channels['chatRoom']['events']['unreact']>[0]) {
	noteChangeDuringRead();
	const message = messages.value.find(m => m.id === ctx.messageId);
	if (message) {
		const userId = ctx.user?.id ?? (message.fromUserId === $i.id ? user.value?.id : $i.id);
		const index = message.reactions.findIndex(r => r.reaction === ctx.reaction && r.user.id === userId);
		if (index !== -1) {
			message.reactions.splice(index, 1);
		}
	}
}

function onUpdated(ctx: Parameters<Misskey.Channels['chatUser']['events']['updated']>[0] & { shouldNotify?: boolean }) {
	noteChangeDuringRead();
	const message = messages.value.find(m => m.id === ctx.messageId);
	if (message && !message.deletedAt) {
		if (message.editedAt && Date.parse(ctx.editedAt) <= Date.parse(message.editedAt)) return;
		if (ctx.shouldNotify === true) sound.playMisskeySfx('chatMessage');
		message.text = ctx.text;
		message.editedAt = ctx.editedAt;
		if (ctx.emojis != null) message.emojis = ctx.emojis;
	}
}

function onRoomUpdated(ctx: Parameters<Misskey.Channels['chatRoom']['events']['roomUpdated']>[0]) {
	noteChangeDuringRead();
	if (room.value == null || room.value.id !== ctx.roomId) return;
	room.value = {
		...room.value,
		name: ctx.name,
		description: ctx.description,
		isArchived: ctx.isArchived,
	};
}

// 入力欄がなくなるので編集も終わる。解除したときに編集へ戻ると、入力中の内容が原文に戻ってしまう
watch(() => room.value?.isArchived, isArchived => {
	if (isArchived) editingMessage.value = null;
});

function onMembershipChanged() {
	membershipVersion.value++;
	refreshRoomPeople();
}

let latestRoomPeopleRequest = 0;

// まだ誰も話していないルームで、招待したあとどうなっているかを主に見せる。送った招待は主にしか読めない
async function refreshRoomPeople() {
	const target = room.value;
	if (target == null || target.ownerId !== $i.id || messages.value.length > 0) return;

	const request = ++latestRoomPeopleRequest;
	try {
		const [members, invitations] = await Promise.all([
			misskeyApi('chat/rooms/members', { roomId: target.id, limit: 50 }),
			misskeyApi('chat/rooms/invitations/outbox', { roomId: target.id, limit: 50 }),
		]);
		// 遅れて返ってきた古い人数で、新しい人数を置き換えない
		if (request !== latestRoomPeopleRequest) return;
		joinedMemberCount.value = members.filter(member => member.userId !== target.ownerId).length;
		sentInvitationCount.value = invitations.length;
	} catch {
		// 次に知らされたときに読み直せるので、今の表示のままにする
	}
}

function onMembershipEnded(ctx: Parameters<Misskey.Channels['chatRoom']['events']['membershipEnded']>[0]) {
	if (ctx.userId !== $i.id) {
		onMembershipChanged();
		return;
	}
	closeRoom();
	// 自分で退出したときは、退出の結果として leaveRoom が移動する
	if (leavingRoom.value) return;
	if (isActivated) notifyRoomClosed(i18n.ts._chat.removedFromRoom);
}

function onRoomDeleted() {
	closeRoom();
	// 自分で削除したときは、削除の結果として room.info.vue が移動する
	if (deletingOwnRoom.value) return;
	if (isActivated) {
		notifyRoomClosed(i18n.ts._chat.roomDeleted);
	} else {
		roomDeletedWhileInactive = true;
	}
}

function notifyRoomClosed(text: string) {
	// 別のページへ移ったあとで分かったときは、戻ってきたときに確かめ直して知らせる
	if (!isActivated) return;
	os.alert({ type: 'info', text });
	// 履歴に残すと、戻るたびにこの案内へ連れ戻されてしまう
	router.replace('/chat');
}

function closeRoom() {
	membershipEnded.value = true;
	initialized.value = false;
	messages.value = [];
	editingMessage.value = null;
	room.value = null;
	canFetchMore.value = false;
	connection.value?.dispose();
	connection.value = null;
}

function onIndicatorClick(ev: MouseEvent) {
	goToNewest();
	// キーボードで押すと、押したボタンが消えてフォーカスの行き先がなくなるので入力欄へ。
	// マウスや指で押したときは、ソフトウェアキーボードを出さないよう動かさない
	if (ev.detail === 0) formEl.value?.querySelector('textarea')?.focus({ preventScroll: true });
}

function notifyNewMessage() {
	showIndicator.value = true;
}

function onVisibilitychange() {
	if (window.document.hidden) return;
	catchUp();
}

let eventsMayBeMissing = false;
let readingAgain = false;

// チャンネルの購読が済むまでに起きたことは、あとから流れてこない。開いた直後も、ストリームがつながり直したあとも読み直して埋める
function readAgain() {
	eventsMayBeMissing = true;
	catchUp();
}

// 読み直しの結果は、問い合わせた時点のもの。そのあいだに届いた変更を上書きするかもしれないので、もう一度読む
function noteChangeDuringRead() {
	if (readingAgain) eventsMayBeMissing = true;
}

async function catchUp() {
	// タイムラインを取得すると既読になるので、見ていないあいだは見に戻るまで待つ
	if (readingAgain || !eventsMayBeMissing || !initialized.value || !isActivated || window.document.hidden) return;
	eventsMayBeMissing = false;

	readingAgain = true;
	let finished = false;
	try {
		finished = await readLatest();
	} finally {
		readingAgain = false;
	}
	// 読んでいるあいだに、また読み直す理由ができた
	if (finished) catchUp();
}

/** @returns 一時的な失敗で読めなかったときは false */
async function readLatest(): Promise<boolean> {
	const LIMIT = 20;
	let r: Misskey.entities.ChatRoomsShowResponse | null;
	let m: (Misskey.entities.ChatMessageLite | Misskey.entities.ChatMessage)[];
	try {
		[r, m] = await Promise.all([
			props.roomId ? misskeyApi('chat/rooms/show', { roomId: props.roomId }) : null,
			props.roomId
				? misskeyApi('chat/messages/room-timeline', { roomId: props.roomId, limit: LIMIT, includeDeleted: true })
				: misskeyApi('chat/messages/user-timeline', { userId: props.userId!, limit: LIMIT, includeDeleted: true }),
		]);
	} catch (err) {
		// 一時的な失敗なら、次の機会まで今の表示のままにする
		const code = (err as Misskey.api.APIError | null | undefined)?.code;
		if (code !== 'NO_SUCH_ROOM' && code !== 'ROOM_DELETED') {
			eventsMayBeMissing = true;
			return false;
		}
		if (!initialized.value || leavingRoom.value || deletingOwnRoom.value) return true;
		// 外されたか、削除された。どちらなのかと、また招待されているかどうかは initialize が確かめて案内する
		closeRoom();
		if (isActivated) initialize();
		return true;
	}
	if (!initialized.value) return true;

	const latest = m.map(x => normalizeMessage(x));
	const latestIds = new Set(latest.map(x => x.id));
	// 最新のページが手元のものとつながらないなら、あいだが抜ける。古い方は捨てて読み直してもらう
	const hasGap = latest.length === LIMIT && !messages.value.some(x => x.id === latest[LIMIT - 1].id);
	const kept = messages.value.filter(x => !latestIds.has(x.id) && (!hasGap || x.id > latest[0].id));
	messages.value = [...kept, ...latest].toSorted((a, b) => a.id < b.id ? 1 : -1);
	if (hasGap) canFetchMore.value = true;
	if (messages.value.find(x => x.id === editingMessage.value?.id)?.deletedAt != null) editingMessage.value = null;

	if (r != null) {
		room.value = r;
		onMembershipChanged();
	}
	return true;
}

// 断られた招待のように、ルームのチャンネルには流れない変更もある
let listChannel: Misskey.IChannelConnection<Misskey.Channels['main']> | null = null;

onMounted(() => {
	initialize();
	useStream().on('_connected_', readAgain);
	if (props.roomId) {
		listChannel = useStream().useChannel('main');
		listChannel.on('chatRoomListChanged', refreshRoomPeople);
	}
});

onUnmounted(() => {
	window.removeEventListener('resize', handleResize);
	window.removeEventListener('scroll', onScrollWhileNotified, { capture: true });
});

onActivated(() => {
	if (roomDeletedWhileInactive) {
		roomDeletedWhileInactive = false;
		notifyRoomClosed(i18n.ts._chat.roomDeleted);
		return;
	}
	if (!initialized.value) {
		initialize();
	} else {
		catchUp();
	}
});

onBeforeUnmount(() => {
	connection.value?.dispose();
	listChannel?.dispose();
	useStream().off('_connected_', readAgain);
	window.document.removeEventListener('visibilitychange', onVisibilitychange);
});

async function inviteUser() {
	const target = room.value;
	if (target == null) return;

	const invitees = await os.selectUsers({ includeSelf: false, localOnly: false, unavailableUsers: getUninvitableUsers(target.id) });
	const sent = await inviteUsersToRoom(target.id, invitees);
	// 送った招待の一覧はメンバータブを開いたときにしか読み込まない
	if (sent > 0) onMembershipChanged();
}

async function leaveRoom() {
	if (room.value == null) return;

	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._chat.leaveRoomConfirm({ name: room.value.name }),
	});
	if (canceled) return;

	leavingRoom.value = true;
	try {
		await os.apiWithDialog('chat/rooms/leave', {
			roomId: room.value.id,
		}, undefined, chatLeaveErrors);
	} catch {
		// The dialog already explained the failure, and the member is still in the room.
		leavingRoom.value = false;
		return;
	}
	router.push('/chat');
}

function showMenu(ev: PointerEvent) {
	const menuItems: MenuItem[] = [{ text: i18n.ts.search, icon: 'ti ti-search', action: () => { tab.value = 'search'; } }];

	if (room.value) {
		if (room.value.ownerId === $i.id) {
			if (!room.value.isArchived) {
				menuItems.push({
					text: i18n.ts._chat.inviteUser,
					icon: 'ti ti-user-plus',
					action: () => {
						inviteUser();
					},
				});
			}
			// 削除は情報タブにある。メニューから探す人のために、そこへの道を置く
			menuItems.push({
				text: i18n.ts._chat.roomInfoAndDelete,
				icon: 'ti ti-info-circle',
				action: () => {
					tab.value = 'info';
				},
			});
		} else {
			menuItems.push({
				text: i18n.ts._chat.leave,
				icon: 'ti ti-x',
				action: () => {
					leaveRoom();
				},
			});
		}
	}

	os.popupMenu(menuItems, ev.currentTarget ?? ev.target);
}

const tab = ref('chat');

// ウィンドウではなくページ自身の幅で決める (デッキの列やウィジェットでページの幅は変わる)
const chatTabEl = useTemplateRef('chatTabEl');
const pageWidth = useElementWidth(chatTabEl);
// 通話に入っているときにステージをどう出すか。狭いページではステージだけを出してチャットはシートにし、広いページでは左右に並べる。
// モバイルでは横向きなどで広くても並べない (並べた形は、モバイルの画面下のナビゲーションの分を空けていない)
const voiceInOwnTab = computed(() => isMobile.value || (pageWidth.value != null && pageWidth.value < STAGE_MIN_PAGE_WIDTH));
const wantsSplit = computed(() => voiceCallState.inThisCall.value);
const chatOpen = ref(true);
// 通話に入ったらステージを前に出す (狭いページではチャットを閉じる)。ただしページの幅が分かるまでは決めない。
// 幅が分かる前に「広い」として開いたままにすると、幅が分かった途端にシートが勝手に開いてフォーカスを奪う。
// 通話中にページが狭くなったときも同じく、開いたチャットをそのままシートにせず閉じる (広くなれば横に並べて開く)
const layoutKnown = computed(() => isMobile.value || pageWidth.value != null);
watch([voiceCallState.inThisCall, voiceInOwnTab, layoutKnown], ([joined, ownTab, known]) => {
	if (!known) return;
	chatOpen.value = !joined || !ownTab;
}, { immediate: true });

// 入力欄で変換中 (IME) のあいだも並べ方を変えない。入力欄を移すと変換中の文字が確定されたり消えたりする
const composing = ref(false);

// 変換を終えないまま入力欄が消えたり裏に回ったりすると compositionend が届かないことがあるので、そこで忘れる
watch(tab, () => {
	composing.value = false;
	// メンバータブで招待を取り消したかもしれない
	if (tab.value === 'chat') refreshRoomPeople();
});

onDeactivated(() => {
	composing.value = false;
});

// 実際の並べ方。変換中のあいだは前の並べ方のままにして (入力欄を動かすと変換中の文字が確定されたり消えたりする)、終わったら決め直す
const splitLayout = ref(false);

watch([wantsSplit, composing], () => {
	if (composing.value) return;
	splitLayout.value = wantsSplit.value;
}, { immediate: true, flush: 'sync' });

const split = computed(() => tab.value === 'chat' && splitLayout.value);
const chatPaneEl = useTemplateRef('chatPaneEl');
const sheetBackdropEl = useTemplateRef('sheetBackdropEl');
let sheetTrap: { release: () => void } | null = null;
let sheetReturnFocus: HTMLElement | null = null;
watch(() => split.value && voiceInOwnTab.value && chatOpen.value, open => {
	if (open && chatPaneEl.value) {
		sheetReturnFocus = window.document.activeElement instanceof HTMLElement ? window.document.activeElement : null;
		// inert にするのはこのページの中 (ステージ) だけ。暗くするのもステージの上だけなので、見えているヘッダーやナビゲーションは使える
		const boundary = chatTabEl.value;
		const backdropTrap = sheetBackdropEl.value ? focusTrap(sheetBackdropEl.value, true, boundary) : null;
		const paneTrap = focusTrap(chatPaneEl.value, true, boundary);
		sheetTrap = { release: () => { backdropTrap?.release(); paneTrap.release(); } };
		// キーボードではすぐ書けるよう入力欄へ。触って操作する端末では、開いただけでソフトウェアキーボードが出ないよう閉じるボタンへ
		const textarea = isTouchUsing ? null : chatPaneEl.value.querySelector<HTMLElement>('textarea');
		(textarea ?? chatPaneEl.value.querySelector<HTMLElement>('button'))?.focus();
	} else if (sheetTrap) {
		releaseSheetTrap();
	}
}, { flush: 'post' });

function releaseSheetTrap() {
	sheetTrap?.release();
	sheetTrap = null;
	if (sheetReturnFocus?.isConnected) sheetReturnFocus.focus({ preventScroll: true });
	sheetReturnFocus = null;
}

// 画面を移るときはシートを閉じて解放する (戻ってきたときに開いたままにしない)
router.useListener('change', () => {
	if (sheetTrap == null) return;
	chatOpen.value = false;
	releaseSheetTrap();
});
onBeforeUnmount(() => releaseSheetTrap());
onDeactivated(() => {
	// 戻ってきたときに、focus trap の無いシートが開いたままにならないよう閉じておく
	if (sheetTrap != null) chatOpen.value = false;
	releaseSheetTrap();
});

// 変換中の Esc は変換の取り消しなので、シートは閉じない
function onSheetEsc(ev: KeyboardEvent) {
	if (ev.isComposing || ev.keyCode === 229) return;
	if (split.value && voiceInOwnTab.value) chatOpen.value = false;
}

// スクロール先を付け替える前の位置を覚え、描画直後・次のフレームより前に column-reverse の位置を揃える。
const pageEl = useTemplateRef('pageEl');
const chatStickyEl = useTemplateRef('chatStickyEl');
const chatScrollerEl = useTemplateRef('chatScrollerEl');
let scrollToRestore = 0;

function currentChatScroller(isSplit: boolean) {
	return isSplit ? chatScrollerEl.value : getScrollContainer(chatScrollerEl.value?.parentElement ?? null);
}

watch(split, (_next, previous) => {
	scrollToRestore = currentChatScroller(previous)?.scrollTop ?? 0;
}, { flush: 'pre' });
watch(split, next => {
	// footer とカードの高さも即時に測り直す。通常の ResizeObserver は 100ms 待つため、それだけでは一瞬ずれる。
	pageEl.value?.refreshStickyLayout();
	chatStickyEl.value?.refresh();
	const scroller = currentChatScroller(next);
	if (scroller != null) scroller.scrollTop = scrollToRestore;
}, { flush: 'post' });

// 入力欄を移すと (要素の付け替えで) フォーカスが外れるので、移す前にフォーカスと選択範囲を覚えておき、移したあとに戻す。
// 戻すのは描画のあと (flush: 'post')。そのときには入力欄の置き場所の表示も描画で切り替わっている
const paneFormHostEl = useTemplateRef('paneFormHostEl');
const formEl = useTemplateRef('formEl');
const chatFormEl = useTemplateRef('chatFormEl');
let focusToRestore: { el: HTMLElement; selection: [number, number, 'forward' | 'backward' | 'none'] | null } | null = null;

watch(split, () => {
	const active = window.document.activeElement;
	if (formEl.value == null || !(active instanceof HTMLElement) || !formEl.value.contains(active)) {
		focusToRestore = null;
		return;
	}
	focusToRestore = {
		el: active,
		selection: active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null,
	};
}, { flush: 'pre' });

watch(split, () => {
	const target = focusToRestore;
	focusToRestore = null;
	if (target == null || !target.el.isConnected || window.document.activeElement === target.el) return;
	target.el.focus({ preventScroll: true });
	if (target.selection != null && target.el instanceof HTMLTextAreaElement) {
		target.el.setSelectionRange(...target.selection);
	}
}, { flush: 'post' });

// 設定が変わったらすぐ並びを変えたいので、変更を追える prefer.r を見る
const chatSide = computed(() => prefer.r['voiceCall.stageChatSide'].value);

function swapChatSide() {
	prefer.commit('voiceCall.stageChatSide', chatSide.value === 'right' ? 'left' : 'right');
}

// 検索はメニューから開く。開いているあいだだけタブにも出し、いまどこにいるかを分かるようにする
const searchTab = computed(() => tab.value === 'search' ? [{
	key: 'search',
	title: i18n.ts.search,
	icon: 'ti ti-search',
}] : []);

const headerTabs = computed(() => room.value ? [{
	key: 'chat',
	title: i18n.ts._chat.messages,
	icon: 'ti ti-messages',
}, {
	key: 'members',
	title: i18n.ts._chat.members,
	icon: 'ti ti-users',
}, {
	key: 'info',
	title: i18n.ts.info,
	icon: 'ti ti-info-circle',
}, ...searchTab.value] : [{
	key: 'chat',
	title: i18n.ts._chat.messages,
	icon: 'ti ti-messages',
}, ...searchTab.value]);

// ヘッダーの参加ボタン。メッセージのタブでは参加バナーから参加できるので出さない。
// ほかのタブにはバナーが無いので、自分が通話にいなければいつでも出す
const showHeaderJoin = computed(() => {
	if (!voiceCallState.available.value || voiceCallState.inThisCall.value) return false;
	return tab.value !== 'chat';
});

const headerActions = computed<PageHeaderItem[]>(() => [
	...(showHeaderJoin.value ? [{
		icon: 'ti ti-phone',
		text: voiceCallState.participants.value.length > 0 ? i18n.ts._voiceCall.join : i18n.ts._voiceCall.start,
		handler: async () => {
			await voiceCallState.join();
			// 通話に入れたときだけメッセージのタブへ。やめたり失敗したりしたのに読んでいたタブから追い出さない
			if (voiceCallState.inThisCall.value) tab.value = 'chat';
		},
	}] : []),
	{
		icon: 'ti ti-dots',
		text: i18n.ts.menu,
		handler: showMenu,
	},
]);

definePage(computed(() => {
	if (initialized.value) {
		if (user.value) {
			return {
				userName: user.value,
				title: user.value.name ? `${user.value.name} (@${user.value.username})` : `@${user.value.username}`,
				subtitle: `@${getAcct(user.value)}`,
				avatar: user.value,
			};
		} else if (room.value) {
			return {
				title: room.value.name,
				titleAsMfm: true,
				titleMfmAuthor: room.value.owner,
				icon: 'ti ti-users',
			};
		} else {
			return {
				title: i18n.ts.directMessage,
			};
		}
	} else {
		return {
			title: i18n.ts.directMessage,
		};
	}
}));
</script>

<style lang="scss" module>
// スマートフォンの画面キーボードが出ているとき、ページ全体のスクロールアンカーがメッセージの増えた分だけ見える範囲を動かし、入力欄をキーボードの裏へ押しやる。
// 止めるのはページ全体の分だけで、メッセージの欄では止めない。止めると、読み返しているあいだに届いた分だけ読んでいた場所がずれる
:global(html):has(.chatTab),
:global(body):has(.chatTab) {
	overflow-anchor: none;
}

.joinBanner {
	margin-bottom: 24px;
}

.transition_x_move,
.transition_x_enterActive,
.transition_x_leaveActive {
	transition: opacity 0.2s cubic-bezier(0,.5,.5,1), transform 0.2s cubic-bezier(0,.5,.5,1) !important;
}

.transition_x_enterFrom,
.transition_x_leaveTo {
	opacity: 0;
	transform: translateY(80px);
}

.transition_x_leaveActive {
	position: absolute;
}

.root {
}

// ボタンは新しく読み込んだメッセージの上に残る。ブラウザのスクロールアンカーがボタンを基準にすると、読んでいた位置から読み込んだ先頭まで飛んでしまう
.moreRow {
	overflow-anchor: none;
}

.more {
	margin: 0 auto;
}

.emptyActions {
	display: flex;
	flex-wrap: wrap;
	justify-content: center;
	gap: 8px;
}

// 左右に並べるときは、ページヘッダーと下端の間 (スクロールしない高さ) にちょうど収める
.split {
	display: flex;
	height: calc(100cqh - var(--MI-stickyTop, 0px) - var(--MI-stickyBottom, 0px) - var(--voiceCallBottomSpacing, 0px));

	.stage {
		flex: 1 1 0;
	}

	.chatPane {
		position: relative;
		display: flex;
		flex: 0 1 400px;
		flex-direction: column;
		min-width: 320px;
		min-height: 0;
		border-left: solid 0.5px var(--MI_THEME-divider);
	}

	&.chatLeft .stage {
		order: 1;
	}

	&.chatLeft .chatPane {
		border-left: none;
		border-right: solid 0.5px var(--MI_THEME-divider);
	}

	// ページと同じく、新しいメッセージが下に来るよう逆向きにスクロールさせる
	.chatScroller {
		display: flex;
		flex: 1;
		flex-direction: column-reverse;
		min-height: 0;
		overflow-y: scroll;
		overscroll-behavior: contain;
		container-type: inline-size;
		background: var(--MI_THEME-bg);
	}
}

// メッセージの欄だけがスクロールするので、アイコンはページヘッダーではなく欄の上端を基準に貼り付ける
.ownScroller {
	--MI-stickyTop: 0px;
}

.paneFooter {
	flex-shrink: 0;
	padding-top: 8px;
}

.footer {
	width: 100%;
	padding-top: 8px;

	&.isFriendly {
		padding-bottom: calc(50px + env(safe-area-inset-bottom));
	}
}

.formArea {
	position: relative;
}

// 入力欄の上に浮かべる。場所を取ると、出たり消えたりするたびに読んでいる場所が動いてしまう
.new {
	position: absolute;
	bottom: 100%;
	left: 0;
	width: 100%;
	padding-bottom: 8px;
	text-align: center;
	// 押せるのはボタンだけ。横の空いたところの下にあるメッセージは押せるままにする
	pointer-events: none;
}

.newButton {
	display: inline-block;
	margin: 0;
	padding: 0 12px;
	line-height: 32px;
	font-size: 12px;
	border-radius: 16px;
	pointer-events: auto;

	// 既定のままだとアクセント色の上にアクセント色で内側に描かれて見えない
	&:focus-visible {
		outline-offset: 2px;
	}
}

.newIcon {
	display: inline-block;
	margin-right: 8px;
}

.form {
	margin: 0 auto;
	width: 100%;
	max-width: 700px;

	// この幅からナビゲーションの縁に開閉ボタン (幅 20px、navbar.vue) が出て、端まで広がった入力欄に重なる
	@media (min-width: 1280px) {
		width: calc(100% - 40px);
	}
}

.fade-enter-active, .fade-leave-active {
	transition: opacity 0.1s;
}

.fade-enter-from, .fade-leave-to {
	transition: opacity 0.5s;
	opacity: 0;
}

// まとまりの2つ目以降の吹き出しは、前の吹き出しとの間を詰める
.stackedMessage {
	margin-top: calc(2px - var(--MI-margin));
}

.dateDivider {
	display: flex;
	font-size: 85%;
	align-items: center;
	justify-content: center;
	gap: 0.5em;
	opacity: 0.75;
	border: solid 0.5px var(--MI_THEME-divider);
	border-radius: 999px;
	width: fit-content;
	padding: 0.5em 1em;
	margin: 0 auto;
}

.narrowCall {
	position: relative;

	.stage {
		width: 100%;
	}

	.chatPane {
		position: fixed;
		z-index: 1100;
		inset: auto 0 var(--voiceCallBottomSpacing, 0px);
		box-sizing: border-box;
		width: 100%;
		min-width: 0;
		height: 72dvh;
		border: none;
		border-radius: calc(var(--MI-radius) + 8px) calc(var(--MI-radius) + 8px) 0 0;
		overflow: hidden;
		background: var(--MI_THEME-bg);
	}
}

// 暗くするのはステージの上だけ (inert にするのもステージだけ)
.sheetBackdrop {
	position: absolute;
	z-index: 1099;
	inset: 0;
	background: var(--MI_THEME-modalBg);
}

.sheetHeading {
	display: flex;
	justify-content: space-between;
	align-items: center;
	padding: 12px 16px;
	border-bottom: 1px solid var(--MI_THEME-divider);

	button {
		width: 32px;
		height: 32px;
	}
}

.chatCorner {
	position: absolute;
	z-index: 2;
	top: 12px;
	left: 12px;
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	border-radius: 8px;
	background: var(--MI_THEME-panelHighlight);

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.cornerRight {
		left: auto;
		right: 12px;
	}
}

// チャットを左右に移すボタンが一番上 (古い) のメッセージに重ならないよう、そのぶん空ける
.split:not(.narrowCall) .chatScroller {
	padding-top: calc(12px + 34px + 4px);
}
</style>
