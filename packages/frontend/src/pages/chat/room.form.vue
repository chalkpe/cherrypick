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
	<XPostFormAttaches v-if="files.length > 0 && !editingMessage" v-model="files" :max="MAX_FILES" @detach="detachFile" @changeSensitive="(changed, isSensitive) => updateAttachment(changed, { isSensitive })" @changeName="(changed, name) => updateAttachment(changed, { name })"/>
	<div v-if="editingMessage" :class="$style.editing"><i class="ti ti-pencil" aria-hidden="true"></i> {{ i18n.ts._chat.editingMessage }}</div>
	<!-- iOS 27 の Safari は案内文 (「…입력해 주세요」の「주」) から住所の欄と見なし、キーボードの上に連絡先の自動入力を出す。autocomplete="off" では止まらないので name で普通の入力欄と知らせる -->
	<textarea
		ref="textareaEl"
		name="search"
		:value="text"
		:class="$style.textarea"
		class="_acrylic"
		:placeholder="i18n.ts.inputMessageHere"
		:aria-label="i18n.ts.inputMessageHere"
		:aria-invalid="remainingLength < 0"
		:aria-describedby="remainingLength < 100 ? remainingLengthId : undefined"
		:readonly="textareaReadOnly"
		@input="onTextInput"
		@compositionstart="onCompositionStart"
		@compositionend="onCompositionEnd"
		@keydown="onKeydown"
		@paste="onPaste"
	></textarea>
	<footer :class="$style.footer">
		<div :class="$style.buttons">
			<button v-if="!editingMessage" class="_button" :class="$style.button" :title="i18n.ts.selectFile" :aria-label="i18n.ts.selectFile" :disabled="files.length >= MAX_FILES" @click="chooseFile"><i class="ti ti-photo-plus"></i></button>
			<button class="_button" :class="$style.button" :title="i18n.ts.emoji" :aria-label="i18n.ts.emoji" @click="insertEmoji"><i class="ti ti-mood-happy"></i></button>
			<!-- 通話中は PC だと通話バーがここに入る -->
			<XVoiceCallBarSlot kind="chatForm" :focusWithin="rootEl" :class="$style.voiceCall"/>
			<button v-if="editingMessage" class="_button" :class="$style.button" :title="i18n.ts.cancel" :aria-label="i18n.ts.cancel" @click="emit('cancelEdit')"><i class="ti ti-x"></i></button>
			<span v-if="remainingLength < 100" :id="remainingLengthId" :class="[$style.remaining, { [$style.overLimit]: remainingLength < 0 }]" :aria-label="i18n.tsx.remainingN({ n: remainingLength })">{{ remainingLength }}</span>
			<!-- disabled にすると、押せない間はフォーカスを持てず、押しただけで入力欄のフォーカスも外れる (send が押せない間は何もしない) -->
			<button class="_button" :class="[$style.button, $style.send]" :aria-disabled="!canSend || sending" :title="editingMessage ? i18n.ts.save : i18n.ts.send" :aria-label="editingMessage ? i18n.ts.save : i18n.ts.send" @mousedown="keepTextareaFocus" @click="send">
				<template v-if="!sending"><i class="ti ti-send"></i></template><template v-if="sending"><MkLoading :em="true"/></template>
			</button>
		</div>
	</footer>
	<input ref="fileEl" style="display: none;" type="file" :disabled="!!editingMessage" @change="onChangeFile"/>
</div>
</template>

<script lang="ts" setup>
import { onMounted, watch, ref, shallowRef, computed, nextTick, readonly, onBeforeUnmount, useId, useTemplateRef } from 'vue';
import * as Misskey from 'cherrypick-js';
//import insertTextAtCursor from 'insert-text-at-cursor';
import { chatErrorText } from './chat-errors.js';
import { formatTimeString } from '@/utility/format-time-string.js';
import { selectFile } from '@/utility/drive.js';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { miLocalStorage } from '@/local-storage.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { prefer } from '@/preferences.js';
import { Autocomplete } from '@/utility/autocomplete.js';
import { emojiPicker } from '@/utility/emoji-picker.js';
import { checkDragDataType, getDragData } from '@/drag-and-drop.js';
import XVoiceCallBarSlot from '@/ui/_common_/voice-call-bar-slot.vue';
import XPostFormAttaches from '@/components/MkPostFormAttaches.vue';

// chat/messages/create-to-user と create-to-room の fileIds の上限
const MAX_FILES = 4;
// 同じく text の上限。コードポイントで数える
const MAX_TEXT_LENGTH = 4096;

const props = defineProps<{
	user?: Misskey.entities.UserDetailed | null;
	room?: Misskey.entities.ChatRoom | null;
	editingMessage?: { id: string; text?: string | null; fileIds?: string[] } | null;
}>();

const emit = defineEmits<{
	(ev: 'edited'): void;
	(ev: 'cancelEdit'): void;
	(ev: 'sent', messageId: string): void;
}>();

const rootEl = useTemplateRef('rootEl');
const textareaEl = shallowRef<HTMLTextAreaElement>();
const fileEl = shallowRef<HTMLInputElement>();

const draftText = ref('');
const editText = ref('');
const text = computed({
	get: () => props.editingMessage ? editText.value : draftText.value,
	set: value => {
		if (props.editingMessage) editText.value = value;
		else draftText.value = value;
	},
});
const files = ref<Misskey.entities.DriveFile[]>([]);
const sending = ref(false);
const textareaReadOnly = ref(false);
let autocompleteInstance: Autocomplete | null = null;
let editSession = 0;

const remainingLength = computed(() => MAX_TEXT_LENGTH - Array.from(text.value).length);
const remainingLengthId = useId();
const canSend = computed(() => remainingLength.value >= 0 && (props.editingMessage
	? text.value.trim() !== '' || (props.editingMessage.fileIds?.length ?? 0) > 0
	: text.value !== '' || files.value.length > 0));

watch(() => props.editingMessage, (message) => {
	editSession++;
	editText.value = message?.text ?? '';
	if (message == null) return;
	void nextTick(() => textareaEl.value?.focus());
}, { immediate: true, flush: 'sync' });

// v-model は変換中の文字を渡さない。スマートフォンのキーボードは打った文字をほとんど常に変換中のままにするので、
// それでは文字があるのに送れない。入力欄の値をそのまま使う
function onTextInput(ev: Event) {
	text.value = (ev.target as HTMLTextAreaElement).value;
}

let composingText = false;

function onCompositionStart() {
	composingText = true;
}

function onCompositionEnd(ev: CompositionEvent) {
	composingText = false;
	onTextInput(ev);
}

// キーボードは変換中の文字を自分でも覚えている。入力欄を空にするだけだと、次の文字を打ったときに送ったはずの文字が戻ってくる。
// フォーカスを外せば変換が確定してキーボードもやり直す。同じ処理の中で戻すので、キーボードは閉じない
function finishComposition() {
	if (!composingText) return;
	textareaEl.value?.blur();
	textareaEl.value?.focus({ preventScroll: true });
}

function getDraftKey() {
	return props.user ? 'user:' + props.user.id : 'room:' + props.room?.id;
}

watch([draftText, files], saveDraft, { deep: true });

function updateAttachment(changed: Misskey.entities.DriveFile, updates: Partial<Pick<Misskey.entities.DriveFile, 'name' | 'isSensitive'>>) {
	files.value = files.value.map(file => file.id === changed.id ? { ...file, ...updates } : file);
}

function detachFile(id: Misskey.entities.DriveFile['id']) {
	files.value = files.value.filter(file => file.id !== id);
}

function alertTooManyFiles() {
	os.alert({ type: 'error', text: i18n.tsx._chat.tooManyFiles({ max: MAX_FILES }) });
}

function attachFiles(added: Misskey.entities.DriveFile[]) {
	const merged = [...files.value, ...added.filter(file => !files.value.some(attached => attached.id === file.id))];
	if (merged.length > MAX_FILES) alertTooManyFiles();
	files.value = merged.slice(0, MAX_FILES);
}

async function uploadFiles(uploading: File[]) {
	if (props.editingMessage || uploading.length === 0) return;
	const session = editSession;
	if (files.value.length + uploading.length > MAX_FILES) {
		alertTooManyFiles();
		return;
	}
	try {
		const uploaded = await os.launchUploader(uploading, { multiple: true });
		if (!props.editingMessage && session === editSession) attachFiles(uploaded);
	} catch {
		// Closing the uploader leaves the existing draft attachment intact.
	}
}

async function onPaste(ev: ClipboardEvent) {
	if (!ev.clipboardData) return;
	const pasted = Array.from(ev.clipboardData.items).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((item): item is File => item != null);
	if (pasted.length === 0) pasted.push(...Array.from(ev.clipboardData.files));
	if (pasted.length === 0) return;
	// Office の表のように、文字と一緒にその見た目の画像も入れるアプリがある。文字があれば文字を貼る。
	// ブラウザで画像をコピーしたときに一緒に入る URL だけのときや、Finder などでファイルをコピーしたときに一緒に入るファイル名だけのときは、ファイルを添付する
	const pastedText = ev.clipboardData.getData('text/plain').trim();
	const fileNames = new Set(pasted.map(file => file.name));
	const isOnlyFileNames = pastedText.split(/\r\n|\r|\n/).map(line => line.trim()).filter(line => line !== '').every(line => fileNames.has(line));
	if (pastedText !== '' && !/^\S+:\/\/\S+$/.test(pastedText) && !isOnlyFileNames) return;
	ev.preventDefault();
	if (props.editingMessage) return;
	if (pasted.length === 1) {
		const pastedFile = pasted[0];
		const lio = pastedFile.name.lastIndexOf('.');
		const ext = lio >= 0 ? pastedFile.name.slice(lio) : '';
		const formattedName = formatTimeString(new Date(pastedFile.lastModified), 'yyyy-MM-dd HH-mm-ss [1]') + ext;
		await uploadFiles([new File([pastedFile], formattedName, { type: pastedFile.type })]);
	} else {
		await uploadFiles(pasted);
	}
}

function onDragover(ev: DragEvent) {
	if (!ev.dataTransfer) return;
	if (props.editingMessage) {
		ev.preventDefault();
		ev.dataTransfer.dropEffect = 'none';
		return;
	}

	const isFile = Array.from(ev.dataTransfer.types).includes('Files') || Array.from(ev.dataTransfer.items).some(item => item.kind === 'file');
	if (isFile || checkDragDataType(ev, ['driveFiles'])) {
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
	if (props.editingMessage) {
		ev.preventDefault();
		return;
	}
	if (ev.dataTransfer.files.length > 0) {
		ev.preventDefault();
		await uploadFiles(Array.from(ev.dataTransfer.files));
		return;
	}
	const droppedData = getDragData(ev, 'driveFiles');
	if (droppedData == null) return;
	ev.preventDefault();
	attachFiles(droppedData);
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
	if (props.editingMessage) return;
	const session = editSession;
	selectFile({
		anchorElement: ev.currentTarget ?? ev.target,
		multiple: true,
		label: i18n.ts.selectFile,
	}).then(selected => {
		if (!props.editingMessage && session === editSession) attachFiles(selected);
	});
}

function onChangeFile() {
	if (fileEl.value?.files) void uploadFiles(Array.from(fileEl.value.files));
}

function showSendError(err: Error) {
	console.error(err);
	// フォームが無くなったのはルームが閉じたときで、その理由は別に知らせている
	if (!formClosed) os.alert({ type: 'error', title: i18n.ts.somethingHappened, text: chatErrorText(err) });
}

// 押しただけで入力欄からフォーカスが移ると、ソフトウェアキーボードが閉じて続けて書けなくなる。
// 入力欄にフォーカスが無ければ何もしない (キーボードを新しく出さない)
function keepTextareaFocus(ev: MouseEvent) {
	if (window.document.activeElement === textareaEl.value) ev.preventDefault();
}

function send() {
	if (sending.value || !canSend.value) return;

	finishComposition();
	// 確定で文字が変わることがある
	if (!canSend.value) return;

	sending.value = true;

	if (props.editingMessage) {
		const session = editSession;
		misskeyApi('chat/messages/update', {
			messageId: props.editingMessage.id,
			text: text.value,
		}).then(() => {
			if (session === editSession) emit('edited');
		}).catch(err => {
			showSendError(err);
		}).then(() => {
			sending.value = false;
		});
		return;
	}

	if (props.user) {
		misskeyApi('chat/messages/create-to-user', {
			toUserId: props.user.id,
			text: text.value ? text.value : undefined,
			fileIds: files.value.length > 0 ? files.value.map(file => file.id) : undefined,
		}).then(message => {
			clear();
			emit('sent', message.id);
		}).catch(err => {
			showSendError(err);
		}).then(() => {
			sending.value = false;
		});
	} else if (props.room) {
		misskeyApi('chat/messages/create-to-room', {
			toRoomId: props.room.id,
			text: text.value ? text.value : undefined,
			fileIds: files.value.length > 0 ? files.value.map(file => file.id) : undefined,
		}).then(message => {
			clear();
			emit('sent', message.id);
		}).catch(err => {
			showSendError(err);
		}).then(() => {
			sending.value = false;
		});
	}
}

function clear() {
	draftText.value = '';
	files.value = [];
	deleteDraft();
}

function saveDraft() {
	const drafts = JSON.parse(miLocalStorage.getItem('chatMessageDrafts') || '{}');

	drafts[getDraftKey()] = {
		updatedAt: new Date(),
		data: {
			text: draftText.value,
			files: files.value,
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
			nextTick(() => textareaEl.value?.focus());
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
		draftText.value = draft.data.text;
		// A draft saved when a message could have one file keeps it under `file`.
		files.value = draft.data.files ?? (draft.data.file != null ? [draft.data.file] : []);
	}
});

let formClosed = false;
onBeforeUnmount(() => {
	formClosed = true;
	editSession++;
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

.editing {
	padding: 8px 16px 0;
	font-size: 85%;
	color: var(--MI_THEME-accent);
}

.textarea {
	cursor: auto;
	display: block;
	width: 100%;
	min-width: 100%;
	max-width: 100%;
	min-height: 80px;
	// 長く書いても、読んでいるメッセージとボタンが見えるようにする
	max-height: min(40vh, 240px);
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

	&:not(:disabled, [aria-disabled="true"]):hover {
		color: var(--MI_THEME-accent);
	}

	&:disabled,
	&[aria-disabled="true"] {
		opacity: 0.5;
		cursor: default;
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

.remaining {
	align-self: center;
	margin-left: auto;
	padding: 0 4px;
	font-size: 0.9em;
	opacity: 0.7;

	&.overLimit {
		color: var(--MI_THEME-error);
		opacity: 1;
	}

	& + .send {
		margin-left: 0;
	}
}
</style>
