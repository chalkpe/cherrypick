import type { Field } from './field.js';

export interface Source {
	privacy: string | null
	sensitive: boolean | null
	language: string | null
	note: string
	fields: Array<Field>
	follow_requests_count?: number
}
