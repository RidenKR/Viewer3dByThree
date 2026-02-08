/**
 * CameraManager - 카메라 뷰, 프로젝션, Pan/Zoom 관리
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export class CameraManager {
  constructor(camera, renderer) {
    this.camera = camera;
    this.renderer = renderer;
    this.controls = null;
    this.projection = 'perspective'; // 'perspective' | 'orthographic'
    this.initialState = null;
    this.modelBounds = null;

    // Orthographic camera (projection 전환용)
    this.orthoCamera = null;

    this.setupControls();
  }

  setupControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.01;
    this.controls.maxDistance = 100000;
    this.controls.zoomSpeed = 1.2;

    // 우클릭 Pan, 중간 버튼 dolly
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };
  }

  /** 활성 카메라 반환 (perspective 또는 orthographic) */
  getActiveCamera() {
    return this.projection === 'orthographic' && this.orthoCamera
      ? this.orthoCamera
      : this.camera;
  }

  /** 모델 바운딩 박스 설정 (카메라 뷰 계산용) */
  setModelBounds(bounds) {
    this.modelBounds = bounds;
    this._adjustClipping(bounds);
  }

  /** 카메라 클리핑 플레인 자동 조정 */
  _adjustClipping(bounds) {
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    this.camera.near = maxDim * 0.001;
    this.camera.far = maxDim * 100;
    this.camera.updateProjectionMatrix();
  }

  /** 초기 카메라 상태 저장 (Home 버튼용) */
  saveInitialState() {
    this.initialState = {
      position: this.camera.position.clone(),
      target: this.controls.target.clone(),
      up: this.camera.up.clone(),
      zoom: this.camera.zoom,
    };
  }

  /** 초기 카메라 상태 복원 (Home 버튼) */
  restoreInitialState() {
    if (!this.initialState) {
      this.fitAll();
      return;
    }

    this.camera.position.copy(this.initialState.position);
    this.camera.up.copy(this.initialState.up);
    this.controls.target.copy(this.initialState.target);
    this.camera.zoom = this.initialState.zoom;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** 모델 전체 보기 (Fit All) */
  fitAll(model) {
    if (!this.modelBounds && !model) return;

    const bounds = model
      ? new THREE.Box3().setFromObject(model)
      : this.modelBounds;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let distance = maxDim / (2 * Math.tan(fov / 2));
    distance *= 1.5;

    this.camera.position.set(
      center.x + distance * 0.577,
      center.y + distance * 0.577,
      center.z + distance * 0.577
    );
    this.camera.up.set(0, 1, 0);
    this.controls.target.copy(center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** 카메라 뷰 프리셋 (Front/Back/Left/Right/Top/Bottom/Iso) */
  setCameraView(direction) {
    if (!this.modelBounds) return;

    const center = this.modelBounds.getCenter(new THREE.Vector3());
    const size = this.modelBounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const fov = this.camera.fov * (Math.PI / 180);
    let distance = maxDim / (2 * Math.tan(fov / 2));
    distance *= 1.5;

    const positions = {
      front:  new THREE.Vector3(center.x, center.y, center.z + distance),
      back:   new THREE.Vector3(center.x, center.y, center.z - distance),
      left:   new THREE.Vector3(center.x - distance, center.y, center.z),
      right:  new THREE.Vector3(center.x + distance, center.y, center.z),
      top:    new THREE.Vector3(center.x, center.y + distance, center.z),
      bottom: new THREE.Vector3(center.x, center.y - distance, center.z),
      iso:    new THREE.Vector3(
        center.x + distance * 0.577,
        center.y + distance * 0.577,
        center.z + distance * 0.577
      ),
    };

    const ups = {
      front:  new THREE.Vector3(0, 1, 0),
      back:   new THREE.Vector3(0, 1, 0),
      left:   new THREE.Vector3(0, 1, 0),
      right:  new THREE.Vector3(0, 1, 0),
      top:    new THREE.Vector3(0, 0, -1),
      bottom: new THREE.Vector3(0, 0, 1),
      iso:    new THREE.Vector3(0, 1, 0),
    };

    const pos = positions[direction];
    const up = ups[direction];
    if (!pos) return;

    this.camera.position.copy(pos);
    this.camera.up.copy(up);
    this.controls.target.copy(center);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /** Projection 토글 (Perspective/Orthographic) */
  toggleProjection() {
    if (this.projection === 'perspective') {
      this._switchToOrthographic();
      this.projection = 'orthographic';
    } else {
      this._switchToPerspective();
      this.projection = 'perspective';
    }
    return this.projection;
  }

  _switchToOrthographic() {
    const aspect = this.renderer.domElement.clientWidth / this.renderer.domElement.clientHeight;
    const distance = this.camera.position.distanceTo(this.controls.target);
    const halfHeight = distance * Math.tan((this.camera.fov * Math.PI) / 360);

    if (!this.orthoCamera) {
      this.orthoCamera = new THREE.OrthographicCamera(
        -halfHeight * aspect, halfHeight * aspect,
        halfHeight, -halfHeight,
        this.camera.near, this.camera.far
      );
    } else {
      this.orthoCamera.left = -halfHeight * aspect;
      this.orthoCamera.right = halfHeight * aspect;
      this.orthoCamera.top = halfHeight;
      this.orthoCamera.bottom = -halfHeight;
      this.orthoCamera.near = this.camera.near;
      this.orthoCamera.far = this.camera.far;
    }

    this.orthoCamera.position.copy(this.camera.position);
    this.orthoCamera.quaternion.copy(this.camera.quaternion);
    this.orthoCamera.zoom = 1;
    this.orthoCamera.updateProjectionMatrix();

    this.controls.object = this.orthoCamera;
    this.controls.update();
  }

  _switchToPerspective() {
    if (this.orthoCamera) {
      this.camera.position.copy(this.orthoCamera.position);
      this.camera.quaternion.copy(this.orthoCamera.quaternion);
    }
    this.camera.updateProjectionMatrix();

    this.controls.object = this.camera;
    this.controls.update();
  }

  update() {
    this.controls.update();
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.orthoCamera) {
      const aspect = width / height;
      const halfHeight = (this.orthoCamera.top - this.orthoCamera.bottom) / 2;
      this.orthoCamera.left = -halfHeight * aspect;
      this.orthoCamera.right = halfHeight * aspect;
      this.orthoCamera.updateProjectionMatrix();
    }
  }

  dispose() {
    this.controls.dispose();
  }
}
