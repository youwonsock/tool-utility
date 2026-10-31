# 무설치 배포 완료 검증

검증일: 2026-10-14. 지원 기준: Windows 10 이상 x64, macOS 15 이상 Apple Silicon.

## 검증 대상

- 실행 소스·런타임 커밋: `9f6580fb77b4bf4275a165b8966a6c24336b5a98`
- 공용 소스 및 OS 어댑터 트리: `27b2daa2d731480e63bfe17d2ad0ec72fe6e2bc9`
- 두 런타임 트리: `0cec2479fa288962d077d22dd20abfa506beca73`
- CPython: 3.14.8, python-build-standalone 20261013, 일반 GIL 빌드. 두 공급자 메타데이터의 `Py_GIL_DISABLED=0` 확인.
- Tcl/Tk: 9.0.4 / 9.0.4. Pillow 12.3.0, MCP SDK 1.30.0, imageio-ffmpeg 0.6.0 및 전이 의존성 잠금.
- FFmpeg: Windows 7.1 essentials / Mac 7.1. 제공 휠과 원본 FFmpeg의 SHA-256은 각 manifest에 기록.
- 런타임 생성 입력 SHA-256: `19dbd1edbcf91cb6d3270d515889cab38d1dcff540315896afc644c939787f80`
- 실제 GitHub Code ZIP SHA-256: `ae0a534e0f27abc37fc79ec1bac273f34d38ae81a2d4f1546a4f2a51cf0c16be`

| 런타임 | 파일 수 | 압축 해제 크기 | 가장 큰 파일 | manifest SHA-256 |
| --- | ---: | ---: | ---: | --- |
| windows-x64 | 2,441 | 176.11 MiB | FFmpeg 83.58 MiB | `22fbcae8acac2394a8666d5e1381afa2a37d8941ac5f2b170cbe6ed375fb95e2` |
| macos-arm64 | 2,107 | 140.88 MiB | FFmpeg 47.08 MiB | `242df113de75b870462fab5eed27403a31db4990c17a2b628647eb46ec851cd8` |

Windows의 네이티브 `.pyd` 96개가 Git에 포함되어 있다. Mac Mach-O 41개는 서명 검사를 통과했고, 실행 권한과 심볼릭 링크 4개가 clone·ZIP에서 보존되었다. 두 런타임의 전체 파일 해시·크기·Git 모드를 검증했으며 모든 파일은 100 MiB 미만이다. 런타임에는 줄바꿈 변환을 적용하지 않는다.

Python 공급자가 선언한 네이티브 의존성 고지, 패키지 고지, FFmpeg 라이선스 출력·GPLv2 전문·출처를 동봉했다. 프로젝트의 테스트·픽스처·자가 테스트·이전 검증기와 설정 마이그레이션, PyInstaller 배포·설치 코드는 제거되었다.

## 실제 실행 결과

| 환경 | 새 clone | GitHub ZIP | 임시 기능 검증 | 네이티브 런처 |
| --- | --- | --- | --- | --- |
| Windows Server 2025 x64, 10.0.26100 | 통과 | 통과 | 각각 45/45, 제외 0 | run.bat / run_mcp.bat 통과 |
| macOS 15.7.9 ARM64 | 통과 | 통과 | 각각 45/45, 제외 0 | run_mac.command / run_mcp.command 통과 |
| macOS 26.6.2 ARM64, 로컬 Mac | 통과 | 통과 | 각각 45/45, 제외 0 | run_mac.command / run_mcp.command 통과 |

각각 다운로드한 폴더를 한글·공백을 포함한 다른 경로로 이동한 뒤 실행했다. ZIP은 Windows의 Expand-Archive, Mac의 ditto로 운영체제 기본 압축 해제 동작을 사용했다. 실행 중 PATH에는 제품 Python·FFmpeg와 외부 Python·FFmpeg를 넣지 않았다. Mac은 OS 기본 dirname·uname·sysctl만 제공한 경로를 사용했고 Windows는 System32만 사용했다.

Mac 프로세스와 자식 프로세스는 sandbox-exec의 outbound network 차단 아래 실행했다. Windows는 동봉 Python과 FFmpeg의 outbound firewall 차단 아래 실행했다. 동봉 Python의 실제 외부 TCP 연결 실패를 확인했다. 다운로드·clone은 이 오프라인 실행 단계 전에 완료했다.

실제 GUI 런처로 창을 열고 OS 창 닫기 동작으로 종료한 뒤 설정 저장과 종료 코드 0을 확인했다. MCP 런처로 초기화 응답과 stdin 종료 후 종료 코드 0을 확인했다. MCP 클라이언트 설정은 Windows·Mac 모두 동봉 console Python과 공용 launch.py의 절대 경로로 생성되었다.

GUI 검증은 개별 PNG 추출, JPG 격자, 미리보기·크기, 구간·크롭·크기 조절·회전·반전·배속·음소거·CRF 편집, 취소, 잘못된 입력, 스크롤, 설정 저장·재시작 복원을 포함했다. MCP는 9개 도구 목록, 연결, 조회·추출·편집 작업, 이미지 읽기, 경로 경계, 중복 출력, 취소, 정상 종료를 확인했다. 현재 설정 형식의 저장·읽기와 유효하지 않은 값의 기본값 복원도 통과했다.

실행 후 배포 폴더에 bytecode·설정·출력 파일이 생기지 않았고 clone의 Git 상태는 깨끗했다. 실제 사용자의 설정·미디어 파일은 정리 대상에 포함하지 않았다.

## GUI·MCP 결과 비교

각 OS에서 GUI와 MCP에 같은 입력과 설정을 전달하고 PNG 4개, 2 × 2 JPG 격자 1개, 편집 영상의 전체 디코딩 RGB 바이트를 비교했다. 개수·크기·전체 RGB SHA-256이 모두 일치했다. clone과 ZIP의 결과도 각각 일치했다.

| 출력 | 크기·개수 | Windows GUI = MCP SHA-256 | Mac GUI = MCP SHA-256 |
| --- | --- | --- | --- |
| PNG 1 | 64 × 36, 각 1개 | `7831901bbd89cf6c3c36b09328dd6689a3544a6b77b44f399cd36e048b1d6be0` | `7831901bbd89cf6c3c36b09328dd6689a3544a6b77b44f399cd36e048b1d6be0` |
| PNG 2 | 64 × 36, 각 1개 | `dade433fd09c6d3e79c719a00cbc200916d40d6a27aa8686a5bcc828d922338f` | `dade433fd09c6d3e79c719a00cbc200916d40d6a27aa8686a5bcc828d922338f` |
| PNG 3 | 64 × 36, 각 1개 | `13721664fe8b04e18c554ab3b0f2a90c70e1f065d1de34250ee828d81ec0144e` | `13721664fe8b04e18c554ab3b0f2a90c70e1f065d1de34250ee828d81ec0144e` |
| PNG 4 | 64 × 36, 각 1개 | `df3a2dc7a5719883a9fbd3a04db9f01a06bf9f071d308e5ca0076d5274be8b1f` | `df3a2dc7a5719883a9fbd3a04db9f01a06bf9f071d308e5ca0076d5274be8b1f` |
| JPG 격자 | 146 × 90, 1개 | `d29bff91e401729c76082c76afc37e0caabc75b5cb030717c758c74c975e8634` | `ca35592fb51cbb6411066e253847231dc4bb279e0c9fa606ae622288538cca81` |
| 편집 영상 | 128 × 72, 10프레임 | `b486b8f984006717c3b5e57557a3d2befce8e9bc9e44ac17ddd81b038409ba1b` | `4458510c13f7bcb0748a483ba0b8ebd99f5dfe56c39a2fbfab3e022a8a070cfc` |

플랫폼별 네이티브 코덱의 JPG·영상 RGB 해시는 표와 같이 별도로 기록했다. PNG 4개의 RGB는 두 OS에서도 동일했다. 편집 영상의 시간·프레임률·오디오 제거 결과도 GUI와 MCP 간 일치했다.

## 검증 기록과 범위

- [Windows 네이티브 clone·ZIP 기능 검증](https://github.com/youwonsock/tool-utility/actions/runs/38522182617): 전체 통과.
- [Mac 네이티브 clone·ZIP 기능 검증](https://github.com/youwonsock/tool-utility/actions/runs/38521357680): macOS 작업 전체 통과.
- [두 OS의 상시 배포 파일 CI](https://github.com/youwonsock/tool-utility/actions/runs/38521361049): 전체 통과.
- [두 OS 최종 런타임 재생성·동기화](https://github.com/youwonsock/tool-utility/actions/runs/38520736707): 전체 통과.

기능 검증 소스는 임시 환경·검증 브랜치에서만 사용했다. main에는 검증 소스 대신 이 결과 기록을 남긴다. 이 실행 커밋 이후 완료 기록·사용 안내만 갱신하며 병합 전 공용 소스 및 두 런타임 트리의 동일성을 확인한다.

실제 Windows 검증 OS는 위에 명시한 Server 2025이다. Windows 10 클라이언트 실기기 검증과 Mac의 브라우저 quarantine 보안 승인 화면은 이 자동 검증에 포함하지 않았다. 첫 실행 시 필요한 OS 보안 승인은 사용 안내에 따른다.

## 경량화 재검증

검증일: 2026-10-31. 위 기록은 경량화 전 런타임의 증거이며 이 절이 현재 런타임의 기록이다. 배포 방식은 저장소 clone 하나로 정리해 OS별 ZIP과 앱 Release를 만들지 않는다.

### 검증 대상

- 런타임 커밋: `ffa92ec669fdf4afe40a667c7fa0b13a7bfff683`, 런타임 입력 SHA-256: `58e26b1e9efbad2eef24ffa2f2e6e31e815e69c4d250452c4effdb63aa67b6e1`
- CPython 3.14.8, Tcl/Tk 9.0.4, MCP SDK 1.30.0. Pillow, imageio-ffmpeg, cryptography, cffi, pycparser, PyJWT는 제거했다.
- FFmpeg 7.1.5 최소 정적 빌드: [Release `video-tools-ffmpeg-7.1.5-1`](https://github.com/youwonsock/tool-utility/releases/tag/video-tools-ffmpeg-7.1.5-1). x264, dav1d, zlib을 포함한 원본 소스를 함께 게시했다.

| 런타임 | 파일 수 | 저장소 크기 | FFmpeg 아카이브 SHA-256 | manifest SHA-256 |
| --- | ---: | --- | --- | --- |
| windows-x64 | 1,631 | 182MB → 68MB | `bdd09d6f26f6222e01dc6b6c20d80f110a690954cf343eb3f4e58e3751c57fce` | `c5d51c974c9d19a4a674f18a3836db1249a0c4d48ec871a5da79464a5af6546a` |
| macos-arm64 | 1,714 | 146MB → 80MB | `f03e43acd223c60fef6ddb990753289bc219e7f2aa86a22436b9a604a64888f5` | `c59173c7cb28cec3f6ac861c2c01d9a629bd002a6b04ea3ba1fc4b99bb5f360c` |

경량화 브랜치의 새 clone은 약 513MB이고, 이 중 `.git`이 130MB, `video-tools`가 149MB, `path-analysis-tools`가 234MB다. `--depth 1` clone은 약 467MB다.

### 실행 결과

CI는 Windows Server 2025와 macOS 15.8.2에서 실행했다.

- [FFmpeg 빌드](https://github.com/youwonsock/tool-utility/actions/runs/41170129103): 두 OS의 새 FFmpeg로 smoke 검사 18개 항목과 코덱 샘플 14개 통과
- [런타임 재생성](https://github.com/youwonsock/tool-utility/actions/runs/41171551818): 두 OS의 `--refresh`와 smoke 검사 17개 항목 통과
- [커밋된 런타임](https://github.com/youwonsock/tool-utility/actions/runs/41172190715): 두 OS의 `--audit --git`과 smoke 검사 17개 항목 통과

macOS 26.6.2 ARM64에서 원격 저장소를 한글·공백이 포함된 경로에 새로 clone해 다음을 확인했다.

- `run_mac.command` 창 실행, `run_mcp.command` 초기화와 stdin 종료 후 종료 코드 0
- `--audit --git`, smoke 검사 18개 항목, 코덱 샘플 14개. 실행 후 Git 상태는 깨끗했다.
- clone한 파일에 격리 속성이 없어 브라우저 다운로드의 보안 승인 절차를 거치지 않는다.
- 실제 창의 위젯을 코드로 조작한 GUI 검사 19개 항목: PNG 추출, JPG 격자, 기존 파일 건너뛰기, 잘못된 입력, 추출 취소, 크롭·회전·반전·크기·배속·CRF 편집, 회전 영상, 음소거, 덮어쓰기 거부, 창 닫기, 설정 저장·복원

### 검증하지 않은 범위

- Windows의 실제 GUI 조작과 새 clone 실행은 결정에 따라 제외했다. Windows는 위 CI 결과만 확인했다.
- Mac의 마우스·키보드 입력, 화면 배치, 파일 선택 창과 알림 창은 확인하지 않았다. GUI 검사에서 두 대화 상자는 코드로 대체했다.
- `read_image`는 RGBA·팔레트·16비트 PNG와 JPG의 축소 동작만 확인했다. 색 비교는 하지 않았고, JPEG 설정이 Pillow 85에서 FFmpeg `-q:v 4`로 바뀌어 결과 바이트가 다르다.

### 지원 범위 변경

[런타임 관리](runtime-management.md#최소-ffmpeg) 목록 밖 코덱의 영상은 더 이상 열리지 않는다. 목록에 없는 오디오 코덱은 추출은 가능해도 음소거하지 않은 편집이 실패한다.

### 남은 개선 후보

- **Windows 경로 길이:** 저장소의 최장 경로가 181자여서 clone 위치가 깊으면 Git의 경로 길이 제한에 걸릴 수 있다. 배포하지 않는 pip의 고지가 `licenses/python-build-standalone/install` 아래에 중복되어 있어 줄일 수 있다.
- **`path-analysis-tools` 경량화:** 동봉 런타임이 234MB로 clone 크기의 가장 큰 부분이다. Pillow를 실제로 사용하므로 별도 측정이 필요하다.
- **Git 기록 용량:** `.git`이 130MB다. 기록을 다시 쓰지 않으면 줄지 않는다.
- **FFmpeg 소스 고정:** GitLab의 x264 아카이브는 바이트가 바뀔 수 있고, `zlib.net`은 새 버전이 나오면 이전 URL을 옮길 수 있다. 다운로드가 실패하면 같은 소스인지 확인한 뒤 다시 고정한다.
