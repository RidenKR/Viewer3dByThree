/**
 * SectionPlaneManager - 다중 섹션 플레인 관리
 * X/Y/Z 축별 독립 섹션 플레인 지원
 */
import * as THREE from 'three';

export class SectionPlaneManager {
  constructor(viewer) {
    this.viewer = viewer;
    this.scene = viewer.scene;

    // 각 축의 섹션 플레인 상태
    this.planes = {};  // { x: THREE.Plane, y: THREE.Plane, z: THREE.Plane }
    this.helpers = {}; // { x: THREE.Mesh, y: THREE.Mesh, z: THREE.Mesh }
    this.states = {};  // { x: { position, flipped }, ... }

    this.helperVisible = true;
    this.modelBounds = null;

    // 활성 clipping planes 목록 (material에 적용)
    this._activeClippingPlanes = [];
  }

  /** 모델 바운딩 박스 설정 */
  setModelBounds(bounds) {
    this.modelBounds = bounds;
  }

  /**
   * 섹션 플레인 추가
   * @param {'x'|'y'|'z'} axis
   */
  addPlane(axis) {
    if (this.planes[axis]) return; // 이미 존재
    if (!this.modelBounds) return;

    const plane = new THREE.Plane();
    this.planes[axis] = plane;
    this.states[axis] = { position: 0, flipped: false };

    this._updatePlane(axis);
    this._createHelper(axis);
    this._applyClipping();

    return { axis, position: 0, flipped: false };
  }

  /**
   * 섹션 플레인 제거
   * @param {'x'|'y'|'z'} axis
   */
  removePlane(axis) {
    if (!this.planes[axis]) return;

    delete this.planes[axis];
    delete this.states[axis];

    // Helper 제거
    if (this.helpers[axis]) {
      this.scene.remove(this.helpers[axis]);
      this.helpers[axis].geometry.dispose();
      this.helpers[axis].material.dispose();
      delete this.helpers[axis];
    }

    this._applyClipping();
  }

  /** 모든 섹션 플레인 제거 */
  clearAll() {
    const axes = Object.keys(this.planes);
    axes.forEach(axis => this.removePlane(axis));
  }

  /**
   * 섹션 플레인 위치 변경
   * @param {'x'|'y'|'z'} axis
   * @param {number} value - 위치 (-100 ~ 100)
   */
  setPosition(axis, value) {
    if (!this.states[axis]) return;
    this.states[axis].position = value;
    this._updatePlane(axis);
  }

  /**
   * 섹션 방향 반전
   * @param {'x'|'y'|'z'} axis
   */
  flipPlane(axis) {
    if (!this.states[axis]) return;
    this.states[axis].flipped = !this.states[axis].flipped;
    this._updatePlane(axis);
  }

  /** 헬퍼(시각적 평면) 표시/숨김 */
  setHelperVisible(visible) {
    this.helperVisible = visible;
    Object.values(this.helpers).forEach(helper => {
      helper.visible = visible;
    });
  }

  /** 활성 플레인 목록 반환 */
  getActivePlanes() {
    return Object.keys(this.planes).map(axis => ({
      axis,
      position: this.states[axis].position,
      flipped: this.states[axis].flipped,
    }));
  }

  /** Clipping planes 배열 반환 (material에 적용할 용도) */
  getClippingPlanes() {
    return this._activeClippingPlanes;
  }

  /** 특정 축이 활성 상태인지 */
  hasPlane(axis) {
    return !!this.planes[axis];
  }

  // ───── Internal ─────

  _updatePlane(axis) {
    const plane = this.planes[axis];
    const state = this.states[axis];
    if (!plane || !this.modelBounds) return;

    const center = this.modelBounds.getCenter(new THREE.Vector3());
    const size = this.modelBounds.getSize(new THREE.Vector3());

    let normal = new THREE.Vector3();
    let axisSize = 0;
    let axisCenter = 0;

    switch (axis) {
      case 'x':
        normal.set(1, 0, 0);
        axisSize = size.x;
        axisCenter = center.x;
        break;
      case 'y':
        normal.set(0, 1, 0);
        axisSize = size.y;
        axisCenter = center.y;
        break;
      case 'z':
        normal.set(0, 0, 1);
        axisSize = size.z;
        axisCenter = center.z;
        break;
    }

    if (state.flipped) {
      normal.negate();
    }

    const t = state.position / 100;
    const planePosition = axisCenter + (t * axisSize / 2);
    const distance = -planePosition * (state.flipped ? -1 : 1);
    plane.set(normal, distance);

    // Helper 업데이트
    this._updateHelper(axis, planePosition);
  }

  _createHelper(axis) {
    if (!this.modelBounds) return;

    const size = this.modelBounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) * 1.2;

    const geometry = new THREE.PlaneGeometry(maxDim, maxDim);
    const material = new THREE.MeshBasicMaterial({
      color: 0xff9800,
      transparent: true,
      opacity: 0.2,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const helper = new THREE.Mesh(geometry, material);
    helper.renderOrder = 1;
    helper.visible = this.helperVisible;
    this.scene.add(helper);
    this.helpers[axis] = helper;

    const center = this.modelBounds.getCenter(new THREE.Vector3());
    this._updateHelperTransform(helper, axis, center, 0);
  }

  _updateHelper(axis, planePosition) {
    const helper = this.helpers[axis];
    if (!helper || !this.modelBounds) return;

    const center = this.modelBounds.getCenter(new THREE.Vector3());
    this._updateHelperTransform(helper, axis, center, planePosition);
  }

  _updateHelperTransform(helper, axis, center, planePosition) {
    helper.position.copy(center);

    switch (axis) {
      case 'x':
        helper.position.x = planePosition;
        helper.rotation.set(0, Math.PI / 2, 0);
        break;
      case 'y':
        helper.position.y = planePosition;
        helper.rotation.set(Math.PI / 2, 0, 0);
        break;
      case 'z':
        helper.position.z = planePosition;
        helper.rotation.set(0, 0, 0);
        break;
    }
  }

  _applyClipping() {
    this._activeClippingPlanes = Object.values(this.planes);

    const model = this.viewer.modelLoader.model;
    if (!model) return;

    // 모델에 적용
    model.traverse((child) => {
      if (child.isMesh && child.material) {
        const materials = Array.isArray(child.material) ? child.material : [child.material];
        materials.forEach(mat => {
          mat.clippingPlanes = this._activeClippingPlanes.length > 0
            ? [...this._activeClippingPlanes]
            : [];
          mat.clipShadows = true;
          mat.needsUpdate = true;
        });
      }
    });

    // 병합 메시에도 적용
    this.viewer.modelLoader.setMergedClipping(
      this._activeClippingPlanes.length > 0 ? [...this._activeClippingPlanes] : []
    );

    // Edge 라인에도 적용
    this.viewer.modelLoader.setEdgeClipping(
      this._activeClippingPlanes.length > 0 ? [...this._activeClippingPlanes] : null
    );
  }

  dispose() {
    this.clearAll();
  }
}
