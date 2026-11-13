export type NoteCleanupDefaultName = 'pinned' | 'favorite' | 'clip' | 'selfReaction' | 'age';
export type NoteCleanupOperator = 'gt' | 'gte' | 'lt' | 'lte';
export type NoteCleanupTarget = 'text' | 'cw' | 'poll' | 'fileComment' | 'fileName';
export type NoteCleanupFlag = 'pinned' | 'favorite' | 'selfReaction' | 'selfRenote' | 'reply' | 'quote' | 'poll' | 'files' | 'cw' | 'localOnly';
export type NoteCleanupCondition =
	{ type: 'all' | 'any'; children: NoteCleanupCondition[] } |
	{ type: 'not'; child: NoteCleanupCondition } |
	{ type: 'keyword'; mode: 'literal' | 'regex'; value: string; flags: string; targets: NoteCleanupTarget[] } |
	{ type: 'age'; operator: NoteCleanupOperator; seconds: number } |
	{ type: 'count'; field: 'reactions' | 'renotes'; operator: NoteCleanupOperator; value: number } |
	{ type: 'flag'; field: NoteCleanupFlag; value: boolean } |
	{ type: 'visibility'; values: string[] } |
	{ type: 'channel'; ids: string[] } |
	{ type: 'clip'; ids: string[] | null } |
	{ type: 'hashtag'; value: string };
