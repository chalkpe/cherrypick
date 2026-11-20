/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 통화의 소리를 100%보다 크게 재생한다.
// audio 요소의 volume은 1까지만 받으므로, 100%를 넘은 트랙만
// MediaStreamAudioSourceNode → GainNode → MediaStreamAudioDestinationNode로 보내고,
// 나온 스트림을 전용 audio 요소로 재생한다. 출력 장치는 이 요소의 setSinkId로 고르므로
// AudioContext.setSinkId가 없는 브라우저(Firefox 등)에서도 출력 장치를 고를 수 있다.
// audio 요소에 setSinkId가 없는 브라우저(Safari)는 출력 장치를 고를 수 없으므로 요소를 거치지 않고 AudioContext의 출력에 바로 연결한다
// (MediaStreamAudioDestinationNode의 소리를 audio 요소로 재생하는 경로가 울리지 않는 WebKit이 있기 때문이다).
// LiveKit의 webAudioMix는 쓰지 않는다 (켜면 그 브라우저들에서 출력 장치 전환이 예외가 된다).
// AudioContext는 통화가 끝날 때까지 하나만 유지하고, 증폭하는 트랙이 없으면 멈춰 둔다.
// 100% 이하로 되돌린 트랙의 노드와 요소는 바로 정리한다.

export const MAX_VOLUME = 2;

// 슬라이더를 움직일 때 gain이 계단처럼 바뀌지 않도록, 목표값을 향해 이 시간 상수로 따라간다 (LiveKit과 같은 값)
const GAIN_TIME_CONSTANT = 0.1;

export type BoostableTrack = {
	readonly mediaStreamTrack: MediaStreamTrack;
};

type Playback = {
	source: MediaStreamAudioSourceNode;
	gain: GainNode;
	destination: MediaStreamAudioDestinationNode | null;
	element: HTMLAudioElement | null;
	playBlocked: boolean;
};

export type VoiceBoostOptions = {
	/** 자동 재생 제한으로 소리를 낼 수 없는 상태가 바뀔 때 호출된다 */
	onBlockedChange?: (blocked: boolean) => void;
	createContext?: () => AudioContext;
	createElement?: () => HTMLAudioElement;
	/** 증폭한 소리를 audio 요소로 재생할지. 생략하면 요소로 출력 장치를 고를 수 있는 브라우저에서 true */
	useElement?: boolean;
};

export class VoiceBoost {
	private context: AudioContext | null = null;
	private playbacks = new Map<BoostableTrack, Playback>();
	private sinkId = '';
	private sinkFailed = false;
	private lastBlocked = false;
	private disposed = false;

	constructor(private options: VoiceBoostOptions = {}) {}

	/** 100%를 넘는 음량으로 재생 중인 (멈춰 있는 경우도 포함) 트랙이 있는지 */
	get active(): boolean {
		return this.playbacks.size > 0;
	}

	/** 증폭한 소리가 자동 재생 제한 때문에 나지 않고 있는지. 증폭할 트랙이 없어 멈춰 둔 상태는 포함하지 않는다 */
	get blocked(): boolean {
		if (this.playbacks.size === 0) return false;
		if (this.context?.state === 'suspended') return true;
		for (const playback of this.playbacks.values()) if (playback.playBlocked) return true;
		return false;
	}

	/**
	 * 트랙의 증폭률을 정한다. 1을 넘으면 증폭해서 재생하고, 아니면 증폭을 정리한다.
	 * 증폭에 성공하면 true를 돌려준다. 증폭 경로를 만들지 못하면 false를 돌려주고 아무것도 남기지 않는다.
	 * 증폭하는 동안 호출하는 쪽은 원래 재생 경로(audio 요소의 volume)를 0으로 두어야 하고, false가 오면 원래 음량으로 되돌려야 한다.
	 */
	set(track: BoostableTrack, gain: number): boolean {
		if (!(gain > 1)) {
			this.release(track);
			return true;
		}
		if (this.disposed) return false;
		const value = Math.min(MAX_VOLUME, gain);
		const existing = this.playbacks.get(track);
		if (existing != null) {
			existing.gain.gain.setTargetAtTime(value, 0, GAIN_TIME_CONSTANT);
			return true;
		}
		const playback = this.createPlayback(track, value);
		if (playback == null) return false;
		this.playbacks.set(track, playback);
		if (this.context?.state === 'suspended') void this.context.resume().catch(() => {});
		if (playback.element != null) {
			void this.applySink(playback.element);
			void this.play(playback, playback.element);
		}
		this.notify();
		return true;
	}

	release(track: BoostableTrack): void {
		const playback = this.playbacks.get(track);
		if (playback == null) return;
		this.playbacks.delete(track);
		this.teardown(playback);
		// 증폭하는 트랙이 없어도 AudioContext는 닫지 않고 멈춰만 둔다 (다시 증폭할 때 장치를 다시 열지 않도록)
		if (this.playbacks.size === 0) void this.context?.suspend().catch(() => {});
		this.notify();
	}

	/** 증폭한 소리의 출력 장치를 바꾼다. 빈 문자열은 브라우저의 기본 장치 */
	async setSinkId(deviceId: string): Promise<void> {
		if (deviceId === this.sinkId && !this.sinkFailed) return;
		this.sinkId = deviceId;
		const results = await Promise.all([...this.playbacks.values()].map(playback => playback.element != null ? this.applySink(playback.element) : true));
		// 적용하지 못한 장치는 같은 ID로 다시 고르면 다시 시도한다
		this.sinkFailed = results.includes(false);
	}

	/** 사용자 조작 뒤에, 멈춰 있던 증폭 경로를 다시 시작한다 */
	async resume(): Promise<void> {
		if (this.disposed) return;
		await this.context?.resume().catch(() => {});
		await Promise.all([...this.playbacks.values()].map(playback => playback.element != null ? this.play(playback, playback.element) : undefined));
		this.notify();
	}

	/** 통화가 끝날 때 등에, 만든 것을 모두 정리한다 */
	dispose(): void {
		this.disposed = true;
		for (const playback of this.playbacks.values()) this.teardown(playback);
		this.playbacks.clear();
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
			gainNode.gain.value = value;
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
			return { source, gain: gainNode, destination, element, playBlocked: false };
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

	private usesElement(): boolean {
		return this.options.useElement ?? (typeof HTMLMediaElement !== 'undefined' && typeof (HTMLMediaElement.prototype as { setSinkId?: unknown }).setSinkId === 'function');
	}

	private async play(playback: Playback, element: HTMLAudioElement): Promise<void> {
		try {
			await element.play();
			playback.playBlocked = false;
		} catch {
			playback.playBlocked = true;
		}
		this.notify();
	}

	private notify(): void {
		const blocked = this.blocked;
		if (blocked === this.lastBlocked) return;
		this.lastBlocked = blocked;
		this.options.onBlockedChange?.(blocked);
	}
}
