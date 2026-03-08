/**
 * AnnotationManager - 어노테이션 관리 (Text/Rect/Circle)
 * HTML overlay 기반 어노테이션 도구
 */
import * as THREE from 'three';

export class AnnotationManager {
  constructor(viewer, labelsContainerId = 'labels-container') {
    this.viewer = viewer;
    this.scene = viewer.scene;
    this.container = document.getElementById(labelsContainerId);
    this.annotations = [];
    this.nextId = 1;
    this.activeMode = null; // 'text' | 'rect' | 'circle' | null
    this.tempState = null;

    // Binding
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);

    // 카메라 업데이트 시 라벨 위치 동기화
    viewer.onUpdate((camera) => this._updateAnnotationPositions(camera));
  }

  // ───── Mode Control ─────

  activate(mode) {
    this.deactivate();
    this.activeMode = mode;
    this.viewer.renderer.domElement.style.cursor = 'crosshair';
    this.viewer.renderer.domElement.addEventListener('mousedown', this._onMouseDown);
    this.viewer.renderer.domElement.addEventListener('mousemove', this._onMouseMove);
    this.viewer.renderer.domElement.addEventListener('mouseup', this._onMouseUp);
  }

  deactivate() {
    // pending 정리
    this._cleanupPending();
    this.activeMode = null;
    this.tempState = null;
    this.viewer.renderer.domElement.style.cursor = '';
    this.viewer.renderer.domElement.removeEventListener('mousedown', this._onMouseDown);
    this.viewer.renderer.domElement.removeEventListener('mousemove', this._onMouseMove);
    this.viewer.renderer.domElement.removeEventListener('mouseup', this._onMouseUp);
  }

  // ───── Event Handlers ─────

  _onMouseDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();

    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Text 모드: 2-click 플로우
    if (this.activeMode === 'text') {
      if (!this._pendingAnnotation) {
        const worldPos = this._getWorldPosition(x, y);
        if (!worldPos) return;
        this._startTextAnnotation(worldPos, x, y);
      } else {
        this._finishTextAnnotation(x, y);
      }
      return;
    }

    // Rect 모드: 3-click 플로우
    if (this.activeMode === 'rect') {
      this._handleRectClick(x, y);
      return;
    }

    // Circle 모드: 3-click 플로우
    if (this.activeMode === 'circle') {
      this._handleCircleClick(x, y);
      return;
    }
  }

  _onMouseMove(event) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // Text 모드: 라벨이 마우스를 따라감
    if (this._pendingAnnotation && this._pendingAnnotation.type === 'text') {
      const pa = this._pendingAnnotation;
      pa.label.style.left = `${x}px`;
      pa.label.style.top = `${y - 20}px`;
      this._updateConnector(pa, pa._markerScreenX, pa._markerScreenY);
      return;
    }

    // Rect 모드 프리뷰
    if (this._pendingRect) {
      const pr = this._pendingRect;
      if (pr.step === 1) {
        // 사각형 크기 프리뷰
        const left = Math.min(pr.startX, x);
        const top = Math.min(pr.startY, y);
        const width = Math.abs(x - pr.startX);
        const height = Math.abs(y - pr.startY);
        pr.element.style.left = `${left}px`;
        pr.element.style.top = `${top}px`;
        pr.element.style.width = `${width}px`;
        pr.element.style.height = `${height}px`;
      } else if (pr.step === 2) {
        // 라벨 위치 프리뷰
        pr.label.style.left = `${x}px`;
        pr.label.style.top = `${y - 20}px`;
        this._updateConnector(pr, pr._markerCenterX, pr._markerCenterY);
      }
      return;
    }

    // Circle 모드 프리뷰
    if (this._pendingCircle) {
      const pc = this._pendingCircle;
      if (pc.step === 1) {
        const radius = Math.hypot(x - pc.startX, y - pc.startY) / 2;
        const cx = (pc.startX + x) / 2;
        const cy = (pc.startY + y) / 2;
        pc.element.style.left = `${cx - radius}px`;
        pc.element.style.top = `${cy - radius}px`;
        pc.element.style.width = `${radius * 2}px`;
        pc.element.style.height = `${radius * 2}px`;
      } else if (pc.step === 2) {
        pc.label.style.left = `${x}px`;
        pc.label.style.top = `${y - 20}px`;
        this._updateConnector(pc, pc._markerCenterX, pc._markerCenterY);
      }
      return;
    }
  }

  _onMouseUp(event) {
    // mouseUp은 더 이상 사용하지 않음 (모든 모드가 click 기반)
  }

  // ───── Annotation Creation ─────

  /** 첫 클릭: 마커 + 라벨 + 연결선 생성, 마우스 따라다니는 상태 */
  _startTextAnnotation(worldPos, screenX, screenY) {
    const id = this.nextId++;

    // 마커 핀 (3D 포인트에 고정)
    const marker = document.createElement('div');
    marker.className = 'annotation-marker-custom';
    marker.style.left = `${screenX - 7}px`;
    marker.style.top = `${screenY - 7}px`;
    marker.style.pointerEvents = 'none'; // pending 중에는 클릭 통과

    // 라벨 (마우스를 따라다님)
    const label = document.createElement('div');
    label.className = 'annotation-label-editable';
    label.dataset.annotationId = id;
    label.innerHTML = `
      <div class="annotation-header">
        <button class="annotation-delete-btn" title="삭제">&times;</button>
      </div>
      <textarea placeholder="텍스트 입력..."></textarea>
    `;
    label.style.left = `${screenX + 40}px`;
    label.style.top = `${screenY - 20}px`;
    label.style.opacity = '0.8';
    label.style.pointerEvents = 'none'; // pending 중에는 클릭 통과

    // 연결선
    const connector = document.createElement('div');
    connector.className = 'annotation-connector';

    if (this.container) {
      this.container.appendChild(connector);
      this.container.appendChild(marker);
      this.container.appendChild(label);
    }

    // 임시 상태 저장 (두 번째 클릭 대기)
    this._pendingAnnotation = {
      id,
      type: 'text',
      worldPos: worldPos.clone(),
      marker,
      label,
      connector,
      element: label,
      _markerScreenX: screenX,
      _markerScreenY: screenY,
    };

    this._updateConnector(this._pendingAnnotation, screenX, screenY);
  }

  /** 두 번째 클릭: 라벨 위치 확정, textarea 포커스 */
  _finishTextAnnotation(screenX, screenY) {
    const pa = this._pendingAnnotation;
    if (!pa) return;

    // 라벨 위치 확정
    pa.label.style.left = `${screenX}px`;
    pa.label.style.top = `${screenY - 20}px`;
    pa.label.style.opacity = '1';
    pa.label.style.pointerEvents = 'auto'; // 확정 후 상호작용 활성화
    pa.marker.style.pointerEvents = 'auto';

    // 삭제 버튼
    pa.label.querySelector('.annotation-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.removeAnnotation(pa.id);
    });

    // 드래그 활성화
    this._makeDraggableWithConnector(pa);

    // 연결선 최종 업데이트
    this._updateConnector(pa, pa._markerScreenX, pa._markerScreenY);

    // 텍스트박스 크기 조정 시 연결선 업데이트
    const resizeObserver = new ResizeObserver(() => {
      const markerX = parseInt(pa.marker.style.left) + 7;
      const markerY = parseInt(pa.marker.style.top) + 7;
      this._updateConnector(pa, markerX, markerY);
    });
    resizeObserver.observe(pa.label);
    pa._resizeObserver = resizeObserver;

    this.annotations.push(pa);
    this._pendingAnnotation = null;

    // textarea에 포커스
    const textarea = pa.label.querySelector('textarea');
    if (textarea) textarea.focus();
  }

  // ───── Rect: 3-click 플로우 ─────

  _handleRectClick(x, y) {
    if (!this._pendingRect) {
      // 1단계: 시작점
      this._startRectAnnotation(x, y);
    } else if (this._pendingRect.step === 1) {
      // 2단계: 사각형 확정 + 라벨 따라다니기
      this._confirmRectShape(x, y);
    } else if (this._pendingRect.step === 2) {
      // 3단계: 라벨 위치 확정
      this._finishRectAnnotation(x, y);
    }
  }

  _startRectAnnotation(x, y) {
    const id = this.nextId++;
    const worldPos = this._getWorldPosition(x, y);

    const el = document.createElement('div');
    el.className = 'annotation annotation-rect';
    el.dataset.annotationId = id;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = '0px';
    el.style.height = '0px';
    el.style.pointerEvents = 'none';

    if (this.container) this.container.appendChild(el);

    this._pendingRect = {
      id,
      type: 'rect',
      step: 1,
      startX: x,
      startY: y,
      worldPos: worldPos?.clone() || null,
      element: el,
    };
  }

  _confirmRectShape(x, y) {
    const pr = this._pendingRect;

    // 최소 크기 체크
    const dist = Math.hypot(x - pr.startX, y - pr.startY);
    if (dist < 5) return;

    // 사각형 크기 확정
    const left = Math.min(pr.startX, x);
    const top = Math.min(pr.startY, y);
    const width = Math.abs(x - pr.startX);
    const height = Math.abs(y - pr.startY);
    pr.element.style.left = `${left}px`;
    pr.element.style.top = `${top}px`;
    pr.element.style.width = `${width}px`;
    pr.element.style.height = `${height}px`;

    // 연결선 기준점: 사각형 중앙
    const markerCX = left + width / 2;
    const markerCY = top + height / 2;

    // 라벨 생성
    const label = document.createElement('div');
    label.className = 'annotation-label-editable';
    label.dataset.annotationId = pr.id;
    label.innerHTML = `
      <div class="annotation-header">
        <button class="annotation-delete-btn" title="삭제">&times;</button>
      </div>
      <textarea placeholder="텍스트 입력..."></textarea>
    `;
    label.style.left = `${x + 20}px`;
    label.style.top = `${y - 20}px`;
    label.style.opacity = '0.8';
    label.style.pointerEvents = 'none';

    // 연결선
    const connector = document.createElement('div');
    connector.className = 'annotation-connector';

    if (this.container) {
      this.container.appendChild(connector);
      this.container.appendChild(label);
    }

    pr.label = label;
    pr.connector = connector;
    pr._markerCenterX = markerCX;
    pr._markerCenterY = markerCY;
    pr.step = 2;

    this._updateConnector(pr, markerCX, markerCY);
  }

  _finishRectAnnotation(x, y) {
    const pr = this._pendingRect;
    if (!pr) return;

    // 라벨 확정
    pr.label.style.left = `${x}px`;
    pr.label.style.top = `${y - 20}px`;
    pr.label.style.opacity = '1';
    pr.label.style.pointerEvents = 'auto';
    pr.element.style.pointerEvents = 'auto';

    // 삭제 버튼 (사각형 + 라벨 + 연결선 모두 삭제)
    pr.label.querySelector('.annotation-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.removeAnnotation(pr.id);
    });

    // 드래그: 라벨만 드래그 가능 (연결선 업데이트)
    this._makeDraggableWithConnector(pr);

    this._updateConnector(pr, pr._markerCenterX, pr._markerCenterY);

    this.annotations.push(pr);
    this._pendingRect = null;

    const textarea = pr.label.querySelector('textarea');
    if (textarea) textarea.focus();
  }

  // ───── Circle: 3-click 플로우 ─────

  _handleCircleClick(x, y) {
    if (!this._pendingCircle) {
      this._startCircleAnnotation(x, y);
    } else if (this._pendingCircle.step === 1) {
      this._confirmCircleShape(x, y);
    } else if (this._pendingCircle.step === 2) {
      this._finishCircleAnnotation(x, y);
    }
  }

  _startCircleAnnotation(x, y) {
    const id = this.nextId++;
    const worldPos = this._getWorldPosition(x, y);

    const el = document.createElement('div');
    el.className = 'annotation annotation-circle';
    el.dataset.annotationId = id;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.width = '0px';
    el.style.height = '0px';
    el.style.pointerEvents = 'none';

    if (this.container) this.container.appendChild(el);

    this._pendingCircle = {
      id,
      type: 'circle',
      step: 1,
      startX: x,
      startY: y,
      worldPos: worldPos?.clone() || null,
      element: el,
    };
  }

  _confirmCircleShape(x, y) {
    const pc = this._pendingCircle;

    const dist = Math.hypot(x - pc.startX, y - pc.startY);
    if (dist < 5) return;

    const radius = dist / 2;
    const cx = (pc.startX + x) / 2;
    const cy = (pc.startY + y) / 2;
    pc.element.style.left = `${cx - radius}px`;
    pc.element.style.top = `${cy - radius}px`;
    pc.element.style.width = `${radius * 2}px`;
    pc.element.style.height = `${radius * 2}px`;

    const markerCX = cx;
    const markerCY = cy;

    const label = document.createElement('div');
    label.className = 'annotation-label-editable';
    label.dataset.annotationId = pc.id;
    label.innerHTML = `
      <div class="annotation-header">
        <button class="annotation-delete-btn" title="삭제">&times;</button>
      </div>
      <textarea placeholder="텍스트 입력..."></textarea>
    `;
    label.style.left = `${x + 20}px`;
    label.style.top = `${y - 20}px`;
    label.style.opacity = '0.8';
    label.style.pointerEvents = 'none';

    const connector = document.createElement('div');
    connector.className = 'annotation-connector';

    if (this.container) {
      this.container.appendChild(connector);
      this.container.appendChild(label);
    }

    pc.label = label;
    pc.connector = connector;
    pc._markerCenterX = markerCX;
    pc._markerCenterY = markerCY;
    pc.step = 2;

    this._updateConnector(pc, markerCX, markerCY);
  }

  _finishCircleAnnotation(x, y) {
    const pc = this._pendingCircle;
    if (!pc) return;

    pc.label.style.left = `${x}px`;
    pc.label.style.top = `${y - 20}px`;
    pc.label.style.opacity = '1';
    pc.label.style.pointerEvents = 'auto';
    pc.element.style.pointerEvents = 'auto';

    pc.label.querySelector('.annotation-delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      this.removeAnnotation(pc.id);
    });

    this._makeDraggableWithConnector(pc);
    this._updateConnector(pc, pc._markerCenterX, pc._markerCenterY);

    this.annotations.push(pc);
    this._pendingCircle = null;

    const textarea = pc.label.querySelector('textarea');
    if (textarea) textarea.focus();
  }

  // ───── Annotation Management ─────

  _removeParts(a) {
    if (a._resizeObserver) { a._resizeObserver.disconnect(); a._resizeObserver = null; }
    if (a.marker) a.marker.remove();
    if (a.label) a.label.remove();
    if (a.connector) a.connector.remove();
    if (a.element) a.element.remove();
  }

  removeAnnotation(id) {
    const idx = this.annotations.findIndex(a => a.id === id);
    if (idx === -1) return;
    this._removeParts(this.annotations[idx]);
    this.annotations.splice(idx, 1);
  }

  clearAll() {
    for (const a of this.annotations) this._removeParts(a);
    this.annotations = [];
  }

  _cleanupPending() {
    if (this._pendingAnnotation) {
      this._removeParts(this._pendingAnnotation);
      this._pendingAnnotation = null;
    }
    if (this._pendingRect) {
      this._removeParts(this._pendingRect);
      this._pendingRect = null;
    }
    if (this._pendingCircle) {
      this._removeParts(this._pendingCircle);
      this._pendingCircle = null;
    }
  }

  // ───── Drag Support ─────

  _makeDraggable(el) {
    let offsetX = 0, offsetY = 0;
    let isDragging = false;

    el.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('annotation-delete')) return;
      isDragging = true;
      offsetX = e.clientX - parseInt(el.style.left);
      offsetY = e.clientY - parseInt(el.style.top);
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      el.style.left = `${e.clientX - offsetX}px`;
      el.style.top = `${e.clientY - offsetY}px`;
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  /** 라벨 드래그 + 연결선 실시간 업데이트 */
  _makeDraggableWithConnector(annotation) {
    const label = annotation.label;
    let offsetX = 0, offsetY = 0;
    let isDragging = false;

    label.addEventListener('mousedown', (e) => {
      if (e.target.classList.contains('annotation-delete-btn')) return;
      if (e.target.tagName === 'TEXTAREA') return;
      isDragging = true;
      offsetX = e.clientX - parseInt(label.style.left);
      offsetY = e.clientY - parseInt(label.style.top);
      e.stopPropagation();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      label.style.left = `${e.clientX - offsetX}px`;
      label.style.top = `${e.clientY - offsetY}px`;

      // 연결선 업데이트: marker가 있으면 마커 중앙, 없으면 저장된 중심점
      let markerX, markerY;
      if (annotation.marker) {
        markerX = parseInt(annotation.marker.style.left) + 7;
        markerY = parseInt(annotation.marker.style.top) + 7;
      } else {
        markerX = annotation._markerCenterX;
        markerY = annotation._markerCenterY;
      }
      this._updateConnector(annotation, markerX, markerY);
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
    });
  }

  /** 마커 중앙 → 라벨 좌측 중앙 연결선 */
  _updateConnector(annotation, markerCenterX, markerCenterY) {
    const connector = annotation.connector;
    const label = annotation.label;

    const labelX = parseInt(label.style.left) || 0;
    const labelY = parseInt(label.style.top) || 0;
    const labelH = label.offsetHeight || 30;
    // 라벨 좌측 중앙
    const labelAnchorX = labelX;
    const labelAnchorY = labelY + labelH / 2;

    const dx = labelAnchorX - markerCenterX;
    const dy = labelAnchorY - markerCenterY;
    const length = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * (180 / Math.PI);

    connector.style.left = `${markerCenterX}px`;
    connector.style.top = `${markerCenterY}px`;
    connector.style.width = `${length}px`;
    connector.style.transform = `rotate(${angle}deg)`;
  }

  // ───── World Position ─────

  _getWorldPosition(screenX, screenY) {
    const canvas = this.viewer.renderer.domElement;
    const mouse = new THREE.Vector2(
      (screenX / canvas.clientWidth) * 2 - 1,
      -(screenY / canvas.clientHeight) * 2 + 1
    );

    const camera = this.viewer.cameraManager.getActiveCamera();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, camera);

    const meshes = this.viewer.modelLoader.getMeshList();
    const intersects = raycaster.intersectObjects(meshes, false);

    if (intersects.length > 0) {
      return intersects[0].point.clone();
    }

    return null;
  }

  // ───── Position Update ─────

  _updateAnnotationPositions(camera) {
    const width = this.viewer.renderer.domElement.clientWidth;
    const height = this.viewer.renderer.domElement.clientHeight;

    for (const a of this.annotations) {
      if (a.type === 'text' && a.worldPos && a.marker) {
        const screenPos = a.worldPos.clone().project(camera);
        if (screenPos.z < 1) {
          const x = (screenPos.x + 1) / 2 * width;
          const y = (-screenPos.y + 1) / 2 * height;

          // 마커 위치 (중앙 정렬: 14px 마커)
          a.marker.style.left = `${x - 7}px`;
          a.marker.style.top = `${y - 7}px`;
          a.marker.style.display = 'flex';

          // 라벨이 처음 배치될 때 오프셋 기록
          if (a._prevMarkerX === undefined) {
            a._prevMarkerX = x;
            a._prevMarkerY = y;
          }

          // 마커 이동량만큼 라벨도 같이 이동
          const deltaX = x - a._prevMarkerX;
          const deltaY = y - a._prevMarkerY;
          if (deltaX !== 0 || deltaY !== 0) {
            const labelX = parseInt(a.label.style.left) || 0;
            const labelY = parseInt(a.label.style.top) || 0;
            a.label.style.left = `${labelX + deltaX}px`;
            a.label.style.top = `${labelY + deltaY}px`;
          }
          a._prevMarkerX = x;
          a._prevMarkerY = y;

          a.label.style.display = 'block';
          a.connector.style.display = 'block';

          // 연결선 업데이트
          this._updateConnector(a, x, y);
        } else {
          a.marker.style.display = 'none';
          a.label.style.display = 'none';
          a.connector.style.display = 'none';
        }
      } else if (a.type !== 'text' && a.worldPos) {
        // rect/circle은 기존 방식
        const screenPos = a.worldPos.clone().project(camera);
        if (screenPos.z < 1) {
          a.element.style.display = 'block';
        } else {
          a.element.style.display = 'none';
        }
      }
    }
  }

  dispose() {
    this.deactivate();
    this.clearAll();
  }
}
