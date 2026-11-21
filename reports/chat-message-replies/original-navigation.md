# 답장 원문 이동 보고

- 고정 시작 커밋: `89016082667f9de02b4e65fbbc4eac23a2130571`

## 동작
- 불러온 범위의 원문: 기존 타임라인에서 그대로 스크롤하고 강조한다.
- 불러온 범위 안인데 없는 글(보이지 않는 글): 찾지 못했다고 알린다.
- 아직 불러오지 않은 옛 원문: 이전 글 불러오기를 되풀이하지 않고, 같은 대화의 기존 타임라인 조회(`chat/messages/user-timeline`, `chat/messages/room-timeline`)를 최대 2번 호출한다.
  1. `sinceId=원문 id, limit=1`로 원문 바로 다음 글을 찾는다.
  2. 그 글을 `untilId`로 삼아 원문과 그 앞의 글 10개를 받는다.
- 결과는 기존 `XMessage` 표현을 쓰는 원문 보기 창으로 따로 연다. 타임라인에 합치지 않으므로 구멍이 생기지 않고, 입력창·작성 중인 내용·수정 중인 글에 영향이 없다.
- 백엔드·API 정의·SDK 변경 없음 (기존 조회의 사용자·방·채널 권한 검사를 그대로 사용, show 권한 확장 없음). 그래서 `cherrypick-js` 재생성은 해당 없음.
- 삭제되었거나 응답에 없는 원문, 조회 실패, 채널 소실(`NO_SUCH_CHANNEL`)은 각각 안내/오류 알림으로 처리한다.
- 채팅 메뉴의 "답장" 명칭을 채팅 전용 키 `_chat.reply`로 바꿨다 (공용 `reply` 키는 그대로).
- 사용하지 않게 된 `replyOriginalTooFar`를 `replyOriginalTitle`로 교체.

## 실행
- PASS: `chat-reply.test.ts` 9건 (원문 창 조회 요청 수·인자, 최신 원문, 원문 부재, 조회 실패)
- PASS: 변경 파일 `eslint --quiet`, `node scripts/check-shipping.mjs` (Lint/SPDX/Locale safety)
- BASELINE: `chat-message-editing.test.ts`, `chat-room-timeline.test.ts`는 `window is not defined`로 변경 전에도 실패 (이 환경의 unit 설정 문제)

## 생략
- 실제 서버·브라우저 조건에서 기존 10쪽 제한의 실패 재현과 새 동작 확인: 검증 환경이 별도 담당 소유라 실행하지 않았다. 실행 검증이 남아 있다.
- 최근 원문 스크롤·삭제된 원문의 화면 확인, 타입 검사(vue-tsc), Storybook build, 전체 build, backend 시험: 생략 (backend 미변경).
- `docs/repo/cherrypick.md`, `docs/guidelines/review.md`는 이 워크트리에 없어 읽지 못했다.
