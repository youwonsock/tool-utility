# 검증 상태 — 2026-10-23

구현과 아래 로컬 검증을 마쳤습니다. 전체 수용 기준 중 Windows 네이티브 실행, 실제 참고 영상의 시각 해석 품질, 실제 게임 PlayMode 검증은 남아 있습니다. 실행하지 않은 항목은 통과로 집계하지 않습니다.

## 계산 코어와 인터페이스

- Mac Apple Silicon, macOS 26.6.2, 동봉 Python 3.14.8에서 **53/53 자동 테스트 통과**, 실패·오류·skip 0.
- 셀 경계·여백·잔여 중앙 패딩·명시적 유효 셀·JPG·원본 변경·잘못된 manifest를 검사했습니다.
- 행동 경계·고저·회전 보호, 카메라 이탈/판단 불가 분리, 정지 경고, 되돌아오는 경로, 3D RDP와 간소화 전 기준 축척을 검사했습니다.
- 기존 중간점만 이동, 삽입/순서 변경 후 ID 보존, 누락된 대응 거절, 명시적 삭제와 공유 참조 보존을 검사했습니다.
- 오래된 snapshot, 생성 receipt 누락, 의존성 위반, 참조 연결 실패 후 중단, 부분 생성 재계획에서 중복 생성 방지를 **가짜 엔진 호출자 단위 테스트**로 확인했습니다.
- 실제 MCP ClientSession/stdio 연결에서 기본 정보+공개 도구 6개 등록, JSON 결과 4종과 PNG 2종의 CLI 일치, UNKNOWN_FRAME 오류 코드 일치를 확인했습니다.
- 배포 스키마 6개와 정본 일치 검사, Windows/Mac 동봉 파일 전체 해시 검사를 통과했습니다.

## video-tools 출력 연계

현재 video-tools의 실제 extract_images를 호출해 생성한 격자를 소비했습니다. 입력 영상은 색상 8프레임의 lossless 합성 자료이며, 0~7초를 1초 간격으로 추출했습니다. 실제 게임 영상의 분석 품질 증거는 아닙니다.

| 출력 | 최종 / tile 크기 | 유효 셀 검사 | 결과 |
| --- | --- | --- | --- |
| 2×2 PNG/JPG | 219×219 / 218×218 | 형식별 7개, 마지막 sheet 3개 | 통과 |
| 3×3 PNG/JPG | 326×326 / 324×324 | 형식별 7개, 마지막 sheet 7개 | 통과 |

총 28개 셀의 크기와 픽셀을 확인했습니다. PNG RGB 최대 오차는 0, JPG 내부 표본의 최대 오차는 1입니다. JPEG 압축의 외곽 ringing을 정확한 원본 픽셀로 취급하지 않았습니다. 유효 셀 수는 테스트 입력에서 명시했습니다.

별도 초기 FFV1 합성 자료를 정확히 영상 끝까지 추출한 시도에서는 요청한 7개와 실제 6개 셀이 달랐습니다. producer의 EOF 처리 원인은 이 제품의 수정 범위에 포함하지 않았습니다. 최종 호환성 증거는 위의 8프레임/0~7초 범위이며, 이 제품은 시간 정보로 유효 셀 수를 추측하지 않습니다.

## XP Hero 연결 검증

실제 XP Hero의 Unity 2023.2.20f1 Editor에 연결한 Unity MCP로, 별도의 호출자 코드를 통해 neutral EditPlan을 적용했습니다. Unity 호출자 코드는 제품 코어에 포함하지 않았습니다.

1. 바탕화면의 별도 검증 씬에서 2개 run, 3개 segment, 7개 point를 생성하고 18개 작업의 receipt와 실제 snapshot을 검증했습니다.
2. root 위치 (12,3,-7), Y 회전 30도, scale 2에서 root-frame 좌표를 적용했습니다.
3. 중간점 하나 변경은 update_node + rebuild 두 작업만 만들고 다른 점과 기존 참조를 보존했습니다.
4. 명시한 중간점 제거는 set_order → delete_node → rebuild 3개 작업으로 적용됐습니다.
5. Unity가 프로젝트 밖 .unity의 재오픈을 거절해 검증 씬만 임시 Assets에 복사하고 새 meta를 생성했습니다. 저장·close·additive reload 후 실제 serialized file ID 11개, 좌표, 경로 배열을 재조회해 complete 판정을 받았습니다. 이름/거리로 기존 객체를 추정하지 않았습니다.
6. 경계 Transform은 서로 다른 객체이며 위치 오차 0입니다. 새 PathData의 Linear·TimeBased 5초·빈 이벤트 설정도 재로드 후 확인했습니다.
7. 재로드한 실제 PathFollower에 수동 Tick을 전달했습니다. 2구간/1구간 두 sequence 모두 이동 후 완료했고 최종 위치 오차는 각각 약 6.75e-7, 0입니다. **EditMode에서 네이티브 코드를 실행한 결과이며 PlayMode 자동 실행 증거는 아닙니다.**

원래 Current 씬은 계속 활성 상태이고 dirty=true를 유지했습니다. 원래 씬을 저장하거나 재로드하지 않았습니다. 임시 검증 씬/Assets 폴더는 정리했고, 바탕화면에 입력·계획·receipt·snapshot·검증용 씬 사본을 남겼습니다. 기존에 사용자 코드 변경이 있던 Scenario 파일은 수정하지 않았습니다.

## 독립 배포

Mac에서 전체 도구를 한글·공백 경로로 이동했습니다. PATH를 비우고 Python 격리 실행(-I), macOS sandbox-exec의 network* 차단 및 원본 제품/video-tools 파일 읽기 차단을 적용했습니다. 실제 접속 시도와 원본 파일 읽기 거절을 확인하고 CLI/MCP 계산·PNG 반환, 실행기, 이동 후 연결 설정을 검증했습니다. 제품 자체 런타임만 사용했습니다.

Windows x64 런타임 2,426개 파일, Mac ARM64 런타임 2,092개 파일의 manifest/해시 검사는 통과했습니다. **Windows 실행 결과는 아직 없습니다.** 별도 GitHub Actions workflow에 windows-latest와 macos-15 네이티브 검사, 스키마, 테스트, 폴더 재배치·MCP smoke를 구성했습니다. workflow는 아직 원격 실행하지 않았습니다. macos-15의 ARM64 label은 [GitHub 공식 runner 문서](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)를 확인했습니다.

개발 검증용 verify_portable.py는 Windows에서 일시적인 프로그램별 inbound/outbound firewall 차단 규칙을 만들고 finally에서 제거합니다. 해당 검증 장비에는 관리자 권한이 필요합니다. 제품 실행기와 공개 분석 도구는 firewall을 변경하지 않습니다.

## 런타임 경량화

2026-10-31에 런타임을 Video Tools 복사본 대신 `tools`의 고정 입력에서 직접 생성하도록 바꿨습니다. Tcl/Tk와 사용하지 않는 cryptography, cffi, pycparser, PyJWT를 뺐습니다. Mac 런타임은 134MB에서 76MB가 되었습니다. 생성은 두 OS의 GitHub Actions에서 수행했고, Mac에서 `--audit --git`, 단위 테스트, smoke, 스키마 확인, 경로 이동·오프라인 검사와 MCP 실행 스크립트를 통과했습니다. Windows 런타임은 CI로만 확인합니다.

2026-10-31에 Python 3.14.10, Pillow 13.0.0, certifi 2026.10.23으로 런타임을 다시 생성했습니다. Pillow 12.3.0에는 13.0.0에서 고쳐진 권고 59건이 있었습니다. 두 OS CI와 Mac 새 clone에서 위 검사를 통과했습니다. 테스트는 합성 이미지만 사용하므로 실제 영상의 결과 변화는 확인하지 않았습니다.

## 재현과 남은 검사

README의 테스트·schema·audit 명령과 `tools/verify_portable.py --output <새 외부 폴더>`로 재현합니다. 검증 스크립트는 기존 결과 폴더를 덮어쓰지 않습니다. 이번 결과의 요약 JSON은 [evidence/2026-10-23](evidence/2026-10-23)에 보관하며, 기계별 절대 경로만 치환했습니다.

- Windows에서 실제 portable job을 실행하고 네이티브 동작 결과를 남깁니다.
- 사용자의 실제 참고 영상/격자로 관측값의 회전·상대 높이·행동 해석 품질을 별도로 평가합니다.
- 실제 게임의 Follower 연결·PlayMode 행동·이벤트/시간 재현은 별도 검증입니다. v1 자동 적용은 경로 기하와 참조 구성까지입니다.
