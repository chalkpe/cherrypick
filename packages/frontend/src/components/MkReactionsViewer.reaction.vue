<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<button
	ref="buttonEl"
	v-ripple="canToggle"
	class="_button"
	:class="[$style.root, { [$style.reacted]: myReaction == reaction, [$style.canToggle]: (canToggle || alternative), [$style.small]: prefer.s.reactionsDisplaySize === 'small', [$style.large]: prefer.s.reactionsDisplaySize === 'large' }]"
	@click.stop="(ev) => { canToggle || alternative ? toggleReaction(ev) : stealReaction(ev) }"
	@touchstart.stop="(ev) => openEmojiMenu(ev)"
	@touchend.stop="closeEmojiMenu"
	@contextmenu.prevent.stop="menu"
>
	<MkReactionIcon style="pointer-events: none;" :class="prefer.s.limitWidthOfReaction ? $style.limitWidth : ''" :reaction="reaction" :emojiUrl="reactionEmojis[emojiName]"/>
	<span :class="$style.count">{{ count }}</span>
</button>
</template>

<script lang="ts" setup>
import { computed, inject, onMounted, ref, useTemplateRef, watch } from 'vue';
import * as Misskey from 'cherrypick-js';
import { getUnicodeEmojiOrNull } from '@@/js/emojilist.js';
import { getEmojiNameFromReaction, isLocalCustomEmojiReaction } from '@@/js/emoji-name.js';
import MkCustomEmojiDetailedDialog from './MkCustomEmojiDetailedDialog.vue';
import type { MenuItem } from '@/types/menu';
import type { ComputedRef } from 'vue';
import XDetails from '@/components/MkReactionsViewer.details.vue';
import MkReactionIcon from '@/components/MkReactionIcon.vue';
import * as os from '@/os.js';
import { misskeyApi, misskeyApiGet } from '@/utility/misskey-api.js';
import { useTooltip } from '@/composables/use-tooltip.js';
import { $i } from '@/i.js';
import MkReactionEffect from '@/components/MkReactionEffect.vue';
import { i18n } from '@/i18n.js';
import * as sound from '@/utility/sound.js';
// import { checkReactionPermissions } from '@/utility/check-reaction-permissions.js';
import { customEmojis, customEmojisMap } from '@/custom-emojis.js';
import { prefer } from '@/preferences.js';
import { DI } from '@/di.js';
import { noteEvents } from '@/composables/use-note-capture.js';
import { mute as muteEmoji, unmute as unmuteEmoji, checkMuted as isEmojiMuted } from '@/utility/emoji-mute.js';
import { addToEmojiPalette } from '@/utility/emoji-palette.js';
import { haptic } from '@/utility/haptic.js';
import { copyToClipboard } from '@/utility/copy-to-clipboard.js';

const props = defineProps<{
	noteId: Misskey.entities.Note['id'];
	reaction: string;
	reactionEmojis: Misskey.entities.Note['reactionEmojis'];
	myReaction: Misskey.entities.Note['myReaction'];
	count: number;
	isInitial: boolean;
	note: Misskey.entities.Note;
}>();

const mock = inject(DI.mock, false);

const emit = defineEmits<{
	(ev: 'reactionToggled', emoji: string, newCount: number): void;
}>();

const buttonEl = useTemplateRef('buttonEl');

const emojiName = computed(() => getEmojiNameFromReaction(props.reaction));

const isLocalCustomEmoji = computed(() => isLocalCustomEmojiReaction(props.reaction));
const canGetInfo = computed(() => isLocalCustomEmoji.value);

const canToggle = computed(() => {
	const emoji = isLocalCustomEmoji.value ? customEmojisMap.get(emojiName.value) : getUnicodeEmojiOrNull(props.reaction);

	// TODO
	//return $i != null && emoji != null && checkReactionPermissions($i, props.note, emoji);
	return $i != null && emoji != null;
});

const reactionName = computed(() => {
	const r = props.reaction.replace(':', '');
	return r.slice(0, r.indexOf('@'));
});

const alternative: ComputedRef<string | null> = computed(() => prefer.s.reactableRemoteReactionEnabled ? (customEmojis.value.find(it => it.name === reactionName.value)?.name ?? null) : null);

const canSteal = computed(() => props.note.user.host && $i && ($i.isAdmin || $i.policies.canManageCustomEmojis));

const longTouchEmoji = ref(false);

async function toggleReaction(ev: MouseEvent) {
	haptic();

	if (!canToggle.value) {
		chooseAlternative(ev);
		return;
	}
	if ($i == null) return;

	const me = $i;

	const oldReaction = props.myReaction;
	if (oldReaction) {
		if (oldReaction !== props.reaction) {
			sound.playMisskeySfx('reaction');
			haptic();
		}

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count - 1));
			return;
		}

		if (oldReaction === props.reaction) {
			misskeyApi('notes/reactions/delete', {
				noteId: props.noteId,
			}).then(() => {
				noteEvents.emit(`unreacted:${props.noteId}`, {
					userId: me.id,
					reaction: oldReaction,
				});
			});
		} else {
			// 既存のリアクションはサーバー側で置き換えられるので delete は呼ばない (delete の間隔制限を避ける)
			misskeyApi('notes/reactions/create', {
				noteId: props.noteId,
				reaction: props.reaction,
			}).then(() => {
				noteEvents.emit(`unreacted:${props.noteId}`, {
					userId: me.id,
					reaction: oldReaction,
				});
				const emoji = customEmojisMap.get(emojiName.value);
				if (emoji == null && getUnicodeEmojiOrNull(props.reaction) == null) {
					return;
				}
				noteEvents.emit(`reacted:${props.noteId}`, {
					userId: me.id,
					reaction: props.reaction,
					emoji: emoji,
				});
			});
		}
	} else {
		if (prefer.s.confirmOnReact) {
			const confirm = await os.confirm({
				type: 'question',
				text: i18n.tsx.reactAreYouSure({ emoji: props.reaction.replace('@.', '') }),
			});

			if (confirm.canceled) return;
		}

		sound.playMisskeySfx('reaction');
		haptic();

		if (mock) {
			emit('reactionToggled', props.reaction, (props.count + 1));
			return;
		}

		misskeyApi('notes/reactions/create', {
			noteId: props.noteId,
			reaction: props.reaction,
		}).then(() => {
			const emoji = customEmojisMap.get(emojiName.value);
			if (emoji == null && getUnicodeEmojiOrNull(props.reaction) == null) {
				return;
			}

			noteEvents.emit(`reacted:${props.noteId}`, {
				userId: me.id,
				reaction: props.reaction,
				emoji: emoji,
			});
		});
		// TODO: 上位コンポーネントでやる
		//if (props.note.text && props.note.text.length > 100 && (Date.now() - new Date(props.note.createdAt).getTime() < 1000 * 3)) {
		//	claimAchievement('reactWithoutRead');
		//}
	}
}

function stealReaction(ev: Event) {
	haptic();

	let menuItems: MenuItem[] = [];

	menuItems.push({
		type: 'label',
		text: `:${reactionName.value}:`,
	});

	if (canGetInfo.value) {
		menuItems.push({
			text: i18n.ts.info,
			icon: 'ti ti-info-circle',
			action: async () => {
				const { dispose } = os.popup(MkCustomEmojiDetailedDialog, {
					emoji: await misskeyApiGet('emoji', {
						name: props.reaction.replace(/:/g, '').replace(/@\./, ''),
					}),
				}, {
					closed: () => dispose(),
				});
			},
		});
	}

	if (customEmojis.value.find(it => it.name === reactionName.value)?.name) {
		menuItems.push({
			text: i18n.ts.copy,
			icon: 'ti ti-copy',
			action: () => {
				copyToClipboard(`:${reactionName.value}:`);
			},
		});
	}

	if (canSteal.value) {
		menuItems.push({
			text: i18n.ts.import,
			icon: 'ti ti-plus',
			action: async () => {
				await os.apiWithDialog('admin/emoji/steal', {
					name: reactionName.value,
					host: props.note.user.host ?? '',
				});
			},
		}, {
			text: `${i18n.ts.doReaction} (${i18n.ts.import})`,
			icon: 'ti ti-mood-plus',
			action: async () => {
				await os.apiWithDialog('admin/emoji/steal', {
					name: reactionName.value,
					host: props.note.user.host ?? '',
				});

				await misskeyApi('notes/reactions/create', {
					noteId: props.note.id,
					reaction: `:${reactionName.value}:`,
				});
			},
		});
	}

	if (isEmojiMuted(props.reaction).value) {
		menuItems.push({
			text: i18n.ts.emojiUnmute,
			icon: 'ti ti-mood-smile',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.unmuteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					unmuteEmoji(props.reaction);
				});
			},
		});
	} else {
		menuItems.push({
			text: i18n.ts.emojiMute,
			icon: 'ti ti-mood-off',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.muteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					muteEmoji(props.reaction);
				});
			},
		});
	}

	os.popupMenu(menuItems, buttonEl.value ?? ev.currentTarget ?? ev.target);
}

async function menu(ev: PointerEvent) {
	let menuItems: MenuItem[] = [];

	menuItems.push({
		type: 'label',
		text: `:${reactionName.value}:`,
	});

	if (canGetInfo.value) {
		menuItems.push({
			text: i18n.ts.info,
			icon: 'ti ti-info-circle',
			action: async () => {
				const { dispose } = os.popup(MkCustomEmojiDetailedDialog, {
					emoji: await misskeyApiGet('emoji', {
						name: props.reaction.replace(/:/g, '').replace(/@\./, ''),
					}),
				}, {
					closed: () => dispose(),
				});
			},
		});
	}

	if (customEmojis.value.find(it => it.name === reactionName.value)?.name) {
		menuItems.push({
			text: i18n.ts.copy,
			icon: 'ti ti-copy',
			action: () => {
				copyToClipboard(`:${reactionName.value}:`);
			},
		});
	}

	if (canSteal.value) {
		menuItems.push({
			text: i18n.ts.import,
			icon: 'ti ti-plus',
			action: async () => {
				await os.apiWithDialog('admin/emoji/steal', {
					name: reactionName.value,
					host: props.note.user.host ?? '',
				});
			},
		}, {
			text: `${i18n.ts.doReaction} (${i18n.ts.import})`,
			icon: 'ti ti-mood-plus',
			action: async () => {
				await os.apiWithDialog('admin/emoji/steal', {
					name: reactionName.value,
					host: props.note.user.host ?? '',
				});

				await misskeyApi('notes/reactions/create', {
					noteId: props.note.id,
					reaction: `:${reactionName.value}:`,
				});
			},
		});
	}

	if (isEmojiMuted(props.reaction).value) {
		menuItems.push({
			text: i18n.ts.emojiUnmute,
			icon: 'ti ti-mood-smile',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.unmuteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					unmuteEmoji(props.reaction);
				});
			},
		});
	} else {
		menuItems.push({
			text: i18n.ts.emojiMute,
			icon: 'ti ti-mood-off',
			action: () => {
				os.confirm({
					type: 'question',
					title: i18n.tsx.muteX({ x: isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction }),
				}).then(({ canceled }) => {
					if (canceled) return;
					muteEmoji(props.reaction);
				});
			},
		});
	}

	if (canToggle.value) {
		menuItems.push({
			text: i18n.ts.addToEmojiPalette,
			icon: 'ti ti-palette',
			action: () => {
				addToEmojiPalette(isLocalCustomEmoji.value ? `:${emojiName.value}:` : props.reaction);
			},
		});
	}

	os.popupMenu(menuItems, ev.currentTarget ?? ev.target);
}

function anime() {
	if (window.document.hidden || !prefer.s.animation || buttonEl.value == null) return;

	const rect = buttonEl.value.getBoundingClientRect();
	const x = rect.left + 16;
	const y = rect.top + (buttonEl.value.offsetHeight / 2);
	const { dispose } = os.popup(MkReactionEffect, { reaction: props.reaction, x, y }, {
		end: () => dispose(),
	});
}

function chooseAlternative(ev: MouseEvent) {
	// メニュー表示にして、モデレーター以上の場合は登録もできるように
	if (!alternative.value) return;
	console.log(alternative.value);
	misskeyApi('notes/reactions/create', {
		noteId: props.noteId,
		reaction: `:${alternative.value}:`,
	});
}

function openEmojiMenu(ev: TouchEvent) {
	longTouchEmoji.value = true;
	window.setTimeout(() => {
		if (longTouchEmoji.value === true) stealReaction(ev);
	}, 500);
}

function closeEmojiMenu() {
	longTouchEmoji.value = false;
}

watch(() => props.count, (newCount, oldCount) => {
	if (oldCount < newCount) anime();
});

onMounted(() => {
	if (!props.isInitial) anime();
});

if (!mock) {
	useTooltip(buttonEl, async (showing) => {
		if (buttonEl.value == null) return;

		const reactions = await misskeyApi('notes/reactions', {
			noteId: props.noteId,
			type: props.reaction,
			limit: 10,
		});

		const users = reactions.map(x => x.user);

		const { dispose } = os.popup(XDetails, {
			showing,
			reaction: props.reaction,
			users,
			count: props.count,
			anchorElement: buttonEl.value,
		}, {
			closed: () => dispose(),
		});
	}, 100);
}
</script>

<style lang="scss" module>
.root {
	display: inline-flex;
	height: 38px;
	padding: 0 12px;
	font-size: 1.35em;
	border-radius: 999px;
	align-items: center;
	justify-content: center;

	&.canToggle {
		background: var(--MI_THEME-buttonBg);

		&:hover {
			background: var(--MI_THEME-buttonHoverBg, rgba(0, 0, 0, 0.1));
		}
	}

	&:not(.canToggle) {
		cursor: default;
	}

	&.small {
		height: 30px;
		font-size: 1em;

		> .count {
			font-size: 0.9em;
			line-height: 22px;
		}
	}

	&.large {
		height: 46px;
		font-size: 1.8em;
		padding: 4px 16px;

		> .count {
			font-size: 0.6em;
			line-height: 50px;
			margin: 0 0 0 8px;
		}
	}

	&.reacted, &.reacted:hover {
		background: var(--MI_THEME-accentedBg);
		color: var(--MI_THEME-accent);
		box-shadow: 0 0 0 1px var(--MI_THEME-accent) inset;

		> .count {
			color: var(--MI_THEME-accent);
		}

		> .icon {
			filter: drop-shadow(0 0 2px rgba(0, 0, 0, 0.5));
		}
	}
}

.limitWidth {
	max-width: 70px;
	object-fit: contain;
}

.count {
	font-size: 0.9em;
	line-height: 32px;
	margin: 0 0 0 5px;
}
</style>
