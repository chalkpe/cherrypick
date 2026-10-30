<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<!-- PC ではチャットの入力欄へ、モバイルでは画面上端へ移す。どちらも無ければその場 (画面下に浮かせる) に出す -->
<Teleport :to="placement.target" :disabled="placement.target == null">
<div
	v-if="voiceCall.room != null && !voiceCallBarHidden"
	:class="[$style.root, $style[placement.variant], { _panel: floating, _shadow: floating }]"
	:style="floating ? { zIndex } : undefined"
	role="region" :aria-label="i18n.ts._voiceCall.inCall"
>
	<!-- 通話中のルームの名前は出さず、状態 (通話中・接続中など) だけを出す -->
	<MkA v-tooltip="i18n.ts._voiceCall.backToRoom" :to="`/chat/room/${voiceCall.room.id}`" :class="$style.room" :aria-label="i18n.ts._voiceCall.backToRoom">
		<i v-tooltip="micSpeaking ? i18n.ts._voiceCall.micInputDetected : voiceCall.micEnabled ? i18n.ts._voiceCall.micOn : i18n.ts._voiceCall.micMuted" :class="[voiceCall.micEnabled ? 'ti ti-microphone' : 'ti ti-microphone-off', $style.roomIcon, { [$style.speaking]: micSpeaking, [$style.muted]: !voiceCall.micEnabled }]" role="img" :aria-label="micSpeaking ? i18n.ts._voiceCall.micInputDetected : voiceCall.micEnabled ? i18n.ts._voiceCall.micOn : i18n.ts._voiceCall.micMuted"></i>
		<span :class="$style.status" :aria-live="voiceCallStatusAnnouncedInRoom ? 'off' : 'polite'">{{ voiceCallStatusText }}</span>
	</MkA>
	<button v-if="voiceCall.audioBlocked" v-tooltip="i18n.ts._voiceCall.enableAudio" class="_buttonPrimary" :class="$style.enableAudio" :aria-label="i18n.ts._voiceCall.enableAudio" @click="resumeAudio">
		<i class="ti ti-volume"></i>
		<span :class="$style.enableAudioLabel">{{ i18n.ts._voiceCall.enableAudio }}</span>
	</button>
	<div :class="$style.actions">
		<button
			v-tooltip="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute" class="_button"
			:class="[$style.action, { [$style.off]: !voiceCall.micEnabled }]"
			:aria-label="voiceCall.micEnabled ? i18n.ts._voiceCall.mute : i18n.ts._voiceCall.unmute"
			@click="setMicEnabled(!voiceCall.micEnabled)"
		>
			<i v-if="voiceCall.micEnabled" class="ti ti-microphone"></i>
			<i v-else class="ti ti-microphone-off"></i>
		</button>
		<button
			v-tooltip="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen" class="_button"
			:class="[$style.action, { [$style.off]: voiceCall.deafened }]"
			:aria-label="voiceCall.deafened ? i18n.ts._voiceCall.undeafen : i18n.ts._voiceCall.deafen"
			@click="setDeafened(!voiceCall.deafened)"
		>
			<i v-if="voiceCall.deafened" class="ti ti-headphones-off"></i>
			<i v-else class="ti ti-headphones"></i>
		</button>
		<button
			v-if="screenShareAvailable"
			v-tooltip="voiceCall.screenSharing ? i18n.ts._voiceCall.stopSharing : i18n.ts._voiceCall.shareScreen" class="_button"
			:class="[$style.action, { [$style.on]: voiceCall.screenSharing }]"
			:aria-label="voiceCall.screenSharing ? i18n.ts._voiceCall.stopSharing : i18n.ts._voiceCall.shareScreen"
			@click="voiceCall.screenSharing ? stopScreenShare() : startScreenShare()"
		>
			<i v-if="voiceCall.screenSharing" class="ti ti-screen-share-off"></i>
			<i v-else class="ti ti-screen-share"></i>
		</button>
		<button
			v-tooltip="i18n.ts._voiceCall.settings" class="_button"
			:class="$style.action"
			:aria-label="i18n.ts._voiceCall.settings"
			@click="openSettings"
		>
			<i class="ti ti-settings"></i>
		</button>
		<button
			v-tooltip="i18n.ts._voiceCall.leave" class="_button"
			:class="[$style.action, $style.leave]"
			:aria-label="i18n.ts._voiceCall.leave"
			@click="leaveVoiceCall()"
		>
			<i class="ti ti-phone-off"></i>
		</button>
	</div>
</div>
</Teleport>
</template>

<script lang="ts" setup>
import { computed, watch } from 'vue';
import * as os from '@/os.js';
import { i18n } from '@/i18n.js';
import { prefer } from '@/preferences.js';
import { leaveVoiceCall, restartMicrophone, resumeAudio, setDeafened, setMicEnabled, startScreenShare, stopScreenShare, voiceCall } from '@/utility/voice-call.js';
import { voiceCallBarHidden, voiceCallBarPlacement as placement } from '@/utility/voice-call-placement.js';
import { openVoiceCallSettings as openSettings, screenShareAvailable } from '@/utility/voice-call-settings.js';
import { voiceCallStatusAnnouncedInRoom, voiceCallStatusText } from '@/utility/voice-call-status.js';

const micSpeaking = computed(() => voiceCall.status === 'connected' && voiceCall.micEnabled && voiceCall.localSpeaking);

const zIndex = os.claimZIndex('middle');

const floating = computed(() => placement.value.variant === 'floating');

// 音声処理の設定はマイクを入れ直したときに反映されるので、通話中に変えたら入れ直す
// prefer.s はリアクティブではないので、変更を追える prefer.r を見る
watch(() => [
	prefer.r['voiceCall.echoCancellation'].value,
	prefer.r['voiceCall.noiseSuppression'].value,
	prefer.r['voiceCall.autoGainControl'].value,
], async () => {
	await restartMicrophone();
});
</script>

<style lang="scss" module>
.root {
	display: flex;
	align-items: center;
	gap: 8px;
}

// どこにも収まらないときは画面下中央に浮かせる
.floating {
	position: fixed;
	left: 50%;
	bottom: calc(var(--MI-minBottomSpacing) + var(--MI-margin));
	transform: translateX(-50%);
	flex-wrap: wrap;
	max-width: calc(100% - (var(--MI-margin) * 2));
	padding: 8px 10px;
}

// PC: チャットの入力欄の下、絵文字ボタンと送信ボタンの間に 1 行で収める
.docked {
	flex: 1;
	min-width: 0;
	box-sizing: border-box;
	height: 34px;
	padding: 0 3px;
	gap: 6px;
	// 収まりきらないときは左側からはみ出させる。退出ボタンは右端にあるので最後まで切れない
	justify-content: flex-end;
	overflow: hidden; // 極端に狭くても送信ボタンに重ならないようにする
	border-radius: 999px;
	background: var(--MI_THEME-panelHighlight);
}

// 入力欄では差し込み先の幅に合わせて文言だけを隠す。ルームへ戻るアイコンは残す。
// ボタンも収まらない幅では入力欄に置かない (voice-call-placement.ts の MIN_DOCKED_SLOT_WIDTH)
@container (max-width: 259px) {
	// 文言は見た目だけ隠し、接続中・再接続中に変わったことは読み上げられるようにする (display: none だと読み上げからも消える)
	.docked .status {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: -1px;
		padding: 0;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		clip-path: inset(50%);
		white-space: nowrap;
		border: 0;
	}
}

// モバイル: 画面上端に全幅で置き、ページの中身を下へ押し下げる
.top {
	box-sizing: border-box;
	width: 100%;
	padding: 6px 10px;
	background: var(--MI_THEME-panel);
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.room {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 16px;
	flex-shrink: 0;
	color: inherit;
	text-decoration: none;

	.docked &,
	.top & {
		flex: 1;
	}

	// 狭いときはボタンより先に縮む
	.docked & {
		overflow: hidden;
	}
}

.roomIcon {
	flex-shrink: 0;
	color: var(--MI_THEME-fg);
	&.speaking { color: var(--MI_THEME-success); }
	&.muted { color: var(--MI_THEME-error); }
}

.status {
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	font-weight: bold;
	font-size: 0.9em;

	.docked & {
		font-size: 0.85em;
	}
}

.enableAudio {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 4px;
	flex-shrink: 0;
	min-width: 28px;
	box-sizing: border-box;
	padding: 6px 12px;
	border-radius: 999px;
	font-size: 0.85em;

	// 音声再生の操作は狭いときも縮めない。入力欄ではアイコンだけにして幅を確保する
	.docked &,
	.top & {
		flex-shrink: 0;
		min-width: 28px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.docked & {
		width: 28px;
		height: 28px;
		padding: 0;
	}
}

// 入力欄では音声再生にも操作ボタンと同じ幅を確保し、文言はアクセシブル名に残す。
.docked .enableAudioLabel {
	display: none;
}

.actions {
	display: flex;
	flex-shrink: 0;
	align-items: center;
	gap: 4px;
}

.action {
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	border-radius: 100%;
	background: var(--MI_THEME-buttonBg);

	// 幅は voice-call-placement.ts の MIN_DOCKED_SLOT_WIDTH と合わせる
	.docked & {
		width: 28px;
		height: 28px;
	}

	.top & {
		width: 32px;
		height: 32px;
	}

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}

	&.off {
		color: var(--MI_THEME-error);
	}

	&.on {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-accent);
	}

	&.leave {
		color: var(--MI_THEME-fgOnAccent);
		background: var(--MI_THEME-error);
	}
}
</style>
