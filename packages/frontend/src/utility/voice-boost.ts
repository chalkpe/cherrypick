/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 통화의 소리를 audio 요소의 volume으로는 낼 수 없는 크기로 재생한다.
// audio 요소의 volume은 1까지만 받고, iPhone·iPad에서는 아예 쓸 수 없다 (값을 써도 곧 1로 돌아간다).
// 그래서 100%가 아닌 트랙은 (iPhone·iPad) 또는 100%를 넘는 트랙은 (그 밖의 브라우저)
// MediaStreamAudioSourceNode → GainNode → MediaStreamAudioDestinationNode로 보내고,
// 나온 스트림을 전용 audio 요소로 재생한다. 출력 장치는 이 요소의 setSinkId로 고르므로
// AudioContext.setSinkId가 없는 브라우저(Firefox 등)에서도 출력 장치를 고를 수 있다.
// LiveKit이 출력 장치 선택을 지원하지 않는 브라우저(Safari 계열)는 출력 장치를 고를 수 없으므로 요소를 거치지 않고 AudioContext의 출력에 바로 연결한다
// (MediaStreamAudioDestinationNode의 소리를 audio 요소로 재생하는 경로가 울리지 않는 WebKit이 있기 때문이다).
// LiveKit의 webAudioMix는 쓰지 않는다 (켜면 그 브라우저들에서 출력 장치 전환이 예외가 된다).
// AudioContext는 통화가 끝날 때까지 하나만 유지하고, 증폭하는 트랙이 없는 채로 잠시 지나면 멈춰 둔다.
// 마지막 트랙을 풀어도 바로 멈추지 않는다. Firefox·WebKit은 suspend()가 끝난 뒤에야 state가 바뀌므로,
// 곧바로 다시 증폭하면 state가 아직 running으로 보여 resume()을 건너뛰고 컨텍스트가 멈춘 채 남을 수 있다.
// 그래서 새 재생을 만들 때와 prepare()에서는 state를 보지 않고 항상 resume()을 부른다.
// 100%로 되돌린 트랙의 노드와 요소는 바로 정리한다.
// 호출하는 쪽은 isReady가 true가 된 트랙만 원래 재생 경로를 끈다 (이 경로가 아직 소리를 못 내는데 원래 소리까지 끄지 않도록).
// 소리가 출력에 닿을 시간을 기다리는 브라우저에서는 새 재생의 gain을 0으로 시작하고, 요소가 재생을 시작하는 순간
// (요소를 쓰지 않으면 컨텍스트가 running이 되는 순간) 목표값으로 올린 뒤 settleDelayMs가 지나야 준비된 것으로 알린다.
// 원래 경로가 꺼지기 전에 두 소리가 겹쳐 커지지 않게 하기 위해서다.
// 기다리지 않는 브라우저에서는 원래 경로를 끄는 순간 바로 이 경로가 소리를 내야 하므로 gain을 처음부터 목표값으로 둔다.
// 대신 이 경로가 소리를 내기 시작한 때부터 재생 시작을 알기까지 두 소리가 잠깐 겹칠 수 있다.

export const MAX_VOLUME = 2;

// 슬라이더를 움직일 때 gain이 계단처럼 바뀌지 않도록, 목표값을 향해 이 시간 상수로 따라간다 (LiveKit과 같은 값)
const GAIN_TIME_CONSTANT = 0.1;

// 재생이 시작되어 원래 요소와 바뀔 때의 올림은 짧게 한다. 원래 요소는 한 번에 꺼지므로 길게 올리면 그동안 소리가 작아진다
const READY_TIME_CONSTANT = 0.005;

// Chromium의 요소 경로는 증폭한 소리가 스피커에 닿는 데 원래 요소보다 시간이 더 걸린다.
// 증폭 경로가 재생을 시작한 뒤 이만큼 지나야 준비된 것으로 보고, 그 사이에는 원래 요소가 계속 소리를 낸다. 원래 요소를 바로 끄면 그 사이가 무음이 된다
export const SETTLE_DELAY_MS = 100;

// 증폭 경로를 풀 때, 원래 요소가 돌아와 소리를 내기 시작할 때까지 증폭 경로를 이만큼 더 유지한다
export const HANDOVER_DELAY_MS = 40;

// 새 AudioContext가 suspended로 시작해도 이 시간 안에 running이 되면 자동 재생 제한으로 보지 않는다 (Firefox 등은 허용된 경우에도 잠시 suspended로 시작한다)
export const WAKE_GRACE_MS = 1000;

// 증폭 경로가 없어도 AudioContext를 깨워 둔 채로 두는 시간. 이 시간 안에 증폭할 트랙이 생기지 않으면 멈춘다
const IDLE_SUSPEND_MS = 3000;

/** LiveKit의 getBrowser()가 돌려주는 값 중 이 모듈이 보는 것 */
export type BrowserInfo = {
	name?: string;
	os?: string;
};

export type VoicePlatform = {
	/** iPhone·iPad(iPadOS의 데스크톱 UA 포함)인지. 이 기기에서는 어느 브라우저든 audio 요소의 volume을 쓸 수 없다 */
	appleMobile: boolean;
	/** 소리를 내려면 사용자 조작 안에서 AudioContext를 깨워야 하는 브라우저인지 */
	needsGestureToStartAudio: boolean;
	/** 두 재생 경로를 바꿀 때 기다릴 시간. Chromium에서만 0이 아니다 */
	settleDelayMs: number;
	handoverDelayMs: number;
};

/**
 * LiveKit의 getBrowser() 결과와 터치 지점 수로 브라우저 계열을 한 번에 판정한다.
 * - appleMobile: iOS의 모든 브라우저, 또는 맥과 같은 UA를 보내는 iPadOS의 Safari (맥의 Safari는 터치 지점이 0이므로 둘 이상이면 iPadOS로 본다. LiveKit의 isIPadOS와 같은 기준).
 * - needsGestureToStartAudio: WebKit 계열(Safari, iPhone·iPad의 모든 브라우저)은 조작 중에 시작한 재생만 허용한다.
 *   Chromium·Firefox는 페이지에 사용자 활성화가 한 번 있으면 조작 밖에서도 컨텍스트를 시작할 수 있으므로 미리 깨울 필요가 없다.
 * - 대기: Chromium(iOS 제외)만 경로 사이의 지연 차이가 커서 기다린다. Firefox 등은 지연 차이가 작아 기다리면 두 소리가 겹쳐 오히려 커진다.
 * 판정하지 못하면(undefined) 모두 가장 보수적인 값(기다리지 않고 미리 깨우지 않음)이다.
 */
export function detectPlatform(browser: BrowserInfo | undefined, maxTouchPoints = 0): VoicePlatform {
	const safari = browser?.name === 'Safari';
	const appleMobile = browser?.os === 'iOS' || (safari && browser?.os === 'macOS' && maxTouchPoints > 1);
	const chromium = browser?.name === 'Chrome' && browser.os !== 'iOS';
	return {
		appleMobile,
		needsGestureToStartAudio: appleMobile || safari,
		settleDelayMs: chromium ? SETTLE_DELAY_MS : 0,
		handoverDelayMs: chromium ? HANDOVER_DELAY_MS : 0,
	};
}

export type BoostableTrack = {
	readonly mediaStreamTrack: MediaStreamTrack;
};

type Playback = {
	source: MediaStreamAudioSourceNode;
	gain: GainNode;
	destination: MediaStreamAudioDestinationNode | null;
	element: HTMLAudioElement | null;
	playBlocked: boolean;
	/** 출력 장치를 이 요소에 적용하지 못했는지. 같은 장치를 다시 고르면 다시 시도한다 */
	sinkFailed: boolean;
	/** 브라우저가 멈춘 요소를 다시 재생해 본 적이 있는지. 사용자 조작(resume)으로 풀린다 */
	replayed: boolean;
	/** 요소의 재생이 시작되었는지. 요소를 쓰지 않는 경로에서는 쓰지 않는다 */
	playing: boolean;
	/** 재생이 시작되었을 때 gain을 올릴 목표값 */
	target: number;
	/** gain이 향하고 있는 값. 아직 올린 적이 없으면 null (기다리지 않는 브라우저는 처음부터 목표값) */
	raisedTo: number | null;
	/** 재생을 시작한 뒤 settleDelayMs가 지나 원래 경로를 꺼도 되는지 */
	settled: boolean;
	settleTimer: number | null;
	/** 원래 경로가 돌아왔고, 증폭 경로를 곧 풀 예정인지 */
	releasing: boolean;
	releaseTimer: number | null;
	/** 요소의 pause·playing 처리기를 한꺼번에 떼기 위한 것 */
	listeners: AbortController;
};

/** 요소를 쓰지 않는 경로에서 미디어 재생 범주를 유지하기 위한, 소리 없는 스트림의 재생 */
type KeepAlive = {
	destination: MediaStreamAudioDestinationNode;
	element: HTMLAudioElement;
};

export type VoiceBoostOptions = {
	/** 자동 재생 제한으로 소리를 낼 수 없는 상태가 바뀔 때 호출된다 */
	onBlockedChange?: (blocked: boolean) => void;
	/** 증폭 경로가 소리를 낼 수 있는 트랙이 바뀔 때 호출된다 */
	onReadyChange?: () => void;
	createContext?: () => AudioContext;
	createElement?: () => HTMLAudioElement;
	/** 증폭한 소리를 audio 요소로 재생할지 (LiveKit이 출력 장치 선택을 지원하는 브라우저에서 true). 생략하면 요소 없이 바로 출력한다 */
	useElement?: boolean;
	/**
	 * 증폭 경로로 재생하는 트랙이 있는 동안, 소리 없는 스트림을 muted 없이 재생하는 요소를 하나 둔다 (iPhone·iPad에서 true).
	 * Web Audio만 소리를 내면 WebKit이 주변음 범주를 골라 무음 스위치를 따르므로, 원래 요소가 소리를 낼 때와 같은 미디어 재생 범주를 유지한다.
	 */
	keepMediaCategory?: boolean;
	/** 증폭 경로가 재생을 시작한 뒤 원래 경로를 꺼도 되기까지 기다릴 시간 (ms). 생략하면 기다리지 않는다. Chromium 외에는 0이다 */
	settleDelayMs?: number;
};

export class VoiceBoost {
	private context: AudioContext | null = null;
	private playbacks = new Map<BoostableTrack, Playback>();
	private sinkId = '';
	private lastBlocked = false;
	private lastReady = new Set<BoostableTrack>();
	private lastStarted = new Set<BoostableTrack>();
	private idleTimer: number | null = null;
	// 컨텍스트를 깨우는 중인지. 이 동안은 suspended를 막힘으로 보지 않는다
	private waking = false;
	private wakeTimer: number | null = null;
	private keepAlive: KeepAlive | null = null;
	private disposed = false;

	constructor(private options: VoiceBoostOptions = {}) {}

	/** 증폭 경로로 재생 중인 (멈춰 있는 경우도 포함) 트랙이 있는지 */
	get active(): boolean {
		return this.playbacks.size > 0;
	}

	/** 증폭한 소리가 자동 재생 제한 때문에 나지 않고 있는지. 증폭할 트랙이 없어 멈춰 둔 상태는 포함하지 않는다 */
	get blocked(): boolean {
		if (this.playbacks.size === 0) return false;
		if (this.context?.state === 'suspended' && !this.waking) return true;
		for (const playback of this.playbacks.values()) if (playback.playBlocked) return true;
		return false;
	}

	/**
	 * 이 트랙의 소리를 증폭 경로가 실제로 내고 있는지 (AudioContext가 running이고, 요소를 쓰면 재생이 시작되었으며, 소리가 출력에 닿을 시간이 지났다).
	 * 호출하는 쪽은 true가 된 뒤에 원래 재생 경로를 끈다. 풀 예정인 트랙은 false다.
	 */
	isReady(track: BoostableTrack): boolean {
		const playback = this.playbacks.get(track);
		return playback != null && playback.settled && !playback.releasing && this.isStarted(track);
	}

	// 증폭 경로가 재생을 시작했는지 (아직 소리가 출력에 닿았다고 볼 시간은 지나지 않았을 수 있다)
	private isStarted(track: BoostableTrack): boolean {
		const playback = this.playbacks.get(track);
		if (playback == null || this.context?.state !== 'running' || playback.playBlocked) return false;
		return playback.element == null || playback.playing;
	}

	/**
	 * 사용자 조작 안에서 AudioContext를 만들고 깨운다. 모바일 브라우저는 조작 중에 시작한 재생만 허용하므로,
	 * 호출하는 쪽은 이벤트 처리기 안에서 동기적으로 불러야 한다. 증폭할 트랙이 없으면 잠시 뒤 다시 멈춘다.
	 */
	prepare(): void {
		if (this.disposed) return;
		const context = this.ensureContext();
		if (context == null) return;
		this.wake(context);
		this.startKeepAlive();
		this.scheduleIdleSuspend();
	}

	/**
	 * 트랙의 증폭률을 정한다. 1이 아닌 양수면 증폭 경로로 재생하고, 1이거나 0이면 증폭 경로를 정리한다.
	 * 성공하면 true를 돌려준다. 증폭 경로를 만들지 못하면 false를 돌려주고 아무것도 남기지 않는다.
	 * 호출하는 쪽은 isReady가 true가 된 뒤에 원래 재생 경로를 끄고, false가 오면 원래 재생 경로를 그대로 둔다.
	 */
	set(track: BoostableTrack, gain: number): boolean {
		if (!(gain > 0) || gain === 1) {
			this.release(track);
			return true;
		}
		if (this.disposed) return false;
		const value = Math.min(MAX_VOLUME, gain);
		const existing = this.playbacks.get(track);
		if (existing != null) {
			existing.target = value;
			// 풀려던 재생을 다시 쓴다
			if (existing.releasing) {
				existing.releasing = false;
				if (existing.releaseTimer != null) window.clearTimeout(existing.releaseTimer);
				existing.releaseTimer = null;
				this.notify();
			}
			// 아직 소리를 낼 수 없는 재생은 재생을 시작하는 순간에 이 목표값으로 올라간다.
			// 이미 이 값으로 올리고 있으면 다시 올리지 않는다 (진행 중인 짧은 올림을 느린 올림으로 덮지 않도록)
			if (this.isStarted(track) && existing.raisedTo !== value) this.rampTo(existing);
			return true;
		}
		const playback = this.createPlayback(track, value);
		if (playback == null) return false;
		this.playbacks.set(track, playback);
		if (this.idleTimer != null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
		if (this.context != null) this.wake(this.context);
		this.startKeepAlive();
		const element = playback.element;
		if (element != null) {
			this.watchElement(playback, element);
			void this.applySinkTracked(playback);
			void this.play(playback, element);
		}
		this.notify();
		return true;
	}

	/**
	 * 트랙의 증폭 경로를 푼다. delayMs를 주면 그만큼 뒤에 풀고, 그동안은 준비되지 않은 것으로 본다.
	 * 호출하는 쪽이 원래 경로를 되살린 뒤 증폭 경로를 조금 늦게 풀면, 두 경로가 바뀌는 사이가 무음이 되지 않는다.
	 */
	release(track: BoostableTrack, delayMs = 0): void {
		const playback = this.playbacks.get(track);
		if (playback == null) return;
		if (delayMs > 0) {
			if (playback.releasing) return;
			playback.releasing = true;
			playback.releaseTimer = window.setTimeout(() => {
				playback.releaseTimer = null;
				if (this.playbacks.get(track) === playback) this.release(track);
			}, delayMs);
			this.notify();
			return;
		}
		this.playbacks.delete(track);
		this.teardown(playback);
		// 증폭하는 트랙이 없어도 AudioContext는 닫지 않고, 바로 멈추지도 않는다 (다시 증폭할 때 장치를 다시 열지 않도록, 멈추는 중의 컨텍스트와 겹치지 않도록)
		if (this.playbacks.size === 0) this.scheduleIdleSuspend();
		this.notify();
	}

	/** 증폭한 소리의 출력 장치를 바꾼다. 빈 문자열은 브라우저의 기본 장치 */
	async setSinkId(deviceId: string): Promise<void> {
		if (deviceId === this.sinkId && ![...this.playbacks.values()].some(playback => playback.sinkFailed)) return;
		this.sinkId = deviceId;
		// 적용하지 못한 장치는 같은 ID로 다시 고르면 다시 시도한다. 재생마다 기록하므로 그 사이에 생긴 재생의 실패를 덮지 않는다
		await Promise.all([...this.playbacks.values()].map(playback => this.applySinkTracked(playback)));
	}

	/** 사용자 조작 뒤에, 멈춰 있던 증폭 경로를 다시 시작한다 */
	async resume(): Promise<void> {
		if (this.disposed) return;
		// 소리 없는 요소의 재생은 조작과 같은 동기 구간에서 시작해야 한다 (WebKit은 await 뒤를 조작 밖으로 본다)
		this.startKeepAlive();
		const waking = this.context != null ? this.wake(this.context) : Promise.resolve();
		for (const playback of this.playbacks.values()) playback.replayed = false;
		await waking;
		if (this.disposed) return;
		await Promise.all([...this.playbacks.values()].map(playback => playback.element != null ? this.play(playback, playback.element) : undefined));
		// 증폭할 트랙이 없으면 깨워 둔 컨텍스트를 다시 멈춘다
		if (this.playbacks.size === 0) this.scheduleIdleSuspend();
		this.notify();
	}

	/** 통화가 끝날 때 등에, 만든 것을 모두 정리한다 */
	dispose(): void {
		this.disposed = true;
		if (this.idleTimer != null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.endWake();
		for (const playback of this.playbacks.values()) this.teardown(playback);
		this.playbacks.clear();
		this.discardKeepAlive();
		this.closeContext();
		this.notify();
	}

	private createPlayback(track: BoostableTrack, value: number): Playback | null {
		const context = this.ensureContext();
		if (context == null) return null;
		const created: Array<{ disconnect(): void }> = [];
		let element: HTMLAudioElement | null = null;
		try {
			const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
			created.push(source);
			const gainNode = context.createGain();
			created.push(gainNode);
			// 기다리는 브라우저만 0에서 시작한다. 기다리지 않는 브라우저는 처음부터 목표값이라 준비된 뒤 다시 올리지 않는다
			const waits = (this.options.settleDelayMs ?? 0) > 0;
			gainNode.gain.value = waits ? 0 : value;
			source.connect(gainNode);
			let destination: MediaStreamAudioDestinationNode | null = null;
			if (this.usesElement()) {
				destination = context.createMediaStreamDestination();
				created.push(destination);
				gainNode.connect(destination);
				element = (this.options.createElement ?? (() => new Audio()))();
				element.srcObject = destination.stream;
			} else {
				gainNode.connect(context.destination);
			}
			return { source, gain: gainNode, destination, element, playBlocked: false, sinkFailed: false, replayed: false, playing: false, target: value, raisedTo: waits ? null : value, settled: false, settleTimer: null, releasing: false, releaseTimer: null, listeners: new AbortController() };
		} catch {
			for (const node of created) {
				try {
					node.disconnect();
				} catch {
					// 이미 끊어진 노드는 그대로 둔다
				}
			}
			return null;
		}
	}

	private ensureContext(): AudioContext | null {
		if (this.context != null) return this.context;
		try {
			const context = (this.options.createContext ?? (() => new AudioContext()))();
			context.addEventListener('statechange', this.onStateChange);
			this.context = context;
			return context;
		} catch {
			return null;
		}
	}

	// AudioContext의 상태가 바뀌면 막힘 상태를 다시 계산해서 알린다. closeContext는 먼저 이 리스너를 떼므로, 닫는 도중의 변화는 여기로 오지 않는다
	private onStateChange = () => {
		if (this.context?.state === 'running') this.endWake();
		this.notify();
	};

	private closeContext(): void {
		const context = this.context;
		if (context == null) return;
		this.context = null;
		context.removeEventListener('statechange', this.onStateChange);
		void context.close().catch(() => {});
	}

	private teardown(playback: Playback): void {
		playback.listeners.abort();
		if (playback.settleTimer != null) window.clearTimeout(playback.settleTimer);
		if (playback.releaseTimer != null) window.clearTimeout(playback.releaseTimer);
		playback.settleTimer = null;
		playback.releaseTimer = null;
		playback.element?.pause();
		if (playback.element != null) playback.element.srcObject = null;
		playback.source.disconnect();
		playback.gain.disconnect();
		playback.destination?.disconnect();
	}

	/** 출력 장치를 적용했으면 true. setSinkId가 없는 요소는 적용할 것이 없으므로 true */
	private async applySink(element: HTMLAudioElement): Promise<boolean> {
		const target = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
		if (typeof target.setSinkId !== 'function') return true;
		return target.setSinkId(this.sinkId).then(() => true, () => false);
	}

	// 출력 장치 적용에 실패하면 같은 장치를 다시 골랐을 때 다시 시도하도록 재생마다 기록한다
	private async applySinkTracked(playback: Playback): Promise<void> {
		if (playback.element == null) return;
		playback.sinkFailed = !await this.applySink(playback.element);
	}

	// 브라우저가 요소를 멈추거나 다시 재생하면 준비 상태를 다시 계산한다 (멈춘 요소가 있는데 원래 요소만 꺼진 채 남지 않도록).
	// 멈춘 요소는 한 번 다시 재생해 본다. 거절되거나 다시 재생한 뒤 또 멈추면 막힘으로 두어 소리 켜기가 뜨게 하고, 사용자 조작(resume)이 있기 전에는 다시 시도하지 않는다
	private watchElement(playback: Playback, element: HTMLAudioElement): void {
		const { signal } = playback.listeners;
		element.addEventListener('pause', () => {
			playback.playing = false;
			this.notify();
			if (playback.replayed) {
				playback.playBlocked = true;
				this.notify();
				return;
			}
			playback.replayed = true;
			void this.play(playback, element);
		}, { signal });
		element.addEventListener('playing', () => {
			playback.playBlocked = false;
			playback.playing = true;
			this.notify();
		}, { signal });
	}

	// 처음 올릴 때와 원래 경로가 아직 소리를 내는 동안(settled가 거짓)에는 짧게, 그 뒤의 변경은 슬라이더를 따라가도록 길게 한다.
	// 원래 경로가 소리를 내는 동안 느리게 올리면 그 경로가 꺼진 뒤에도 gain이 덜 올라와 소리가 파인다
	private rampTo(playback: Playback): void {
		const timeConstant = playback.raisedTo == null || !playback.settled ? READY_TIME_CONSTANT : GAIN_TIME_CONSTANT;
		playback.raisedTo = playback.target;
		playback.gain.gain.setTargetAtTime(playback.target, 0, timeConstant);
	}

	// 컨텍스트를 깨운다. suspend()가 끝나기 전에는 state가 running으로 보일 수 있으므로 상태를 보지 않고 resume()을 부른다.
	// 멈춰 있던 컨텍스트는 깨어나는 동안 막힘으로 보지 않고, resume()이 거절되거나 WAKE_GRACE_MS 안에 running이 되지 않을 때만 막힘으로 본다
	private wake(context: AudioContext): Promise<void> {
		if (context.state !== 'running' && !this.waking) {
			this.waking = true;
			this.wakeTimer = window.setTimeout(() => {
				this.wakeTimer = null;
				this.endWake();
			}, WAKE_GRACE_MS);
		}
		return context.resume().then(() => {}, () => this.endWake());
	}

	private endWake(): void {
		if (this.wakeTimer != null) window.clearTimeout(this.wakeTimer);
		this.wakeTimer = null;
		if (!this.waking) return;
		this.waking = false;
		if (!this.disposed) this.notify();
	}

	private scheduleIdleSuspend(): void {
		if (this.idleTimer != null) window.clearTimeout(this.idleTimer);
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null;
			if (this.disposed || this.playbacks.size > 0) return;
			void this.context?.suspend().catch(() => {});
			this.pauseKeepAlive();
		}, IDLE_SUSPEND_MS);
	}

	// 소리 없는 스트림을 muted 없이 재생해서 미디어 재생 범주를 유지한다.
	// 사용자 조작 밖에서 막히면 다음 조작(prepare·resume)에서 다시 시작한다. 거절을 막힘으로 보지 않는 이유는, 무음 모드인지 알 수 없어
	// 무음 모드가 아닌 기기에서도 소리 켜기가 불필요하게 뜨기 때문이다
	private startKeepAlive(): void {
		if (!(this.options.keepMediaCategory ?? false) || this.disposed) return;
		if (this.keepAlive == null) {
			const context = this.ensureContext();
			if (context == null) return;
			try {
				const destination = context.createMediaStreamDestination();
				const element = (this.options.createElement ?? (() => new Audio()))();
				element.srcObject = destination.stream;
				this.keepAlive = { destination, element };
			} catch {
				return;
			}
		}
		void this.keepAlive.element.play().catch(() => {});
	}

	// 증폭할 트랙이 없는 채로 지나면 요소를 멈추기만 한다. 요소는 조작으로 재생 허용을 얻은 것이므로 버리지 않고 다음에 다시 쓴다
	private pauseKeepAlive(): void {
		this.keepAlive?.element.pause();
	}

	private discardKeepAlive(): void {
		const keepAlive = this.keepAlive;
		if (keepAlive == null) return;
		this.keepAlive = null;
		keepAlive.element.pause();
		keepAlive.element.srcObject = null;
		try {
			keepAlive.destination.disconnect();
		} catch {
			// 이미 끊어진 노드는 그대로 둔다
		}
	}

	private usesElement(): boolean {
		return this.options.useElement ?? false;
	}

	private async play(playback: Playback, element: HTMLAudioElement): Promise<void> {
		try {
			await element.play();
			playback.playBlocked = false;
			playback.playing = true;
		} catch {
			playback.playBlocked = true;
			playback.playing = false;
		}
		this.notify();
	}

	private notify(): void {
		const blocked = this.blocked;
		if (blocked !== this.lastBlocked) {
			this.lastBlocked = blocked;
			this.options.onBlockedChange?.(blocked);
		}
		const tracks = [...this.playbacks.keys()];
		const started = new Set(tracks.filter(track => this.isStarted(track)));
		for (const track of tracks) {
			const playback = this.playbacks.get(track)!;
			if (started.has(track)) {
				if (this.lastStarted.has(track)) continue;
				// 재생을 시작한 재생은 호출하는 쪽이 원래 경로를 끄기 전에 목표 gain으로 올리고, 소리가 출력에 닿을 시간을 기다린다.
				// 풀 예정인 재생은 올리지 않는다 (곧 멈추고, 취소되면 set()이 올린다)
				const settleMs = this.options.settleDelayMs ?? 0;
				if (settleMs <= 0) playback.settled = true;
				if (!playback.releasing && playback.raisedTo !== playback.target) this.rampTo(playback);
				if (playback.settleTimer != null) window.clearTimeout(playback.settleTimer);
				if (settleMs <= 0) continue;
				playback.settleTimer = window.setTimeout(() => {
					playback.settleTimer = null;
					playback.settled = true;
					this.notify();
				}, settleMs);
			} else {
				playback.settled = false;
				if (playback.settleTimer != null) window.clearTimeout(playback.settleTimer);
				playback.settleTimer = null;
			}
		}
		this.lastStarted = started;
		const ready = new Set(tracks.filter(track => this.isReady(track)));
		const readyChanged = ready.size !== this.lastReady.size || [...ready].some(track => !this.lastReady.has(track));
		this.lastReady = ready;
		if (readyChanged) this.options.onReadyChange?.();
	}
}
