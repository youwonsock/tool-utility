# Vidio To Image — 영상 이미지 추출 및 MCP 영상 편집

Vidio To Image는 **Windows·macOS용 이미지 추출·영상 편집 GUI와 에이전트용 MCP 서버를 함께 제공하는 영상 처리 도구**입니다. 동영상의 원하는 구간에서 PNG/JPG 프레임이나 2×2·3×3 격자 이미지를 추출하고, MCP를 연결한 에이전트는 영상 정보 조회부터 구간 자르기·크롭·회전·반전·크기 조절·배속·음소거까지 수행할 수 있습니다.

| 제공 방식 | 지원 기능 | 시작하기 |
| --- | --- | --- |
| Windows·Mac GUI | 이미지 추출·격자 합성·영상 편집·진행률·취소 | [GUI 설치 및 실행](#gui-설치-및-실행), [GUI 사용 방법](#gui-사용-방법) |
| 로컬 MCP 서버 (`video-tools`, stdio) | 에이전트가 9개 도구로 영상 분석·이미지 추출·영상 편집·작업 관리·결과 이미지 확인 | [MCP 설정 및 사용](#mcp-설정-및-사용), [MCP 도구 명세](#mcp-도구-명세) |

GUI와 MCP는 공용 영상 처리 서비스와 작업 관리 코드를 사용합니다. GUI의 이미지 추출·영상 편집 탭에서 직접 작업하거나, GUI 없이 MCP 서버를 통해 에이전트가 작업할 수 있습니다. 작업 기록은 각 프로세스에서 독립적으로 관리합니다. 이 문서에서 두 사용 방식의 설치, 설정, 사용법을 함께 안내합니다.

## GUI 주요 기능

- 시작 시간, 끝 시간, 양의 실수 초 단위 추출 간격 지정
- 개별 이미지 저장 또는 `2 × 2`, `3 × 3` 격자 합성
- 최종 이미지 해상도 또는 격자 셀 이미지 크기 기준 선택
- 원본 비율을 유지한 축소·확대와 여백 처리
- 현재 설정을 반영한 합성 샘플 미리보기
- PNG/JPG 형식, 저장 폴더, 파일명 접두사, 기존 파일 덮어쓰기 설정
- FFmpeg 작업 진행률 표시와 추출 취소
- 설정을 `%APPDATA%\VideoToImage\settings.json`에 저장

## 설치 없는 배포본 실행

최종 사용자에게는 소스 대신 운영체제에 맞는 ZIP을 제공합니다. 압축을 해제하면 Python, FFmpeg, MCP SDK 설치나 최초 실행 다운로드 없이 실행할 수 있습니다. 필요한 런타임과 FFmpeg는 GUI·MCP 실행기가 같은 배포본 안에서 공유합니다. 실행 파일만 따로 복사하지 말고 배포 폴더 또는 Mac 앱 전체를 이동하세요.

| 배포 파일 | GUI 실행 | MCP 실행 파일 |
|---|---|---|
| `VideoToImage-win64.zip` | `VideoToImage.exe` 더블클릭 | 같은 폴더의 `video-tools-mcp.exe` |
| `VideoToImage-macos-arm64.zip` | `VideoToImage.app` 더블클릭 | `VideoToImage.app/Contents/MacOS/video-tools-mcp` |
| `VideoToImage-macos-x86_64.zip` | `VideoToImage.app` 더블클릭 | `VideoToImage.app/Contents/MacOS/video-tools-mcp` |

Mac은 내부용 ad-hoc 서명 배포입니다. 최초 실행 시 macOS의 보안 승인이 필요할 수 있으며, 시스템 설정 → 개인정보 보호 및 보안에서 해당 앱의 실행을 승인합니다. 보안 기능을 전체적으로 끄지 않습니다. 임의 경로로 실행되는 App Translocation 상태에서도 앱 내부 리소스를 사용하며, MCP 설정을 만들 때는 실제 배포 위치를 선택하세요.

GUI의 **MCP 연결 설정**에서 영상 작업 폴더를 선택하고 JSON을 복사·저장한 뒤 사용하는 MCP 클라이언트에 등록합니다. 배포본을 옮기면 설정을 다시 생성하세요. 서버 설치나 GUI 실행은 필요하지 않습니다. 등록 설정은 네이티브 MCP 실행 파일과 `--workspace` 인자를 사용합니다.

Windows 설정은 기존 `%APPDATA%/VideoToImage/settings.json`에, Mac 설정은 `~/Library/Application Support/VideoToImage/settings.json`에 저장합니다. 이전 Mac의 `~/AppData/Roaming/VideoToImage/settings.json`은 새 설정이 없을 때 가져오며 원본은 보존합니다.

## GUI 영상 편집

공통 영상 파일과 처리 구간을 선택한 뒤 **영상 편집** 탭에서 결과 MP4 경로, 크롭, 회전, 반전, 출력 크기, 배속, 음소거, CRF를 지정합니다. 크롭 좌표는 자동 회전 적용 후 원본 영상 픽셀 기준입니다. 크기를 지정하면 비율을 유지하고 여백을 추가합니다. 출력은 H.264/AAC MP4이며 원본과 같은 경로를 사용할 수 없습니다.

기본값은 크롭·크기 조절 없음, 회전 0도, 배속 1배, CRF 20, 반전·음소거·덮어쓰기 꺼짐입니다. 진행률·취소·결과 경로를 표시하며, Mac의 Command+Q도 작업을 정리하고 설정을 저장합니다. GUI 미리보기는 추출 배치를 보여주는 합성 샘플이며 실제 영상 플레이어가 아닙니다.

## 개발자의 소스 실행

다음 설치 명령과 실행 스크립트는 **개발 환경용**입니다. 위 ZIP 사용자는 실행할 필요가 없습니다.

### Mac 소스 실행

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-mcp.txt
.venv/bin/python video_to_image.py
```

Tk가 포함된 Python이 필요합니다. 단순 import 대신 실제 Tk 창 생성으로 환경을 확인하세요.

### Windows 소스 실행

### 간편 실행

1. `run.bat`을 실행합니다.
2. `dist\VideoToImage\VideoToImage.exe`가 있으면 패키징된 프로그램을 바로 실행합니다.
3. 패키지된 실행 파일이 없으면 `.venv`가 있는지 확인하고, 처음 실행할 때 `install.ps1`을 통해 가상환경과 의존성을 준비합니다.
4. 프로그램에서 동영상 파일을 선택합니다.

소스에서 직접 설치하려면 PowerShell에서 실행합니다.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install.ps1
```

`install.ps1`은 현재 PATH에 등록된 Python으로 `.venv`를 만들고 `requirements.txt`를 설치합니다. 소스 실행에는 Python 3.10 이상을 권장합니다.

## GUI 사용 방법

### 1. 동영상 선택

`찾아보기`에서 MP4 파일을 선택합니다. 파일을 분석하면 영상 길이와 FFmpeg 준비 상태가 표시되고, 끝 시간은 영상 길이로 자동 설정됩니다. 파일명에서 확장자를 제외한 이름이 기본 파일명 접두사에도 반영됩니다.

### 2. 추출 구간 지정

시간은 초 또는 다음 형식으로 입력할 수 있습니다.

- `90` → 90초
- `01:30` → 1분 30초
- `00:01:30.500` → 1분 30.5초

끝 시점은 포함하지 않습니다. 예를 들어 `00:00:00`부터 `00:00:04`까지 간격 `0.5`초를 지정하면 0, 0.5, 1.0, ... 3.5초 프레임을 처리합니다. 끝 시간은 영상 길이를 넘을 수 없고, 추출 간격은 0보다 커야 합니다.

정확한 기준은 `시작 + 순번 × 간격 < 끝`인 목표 시각입니다. 각 목표 시각 이전의 가장 최근 프레임을 선택하며, 시작 경계에서는 구간 안의 첫 프레임을 사용합니다. 원본 프레임 시각과 목표 시각이 다르면 같은 프레임이 반복될 수 있습니다. 최소 간격은 0.001초, 한 작업의 최대 샘플 수는 10,000개입니다. 구간 안에 디코딩 가능한 프레임이 없으면 결과가 0장일 수 있습니다.

### 3. 저장 설정

- `저장 폴더`: 결과 이미지를 저장할 폴더입니다. 없으면 추출 시작 시 생성합니다.
- `파일명 앞부분`: 기본 형식은 동영상 이름을 포함한 `<동영상이름>_frame`입니다.
- `형식`: `PNG` 또는 `JPG`를 선택합니다.
- `기존 파일 덮어쓰기`: 끄면 같은 이름의 기존 파일을 건너뛰고, 켜면 교체합니다.

FFmpeg 결과는 임시 폴더에 먼저 생성한 뒤 파일별로 저장합니다. 덮어쓰기를 끄면 이미 존재하는 파일을 배타적 생성으로 보호합니다. 완료 수는 실제 저장한 이미지 수이며, 건너뛴 파일 수를 별도로 표시합니다. `%`, `[]`, 한글이 포함된 접두사도 그대로 사용할 수 있습니다.

결과 파일은 다음 형식으로 저장됩니다.

```text
<파일명 앞부분>_0001.png
<파일명 앞부분>_0002.png
```

### 4. 출력 방식과 이미지 크기

#### 개별 이미지 저장

추출한 각 프레임을 하나의 이미지 파일로 저장합니다. 격자 크기 설정은 사용하지 않습니다.

#### 격자 합치기

추출 프레임을 순서대로 `2 × 2` 또는 `3 × 3` 한 장에 배치합니다. 셀 사이 간격과 바깥 여백은 각각 6px이며, 빈 공간은 밝은 회색으로 채워집니다.

끝 구간에서 부족한 칸은 빈칸으로 남깁니다. 구간 밖 프레임으로 격자를 채우지 않습니다. PNG와 JPG 모두 지정한 최종 크기를 유지합니다.

#### 최종 이미지 해상도

격자와 여백을 포함한 최종 파일 크기를 지정합니다.

- `1920 × 1080`
- `2048 × 2048`
- `4096 × 4096`
- `사용자 지정`

#### 격자 셀 이미지 크기

각 셀의 크기를 지정합니다. 다음 프리셋과 사용자 지정 크기를 사용할 수 있습니다.

- `원본`
- `1920 × 1080`
- `1280 × 720`
- `854 × 480`
- `640 × 360`
- `사용자 지정`

격자 모드에서 셀 크기를 직접 지정하면 최종 크기는 다음과 같이 계산됩니다.

```text
최종 너비 = 열 수 × 셀 너비 + (열 수 - 1) × 6 + 2 × 6
최종 높이 = 행 수 × 셀 높이 + (행 수 - 1) × 6 + 2 × 6
```

영상은 원본 비율을 유지한 채 셀 안에 맞춰지고 남는 영역은 여백으로 처리됩니다.

### 5. 미리보기와 추출

저장 설정 아래의 미리보기는 실제 동영상이나 FFmpeg를 실행하지 않고, 현재 출력 방식·격자·크기 설정을 반영한 합성 샘플을 보여줍니다. 설정을 바꾸면 자동으로 갱신됩니다.

설정을 확인한 뒤 `이미지 추출 시작`을 누르면 백그라운드에서 FFmpeg가 실행됩니다. 진행 중에는 `취소`로 작업을 중단할 수 있습니다.

인코딩 중 취소하면 임시 결과를 정리합니다. 결과 파일 저장 단계가 이미 시작되었다면 저장을 마친 뒤 완료로 보고합니다. FFmpeg가 실패하면 원인 로그를 오류 메시지에 포함합니다.

## MCP 설정 및 사용

이 툴에 포함된 `video_to_image_mcp.py`는 **MCP(Model Context Protocol) 서버**입니다. 에이전트는 MCP 클라이언트에 `video-tools` 서버를 등록한 뒤 아래의 9개 도구를 호출할 수 있습니다. 영상 파일에 접근할 수 있는 같은 컴퓨터에서 로컬 stdio 서버를 실행할 수 있는 클라이언트가 필요합니다.

Python 3.10 이상을 설치하고, 아래 명령은 저장소의 `Vidio To Image` 폴더에서 실행합니다. `--workspace`는 에이전트가 읽고 쓸 영상 작업 폴더입니다. 편집할 원본 영상을 이 폴더 안에 넣으세요.

### Windows 설치

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install_mcp.ps1 -Workspace "D:\VideoWorkspace"
```

설치 스크립트는 프로젝트의 `.venv`에 GUI 및 MCP 의존성을 설치하고, 현재 Python·서버·작업 폴더의 절대 경로가 담긴 `mcp-config.local.json`을 생성합니다. 생성 후에는 아래 [클라이언트 연결](#클라이언트-연결)을 진행합니다.

### Linux/macOS 설치

소스에서 GUI 또는 MCP 서버를 개발·실행하려면 다음과 같이 환경을 준비합니다. 배포본 사용자에게는 이 설치가 필요하지 않습니다.

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-mcp.txt
.venv/bin/python configure_mcp.py --workspace "$PWD/media" --output mcp-config.local.json
```

### 클라이언트 연결

1. 생성된 `mcp-config.local.json`을 엽니다.
2. `mcpServers.video-tools` 항목을 사용하는 MCP 클라이언트의 설정에 합칩니다. 기존 다른 서버 항목은 유지합니다. 클라이언트가 `command`/`args` 입력 방식을 제공하면 생성된 JSON의 두 값을 그대로 사용합니다.
3. 클라이언트에서 MCP 서버를 다시 로드하거나 클라이언트를 다시 시작합니다.
4. 도구 목록에 아래의 9개 도구가 표시되는지 확인하고, `server_info`로 작업 폴더와 `transport: "stdio"`를 확인합니다. `list_media`로 작업 폴더의 영상을 조회할 수 있습니다.

생성되는 설정의 형식은 다음과 같습니다. 경로는 예시이므로 직접 복사하기보다 설치 스크립트나 `configure_mcp.py`가 생성한 실제 경로를 사용하세요.

```json
{
  "mcpServers": {
    "video-tools": {
      "command": "C:\\tools\\tool-utility\\Vidio To Image\\.venv\\Scripts\\python.exe",
      "args": [
        "C:\\tools\\tool-utility\\Vidio To Image\\video_to_image_mcp.py",
        "--workspace",
        "D:\\VideoWorkspace"
      ]
    }
  }
}
```

설치 스크립트는 연결용 설정 파일을 생성하며, 클라이언트에 등록하는 단계는 해당 앱의 설정 화면/파일에서 수행합니다. 저장소를 내려받거나 GUI를 실행하는 것만으로 에이전트에 MCP 도구가 자동 등록되지는 않습니다. GUI용 EXE/ZIP과 별도로 위 Python 환경과 서버 실행 설정을 사용합니다.

### 서버 직접 실행 및 FFmpeg 설정

일반적인 MCP 사용에서는 클라이언트가 설정의 `command`와 `args`로 서버를 실행합니다. 직접 실행하려면 다음 명령을 사용합니다.

```powershell
.\run_mcp.bat --workspace "D:\VideoWorkspace"
```

Linux/macOS에서는 다음과 같이 실행합니다.

```bash
.venv/bin/python video_to_image_mcp.py --workspace "$PWD/media"
```

stdio 서버는 클라이언트의 프로토콜 입력을 기다리므로 실행 후 일반 메뉴가 표시되지 않습니다. MCP 전용 서버의 stdout은 프로토콜 전용이며 설치 로그를 출력하지 않습니다.

FFmpeg는 PATH의 실행 파일을 우선 사용하며 없으면 `imageio-ffmpeg`의 실행 파일을 사용합니다. 특정 버전을 사용하려면 MCP 설정의 `args`에 `--ffmpeg`와 실행 파일 경로를 추가하세요. ffprobe가 있으면 JSON 메타데이터를 사용하고, 없으면 FFmpeg의 정보 출력을 사용합니다. FFmpeg만 있는 환경에서는 영상 길이 표시의 정밀도가 낮을 수 있습니다.

서버는 공식 MCP Python SDK의 `mcp==1.30.0`을 사용하며, 버전은 `requirements-mcp.txt`에 고정되어 있습니다. [공식 v1 문서](https://py.sdk.modelcontextprotocol.io/v1/)

### MCP 도구 명세

| 도구 | 주요 입력 | 역할 및 반환 내용 |
| --- | --- | --- |
| `server_info` | 없음 | 작업 폴더, 전송 방식, 기능, 처리 제한 확인 |
| `list_media` | `directory="."`, `limit=100` | 지정 폴더 바로 아래의 하위 폴더·영상·이미지 목록과 목록 잘림 여부 |
| `inspect_video` | `video_path` | 길이, 크기, FPS, 오디오, 회전 메타데이터 |
| `start_frame_extraction` | `video_path`, `output_directory`, 추출 옵션 | 개별 프레임 또는 2×2·3×3 격자 추출 작업 시작, `job_id` 반환 |
| `start_video_edit` | `video_path`, `output_path`, 편집 옵션 | 구간·크롭·회전·반전·크기·배속·음소거 편집 작업 시작, `job_id` 반환 |
| `get_job` | `job_id` | 작업 상태, 진행률, 오류, 결과 경로 조회 |
| `list_jobs` | 없음 | 최근 작업 목록 |
| `cancel_job` | `job_id` | 작업 취소 요청 및 현재 상태 반환 |
| `read_image` | `image_path`, `max_width=1280` | 에이전트가 확인할 수 있도록 PNG/JPG 파일의 미리보기를 MCP 이미지 콘텐츠로 반환 |

공통 시간 옵션은 초 단위 `start=0`, `end=null`이며, `end`를 생략하면 영상 끝까지 처리합니다. `width`와 `height`는 함께 지정하거나 둘 다 생략합니다. `overwrite=false`가 기본값입니다.

- 이미지 추출 옵션: `interval=1`, `grid_size=1`(개별), `2`(2×2), `3`(3×3), `width`, `height`, `image_format="png"` 또는 `"jpg"`, `prefix="frame"`. 크기를 생략하면 원본 프레임/셀 크기를 사용합니다.
- 영상 편집 옵션: `crop=[x,y,width,height]`, `rotation=0`/`90`/`180`/`270`, `flip_horizontal=false`, `flip_vertical=false`, `width`, `height`, `speed=1`, `mute=false`, `crf=20`.

### 작업 상태와 결과 확인

`start_*`는 완료 파일 대신 `job_id`를 즉시 반환합니다. `get_job`을 1~2초 간격으로 조회하고 `status`가 `completed`이면 `result`를 사용하세요. `failed`이면 `error`에 FFmpeg 원인 로그 또는 입력 오류가 들어갑니다.

이미지 추출의 `result.files`는 이번에 저장한 이미지 경로 목록이며, `saved_count`와 `skipped_count`로 저장/건너뛰기 개수를 구분합니다. 영상 편집 결과 경로는 `result.output_path`입니다. 결과 경로는 작업 폴더 기준이며, 다음 도구 호출의 입력으로 사용할 수 있습니다.

작업 상태는 `queued → running → completed/failed`이며 취소 요청 시 `cancelling → cancelled`가 될 수 있습니다. 파일 저장 단계가 이미 시작된 작업은 완료로 끝날 수 있습니다. 서버 종료 시 대기·실행 작업을 취소하고 자식 프로세스를 정리합니다. 작업 기록은 메모리에 최대 100개 보관하며 재시작하면 초기화됩니다. 완성된 결과 파일은 남습니다.

### 에이전트 사용 예시

작업 폴더에 `input.mp4`를 넣고 다음과 같이 요청할 수 있습니다.

> input.mp4의 10초부터 25초까지를 잘라서 시계 방향 90도 회전하고, 1280×720에 비율을 유지해 맞춰줘. 소리는 제거하고 edited/clip.mp4로 저장한 다음, 결과에서 2초 간격의 3×3 요약 이미지를 만들어 확인해줘.

에이전트의 호출 순서는 다음과 같습니다.

1. `inspect_video`로 구간과 영상 크기를 확인합니다.
2. `start_video_edit`를 호출합니다.
3. `get_job`으로 완료 여부와 `result.output_path`를 확인합니다.
4. 결과 영상에 `start_frame_extraction`을 실행하고, 해당 `job_id`를 `get_job`으로 조회해 완료를 기다립니다.
5. `result.files`의 이미지 경로를 `read_image`에 전달해 확인합니다.

`start_video_edit` 요청 인자:

```json
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
```

`start_frame_extraction` 요청 인자:

```json
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
```

실제 영상 길이에 맞춰 `start`/`end`를 지정하세요. 위 예시는 원본 길이가 25초 이상일 때 사용할 수 있습니다.

### MCP 동작 기준 및 제한

- 모든 입력·출력 경로는 설정한 작업 폴더 안에 있어야 합니다. 상대 경로는 작업 폴더 기준이며, 폴더 바깥을 가리키는 절대 경로·상위 이동·심볼릭 링크는 거부합니다.
- 영상 편집 결과는 H.264/AAC MP4입니다. 원본 경로에 저장할 수 없습니다. 기존 결과를 바꾸려면 `overwrite=true`를 명시합니다.
- 이미지 추출의 `overwrite=false`는 기존 이름을 건너뛰며 `saved_count`, `skipped_count`로 구분합니다. `files`에는 이번에 저장한 파일만 들어갑니다.
- 편집 순서는 구간 자르기 → 크롭 → 시계 방향 회전 → 반전 → 크기 조절 → 배속입니다. `crop=[x,y,width,height]`는 입력 영상의 회전 메타데이터 적용 후 좌표를 사용합니다.
- `width`/`height`는 최종 출력 크기입니다. 비율을 유지하고 남는 영역을 여백으로 채웁니다. MP4의 지정 크기는 짝수여야 하며, 미지정 시 홀수 원본/크롭 크기는 다음 짝수로 패딩합니다.
- 배속은 0.25~4배이고 오디오 템포도 같이 변경합니다. `mute=true`는 오디오를 제거합니다. CRF 기본값은 20이며 낮을수록 화질과 파일 크기가 커집니다.
- 편집 영상은 원본 FPS 기준의 고정 프레임률로 저장합니다. FPS를 읽을 수 없으면 30FPS를 사용합니다. 영상 길이는 출력 프레임 간격 단위로 반올림될 수 있습니다.
- 프레임 추출은 끝 시점을 제외합니다. 목표 시각 이전의 가장 최근 프레임을 선택하고, 시작 경계에서는 구간 안의 첫 프레임을 사용합니다. 마지막 격자의 남는 칸은 밝은 회색입니다.
- `read_image`는 `max_width`(64~2048, 기본 1280)를 가로·세로 상한으로 삼아 축소한 미리보기를 반환하며 원본 이미지를 수정하지 않습니다. `list_media`의 `limit`은 1~500입니다.
- 최대 동시 작업 2개, 대기 포함 8개, 추출 샘플 10,000개, 이미지/영상 프레임당 64메가픽셀, FFmpeg 실행 시간 1시간으로 제한합니다.

## 개발자의 배포 빌드 및 검증

네이티브 Windows x64, Mac arm64 또는 Mac x86_64에서 Python **3.14.6**과 Tk를 준비하고 다음 명령을 사용합니다. 단일 공용 Spec이 GUI·MCP 실행기와 공유 런타임을 수집합니다. 운영체제별 어댑터에는 설정·글꼴·입력·프로세스 처리 차이만 둡니다.

```bash
python -m venv .venv
# Windows에서는 .venv/Scripts/python.exe 사용
.venv/bin/python -m pip install -r requirements-release.txt
.venv/bin/python build_portable.py --package
.venv/bin/python verify_portable.py
```

기존 Windows `build.ps1`, `package.ps1`과 Mac `build_mac.sh`는 동일한 공용 빌드 코드를 호출합니다. 생성물은 `dist/`에 저장되며 ZIP SHA-256도 기록합니다. 배포본은 내장 FFmpeg만으로 정보를 조회하므로 외부 ffprobe가 없어도 동일하게 동작합니다.

라이선스와 빌드 기록은 Windows `_internal/licenses`, Mac `Contents/Resources/licenses`에서 확인합니다. 실제 FFmpeg 버전·빌드 설정·바이너리 해시·원본 제공처·소스 릴리스 정보를 기록합니다. FFmpeg의 GPL 구성요소와 각 패키지 고지를 유지해야 합니다.

`verify_portable.py`는 한글·공백이 있는 임시 경로에 배포본을 복사하고 외부 Python/FFmpeg/ffprobe 경로를 제거한 환경에서 GUI 자체 검사와 실제 MCP 연결·미디어·취소·종료를 검증합니다. 결과는 `test-output/portable-verification.json`과 `gui-portable.json`입니다. 개발용 `--self-test-report <경로>`는 사용자 설정 대신 임시 설정을 사용합니다.

검증 목표, 발견 문제, 수정과 재검증 기록은 [IMPLEMENTATION.md](IMPLEMENTATION.md)에 기록합니다.

## 문제 해결

- `FFmpeg 실행 파일을 찾지 못했습니다`가 표시되면 `.venv`가 활성화된 상태인지 확인하고 `install.ps1`을 다시 실행합니다.
- 동영상 분석이 실패하면 FFmpeg가 읽을 수 있는 파일인지, 파일 경로에 접근할 수 있는지 확인합니다.
- 기존 파일을 덮어쓰지 않으려면 `기존 파일 덮어쓰기`를 끈 상태로 실행합니다. 이 경우 새로 생성된 파일만 완료 수에 포함됩니다.
- 출력 폴더를 저장소 안에 지정하면 생성된 이미지가 많아질 수 있으므로, 개발 저장소에서는 `test-output`, `resolution-test`, `mosaic-test`, `packaging-feature-test` 같은 테스트 출력 폴더를 사용합니다.
- MCP 도구가 표시되지 않으면 `mcp-config.local.json`의 Python 경로가 이 프로젝트의 가상환경인지 확인하고, [클라이언트 연결](#클라이언트-연결)에 따라 설정을 등록한 뒤 서버를 다시 시작합니다.
- MCP에서 파일을 찾지 못하거나 작업 폴더 오류가 나면 `server_info`의 `workspace`와 입력 경로를 확인합니다. 상대 경로는 저장소가 아니라 해당 작업 폴더를 기준으로 해석합니다.

## 개발자 확인

| 파일 | 역할 |
| --- | --- |
| `video_to_image.py` | Tkinter 화면과 사용자 동작 조정 |
| `video_to_image_domain.py` | 시간·크기·격자 계산 및 FFmpeg 필터 생성 |
| `video_to_image_settings.py` | 설정 저장과 이전 설정 형식 변환 |
| `video_to_image_media.py` | FFmpeg 탐색·분석·추출 및 백그라운드 이벤트 |
| `video_to_image_backend.py` | 프로세스 실행·종료, 메타데이터, 완료 파일 저장 |
| `video_to_image_edit.py` | MP4 구간·크롭·회전·크기·배속·오디오 편집 |
| `video_to_image_jobs.py` | 작업 ID, 진행 상태, 취소, 제한된 작업 큐 |
| `video_to_image_mcp.py` | 에이전트용 stdio MCP 도구 9개 |
| `configure_mcp.py` | 현재 Python 환경의 절대 경로를 사용하는 MCP 클라이언트 설정 생성 |
| `install_mcp.ps1`, `run_mcp.bat` | Windows MCP 의존성 설치·설정 생성 및 서버 실행 |
| `video_to_image_preview.py` | 결과물 미리보기 Canvas 렌더링 |

회귀 테스트는 다음 명령으로 실행합니다.

```powershell
python -m unittest discover -v
```

실제 FFmpeg 및 MCP 연결 테스트까지 실행하려면 먼저 `python -m pip install -r requirements-mcp.txt`를 실행하세요. 합성 영상과 MCP stdio 클라이언트로 파일 보존, 특수문자 접두사, 추출 시점, 끝 구간·부분 격자, JPG 크기, 영상 편집·오디오, 취소, 작업 폴더 제한, 도구 목록·호출·이미지 반환을 검사합니다. 의존성이 없는 MCP/이미지 통합 테스트는 건너뜁니다. GitHub Actions에서는 Windows·Linux·Mac arm64·Mac x86_64에서 회귀 검사를 실행하고, Windows와 Mac에서는 네이티브 배포본까지 검증합니다. GUI 검사에는 `VIDEO_TOOLS_GUI_TESTS=1`을 지정합니다.

