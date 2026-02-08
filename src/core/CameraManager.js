/**
 * CameraManager - 카메라 뷰, 프로젝션, 커스텀 Pan/Zoom 관리
 *
 * xeokit viewer3d의 카메라 동작을 재현:
 * - OrbitControls 회전만 사용 (트랙볼 자유 회전 가능하도록 설정 예정)
 * - Pan: 우클릭/중클릭/Shift+좌클릭 드래그 → 모델 크기 기반 커스텀 Pan
 * - Zoom: 휠 → 비율 기반 커스텀 줌 (모든 크기의 모델에서 일관된 동작)
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
    this.modelSize = 1; // 모델의 maxDim (Pan/Zoom 속도 계산용)

    // Orthographic camera (projection 전환용)
    this.orthoCamera = null;

    // 커스텀 Pan 상태
    this._isPanning = false;
    this._lastPanX = 0;
    this._lastPanY = 0;

    this.setupControls();
    this._setupCustomPan();
    this._setupCustomZoom();
  }

  // ───── OrbitControls Setup ─────

  setupControls() {
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.screenSpacePanning = true;

    // OrbitControls는 회전만 사용
    // Pan과 Zoom은 커스텀 핸들러로 처리
    this.controls.enablePan = false;
    this.controls.enableZoom = false;

    this.controls.minDistance = 0.001;
    this.controls.maxDistance = Infinity;
    this.controls.rotateSpeed = 1.0;

    // 좌클릭만 회전 (Pan/Zoom은 커스텀)
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: null,
      RIGHT: null,
    };
  }

  // ───── Custom Pan (모델 크기 기반) ─────

  _setupCustomPan() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('mousedown', (e) => {
      // 우클릭, 중간 버튼, Shift+좌클릭으로 Pan
      if (e.button === 2 || e.button === 1 || (e.button === 0 && e.shiftKey)) {
        this._isPanning = true;
        this._lastPanX = e.clientX;
        this._lastPanY = e.clientY;
        e.preventDefault();
      }
    });

    canvas.addEventListener('mousemove', (e) => {
      if (!this._isPanning) return;

      const dx = e.clientX - this._lastPanX;
      const dy = e.clientY - this._lastPanY;
      this._lastPanX = e.clientX;
      this._lastPanY = e.clientY;

      const activeCamera = this.getActiveCamera();
      this._panCamera(activeCamera, dx, dy);
    });

    canvas.addEventListener('mouseup', (e) => {
      if (e.button === 2 || e.button === 1 || e.button === 0) {
        this._isPanning = false;
      }
    });

    canvas.addEventListener('mouseleave', () => {
      this._isPanning = false;
    });

    // 우클릭 컨텍스트 메뉴 방지
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
  }

  /**
   * 카메라의 로컬 축 기반 Pan
   * xeokit 커스텀 Pan과 동일한 로직: viewDir × up → right, right × viewDir → camUp
   */
  _panCamera(camera, dx, dy) {
    const panSpeed = this.modelSize * 0.002;

    // 시선 방향
    const viewDir = new THREE.Vector3().subVectors(this.controls.target, camera.position);

    // 오른쪽 방향 (viewDir × up)
    const right = new THREE.Vector3().crossVectors(viewDir, camera.up).normalize();

    // 카메라 실제 up (right × viewDir)
    const camUp = new THREE.Vector3().crossVectors(right, viewDir).normalize();

    // 이동량
    const moveX = -dx * panSpeed;
    const moveY = dy * panSpeed;

    const offset = new THREE.Vector3()
      .addScaledVector(right, moveX)
      .addScaledVector(camUp, moveY);

    // eye와 target 모두 이동
    camera.position.add(offset);
    this.controls.target.add(offset);

    // Ortho 카메라 동기화
    if (this.projection === 'orthographic' && this.orthoCamera && camera !== this.orthoCamera) {
      this.orthoCamera.position.add(offset);
    } else if (this.projection === 'perspective' && camera !== this.camera) {
      this.camera.position.add(offset);
    }
  }

  // ───── Custom Zoom (비율 기반) ─────

  _setupCustomZoom() {
    const canvas = this.renderer.domElement;

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();

      const activeCamera = this.getActiveCamera();
      const target = this.controls.target;

      // eye에서 target까지의 거리
      const eyeToTarget = new THREE.Vector3().subVectors(target, activeCamera.position);
      const currentDist = eyeToTarget.length();

      // 비율 기반 줌: deltaY > 0 (아래로) = 축소, deltaY < 0 (위로) = 확대
      const zoomSensitivity = 0.001;
      const zoomFactor = 1 + e.deltaY * zoomSensitivity;

      // 새 거리 (최소 거리 제한: 현재 거리의 0.1%)
      let newDist = currentDist * zoomFactor;
      const minDist = currentDist * 0.001;
      if (newDist < minDist) newDist = minDist;

      // 방향 벡터 정규화
      const dir = eyeToTarget.normalize();

      // 새 eye 위치 (target 기준으로 거리 조정)
      activeCamera.position.copy(target).addScaledVector(dir, -newDist);

      // Ortho 모드에서는 scale도 조정
      if (this.projection === 'orthographic' && this.orthoCamera) {
        this.orthoCamera.zoom *= (1 / zoomFactor);
        this.orthoCamera.updateProjectionMatrix();
      }

      this.controls.update();
    }, { passive: false });
  }

  // ───── Camera State ─────

  /** 활성 카메라 반환 (perspective 또는 orthographic) */
  getActiveCamera() {
    return this.projection === 'orthographic' && this.orthoCamera
      ? this.orthoCamera
      : this.camera;
  }

  /** 모델 바운딩 박스 설정 (카메라 뷰 계산용) */
  setModelBounds(bounds) {
    this.modelBounds = bounds;
    const size = bounds.getSize(new THREE.Vector3());
    this.modelSize = Math.max(size.x, size.y, size.z);
    this._adjustClipping(bounds);
  }

  /** 카메라 클리핑 플레인 자동 조정 (xeokit과 동일) */
  _adjustClipping(bounds) {
    const maxDim = this.modelSize;

    // xeokit과 동일: near = maxSize * 0.00001, far = maxSize * 100
    const nearClip = Math.max(0.0001, maxDim * 0.00001);
    const farClip = Math.max(nearClip * 10, maxDim * 100);

    this.camera.near = nearClip;
    this.camera.far = farClip;
    this.camera.updateProjectionMatrix();

    if (this.orthoCamera) {
      this.orthoCamera.near = nearClip;
      this.orthoCamera.far = farClip;
      this.orthoCamera.updateProjectionMatrix();
    }
  }

  /** 초기 카메라 상태 저장 (Home 버튼용) */
  saveInitialState() {
    const activeCamera = this.getActiveCamera();
    this.initialState = {
      position: activeCamera.position.clone(),
      target: this.controls.target.clone(),
      up: activeCamera.up.clone(),
      zoom: activeCamera.zoom,
    };
  }

  /** 초기 카메라 상태 복원 (Home 버튼) */
  restoreInitialState() {
    if (!this.initialState) {
      this.fitAll();
      return;
    }

    const activeCamera = this.getActiveCamera();
    activeCamera.position.copy(this.initialState.position);
    activeCamera.up.copy(this.initialState.up);
    this.controls.target.copy(this.initialState.target);
    activeCamera.zoom = this.initialState.zoom;
    activeCamera.updateProjectionMatrix();
    this.controls.update();
  }

  // ───── Camera Views ─────

  /** 모델 전체 보기 (Fit All) */
  fitAll(model) {
    if (!this.modelBounds && !model) return;

    const bounds = model
      ? new THREE.Box3().setFromObject(model)
      : this.modelBounds;

    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);

    // xeokit과 동일: maxSize * 2 거리
    const distance = maxDim * 2;

    const activeCamera = this.getActiveCamera();
    activeCamera.position.set(
      center.x + distance * 0.577,
      center.y + distance * 0.577,
      center.z + distance * 0.577
    );
    activeCamera.up.set(0, 1, 0);
    this.controls.target.copy(center);
    activeCamera.updateProjectionMatrix();
    this.controls.update();
  }

  /** 카메라 뷰 프리셋 (Front/Back/Left/Right/Top/Bottom/Iso) */
  setCameraView(direction) {
    if (!this.modelBounds) return;

    const center = this.modelBounds.getCenter(new THREE.Vector3());
    const maxDim = this.modelSize;
    const distance = maxDim * 2;

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

    const activeCamera = this.getActiveCamera();
    activeCamera.position.copy(pos);
    activeCamera.up.copy(up);
    this.controls.target.copy(center);
    activeCamera.updateProjectionMatrix();
    this.controls.update();
  }

  // ───── Projection Toggle ─────

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
    this.orthoCamera.up.copy(this.camera.up);
    this.orthoCamera.zoom = 1;
    this.orthoCamera.updateProjectionMatrix();

    this.controls.object = this.orthoCamera;
    this.controls.update();
  }

  _switchToPerspective() {
    if (this.orthoCamera) {
      this.camera.position.copy(this.orthoCamera.position);
      this.camera.quaternion.copy(this.orthoCamera.quaternion);
      this.camera.up.copy(this.orthoCamera.up);
    }
    this.camera.updateProjectionMatrix();

    this.controls.object = this.camera;
    this.controls.update();
  }

  // ───── Update & Resize ─────

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
