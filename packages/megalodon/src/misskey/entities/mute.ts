import type { UserDetail } from './userDetail.js';

export interface Mute {
	id: string
	createdAt: string
	expiresAt: string | null
	muteeId: string
	mutee: UserDetail
}
