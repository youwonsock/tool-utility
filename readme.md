# tool-utility

Unreal 플러그인과 Unity Editor 도구에서 분리된 기타 작업 편의 도구를 보관하는 Git 저장소입니다.

각 최상위 툴 폴더는 독립적으로 사용할 수 있도록 자체 README와 전용 무시 규칙을 가집니다. 저장소 루트에서는 공통 빌드나 설치를 수행하지 않고, 필요한 툴 폴더의 문서를 따라 사용합니다.

## 보관 중인 툴

| 툴 | 요약 | 문서 |
| --- | --- | --- |
| Vidio To Image | Windows에서 MP4의 지정 구간을 PNG/JPG 프레임 또는 2×2·3×3 격자 이미지로 추출하는 GUI 도구 | [툴 README](<./Vidio To Image/README.md>) |
| Codex–OpenCode | Codex의 계획·검수와 OpenCode의 구현·테스트를 분리하는 로컬 플러그인 및 MCP 서비스 | [툴 README](./codex-opencode/README.md) |

## 폴더 운영

- 툴별 소스, 의존성, 실행 방법은 각 툴 폴더 안에서 관리합니다.
- 엔진 생성물, 가상환경, 빌드 결과물, 테스트 출력물은 각 폴더의 무시 규칙으로 제외합니다.
- 새로운 기타 툴은 독립 실행에 필요한 README와 전용 무시 규칙을 갖춘 최상위 폴더로 추가합니다.
