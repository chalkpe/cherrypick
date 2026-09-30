export interface Filter {
	id: string
	phrase: string
	context: Array<FilterContext>
	expires_at: string | null
	irreversible: boolean
	whole_word: boolean
}

export type FilterContext = string

// Filters of the v2 API (Mastodon 4.0+)
export interface FilterV2 {
	id: string
	title: string
	context: Array<FilterContext>
	expires_at: string | null
	filter_action: 'warn' | 'hide' | 'blur'
	keywords: Array<FilterKeyword>
	statuses: Array<FilterStatus>
}

export interface FilterKeyword {
	id: string
	keyword: string
	whole_word: boolean
}

export interface FilterStatus {
	id: string
	status_id: string
}

export interface FilterResult {
	filter: FilterV2
	keyword_matches: Array<string> | null
	status_matches: Array<string> | null
}
