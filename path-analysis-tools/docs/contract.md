# 버전 1 계약

정본은 `schema_catalog.py`이며 `tools/export_contracts.py`로 배포 스키마를 생성합니다. 알 수 없는 문서 형식·버전·필드, 중복 ID/JSON 키, NaN·Infinity를 거절합니다. 모든 파일 경로는 `--workspace` 내부이며 심볼릭 링크로 외부를 참조할 수 없습니다.

## 이미지

`inspect_sheets` 요청: `analysis_id`, `sheets[]`의 `id`, `path`, `columns`, `rows`, `valid_cells`는 필수입니다. 셀은 0부터 시작하는 행 우선 순서입니다. `margin`과 `padding` 기본값은 6입니다. 셀 크기는 전체 크기에서 여백을 빼고 정수 나눗셈하며 남은 픽셀은 중앙 외곽 패딩으로 계산합니다. `cell_rects`는 전체 셀 수만큼의 `[x,y,width,height]` 배열이며 지정 시 우선합니다.

`start_time`, `interval`은 둘을 함께 지정할 때만 셀 timestamp를 기록합니다. 여러 이미지의 start_time은 각 이미지 첫 셀 시점입니다. 유효 셀을 임의로 감지하지 않습니다. `SheetManifest`는 원본 해시를 저장하고 `read_frame`은 변경된 원본을 거절합니다. `frame_ref` 형식은 `<sheet id>:<zero-based cell>`입니다.

## 관측과 경로

`ObservationSet` 필수: `analysis_id`, `frame_id`, `mode(create|edit)`, `targets[]`.
각 target: `id`, `label`, `runs[]`; 각 run: `id`, `segments[]`; 각 segment: `id`, `label`, `samples[]`.
각 sample: `id`, `status`, `position`, `frame_refs[]`; 선택: `protected`, `existing_ref`, `note`.

- `estimated`: 호출한 에이전트가 추정한 유한한 XYZ. 같은 연속 경로에서 공통 단위와 Y-up 축을 사용합니다.
- `unresolved`/`excluded`: position은 null. 해당 구간을 연결하지 않습니다.
- 표시 이름과 순서에서 독립된 source ID를 유지해야 재분석 시 point ID가 유지됩니다. previous_plan은 같은 analysis_id여야 합니다.
- create는 각 연속 경로 시작을 0으로 옮기고 첫 수평 진행을 +Z에 맞춥니다. **간소화 전 관측 경로**의 대상별 최장 길이 10을 공통 축척으로 적용합니다. 간소화 설정이 기준 방향과 축척을 바꾸지 않습니다. edit는 위치·축척을 보존합니다.
- 기본 3D RDP 오차는 연속 경로 길이의 0.005입니다. 시작·끝·행동 경계·protected·existing_ref·protected_point_ids는 보존합니다. 서로 다른 구간 경계점의 위치는 같고 논리 ID는 다릅니다.
- 인접 행동 구간이 같은 run에 들어가려면 경계 위치가 1e-7 이내로 같아야 합니다. 불연속은 명시적으로 다른 run으로 작성합니다.
- 정지 구간은 NO_MOVEMENT 경고와 함께 생략합니다. 자동 대기 시간이나 게임 이벤트를 생성하지 않습니다.
- 기존 편집은 보존할 모든 기존 점에 existing_ref를 붙이거나, previous_plan과 protected_point_ids로 보호해야 합니다. planner도 보호 여부를 검사합니다.

## 씬 스냅샷

`SceneSnapshot`: `scene_id`, `scope_id`, `frame_id`, `frame_transform[16]`, `capabilities[]`, `nodes[]`, `orders[]`.

선택 루트(scope)는 수정 경계이며 nodes에 포함하지 않습니다. 각 node에는 `id`, 불투명 문자열 `externalRef`, `kind(run|segment|point)`, `parent_id`, `label`, `position[3]`, `owned`, `external_reference_count`를 기록합니다. 모든 position은 **선택 좌표 기준(frame)의 위치**이며 각 node의 부모 localPosition과 동일하다고 가정하지 않습니다. frame_transform은 해당 기준의 현재 변환을 담은 row-major affine 4x4입니다.

external_reference_count는 snapshot.orders로 관리하지 않는 모든 참조 수입니다. 같은 선택 루트 안의 다른 컴포넌트 참조도 포함하며, 증명하지 못하면 null입니다. owned와 외부 참조 0이 확인되고 자식·공유 참조·보존할 경로 참조도 없는 point만 물리 삭제합니다. 그 외 삭제 요청은 관리 대상 경로의 참조 해제만 계획하고, 관련 없는 경로의 배열과 객체를 보존합니다.

orders는 `{owner_id, relation: segments|points, items:[node id...]}`입니다. node ID는 실제 제공자 참조와 별도로 유지합니다. 에이전트는 기존 대응표/생성 receipt를 이용해 재조회된 객체에도 같은 논리 ID를 부여합니다.

capabilities의 표준 이름은 `create_node`, `update_node`, `set_order`, `delete_node`, `rebuild`입니다. 특정 Unity MCP 메서드명이 아닙니다. 에이전트가 현재 사용할 수 있는 실제 기능을 확인한 뒤 기입합니다.

## 편집과 실행 기록

`plan_scene_edits`: `path_plan`, `snapshot`, 선택 `bindings {desired logical id: snapshot node id}`, `remove_point_ids[]`, `placement[16]`.
bindings는 run/segment/point를 연결할 수 있으며 같은 씬 객체에 여러 desired ID를 연결할 수 없습니다. 기존 point는 재사용 또는 명시적 제거로 빠짐없이 분류해야 합니다. 이름/좌표로 자동 대응하지 않습니다. 좌표계가 다르면 plan 위치를 snapshot 기준으로 옮기는 row-major affine placement가 필수입니다.

작업은 `{id,kind,depends_on,expected,after}`입니다. expected의 node/order는 이전 값이며 create는 absent_node_id를 검사합니다. update_node는 position과 parent만 변경합니다. 기존 이름·기타 컴포넌트 설정은 보존합니다. set_order는 참조 배열을 정확히 설정하고 delete_node는 마지막에 실행합니다. rebuild는 최종 적용과 저장·재조회를 위한 caller barrier입니다.

ApplyLog: `edit_plan_id`, `entries[]`. 각 entry는 operation_id와 success/failed 상태입니다. 성공한 create_node에는 `node_id`와 실제 `externalRef`가 필수입니다. 실패 이후 작업을 계속 기록할 수 없고 선행 작업이 성공해야 후속 작업을 기록할 수 있습니다.

verify_scene_apply 결과: ready / unsupported / stale / partial / failed / conflict / complete. complete는 모든 작업 receipt와 최종 실제 스냅샷이 일치해야 합니다. rebuild 성공 receipt는 호출자가 실제 Path Rebuild/Ready와 저장 검증까지 수행했음을 의미하며 서버가 엔진을 호출한 증거는 아닙니다.

좌표 반올림에 대해서는 선택 frame 단위의 거리 오차 1e-5를 허용합니다. float32 엔진의 반복적인 미세 이동 계획을 막기 위한 수치 허용치이며, 경로 간소화 오차와는 별개입니다. 이름·참조·계층·순서는 정확히 비교하고 frame_transform 변경은 오래된 스냅샷으로 처리합니다.

partial/failed/stale/conflict는 이전 계획을 재실행하지 않습니다. 실제 새 스냅샷을 읽고 생성 receipt를 bindings에 포함하며 모든 새 재사용 점을 보호한 뒤 plan_scene_edits를 다시 호출합니다. CLI 오류는 stderr의 `{"error":{"code":"...","message":"..."}}`와 종료 코드 2로 전달합니다. MCP는 isError=true 텍스트에 같은 오류 JSON을 포함합니다. 표준 MCP SDK의 오류 설명 접두사가 붙을 수 있습니다.
