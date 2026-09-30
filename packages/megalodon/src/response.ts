export type Response<T = any> = {
  data: T
  status: number
  statusText: string
  headers: any
}

/**
 * Response of a list that Misskey paginates by records other than the returned entities,
 * such as the follow relations behind a follower list.
 */
export type PagedResponse<T = any> = Response<T> & {
  /** IDs of those records in the same order as data, for building pagination links */
  pageIds: Array<string>
}
