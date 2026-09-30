import type { Account } from './account.js';
import type { Status } from './status.js';

export interface Notification {
	account: Account
	created_at: string
	id: string
	status?: Status
	type: NotificationType
	// Reaction notifications, as Pleroma / Akkoma send them
	emoji?: string
	emoji_url?: string | null
}

export type NotificationType = string
