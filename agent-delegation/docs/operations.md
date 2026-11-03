# 운영·복구 계약

사용법은 [README](../README.md)에 있습니다. 이 문서는 장애가 났을 때의 판단과 안전 장치의 세부 동작을 정리합니다.

## 장애 판단표

| 상황 | 동작 |
| --- | --- |
| 지시자·MCP 연결 종료 | 서비스와 워커는 계속 실행. 다시 연결해 `list_runs`로 확인 |
| 서비스만 종료, 워커 생존 | 같은 워커를 다시 관찰. 모델 요청을 새로 보내지 않음 |
| 워커 종료, 네이티브 프로세스 생존 | `orphaned`. 자원 잠금 유지. 증거를 대조한 뒤 취소나 수정을 명시적으로 결정 |
| 재부팅으로 이전 프로세스 소멸 | `interrupted`. 기존 요청을 다시 보내지 않음. 수정 지시로 새 시도 |
| 시작 여부·프로세스 소유권 불명 | `orphaned` 또는 `stop_uncertain`. 자원을 다시 할당하지 않음 |
| 자원 연결 불일치 | `resource_wait`. 같은 worktree와 잠금 유지. 연결을 맞춘 뒤 `reconcile_run` |
| 모델·검증 실패 | `needs_review`. 지시자가 정하기 전에는 재시도하지 않음 |
| 범위·문맥 위반 | 증거를 보존하고 승인을 막음 |
| 수정 시도의 재적용 충돌 | 구현자에게 해결 지시. 남아 있으면 `conflict_unresolved`로 승인을 막고 `request_changes`로 이어 감 |
| 수정 시도의 재적용 실패 | `CORRECTION_APPLY_FAILED`. 모델 호출 없음, 수정 횟수 미사용 |
| 통합 중 서비스 종료 | 실제 HEAD·부모·diff를 대조. 입증되지 않으면 다시 검수 |
| 반영 뒤 응답 유실 | 대상 HEAD가 승인 커밋이고 브랜치·작업폴더가 맞으면 완료로 복구 |
| 대상 저장소에 사용자 변경 | 보존하고 `finalize_uncertain` 또는 사전 조건 오류 반환 |

불확실한 외부 작업은 자동으로 반복하지 않습니다. 실제 프로세스와 Git 증거로 대조한 뒤 다음 동작을 정합니다.

## 서비스와 기록

- **접속:** 서비스는 localhost에만 열리고, 시작할 때마다 새 bearer 암호를 사용자 데이터 파일에 씁니다. 브라우저 Origin 요청은 받지 않습니다. OpenCode·Kilo는 워커별 임의 포트와 Basic 인증, Codex·Claude는 소유한 STDIO 프로세스를 씁니다. 인증 값은 MCP 응답에 넣지 않습니다.
- **소유자 확인:** 서비스 소유자는 PID와 프로세스 생성 시각으로 확인합니다. 새 서비스는 살아 있는 소유자를 교체하지 않고, 죽은 소유자의 잠금만 회수합니다. 확인할 수 없으면 중복 실행보다 중단을 택합니다. 이때는 `service.log`와 `jobs/<attempt>/`의 `launch.json`, `started.json`, `worker.json`을 확인하고, PID 숫자만 보고 프로세스를 종료하지 마세요.
- **회수 잠금:** 회수 중 프로세스가 죽어 `service-reaping.lock`이 남으면 시작이 `SERVICE_RECOVERY`로 멈춥니다. 서비스가 없는 것을 확인한 뒤 그 폴더를 지웁니다.
- **저장:** 상태 변경은 revision과 체크섬이 있는 증분 journal에 fsync한 뒤 확정합니다. 요청 응답과 이벤트도 같은 트랜잭션에 넣습니다. 재시작하면 체크포인트 뒤의 journal을 차례로 복구합니다. 마지막 불완전 레코드는 버리고, 중간 손상이나 revision 누락은 오류입니다.
- **상태 오류:** 알 수 없는 상태는 `STATE_CORRUPT`, 허용되지 않는 전환은 `STATE_TRANSITION`입니다. 저장이 실패하면 새 작업 시작을 멈추고 `REQUEST_UNCERTAIN`을 반환합니다. 서비스를 재시작해 복구한 뒤 상태를 대조하세요.
- **제출:** 모든 입력과 문맥을 검증하고 `submissions/<request_id>/manifest.json`에 생성물 소유권을 기록한 뒤 준비합니다. 작업 파일은 배타적 hard link로 게시하고, 준비가 끝나면 실행과 제출 이벤트를 한 번에 등록합니다. 등록 전 오류는 이번 제출이 만든 변경 없는 생성물만 정리합니다. `submissions/` 기록을 지워 불확실한 요청을 다시 제출하지 마세요.
- **규칙 변경:** 문맥으로 쓴 규칙·명세를 바꿨다면 기존 실행을 조용히 갱신하지 않습니다. 현재 작업을 검토하고 새 실행을 계획하세요.
- **모델 요청:** 보내기 전에 실행·시도·세션·메시지 ID와 의도를 저장합니다. 응답을 잃으면 같은 세션에서 그 메시지를 찾고, 다시 보내지 않습니다. 완료는 실제 메시지, 그 메시지에 대한 완료 응답, 대기 중 도구 없음, idle 상태를 함께 보고 판단합니다.
- **검증 명령:** 실행 의도, 실제 셸, 환경 식별자와 프로세스 소유권을 먼저 기록합니다. 별도 command-host가 종료 코드와 로그를 저장하고 프로세스 트리를 정리합니다. 종료 코드를 알 수 없으면 `unknown`이며 자동으로 다시 실행하지 않습니다.
- **변경 요청:** 1초 넘게 걸리면 `{in_progress, operation_id, operation_status, run_id?}`로 먼저 응답합니다. 같은 `request_id`와 내용으로 결과를 다시 확인하거나 `get_run.operations`를 봅니다.
- **응답 크기:** 일반 응답은 4 KiB, 산출물 응답은 16 KiB 이내입니다. `next_cursor`, `after`, `next_offset`으로 이어 읽습니다. 페이지에 들어가지 않는 작업 항목은 요약(`task_id`, 상태, 시도 ID·상태·커밋, 검사 결과)과 전체를 가리키는 `artifact_id`로 돌려줍니다.
- **데이터 권한:** POSIX에서는 데이터·인증 기록을 사용자 전용 권한으로 만들고, Windows는 사용자 프로필 ACL을 씁니다. 데이터·연결 암호·로그는 Git에 넣지 마세요.

## 취소와 수정 지시

- `cancel_run`은 취소 의도를 먼저 저장하고, 종료 대기와 분리해 바로 응답합니다.
- `cancelling`은 완료가 아닙니다. 실제 종료를 확인하기 전에는 자원 잠금을 풀지 않습니다. macOS는 소유 프로세스 그룹, Windows는 `taskkill /T`로 하위 프로세스까지 종료합니다.
- 늦게 도착한 완료·실패 기록은 취소된 실행을 되돌리지 못합니다. 취소된 검증은 `cancelled`입니다.
- 최종 반영의 `finalizing` 경계 전 취소는 반영을 막고, 경계 뒤의 취소는 `RUN_FROZEN`으로 거절합니다.
- 수정 지시가 수락되면 이전 결과는 즉시 검수 대상에서 빠집니다. 재시작해도 그 결과를 승인하거나 수정 지시를 중복 제출할 수 없습니다.
- 통합된 작업은 고치지 않고 후속 작업을 추가합니다. 아직 통합하지 않은 결과의 수정은 가장 최근 시도의 커밋을 적용한 새 시도로 진행합니다.
- 범위·문맥 거절에는 tracked diff와 `rejected-result.json`이 남습니다. 미추적 UTF-8 파일은 64 KiB까지 미리보기를 주고, 바이너리·인증 파일 본문과 심볼릭 링크 대상은 넣지 않습니다.

## 실행 중 범위 보호

- **경로 검사:** 직접 편집·삭제·이름 변경·다중 파일 패치는 실행 전에 모든 경로를 검사합니다. 범위 밖 경로, 문맥, `.git`, traversal, 대소문자·Windows short-name 별칭, ADS, 심볼릭 링크·junction 우회는 권한 승인으로도 풀리지 않습니다.
- **플랫폼별 확인:** 모델 요청 전에 OpenCode·Kilo는 edit/bash ask 정책과 permission API, Codex는 신뢰 해시가 확인된 훅과 명령 게이트웨이, Claude는 훅 등록과 SDK callback을 확인합니다. 확인할 수 없는 설치본은 실행하지 않습니다.
- **셸 명령:** 일반 셸·exec·write_stdin은 지시자 승인을 받습니다. 재위임, 백그라운드 실행, 소유권을 바꾸는 Git 명령은 거절합니다. `always` 승인은 정확한 명령·작업 폴더·시도·범위 해시에 묶이고 현재 시도에서만 유효합니다.
- **감시:** 워커가 소유하는 파일 알림과 주기적 Git·문맥 검사는 MCP나 서비스가 끊겨도 유지됩니다. 문맥을 제외한 ignored 빌드 출력은 허용합니다. 위반이나 감시 상태 불명은 `scope-violation.json`에 남기고 소유 프로세스를 중단한 뒤, 종료를 확인하고 `scope_or_context_error`로 검수에 올립니다. 파일을 자동 복원하거나 삭제하지 않습니다.
- **한계:** 이 보호는 OS 격리가 아닙니다. 승인한 프로그램의 모든 외부 부작용을 막지는 못하므로 셸 승인 때 명령과 작업 폴더를 검토하세요.

## 공유 자원

- 자원 프로파일은 연결 설정, `resource_key`, 읽기 전용 probe 명령, 예상 인스턴스 ID를 가집니다. 같은 키는 서비스 전체에서 같은 정의여야 합니다.
- probe는 잠금을 얻은 뒤, 모델 호출 전에 실행합니다. 실제 시스템을 조회해 `instance_id`와 필요하면 `project_path`를 JSON으로 돌려줘야 합니다. 기대값을 그대로 출력하는 스크립트는 쓸 수 없습니다.
- Unity Editor 같은 프로젝트 종속 자원은 작업 worktree와 최종 검증 worktree 각각에 연결해야 합니다. 경로가 맞지 않으면 `resource_wait`로 기다리며, 연결한 뒤 `reconcile_run`을 호출하면 같은 시도를 이어 갑니다.
- OpenCode는 기존 설정의 MCP 연결을 모두 끄고 명시한 자원만 켜며, 외부 플러그인은 `--pure`로 끕니다. 사용자 인증 파일은 복사하지 않습니다.
- 워커의 재위임과 이 위임 MCP 호출은 금지됩니다.

## 구현자 설치본과 SDK

- Codex는 CLI만, OpenCode·Kilo·Claude는 CLI와 SDK가 필요합니다.
- SDK 탐색 순서는 `profiles.json`의 절대 `sdk_root` → `AGENT_DELEGATION_{OPENCODE,CLAUDE,KILO}_SDK_ROOT` → 선택한 CLI 패키지 → 현재 Node/npm 전역 패키지입니다. 프로젝트나 다른 도구의 SDK로 대체하지 않습니다.
- CLI 경로는 `profiles.json`의 `executable` 또는 `AGENT_DELEGATION_{OPENCODE,CODEX,CLAUDE,KILO}_EXECUTABLE`(`_EXECUTABLE_ARGS`)로 지정합니다. 서비스는 시작할 때의 환경 변수를 유지하므로, 바꾼 뒤에는 `stop` 후 `doctor`를 다시 실행합니다.
- `doctor`의 오류는 `SDK_NOT_FOUND`, `SDK_INCOMPATIBLE`, `CLI_NOT_FOUND`, `CLI_INCOMPATIBLE`이며 검사 경로와 안내가 함께 옵니다. 성공은 초기화·정책·세션 연결을 확인했다는 뜻이고, 공급자 인증이나 모델 작업 성공을 보장하지 않습니다.
- 설정·초기화 실패는 수정 횟수에 포함하지 않습니다. 전달 의도를 기록한 요청은 불확실해도 포함합니다.
- 진행 중인 시도의 설치본이 바뀌면 `RUNTIME_CHANGED`를 남기고 요청을 다시 보내지 않습니다. SDK가 없어도 기록 조회, 검수, 소유 프로세스 취소, 최종 검증은 됩니다.
- OpenCode 기본 모델은 설정, 최근 모델 기록, 공급자 기본 모델 순으로 정하고 시도에 고정합니다. `doctor.connection.model_warning`은 기본 모델을 쓸 수 없다는 경고입니다.
- Claude 모델 별칭의 실제 계열을 확인할 수 없으면 `MODEL_UNAVAILABLE`입니다. 정확한 모델 ID를 지정하세요.
- Claude Code 2.1.223은 초기화 응답에 버전을 보내지 않아 `CLI_INCOMPATIBLE`이 됩니다. CLI 2.1.316과 SDK 0.3.316은 통과했습니다. 전역 폴더에 쓸 수 없으면 사용자 폴더에 설치하고 `profiles.json`으로 지정합니다.
- OpenCode·Kilo 워커는 사용자 설정의 권한 중 정책에 없는 항목을 `deny`로 덮어씁니다.

## Codex 워커

- **정책:** `on-request` 승인과 `workspace-write` 샌드박스를 씁니다. 검증 기준 CLI는 0.166.0입니다.
- **훅:** 모델 호출 없이 설정을 읽고, 소유한 `PreToolUse` 훅 하나를 `hooks/list`로 찾습니다. 그 key와 해시만 실행 인자의 `hooks.state`에 등록해 다시 시작한 뒤, 같은 명령·동기 실행·`trusted` 상태를 확인합니다. 확인한 값은 `jobs/<attempt>/hook-policy.json`에 남고, 전역 훅 신뢰는 바꾸지 않습니다.
- **도구:** 파일은 `delegate_read_file`로 범위 안의 UTF-8 파일을 64 KiB씩 읽고, 수정은 `apply_patch`의 모든 경로를 검사합니다. 셸은 `delegate_run_command`로 지시자 승인을 받아 별도 프로세스에서 실행합니다. 네이티브 셸·exec·write_stdin은 거절합니다.
- **`ask` 미지원:** Codex의 `PreToolUse`는 `ask`를 처리하지 못하므로 훅은 `allow`·`deny`만 씁니다. 네이티브 승인이 필요한 MCP 도구 호출은 거절되며, 자원 진단이 성공해도 그 도구를 Codex에서 쓸 수 있다는 뜻은 아닙니다.
- **세션:** 완료는 app-server 이벤트로 판단합니다. 스트림이 전달 확인 전 5초, 확인 후 30초 조용할 때만 `thread/turns/list`로 최근 턴을 읽고, 실패해도 요청을 다시 보내지 않습니다.
- **Windows:** `workspace-write`가 `read-only`로 바뀌지 않도록 실행 인자에서만 `windows.sandbox=unelevated`를 기본 선택합니다. 명시한 `mxc`·`elevated`·`unelevated`는 유지합니다. `.cmd` 래퍼가 인자를 다시 해석해도 명령으로 실행되지 않도록 CMD 연산 문자를 TOML Unicode escape로 넘깁니다.
- Codex app-server 연동은 실험 기능입니다.

## 업데이트와 제거

- 설치본은 버전과 내용 해시가 붙은 폴더에 만들어지고, 이전 설치본은 지우지 않습니다.
- 살아 있는 서비스, 종료가 불확실한 시도, 다른 프로토콜·저장 형식이 있으면 `UPDATE_PENDING`으로 전환을 보류합니다. 형식이 다른 데이터는 변환하지 않습니다.
- 등록이 실패하면 Codex와 Claude Code 모두 이전 등록을 복구합니다. 사용자 CLI·SDK·인증·프로필·실행 기록은 그대로 둡니다.
- 열린 대화는 이전 설치본을 계속 씁니다. MCP 초기화의 `serverInfo.version`은 연결된 브리지, `doctor.deployment.version`과 `doctor.deployment.executable`은 실제 서비스의 배포물입니다. 호스트가 재연결 경로를 주지 않으면 앱에서 다시 연결하거나 재시작하고, 다른 작업이 실행 중일 때 백엔드를 임의로 종료하지 마세요.
- 제거: 작업을 끝내거나 취소하고 `stop`한 뒤 `codex plugin remove agent-delegation@personal`, `claude plugin uninstall agent-delegation@personal`을 실행합니다. 데이터와 이전 설치본은 직접 지웁니다.
- `cleanup`은 서비스가 만든 끝난 실행의 worktree만 지우고 증거와 기록은 남깁니다. 원본 로그에는 코드와 모델 대화가 있으니 공유할 때 주의하세요.

## 보관과 저장 형식

- 실행이 처음 `completed`·`cancelled`가 될 때 `ended_at`을 기록합니다. 7일이 지나면 서비스 시작 때와 매시간 한 건씩 `archives/runs/`로 옮깁니다. 자원 잠금, 살아 있는 프로세스, 미해결 제출이 있으면 미룹니다. 요청 응답도 7일 뒤 `archives/requests/`로 옮깁니다.
- 보관된 실행도 `list_runs`·`get_run`·`wait_run`·`get_artifact`·`cleanup`으로 볼 수 있고 `archived`, `archived_at`, `ended_at`이 붙습니다. 새 변경은 `RUN_ARCHIVED`로 거절합니다. 보관된 `get_run`에는 `effective_concurrency`와 `operations`가 없습니다.
- 보관 파일은 내용 해시를 이름으로 쓰고 체크섬을 검사합니다. 없거나 손상되면 `STATE_CORRUPT`입니다. 보관 기록·증거·로그는 자동으로 지우지 않습니다.
- journal은 256개 레코드 또는 `max(32 MiB, 최신 레코드 × 4)`에서 새 세대로 바뀝니다. 별도 `storage-worker.mjs`가 체크포인트를 만들고, `checkpoint.json`이 현재 snapshot과 journal 목록을 가리킵니다. `state.json` 하나로는 최신 상태를 알 수 없습니다.
- Windows의 일시적인 파일 잠금은 최대 230 ms까지 재시도합니다.

## 백업과 복원

- 백업은 서비스와 워커가 멈춘 것을 확인한 뒤 데이터 폴더 전체를 같은 시점에 복사합니다. `checkpoint.json`, `checkpoints/`, `journals/`, `archives/`, `jobs/`, `artifacts/`, 제출 준비 기록, worktree가 모두 필요합니다.
- 복원도 서비스와 워커를 먼저 멈추고 현재 데이터를 따로 보존합니다. 같은 백업 전체를 원래 절대 경로에 복원하고, 그 형식을 지원하는 배포물로 확인합니다.
- 기록과 worktree에 절대 경로가 있으므로 다른 위치로 옮기는 복원은 지원하지 않습니다. 시점이 다른 파일이나 형식이 다른 배포물을 섞지 마세요.

## 사용량과 동시 실행

- `get_run`은 시도별·실행 합계 `usage`(입력·출력·캐시 토큰, `cost_usd`)를 돌려줍니다. 비용을 보고하지 않는 플랫폼은 `cost_usd`가 `null`이고, 합계도 한 시도라도 없으면 `null`입니다. 구독 요금과는 다를 수 있습니다.
- `last_activity_at`은 구현자 기록이 마지막으로 바뀐 시각입니다. 작업이 멈췄는지 판단할 때 씁니다.
- 서비스 전체 동시 실행 수는 `AGENT_DELEGATION_CONCURRENCY`(기본 2)이고, 실행의 `settings.concurrency`는 이를 넘지 못합니다. 실제 값은 `get_run.effective_concurrency`에 나옵니다. 워커 하나는 약 115MB를 씁니다.
- 검증 셸 선택과 Bash·Zsh 초기화는 [OpenCode 1.18.30 규칙](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/shell.ts)을 따릅니다. macOS는 Zsh, Windows는 PowerShell·Git Bash·cmd 순이며, PowerShell은 인용을 보존하는 인코딩된 명령으로 실행해 마지막 종료 코드를 기록합니다. 수정 시도와 최종 검증은 처음 정한 셸을 유지합니다. 네이티브 플러그인의 shell.env 훅은 실행하지 않으므로 필요한 환경 값은 프로필의 `env_refs`로 지정합니다.

## 검증 범위

- **자동 테스트:** 네 플랫폼의 모의 네이티브 프로토콜과 실제 임시 Git 저장소로 16개 지시자·구현자 조합의 MCP 계약을 검사합니다.
- **연결 검사:** `npm run check:connections`는 모델 호출 없이 실제 CLI·SDK 초기화를 검사합니다. 인수가 없으면 사용자의 현재 설치본, `node scripts/prepare-connections.mjs <임시 경로>`로 준비한 경로를 주면 그 테스트 설치본을 검사합니다.
- **CI:** macOS·Windows 회귀 검사와 네이티브 초기화 검사를 실행합니다. `scripts/ci-check.mjs`는 크기를 제한한 진단 로그만 실패 시 7일 아티팩트로 올리고, 원본 기록·암호·인증·네이티브 로그는 올리지 않습니다.
- **실제 모델:** `e2e`와 `e2e:platform`은 임시 저장소에서 실행하며, 실패하면 로그 경로를 출력하고 임시 폴더를 남깁니다. `--installed`는 빌드 대신 설치본을 씁니다. `e2e`에 `--user-data`를 붙이면 실제 데이터 폴더를 쓰고, 통과하면 그 실행의 worktree만 정리합니다. `e2e`는 임시 내보내기 설정을 쓰므로 등록된 플러그인 경로는 검사하지 않습니다.
- **2026-11-03 확인 결과 (macOS):** Codex 0.166.0, OpenCode 1.19.0 + SDK 1.19.5, Claude Code 2.1.316 + SDK 0.3.316, Kilo 7.4.23 + SDK 7.8.18에서 충돌 수정부터 반영까지, 서비스 재시작, 취소가 모두 통과했습니다. 지시자 조합 `haiku-kilo`, `haiku-luna`, `luna-haiku`도 통과했습니다.
- **확인하지 않은 범위:** IDE·데스크톱 GUI 지시자, Windows 실기기, GUI 구현자 자동 제어(제공하지 않음)입니다.
