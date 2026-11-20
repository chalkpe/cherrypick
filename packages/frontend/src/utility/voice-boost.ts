/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// 通話の音を 100% より大きくして鳴らす。
// audio 要素の volume は 1 までしか受け付けないので、100% を超えたトラックだけを
// MediaStreamAudioSourceNode → GainNode → MediaStreamAudioDestinationNode に通し、
// 出てきたストリームを専用の audio 要素で鳴らす。専用の audio 要素の setSinkId で出力先を選ぶので、
// AudioContext.setSinkId の無いブラウザ (Firefox など) でも出力装置を選べる。
// audio 要素に setSinkId が無いブラウザ (Safari) は出力装置を選べないので、要素を挟まず AudioContext の出力にそのまま繋ぐ
// (MediaStreamAudioDestinationNode の音を audio 要素で鳴らす経路が鳴らない WebKit があるため)。
// LiveKit の webAudioMix は使わない (有効にすると、それらのブラウザで出力装置の切り替えが例外になる)。
// 100% 以下に戻したら、ここで作ったものはすべて片付ける。

export const MAX_VOLUME = 2;

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
	/** 自動再生の制限で鳴らせない状態が変わったときに呼ばれる */
	onBlockedChange?: (blocked: boolean) => void;
	createContext?: () => AudioContext;
	createElement?: () => HTMLAudioElement;
	/** 増幅した音を audio 要素で鳴らすか。省略時は、要素で出力装置を選べるブラウザなら true */
	useElement?: boolean;
};

export class VoiceBoost {
	private context: AudioContext | null = null;
	private playbacks = new Map<BoostableTrack, Playback>();
	private sinkId = '';
	private lastBlocked = false;
	private disposed = false;

	constructor(private options: VoiceBoostOptions = {}) {}

	/** 100% を超える音量で鳴らしている (止められている場合も含む) トラックがあるか */
	get active(): boolean {
		return this.playbacks.size > 0;
	}

	/** 増幅した音が、自動再生の制限で鳴らせていないか */
	get blocked(): boolean {
		if (this.playbacks.size === 0) return false;
		if (this.context?.state === 'suspended') return true;
		for (const playback of this.playbacks.values()) if (playback.playBlocked) return true;
		return false;
	}

	isBoosted(track: BoostableTrack): boolean {
		return this.playbacks.has(track);
	}

	/**
	 * トラックの増幅率を決める。1 を超えれば増幅して鳴らし、そうでなければ増幅を片付ける。
	 * 増幅しているあいだ、呼び出し側は元の再生経路 (audio 要素の volume) を 0 にしておくこと。
	 */
	set(track: BoostableTrack, gain: number): void {
		if (this.disposed) return;
		if (!(gain > 1)) {
			this.release(track);
			return;
		}
		const value = Math.min(MAX_VOLUME, gain);
		const existing = this.playbacks.get(track);
		if (existing != null) {
			existing.gain.gain.value = value;
			return;
		}
		const context = this.ensureContext();
		if (context == null) return;
		const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
		const gainNode = context.createGain();
		gainNode.gain.value = value;
		source.connect(gainNode);
		let destination: MediaStreamAudioDestinationNode | null = null;
		let element: HTMLAudioElement | null = null;
		if (this.usesElement()) {
			destination = context.createMediaStreamDestination();
			gainNode.connect(destination);
			element = (this.options.createElement ?? (() => new Audio()))();
			element.srcObject = destination.stream;
		} else {
			gainNode.connect(context.destination);
		}
		const playback: Playback = { source, gain: gainNode, destination, element, playBlocked: false };
		this.playbacks.set(track, playback);
		if (element != null) {
			void this.applySink(element);
			void this.play(playback, element);
		}
		this.notify();
	}

	release(track: BoostableTrack): void {
		const playback = this.playbacks.get(track);
		if (playback == null) return;
		this.playbacks.delete(track);
		this.teardown(playback);
		if (this.playbacks.size === 0) this.closeContext();
		this.notify();
	}

	/** 増幅した音の出力先を切り替える。空文字はブラウザの既定の装置 */
	async setSinkId(deviceId: string): Promise<void> {
		if (deviceId === this.sinkId) return;
		this.sinkId = deviceId;
		await Promise.all([...this.playbacks.values()].map(playback => playback.element != null ? this.applySink(playback.element) : undefined));
	}

	/** ユーザー操作のあとで、止められていた増幅経路を再開する */
	async resume(): Promise<void> {
		if (this.disposed) return;
		await this.context?.resume().catch(() => {});
		await Promise.all([...this.playbacks.values()].map(playback => playback.element != null ? this.play(playback, playback.element) : undefined));
		this.notify();
	}

	/** 通話の終わりなどで、作ったものをすべて片付ける */
	dispose(): void {
		this.disposed = true;
		for (const playback of this.playbacks.values()) this.teardown(playback);
		this.playbacks.clear();
		this.closeContext();
		this.notify();
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

	private onStateChange = () => {
		// 閉じたあとの変化は、片付けの途中なので見ない
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

	private async applySink(element: HTMLAudioElement): Promise<void> {
		const target = element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
		if (typeof target.setSinkId !== 'function') return;
		await target.setSinkId(this.sinkId).catch(() => {});
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
