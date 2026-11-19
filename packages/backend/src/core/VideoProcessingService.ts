/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import FFmpeg from 'fluent-ffmpeg';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { ImageProcessingService } from '@/core/ImageProcessingService.js';
import type { IImage } from '@/core/ImageProcessingService.js';
import { createTempDir } from '@/misc/create-temp.js';
import { ffmpegLocalInputOptions } from '@/misc/ffmpeg-local-input.js';
import { bindThis } from '@/decorators.js';
import { appendQuery, query } from '@/misc/prelude/url.js';

@Injectable()
export class VideoProcessingService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		private imageProcessingService: ImageProcessingService,
	) {
	}

	@bindThis
	public async generateVideoThumbnail(source: string): Promise<IImage> {
		const [dir, cleanup] = await createTempDir();

		try {
			const command = FFmpeg({ source }).inputOptions(ffmpegLocalInputOptions);
			// 비율로 시각을 지정하면 fluent-ffmpeg가 입력 옵션 없이 ffprobe를 실행한다.
			const metadata = await new Promise<FFmpeg.FfprobeData>((resolve, reject) => {
				command.ffprobe(0, ffmpegLocalInputOptions, (error, data) => {
					if (error) reject(error);
					else resolve(data);
				});
			});
			const resolution = (stream: FFmpeg.FfprobeStream) => (stream.width ?? 0) * (stream.height ?? 0);
			const video = metadata.streams
				.filter(stream => stream.codec_type === 'video' && resolution(stream) > 0)
				.sort((a, b) => resolution(b) - resolution(a))[0];
			if (!video) throw new Error('No video stream in input');

			const streamDuration = Number(video.duration);
			const duration = Number.isFinite(streamDuration) ? streamDuration : Number(metadata.format.duration);
			if (!Number.isFinite(duration)) throw new Error('Could not get input duration');

			await new Promise((res, rej) => {
				command
					.on('end', res)
					.on('error', rej)
					.screenshot({
						folder: dir,
						filename: 'out.png',	// must have .png extension
						count: 1,
						timestamps: [duration * 0.05],
					});
			});

			return await this.imageProcessingService.convertToWebp(`${dir}/out.png`, 498, 422);
		} finally {
			cleanup();
		}
	}

	@bindThis
	public getExternalVideoThumbnailUrl(url: string): string | null {
		if (this.config.videoThumbnailGenerator == null) return null;

		return appendQuery(
			`${this.config.videoThumbnailGenerator}/thumbnail.webp`,
			query({
				thumbnail: '1',
				url,
			}),
		);
	}
}

