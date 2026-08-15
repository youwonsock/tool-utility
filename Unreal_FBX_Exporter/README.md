# FBX_Exporter

Unreal Engine 5.8용 Editor 전용 플러그인입니다. Content Browser에서 선택한 Static Mesh를 FBX와 PBR 텍스처 세트로 내보내 Unity 등 외부 툴에서 후처리할 수 있게 합니다.

## 주요 기능

- 여러 Static Mesh를 한 번에 내보냅니다.
- 선택한 메시마다 별도의 폴더와 FBX 파일을 생성합니다.
- 머티리얼을 베이크해 `BaseColor`, `Normal`, `Mask`, `Occlusion`, `Emission`, `Opacity` 계열 텍스처를 PNG로 저장합니다.
- PBR 베이크 해상도 `512`, `1024`, `2048`, `4096`을 지원하며 기본값은 `2048`입니다.
- 머티리얼에 직접 연결된 원본 Texture2D를 사용할 수 있는 경우 재사용할 수 있습니다.
- 마지막 출력 폴더를 프로젝트 설정에 저장하고 다음 실행 때 다시 사용합니다.
- 기존 메시 폴더를 덮어쓸 때 확인하며, 내보내기 중 오류가 발생하면 기존 파일을 복원하도록 임시 스테이징을 사용합니다.

Unreal 에셋 자체는 수정하지 않습니다. Unity 머티리얼, Unity 메타데이터, 머티리얼 설정 파일은 생성하지 않으므로 외부 툴에서 직접 구성해야 합니다.

## 출력 결과

출력 루트 아래에 메시 이름별 폴더가 생성됩니다. 파일명에 사용할 수 없는 문자는 `_`로 바뀝니다.

```text
<출력 루트>/
└─ <메시 이름>/
   ├─ <메시 이름>.fbx
   └─ Textures/
      ├─ <머티리얼 슬롯>_BaseColor.png
      ├─ <머티리얼 슬롯>_Normal.png
      ├─ <머티리얼 슬롯>_Mask.png
      ├─ <머티리얼 슬롯>_Occlusion.png
      ├─ <머티리얼 슬롯>_Emission.png
      └─ <머티리얼 슬롯>_Opacity.png
```

메시가 Masked 블렌드 모드이면 마지막 파일 이름은 `OpacityMask.png`가 됩니다. `BaseColor`의 알파 채널에도 opacity 값이 기록됩니다.

`Mask.png`의 채널은 다음과 같이 구성됩니다.

| 채널 | 값 |
| --- | --- |
| R | Metallic |
| G | Ambient Occlusion |
| B | `255` 고정값 |
| A | `1 - Roughness`로 계산한 Smoothness |

## 설치 및 프로젝트 연결

현재 저장소에서 사용하는 외부 플러그인 배치 예시는 다음과 같습니다.

```text
C:\GitRepo\
├─ Unreal_Portfolio\Haven\
├─ AssetImportProject\AssetImportProject\
└─ etc-editor-tools\Unreal_FBX_Exporter\
```

프로젝트가 플러그인을 외부 폴더에서 찾도록 `.uproject`에 다음 설정을 추가합니다.

```json
"AdditionalPluginDirectories": [
    "../../etc-editor-tools"
]
```

프로젝트 위치가 다르면 `AdditionalPluginDirectories`의 경로를 `Unreal_FBX_Exporter` 폴더를 포함하는 외부 툴 디렉터리에 맞게 조정합니다. Unreal Editor가 플러그인을 발견하지 못하면 프로젝트 파일을 다시 생성한 후 Editor를 재시작합니다.

## 사용 방법

1. Unreal Engine 5.8 프로젝트에서 플러그인이 로드되었는지 확인합니다.
2. Content Browser에서 내보낼 Static Mesh 하나 이상을 선택합니다. 여러 에셋을 선택할 때는 모두 Static Mesh여야 합니다.
3. 마우스 오른쪽 버튼을 클릭하고 `Asset Actions` → `FBX_Exporter` → `Export Static Meshes + Textures`를 선택합니다.
4. 출력 루트 폴더를 입력하거나 `Browse...`로 선택합니다.
5. `PBR Bake Resolution`에서 텍스처 해상도를 선택합니다.
6. 필요하면 `Reuse directly connected source textures when available` 옵션을 끕니다.
7. `Export`를 누릅니다.

출력 폴더를 지정하지 않으면 기본값은 프로젝트 폴더 아래의 `Exports/StaticMeshTextures`입니다. 한 번 선택한 경로는 프로젝트별 Editor 설정에 저장됩니다. 같은 메시 폴더가 이미 있으면 기존 FBX와 관련 텍스처를 교체할지 묻습니다.

## 내보내기 동작과 제한

- 메뉴는 선택 항목이 모두 로드 가능한 Static Mesh일 때만 표시됩니다. 텍스처나 머티리얼을 함께 선택하거나 다른 에셋을 섞으면 메뉴가 표시되지 않을 수 있습니다.
- 메시의 유효한 LOD0 렌더 데이터와 UV0가 필요합니다.
- 머티리얼 슬롯에 할당된 머티리얼이 없으면 해당 슬롯의 텍스처는 생성되지 않고 경고가 표시됩니다.
- FBX는 바이너리 형식으로 저장되며 Vertex Color를 포함합니다. LOD, Collision, Source Mesh는 FBX 옵션에서 내보내지 않습니다.
- Runtime Virtual Texture, Substrate Front Material, Custom HLSL을 사용하는 머티리얼은 경고가 표시될 수 있으며, 외부 툴에서 사용할 수 있는 베이크된 PBR 텍스처만 생성됩니다.
- 서로 다른 선택 에셋이 같은 안전한 출력 폴더 이름으로 변환되면 충돌 방지를 위해 배치 내보내기가 중단됩니다.

## 테스트

Unreal Automation Tests가 다음 영역을 검증합니다.

- 파일명 안전화
- Metallic/Ambient Occlusion/Roughness의 `Mask` 채널 패킹
- 기존 프로젝트 설정에서 마지막 출력 경로 마이그레이션
- 파일 게시 실패 시 기존 출력 파일 복원

Unreal Editor의 Session Frontend에서 Automation Tests를 열고 `FBX_Exporter.Editor.StaticMeshTextureExport`를 검색해 실행할 수 있습니다.
