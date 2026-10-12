# 영상 편집 MCP 서버

에이전트가 로컬 영상을 분석하고 편집할 수 있는 stdio MCP 서버입니다. 기존 GUI와 같은 프레임 추출 로직을 사용합니다. 서버와 MCP 클라이언트는 영상 파일에 접근할 수 있는 같은 컴퓨터에서 실행합니다.

## Windows 설치

Python 3.10 이상을 설치한 뒤 저장소의 `Vidio To Image` 폴더에서 실행합니다.

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install_mcp.ps1 -Workspace "D:\VideoWorkspace"
~~~

설치 스크립트가 다음을 수행합니다.

1. 프로젝트의 `.venv`에 GUI 및 MCP 의존성을 설치합니다.
2. 현재 Python·서버·작업 폴더의 절대 경로가 담긴 `mcp-config.local.json`을 생성합니다.
3. 생성된 설정의 `mcpServers.video-tools` 항목을 사용하는 MCP 클라이언트 설정에 합칩니다. 기존 다른 서버 항목은 유지합니다.
4. 클라이언트에서 MCP 서버를 다시 로드합니다.

3~4번은 사용하는 클라이언트의 설정 화면/파일에서 수행합니다. 설치 스크립트가 다른 앱의 설정을 자동으로 덮어쓰지는 않습니다. MCP 클라이언트가 command/args 입력 방식을 제공하면 생성된 JSON의 두 값을 그대로 사용합니다.

직접 실행할 때는 다음 명령을 사용합니다.

~~~powershell
.\run_mcp.bat --workspace "D:\VideoWorkspace"
~~~

stdio 서버는 클라이언트의 프로토콜 입력을 기다리므로 실행 후 일반 메뉴가 표시되지 않습니다. MCP 전용 서버의 stdout은 프로토콜 전용이며 설치 로그를 출력하지 않습니다.

## Linux/macOS

GUI의 공식 대상은 Windows이며, 공통 처리 계층과 stdio 서버는 다음과 같이 실행할 수 있습니다.

~~~bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-mcp.txt
.venv/bin/python configure_mcp.py --workspace "$PWD/media" --output mcp-config.local.json
.venv/bin/python video_to_image_mcp.py --workspace "$PWD/media"
~~~

FFmpeg는 PATH의 실행 파일을 우선 사용하며 없으면 `imageio-ffmpeg`의 실행 파일을 사용합니다. 특정 버전을 사용하려면 MCP 설정 args에 `--ffmpeg`와 실행 파일 경로를 추가하세요. ffprobe가 있으면 JSON 메타데이터를 사용하고, 없으면 FFmpeg의 정보 출력을 사용합니다. FFmpeg만 있는 환경에서는 영상 길이 표시의 정밀도가 낮을 수 있습니다.

서버는 공식 MCP Python SDK의 유지보수 중인 v1 계열 `mcp==1.30.0`을 사용합니다. 설치 버전을 고정해 v2의 API 변경과 분리했습니다. [공식 v1 문서](https://py.sdk.modelcontextprotocol.io/v1/)

## 도구

| 도구 | 역할 |
| --- | --- |
| `server_info` | 작업 폴더, 기능, 처리 제한 확인 |
| `list_media` | 지정 폴더의 하위 폴더·영상·이미지 목록 |
| `inspect_video` | 길이, 크기, FPS, 오디오, 회전 메타데이터 |
| `start_frame_extraction` | 개별 프레임 또는 2×2·3×3 격자 추출 시작 |
| `start_video_edit` | 구간·크롭·회전·반전·크기·배속·음소거 편집 시작 |
| `get_job` | 상태, 진행률, 오류, 결과 경로 조회 |
| `list_jobs` | 최근 작업 목록 |
| `cancel_job` | 작업 취소 요청 |
| `read_image` | 에이전트가 볼 수 있는 PNG/JPG 미리보기 반환 |

`start_*`는 완료 파일 대신 `job_id`를 즉시 반환합니다. `get_job`을 1~2초 간격으로 조회하고 `completed`의 `result`를 사용하세요. `failed`이면 `error`에 FFmpeg 원인 로그 또는 입력 오류가 들어갑니다.

작업 상태는 `queued → running → completed/failed`이며 취소 요청 시 `cancelling → cancelled`가 될 수 있습니다. 파일 저장 단계가 이미 시작된 작업은 완료로 끝날 수 있습니다. 서버 종료 시 대기·실행 작업을 취소하고 자식 프로세스를 정리합니다. 작업 기록은 메모리에 최대 100개 보관하며 재시작하면 초기화됩니다. 완성된 결과 파일은 남습니다.

## 에이전트 사용 예시

작업 폴더에 `input.mp4`를 넣고 다음과 같이 요청할 수 있습니다.

> input.mp4의 10초부터 25초까지를 잘라서 시계 방향 90도 회전하고, 1280×720에 비율을 유지해 맞춰줘. 소리는 제거하고 edited/clip.mp4로 저장한 다음, 결과에서 2초 간격의 3×3 요약 이미지를 만들어 확인해줘.

에이전트의 호출 순서는 다음과 같습니다.

1. `inspect_video`로 구간과 영상 크기를 확인합니다.
2. `start_video_edit`를 호출합니다.
3. `get_job`으로 완료 여부와 결과 파일을 확인합니다.
4. 결과 영상에 `start_frame_extraction`을 실행합니다.
5. 완료된 이미지 경로를 `read_image`에 전달해 확인합니다.

편집 요청 인자:

~~~json
{
  "video_path": "input.mp4",
  "output_path": "edited/clip.mp4",
  "start": 10,
  "end": 25,
  "rotation": 90,
  "width": 1280,
  "height": 720,
  "mute": true,
  "overwrite": false
}
~~~

추출 요청 인자:

~~~json
{
  "video_path": "edited/clip.mp4",
  "output_directory": "captures",
  "interval": 2,
  "grid_size": 3,
  "width": 1920,
  "height": 1080,
  "prefix": "clip_summary",
  "image_format": "jpg"
}
~~~

실제 영상 길이에 맞춰 start/end를 지정하세요. end를 생략하면 영상 끝까지 처리합니다.

## 동작 기준

- 모든 입력·출력 경로는 설정한 작업 폴더 안에 있어야 합니다. 상대 경로는 작업 폴더 기준이며, 바깥을 가리키는 절대 경로·상위 이동·심볼릭 링크는 거부합니다.
- 영상 편집 결과는 H.264/AAC MP4입니다. 원본 경로에 저장할 수 없습니다. 기존 결과를 바꾸려면 `overwrite=true`를 명시합니다.
- 이미지 추출의 `overwrite=false`는 기존 이름을 건너뛰며 `saved_count`, `skipped_count`로 구분합니다. `files`에는 이번에 저장한 파일만 들어갑니다.
- 편집 순서는 구간 자르기 → 크롭 → 시계 방향 회전 → 반전 → 크기 조절 → 배속입니다. `crop=[x,y,width,height]`는 입력 영상의 회전 메타데이터 적용 후 좌표를 사용합니다.
- width/height는 최종 출력 크기입니다. 비율을 유지하고 남는 영역을 여백으로 채웁니다. MP4의 지정 크기는 짝수여야 하며, 미지정 시 홀수 원본/크롭 크기는 다음 짝수로 패딩합니다.
- 배속은 0.25~4배이고 오디오 템포도 같이 변경합니다. `mute=true`는 오디오를 제거합니다. CRF 기본값은 20이며 낮을수록 화질과 파일 크기가 커집니다.
- 프레임 추출은 끝 시점을 제외합니다. 목표 시각 이전의 가장 최근 프레임을 선택하고, 시작 경계에서는 구간 안의 첫 프레임을 사용합니다. 마지막 격자의 남는 칸은 밝은 회색입니다.
- `read_image`는 최대 2048픽셀 범위로 축소한 미리보기를 반환하며 원본 이미지를 수정하지 않습니다.
- 최대 동시 작업 2개, 대기 포함 8개, 추출 샘플 10,000개, 이미지/영상 프레임당 64메가픽셀, FFmpeg 실행 시간 1시간으로 제한합니다.

## 검증

~~~powershell
python -m pip install -r requirements-mcp.txt
python -m unittest discover -v
~~~

테스트는 실제 합성 영상과 MCP stdio 클라이언트를 사용합니다. 파일 보존, 특수문자 접두사, 추출 시간, 부분 격자, JPG 해상도, 영상 편집·오디오, 취소, 작업 폴더 제한, 도구 목록·호출·이미지 반환을 검증합니다.

현재 연결된 클라이언트에 새 도구가 표시되지 않으면 생성된 설정의 Python 경로가 이 프로젝트의 가상환경인지 확인한 뒤 서버를 다시 시작하세요. 이 저장소를 내려받는 것만으로 이미 실행 중인 에이전트 세션에 도구가 자동 등록되지는 않습니다.

