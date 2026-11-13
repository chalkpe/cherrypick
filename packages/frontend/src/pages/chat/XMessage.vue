<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :data-chat-message-id="message.id" :class="[$style.root, { [$style.isMe]: isMe, [$style.continued]: !isFirstInGroup }]">
	<MkAvatar v-if="!isMe && isFirstInGroup && message.fromUser != null" :class="[$style.avatar, prefer.s.useStickyIcons ? $style.useSticky : null]" :user="message.fromUser" :link="!isMe" :preview="false"/>
	<!-- 계정이 없어진 작성자는 계정이 아니므로 프로필로 연결하지 않는다 -->
	<div v-else-if="!isMe && isFirstInGroup" :class="[$style.avatar, $style.archivedAvatar, prefer.s.useStickyIcons ? $style.useSticky : null]" aria-hidden="true"><i class="ti ti-user"></i></div>
	<!-- まとまりの2つ目以降もアバターの幅だけ空けて、吹き出しの位置を揃える -->
	<div v-else-if="!isMe" :class="$style.avatarSpace"></div>
	<div :class="[$style.body, hasFiles ? $style.fullWidth : null]" tabindex="0" aria-haspopup="menu" @keydown.self="onMenuKeydown" @contextmenu.stop="onContextmenu">
		<div v-if="isFirstInGroup" :class="$style.header">
			<MkUserName v-if="!isMe && prefer.s['chat.showSenderName'] && message.fromUser != null" :user="message.fromUser"/>
			<span v-else-if="!isMe && message.fromUser == null" :class="$style.archivedAuthor">
				<template v-if="archivedName != null">
					<span>{{ archivedName }}</span>
					<span v-if="archivedAcct != null" :class="$style.archivedAcct">{{ archivedAcct }}</span>
				</template>
				<span v-else>{{ i18n.ts._chat.unknownUser }}</span>
			</span>
		</div>
		<MkFukidashi :class="[$style.fukidashi, { [$style.noTailLeft]: !isFirstInGroup && !isMe }]" :tail="!isFirstInGroup ? 'none' : isMe ? 'right' : 'left'" :fullWidth="hasFiles" :accented="isMe">
			<span v-if="deletedAt" :class="$style.deletedMessage">{{ i18n.ts._chat.deletedMessage }}</span>
			<template v-else>
				<Mfm
					v-if="message.text"
					ref="text"
					class="_selectable"
					:text="message.text"
					:parsedNodes="referenceNodes"
					:author="message.fromUser ?? undefined"
					:i="$i"
					:nyaize="'respect'"
					:emojiUrls="message.emojis"
					:enableEmojiMenu="true"
					:enableEmojiMenuReaction="canReact"
				/>
				<XDiceResult v-if="message.dice" :class="$style.dice" :dice="message.dice"/>
				<MkMediaList v-if="hasFiles" :mediaList="message.files" :user="message.fromUser"/>
				<div v-if="unavailableFileCount > 0" :class="$style.unavailableFiles"><i class="ti ti-photo-off" aria-hidden="true"></i> {{ i18n.ts._chat.cannotFetchMoreHistory }}</div>
			</template>
		</MkFukidashi>
		<MkUrlPreview v-for="url in urls" :key="url" :url="url" style="margin: 8px 0;"/>
		<div :class="[$style.footer, { [$style.groupedFooter]: !isLastInGroup }]">
			<button class="_textButton" :class="$style.menuButton" style="color: currentColor;" :aria-label="i18n.ts.menu" @click="showMenu"><i class="ti ti-dots-circle-horizontal"></i></button>
			<MkTime :class="$style.time" :time="message.createdAt"/>
			<span v-if="editedAt && !deletedAt" :class="$style.edited">{{ i18n.ts.edited }}</span>
			<MkA v-if="isSearchResult && 'toRoom' in message && message.toRoom != null" :to="message.toRoomChannelId ? channelConversationPath(message.toRoomId!, message.toRoomChannelId) : `/chat/room/${message.toRoomId}`"><MkAvatar :room="message.toRoom" style="width: 1.3em; height: 1.3em; vertical-align: middle; margin-right: 0.4em;"/>{{ message.toRoom.name }}<template v-if="message.toRoomChannel"> · #{{ message.toRoomChannel.name }}</template></MkA>
			<MkA v-if="isSearchResult && 'toUser' in message && message.toUser != null && isMe" :to="`/chat/user/${message.toUserId}`">@{{ message.toUser.username }}</MkA>
		</div>
		<TransitionGroup
			v-if="!deletedAt"
			:enterActiveClass="prefer.s.animation ? $style.transition_reaction_enterActive : ''"
			:leaveActiveClass="prefer.s.animation ? $style.transition_reaction_leaveActive : ''"
			:enterFromClass="prefer.s.animation ? $style.transition_reaction_enterFrom : ''"
			:leaveToClass="prefer.s.animation ? $style.transition_reaction_leaveTo : ''"
			:moveClass="prefer.s.animation ? $style.transition_reaction_move : ''"
			tag="div" :class="$style.reactions"
		>
			<div v-for="record in message.reactions" :key="record.reaction + record.user.id" :class="[$style.reaction, record.user.id === $i.id ? $style.reactionMy : null]" @click.capture="onReactionClick(record)">
				<MkAvatar :user="record.user" :link="false" :class="$style.reactionAvatar"/>
				<MkReactionIcon
					:withTooltip="true"
					:reaction="record.reaction.replace(/^:(\w+):$/, ':$1@.:')"
					:noStyle="true"
					:class="$style.reactionIcon"
				/>
			</div>
		</TransitionGroup>
	</div>
</div>
</template>

<script lang="ts" setup>
import { computed, defineAsyncComponent, onBeforeUnmount, provide, ref, watch } from 'vue';
import * as mfm from 'mfc-js';
import * as Misskey from 'cherrypick-js';
import { url } from '@@/js/config.js';
import { isLink } from '@@/js/is-link.js';
import type { MenuItem } from '@/types/menu.js';
import type { NormalizedChatMessage } from './room.vue';
import { chatErrorText } from './chat-errors.js';
import { channelConversationPath, channelReferenceNodes } from './chat-channel-references.js';
import XDiceResult from './XDiceResult.vue';
import { extractUrlFromMfm } from '@/utility/extract-url-from-mfm.js';
import MkUrlPreview from '@/components/MkUrlPreview.vue';
import { ensureSignin } from '@/i.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { i18n } from '@/i18n.js';
import MkFukidashi from '@/components/MkFukidashi.vue';
import * as os from '@/os.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';
import MkMediaList from '@/components/MkMediaList.vue';
import { reactionPicker } from '@/utility/reaction-picker.js';
import * as sound from '@/utility/sound.js';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import { prefer } from '@/preferences.js';
import { DI } from '@/di.js';
import { getHTMLElementOrNull } from '@/utility/get-dom-node-or-null.js';

const $i = ensureSignin();

const props = withDefaults(defineProps<{
	message: NormalizedChatMessage | Misskey.entities.ChatMessage;
	isSearchResult?: boolean;
	channels?: Misskey.entities.ChatRoomChannel[];
	canEdit?: boolean;
	// ルームの画面のメッセージには toRoom が付かないので、アーカイブの状態はルームから受け取る
	roomArchived?: boolean;
	// 同じ送信者が続けて送ったメッセージのまとまりの中での位置。省略すると単独のメッセージとして表示する。
	// 新着のたびに全部の吹き出しを描き直さないよう、オブジェクトではなく真偽値で受け取る
	firstInGroup?: boolean;
	lastInGroup?: boolean;
}>(), {
	firstInGroup: true,
	lastInGroup: true,
	canEdit: false,
	roomArchived: false,
});

const emit = defineEmits<{
	(ev: 'edit', message: NormalizedChatMessage | Misskey.entities.ChatMessage): void;
}>();

const fetchedChannels = ref<Misskey.entities.ChatRoomChannel[] | null>(null);
let channelListRequest = 0;
watch(() => [props.message.toRoomId, props.message.channelRefs, props.channels] as const, async () => {
	const request = ++channelListRequest;
	fetchedChannels.value = null;
	if (props.channels || !props.message.toRoomId || !props.message.channelRefs?.length) return;
	try {
		const list = await misskeyApi('chat/rooms/channels/list', { roomId: props.message.toRoomId });
		if (request === channelListRequest) fetchedChannels.value = list;
	} catch {
		// 접근할 수 없는 그룹의 채널에는 링크를 만들지 않는다.
	}
}, { immediate: true });
onBeforeUnmount(() => { channelListRequest++; });
const referenceNodes = computed(() => {
	const channels = props.channels ?? fetchedChannels.value;
	return props.message.text && props.message.toRoomId && props.message.toRoomChannelId
		? channelReferenceNodes(props.message.text, props.message.channelRefs ?? [], channels, props.message.toRoomId, i18n.ts._chat._channels.deleted, url)
		: undefined;
});

const isMe = computed(() => props.message.fromUserId != null && props.message.fromUserId === $i.id);
// 계정이 없어진 작성자는 그룹 소유 서버가 보관한 이름과 계정 주소를 글자로만 보인다
const archivedAuthor = computed(() => 'archivedAuthor' in props.message ? props.message.archivedAuthor ?? null : null);
const archivedName = computed(() => archivedAuthor.value?.name ?? archivedAuthor.value?.username ?? null);
const archivedAcct = computed(() => {
	const author = archivedAuthor.value;
	if (author?.username == null) return null;
	return author.host != null ? `@${author.username}@${author.host}` : `@${author.username}`;
});
const unavailableFileCount = computed(() => 'unavailableFileCount' in props.message ? props.message.unavailableFileCount ?? 0 : 0);
const editedAt = computed(() => (props.message as NormalizedChatMessage).editedAt ?? null);
const deletedAt = computed(() => (props.message as NormalizedChatMessage).deletedAt ?? null);
const hasFiles = computed(() => deletedAt.value == null && props.message.files.length > 0);
const unmounted = ref(false);
const isReadOnly = computed(() => props.roomArchived || ('toRoom' in props.message && props.message.toRoom?.isArchived === true));
// 自分のメッセージにはリアクションできない。サーバーは NO_SUCH_MESSAGE で断る
const canReact = computed(() => !isMe.value && !unmounted.value && !deletedAt.value && !isReadOnly.value && $i.policies.chatAvailability === 'available');
onBeforeUnmount(() => { unmounted.value = true; });
// 検索結果は前後のメッセージと関係なく並ぶのでまとめない
const isFirstInGroup = computed(() => props.isSearchResult === true || props.firstInGroup);
const isLastInGroup = computed(() => props.isSearchResult === true || props.lastInGroup);
const urls = computed(() => !deletedAt.value && props.message.text ? extractUrlFromMfm(mfm.parse(props.message.text)) : []);

provide(DI.mfmEmojiReactCallback, (reaction) => {
	if (!canReact.value) return;

	sound.playMisskeySfx('reaction');
	sendReaction('chat/messages/react', reaction);
});

function sendReaction(endpoint: 'chat/messages/react' | 'chat/messages/unreact', reaction: string) {
	misskeyApi(endpoint, {
		messageId: props.message.id,
		reaction: reaction,
	}).catch(err => {
		os.alert({ type: 'error', title: i18n.ts.somethingHappened, text: chatErrorText(err) });
	});
}

function react(ev: PointerEvent) {
	if (!canReact.value) return;

	const targetEl = getHTMLElementOrNull(ev.currentTarget ?? ev.target);
	if (!targetEl) return;

	reactionPicker.show(targetEl, null, async (reaction) => {
		if (!canReact.value) return;
		sound.playMisskeySfx('reaction');
		sendReaction('chat/messages/react', reaction);
	});
}

function onReactionClick(record: Misskey.entities.ChatMessage['reactions'][0]) {
	if (!canReact.value) return;

	if (record.user.id === $i.id) {
		sendReaction('chat/messages/unreact', record.reaction);
	} else if (!/@[\w.-]/.test(record.reaction)) { // 他サーバーのカスタム絵文字はこのサーバーからはリアクションできない
		if (!props.message.reactions.some(r => r.user.id === $i.id && r.reaction === record.reaction)) {
			sound.playMisskeySfx('reaction');
			sendReaction('chat/messages/react', record.reaction);
		}
	}
}

function onContextmenu(ev: PointerEvent) {
	if (ev.target && isLink(ev.target as HTMLElement)) return;
	// 指で長押しすると言葉が選ばれてからここへ来る。コピーはメニューにあるので、選択を残さずメニューを開く
	if (ev.pointerType === 'touch') window.getSelection()?.removeAllRanges();
	else if (window.getSelection()?.toString() !== '') return;

	os.contextMenu(getMenu(), ev);
}

function onMenuKeydown(ev: KeyboardEvent) {
	if (ev.key !== 'Enter' && ev.key !== 'ContextMenu' && !(ev.key === 'F10' && ev.shiftKey)) return;
	ev.preventDefault();
	ev.stopPropagation();
	showMenu(ev);
}

function showMenu(ev: PointerEvent | KeyboardEvent) {
	os.popupMenu(getMenu(), ev.currentTarget ?? ev.target);
}

function getMenu(): MenuItem[] {
	const menu: MenuItem[] = [];

	if (!isMe.value && canReact.value) {
		menu.push({
			text: i18n.ts.reaction,
			icon: 'ti ti-mood-plus',
			action: (ev) => {
				react(ev);
			},
		});

		menu.push({
			type: 'divider',
		});
	}

	if (!deletedAt.value) {
		menu.push({
			text: i18n.ts.copyContent,
			icon: 'ti ti-copy',
			action: () => {
				copyToClipboard(props.message.text ?? '', 'content');
			},
		});

		menu.push({
			type: 'divider',
		});
	}

	if (isMe.value && !deletedAt.value && !isReadOnly.value && $i.policies.chatAvailability === 'available') {
		if (props.canEdit && props.message.dice == null) {
			menu.push({
				text: i18n.ts.edit,
				icon: 'ti ti-pencil',
				action: () => {
					emit('edit', props.message);
				},
			});
		}

		menu.push({
			text: i18n.ts.delete,
			icon: 'ti ti-trash',
			danger: true,
			action: async () => {
				const { canceled } = await os.confirm({
					type: 'warning',
					text: i18n.ts.deleteConfirm,
				});
				if (canceled) return;

				misskeyApi('chat/messages/delete', {
					messageId: props.message.id,
				}).catch(err => {
					os.alert({ type: 'error', title: i18n.ts.somethingHappened, text: chatErrorText(err) });
				});
			},
		});
	}

	if (!isMe.value && props.message.fromUser != null) {
		menu.push({
			text: i18n.ts.reportAbuse,
			icon: 'ti ti-exclamation-circle',
			action: async () => {
				const localUrl = `${url}/chat/messages/${props.message.id}`;
				const { dispose } = await os.popupAsyncWithDialog(import('@/components/MkAbuseReportWindow.vue').then(x => x.default), {
					user: props.message.fromUser!,
					initialComment: `${localUrl}\n-----\n`,
				}, {
					closed: () => dispose(),
				});
			},
		});
	}

	return menu;
}
</script>

<style lang="scss" module>
.dice {
	margin-top: 8px;
}

.transition_reaction_move,
.transition_reaction_enterActive,
.transition_reaction_leaveActive {
	transition: opacity 0.2s cubic-bezier(0,.5,.5,1), transform 0.2s cubic-bezier(0,.5,.5,1) !important;
}
.transition_reaction_enterFrom,
.transition_reaction_leaveTo {
	opacity: 0;
	transform: scale(0.7);
}
.transition_reaction_leaveActive {
	position: absolute;
}

.root {
	position: relative;
	display: flex;

	&.isMe {
		flex-direction: row-reverse;
		text-align: right;

		.footer {
			flex-direction: row-reverse;
		}
	}

	// まとまりの2つ目以降は名前の行がないので、前の吹き出しに詰めて並べる
	&.continued {
		.body {
			padding-top: 0;
		}
	}
}

.avatar {
	display: block;
	width: 50px;
	height: 50px;

	&.useSticky {
		position: sticky;
		top: calc(16px + var(--MI-stickyTop, 0px));
	}
}

// .avatar と同じ幅
.avatarSpace {
	flex-shrink: 0;
	width: 50px;
}

.archivedAvatar {
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
	border-radius: 100%;
	// 설정의 계정 목록에서 정보를 불러오지 못한 계정과 같은 모양
	background-color: color-mix(in srgb, var(--MI_THEME-fg), transparent 85%);
	color: color-mix(in srgb, var(--MI_THEME-fg), transparent 25%);
	font-size: 1.4em;
}

.archivedAuthor {
	display: inline-flex;
	flex-wrap: wrap;
	gap: 0 6px;
	font-weight: bold;
}

.archivedAcct {
	font-weight: normal;
	opacity: 0.7;
}

.unavailableFiles {
	margin-top: 4px;
	font-size: 0.9em;
	opacity: 0.7;
}

@container (max-width: 450px) {
	.root {
		&.isMe {
			.avatar {
				display: none;
			}
		}
	}

	.avatar {
		width: 42px;
		height: 42px;
	}

	.avatarSpace {
		width: 42px;
	}

	.fukidashi {
		font-size: 90%;
	}
}

.body {
	padding-top: 4px;
	margin: 0 12px;
	box-sizing: border-box;

	&.fullWidth {
		width: 100%;
	}
}

// 指で長押しするとメニューが開き、コピーもそこにあるので、言葉まで選ばれないようにする。
// iOS の Safari は長押しで contextmenu を出さない (メニューが開かない) ので、これまでどおり選べるままにする
@media (hover: none) and (pointer: coarse) {
	@supports not (-webkit-touch-callout: none) {
		.body :global(._selectable) {
			user-select: none;
			-webkit-user-select: none;
		}
	}
}

.header {
	min-height: 4px; // fukidashiの位置調整も兼ねるため
	font-size: 80%;
}

.fukidashi {
	text-align: left;

	// 尻尾のない吹き出しは尻尾の分の余白が右側にしか付かないので、左寄せのときは左側にも付けて尻尾のある吹き出しと左端を揃える
	&.noTailLeft {
		padding-left: calc(var(--fukidashi-radius) * .13);
	}
}

.content {
	overflow: clip;
	overflow-wrap: break-word;
	word-break: break-word;
}

.footer {
	display: flex;
	flex-direction: row;
	gap: 0.5em;
	margin-top: 4px;
	font-size: 75%;
}

// まとまりの途中は普段の余白を詰め、キーボードで入ったときはメニューと時刻を出す。
.groupedFooter {
	display: none;

	.body:focus-within & {
		display: flex;
	}
}

.menuButton {
	position: relative;

	// アイコンは小さいままで、押せる範囲だけを広げる
	&::before {
		content: '';
		position: absolute;
		inset: -8px -10px;
	}
}

.time {
	opacity: 0.5;
}

.edited {
	opacity: 0.5;
}

.deletedMessage {
	opacity: 0.6;
	font-style: italic;
}

.reactions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	margin-top: 8px;

	&:empty {
		display: none;
	}
}

.reaction {
	display: flex;
	align-items: center;
	border: solid 1px var(--MI_THEME-divider);
	border-radius: 999px;
	padding: 8px;

	&.reactionMy {
		border-color: var(--MI_THEME-accent);
	}
}

.reactionAvatar {
	width: 24px;
	height: 24px;
	margin-right: 8px;
}

.reactionIcon {
	width: 24px;
	height: 24px;
}
</style>
