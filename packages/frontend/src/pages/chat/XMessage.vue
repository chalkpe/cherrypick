<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div :class="[$style.root, { [$style.isMe]: isMe, [$style.continued]: !isFirstInGroup }]">
	<MkAvatar v-if="!isMe && isFirstInGroup" :class="[$style.avatar, prefer.s.useStickyIcons ? $style.useSticky : null]" :user="message.fromUser!" :link="!isMe" :preview="false"/>
	<!-- まとまりの2つ目以降もアバターの幅だけ空けて、吹き出しの位置を揃える -->
	<div v-else-if="!isMe" :class="$style.avatarSpace"></div>
	<div :class="[$style.body, hasFiles ? $style.fullWidth : null]" tabindex="0" aria-haspopup="menu" @keydown.self="onMenuKeydown" @contextmenu.stop="onContextmenu">
		<div v-if="isFirstInGroup" :class="$style.header"><MkUserName v-if="!isMe && prefer.s['chat.showSenderName'] && message.fromUser != null" :user="message.fromUser"/></div>
		<MkFukidashi :class="[$style.fukidashi, { [$style.noTailLeft]: !isFirstInGroup && !isMe }]" :tail="!isFirstInGroup ? 'none' : isMe ? 'right' : 'left'" :fullWidth="hasFiles" :accented="isMe">
			<span v-if="deletedAt" :class="$style.deletedMessage">{{ i18n.ts._chat.deletedMessage }}</span>
			<template v-else>
				<Mfm
					v-if="message.text"
					ref="text"
					class="_selectable"
					:text="message.text"
					:author="message.fromUser"
					:i="$i"
					:nyaize="'respect'"
					:emojiUrls="message.emojis"
					:enableEmojiMenu="true"
					:enableEmojiMenuReaction="canReact"
				/>
				<XDiceResult v-if="message.dice" :class="$style.dice" :dice="message.dice"/>
				<MkMediaList v-if="hasFiles" :mediaList="message.files" :user="message.fromUser"/>
			</template>
		</MkFukidashi>
		<MkUrlPreview v-for="url in urls" :key="url" :url="url" style="margin: 8px 0;"/>
		<div :class="[$style.footer, { [$style.groupedFooter]: !isLastInGroup }]">
			<button class="_textButton" :class="$style.menuButton" style="color: currentColor;" :aria-label="i18n.ts.menu" @click="showMenu"><i class="ti ti-dots-circle-horizontal"></i></button>
			<MkTime :class="$style.time" :time="message.createdAt"/>
			<span v-if="editedAt && !deletedAt" :class="$style.edited">{{ i18n.ts.edited }}</span>
			<MkA v-if="isSearchResult && 'toRoom' in message && message.toRoom != null" :to="`/chat/room/${message.toRoomId}`">{{ message.toRoom.name }}</MkA>
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
			<div
				v-for="record in message.reactions"
				:key="record.reaction + record.user.id"
				:class="[$style.reaction, {
					[$style.reactionReacted]: record.user.id === $i.id,
					[$style.reactionCanToggle]: isUsableReaction(record.reaction),
					[$style.reactionClickable]: isReactionClickable(record),
					[$style.reactionSmall]: prefer.r.reactionsDisplaySize.value === 'small',
					[$style.reactionLarge]: prefer.r.reactionsDisplaySize.value === 'large',
				}]"
				@click.capture="onReactionClick(record)"
			>
				<MkAvatar :user="record.user" :link="false" :class="$style.reactionAvatar"/>
				<MkReactionIcon
					:withTooltip="true"
					:reaction="record.reaction.replace(/^:(\w+):$/, ':$1@.:')"
					:class="[$style.reactionIcon, prefer.r.limitWidthOfReaction.value ? $style.reactionLimitWidth : '']"
				/>
			</div>
		</TransitionGroup>
	</div>
</div>
</template>

<script lang="ts" setup>
import { computed, defineAsyncComponent, onBeforeUnmount, provide, ref } from 'vue';
import * as mfm from 'mfc-js';
import * as Misskey from 'cherrypick-js';
import { url } from '@@/js/config.js';
import { isLink } from '@@/js/is-link.js';
import { getUnicodeEmojiOrNull } from '@@/js/emojilist.js';
import { getEmojiNameFromReaction } from '@@/js/emoji-name.js';
import type { MenuItem } from '@/types/menu.js';
import type { NormalizedChatMessage } from './room.vue';
import { chatErrorText } from './chat-errors.js';
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
import { customEmojisMap } from '@/custom-emojis.js';
import { DI } from '@/di.js';
import { getHTMLElementOrNull } from '@/utility/get-dom-node-or-null.js';

const $i = ensureSignin();

const props = withDefaults(defineProps<{
	message: NormalizedChatMessage | Misskey.entities.ChatMessage;
	isSearchResult?: boolean;
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

const isMe = computed(() => props.message.fromUserId === $i.id);
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

// 他サーバーのカスタム絵文字はこのサーバーからはリアクションできない
function isRemoteCustomEmoji(reaction: string): boolean {
	return /@[\w.-]/.test(reaction);
}

// ノートのリアクション (MkReactionsViewer.reaction.vue の canToggle) と同じく、このサーバーで使える絵文字かどうか
function isUsableReaction(reaction: string): boolean {
	if (reaction[0] !== ':') return getUnicodeEmojiOrNull(reaction) != null;
	if (isRemoteCustomEmoji(reaction)) return false;
	return customEmojisMap.has(getEmojiNameFromReaction(reaction));
}

// 押すと何かが起きるリアクション。onReactionClick が何もしないものには、押せる見た目を付けない
function isReactionClickable(record: Misskey.entities.ChatMessage['reactions'][0]): boolean {
	return canReact.value && (record.user.id === $i.id || !isRemoteCustomEmoji(record.reaction));
}

// 絵文字 (MkEmoji / MkCustomEmoji) は自分でクリックの伝播を止めるので、テンプレートではキャプチャで受けて絵文字の上を押しても反応するようにしている
function onReactionClick(record: Misskey.entities.ChatMessage['reactions'][0]) {
	if (!canReact.value) return;

	if (record.user.id === $i.id) {
		sendReaction('chat/messages/unreact', record.reaction);
	} else if (!isRemoteCustomEmoji(record.reaction)) {
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

	// リアクションはノートと同じく本文の文字の大きさに合わせる
	.fukidashi,
	.reactions {
		font-size: 90%;
	}
}

.body {
	min-width: 0;
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

// リアクションの見た目はノートのもの (MkReactionsViewer.vue / MkReactionsViewer.reaction.vue) に揃える。
// 大きさ・背景・自分のリアクションの強調は、誰が送ったメッセージかによらず同じにする
.reactions {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px;
	margin-top: 8px;

	&:empty {
		display: none;
	}
}

.reaction {
	display: inline-flex;
	max-width: 100%;
	height: 38px;
	padding: 0 12px;
	font-size: 1.35em;
	border-radius: 999px;
	align-items: center;
	justify-content: center;
	// ノートのリアクションは button なので、高さに余白を含める計算を揃える
	box-sizing: border-box;

	&.reactionCanToggle {
		background: var(--MI_THEME-buttonBg);
	}

	&.reactionClickable {
		cursor: pointer;
	}

	&.reactionCanToggle.reactionClickable:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.reactionSmall {
		height: 30px;
		font-size: 1em;
	}

	&.reactionLarge {
		height: 46px;
		font-size: 1.8em;
		padding: 4px 16px;

		> .reactionAvatar {
			margin: 0 8px 0 0;
		}
	}

	&.reactionReacted, &.reactionReacted.reactionClickable:hover {
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
		box-shadow: 0 0 0 1px var(--MI_THEME-accent) inset;
	}
}

// 誰のリアクションかは、絵文字と同じ高さのアバターで示す。絵文字との間隔はノートのリアクション数と同じにする
.reactionAvatar {
	width: 1.25em;
	height: 1.25em;
	margin: 0 5px 0 0;
}

.reactionLimitWidth {
	max-width: 70px;
	object-fit: contain;
}

// 폭 제한을 꺼도 칩 안에서 줄어들 수 있게 하여 좁은 화면에서 이미지를 자르지 않는다.
.reactionIcon {
	min-width: 0;
	object-fit: contain;
}
</style>
