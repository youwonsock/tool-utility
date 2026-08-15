# etc-editor-tools

여러 프로젝트에서 재사용하는 에디터 플러그인과 작업 편의 도구를 한곳에 보관하는 Git 저장소입니다.

각 최상위 툴 폴더는 독립적으로 사용할 수 있도록 자체 README와 `.gitignore`를 가집니다. 저장소 루트에서는 공통 빌드나 설치를 수행하지 않고, 필요한 툴 폴더의 문서를 따라 사용합니다.

## 보관 중인 툴

| 툴 | 요약 | 문서 |
| --- | --- | --- |
| `Unreal_FBX_Exporter` | Unreal Engine Content Browser에서 Static Mesh를 FBX와 PBR 텍스처 세트로 내보내는 Editor 플러그인 | [툴 README](<./Unreal_FBX_Exporter/README.md>) |
| `Vidio To Image` | Windows에서 MP4의 지정 구간을 PNG/JPG 프레임 또는 2×2·3×3 격자 이미지로 추출하는 GUI 도구 | [툴 README](<./Vidio To Image/README.md>) |

## 폴더 운영

- 툴별 소스, 의존성, 실행 방법은 각 툴 폴더 안에서 관리합니다.
- 엔진 생성물, 가상환경, 빌드 결과물, 테스트 출력물은 각 폴더의 `.gitignore`로 제외합니다.
- 새로운 툴을 추가할 때는 독립 실행에 필요한 README와 전용 `.gitignore`를 함께 추가합니다.
