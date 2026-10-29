<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader ref="pageEl" v-model:tab="tab" centerTitle :reversed="tab === 'chat'" :tabs="headerTabs" :actions="headerActions">
	<!-- 広いページで誰かが通話にいるあいだは、通話 (ステージ) とチャットを左右に並べる。ステージは一つだけ作り、チャットを置く側の反対へ CSS の順序で移す。
	狭いページでは、通話は専用タブで開き、チャットには重ねない -->
	<div v-if="tab === 'chat'" ref="chatTabEl" :style="{ '--voiceCallBottomSpacing': isMobile ? 'var(--MI-mobileFooterHeight, 0px)' : '0px' }" :class="{ [$style.split]: split, [$style.narrowCall]: split && voiceInOwnTab, [$style.chatLeft]: split && chatSide === 'left' }">
		<XStage v-if="split && room" :room="room" :call="voiceCallState" :class="$style.stage" :chatOpen="chatOpen" @toggleChat="chatOpen = !chatOpen"/>
		<div v-if="split && voiceInOwnTab && chatOpen" ref="sheetBackdropEl" :class="$style.sheetBackdrop" @click="chatOpen = false"></div>
		<div v-show="!split || chatOpen" ref="chatPaneEl" :class="$style.chatPane" :role="split && voiceInOwnTab && chatOpen ? 'dialog' : undefined" :aria-modal="split && voiceInOwnTab && chatOpen ? true : undefined" :aria-label="i18n.ts._chat.messages" @dragover="chatFormEl?.onDragover($event)" @drop="chatFormEl?.onDrop($event)" @keydown.esc="split && voiceInOwnTab && (chatOpen = false)">
			<!-- シートを開くと focus trap が外側 (ステージも通話バーも) を inert にするので、通話の状態はシートの中からも読み上げる -->
			<div v-if="split && voiceInOwnTab" :class="$style.sheetHeading"><strong>{{ i18n.ts._chat.messages }}</strong><span v-if="chatOpen" :class="$style.srOnly" aria-live="polite">{{ voiceCallStatusText }}</span><button v-tooltip="i18n.ts.close" class="_button" :aria-label="i18n.ts.close" @click="chatOpen = false"><i class="ti ti-x"></i></button></div>
			<button v-if="split && !voiceInOwnTab" v-tooltip="chatSide === 'right' ? i18n.ts._voiceCall.moveChatLeft : i18n.ts._voiceCall.moveChatRight" class="_button" :class="[$style.chatCorner, { [$style.cornerRight]: chatSide === 'left' }]" :aria-label="chatSide === 'right' ? i18n.ts._voiceCall.moveChatLeft : i18n.ts._voiceCall.moveChatRight" @click="swapChatSide"><i :class="chatSide === 'right' ? 'ti ti-layout-sidebar' : 'ti ti-layout-sidebar-right'"></i></button>
			<!-- 並べているときはメッセージの欄だけを自分でスクロールさせる -->
			<div ref="chatScrollerEl" :class="$style.chatScroller">
				<!-- 通話カードはメッセージをスクロールしてもページヘッダーの下に貼り付ける -->
				<MkStickyContainer ref="chatStickyEl" class="_spacer" style="--MI_SPACER-w: 700px;">
					<template #header>
						<XBanner v-if="room && !split" :call="voiceCallState" :class="$style.joinBanner"/>
					</template>
					<div class="_gaps">
						<div v-if="initializing">
							<MkLoading/>
						</div>

						<div v-else-if="messages.length === 0">
							<div class="_gaps" style="text-align: center;">
								<div>{{ i18n.ts._chat.noMessagesYet }}</div>
								<template v-if="user">
									<div v-if="user.chatScope === 'followers'">{{ i18n.ts._chat.thisUserAllowsChatOnlyFromFollowers }}</div>
									<div v-else-if="user.chatScope === 'following'">{{ i18n.ts._chat.thisUserAllowsChatOnlyFromFollowing }}</div>
									<div v-else-if="user.chatScope === 'mutual'">{{ i18n.ts._chat.thisUserAllowsChatOnlyFromMutualFollowing }}</div>
									<div v-else-if="user.chatScope === 'none'">{{ i18n.ts._chat.thisUserNotAllowedChatAnyone }}</div>
								</template>
								<template v-else-if="room">
									<div>{{ i18n.ts._chat.inviteUserToChat }}</div>
								</template>
							</div>
						</div>

						<div v-else ref="timelineEl" class="_gaps" :class="{ [$style.ownScroller]: split }">
							<div v-if="canFetchMore">
								<MkButton :class="$style.more" :wait="moreFetching" primary rounded @click="fetchMore">{{ i18n.ts.loadMore }}</MkButton>
							</div>

							<TransitionGroup
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
											:firstInGroup="groupPositions[i]?.first ?? true"
											:lastInGroup="groupPositions[i]?.last ?? true"
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
		<XMembers v-if="room != null" :room="room" @inviteUser="inviteUser"/>
	</div>

	<div v-else-if="tab === 'info'" class="_spacer" style="--MI_SPACER-w: 700px;">
		<XInfo v-if="room != null" :room="room" @updated="room = $event"/>
	</div>

	<template #footer>
		<!-- 表示は v-show ではなく style で切り替える (上の paneFormHostEl と同じ理由) -->
		<div v-if="tab === 'chat'" :class="[$style.footer, {[$style.isFriendly]: isMobile && isFriendly().value }]" :style="split ? { display: 'none' } : undefined">
			<!-- 入力欄は 1 つだけ作り、並べ方が変わっても作り直さずに置き場所だけを移す (並べているときはメッセージの欄の下へ)。
			作り直すとフォーカスが外れてページ全体のショートカットが効いてしまい、変換中の文字や送信中の状態も失われる -->
			<Teleport v-if="paneFormHostEl != null" :to="paneFormHostEl" :disabled="!split">
				<div ref="formEl" class="_gaps" @compositionstart="composing = true" @compositionend="composing = false" @focusout="composing = false">
					<Transition name="fade">
						<div v-show="showIndicator" :class="$style.new">
							<button class="_buttonPrimary" :class="$style.newButton" @click="onIndicatorClick">
								<i class="fas ti-fw fa-arrow-circle-down" :class="$style.newIcon"></i>{{ i18n.ts._chat.newMessage }}
							</button>
						</div>
					</Transition>
					<XForm v-if="initialized" ref="chatFormEl" :user="user" :room="room" :class="$style.form"/>
				</div>
			</Teleport>
		</div>
	</template>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { ref, useTemplateRef, computed, watch, onMounted, onBeforeUnmount, onDeactivated, onActivated, onUnmounted } from 'vue';
import * as Misskey from 'cherrypick-js';
import { getScrollContainer } from '@@/js/scroll.js';
import XMessage from './XMessage.vue';
import XForm from './room.form.vue';
import XSearch from './room.search.vue';
import XMembers from './room.members.vue';
import XInfo from './room.info.vue';
import XBanner from './room.voice.banner.vue';
import XStage from './room.voice.stage.vue';
import type { MenuItem } from '@/types/menu.js';
import type { PageHeaderItem } from '@/types/page-header.js';
import * as os from '@/os.js';
import { useStream } from '@/stream.js';
import * as sound from '@/utility/sound.js';
import { i18n } from '@/i18n.js';
import { ensureSignin } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { definePage } from '@/page.js';
import { prefer } from '@/preferences.js';
import MkButton from '@/components/MkButton.vue';
import { useRouter } from '@/router.js';
import { useMutationObserver } from '@/composables/use-mutation-observer.js';
import MkInfo from '@/components/MkInfo.vue';
import { makeDateSeparatedTimelineComputedRef } from '@/utility/timeline-date-separate.js';
import { getChatMessageGroupPositions } from '@/utility/chat-message-grouping.js';
import { acct as getAcct } from '@@/js/user.js';
import { isFriendly } from '@/utility/is-friendly.js';
import { deviceKind } from '@/utility/device-kind.js';
import { useChatRoomVoiceCall } from '@/composables/use-chat-room-voice-call.js';
import { useElementWidth } from '@/composables/use-element-width.js';
import { focusTrap } from '@/utility/focus-trap.js';
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
	reactions: (Misskey.entities.ChatMessageLite['reactions'][number] & {
		user: Misskey.entities.UserLite;
	})[];
};

const initializing = ref(false);
const initialized = ref(false);
const moreFetching = ref(false);
const messages = ref<NormalizedChatMessage[]>([]);
const canFetchMore = ref(false);
const user = ref<Misskey.entities.UserDetailed | null>(null);
const room = ref<Misskey.entities.ChatRoom | null>(null);
const memberships = ref<Misskey.entities.ChatRoomMembership[]>([]);
const connection = ref<Misskey.IChannelConnection<Misskey.Channels['chatUser']> | Misskey.IChannelConnection<Misskey.Channels['chatRoom']> | null>(null);
const showIndicator = ref(false);
const timelineEl = useTemplateRef('timelineEl');
const timeline = makeDateSeparatedTimelineComputedRef(messages);
// 画面には古い順に並べる
const displayTimeline = computed(() => timeline.value.toReversed());
// 同じ送信者が続けて送ったメッセージは吹き出しをまとめて詰めて表示する
const groupPositions = computed(() => getChatMessageGroupPositions(displayTimeline.value));
const voiceCallState = useChatRoomVoiceCall(room);

const SCROLL_HEAD_THRESHOLD = 200;

// column-reverseなので本来はスクロール位置の最下部への追従は不要なはずだが、おそらくブラウザのバグにより、最下部にスクロールした状態でも追従されない場合がある(スクロール位置が少数になることがあるのが関わっていそう)
// そのため補助としてMutationObserverを使って追従を行う
useMutationObserver(timelineEl, {
	subtree: true,
	childList: true,
	attributes: false,
}, () => {
	const scrollContainer = getScrollContainer(timelineEl.value)!;
	// column-reverseなのでscrollTopは負になる
	if (-scrollContainer.scrollTop < SCROLL_HEAD_THRESHOLD) {
		scrollContainer.scrollTo({
			top: 0,
			behavior: 'instant',
		});
	}
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

async function initialize() {
	const LIMIT = 20;

	if (initializing.value) return;

	initializing.value = true;
	initialized.value = false;

	if (props.userId) {
		const [u, m] = await Promise.all([
			misskeyApi('users/show', { userId: props.userId }),
			misskeyApi('chat/messages/user-timeline', { userId: props.userId, limit: LIMIT }),
		]);

		user.value = u;
		messages.value = m.map(x => normalizeMessage(x));

		if (messages.value.length === LIMIT) {
			canFetchMore.value = true;
		}

		connection.value = useStream().useChannel('chatUser', {
			otherId: user.value.id,
		});
		connection.value.on('message', onMessage);
		connection.value.on('deleted', onDeleted);
		connection.value.on('react', onReact);
		connection.value.on('unreact', onUnreact);
	} else if (props.roomId) {
		const [rResult, mResult] = await Promise.allSettled([
			misskeyApi('chat/rooms/show', { roomId: props.roomId }),
			misskeyApi('chat/messages/room-timeline', { roomId: props.roomId, limit: LIMIT }),
		]);

		if (rResult.status === 'rejected') {
			os.alert({
				type: 'error',
				text: i18n.ts.somethingHappened,
			});
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
				await os.apiWithDialog('chat/rooms/join', { roomId: r.id });
				initializing.value = false;
				initialize();
				return;
			}
		}

		const m = mResult.status === 'fulfilled' ? mResult.value as Misskey.entities.ChatMessagesRoomTimelineResponse : [];

		room.value = r;
		messages.value = m.map(x => normalizeMessage(x));

		memberships.value = await misskeyApi('chat/rooms/members', {
			roomId: room.value.id,
			limit: 50,
		});

		if (messages.value.length === LIMIT) {
			canFetchMore.value = true;
		}

		connection.value = useStream().useChannel('chatRoom', {
			roomId: room.value.id,
		});
		connection.value.on('message', onMessage);
		connection.value.on('deleted', onDeleted);
		connection.value.on('react', onReact);
		connection.value.on('unreact', onUnreact);
	}

	window.document.addEventListener('visibilitychange', onVisibilitychange);

	initialized.value = true;
	initializing.value = false;
}

let isActivated = true;

onActivated(() => {
	isActivated = true;
});

onDeactivated(() => {
	isActivated = false;
});

async function fetchMore() {
	const LIMIT = 30;

	moreFetching.value = true;

	const newMessages = props.userId ? await misskeyApi('chat/messages/user-timeline', {
		userId: user.value!.id,
		limit: LIMIT,
		untilId: messages.value[messages.value.length - 1].id,
	}) : await misskeyApi('chat/messages/room-timeline', {
		roomId: room.value!.id,
		limit: LIMIT,
		untilId: messages.value[messages.value.length - 1].id,
	});

	messages.value.push(...newMessages.map(x => normalizeMessage(x)));

	canFetchMore.value = newMessages.length === LIMIT;
	moreFetching.value = false;
}

function onMessage(message: Misskey.entities.ChatMessageLite) {
	sound.playMisskeySfx('chatMessage');

	messages.value.unshift(normalizeMessage(message));

	// TODO: DOM的にバックグラウンドになっていないかどうかも考慮する
	if (message.fromUserId !== $i.id && !window.document.hidden && isActivated) {
		connection.value?.send('read', {
			id: message.id,
		});
	}

	if (message.fromUserId !== $i.id) {
		//notifyNewMessage();
	}
}

function onDeleted(id: string) {
	const index = messages.value.findIndex(m => m.id === id);
	if (index !== -1) {
		messages.value.splice(index, 1);
	}
}

function onReact(ctx: Parameters<Misskey.Channels['chatUser']['events']['react']>[0] | Parameters<Misskey.Channels['chatRoom']['events']['react']>[0]) {
	const message = messages.value.find(m => m.id === ctx.messageId);
	if (message) {
		if (room.value == null) { // 1on1の時はuserは省略される
			message.reactions.push({
				reaction: ctx.reaction,
				user: message.fromUserId === $i.id ? user.value! : $i,
			});
		} else {
			message.reactions.push({
				reaction: ctx.reaction,
				user: ctx.user!,
			});
		}
	}
}

function onUnreact(ctx: Parameters<Misskey.Channels['chatUser']['events']['unreact']>[0] | Parameters<Misskey.Channels['chatRoom']['events']['unreact']>[0]) {
	const message = messages.value.find(m => m.id === ctx.messageId);
	if (message) {
		const index = message.reactions.findIndex(r => r.reaction === ctx.reaction && r.user.id === ctx.user!.id);
		if (index !== -1) {
			message.reactions.splice(index, 1);
		}
	}
}

function onIndicatorClick() {
	showIndicator.value = false;
}

function notifyNewMessage() {
	showIndicator.value = true;
}

function onVisibilitychange() {
	if (window.document.hidden) return;
	// TODO
}

onMounted(() => {
	initialize();
});

onUnmounted(() => {
	window.removeEventListener('resize', handleResize);
});

onActivated(() => {
	if (!initialized.value) {
		initialize();
	}
});

onBeforeUnmount(() => {
	connection.value?.dispose();
	window.document.removeEventListener('visibilitychange', onVisibilitychange);
});

async function inviteUser() {
	if (room.value == null) return;

	const invitee = await os.selectUser({ includeSelf: false, localOnly: false });
	os.apiWithDialog('chat/rooms/invitations/create', {
		roomId: room.value.id,
		userId: invitee.id,
	});
}

async function leaveRoom() {
	if (room.value == null) return;

	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts.areYouSure,
	});
	if (canceled) return;

	misskeyApi('chat/rooms/leave', {
		roomId: room.value.id,
	});
	router.push('/chat');
}

function showMenu(ev: PointerEvent) {
	const menuItems: MenuItem[] = [{ text: i18n.ts.search, icon: 'ti ti-search', action: () => { tab.value = 'search'; } }];

	if (room.value) {
		if (room.value.ownerId === $i.id) {
			menuItems.push({
				text: i18n.ts._chat.inviteUser,
				icon: 'ti ti-user-plus',
				action: () => {
					inviteUser();
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
// 通話カードを出す場面 (誰かが通話にいるか、自分が参加中) で、ページが広ければ通話カードの代わりにステージを横に並べる。
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
		const backdropTrap = sheetBackdropEl.value ? focusTrap(sheetBackdropEl.value, true) : null;
		const paneTrap = focusTrap(chatPaneEl.value, true);
		// 閉じるときは背景 (v-if) が先に DOM から消えている。背景を先に解放して、pane の解放が周囲の inert を全部外せるようにする
		sheetTrap = { release: () => { backdropTrap?.release(); paneTrap.release(); } };
		chatPaneEl.value.querySelector<HTMLElement>('button')?.focus();
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

// KeepAlive に退避された後では祖先側の inert を外せないので、画面遷移の前に閉じて解放する
router.useListener('change', () => {
	if (sheetTrap == null) return;
	chatOpen.value = false;
	releaseSheetTrap();
});
onBeforeUnmount(() => releaseSheetTrap());
onDeactivated(() => releaseSheetTrap());

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
}] : [{
	key: 'chat',
	title: i18n.ts._chat.messages,
	icon: 'ti ti-messages',
}]);

// ヘッダーの参加ボタン。メッセージのタブでは通話カード (誰かが通話にいるときだけ出る) から参加できるので、カードが無いときだけ出す。
// ほかのタブにはカードが無いので、自分が通話にいなければいつでも出す
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
.joinBanner { margin-bottom: 24px; }

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

.more {
	margin: 0 auto;
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

.new {
	width: 100%;
	padding-bottom: 8px;
	text-align: center;
}

.newButton {
	display: inline-block;
	margin: 0;
	padding: 0 12px;
	line-height: 32px;
	font-size: 12px;
	border-radius: 16px;
}

.newIcon {
	display: inline-block;
	margin-right: 8px;
}

.form {
	margin: 0 auto;
	width: 100%;
	max-width: 700px;
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
.narrowCall { position: relative; }
.narrowCall .stage { width: 100%; }
.narrowCall .chatPane { position: fixed; z-index: 1100; inset: auto 0 var(--voiceCallBottomSpacing, 0px); box-sizing: border-box; width: 100%; min-width: 0; height: 72dvh; border: none; border-radius: 20px 20px 0 0; overflow: hidden; background: var(--MI_THEME-bg); }
.sheetBackdrop { position: fixed; z-index: 1099; inset: 0; background: var(--MI_THEME-modalBg); }
.sheetHeading { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--MI_THEME-divider); }
.sheetHeading button { width: 32px; height: 32px; }
.srOnly { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.chatCorner { position: absolute; z-index: 2; top: 12px; left: 12px; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px; background: var(--MI_THEME-panelHighlight); }
.cornerRight { left: auto; right: 12px; }
.chatCorner:hover { background: var(--MI_THEME-buttonHoverBg); }
</style>
