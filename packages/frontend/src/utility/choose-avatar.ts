/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as os from '@/os.js';
import { chooseDriveFile } from '@/utility/drive.js';
import { i18n } from '@/i18n.js';

export function chooseAvatar(anchor: EventTarget | null, currentId: string | null, save: (id: string | null) => Promise<unknown>) {
	os.popupMenu([{
		text: i18n.ts.avatar,
		type: 'label',
	}, {
		text: i18n.ts.upload,
		icon: 'ti ti-upload',
		action: async () => {
			const files = await os.chooseFileFromPc({ multiple: false });
			const file = files[0];

			let originalOrCropped = file;

			const { canceled } = await os.confirm({
				type: 'question',
				text: i18n.ts.cropImageAsk,
				okText: i18n.ts.cropYes,
				cancelText: i18n.ts.cropNo,
			});

			if (!canceled) {
				originalOrCropped = await os.cropImageFile(file, {
					aspectRatio: 1,
				});
			}

			const driveFile = (await os.launchUploader([originalOrCropped], { multiple: false }))[0];
			save(driveFile.id);
		},
	}, {
		text: i18n.ts.fromDrive,
		icon: 'ti ti-cloud',
		action: () => {
			chooseDriveFile({ multiple: false, excludeSensitive: true }).then(files => {
				save(files[0].id);
			});
		},
	}, ...(currentId != null ? [
			{ type: 'divider' as const },
			{
				type: 'button' as const,
				text: i18n.ts.detach,
				icon: 'ti ti-circle-x',
				action: () => { void save(null); },
			},
		] : [])], anchor);
}
