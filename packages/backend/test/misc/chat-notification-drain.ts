/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { api, connectStream, randomString, signup } from '../utils.js';

/** Observe a later real notification before the test server is shut down. */
export async function waitForChatNotificationTurn(): Promise<void> {
	const sender = await signup();
	const recipient = await signup();
	const updated = await api('i/update', { chatScope: 'everyone' }, recipient);
	if (updated.status !== 200) throw new Error('could not prepare notification recipient');

	const text = `notification-drain-${randomString()}`;
	let received!: () => void;
	const notification = new Promise<void>(resolve => { received = resolve; });
	const stream = await connectStream(recipient, 'main', message => {
		if (message.type === 'newChatMessage' && message.body?.text === text) received();
	});
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await api('chat/messages/create-to-user', { toUserId: recipient.id, text }, sender);
		if (result.status !== 200) throw new Error('could not send notification marker');
		await Promise.race([
			notification,
			new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('notification marker timed out')), 15_000); }),
		]);
	} finally {
		if (timeout != null) clearTimeout(timeout);
		stream.close();
	}
}
