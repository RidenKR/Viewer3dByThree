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

    // Raycasting으로 3D 위치 찾기
    const worldPos = this._getWorldPosition(x, y);

    switch (this.activeMode) {
      case 'text':
        this._createTextAnnotation(worldPos, x, y);
        break;
      case 'rect':
      case 'circle':
        this.tempState = { startX: x, startY: y, startPos: worldPos };
        break;
    }
  }

  _onMouseMove(event) {
    if (!this.tempState) return;

    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    // 임시 프리뷰 업데이트 (미구현 - 단순화를 위해 릴리즈 시 생성)
  }

  _onMouseUp(event) {
    if (event.button !== 0 || !this.tempState) return;

    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const endX = event.clientX - rect.left;
    const endY = event.clientY - rect.top;
    const endPos = this._getWorldPosition(endX, endY);

    const { startX, startY, startPos } = this.tempState;

    // 최소 크기 체크 (5px 이상 드래그)
    const dragDist = Math.hypot(endX - startX, endY - startY);
    if (dragDist < 5) {
      this.tempState = null;
      return;
    }

    switch (this.activeMode) {
      case 'rect':
        this._createRectAnnotation(startPos, endPos, startX, startY, endX, endY);
        break;
      case 'circle':
        this._createCircleAnnotation(startPos, endPos, startX, startY, endX, endY);
        break;
    }

    this.tempState = null;
  }

  // ───── Annotation Creation ─────

  _createTextAnnotation(worldPos, screenX, screenY) {
    const text = prompt('어노테이션 텍스트를 입력하세요:');
    if (!text || text.trim() === '') return;

    const id = this.nextId++;
    const el = document.createElement('div');
    el.className = 'annotation annotation-text';
    el.dataset.annotationId = id;
    el.innerHTML = `
      <span class="annotation-content">${text}</span>
      <button class="annotation-delete" title="삭제">&times;</button>
    `;

    el.style.left = `${screenX}px`;
    el.style.top = `${screenY}px`;

    // 삭제 버튼
    el.querySelector('.annotation-delete').addEventListener('click', (e) => {
      e.stopPropagation();
      this.removeAnnotation(id);
    });

    // 드래그 이동
    this._makeDraggable(el);

    if (this.container) this.container.appendChild(el);

    this.annotations.push({
      id,
      type: 'text',
      worldPos: worldPos?.clone(),
      element: el,
      text,
    });
  }

  _createRectAnnotation(startPos, endPos, x1, y1, x2, y2) {
    const id = this.nextId++;
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);

    const el = document.createElement('div');
    el.className = 'annotation annotation-rect';
    el.dataset.annotationId = id;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'annotation-delete';
    deleteBtn.title = '삭제';
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.removeAnnotation(id);
    });
    el.appendChild(deleteBtn);

    this._makeDraggable(el);

    if (this.container) this.container.appendChild(el);

    // 3D 중점 계산
    const midPos = startPos && endPos
      ? new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5)
      : null;

    this.annotations.push({
      id,
      type: 'rect',
      worldPos: midPos,
      element: el,
    });
  }

  _createCircleAnnotation(startPos, endPos, x1, y1, x2, y2) {
    const id = this.nextId++;
    const radius = Math.hypot(x2 - x1, y2 - y1) / 2;
    const centerX = (x1 + x2) / 2;
    const centerY = (y1 + y2) / 2;

    const el = document.createElement('div');
    el.className = 'annotation annotation-circle';
    el.dataset.annotationId = id;
    el.style.left = `${centerX - radius}px`;
    el.style.top = `${centerY - radius}px`;
    el.style.width = `${radius * 2}px`;
    el.style.height = `${radius * 2}px`;

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'annotation-delete';
    deleteBtn.title = '삭제';
    deleteBtn.textContent = '×';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.removeAnnotation(id);
    });
    el.appendChild(deleteBtn);

    this._makeDraggable(el);

    if (this.container) this.container.appendChild(el);

    const midPos = startPos && endPos
      ? new THREE.Vector3().addVectors(startPos, endPos).multiplyScalar(0.5)
      : null;

    this.annotations.push({
      id,
      type: 'circle',
      worldPos: midPos,
      element: el,
    });
  }

  // ───── Annotation Management ─────

  removeAnnotation(id) {
    const idx = this.annotations.findIndex(a => a.id === id);
    if (idx === -1) return;

    const annotation = this.annotations[idx];
    if (annotation.element) annotation.element.remove();
    this.annotations.splice(idx, 1);
  }

  clearAll() {
    for (const a of this.annotations) {
      if (a.element) a.element.remove();
    }
    this.annotations = [];
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
    // 텍스트 어노테이션만 3D 위치에 고정 (rect/circle은 스크린 좌표)
    const width = this.viewer.renderer.domElement.clientWidth;
    const height = this.viewer.renderer.domElement.clientHeight;

    for (const a of this.annotations) {
      if (a.type === 'text' && a.worldPos) {
        const screenPos = a.worldPos.clone().project(camera);
        if (screenPos.z < 1) {
          const x = (screenPos.x + 1) / 2 * width;
          const y = (-screenPos.y + 1) / 2 * height;
          a.element.style.left = `${x}px`;
          a.element.style.top = `${y}px`;
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
