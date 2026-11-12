# Frontend E2E CI 서비스 포트 충돌 수정

## 원인과 실제 실패

- 대상: [실패 실행 43119732968 / frontend E2E job 130856826372](https://github.com/chalkpe/cherrypick/actions/runs/43119732968/job/130856826372).
- 기준: 최신 `origin/develop` = `7ba927bfc9b28902751ee3828a83161807ff287e`.
- 전체 job 로그와 Jobs API를 `gh`로 읽었다. 실패는 2026-11-11 23:25:53 UTC의 `Initialize containers` 단계다. Checkout, 의존성 설치, 빌드, Playwright 시험은 모두 실행되지 않았다.
- 실제 명령은 `docker create ... -p 54312:5432 ... postgres:18`이었다. Docker가 시작 중 `failed to bind host port 0.0.0.0:54312/tcp: address already in use`로 종료했다. Redis 생성까지 도달하지 않았다.
- 따라서 PostgreSQL 18의 SQL 동작이나 frontend 시험 실패가 아니라, 이미 점유된 호스트 포트를 workflow가 고정 요구한 준비 단계 실패다. Redis의 `56312:6379`도 같은 고정 할당 구조였다.
- 로그에는 기존 점유 프로세스·컨테이너의 소유자 정보가 없다. 다른 workflow, 운영 DB, 이전 컨테이너, 특정 프로세스가 점유했다고 단정하지 않는다. 타인 자원은 조회를 위한 변경·중단·삭제도 하지 않았다.

## 러너와 인접 workflow 조사

실패 러너는 `GitHub Actions 1000012859`, 그룹 `GitHub Actions`, 라벨 `ubuntu-latest`다. 전체 로그에서 GitHub Hosted Compute Agent, Ubuntu 26.04.1, 이미지 `ubuntu-26.04` 버전 `20261101.186.1`, runner `2.338.2`, Docker API `1.54`를 확인했다. Self-hosted runner라는 근거는 없다.

| Workflow / job | 서비스와 포트 | 병렬 실행과 소비 경로 |
| --- | --- | --- |
| `test-frontend.yml` / `e2e` | PostgreSQL `54312:5432`, Redis `56312:6379` → 이번 수정으로 동적 할당 | Unit job과 독립 실행, 별도 concurrency 없음. 테스트 YAML을 복사하고 루트 `start:test`가 다시 복사했음 |
| `test-backend.yml` / `unit` | PostgreSQL·Redis 동일, Meilisearch `57712:7700` | Node 두 버전 matrix. `.config/test.yml` → 시험 모드 설정 컴파일 |
| `test-backend.yml` / `e2e` | PostgreSQL·Redis 동일 | Node 두 버전 matrix, `fail-fast: false`. 동일 시험 설정 소비 |
| `test-backend.yml` / `migration` | PostgreSQL 동일 | Node 한 버전. `CHERRYPICK_CONFIG_YML=test.yml`로 migration과 DDL 검사 |
| `frontend-diagnostics.inspect.yml` / `report` | PostgreSQL·Redis 동일 | PR별 concurrency로 이전 실행 취소. base/head를 각각 복사하고 브라우저 하네스가 루트 `start:test`로 순서대로 실행 |
| `backend-diagnostics.inspect.yml` / `get-memory-usage` | PostgreSQL·Redis 동일 | 별도 concurrency 없음. base/head의 `.config/default.yml`과 메모리 측정 하네스 사용 |
| `test-production.yml` | service container 없음 | `.config/default.yml`을 사용한 빌드만 수행 |
| `test-federation.yml` | job service 고정 매핑 없음 | 별도 Docker Compose 네트워크의 컨테이너 간 연결 사용 |

저장소 workflow에는 기존 `job.services.*.ports` 사용 사례가 없었다. 로컬 backend 시험용 Compose도 `127.0.0.1:54312:5432`와 `127.0.0.1:56312:6379`를 사용하므로 공용 시험 YAML의 기본 포트는 유지했다.

같은 SHA의 backend workflow `43119732962`는 다섯 job 모두 성공했다. 확인한 backend unit runner는 `GitHub Actions 1000012861`로 실패 러너와 달랐다. [GitHub 공식 문서](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)는 이 종류의 hosted runner를 새 VM으로 설명한다. 여러 job에 같은 숫자가 있다는 사실만으로 job끼리 같은 호스트에서 충돌했다고 볼 수 없다.

이번 수정은 실제 실패가 확인된 frontend E2E 경로에 한정했다. 인접 workflow의 고정 매핑은 위와 같이 기록했으며, 실패가 확인되지 않은 backend·diagnostics 시험과 하네스까지 일괄 변경하지 않았다. 특히 backend diagnostics의 DB 초기화 코드는 포트와 DB 이름도 별도로 고정하므로, workflow 매핑만 바꾸면 소비 경로가 끊어진다.

## 수정과 설정 소비 경로

수정 파일은 `.github/workflows/test-frontend.yml` 한 개다.

1. PostgreSQL·Redis service의 `ports`에서 컨테이너 포트 `5432`, `6379`만 지정한다. GitHub/Docker가 사용 가능한 호스트 포트를 할당한다. [공식 service container 문서](https://docs.github.com/en/actions/tutorials/use-containerized-services/use-docker-service-containers)의 할당 방식과 service context를 사용했다.
2. `job.services.postgres.ports['5432']`와 `job.services.redis.ports['6379']`를 구성 단계의 환경변수로 전달한다.
3. 기존 의존성 `js-yaml`로 `.github/cherrypick/test.yml`을 읽고 `db.port`, `redis.port`만 할당값으로 바꿔 `.config/test.yml`에 쓴다. 원본 YAML과 로컬 기본 포트, DB 이름, HTTP 포트 `61812`는 보존한다.
4. `start-server-and-test`가 `pnpm --filter backend start:test`를 실행하도록 바꾼다. 루트 `start:test`는 기본 YAML을 다시 복사하므로, 이를 그대로 실행하면 동적 포트 설정이 지워진다. backend package의 기존 시작 스크립트는 재복사 없이 `NODE_ENV=test pnpm compile-config`를 실행한다.
5. `packages/backend/scripts/compile_config.js`가 `.config/test.yml`을 `built/.config.json`으로 변환한다. 서버의 `loadConfig()`가 그 JSON을 읽고 DB 및 Redis 연결에 사용한다. 서버와 Playwright의 HTTP 연결 주소는 기존 `localhost:61812`다.
6. 해당 frontend workflow만 feature branch에서 원격 확인할 수 있도록 `workflow_dispatch`를 추가했다. PR은 만들지 않았고 develop에는 푸시하지 않았다.

고정 포트를 다른 번호로 바꾸거나 재시도로 오류를 숨기지 않았다. 새 의존성, 제품 서버 코드, locale, migration, 생성 API, changelog 변경은 없다.

## 검증

| 상태 | 항목 | 결과와 한계 |
| --- | --- | --- |
| PASS | 실제 원인 확인 | 원래 Actions job의 전체 로그와 runner API에서 초기 컨테이너 bind 실패 확인. 재현을 위해 Mac에 DB나 서버를 띄우지 않음 |
| PASS | 구성 변환 회귀 RED → GREEN | 실제 workflow의 구성 명령을 임시 checkout에 실행. 수정 전에는 기대 PostgreSQL `35432` 대신 `54312`로 실패. 수정 후 PostgreSQL `35432`, Redis `36379`, HTTP `61812`, DB 이름·호스트 보존 확인 |
| PASS | 실제 서버 직전 설정 컴파일 | 기존 backend `start:test`의 컴파일 부분과 실제 `compile_config.js` 실행 후 `built/.config.json`의 두 할당 포트 확인. 서버 실행은 하지 않음 |
| PASS | 재복사 회귀 확인 | 수정된 구성 후에도 기존 루트 시작 경로를 강제하면 컴파일 결과가 다시 `54312`가 되어 의도한 검증에서 실패함을 확인 |
| PASS | Workflow 정적 검사 | 공식 release checksum을 확인한 actionlint `1.7.12`로 대상 workflow 검사, 최종 exit 0. ShellCheck/Pyflakes는 미설치로 제외 |
| PASS | YAML / shell | 실제 YAML 파싱 및 구성 shell 실행, 모든 run 단계의 `bash -n`, `git diff --check` 통과 |
| PASS | 원격 frontend CI | 제품 SHA `5b8bed468dcf1e6b98273e4eae8663cfb3948a12`에서 Unit 95개 파일 / 1,406개 통과, E2E 105개 통과 / 1개 skip. 두 job 모두 성공 |
| BASELINE | 빌드 검색 인덱스 진단 | `settings/privacy.vue`의 `[create-search-index] Error analyzing file` 메시지가 원래 SHA의 성공한 Unit build 로그에도 동일하게 존재. 이번 포트 변경과 무관하며 빌드 exit 0. 원본 로그 보존 |
| PASS | Shipping | `node scripts/check-shipping.mjs --base origin/develop`: SPDX 2,984 파일 OK, locale safety PASS |
| SKIPPED | 변경 파일 ESLint | YAML만 변경하여 package ESLint 대상 없음 |
| SKIPPED | Mac production build / 서버 / 무거운 E2E | 작업 제한 준수. Windows heavy 슬롯과 타인 컨테이너·프로세스는 사용하지 않음 |
| SKIPPED | Backend 전체 시험 / migration 검사 / SDK 재생성 | 해당 구현·entity·migration·API 변경 없음 |

수정 후 첫 컴파일 검증은 `cross-env`를 찾지 못하는 준비 오류였다. pnpm이 제공하는 실행 PATH를 임시 도구에 반영한 뒤 다시 실행했다. 그 준비 오류는 제품 시험 통과로 세지 않았다. actionlint가 처음 지적한 숫자 인덱스는 문자열 키로 수정한 뒤 재검사했다.

## 원격 CI와 최종 SHA

- 최종 제품 수정 SHA: `5b8bed468dcf1e6b98273e4eae8663cfb3948a12`.
- 푸시 대상: `origin/feature/cherrypick-ci-e2e-port`.
- 원격 확인: [frontend workflow 실행 43123080504](https://github.com/chalkpe/cherrypick/actions/runs/43123080504), 위 제품 SHA에서 `workflow_dispatch` 1회 실행.
- 원격 결과: workflow와 두 job 모두 성공. [Unit job `130868208062`](https://github.com/chalkpe/cherrypick/actions/runs/43123080504/job/130868208062)은 95개 파일 / 1,406개 시험 통과. [E2E job `130868208454`](https://github.com/chalkpe/cherrypick/actions/runs/43123080504/job/130868208454)은 106개 중 105개 통과, 1개 skip, 실패 0개다.
- 실제 E2E runner: `GitHub Actions 1000012888`. 실행 시간은 2026-11-11 23:52:20 UTC부터 2026-11-12 00:02:57 UTC까지다.
- 서비스 로그에서 `docker create ... -p 5432`, `-p 6379`와 실제 호스트 할당 PostgreSQL `32768`, Redis `32769`를 확인했다. 구성 단계 환경변수에도 각각 같은 값이 기록됐고, backend 시작 시 `.config/test.yml → built/.config.json` 컴파일 후 기존 HTTP 주소에서 실제 E2E가 실행됐다.
- Skip은 `chat.spec.ts:1249`의 `a long press on a message opens its menu and selects nothing`이다. Linux Chromium이 합성 long press로 contextmenu를 내보내지 않아 기존 코드가 명시적으로 건너뛴다. 이를 통과로 세지 않았으며 시험 코드는 변경하지 않았다.
- 이 실행 한 번으로 검증했다. 기존 실패 job을 재실행하거나 저장소 전체 workflow를 다시 돌리지 않았다.
- 본 보고서는 제품 수정 이후 문서 전용 커밋으로 추가한다. 최종 전달 HEAD와 원격 일치 여부는 `.local/ci-e2e-port/final-revision.json`에도 기록한다.

## 비밀 제거한 증거

제품 워크트리의 `.local/ci-e2e-port/`에 보존한다. GitHub가 마스킹한 로그를 사용하며 인증 토큰·운영 설정은 보고서와 커밋에 포함하지 않는다.

- `original-job.log`, `original-failed.log`, `original-job.json`, `original-unit.log`: 원래 실패 전체 로그, 실패 발췌와 runner 정보.
- `original-backend-run.json`, `original-backend-runner.json`, `service-workflow-inventory.txt`: 관련 workflow·병렬성·runner 조사.
- `config-regression.mjs`, `config-red.log`, `config-green.log`, `config-overwrite-red.log`: 실제 구성 명령 및 컴파일 회귀 증거.
- `config-fixture-error.log`: 준비 오류 별도 기록.
- `actionlint.log`, `actionlint-red.log`, `shell-syntax.log`, `shipping.log`: 정적 검사와 shipping 결과.
- `remote-run-initial.json`, `remote-run-final.json`, `remote-watch.log`, `remote-e2e-job.json`, `remote-e2e.log`, `remote-unit.log`: 해당 SHA의 원격 실행, 실제 할당 포트, 구성 소비, 시험 결과.
- `implementation.patch`, `final-revision.json`: 제품 변경과 최종 전달 revision 확인.
