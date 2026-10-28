<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<div
	ref="rootEl"
	:class="$style.root"
	@dragover.stop="onDragover"
	@drop.stop="onDrop"
>
	<XPostFormAttaches v-if="file" v-model="attachments" :max="1" @detach="file = null" @changeSensitive="(changed, isSensitive) => updateAttachment(changed, { isSensitive })" @changeName="(changed, name) => updateAttachment(changed, { name })"/>
	<textarea
		ref="textareaEl"
		v-model="text"
		:class="$style.textarea"
		class="_acrylic"
		:placeholder="i18n.ts.inputMessageHere"
		:readonly="textareaReadOnly"
		@keydown="onKeydown"
		@paste="onPaste"
	></textarea>
	<footer :class="$style.footer">
		<div :class="$style.buttons">
			<button class="_button" :class="$style.button" @click="chooseFile"><i class="ti ti-photo-plus"></i></button>
			<button class="_button" :class="$style.button" @click="insertEmoji"><i class="ti ti-mood-happy"></i></button>
			<!-- 通話中は PC だと通話バーがここに入る -->
			<XVoiceCallBarSlot kind="chatForm" :focusWithin="rootEl" :class="$style.voiceCall"/>
			<button class="_button" :class="[$style.button, $style.send]" :disabled="!canSend || sending" :title="i18n.ts.send" @click="send">
				<template v-if="!sending"><i class="ti ti-send"></i></template><template v-if="sending"><MkLoading :em="true"/></template>
			</button>
		</div>
	</footer>
	<input ref="fileEl" style="display: none;" type="file" @change="onChangeFile"/>
</div>
</template>

<script lang="ts" setup>
import { onMounted, watch, ref, shallowRef, computed, nextTick, readonly, onBeforeUnmount, useTemplateRef } from 'vue';
import * as Misskey from 'cherrypick-js';
//import insertTextAtCursor from 'insert-text-at-cursor';
import { formatTimeString } from '@/utility/format-time-string.js';
import { selectFile } from '@/utility/drive.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { miLocalStorage } from '@/local-storage.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';
import { Autocomplete } from '@/utility/autocomplete.js';
import { emojiPicker } from '@/utility/emoji-picker.js';
import { getDragData } from '@/drag-and-drop.js';
import XVoiceCallBarSlot from '@/ui/_common_/voice-call-bar-slot.vue';
import XPostFormAttaches from '@/components/MkPostFormAttaches.vue';

const props = defineProps<{
	user?: Misskey.entities.UserDetailed | null;
	room?: Misskey.entities.ChatRoom | null;
}>();

const rootEl = useTemplateRef('rootEl');
const textareaEl = shallowRef<HTMLTextAreaElement>();
const fileEl = shallowRef<HTMLInputElement>();

const text = ref<string>('');
const file = ref<Misskey.entities.DriveFile | null>(null);
const attachments = computed({
	get: () => file.value ? [file.value] : [],
	set: (files: Misskey.entities.DriveFile[]) => { file.value = files[0] ?? null; },
});
const sending = ref(false);
const textareaReadOnly = ref(false);
let autocompleteInstance: Autocomplete | null = null;

const canSend = computed(() => (text.value != null && text.value !== '') || file.value != null);

function getDraftKey() {
	return props.user ? 'user:' + props.user.id : 'room:' + props.room?.id;
}

watch([text, file], saveDraft, { deep: true });

function updateAttachment(changed: Misskey.entities.DriveFile, updates: Partial<Pick<Misskey.entities.DriveFile, 'name' | 'isSensitive'>>) {
	if (file.value?.id !== changed.id) return;
	file.value = { ...file.value, ...updates };
}

async function uploadFiles(files: File[]) {
	if (files.length === 0) return;
	if (files.length > 1) {
		os.alert({ type: 'error', text: i18n.ts.onlyOneFileCanBeAttached });
		return;
	}
	try {
		const uploaded = await os.launchUploader(files, { multiple: false });
		if (uploaded[0]) file.value = uploaded[0];
	} catch {
		// Closing the uploader leaves the existing draft attachment intact.
	}
}

async function onPaste(ev: ClipboardEvent) {
	if (!ev.clipboardData) return;
	const files = Array.from(ev.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((item): item is File => item != null);
	if (files.length === 0) files.push(...Array.from(ev.clipboardData.files));
	if (files.length === 0) return;
	ev.preventDefault();
	if (files.length === 1) {
		const pastedFile = files[0];
		const lio = pastedFile.name.lastIndexOf('.');
		const ext = lio >= 0 ? pastedFile.name.slice(lio) : '';
		const formattedName = formatTimeString(new Date(pastedFile.lastModified), 'yyyy-MM-dd HH-mm-ss [1]') + ext;
		await uploadFiles([new File([pastedFile], formattedName, { type: pastedFile.type })]);
	} else {
		await uploadFiles(files);
	}
}

function onDragover(ev: DragEvent) {
	if (!ev.dataTransfer) return;

	const isFile = Array.from(ev.dataTransfer.types).includes('Files') || Array.from(ev.dataTransfer.items).some(item => item.kind === 'file');
	if (isFile || Array.from(ev.dataTransfer.types).some(type => type.toLowerCase() === 'cherrypick/drivefiles')) {
		ev.preventDefault();
		switch (ev.dataTransfer.effectAllowed) {
			case 'all':
			case 'uninitialized':
			case 'copy':
			case 'copyLink':
			case 'copyMove':
				ev.dataTransfer.dropEffect = 'copy';
				break;
			case 'linkMove':
			case 'move':
				ev.dataTransfer.dropEffect = 'move';
				break;
			default:
				ev.dataTransfer.dropEffect = 'none';
				break;
		}
	}
}

async function onDrop(ev: DragEvent) {
	if (!ev.dataTransfer) return;
	if (ev.dataTransfer.files.length > 0) {
		ev.preventDefault();
		await uploadFiles(Array.from(ev.dataTransfer.files));
		return;
	}
	const droppedData = getDragData(ev, 'driveFiles');
	if (droppedData == null) return;
	ev.preventDefault();
	if (droppedData.length === 1) file.value = droppedData[0];
	else if (droppedData.length > 1) os.alert({ type: 'error', text: i18n.ts.onlyOneFileCanBeAttached });
}

defineExpose({ onDragover, onDrop });

function onKeydown(ev: KeyboardEvent) {
	if (ev.isComposing || ev.key === 'Process' || ev.keyCode === 229) return;
	if (ev.key === 'Enter') {
		if (prefer.s['chat.sendOnEnter']) {
			if (!(ev.ctrlKey || ev.metaKey || ev.shiftKey)) {
				send();
			}
		} else {
			if ((ev.ctrlKey || ev.metaKey)) {
				send();
			}
		}
	}
}

function chooseFile(ev: PointerEvent) {
	selectFile({
		anchorElement: ev.currentTarget ?? ev.target,
		multiple: false,
		label: i18n.ts.selectFile,
	}).then(selectedFile => {
		file.value = selectedFile;
	});
}

function onChangeFile() {
	if (fileEl.value?.files) void uploadFiles(Array.from(fileEl.value.files));
}

function send() {
	if (sending.value || !canSend.value) return;

	sending.value = true;

	if (props.user) {
		misskeyApi('chat/messages/create-to-user', {
			toUserId: props.user.id,
			text: text.value ? text.value : undefined,
			fileId: file.value ? file.value.id : undefined,
		}).then(message => {
			clear();
		}).catch(err => {
			console.error(err);
		}).then(() => {
			sending.value = false;
		});
	} else if (props.room) {
		misskeyApi('chat/messages/create-to-room', {
			toRoomId: props.room.id,
			text: text.value ? text.value : undefined,
			fileId: file.value ? file.value.id : undefined,
		}).then(message => {
			clear();
		}).catch(err => {
			console.error(err);
		}).then(() => {
			sending.value = false;
		});
	}
}

function clear() {
	text.value = '';
	file.value = null;
	deleteDraft();
}

function saveDraft() {
	const drafts = JSON.parse(miLocalStorage.getItem('chatMessageDrafts') || '{}');

	drafts[getDraftKey()] = {
		updatedAt: new Date(),
		data: {
			text: text.value,
			file: file.value,
		},
	};

	miLocalStorage.setItem('chatMessageDrafts', JSON.stringify(drafts));
}

function deleteDraft() {
	const drafts = JSON.parse(miLocalStorage.getItem('chatMessageDrafts') || '{}');

	delete drafts[getDraftKey()];

	miLocalStorage.setItem('chatMessageDrafts', JSON.stringify(drafts));
}

async function insertEmoji(ev: MouseEvent) {
	textareaReadOnly.value = true;
	const target = ev.currentTarget ?? ev.target;
	if (target == null) return;

	// emojiPickerはダイアログが閉じずにtextareaとやりとりするので、
	// focustrapをかけているとinsertTextAtCursorが効かない
	// そのため、投稿フォームのテキストに直接注入する
	// See: https://github.com/misskey-dev/misskey/pull/14282
	//      https://github.com/misskey-dev/misskey/issues/14274

	let pos = textareaEl.value?.selectionStart ?? 0;
	let posEnd = textareaEl.value?.selectionEnd ?? text.value.length;
	emojiPicker.show(
		target as HTMLElement,
		emoji => {
			const textBefore = text.value.substring(0, pos);
			const textAfter = text.value.substring(posEnd);
			text.value = textBefore + emoji + textAfter;
			pos += emoji.length;
			posEnd += emoji.length;
		},
		() => {
			textareaReadOnly.value = false;
			nextTick(() => focus());
		},
	);
}

onMounted(() => {
	if (textareaEl.value != null) {
		autocompleteInstance = new Autocomplete(textareaEl.value, text);
	}

	// 書きかけの投稿を復元
	const draft = JSON.parse(miLocalStorage.getItem('chatMessageDrafts') || '{}')[getDraftKey()];
	if (draft) {
		text.value = draft.data.text;
		file.value = draft.data.file;
	}
});

onBeforeUnmount(() => {
	if (autocompleteInstance) {
		autocompleteInstance.detach();
		autocompleteInstance = null;
	}
});
</script>

<style lang="scss" module>
.root {
	position: relative;
	border-bottom: none;
	border-radius: 14px 14px 0 0;
	overflow: clip;
}

.textarea {
	cursor: auto;
	display: block;
	width: 100%;
	min-width: 100%;
	max-width: 100%;
	min-height: 80px;
	margin: 0;
	padding: 16px 16px 0 16px;
	resize: none;
	font-size: 1em;
	font-family: inherit;
	outline: none;
	border: none;
	border-radius: 0;
	box-shadow: none;
	box-sizing: border-box;
	color: var(--MI_THEME-fg);
	field-sizing: content;
}

.footer {
	position: sticky;
	bottom: 0;
	background: var(--MI_THEME-panel);
}

.buttons {
	display: flex;
}

.button {
	flex-shrink: 0;
	height: 50px;
	aspect-ratio: 1;

	&:hover {
		color: var(--MI_THEME-accent);
	}
}

// 通話バーはこの幅いっぱいを使う。両隣のボタンはアイコンの周りに余白があるので、ここには余白を取らない
.voiceCall {
	display: flex;
	flex: 1;
	align-items: center;
	min-width: 0;
}

.send {
	margin-left: auto;
	color: var(--MI_THEME-accent);
}
</style>
